import type { DisplayCoast } from './display';
import type { Mesh } from './mesh';

// ---------- 描河时按画面海岸场的几样查询，跨几次描河记下来（第三十三轮提速） ----------
// Worker 每改一笔都把整个世界的河重描一遍（core/river-pack.ts 的 worldRivers）。描河里最费时的是按画面上的海岸场
// （core/display.ts 的 DisplayCoast）找岸线：河口走到岸线（shoreCrossing）、岸线的法向（seawardNormal）、
// 三角洲分汊的候选河口（圆与岸线的交点）、一段线在不在陆地上。这些查询的结果只取决于：
//   · 查询的参数（点的坐标、找三角形的起点 hint 等，都放进键里）；
//   · 网格与海岸破碎度（换了就全部作废）；
//   · 查询时读到的那几格的海岸场（coast、elevation、frag 三样，第三十四轮起再加海岸类型的两个数 style，
//     第三十六轮起再加这一格的峡湾表的摘要 fjord.sig：淹到哪里随远处的陆海变，表变了摘要就变）。
// 查询时读到哪几格由 core/display.ts 的 coastReads 记下来（displayCoastAt 每次找到的三角形、shoreCrossing 沿边走时的两格，
// rivers.ts 的 coastSmooth 也记）。下一次描河再问同一个键时，这几格的三样都没变就直接用上一次的结果——与重新算逐位相同
// （同样的参数、同样读到的值，算出来就一样）。只改气候时海岸场几乎不变，改地形时只有改动附近的几格变了。
// 结果放进去、取出来都复制一份（调用的一方可能就地改点的数组）。几次描河都没用到的条目丢掉
//
// 用法（不新建闭包）：keyStart → keyAdd… → memoGet；没有时 memoMiss，照常算（算的时候记下读到的格），memoPut 存下

export const coastReads: { on: boolean; cells: number[] } = { on: false, cells: [] };

interface Entry {
  // 键的各个数按位（每个数两个 32 位整数）
  key: Int32Array;
  value: unknown;
  cells: Int32Array;
  vals: Float64Array;
  gen: number;
}

export const MISS: unique symbol = Symbol('miss');

const state = {
  mesh: null as Mesh | null,
  rough: NaN,
  gen: 0,
  active: 0,
  map: new Map<number, Entry[]>(),
  size: 0,
  hits: 0,
  misses: 0,
};

// 每次描河开始时调用：网格、破碎度换了就清空；描河结束时 memoEnd（嵌套时只有最外层的算一代）
export function memoBegin(mesh: Mesh, rough: number): void {
  if (state.active++ > 0) return;
  if (state.mesh !== mesh || state.rough !== rough) {
    state.map.clear();
    state.size = 0;
    state.mesh = mesh;
    state.rough = rough;
  }
  state.gen++;
}

// 最近 KEEP 次描河都没用到的条目丢掉（预览世界与当前世界交替描时两边的都留着）
const KEEP = 4;
export function memoEnd(): void {
  if (--state.active > 0) return;
  coastReads.on = false;
  coastReads.cells.length = 0;
  pending.length = 0;
  if (state.gen % KEEP !== 0) return;
  for (const [h, list] of state.map) {
    let w = 0;
    for (let r = 0; r < list.length; r++) if (state.gen - list[r].gen < KEEP) list[w++] = list[r];
    state.size -= list.length - w;
    if (w === 0) state.map.delete(h);
    else list.length = w;
  }
}

export const memoActive = () => state.active > 0 && enabled;

// 关掉（测试里与不记的写法逐位比、测速时看没记下时要多久）：关着时照常算，记下的留着（再开时照样按读到的格验过才用）
let enabled = true;
export function setCoastMemo(on: boolean): void {
  enabled = on;
}
// 丢掉记下的全部
export function clearCoastMemo(): void {
  state.map.clear();
  state.size = 0;
}
export const memoStats = () => ({ size: state.size, hits: state.hits, misses: state.misses, gen: state.gen });

// 键：一串数（坐标、hint、种类）。放在反复用的数组里
let K = new Float64Array(64);
let KI = new Int32Array(K.buffer);
let kn = 0;
export function keyStart(kind: number): void {
  kn = 0;
  keyAdd(kind);
}
export function keyAdd(v: number): void {
  if (kn === K.length) {
    const k2 = new Float64Array(K.length * 2);
    k2.set(K);
    K = k2;
    KI = new Int32Array(K.buffer);
  }
  K[kn++] = v;
}
export function keyAddPts(P: readonly (readonly [number, number])[], from: number, to: number): void {
  for (let j = from; j < to; j++) {
    keyAdd(P[j][0]);
    keyAdd(P[j][1]);
  }
}

function keyHash(): number {
  let h = 0x811c9dc5 ^ kn;
  for (let i = 0; i < 2 * kn; i++) h = Math.imul(h ^ KI[i], 0x01000193);
  return h;
}

// 按位比（−0 与 0、NaN 都按位）
function keyEquals(a: Int32Array): boolean {
  if (a.length !== 2 * kn) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== KI[i]) return false;
  return true;
}

// 两个数逐位相同（0 与 −0 不同）
const same = (a: number, b: number) => a === b && (a !== 0 || 1 / a === 1 / b);

// 每格记 VALS 个数：coast、elevation、frag，与海岸类型的两个数（第三十四轮，DisplayCoast 的 style；没有时 0）、峡湾表的摘要（第三十六轮）
const VALS = 6;
function valid(e: Entry, f: DisplayCoast): boolean {
  const { cells, vals } = e;
  const frag = f.frag;
  const st = f.style;
  const sig = f.fjord ? f.fjord.sig : null;
  for (let j = 0; j < cells.length; j++) {
    const c = cells[j];
    const o = VALS * j;
    if (!same(vals[o], f.coast[c]) || !same(vals[o + 1], f.elevation[c]) || !same(vals[o + 2], frag ? frag[c] : 0)) return false;
    if (!same(vals[o + 3], st ? st[2 * c] : 0) || !same(vals[o + 4], st ? st[2 * c + 1] : 0) || vals[o + 5] !== (sig ? sig[c] : 0)) return false;
  }
  return true;
}

// 没有记下的、记下的那几格变了的：MISS（调用的一方照常算，再 memoPut）
const pending: { key: Int32Array; hash: number; start: number; on: boolean }[] = [];
export function memoGet(f: DisplayCoast): unknown {
  const v = memoPeek(f);
  if (v === MISS) memoMissStart();
  return v;
}

// 只查：有、读到的格都没变时返回记下的（外面一层在记时把这几格算它读的），不然 MISS（不开始记）。
// 结果还要按别的东西再验一遍的（三角洲分汊）先 memoPeek，不能用时再 memoMissStart、照常算、memoPut
export function memoPeek(f: DisplayCoast): unknown {
  const h = keyHash();
  const list = state.map.get(h);
  if (list) {
    for (const e of list) {
      if (!keyEquals(e.key) || !valid(e, f)) continue;
      e.gen = state.gen;
      state.hits++;
      // 外面一层也在记：这一次读到的格算它读的
      if (coastReads.on) for (let j = 0; j < e.cells.length; j++) coastReads.cells.push(e.cells[j]);
      return e.value;
    }
  }
  return MISS;
}

// 按现在的键开始记（之后照常算、memoPut）
export function memoMissStart(): void {
  state.misses++;
  pending.push({ key: KI.slice(0, 2 * kn), hash: keyHash(), start: coastReads.cells.length, on: coastReads.on });
  coastReads.on = true;
}

// 去重用的标记（按格）
let mark = new Int32Array(0);
let stamp = 0;

// 算好了：存下结果与这一次读到的格（与它们现在的值）。必须与 memoGet 的 MISS 一一对应（后进先出）
export function memoPut(f: DisplayCoast, value: unknown): void {
  const p = pending.pop()!;
  const all = coastReads.cells;
  const n = f.coast.length;
  if (mark.length < n) mark = new Int32Array(n);
  if (++stamp === 0x7fffffff) {
    mark.fill(0);
    stamp = 1;
  }
  const uniq: number[] = [];
  for (let j = p.start; j < all.length; j++) {
    const c = all[j];
    if (mark[c] === stamp) continue;
    mark[c] = stamp;
    uniq.push(c);
  }
  const cells = Int32Array.from(uniq);
  const vals = new Float64Array(VALS * cells.length);
  const frag = f.frag;
  const st = f.style;
  const sig = f.fjord ? f.fjord.sig : null;
  for (let j = 0; j < cells.length; j++) {
    const c = cells[j];
    const o = VALS * j;
    vals[o + 5] = sig ? sig[c] : 0;
    vals[o] = f.coast[c];
    vals[o + 1] = f.elevation[c];
    vals[o + 2] = frag ? frag[c] : 0;
    vals[o + 3] = st ? st[2 * c] : 0;
    vals[o + 4] = st ? st[2 * c + 1] : 0;
  }
  // 外面一层没在记：读到的格不用再留着
  if (!p.on) {
    coastReads.on = false;
    all.length = 0;
  }
  const e: Entry = { key: p.key, value, cells, vals, gen: state.gen };
  const list = state.map.get(p.hash);
  if (!list) {
    state.map.set(p.hash, [e]);
    state.size++;
    return;
  }
  // 同一个键（读到的格变了）：换掉旧的
  for (let k = 0; k < list.length; k++) {
    if (sameKey(list[k].key, p.key)) {
      list[k] = e;
      return;
    }
  }
  list.push(e);
  state.size++;
}

function sameKey(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
