import type { GeoFeature } from './features';
import type { Causes, Conflict, Derived, SmallState, World } from './world';

// 预览世界：引擎在副本上执行一条命令之后，副本与当前世界的差别。只带内容变了的数组（主线程在当前世界上
// 补上它们，得到将来的世界画在地图上；没变的数组沿用当前世界的同一个对象，地图的着色缓存照样命中）。
// 份额、适宜度（格数 × 生态种数）只带变了的那几格；生态的种数变了时整份放进 derived

type Typed = Float32Array | Int32Array | Uint8Array | Uint16Array | Int16Array;

// 稀疏的行：idx 是变了的格，rows 依次是它们的值（每格“生态种数”个）
export interface SparseRows {
  idx: Int32Array;
  rows: Float32Array;
}

export interface PreviewPatch {
  small: SmallState;
  causes: Partial<Record<keyof Causes, Typed>>;
  // 自定义场：有一个变了（或新增、删除）时整份带上；没变为 null
  fields: Record<string, Float32Array> | null;
  derived: Partial<Record<keyof Derived, Typed>>;
  corrF: Record<string, Float32Array> | null;
  share: SparseRows | null;
  suit: SparseRows | null;
  features: GeoFeature[];
  conflicts: Conflict[];
  // 副本里没有了的可选推导数组（比如去掉颜色脚本后的 look）：拼回来时也去掉，不沿用当前世界的。没有时不带这一项
  gone?: (keyof Derived)[];
}

// 两个数组的内容逐字节相同（−0 与 +0 算不同：拼回来的世界与副本逐位一致）
function same(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength || a.constructor !== b.constructor) return false;
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

function sameRecord(a: Record<string, Float32Array>, b: Record<string, Float32Array>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && same(a[k], b[k]));
}

// 变了的格（每格 width 个值，逐位比较）；一格都没变时为 null
function changedRows(a: Float32Array, b: Float32Array, width: number): SparseRows | null {
  if (!width) return null;
  const x = new Int32Array(a.buffer, a.byteOffset, a.length);
  const y = new Int32Array(b.buffer, b.byteOffset, b.length);
  const idx: number[] = [];
  const cells = a.length / width;
  for (let i = 0; i < cells; i++) {
    for (let k = i * width; k < (i + 1) * width; k++) {
      if (x[k] !== y[k]) {
        idx.push(i);
        break;
      }
    }
  }
  if (!idx.length) return null;
  const rows = new Float32Array(idx.length * width);
  idx.forEach((i, k) => rows.set(b.subarray(i * width, (i + 1) * width), k * width));
  return { idx: Int32Array.from(idx), rows };
}

function withRows(base: Float32Array, r: SparseRows, width: number): Float32Array {
  const out = base.slice();
  for (let k = 0; k < r.idx.length; k++) out.set(r.rows.subarray(k * width, (k + 1) * width), r.idx[k] * width);
  return out;
}

// 副本（copy）与当前世界（live）的差别。数组直接引用副本的（发给主线程时结构化克隆会复制一份）
export function previewPatch(live: World, copy: World): PreviewPatch {
  const causes: PreviewPatch['causes'] = {};
  for (const [k, v] of Object.entries(copy.causes)) {
    if (!ArrayBuffer.isView(v)) continue;
    const old = (live.causes as unknown as Record<string, ArrayBufferView>)[k];
    if (!old || !same(old, v)) (causes as Record<string, Typed>)[k] = v as Typed;
  }
  const S = copy.small.species.length;
  // 生态的种数变了：份额、适宜度、可达整份重新分配过，整份带上
  const resized = copy.derived.share.length !== live.derived.share.length;
  const derived: PreviewPatch['derived'] = {};
  for (const [k, v] of Object.entries(copy.derived)) {
    if (!ArrayBuffer.isView(v)) continue;
    if (!resized && (k === 'share' || k === 'suit')) continue;
    const old = (live.derived as unknown as Record<string, ArrayBufferView>)[k];
    if (!old || !same(old, v)) (derived as Record<string, Typed>)[k] = v as Typed;
  }
  const gone = Object.entries(live.derived)
    .filter(([k, v]) => ArrayBuffer.isView(v) && !ArrayBuffer.isView((copy.derived as unknown as Record<string, unknown>)[k]))
    .map(([k]) => k as keyof Derived);
  return {
    small: copy.small,
    causes,
    fields: sameRecord(live.causes.fields, copy.causes.fields) ? null : copy.causes.fields,
    derived,
    corrF: sameRecord(live.derived.corrF, copy.derived.corrF) ? null : copy.derived.corrF,
    share: resized ? null : changedRows(live.derived.share, copy.derived.share, S),
    suit: resized ? null : changedRows(live.derived.suit, copy.derived.suit, S),
    features: copy.derived.features,
    conflicts: copy.derived.conflicts,
    ...(gone.length ? { gone } : {}),
  };
}

// 在当前世界（base，要与算预览时的世界是同一个状态）上补上差别，得到将来的世界。没变的数组沿用 base 的
export function previewWorldOf(base: World, p: PreviewPatch): World {
  const S = p.small.species.length;
  const derived: Derived = { ...base.derived, ...(p.derived as Partial<Derived>), features: p.features, conflicts: p.conflicts };
  if (p.corrF) derived.corrF = p.corrF;
  if (p.share) derived.share = withRows(base.derived.share, p.share, S);
  if (p.suit) derived.suit = withRows(base.derived.suit, p.suit, S);
  for (const k of p.gone ?? []) delete (derived as unknown as Record<string, unknown>)[k];
  const causes: Causes = { ...base.causes, ...(p.causes as Partial<Causes>) };
  if (p.fields) causes.fields = p.fields;
  return { ...base, causes, small: p.small, derived };
}
