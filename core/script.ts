import { z } from 'zod';
// 注意循环引用：这里在模块顶层就用到了 CommandError（class ScriptError extends CommandError）。
// commands.ts 引用 species.ts、generate.ts，所以那两个文件以后要引用 scriptsSchema 时，
// 不能在模块顶层直接读它（会碰上“初始化之前不能访问”）：用 z.lazy(() => scriptsSchema)，
// 或者先把 CommandError 挪进一个不引用别的模块的小文件
import { CommandError } from './commands';
import { type Mesh, graphDistance } from './mesh';
import { hashString } from './names';
import {
  type Noise2,
  type Noise3,
  clamp as clampRange,
  fbm as fbmKernel,
  fbm3 as fbm3Kernel,
  gradientNoise,
  gradientNoise3,
  mixSeed,
  mulberry32,
  noise2,
  noise3 as noise3Kernel,
  smoothstep as smoothKernel,
} from './rng';
import { type Derived, type World, longitudeOf, planetRadiusKm, worldLatitude } from './world';

// 用户脚本（第三批）的运行环境：编译、绑定变量、整段循环地运行、检查返回值，出错时给出中文说明。
//
// 一段脚本是一个函数体，用户写 `return …`。五种脚本：
//   placement 长在哪里 —— 每个陆地格一次，返回 0–1 的数或 true/false，乘进生态的适宜度
//   color     颜色     —— 每格一次，返回 [r, g, b] 或 '#rrggbb'
//   match     哪些河是这一种 —— 每条河一次，返回真或假
//   crust     地形     —— 整个星球每格一次，返回新的高度，或者 {height?, mountains?, hills?, rock?}
//   setup     布局     —— 每个星球模型一次（加大陆块、加岛）
//
// 确定性：脚本看不到时间、随机数、全局对象（这些名字被同名参数遮住，Math 换成没有 random 的冻结副本），
// 随机只能用 rand(k)：每格固定、与计算顺序无关。遮住名字只保证确定性，不是安全边界——
// (()=>{}).constructor 仍然能拿到真正的 Function；安全靠把脚本放进隔离的 worker 里跑（见计划第三批“隔离”）。
//
// 出错分两种：
//   语法错误 —— 编译时抛 ScriptError（添加、修改脚本的命令当场被拒绝）；
//   运行时出错、算出 NaN、返回值类型不对 —— runScript 不抛错，返回 {ok: false, issue, output}，
//   output 是“当作没有这段脚本”的结果（系数 1、基础颜色、不匹配、地形不改），调用方照常用它。
//
// 编译好的函数只放在本模块的缓存里，绝不能放进会被克隆的数据（small、derived、命令、检查点）：
// structuredClone 和 postMessage 遇到函数会抛 DataCloneError。

// ---------- 容器与格式 ----------

export const SCRIPT_KINDS = ['placement', 'color', 'match', 'setup', 'crust'] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

// 每格（或每条河）运行一次的四种
export type CellKind = Exclude<ScriptKind, 'setup'>;

export const SCRIPT_KIND_LABEL: Record<ScriptKind, string> = {
  placement: '长在哪里',
  color: '颜色',
  match: '哪些河是这一种',
  setup: '布局',
  crust: '地形',
};

// 脚本接口的版本号：以后改变量、改返回值的含义时加 1，旧脚本按旧的规则运行
export const SCRIPT_API = 1;
export const MAX_SCRIPT_CHARS = 20000;

export const scriptSchema = z.object({ api: z.literal(SCRIPT_API), src: z.string().max(MAX_SCRIPT_CHARS) });
export type Script = z.output<typeof scriptSchema>;

// 生态、河流类型、星球形态都用同一个容器 `scripts`。全部可选、没有默认值：不写脚本的旧数据解析结果不变
export const scriptsSchema = z.object({
  placement: scriptSchema.optional(),
  color: scriptSchema.optional(),
  match: scriptSchema.optional(),
  setup: scriptSchema.optional(),
  crust: scriptSchema.optional(),
});
export type Scripts = z.output<typeof scriptsSchema>;

// 脚本源码的哈希（信任列表用）：按 UTF-8 字节，两条独立的通道（FNV-1a 与乘法混合），64 位十六进制
export function scriptHash(src: string): string {
  const bytes = new TextEncoder().encode(src);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ bytes.length;
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export interface FoundScript {
  // 显示用的名字（生态名、河流类型名……；没有名字时为 id）
  owner: string;
  // 所属对象的 id（种子用）；找不到为 undefined
  id?: string;
  kind: ScriptKind;
  src: string;
  hash: string;
  // 在 JSON 里的位置，如 commands[3].commands[0].species.scripts.placement
  path: string;
}

// 在任意 JSON（一条命令、整个世界文件、资源包）里找出全部脚本：凡是键为 scripts 的对象都算容器，
// 一直往下找（batch 里的命令、update_species 的 patch、星球形态……）。
// 所属对象：容器所在的对象，或者往上第一个带字符串 id 的对象（update_species 的 patch 没有 id，用命令的 id）
export function findScripts(json: unknown): FoundScript[] {
  const out: FoundScript[] = [];
  const chain: Record<string, unknown>[] = [];
  const visit = (v: unknown, path: string, depth: number) => {
    if (depth > 200 || v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) {
      v.forEach((x, k) => visit(x, `${path}[${k}]`, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    chain.push(o);
    const box = o.scripts;
    if (box !== null && typeof box === 'object' && !Array.isArray(box)) {
      let idObj: Record<string, unknown> | undefined;
      for (let k = chain.length - 1; k >= 0 && !idObj; k--) if (typeof chain[k].id === 'string') idObj = chain[k];
      const id = idObj?.id as string | undefined;
      const name = typeof o.name === 'string' ? o.name : typeof idObj?.name === 'string' ? (idObj.name as string) : undefined;
      for (const kind of SCRIPT_KINDS) {
        const s = (box as Record<string, unknown>)[kind];
        if (s === null || typeof s !== 'object') continue;
        const src = (s as Record<string, unknown>).src;
        if (typeof src !== 'string') continue;
        out.push({ owner: name || id || '脚本', id, kind, src, hash: scriptHash(src), path: `${path ? `${path}.` : ''}scripts.${kind}` });
      }
    }
    for (const [k, x] of Object.entries(o)) if (k !== 'scripts') visit(x, path ? `${path}.${k}` : k, depth + 1);
    chain.pop();
  };
  visit(json, '', 0);
  return out;
}

// ---------- 变量 ----------

export interface ScriptVariable {
  // 英文名与中文名，脚本里两个都能用
  key: string;
  zh?: string;
  // 编辑器“变量和例子”里的说明
  label: string;
  unit?: string;
  group: '气候' | '地形' | '水' | '位置' | '改动' | '世界' | '颜色' | '地形生成' | '布局';
  kinds: readonly ScriptKind[];
  // 整个世界一个值（不按格变）
  scalar?: true;
}

const CELL: readonly ScriptKind[] = ['placement', 'color', 'match'];
const CELL_CRUST: readonly ScriptKind[] = ['placement', 'color', 'match', 'crust'];
const ALL: readonly ScriptKind[] = SCRIPT_KINDS;

// 不提供省份变量：改省份的命令不触发重算，用了省份的脚本会和撤销、重放的结果不一致
export const VARIABLES: readonly ScriptVariable[] = [
  { key: 'tMean', zh: '年均温', label: '年平均气温', unit: '°C', group: '气候', kinds: CELL },
  { key: 'tWarm', zh: '最热月', label: '暖季（最热的半年）平均气温', unit: '°C', group: '气候', kinds: CELL },
  { key: 'tCold', zh: '最冷月', label: '冷季（最冷的半年）平均气温', unit: '°C', group: '气候', kinds: CELL },
  { key: 'precip', zh: '降水', label: '年降水量', unit: 'mm', group: '气候', kinds: CELL },
  { key: 'moisture', zh: '湿润', label: '湿润程度（降水 ÷ 蒸发能力；1 左右半干半湿，越大越湿）', group: '气候', kinds: CELL },
  { key: 'seasonality', zh: '四季', label: '降水的季节性（−1 到 1，正数是夏天多雨）', group: '气候', kinds: CELL },
  { key: 'continentality', zh: '大陆性', label: '大陆性（0 靠海，1 深居内陆）', group: '气候', kinds: CELL },
  { key: 'windX', zh: '风向东', label: '全年平均风的东西分量（向东为正）', group: '气候', kinds: CELL },
  { key: 'windY', zh: '风向南', label: '全年平均风的南北分量（向南为正）', group: '气候', kinds: CELL },
  { key: 'elevation', zh: '海拔', label: '海拔（海里是负的水深）', unit: 'm', group: '地形', kinds: CELL },
  { key: 'slope', zh: '坡度', label: '坡度', unit: 'm/km', group: '地形', kinds: CELL },
  { key: 'uplift', zh: '抬升', label: '抬升（山带的强弱，约 0–1.5）', group: '地形', kinds: CELL },
  { key: 'rock', zh: '岩性', label: '岩石软硬（0.4 坚硬 – 1.8 松软，越软越容易被冲刷）', group: '地形', kinds: CELL_CRUST },
  { key: 'lake', zh: '湖', label: '湖（0 不是湖，1 湖面，2 干涸的盐湖）', group: '地形', kinds: CELL },
  { key: 'coastDist', zh: '离海岸', label: '离海多远（海上为 0）', unit: 'km', group: '地形', kinds: CELL },
  { key: 'discharge', zh: '流量', label: '河流流量', unit: 'm³/s', group: '水', kinds: CELL },
  { key: 'wetness', zh: '湿度', label: '地形湿度（谷底、低洼处大，山脊上小）', group: '水', kinds: CELL },
  { key: 'drainArea', zh: '汇水', label: '上游汇水面积', unit: 'km²', group: '水', kinds: CELL },
  { key: 'isRiver', zh: '是河', label: '是不是河（1 是，0 不是）', group: '水', kinds: CELL },
  { key: 'riverDist', zh: '离河', label: '离最近的河多远', unit: 'km', group: '水', kinds: CELL },
  { key: 'x', label: '地图上的横坐标（地图高为 1）', group: '位置', kinds: CELL },
  { key: 'y', label: '地图上的纵坐标（向南增大）', group: '位置', kinds: CELL },
  { key: 'lat', zh: '纬度', label: '纬度（北纬为正）', unit: '°', group: '位置', kinds: CELL_CRUST },
  { key: 'lon', zh: '经度', label: '经度（东经为正；一块地区按地图中心算）', unit: '°', group: '位置', kinds: CELL_CRUST },
  { key: 'cell', label: '格的编号', group: '位置', kinds: CELL_CRUST },
  { key: 'areaKm2', zh: '面积', label: '这一格的面积', unit: 'km²', group: '位置', kinds: CELL },
  { key: 'px', label: '在星球上的位置（单位球面上的 x；一块地区为 0）', group: '位置', kinds: CELL_CRUST },
  { key: 'py', label: '在星球上的位置（单位球面上的 y；一块地区为 0）', group: '位置', kinds: CELL_CRUST },
  { key: 'pz', label: '在星球上的位置（单位球面上的 z，北极为 1；一块地区为 0）', group: '位置', kinds: CELL_CRUST },
  { key: 'tempEdit', zh: '冷暖改动', label: '用“冷暖”画笔改过的温度', unit: '°C', group: '改动', kinds: CELL },
  { key: 'moistEdit', zh: '干湿改动', label: '用“干湿”画笔改过的降水（对数：0 不变，0.69 加倍）', group: '改动', kinds: CELL },
  { key: 'seed', zh: '种子', label: '世界的种子', group: '世界', kinds: ALL, scalar: true },
  { key: 'globe', zh: '星球', label: '是不是整个星球（true / false）', group: '世界', kinds: ALL, scalar: true },
  { key: 'radiusKm', zh: '半径', label: '星球半径', unit: 'km', group: '世界', kinds: ALL, scalar: true },
  { key: 'tilt', zh: '轴倾角', label: '自转轴倾角', unit: '°', group: '世界', kinds: ALL, scalar: true },
  { key: 'solar', zh: '日照', label: '太阳强弱（地球为 1）', group: '世界', kinds: ALL, scalar: true },
  { key: 'humidity', zh: '水汽', label: '全局水汽（地球为 1）', group: '世界', kinds: ALL, scalar: true },
  { key: 'riverThreshold', zh: '河流门槛', label: '算作河的最小流量', unit: 'm³/s', group: '世界', kinds: ALL, scalar: true },
  { key: 'share', zh: '份额', label: '这一格里这种生态占的比例（0–1）', group: '颜色', kinds: ['color'] },
  { key: 'color', zh: '颜色', label: '生态本来的颜色 [r, g, b]（只读）', group: '颜色', kinds: ['color'], scalar: true },
  { key: 'height', zh: '高度', label: '这里原来的高度（海平面以上为正）', unit: 'm', group: '地形生成', kinds: ['crust'] },
  { key: 'mountains', zh: '山', label: '山的强弱（0–2）', group: '地形生成', kinds: ['crust'] },
  { key: 'hills', zh: '丘陵', label: '丘陵的强弱（0–0.5）', group: '地形生成', kinds: ['crust'] },
  { key: 'continent', zh: '大陆', label: '大陆场（大于 0 是大陆，小于 0 是大洋）', group: '地形生成', kinds: ['crust'] },
  { key: 'addBlock', zh: '加大陆块', label: '加一块大陆：addBlock({lat, lon, size, stretch, angle})', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'addIsland', zh: '加岛', label: '加一个岛：addIsland({lat, lon, height, size})', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'clearBlocks', zh: '清空大陆块', label: '去掉原来的大陆块', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'clearIslands', zh: '清空岛', label: '去掉原来的岛', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'blocks', zh: '大陆块', label: '原来的大陆块（只读列表，每项 {lat, lon, size}）', group: '布局', kinds: ['setup'], scalar: true },
];

// 辅助函数（编辑器的说明用；实现见下面的 HELPERS）
export const SCRIPT_HELPERS: readonly { name: string; usage: string; label: string }[] = [
  { name: 'noise', usage: 'noise(x, y, k = 0)', label: '二维噪声，约 −1 到 1；k 换一组' },
  { name: 'fbm', usage: 'fbm(x, y, oct = 4, gain = 0.5, k = 0)', label: '几层叠起来的二维噪声' },
  { name: 'noise3', usage: 'noise3(x, y, z, k = 0)', label: '三维噪声' },
  { name: 'fbm3', usage: 'fbm3(x, y, z, oct = 4, gain = 0.5, k = 0)', label: '几层叠起来的三维噪声' },
  { name: 'fbmAt', usage: 'fbmAt(freq, oct = 3, k = 0)', label: '这一格处的噪声（星球上没有接缝）；freq 是每个地图单位里的起伏次数' },
  { name: 'rand', usage: 'rand(k = 0)', label: '0–1 的随机数：每格固定，与计算顺序无关；换 k 得到另一组' },
  { name: 'field', usage: "field('名字')", label: '自定义场（或内置变量）在这一格的值' },
  { name: 'river', usage: "river('类型 id')", label: '离这种河多近（0–1，河上为 1）' },
  { name: 'smoothstep', usage: 'smoothstep(a, b, v)', label: 'v 从 a 到 b 平滑地从 0 变到 1' },
  { name: 'clamp', usage: 'clamp(v, lo = 0, hi = 1)', label: '把 v 限制在 lo 到 hi 之间' },
  { name: 'mix', usage: 'mix(a, b, t)', label: '按 t（0–1）在 a、b 之间取值' },
  { name: 'step', usage: 'step(edge, v)', label: 'v 小于 edge 为 0，否则为 1' },
  { name: 'mixColor', usage: 'mixColor(c1, c2, t)', label: '按 t 混合两种颜色（[r, g, b] 或 #rrggbb）' },
  { name: 'rgb', usage: 'rgb(r, g, b) 或 rgb("#rrggbb")', label: '颜色' },
  { name: 'Math', usage: 'Math.sin(x)…', label: '数学函数（没有 Math.random，用 rand()）' },
];

const VAR_BY_NAME = new Map<string, ScriptVariable>();
for (const v of VARIABLES) {
  VAR_BY_NAME.set(v.key, v);
  if (v.zh) VAR_BY_NAME.set(v.zh, v);
}

// 某种脚本能用的变量
export function scriptVariablesFor(kind: ScriptKind): ScriptVariable[] {
  return VARIABLES.filter((v) => v.kinds.includes(kind));
}

// 源码里出现了这个名字（前后不是字母、数字、_、$；中文名同样适用）
const NAME_RE = new Map<string, RegExp>();
for (const name of VAR_BY_NAME.keys()) {
  const esc = name.replace(/[$]/g, '\\$');
  NAME_RE.set(name, new RegExp(`(?<![\\p{L}\\p{N}_$])${esc}(?![\\p{L}\\p{N}_$])`, 'u'));
}

// ---------- 出错 ----------

export interface ScriptIssue {
  owner: string;
  kind: ScriptKind;
  // syntax 语法错误；runtime 运行时出错；value 返回值不对（NaN、类型）；disabled 安全模式下没有运行
  reason: 'syntax' | 'runtime' | 'value' | 'disabled';
  // 用户源码里的行号（从 1 起）；不知道时没有
  line?: number;
  // 出错的格（runScript 的 cells 里的值）
  cell?: number;
  // 原因（中文），编辑器的红字：`第 ${line} 行：${text}`
  text: string;
  // 引擎给的原始信息
  raw: string;
  // 完整的一句话：「X」的长在哪里脚本第 3 行出错：…
  message: string;
}

export class ScriptError extends CommandError {
  readonly owner: string;
  readonly kind: ScriptKind;
  readonly line: number | undefined;
  readonly cell: number | undefined;
  readonly issue: ScriptIssue;
  constructor(issue: ScriptIssue) {
    super(issue.message);
    this.name = 'ScriptError';
    this.owner = issue.owner;
    this.kind = issue.kind;
    this.line = issue.line;
    this.cell = issue.cell;
    this.issue = issue;
  }
}

function makeIssue(owner: string, kind: ScriptKind, reason: ScriptIssue['reason'], text: string, raw: string, line?: number, cell?: number): ScriptIssue {
  const where = `「${owner}」的${SCRIPT_KIND_LABEL[kind]}脚本${line ? `第 ${line} 行` : ''}`;
  const message =
    reason === 'syntax' ? `${where}有语法错误：${text}` : reason === 'disabled' ? `${where}没有运行：${text}` : `${where}出错：${text}`;
  return { owner, kind, reason, line, cell, text, raw, message };
}

// 编辑距离（按字符，中文也按一个字算）
function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, k) => k);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

function missingVariable(name: string, kind: ScriptKind): string {
  const v = VAR_BY_NAME.get(name);
  if (v && !v.kinds.includes(kind)) {
    return `${SCRIPT_KIND_LABEL[kind]}脚本里没有变量 ${name}（只有${v.kinds.map((k) => SCRIPT_KIND_LABEL[k]).join('、')}脚本能用）`;
  }
  const names = [...scriptVariablesFor(kind).flatMap((u) => (u.zh ? [u.key, u.zh] : [u.key])), ...HELPER_NAMES];
  let best = '';
  let bestD = Infinity;
  for (const c of names) {
    const d = c.toLowerCase() === name.toLowerCase() ? 0 : editDistance(name, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const len = Array.from(name).length;
  return bestD <= (len <= 3 ? 1 : 2) ? `没有变量 ${name}（是不是 ${best}？）` : `没有变量 ${name}`;
}

// 被遮住的名字（脚本里它们都是 undefined；Date、performance 一碰就报错，Math 是没有 random 的副本）
const SHADOW = [
  'globalThis',
  'self',
  'window',
  'Function',
  'eval',
  'Date',
  'performance',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'importScripts',
  'postMessage',
  'indexedDB',
  'caches',
  'crypto',
  'Worker',
  'require',
  'process',
  'Math',
] as const;

// 运行时的出错信息换成中文提示（V8、Firefox、Safari 的几种写法）
function runtimeText(raw: string, kind: ScriptKind): string {
  if (/Math\.random is not a function/.test(raw)) return '用 rand() 代替 Math.random()';
  if (/\b(Date|performance)\b/.test(raw)) return '脚本里不能用时间';
  const ref = /^(\S+) is not defined$/.exec(raw) ?? /^Can't find variable: (\S+)$/.exec(raw);
  if (ref) return missingVariable(ref[1], kind);
  const fn = /^(\S+) is not a function/.exec(raw);
  if (fn && (SHADOW as readonly string[]).includes(fn[1])) return `脚本里不能用 ${fn[1]}`;
  if (/Maximum call stack size exceeded|too much recursion/.test(raw)) return '函数调用太深了（是不是写了没有尽头的递归？）';
  const prop = /Cannot read properties of (undefined|null) \(reading '(.+)'\)/.exec(raw) ?? /can't access property "(.+)", .+ is (undefined|null)/.exec(raw);
  if (prop) return prop[0].startsWith('Cannot') ? `读不到「${prop[2]}」：前面的值是 ${prop[1]}` : `读不到「${prop[1]}」：前面的值是 ${prop[2]}`;
  if (fn) return `${fn[1]} 不是函数`;
  return raw;
}

const CLOSE_NAME: Record<string, string> = { '(': '右括号 )', '[': '右方括号 ]', '{': '右花括号 }' };
const OPEN_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

// 括号是否配对（跳过字符串、模板、注释）。V8 会用它自己包在外面的 } 补上没配对的 {，再报“不该出现 )”，
// 所以先数括号，说清楚少了哪一个
function bracketText(src: string): string | null {
  const stack: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 1;
    } else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c && (c === '`' || src[i] !== '\n'); i++) if (src[i] === '\\') i++;
    } else if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c in OPEN_OF) {
      const open = stack.pop();
      if (open === undefined) return `多了一个 ${c}`;
      if (open !== OPEN_OF[c]) return `括号没有配对：这里应该是${CLOSE_NAME[open]}，写成了 ${c}`;
    }
  }
  return stack.length ? `代码没写完（少了${CLOSE_NAME[stack[stack.length - 1]]}）` : null;
}

// 语法错误换成中文说明
function syntaxText(raw: string, src: string): string {
  let m: RegExpExecArray | null;
  const brackets = bracketText(src);
  if (brackets) return brackets;
  if (/Unexpected end of input|missing \} after function body|end of script|Unexpected EOF/i.test(raw)) return '代码没写完（是不是少了右括号 ) 或右花括号 }？）';
  if (/missing \) after argument list|missing \) in parenthetical|missing \) after condition|Expected '\)'/.test(raw)) return '少了右括号 )';
  if (/Unterminated template/i.test(raw)) return '反引号 ` 没有配对';
  if (/Unterminated string|unterminated string literal/i.test(raw)) return '引号没有配对';
  if (/Invalid or unexpected token|illegal character|Invalid character/i.test(raw)) {
    return /[（），；：“”‘’。、！？【】]/.test(src) ? '用了中文标点（，；（ ）“ ”），要换成英文标点' : '有不认识的字符（是不是引号没有配对？）';
  }
  if ((m = /Identifier '(.+)' has already been declared/.exec(raw) ?? /redeclaration of (?:let|const|var|formal parameter) (.+)/.exec(raw))) return `「${m[1]}」重复声明了`;
  if ((m = /Unexpected identifier(?: '(.+)')?/.exec(raw))) return `这里不该出现${m[1] ? `「${m[1]}」` : '名字'}（是不是少了运算符、逗号或分号？）`;
  if (/Unexpected number/.test(raw)) return '这里不该出现数字（是不是少了运算符或逗号？）';
  if (/Unexpected string/.test(raw)) return '这里不该出现字符串（是不是少了运算符或逗号？）';
  if (/reserved word|reserved identifier/i.test(raw)) return '用了保留字（比如 let、yield、static）当名字';
  if (/Octal/i.test(raw)) return '不能用 0 开头的八进制数字';
  if (/Invalid left-hand side in assignment|invalid assignment left-hand side/i.test(raw)) return '等号左边不能被赋值（比较是否相等要用 ===）';
  if (/Illegal (break|continue)/.test(raw)) return '这里不能用 break 或 continue';
  if ((m = /Unexpected token:? '?(.+?)'?$/i.exec(raw) ?? /expected expression, got '?(.+?)'?$/.exec(raw))) return `这里不该出现「${m[1]}」`;
  if (/missing ; before statement/.test(raw)) return '少了分号或运算符';
  return `语法不对（${raw}）`;
}

// ---------- 辅助函数 ----------

// 一次运行的状态。脚本同步地一段一段跑，所以全模块一份就够；辅助函数从这里读当前格与种子
interface RunState {
  active: boolean;
  kind: ScriptKind;
  cell: number;
  worldSeed: number;
  ownerHash: number;
  // 上一次 k 对应的种子（同一个 k 连续调用很常见）
  lastK: number;
  lastSeed: number;
  inputs: ScriptInputs | null;
  globe: boolean;
  // fbmAt、地形脚本的 rand 用的位置（第一次用到时才取）
  posReady: boolean;
  px: ArrayLike<number> | null;
  py: ArrayLike<number> | null;
  pz: ArrayLike<number> | null;
  mx: ArrayLike<number> | null;
  my: ArrayLike<number> | null;
  noise2: Map<number, Noise2>;
  noise3: Map<number, Noise3>;
  fields: Map<string, ArrayLike<number>>;
  rivers: Map<string, ArrayLike<number> | null>;
  // 布局脚本的 rand()：一条随机流
  stream: (() => number) | null;
  // 返回值不对时记下它（生成说明用）
  bad: unknown;
}

const RUN: RunState = {
  active: false,
  kind: 'placement',
  cell: 0,
  worldSeed: 0,
  ownerHash: 0,
  lastK: NaN,
  lastSeed: 0,
  inputs: null,
  globe: false,
  posReady: false,
  px: null,
  py: null,
  pz: null,
  mx: null,
  my: null,
  noise2: new Map(),
  noise3: new Map(),
  fields: new Map(),
  rivers: new Map(),
  stream: null,
  bad: undefined,
};

// mixSeed 的一步（展开写，避免每次调用都分配参数数组）；mixStep(mixStep(0x811c9dc5, a), b) >>> 0 = mixSeed(a, b)
function mixStep(h: number, p: number): number {
  h = Math.imul(h ^ (p >>> 0), 0x01000193);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return h ^ (h >>> 15);
}

// 第 k 组噪声、随机数的种子：mixSeed(世界种子, hashString(seedKey ?? 所属 id), k)
function seedFor(k: number): number {
  if (k !== RUN.lastK) {
    RUN.lastK = k;
    RUN.lastSeed = mixSeed(RUN.worldSeed, RUN.ownerHash, k);
  }
  return RUN.lastSeed;
}

function noise2For(k: number): Noise2 {
  const s = seedFor(k);
  let n = RUN.noise2.get(s);
  if (!n) RUN.noise2.set(s, (n = gradientNoise(s)));
  return n;
}

function noise3For(k: number): Noise3 {
  const s = seedFor(k);
  let n = RUN.noise3.get(s);
  if (!n) RUN.noise3.set(s, (n = gradientNoise3(s)));
  return n;
}

// 层数取 1–12 的整数（防止写错成很大的数卡住）
const octaves = (oct: number) => (oct >= 1 ? Math.min(12, Math.floor(oct)) : 1);

function bindPositions(): void {
  const inp = RUN.inputs;
  RUN.posReady = true;
  if (!inp) return;
  const arr = (key: string) => {
    const v = inp.get(key);
    return v !== undefined && typeof v === 'object' ? (v as ArrayLike<number>) : null;
  };
  RUN.px = arr('px');
  RUN.py = arr('py');
  RUN.pz = arr('pz');
  if (!RUN.globe) {
    RUN.mx = arr('x');
    RUN.my = arr('y');
  }
}

// 位置量化后再哈希（地形脚本）：缩略图与成品世界在同一位置得到同一个随机数，与格的编号无关
const quant = (v: number) => Math.round(v * 32768);

function rand(k = 0): number {
  const st = RUN;
  if (st.stream) return st.stream();
  const s = seedFor(k);
  if (st.kind === 'crust') {
    if (!st.posReady) bindPositions();
    if (st.px && st.py && st.pz) {
      const c = st.cell;
      return (mixStep(mixStep(mixStep(mixStep(0x811c9dc5, s), quant(st.px[c])), quant(st.py[c])), quant(st.pz[c])) >>> 0) / 4294967296;
    }
  }
  return (mixStep(mixStep(0x811c9dc5, s), st.cell) >>> 0) / 4294967296;
}

function fbmAt(freq: number, oct = 3, k = 0): number {
  const st = RUN;
  if (!st.posReady) bindPositions();
  const c = st.cell;
  if (st.globe) {
    if (!st.px || !st.py || !st.pz) throw new Error('这里没有格的位置，不能用 fbmAt（用 fbm3）');
    return fbm3Kernel(noise3For(k), st.px[c], st.py[c], st.pz[c], freq / Math.PI, octaves(oct), 0.5);
  }
  if (!st.mx || !st.my) throw new Error('这里没有格的位置，不能用 fbmAt（用 fbm）');
  return fbmKernel(noise2For(k), st.mx[c], st.my[c], freq, octaves(oct), 0.5);
}

function field(name: string): number {
  const st = RUN;
  let a = st.fields.get(name);
  if (!a) {
    const key = String(name);
    a = st.inputs?.field?.(key);
    if (!a) {
      const v = VAR_BY_NAME.get(key);
      const got = v && !v.scalar ? st.inputs?.get(v.key) : undefined;
      if (got !== undefined && typeof got === 'object') a = got as ArrayLike<number>;
    }
    if (!a) throw new Error(`没有自定义场「${key}」`);
    st.fields.set(name, a);
  }
  return a[st.cell];
}

// 离某种河多近（0–1）。由引擎的 inputs.river 提供；没有这种河（或还没有河流类型）时为 0
function river(typeId: string): number {
  const st = RUN;
  let a = st.rivers.get(typeId);
  if (a === undefined) {
    a = st.inputs?.river?.(String(typeId)) ?? null;
    st.rivers.set(typeId, a);
  }
  return a ? a[st.cell] : 0;
}

type Rgb = [number, number, number];

// 颜色：[r, g, b]（0–255）或 '#rrggbb' / '#rgb'；不认识时为 null
function parseColor(v: unknown): Rgb | null {
  if (typeof v === 'string') {
    const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = v as ArrayLike<unknown>;
    if (a.length < 3) return null;
    const r = a[0];
    const g = a[1];
    const b = a[2];
    if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return null;
    return [r, g, b];
  }
  return null;
}

function colorOf(v: unknown): Rgb {
  const c = parseColor(v);
  if (!c) throw new Error(`颜色格式不对：${describe(v)}（要 [r, g, b] 或 '#rrggbb'）`);
  return c;
}

const HELPERS = Object.freeze({
  noise: (x: number, y: number, k = 0) => noise2(seedFor(k), x, y),
  fbm: (x: number, y: number, oct = 4, gain = 0.5, k = 0) => fbmKernel(noise2For(k), x, y, 1, octaves(oct), gain),
  noise3: (x: number, y: number, z: number, k = 0) => noise3Kernel(seedFor(k), x, y, z),
  fbm3: (x: number, y: number, z: number, oct = 4, gain = 0.5, k = 0) => fbm3Kernel(noise3For(k), x, y, z, 1, octaves(oct), gain),
  fbmAt,
  rand,
  field,
  river,
  smoothstep: (a: number, b: number, v: number) => (a === b ? (v < a ? 0 : 1) : smoothKernel(a, b, v)),
  clamp: (v: number, lo = 0, hi = 1) => clampRange(v, lo, hi),
  mix: (a: number, b: number, t: number) => a + (b - a) * t,
  step: (edge: number, v: number) => (v < edge ? 0 : 1),
  mixColor: (a: unknown, b: unknown, t: number): Rgb => {
    const x = colorOf(a);
    const y = colorOf(b);
    return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  },
  rgb: (r: unknown, g?: number, b?: number): Rgb => (typeof r === 'string' ? colorOf(r) : colorOf([r, g, b])),
});
const HELPER_NAMES = Object.keys(HELPERS);
// 函数本身也冻结：脚本不能在 noise.foo 上记东西（那样就和计算顺序有关了）
for (const f of Object.values(HELPERS)) Object.freeze(f);

// Math 的冻结副本，没有 random
const SAFE_MATH = Object.freeze(
  Object.fromEntries(
    Object.getOwnPropertyNames(Math)
      .filter((k) => k !== 'random')
      .map((k) => [k, (Math as unknown as Record<string, unknown>)[k]]),
  ),
);

// 一碰就报错的替身（Date、performance）：读属性、调用、new 都抛出带名字的错误，出错提示据此说“不能用时间”
function poison(name: string): unknown {
  const fail = (): never => {
    throw new TypeError(`${name} is not available in scripts`);
  };
  return new Proxy(function () {}, { get: fail, set: fail, apply: fail, construct: fail, has: fail, getPrototypeOf: fail });
}
const SHADOW_VALUES: unknown[] = SHADOW.map((n) => (n === 'Math' ? SAFE_MATH : n === 'Date' || n === 'performance' ? poison(n) : undefined));

// ---------- 编译 ----------

// 一个变量在循环里怎么传：按格取数组、整个世界一个值、格的编号
export type ParamMode = 'array' | 'scalar' | 'cell';
export interface ScriptParam {
  name: string;
  key: string;
  mode: ParamMode;
}

export interface CompiledScript {
  readonly kind: ScriptKind;
  readonly src: string;
  // 源码里出现的变量名（按 VARIABLES 的顺序；中文名、英文名各算一个参数）
  readonly names: readonly string[];
  // 每个参数对应的英文名
  readonly keys: readonly string[];
  readonly params: readonly ScriptParam[];
  // 每格的函数（参数就是 names）；布局脚本直接调用它
  readonly script: (...args: unknown[]) => unknown;
  // 整段循环（布局脚本没有）：(cells, out, host, put, ...输入) → 出错的下标，全部正常为 −1
  readonly loop: ((...args: unknown[]) => number) | null;
}

interface Failure {
  raw: string;
  text: string;
  line?: number;
}

// 编译缓存：键为 kind + '\0' + 源码，最近用过的 128 段。编辑器每次停顿都会提交一次，同一段源码不重复编译。
// 编译出的函数只在这里（以及调用方临时的局部变量里），不能放进会被克隆的数据
const CACHE_SIZE = 128;
const cache = new Map<string, CompiledScript | Failure>();

// 统计（测试用）
export const scriptStats = { compiles: 0, hits: 0 };

let enabled = true;
let disallowed = false;

// 安全模式：在一个 worker 的生命周期内由调用方固定（关掉后所有脚本都按“没有脚本”处理）
export function setScriptsEnabled(on: boolean): void {
  enabled = on;
}
export function scriptsEnabled(): boolean {
  return enabled;
}

// 主线程调用：之后任何编译都抛错，防止不小心在主线程跑用户代码
export function disallowScripts(): void {
  disallowed = true;
}

// 语法错误的行号：V8 的 new Function 不给行号，编辑器可以装一个只做解析的定位器（比如懒加载的 acorn）
let syntaxLocator: ((src: string) => number | undefined) | null = null;
export function setSyntaxLocator(f: ((src: string) => number | undefined) | null): void {
  syntaxLocator = f;
}

function paramsOf(kind: ScriptKind, src: string): ScriptParam[] {
  const out: ScriptParam[] = [];
  for (const v of VARIABLES) {
    if (!v.kinds.includes(kind)) continue;
    const mode: ParamMode = v.key === 'cell' ? 'cell' : v.scalar ? 'scalar' : 'array';
    for (const name of v.zh ? [v.key, v.zh] : [v.key]) if (NAME_RE.get(name)!.test(src)) out.push({ name, key: v.key, mode });
  }
  return out;
}

// 每种脚本的返回值在循环里就地检查、写进输出（长在哪里、河流匹配直接写；颜色、地形交给 put）
function convertSource(kind: ScriptKind): string {
  switch (kind) {
    case 'placement':
      return (
        "if (typeof __v === 'number') { if (__v !== __v) { __st.bad = __v; return __j; } __out[__j] = __v < 0 ? 0 : __v > 1 ? 1 : __v; }\n" +
        'else if (__v === true) __out[__j] = 1;\nelse if (__v === false) __out[__j] = 0;\nelse { __st.bad = __v; return __j; }\n'
      );
    case 'match':
      return '__out[__j] = __v ? 1 : 0;\n';
    default:
      return 'if (!__put(__v, __j)) { __st.bad = __v; return __j; }\n';
  }
}

// 生成的代码（外层是宽松模式的工厂，参数遮住全局名字；里面的函数都是严格模式）。
// 用户源码前面的行数固定（所有声明写在同一行），所以运行时的行号只差一个按种类标定的常数。
// 用户源码放在一个块里：用户自己声明与变量同名的 const/let 是合法的遮蔽，不会和参数冲突
function generate(kind: ScriptKind, src: string, params: ScriptParam[]): string {
  const helpers = HELPER_NAMES.map((h) => `${h} = __h.${h}`).join(', ');
  const head = `const ${helpers};\nfunction __map2_script(${params.map((p) => p.name).join(', ')}) { "use strict"; {\n`;
  let loop = 'const __map2_loop = null;';
  if (kind !== 'setup') {
    const inputs: string[] = [];
    const args = params.map((p) => {
      if (p.mode === 'cell') return '__i';
      const a = `__a${inputs.length}`;
      inputs.push(a);
      return p.mode === 'array' ? `${a}[__i]` : a;
    });
    loop =
      `function __map2_loop(${['__cells', '__out', '__host', '__put', ...inputs].join(', ')}) {\n"use strict";\n` +
      'const __m = __cells.length;\nfor (let __j = 0; __j < __m; __j++) {\nconst __i = __cells[__j];\n__st.cell = __i;\n' +
      `const __v = __map2_script(${args.join(', ')});\n${convertSource(kind)}` +
      'if ((__j & 255) === 255) __host.tick();\n}\nreturn -1;\n}';
  }
  return `${head}${src}\n} }\n${loop}\nreturn [__map2_script, __map2_loop];`;
}

function build(kind: ScriptKind, src: string): CompiledScript {
  const params = paramsOf(kind, src);
  const factory = new Function(...SHADOW, '__h', '__st', generate(kind, src, params)) as (...a: unknown[]) => [CompiledScript['script'], CompiledScript['loop']];
  const [script, loop] = factory(...SHADOW_VALUES, HELPERS, RUN);
  return { kind, src, names: params.map((p) => p.name), keys: params.map((p) => p.key), params, script, loop };
}

// 语法检查：源码单独作为一个严格模式的函数体能通过解析，才放进生成的代码（这样它不可能用多余的 } 跑出那个块）
function syntaxFailure(src: string): Failure | null {
  try {
    new Function(`"use strict";${src}\n`);
    return null;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return { raw, text: syntaxText(raw, src), line: firefoxSyntaxLine(e, src) };
  }
}

export function compileScript(kind: ScriptKind, src: string, owner = '脚本'): CompiledScript {
  if (disallowed) throw new Error('主线程不运行脚本');
  const key = `${kind}\0${src}`;
  let hit = cache.get(key);
  if (hit) {
    scriptStats.hits++;
    cache.delete(key);
    cache.set(key, hit);
  } else {
    scriptStats.compiles++;
    if (src.length > MAX_SCRIPT_CHARS) hit = { raw: 'too long', text: `脚本太长了（最多 ${MAX_SCRIPT_CHARS} 个字符）` };
    else hit = syntaxFailure(src) ?? undefined;
    if (!hit) {
      try {
        hit = build(kind, src);
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        hit = { raw, text: syntaxText(raw, src) };
      }
    }
    cache.set(key, hit);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  // 行号的定位器可能是缓存之后才装上的，所以每次报错时再问一次
  if ('raw' in hit) throw new ScriptError(makeIssue(owner, kind, 'syntax', hit.text, hit.raw, hit.line ?? syntaxLocator?.(src)));
  return hit;
}

// ---------- 行号 ----------

// 错误栈里第一处生成代码的位置（V8：“<anonymous>:行:列”；Firefox：“> Function:行:列”）。
// 辅助函数里抛出的错误也会落在调用它的那一行
function stackLine(e: unknown): number | undefined {
  const stack = e instanceof Error ? e.stack : undefined;
  if (!stack) return undefined;
  for (const l of stack.split('\n')) {
    const m = /<anonymous>:(\d+):\d+\)?\s*$/.exec(l) ?? /> (?:Function|eval):(\d+):\d+\s*$/.exec(l);
    if (m) return Number(m[1]);
  }
  return undefined;
}

// 每种脚本的行号偏移：第一次需要时编译一段第 1 行就抛错的脚本，看栈里报的是第几行
const lineOffset = new Map<ScriptKind, number | null>();
function offsetFor(kind: ScriptKind): number | null {
  let off = lineOffset.get(kind);
  if (off === undefined) {
    off = null;
    try {
      build(kind, 'throw new Error("probe");').script();
    } catch (e) {
      const l = stackLine(e);
      off = l === undefined ? null : l - 1;
    }
    lineOffset.set(kind, off);
  }
  return off;
}

function userLine(e: unknown, kind: ScriptKind, src: string): number | undefined {
  const l = stackLine(e);
  const off = l === undefined ? null : offsetFor(kind);
  if (l === undefined || off === null) return undefined;
  const line = l - off;
  return line >= 1 && line <= src.split('\n').length ? line : undefined;
}

// Firefox 的 SyntaxError 带 lineNumber（相对 new Function 的源码）：同样用一段第 1 行就出错的源码标定
let syntaxOffset: number | null | undefined;
function firefoxSyntaxLine(e: unknown, src: string): number | undefined {
  const l = (e as { lineNumber?: unknown }).lineNumber;
  if (typeof l !== 'number') return undefined;
  if (syntaxOffset === undefined) {
    syntaxOffset = null;
    try {
      new Function('"use strict";)\n');
    } catch (p) {
      const pl = (p as { lineNumber?: unknown }).lineNumber;
      if (typeof pl === 'number') syntaxOffset = pl - 1;
    }
  }
  if (syntaxOffset === null) return undefined;
  const line = l - syntaxOffset;
  return line >= 1 && line <= src.split('\n').length ? line : undefined;
}

// ---------- 输入 ----------

export type InputValue = ArrayLike<number> | number | boolean | readonly number[];

// 脚本的输入：按变量的英文名取。只有源码里用到的变量才会来取，所以贵的（离海岸、离河）可以在 get 里现算
export interface ScriptInputs {
  // 数组的长度（格数）
  n: number;
  // 整个星球：fbmAt 用三维噪声
  globe: boolean;
  get(key: string): InputValue | undefined;
  // 自定义场
  field?(name: string): ArrayLike<number> | undefined;
  // 河岸场 river:<id>（0–1）；由引擎在有河流类型后提供
  river?(typeId: string): ArrayLike<number> | undefined;
}

// 直接用几份数组作输入（测试、地形脚本、每条河一次的 match 用）。自定义场写成 'field:名字'
export function arrayInputs(
  n: number,
  values: Record<string, InputValue>,
  opts: { globe?: boolean; river?: (typeId: string) => ArrayLike<number> | undefined } = {},
): ScriptInputs {
  return {
    n,
    globe: opts.globe ?? false,
    get: (key) => values[key],
    field: (name) => values[`field:${name}`] as ArrayLike<number> | undefined,
    river: opts.river,
  };
}

// 按内容缓存的距离场（离海岸、离河）：causes.land 是原地改的，所以不能按数组本身做键，要逐字节比较
interface DistMemo {
  key: Uint8Array[];
  value: Float64Array;
}
const distMemo = new WeakMap<Mesh, Map<string, DistMemo[]>>();

function bytesOf(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let k = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const m = a.length >> 2;
    const x = new Int32Array(a.buffer, a.byteOffset, m);
    const y = new Int32Array(b.buffer, b.byteOffset, m);
    for (let i = 0; i < m; i++) if (x[i] !== y[i]) return false;
    k = m * 4;
  }
  for (; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

function memoDist(mesh: Mesh, name: string, inputs: ArrayBufferView[], compute: () => Float64Array): Float64Array {
  const key = inputs.map(bytesOf);
  let byName = distMemo.get(mesh);
  if (!byName) distMemo.set(mesh, (byName = new Map()));
  const list = byName.get(name) ?? [];
  const hit = list.find((m) => m.key.length === key.length && m.key.every((b, k) => sameBytes(b, key[k])));
  if (hit) return hit.value;
  const value = compute();
  byName.set(name, [{ key: key.map((b) => b.slice()), value }, ...list].slice(0, 2));
  return value;
}

// 星球上的单位向量拆成三份（一块地区为 0）
const posMemo = new WeakMap<Mesh, { px: Float64Array; py: Float64Array; pz: Float64Array }>();
function positionsOf(mesh: Mesh) {
  let p = posMemo.get(mesh);
  if (!p) {
    const n = mesh.n;
    if (mesh.kind === 'sphere') {
      p = { px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n) };
      for (let i = 0; i < n; i++) {
        p.px[i] = mesh.p[3 * i];
        p.py[i] = mesh.p[3 * i + 1];
        p.pz[i] = mesh.p[3 * i + 2];
      }
    } else {
      const zero = new Float64Array(n);
      p = { px: zero, py: zero, pz: zero };
    }
    posMemo.set(mesh, p);
  }
  return p;
}

// 一个世界的标准输入。extra 补上颜色脚本的 share、color 等；river 由引擎在有河流类型后提供
export function worldInputs(
  world: World,
  d: Derived = world.derived,
  opts: { extra?: Record<string, InputValue>; river?: (typeId: string) => ArrayLike<number> | undefined } = {},
): ScriptInputs {
  const { mesh, causes, settings, small } = world;
  const n = mesh.n;
  const km = world.kmPerUnit;
  const made = new Map<string, InputValue>();
  const lazy = (key: string, f: () => InputValue) => {
    let v = made.get(key);
    if (v === undefined) made.set(key, (v = f()));
    return v;
  };
  const isRiver = () =>
    lazy('isRiver', () => {
      const out = new Uint8Array(n);
      const t = small.planet.riverThreshold;
      for (let i = 0; i < n; i++) out[i] = causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= t ? 1 : 0;
      return out;
    }) as Uint8Array;
  const get = (key: string): InputValue | undefined => {
    const e = opts.extra?.[key];
    if (e !== undefined) return e;
    switch (key) {
      case 'tMean':
      case 'tWarm':
      case 'tCold':
      case 'precip':
      case 'moisture':
      case 'seasonality':
      case 'continentality':
      case 'elevation':
      case 'slope':
      case 'lake':
      case 'discharge':
      case 'wetness':
      case 'drainArea':
        return d[key];
      case 'windX':
        return lazy(key, () => Float32Array.from(d.windSX, (v, i) => (v + d.windWX[i]) / 2));
      case 'windY':
        return lazy(key, () => Float32Array.from(d.windSY, (v, i) => (v + d.windWY[i]) / 2));
      case 'uplift':
        return causes.uplift;
      case 'rock':
        return causes.erod;
      case 'tempEdit':
        return causes.tempOffset;
      case 'moistEdit':
        return causes.moistOffset;
      case 'coastDist':
        return memoDist(mesh, 'coast', [causes.land, Float64Array.of(km)], () => {
          const sea: number[] = [];
          for (let i = 0; i < n; i++) if (causes.land[i] === 0) sea.push(i);
          return graphDistance(mesh, sea).map((v) => v * km);
        });
      case 'isRiver':
        return isRiver();
      case 'riverDist':
        return memoDist(mesh, 'river', [causes.land, d.lake, d.discharge, Float64Array.of(small.planet.riverThreshold, km)], () => {
          const r = isRiver();
          const seeds: number[] = [];
          for (let i = 0; i < n; i++) if (r[i]) seeds.push(i);
          return graphDistance(mesh, seeds).map((v) => v * km);
        });
      case 'x':
        return mesh.x;
      case 'y':
        return mesh.y;
      case 'lat':
        return lazy(key, () => Float64Array.from(mesh.y, (y) => worldLatitude(world, y)));
      case 'lon': {
        // 一块地区按赤道尺度把 x 换成相对地图中心的经度（与地名表导出相同）
        const span = (mesh.width * km) / 111.2;
        return lazy(key, () => Float64Array.from(mesh.x, (x) => (settings.globe ? longitudeOf(x) : (x / mesh.width - 0.5) * span)));
      }
      case 'areaKm2':
        return lazy(key, () => Float64Array.from(mesh.area, (a) => a * km * km));
      case 'px':
      case 'py':
      case 'pz':
        return positionsOf(mesh)[key];
      case 'seed':
        return small.terrain.gen?.seed ?? settings.seed;
      case 'globe':
        return settings.globe === true;
      case 'radiusKm':
        return planetRadiusKm(settings);
      case 'tilt':
      case 'solar':
      case 'humidity':
      case 'riverThreshold':
        return small.planet[key];
      default:
        return undefined;
    }
  };
  return {
    n,
    globe: mesh.kind === 'sphere',
    get,
    field: (name) => {
      const arr = causes.fields[name];
      if (!arr) return undefined;
      const corr = d.corrF[name];
      return corr ? (lazy(`field:${name}`, () => arr.map((v, i) => v + corr[i])) as Float32Array) : arr;
    },
    river: opts.river,
  };
}

// ---------- 运行 ----------

// 看门狗（worker 里装一个发消息的；Node 里什么也不做）：进入脚本时 enter，每 256 格 tick，结束时（含出错）exit
export interface ScriptHost {
  enter(label: string): void;
  tick(): void;
  exit(): void;
}
const NO_HOST: ScriptHost = { enter() {}, tick() {}, exit() {} };
let host: ScriptHost = NO_HOST;
export function setScriptHost(h: ScriptHost | null): void {
  host = h ?? NO_HOST;
}

export interface CrustOutput {
  height: Float64Array;
  mountains: Float64Array;
  hills: Float64Array;
  rock: Float64Array;
}

// 每种脚本的输出，与 cells 一一对应（第 j 项是 cells[j] 的结果）
export interface CellOutputs {
  // 0–1 的系数
  placement: { factor: Float32Array };
  // 每格 3 个字节
  color: { rgb: Uint8Array };
  // 1 匹配，0 不匹配
  match: { match: Uint8Array };
  // 改过的地形（没改的项是原来的值）
  crust: CrustOutput;
}

// 出错时 output 是“当作没有这段脚本”的结果，调用方照常用它
export type CellResult<K extends CellKind = CellKind> =
  | { ok: true; output: CellOutputs[K] }
  | { ok: false; issue: ScriptIssue; output: CellOutputs[K] };

export interface RunOptions {
  // 显示用的名字（出错说明、看门狗的提示）
  owner: string;
  // 所属对象的 id；噪声与 rand 的种子用 seedKey ?? id ?? owner
  id?: string;
  seedKey?: string;
  // 世界种子（gen?.seed ?? settings.seed）；省略时取输入里的 seed
  seed?: number;
  inputs: ScriptInputs;
  // 对哪些格运行（下标进输入数组）
  cells: ArrayLike<number>;
}

// 地形脚本返回值的范围
const CRUST_RANGE: Record<keyof CrustOutput, [number, number]> = {
  height: [-11000, 9000],
  mountains: [0, 2],
  hills: [0, 0.5],
  rock: [0.4, 1.8],
};
const CRUST_KEYS = Object.keys(CRUST_RANGE) as (keyof CrustOutput)[];

function crustBase(inputs: ScriptInputs, cells: ArrayLike<number>): CrustOutput {
  const m = cells.length;
  const out = {} as CrustOutput;
  for (const k of CRUST_KEYS) {
    const a = new Float64Array(m);
    const src = inputs.get(k);
    if (src !== undefined && typeof src === 'object') for (let j = 0; j < m; j++) a[j] = (src as ArrayLike<number>)[cells[j]];
    out[k] = a;
  }
  return out;
}

// 当作没有这段脚本：系数 1、基础颜色、不匹配、地形不改
function absentOutput(kind: CellKind, inputs: ScriptInputs, cells: ArrayLike<number>): CellOutputs[CellKind] {
  const m = cells.length;
  switch (kind) {
    case 'placement':
      return { factor: new Float32Array(m).fill(1) };
    case 'match':
      return { match: new Uint8Array(m) };
    case 'color': {
      const c = parseColor(inputs.get('color')) ?? [0, 0, 0];
      const rgb = new Uint8Array(m * 3);
      for (let j = 0; j < m; j++) for (let t = 0; t < 3; t++) rgb[3 * j + t] = Math.round(clampRange(c[t], 0, 255));
      return { rgb };
    }
    case 'crust':
      return crustBase(inputs, cells);
  }
}

function describe(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (typeof v === 'string') return `文字 "${v.length > 20 ? `${v.slice(0, 20)}…` : v}"`;
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `有 ${v.length} 项的数组`;
  if (typeof v === 'function') return '函数';
  return '对象';
}

function hasNaN(v: unknown): boolean {
  if (typeof v === 'number') return Number.isNaN(v);
  if (Array.isArray(v)) return v.slice(0, 3).some((x) => typeof x === 'number' && Number.isNaN(x));
  if (v && typeof v === 'object') return CRUST_KEYS.some((k) => Number.isNaN((v as Record<string, unknown>)[k]));
  return false;
}

// 返回值不对时的说明
function valueText(kind: CellKind, v: unknown): string {
  if (v === undefined) return '地图上有一处没有返回值（是不是忘了写 return？）';
  if (hasNaN(v)) return '地图上有一处算出了 NaN（不是数字）';
  const want =
    kind === 'placement'
      ? '0 到 1 之间的数，或 true / false'
      : kind === 'color'
        ? "颜色 [r, g, b] 或 '#rrggbb'"
        : '新的高度（一个数），或 {height, mountains, hills, rock}';
  return `应该返回${want}，地图上有一处返回了${describe(v)}`;
}

function putFor(kind: CellKind, out: CellOutputs[CellKind]): ((v: unknown, j: number) => boolean) | null {
  if (kind === 'color') {
    const rgb = (out as CellOutputs['color']).rgb;
    return (v, j) => {
      const c = parseColor(v);
      if (!c || c[0] !== c[0] || c[1] !== c[1] || c[2] !== c[2]) return false;
      rgb[3 * j] = Math.round(clampRange(c[0], 0, 255));
      rgb[3 * j + 1] = Math.round(clampRange(c[1], 0, 255));
      rgb[3 * j + 2] = Math.round(clampRange(c[2], 0, 255));
      return true;
    };
  }
  if (kind === 'crust') {
    const o = out as CrustOutput;
    return (v, j) => {
      if (typeof v === 'number') {
        if (v !== v) return false;
        o.height[j] = clampRange(v, CRUST_RANGE.height[0], CRUST_RANGE.height[1]);
        return true;
      }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
      const r = v as Record<string, unknown>;
      for (const k of CRUST_KEYS) {
        const x = r[k];
        if (x === undefined) continue;
        if (typeof x !== 'number' || x !== x) return false;
        o[k][j] = clampRange(x, CRUST_RANGE[k][0], CRUST_RANGE[k][1]);
      }
      return true;
    };
  }
  return null;
}

function begin(kind: ScriptKind, opts: { owner: string; id?: string; seedKey?: string; seed?: number }, inputs: ScriptInputs | null, seed: number) {
  if (RUN.active) throw new Error('脚本不能嵌套运行');
  RUN.active = true;
  RUN.kind = kind;
  RUN.cell = 0;
  RUN.worldSeed = seed >>> 0;
  RUN.ownerHash = hashString(opts.seedKey ?? opts.id ?? opts.owner);
  RUN.lastK = NaN;
  RUN.inputs = inputs;
  RUN.globe = inputs?.globe ?? false;
  RUN.posReady = false;
  RUN.bad = undefined;
}

function end() {
  RUN.active = false;
  RUN.inputs = null;
  RUN.px = RUN.py = RUN.pz = RUN.mx = RUN.my = null;
  RUN.noise2.clear();
  RUN.noise3.clear();
  RUN.fields.clear();
  RUN.rivers.clear();
  RUN.stream = null;
  RUN.bad = undefined;
}

// 对一串格运行一段每格的脚本。出错不抛（语法错误、运行时出错、NaN、类型不对、安全模式），
// 返回 {ok: false, issue, output}，output 为“没有这段脚本”的结果；超出范围的数被截到范围内
export function runScript<K extends CellKind>(script: { kind: K; src: string }, opts: RunOptions): CellResult<K> {
  const { kind, src } = script;
  const { inputs, cells, owner } = opts;
  const fail = (issue: ScriptIssue): CellResult<K> => ({ ok: false, issue, output: absentOutput(kind, inputs, cells) as CellOutputs[K] });
  if (!enabled) return fail(makeIssue(owner, kind, 'disabled', '安全模式下脚本不运行', 'disabled'));
  let c: CompiledScript;
  try {
    c = compileScript(kind, src, owner);
  } catch (e) {
    if (e instanceof ScriptError) return fail(e.issue);
    throw e;
  }
  // 绑定输入：只取源码里用到的变量
  const args: unknown[] = [];
  for (const p of c.params) {
    if (p.mode === 'cell') continue;
    let v: unknown = inputs.get(p.key);
    if (v === undefined) return fail(makeIssue(owner, kind, 'runtime', `这里没有变量 ${p.name}`, `missing input ${p.key}`));
    if (p.mode === 'array' && typeof v !== 'object') v = new Float64Array(inputs.n).fill(Number(v));
    if (p.key === 'color' && typeof v === 'object') v = Object.freeze(Array.from(v as ArrayLike<number>));
    args.push(v);
  }
  const out = (kind === 'crust' ? crustBase(inputs, cells) : absentOutput(kind, inputs, cells)) as CellOutputs[K];
  const target = kind === 'placement' ? (out as CellOutputs['placement']).factor : kind === 'match' ? (out as CellOutputs['match']).match : null;
  const put = putFor(kind, out);
  const seed = opts.seed ?? Number(inputs.get('seed') ?? 0);
  begin(kind, opts, inputs, seed);
  let issue: ScriptIssue | null = null;
  const h = host;
  h.enter(owner);
  try {
    const bad = c.loop!(cells, target, h, put, ...args);
    if (bad >= 0) issue = makeIssue(owner, kind, 'value', valueText(kind, RUN.bad), describe(RUN.bad), undefined, cells[bad]);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    issue = makeIssue(owner, kind, 'runtime', runtimeText(raw, kind), raw, userLine(e, kind, src), RUN.cell);
  } finally {
    h.exit();
    end();
  }
  return issue ? fail(issue) : { ok: true, output: out };
}

export type SetupResult = { ok: true; value: unknown } | { ok: false; issue: ScriptIssue };

// 布局脚本：每个星球模型运行一次。values 给出世界的参数与 addBlock 等函数；
// rand() 是一条独立的随机流 mulberry32(mixSeed(seed, 105, 0x3d))（每次调用取下一个数）
export function runSetup(script: { src: string }, opts: { owner: string; id?: string; seedKey?: string; seed: number; values: Record<string, unknown> }): SetupResult {
  const kind = 'setup';
  const { owner, values } = opts;
  if (!enabled) return { ok: false, issue: makeIssue(owner, kind, 'disabled', '安全模式下脚本不运行', 'disabled') };
  let c: CompiledScript;
  try {
    c = compileScript(kind, script.src, owner);
  } catch (e) {
    if (e instanceof ScriptError) return { ok: false, issue: e.issue };
    throw e;
  }
  const args: unknown[] = [];
  for (const p of c.params) {
    const v = values[p.key];
    if (v === undefined) return { ok: false, issue: makeIssue(owner, kind, 'runtime', `这里没有变量 ${p.name}`, `missing input ${p.key}`) };
    args.push(v);
  }
  begin(kind, opts, null, opts.seed);
  RUN.stream = mulberry32(mixSeed(opts.seed, 105, 0x3d));
  const h = host;
  h.enter(owner);
  try {
    return { ok: true, value: c.script(...args) };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return { ok: false, issue: makeIssue(owner, kind, 'runtime', runtimeText(raw, kind), raw, userLine(e, kind, script.src)) };
  } finally {
    h.exit();
    end();
  }
}

export interface PurityResult {
  pure: boolean;
  // 正反两次结果不同的第一格
  cell?: number;
  // 有一次运行失败
  issue?: ScriptIssue;
}

// 纯度检查：同一批格正着算一遍、倒着算一遍，结果逐值相同才算纯（“记住上一格”的脚本会露馅）。
// 只对纯的脚本才能做“只重算输入变了的格”，所以提交前要检查
export function checkPurity(run: (cells: Int32Array) => CellResult, cells: ArrayLike<number>): PurityResult {
  const fwd = Int32Array.from(cells);
  const rev = fwd.slice().reverse();
  const a = run(fwd);
  if (!a.ok) return { pure: false, issue: a.issue };
  const b = run(rev);
  if (!b.ok) return { pure: false, issue: b.issue };
  const m = fwd.length;
  if (!m) return { pure: true };
  const x = a.output as unknown as Record<string, ArrayLike<number>>;
  const y = b.output as unknown as Record<string, ArrayLike<number>>;
  for (const key of Object.keys(x)) {
    const s = x[key].length / m;
    for (let j = 0; j < m; j++) {
      for (let t = 0; t < s; t++) if (!Object.is(x[key][j * s + t], y[key][(m - 1 - j) * s + t])) return { pure: false, cell: fwd[j] };
    }
  }
  return { pure: true };
}
