// 引擎的小工具（第八十三轮从 core/engine.ts 原样搬出）：预览的差异、历史留几步、复制世界
import type { GeoFeature } from './features';
import type { World, Causes, Derived } from './world';
import type { PreviewExtras, PreviewResult, DerivedState } from './engine-types';
import { activeConflicts } from './constraints';
import type { Command } from './commands';
import { isVegetated } from './vegetation';
import { cloneSmall } from './small-copy';

// 两份地物一一对应（同样的键、同样的先后），名字变了的地物风格也都变了
export function onlyRestyled(prev: readonly GeoFeature[], cur: readonly GeoFeature[]): boolean {
  if (prev.length !== cur.length) return false;
  for (let k = 0; k < cur.length; k++) {
    const a = prev[k];
    const b = cur[k];
    if (a.key !== b.key) return false;
    if (a.name !== b.name && a.style === b.style) return false;
  }
  return true;
}

// 一口气走完分阶段的计算（第九十七轮挪到 progress.ts，这里照旧导出）
export { drain } from './progress';

// 陆海的变化与执行后没涂成的格
export function landAndFailing(a: World, b: World): Pick<PreviewExtras, 'failing' | 'landGained' | 'landLost'> {
  const landGained: number[] = [];
  const landLost: number[] = [];
  const la = a.causes.land;
  const lb = b.causes.land;
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) (lb[i] ? landGained : landLost).push(i);
  return { failing: activeConflicts(b).flatMap((c) => c.failing), landGained, landLost };
}

// 省份预览能做的命令：只改省份数组与小数据里的省份、切线
const PROVINCE_OPS = new Set<Command['op']>(['assign_province', 'merge_province', 'split_province', 'regenerate_provinces', 'generate_provinces', 'set_province', 'cut_province']);
export function provinceOnly(cmd: Command): boolean {
  return cmd.op === 'batch' ? cmd.commands.every(provinceOnly) : PROVINCE_OPS.has(cmd.op);
}

export function diffWorlds(a: World, b: World, cmd: Command): Omit<PreviewResult, keyof PreviewExtras> {
  const n = a.mesh.n;
  const thr = a.small.planet.riverThreshold;
  const changedCells: number[] = [];
  const riverAdded: number[] = [];
  const riverRemoved: number[] = [];
  const lakeAdded: number[] = [];
  const lakeRemoved: number[] = [];
  const carved: PreviewResult['carved'] = { cells: [], maxDrop: 0 };
  let maxCorrT = 0;
  let maxCorrP = 0;
  for (let i = 0; i < n; i++) {
    const da = a.derived.dominant[i];
    const db = b.derived.dominant[i];
    const ida = da >= 0 ? a.small.species[da]?.id : da;
    const idb = db >= 0 ? b.small.species[db]?.id : db;
    if (ida !== idb) changedCells.push(i);
    // 与屏幕上画出来的河一致：陆地、不是湖、流量不低于门槛
    const ra = a.causes.land[i] === 1 && a.derived.lake[i] !== 1 && a.derived.discharge[i] >= thr;
    const rb = b.causes.land[i] === 1 && b.derived.lake[i] !== 1 && b.derived.discharge[i] >= thr;
    if (rb && !ra) riverAdded.push(i);
    if (ra && !rb) riverRemoved.push(i);
    const la = a.derived.lake[i] === 1;
    const lb = b.derived.lake[i] === 1;
    if (lb && !la) lakeAdded.push(i);
    if (la && !lb) lakeRemoved.push(i);
    const drop = a.derived.elevation[i] - b.derived.elevation[i];
    if (drop >= 1) {
      carved.cells.push(i);
      carved.maxDrop = Math.max(carved.maxDrop, drop);
    }
    maxCorrT = Math.max(maxCorrT, Math.abs(b.derived.corrT[i]));
    maxCorrP = Math.max(maxCorrP, Math.abs(b.derived.corrP[i]));
  }
  const S = b.small.species.length;
  const satisfied = b.small.constraints.map((c) => {
    const t = b.small.species.findIndex((s) => s.id === c.species);
    const valid = c.cells.filter((i) => isVegetated(b, b.derived, i));
    const ok = valid.filter((i) => b.derived.dominant[i] === t).length;
    void S;
    return { id: c.id, satisfied: valid.length ? ok / valid.length : 0, required: c.ratio };
  });
  const out: Omit<PreviewResult, keyof PreviewExtras> = { changedCells, riverAdded, riverRemoved, maxCorrT, maxCorrP, conflicts: activeConflicts(b).length, satisfied, lakeAdded, lakeRemoved, carved };
  const id = cmd.op === 'update_guide' ? cmd.id : cmd.op === 'add_guide' ? (cmd.guide.id ?? b.small.guides[b.small.guides.length - 1]?.id) : undefined;
  const g = id !== undefined ? b.small.guides.find((x) => x.id === id) : undefined;
  if (g) {
    const land = b.causes.land;
    let followed = true;
    for (let k = 0; k + 1 < g.cells.length && land[g.cells[k]]; k++) if (b.derived.receiver[g.cells[k]] !== g.cells[k + 1]) followed = false;
    out.guide = {
      id: g.id,
      flow: g.cells.map((c) => b.derived.discharge[c]),
      name: b.derived.features.find((f) => f.guide === g.id)?.name ?? '',
      followed,
    };
  }
  return out;
}

// 复制时用展开（与原对象同形），逐个赋值会让对象退化成字典模式，之后每次读写都变慢
function cloneCauses(c: Causes, fields: Record<string, Float32Array>): Causes {
  const out = { ...c };
  for (const [k, v] of Object.entries(out)) if (ArrayBuffer.isView(v)) (out as unknown as Record<string, unknown>)[k] = (v as Float32Array).slice();
  out.fields = fields;
  return out;
}

// 撤销缓存最多几份：每份最多是整个世界的推导（10 万格约 27 MB），相同的数组共用，合计不超过 UNDO_BYTES。
// 6 万格以上（新建的类地星球 6.26 万、大星球 13.92 万格，见 planetCells）存 6 份。
// 第十七轮：大星球每份约 37 MB，200 MB 只放得下 5 份，上限提到 240 MB（类地星球 6 份约 100 MB，地区 8 份约 90 MB，不受影响）
export function undoDepth(n: number): number {
  return n > 60000 ? 6 : 8;
}
export const UNDO_BYTES = 240 * 1024 * 1024;

// 撤销缓存里各份推导合计占多少字节（共用的数组只算一次）
export function keptBytes(kept: readonly { state?: DerivedState }[]): number {
  const seen = new Set<ArrayBufferLike>();
  let bytes = 0;
  const add = (v: unknown) => {
    if (!ArrayBuffer.isView(v) || seen.has(v.buffer)) return;
    seen.add(v.buffer);
    bytes += v.byteLength;
  };
  for (const k of kept) {
    const d = k.state?.derived;
    if (!d) continue;
    for (const v of Object.values(d)) add(v);
    for (const v of Object.values(d.corrF)) add(v);
  }
  return bytes;
}

// 两个数组逐字节相同（同一种类型、同样长）
export function sameContent(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
  const n = a.byteLength;
  if (n % 4 === 0 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const x = new Int32Array(a.buffer, a.byteOffset, n / 4);
    const y = new Int32Array(b.buffer, b.byteOffset, n / 4);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  const x = new Uint8Array(a.buffer, a.byteOffset, n);
  const y = new Uint8Array(b.buffer, b.byteOffset, n);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

// 推导里的数组都换成副本（对象本身不换；自定义场的修正就地换）
export function privatize(d: Derived) {
  const r = d as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(r)) if (ArrayBuffer.isView(v)) r[k] = (v as Float32Array).slice();
  for (const [k, v] of Object.entries(d.corrF)) d.corrF[k] = v.slice();
}

// 推导的副本：数组都复制；地物、冲突列表照旧共用（之后的完整重算总是换上新的）
function copyDerived(d: Derived): Derived {
  const out = { ...d };
  for (const [k, v] of Object.entries(out)) if (ArrayBuffer.isView(v)) (out as unknown as Record<string, unknown>)[k] = (v as Float32Array).slice();
  const corrF: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(d.corrF)) corrF[k] = v.slice();
  out.corrF = corrF;
  return out;
}

export function cloneWorld(w: World): World {
  const c = w.causes;
  const fields: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(c.fields)) fields[k] = v.slice();
  const derived = copyDerived(w.derived);
  derived.conflicts = structuredClone(w.derived.conflicts);
  return {
    settings: w.settings,
    mesh: w.mesh,
    kmPerUnit: w.kmPerUnit,
    causes: cloneCauses(c, fields),
    small: cloneSmall(w.small),
    derived,
  };
}
