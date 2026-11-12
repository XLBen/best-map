import { hashString } from '../names';
import { clamp as clampRange, mixSeed, mulberry32 } from '../rng';
import { type CellKind, type MatchScope, nameLine, type ScriptKind } from './format';
import { makeIssue, ScriptError, type ScriptIssue } from './issues';
import { describe, parseColor, RUN_STATE as RUN } from './helpers';
import { type CompiledScript, compileScript, enabled, runtimeIssue } from './compile';
import type { ScriptInputs } from './inputs';

// 运行：整段循环地跑、检查返回值、出错时给“当作没有这段脚本”的结果（第一百零一轮从 core/script.ts 原样搬来）

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


// 地形脚本的输入必须带上原来的 height、mountains、hills、rock：脚本只改其中几项时，其余照原样输出，
// 出错时整份原样输出。少了哪一项是调用方的错（不是用户脚本的错），直接抛错，免得把 0 当成岩性写回地形
function crustBase(inputs: ScriptInputs, cells: ArrayLike<number>): CrustOutput {
  const m = cells.length;
  const out = {} as CrustOutput;
  for (const k of CRUST_KEYS) {
    const src = inputs.get(k);
    if (src === undefined || typeof src !== 'object') throw new Error(`地形脚本的输入里没有 ${k}（调用方要给出原来的 height、mountains、hills、rock）`);
    const a = new Float64Array(m);
    for (let j = 0; j < m; j++) a[j] = (src as ArrayLike<number>)[cells[j]];
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

function hasNaN(kind: CellKind, v: unknown): boolean {
  if (typeof v === 'number') return Number.isNaN(v);
  if (kind === 'color' && (Array.isArray(v) || ArrayBuffer.isView(v))) {
    const a = v as ArrayLike<unknown>;
    for (let t = 0; t < 3 && t < a.length; t++) if (Number.isNaN(a[t])) return true;
    return false;
  }
  if (kind === 'crust' && v !== null && typeof v === 'object') return CRUST_KEYS.some((k) => Number.isNaN((v as Record<string, unknown>)[k]));
  return false;
}

// 返回值不对时的说明
function valueText(kind: CellKind, v: unknown): string {
  if (v === undefined) return '地图上有一处没有返回值：少了 return';
  if (hasNaN(kind, v)) return '地图上有一处算出了 NaN（不是数字）';
  const want =
    kind === 'placement'
      ? '0 到 1 之间的数，或 true / false'
      : kind === 'color'
        ? "颜色 [r, g, b] 或 '#rrggbb'"
        : kind === 'match'
          ? '真或假'
          : '新的高度（一个数），或 {height, mountains, hills, rock}';
  return `应该返回${want}，地图上有一处返回了${describe(v)}`;
}

function valueIssue(owner: string, kind: CellKind, v: unknown, cell: number): ScriptIssue {
  return makeIssue(owner, kind, 'value', valueText(kind, v), describe(v), undefined, cell);
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

// 交给脚本的整体值（颜色脚本的 color、布局脚本的参数和函数）：数据给冻结的副本，函数包一层冻结的箭头函数。
// 脚本既改不了调用方手里的东西，也不能在上面记东西留到下一次运行
function frozenCopy(v: unknown, depth = 0): unknown {
  if (typeof v === 'function') {
    const f = v as (...a: unknown[]) => unknown;
    return Object.freeze((...a: unknown[]) => f(...a));
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth > 32) return undefined;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Object.freeze(Array.from(v as ArrayLike<unknown>, (x) => frozenCopy(x, depth + 1)));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = frozenCopy(x, depth + 1);
  return Object.freeze(o);
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
  RUN.biomeShares.clear();
  RUN.stream = null;
  RUN.bad = undefined;
}

// 出错说明带上所属对象的 id（没有 id 时照旧）
const withId = (issue: ScriptIssue, id: string | undefined): ScriptIssue => (id === undefined || issue.id === id ? issue : { ...issue, id });

// 对一串格运行一段每格的脚本。出错不抛（语法错误、运行时出错、NaN、类型不对、缺变量、安全模式），
// 返回 {ok: false, issue, output}，output 为“没有这段脚本”的结果；超出范围的数被截到范围内。
// 只有调用方的错（主线程上 disallowScripts 之后、地形脚本缺原来的地形、看门狗本身出错）才抛
export function runScript<K extends CellKind>(script: { kind: K; src: string; scope?: MatchScope }, opts: RunOptions): CellResult<K> {
  const { kind, src, scope } = script;
  const { inputs, cells, owner } = opts;
  const fail = (issue: ScriptIssue): CellResult<K> => ({ ok: false, issue: withId(issue, opts.id), output: absentOutput(kind, inputs, cells) as CellOutputs[K] });
  if (!enabled) return fail(makeIssue(owner, kind, 'disabled', '安全模式下脚本不运行', 'disabled'));
  let c: CompiledScript;
  try {
    c = compileScript(kind, src, owner, scope);
  } catch (e) {
    if (e instanceof ScriptError) return fail(e.issue);
    throw e;
  }
  // 绑定输入：只取源码里用到的变量
  const args: unknown[] = [];
  for (const p of c.params) {
    if (p.mode === 'cell') continue;
    let v: unknown = inputs.get(p.key);
    if (v === undefined) return fail(makeIssue(owner, kind, 'runtime', `这里没有变量 ${p.name}`, `missing input ${p.key}`, nameLine(src, p.name)));
    if (p.mode === 'array' && typeof v !== 'object') v = new Float64Array(inputs.n).fill(Number(v));
    else if (p.mode === 'scalar') v = frozenCopy(v);
    args.push(v);
  }
  const out = (kind === 'crust' ? crustBase(inputs, cells) : absentOutput(kind, inputs, cells)) as CellOutputs[K];
  const target = kind === 'placement' ? (out as CellOutputs['placement']).factor : kind === 'match' ? (out as CellOutputs['match']).match : null;
  const put = putFor(kind, out);
  const seed = opts.seed ?? Number(inputs.get('seed') ?? 0);
  const h = host;
  let issue: ScriptIssue | null = null;
  begin(kind, opts, inputs, seed);
  try {
    h.enter(owner);
    try {
      const bad = c.loop!(cells, target, h, put, ...args);
      if (bad >= 0) issue = valueIssue(owner, kind, RUN.bad, cells[bad]);
    } catch (e) {
      issue = runtimeIssue(e, owner, kind, src, RUN.cell);
    } finally {
      h.exit();
    }
  } finally {
    // 无论如何都复原运行状态（否则之后每次都是“脚本不能嵌套运行”）
    end();
  }
  return issue ? fail(issue) : { ok: true, output: out };
}

export type SetupResult = { ok: true; value: unknown } | { ok: false; issue: ScriptIssue };

// 布局脚本：每个星球模型运行一次。values 给出世界的参数与 addBlock 等函数（脚本拿到的是冻结的副本，
// 函数包了一层；addBlock 收到的对象是脚本的，调用方要自己复制、检查）；
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
    const v = Object.hasOwn(values, p.key) ? values[p.key] : undefined;
    if (v === undefined) return { ok: false, issue: makeIssue(owner, kind, 'runtime', `这里没有变量 ${p.name}`, `missing input ${p.key}`, nameLine(script.src, p.name)) };
    args.push(frozenCopy(v));
  }
  const h = host;
  begin(kind, opts, null, opts.seed);
  RUN.stream = mulberry32(mixSeed(opts.seed, 105, 0x3d));
  try {
    h.enter(owner);
    try {
      return { ok: true, value: c.script(...args) };
    } catch (e) {
      return { ok: false, issue: runtimeIssue(e, owner, kind, script.src) };
    } finally {
      h.exit();
    }
  } finally {
    end();
  }
}
