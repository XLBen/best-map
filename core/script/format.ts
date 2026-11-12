import { z } from 'zod';

// 脚本的容器与格式、能用的变量和辅助函数的清单、从源码里只留下代码的 codeOnly（第一百零一轮从 core/script.ts 原样搬来）

// ---------- 容器与格式 ----------

export const SCRIPT_KINDS = ['placement', 'color', 'match', 'setup', 'crust'] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

// 每格（或每条河）运行一次的四种
export type CellKind = Exclude<ScriptKind, 'setup'>;

export const SCRIPT_KIND_LABEL: Record<ScriptKind, string> = {
  placement: '长在哪里',
  color: '颜色',
  match: '哪些河湖是这一种',
  setup: '布局',
  crust: '地形',
};

// 脚本接口的版本号：以后改变量、改返回值的含义时加 1，旧脚本按旧的规则运行
export const SCRIPT_API = 1;
export const MAX_SCRIPT_CHARS = 20000;

const scriptSchema = z.object({ api: z.literal(SCRIPT_API), src: z.string().max(MAX_SCRIPT_CHARS) });
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
// 所属对象：容器所在的对象，或者往上第一个带字符串 id 的对象（update_species 的 patch 没有 id，用命令的 id）。
// 信任检查靠它，所以不设深度上限（套很多层 batch 也藏不住脚本）：用自己的栈，不递归，不会爆栈。
// 每次打开世界都要过一遍整个文件（画了很多笔的世界里有几百万个数）：数、字符串不进栈，位置（path）只在找到脚本时才拼
export function findScripts(json: unknown): FoundScript[] {
  const out: FoundScript[] = [];
  // 栈里的一个对象或数组：up 是它所在的对象（拼位置用），key 是它在 up 里的键或下标；idObj 是往上第一个带字符串 id 的对象
  interface Node {
    v: object;
    up: Node | null;
    key: string | number;
    idObj: Record<string, unknown> | undefined;
  }
  const pathOf = (n: Node): string => {
    const chain: Node[] = [];
    for (let x: Node | null = n; x?.up; x = x.up) chain.push(x);
    let p = '';
    for (let i = chain.length - 1; i >= 0; i--) {
      const k = chain[i].key;
      p = typeof k === 'number' ? `${p}[${k}]` : p ? `${p}.${k}` : k;
    }
    return p;
  };
  const isBox = (x: unknown): x is object => x !== null && typeof x === 'object' && !ArrayBuffer.isView(x);
  if (!isBox(json)) return out;
  // 深度优先、按键的顺序
  const stack: Node[] = [{ v: json, up: null, key: '', idObj: undefined }];
  const seen = new Set<object>();
  while (stack.length) {
    const node = stack.pop()!;
    const v = node.v;
    if (seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let k = v.length - 1; k >= 0; k--) {
        const x = v[k];
        if (isBox(x)) stack.push({ v: x, up: node, key: k, idObj: node.idObj });
      }
      continue;
    }
    const o = v as Record<string, unknown>;
    const idObj = typeof o.id === 'string' ? o : node.idObj;
    const box = o.scripts;
    if (box !== null && typeof box === 'object' && !Array.isArray(box)) {
      const id = idObj?.id as string | undefined;
      const name = typeof o.name === 'string' ? o.name : typeof idObj?.name === 'string' ? (idObj.name as string) : undefined;
      for (const kind of SCRIPT_KINDS) {
        const s = (box as Record<string, unknown>)[kind];
        if (s === null || typeof s !== 'object') continue;
        const src = (s as Record<string, unknown>).src;
        if (typeof src !== 'string') continue;
        const path = pathOf(node);
        out.push({ owner: name || id || '脚本', id, kind, src, hash: scriptHash(src), path: `${path ? `${path}.` : ''}scripts.${kind}` });
      }
    }
    const keys = Object.keys(o);
    for (let k = keys.length - 1; k >= 0; k--) {
      const x = o[keys[k]];
      if (keys[k] !== 'scripts' && isBox(x)) stack.push({ v: x, up: node, key: keys[k], idObj });
    }
  }
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
  // match 里只有河流类型（river）或湖泊类型（lake）的才有（编辑器只列那一种的）
  for?: 'river' | 'lake';
}

const CELL: readonly ScriptKind[] = ['placement', 'color', 'match'];
const CELL_CRUST: readonly ScriptKind[] = ['placement', 'color', 'match', 'crust'];
const ALL: readonly ScriptKind[] = SCRIPT_KINDS;

// 不提供省份变量：改省份的命令不触发重算，用了省份的脚本会和撤销、重放的结果不一致
// 星球的半径、轴倾角、日照、水汽、河流门槛不给布局、地形两种脚本：星球形态的模型、地形只按种子、类型、形态缓存，
// 改这几项不重算地形，用了它们的形态脚本会和撤销、重放的结果不一致
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
  // 只给河流类型的 match（每条河算一次）：整条河的长度、源头的海拔
  { key: 'riverLength', zh: '河长', label: '这条河有多长（到汇入更大的河、入海或入湖为止）', unit: 'km', group: '水', kinds: ['match'], for: 'river' },
  { key: 'sourceElevation', zh: '源头海拔', label: '这条河源头的海拔', unit: 'm', group: '水', kinds: ['match'], for: 'river' },
  // 只给湖泊类型的 match（每个湖算一次）
  { key: 'lakeArea', zh: '湖面积', label: '这个湖有多大（连干涸的湖底）', unit: 'km²', group: '水', kinds: ['match'], for: 'lake' },
  { key: 'inflow', zh: '入湖水量', label: '流进这个湖的水', unit: 'm³/s', group: '水', kinds: ['match'], for: 'lake' },
  { key: 'dryLake', zh: '干湖', label: '是不是干湖（1 是：只剩干涸的湖底，0 不是）', group: '水', kinds: ['match'], for: 'lake' },
  { key: 'placedLake', zh: '放的湖', label: '是不是放的湖（1 是，0 是自然的湖）', group: '水', kinds: ['match'], for: 'lake' },
  { key: 'perennial', zh: '常年有水', label: '是不是不受蒸发影响、常年蓄满的湖（放的湖默认是）', group: '水', kinds: ['match'], for: 'lake' },
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
  { key: 'radiusKm', zh: '半径', label: '星球半径', unit: 'km', group: '世界', kinds: CELL, scalar: true },
  { key: 'tilt', zh: '轴倾角', label: '自转轴倾角', unit: '°', group: '世界', kinds: CELL, scalar: true },
  { key: 'solar', zh: '日照', label: '太阳强弱（地球为 1）', group: '世界', kinds: CELL, scalar: true },
  { key: 'humidity', zh: '水汽', label: '全局水汽（地球为 1）', group: '世界', kinds: CELL, scalar: true },
  { key: 'riverThreshold', zh: '河流门槛', label: '算作河的最小流量', unit: 'm³/s', group: '世界', kinds: CELL, scalar: true },
  { key: 'share', zh: '份额', label: '这一格里这种生态占的比例（0–1）', group: '颜色', kinds: ['color'] },
  { key: 'color', zh: '颜色', label: '生态本来的颜色 [r, g, b]（只读）', group: '颜色', kinds: ['color'], scalar: true },
  { key: 'height', zh: '高度', label: '这里原来的高度（海平面以上为正）', unit: 'm', group: '地形生成', kinds: ['crust'] },
  { key: 'mountains', zh: '山', label: '山的强弱（0–2）', group: '地形生成', kinds: ['crust'] },
  { key: 'hills', zh: '丘陵', label: '丘陵的强弱（0–0.5）', group: '地形生成', kinds: ['crust'] },
  { key: 'continent', zh: '大陆', label: '大陆场（大于 0 是大陆，小于 0 是大洋）', group: '地形生成', kinds: ['crust'] },
  { key: 'addBlock', zh: '加大陆块', label: '加一块大陆：addBlock({lat, lon, size, stretch, angle})', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'addIsland', zh: '加岛', label: '加一个岛：addIsland({lat, lon, height, size})', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'clearBlocks', zh: '清空大陆块', label: '删除原来的大陆块', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'clearIslands', zh: '清空岛', label: '删除原来的岛', group: '布局', kinds: ['setup'], scalar: true },
  { key: 'blocks', zh: '大陆块', label: '原来的大陆块（只读列表，每项 {lat, lon, size}）', group: '布局', kinds: ['setup'], scalar: true },
];

// 辅助函数（编辑器的说明用；实现见下面的 HELPERS）
// for：只在这一种 match 里有（编辑器只在那里列出）；'water' 是河、湖两种都有
export const SCRIPT_HELPERS: readonly { name: string; usage: string; label: string; for?: 'river' | 'lake' | 'water' }[] = [
  { name: 'noise', usage: 'noise(x, y, k = 0)', label: '二维噪声，约 −1 到 1；k 换一组' },
  { name: 'fbm', usage: 'fbm(x, y, oct = 4, gain = 0.5, k = 0)', label: '几层叠起来的二维噪声' },
  { name: 'noise3', usage: 'noise3(x, y, z, k = 0)', label: '三维噪声' },
  { name: 'fbm3', usage: 'fbm3(x, y, z, oct = 4, gain = 0.5, k = 0)', label: '几层叠起来的三维噪声' },
  { name: 'fbmAt', usage: 'fbmAt(freq, oct = 3, k = 0)', label: '这一格处的噪声（星球上没有接缝）；freq 是每个地图单位里的起伏次数' },
  { name: 'rand', usage: 'rand(k = 0)', label: '0–1 的随机数：每格固定，与计算顺序无关；换 k 得到另一组' },
  { name: 'field', usage: "field('名字')", label: '自定义场（或内置变量）在这一格的值' },
  { name: 'river', usage: "river('类型 id')", label: '离这种河多近（0–1，河上为 1）' },
  { name: 'hasRiver', usage: "hasRiver('类型 id')", label: '地图上有没有这种河（任何地方有一格就是 true）' },
  { name: 'nearLake', usage: "nearLake('类型 id')", label: '离这种湖多近（0–1，湖上为 1）' },
  { name: 'hasLake', usage: "hasLake('类型 id')", label: '地图上有没有这种湖' },
  { name: 'biome', usage: "biome('生态 id')", label: '这条河流经的格（这个湖的湖岸）里这种生态占多少（0–1）', for: 'water' },
  { name: 'dominantBiome', usage: 'dominantBiome()', label: "这条河流经（这个湖岸边）最多的生态的 id，比如 'wetland'", for: 'water' },
  { name: 'biomeAtSource', usage: 'biomeAtSource()', label: '源头那里的生态的 id', for: 'river' },
  { name: 'biomeAtMouth', usage: 'biomeAtMouth()', label: '河口（汇入、入海、入湖的地方）的生态的 id', for: 'river' },
  { name: 'smoothstep', usage: 'smoothstep(a, b, v)', label: 'v 从 a 到 b 平滑地从 0 变到 1' },
  { name: 'clamp', usage: 'clamp(v, lo = 0, hi = 1)', label: '把 v 限制在 lo 到 hi 之间' },
  { name: 'mix', usage: 'mix(a, b, t)', label: '按 t（0–1）在 a、b 之间取值' },
  { name: 'step', usage: 'step(edge, v)', label: 'v 小于 edge 为 0，否则为 1' },
  { name: 'mixColor', usage: 'mixColor(c1, c2, t)', label: '按 t 混合两种颜色（[r, g, b] 或 #rrggbb）' },
  { name: 'rgb', usage: 'rgb(r, g, b) 或 rgb("#rrggbb")', label: '颜色' },
  { name: 'Math', usage: 'Math.sin(x)…', label: '数学函数（没有 Math.random，用 rand()）' },
];

export const VAR_BY_NAME = new Map<string, ScriptVariable>();
for (const v of VARIABLES) {
  VAR_BY_NAME.set(v.key, v);
  if (v.zh) VAR_BY_NAME.set(v.zh, v);
}

// 某种脚本能用的变量
// match 是河流类型的还是湖泊类型的（只给一种的变量另一种里没有，名字可以随便用）。省略为河
export type MatchScope = 'river' | 'lake';
export const inScope = (v: ScriptVariable, kind: ScriptKind, scope: MatchScope = 'river') => !v.for || kind !== 'match' || v.for === scope;

export function scriptVariablesFor(kind: ScriptKind, scope?: MatchScope): ScriptVariable[] {
  return VARIABLES.filter((v) => v.kinds.includes(kind) && inScope(v, kind, scope));
}

// 源码里出现了这个名字（前后不是字母、数字、_、$；中文名同样适用）。只在 codeOnly 之后的代码里找
export const NAME_RE = new Map<string, RegExp>();
for (const name of VAR_BY_NAME.keys()) {
  const esc = name.replace(/[$]/g, '\\$');
  NAME_RE.set(name, new RegExp(`(?<![\\p{L}\\p{N}_$])${esc}(?![\\p{L}\\p{N}_$])`, 'u'));
}

// 这些词后面的 / 是正则的开头，不是除号
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const IDENT_CHAR = /[\p{L}\p{N}_$]/u;
const LINE_END = /[\n\r\u2028\u2029]/;

// 把注释、字符串、模板里的文字、正则的内容换成空格（换行保留、长度不变），只留下代码本身。
// 找变量名、数括号、找中文标点都用它：注释里写一句“离河近的地方”，不会去算离河的距离，
// 也不会因为这次没有提供“离河”而报错。模板里的 ${…} 是代码，照常保留
export function codeOnly(src: string): string {
  const n = src.length;
  const out = src.split('');
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (!LINE_END.test(out[k])) out[k] = ' ';
  };
  // 每层模板表达式 ${…} 里还没配对的 {
  const depth: number[] = [];
  // 模板的文字部分：从 from 扫到 ` 或 ${，返回之后接着扫的位置
  const templateText = (from: number): number => {
    let k = from;
    while (k < n && src[k] !== '`' && !(src[k] === '$' && src[k + 1] === '{')) k += src[k] === '\\' ? 2 : 1;
    blank(from, k);
    if (k < n && src[k] === '$') {
      depth.push(0);
      return k + 2;
    }
    return k + 1;
  };
  // 前面是值（名字、数、右括号、字符串）时 / 是除号，否则是正则
  const regexAllowed = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k < 0) return true;
    const c = out[k];
    if (c === ')' || c === ']' || c === '"' || c === "'" || c === '`') return false;
    if (!IDENT_CHAR.test(c)) return true;
    let s = k;
    while (s > 0 && IDENT_CHAR.test(out[s - 1])) s--;
    return REGEX_AFTER_WORD.has(src.slice(s, k + 1));
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let e = i;
      while (e < n && !LINE_END.test(src[e])) e++;
      blank(i, e);
      i = e;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && !LINE_END.test(src[k])) k += src[k] === '\\' ? 2 : 1;
      blank(i + 1, k);
      i = k + 1;
    } else if (c === '`') {
      i = templateText(i + 1);
    } else if (c === '}' && depth.length && depth[depth.length - 1] === 0) {
      depth.pop();
      i = templateText(i + 1);
    } else if (c === '/' && regexAllowed(i)) {
      let k = i + 1;
      let cls = false;
      for (; k < n && !LINE_END.test(src[k]) && (cls || src[k] !== '/'); k++) {
        if (src[k] === '\\') k++;
        else if (src[k] === '[') cls = true;
        else if (src[k] === ']') cls = false;
      }
      if (k < n && src[k] === '/') {
        // 正则的内容和标志（/…/gy 的 y 不是变量 y）
        let e = k + 1;
        while (e < n && /[a-z]/i.test(src[e])) e++;
        blank(i + 1, k);
        blank(k + 1, e);
        i = e;
      } else i++; // 到行尾也没有结束：不是正则，当作除号
    } else {
      if (depth.length && c === '{') depth[depth.length - 1]++;
      else if (depth.length && c === '}') depth[depth.length - 1]--;
      i++;
    }
  }
  return out.join('');
}

// 源码的行数（与 JS 的行号一致：\r\n、\r、\u2028、\u2029 都算换行）
export const lineCount = (src: string) => src.split(/\r\n|[\n\r\u2028\u2029]/).length;

// 变量名在代码里第一次出现在第几行（这次没有提供这个变量时报行号用）
export function nameLine(src: string, name: string): number | undefined {
  const m = NAME_RE.get(name)?.exec(codeOnly(src));
  return m ? lineCount(src.slice(0, m.index)) : undefined;
}
