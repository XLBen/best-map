import { riverBuffers, riversId, worldRivers } from '../core/river-pack';
import type { Engine } from '../core/engine';
import type { GeoFeature } from '../core/features';
import { ContentSender } from './content-post';
import type { LightSnapshot, Snapshot } from './protocol';

// 计算 Worker 发给主线程的快照（第八十轮从 worker.ts 搬来，测速 tools/bench-country-ui 也用它）。
// 推导数组（第九轮起）与原因数组（第八十轮起）都只发与上一次发的不同的：相同的写 null、列进 same，主线程沿用手上的同一个数组对象
// （按数组对象认的缓存——着色、国名的几何、统计、图例……——照样命中）。
// 推导数组发出去以后引擎不再就地改（Engine.freezeDerived），按引用记着比；原因数组引擎会就地改（撤销、笔画），所以记的是发出去时的副本

// 两个数组内容相同（同一个对象，或者逐字节相同）
export function sameArray(a: ArrayBufferView | undefined, b: ArrayBufferView): boolean {
  if (a === b) return true;
  if (!a || a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
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

// a 与 b（同样类型、同样长）里变了的格：每格 width 个值逐位比较。变了的超过一成时为 null（整份发更省事）
function changedCells(a: ArrayBufferView, b: ArrayBufferView, n: number): { idx: Int32Array; rows: ArrayBufferView } | null {
  if (a.constructor !== b.constructor || a.byteLength !== b.byteLength || n <= 0) return null;
  const T = b as unknown as Float32Array;
  const len = T.length;
  if (len % n !== 0) return null;
  const width = len / n;
  // 按位比较：4 字节的按 Int32，8 字节的按两个 Int32，其他按字节
  const bpe = T.BYTES_PER_ELEMENT;
  const unit = bpe >= 4 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 ? 4 : 1;
  const per = (width * bpe) / unit;
  const x = unit === 4 ? new Int32Array(a.buffer, a.byteOffset, a.byteLength / 4) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = unit === 4 ? new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const limit = Math.floor(n / 10);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = i * per, end = k + per; k < end; k++) {
      if (x[k] !== y[k]) {
        idx.push(i);
        break;
      }
    }
    if (idx.length > limit) return null;
  }
  const Ctor = T.constructor as Float32ArrayConstructor;
  const rows = new Ctor(idx.length * width);
  for (let q = 0; q < idx.length; q++) rows.set(T.subarray(idx[q] * width, (idx[q] + 1) * width), q * width);
  return { idx: Int32Array.from(idx), rows };
}

// 两个值逐值相同（同一个对象；数组、类型数组、普通对象逐项比）
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && sameArray(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = Object.keys(x);
  if (kx.length !== Object.keys(y).length) return false;
  for (const k of kx) if (!(k in y) || !sameValue(x[k], y[k])) return false;
  return true;
}

const sliceOf = <T extends ArrayBufferView>(a: T): T => (a as unknown as { slice: () => T }).slice();

// 上一次发的：状态编号、推导数组（引用）、原因数组（发出去时的副本，键是原因的名字，自定义场是 'field:名字'）
interface Sent {
  state: number;
  derived: Map<string, ArrayBufferView>;
  corrF: Map<string, ArrayBufferView>;
  causes: Map<string, ArrayBufferView>;
}

export class SnapshotSender {
  private last: Sent | null = null;
  // 上一次发的地物（第八十轮）：每个地物的浅副本（引擎换名字时先复制再改，这里另留一份免得被改到）
  private features: GeoFeature[] | null = null;
  // 上一次发的河的编号（river-pack 的那一份）
  private rivers = 0;
  // 小数据里的内容没换时不发（见 content-post.ts）
  private readonly content: ContentSender;
  // worker：这个 Worker 的编号（开始时间）：换了 Worker 也不会碰巧对上
  constructor(worker: number) {
    this.content = new ContentSender(worker);
  }

  // 换了引擎（新建、打开）：下一份快照是完整的
  reset() {
    this.last = null;
    this.features = null;
    this.rivers = 0;
  }

  // 地物与上一次发的逐值相同（只改了国名、颜色、人口时，名字都没变）：主线程沿用手上的同一个数组。changed 时记下这一份
  private sameFeatures(f: GeoFeature[]): boolean {
    const old = this.features;
    if (old && old.length === f.length && f.every((x, i) => sameValue(old[i], x))) return true;
    this.features = f.map((x) => ({ ...x }));
    return false;
  }

  // 快照：原因、推导都只复制、转交与上一次发的不同的数组（full 时全部），相同的写 null、列进 same
  full(e: Engine, full = false): { snap: Snapshot; transfer: Transferable[] } {
    const w = e.world;
    const transfer: Transferable[] = [];
    const copy = <T extends ArrayBufferView>(a: T): T => {
      const c = sliceOf(a);
      transfer.push(c.buffer as ArrayBuffer);
      return c;
    };
    const prev = full ? null : this.last;
    const sent: Sent = { state: e.stateId, derived: new Map(), corrF: new Map(), causes: new Map() };
    const same: NonNullable<Snapshot['same']> = { base: prev?.state ?? 0, derived: [], corrF: [], rows: {}, causes: [], fields: [], objects: [] };
    // 原因：与上一次发的副本逐字节相同的不发（主线程沿用）；变了的发一份、另留一份副本下次比
    const cause = <T extends ArrayBufferView>(key: string, v: T, list: string[], name: string): T | null => {
      const old = this.last?.causes.get(key);
      if (old && sameArray(old, v)) {
        sent.causes.set(key, old);
        if (prev) {
          list.push(name);
          return null;
        }
        return copy(v);
      }
      sent.causes.set(key, sliceOf(v));
      return copy(v);
    };
    const causes = {} as Snapshot['causes'];
    for (const [k, v] of Object.entries(w.causes)) {
      if (k === 'fields') continue;
      (causes as unknown as Record<string, unknown>)[k] = ArrayBuffer.isView(v) ? cause(k, v, same.causes!, k) : v;
    }
    causes.fields = {};
    for (const [k, v] of Object.entries(w.causes.fields)) (causes.fields as Record<string, unknown>)[k] = cause(`field:${k}`, v, same.fields!, k);
    const derived = {} as Snapshot['derived'];
    // 地物（第八十轮）：与上一次发的相同时不发
    const sameF = this.sameFeatures(w.derived.features);
    for (const [k, v] of Object.entries(w.derived)) {
      if (k === 'features' && prev && sameF) {
        (derived as unknown as Record<string, unknown>)[k] = null;
        same.objects!.push(k);
        continue;
      }
      if (!ArrayBuffer.isView(v)) {
        (derived as unknown as Record<string, unknown>)[k] = v;
        continue;
      }
      sent.derived.set(k, v);
      const old = prev?.derived.get(k);
      if (prev && sameArray(old, v)) {
        (derived as unknown as Record<string, unknown>)[k] = null;
        same.derived.push(k);
        continue;
      }
      // 只变了一小部分格：只发那些格
      const part = old ? changedCells(old, v, w.mesh.n) : null;
      if (part) {
        (derived as unknown as Record<string, unknown>)[k] = null;
        same.rows[k] = part;
        transfer.push(part.idx.buffer as ArrayBuffer, part.rows.buffer as ArrayBuffer);
      } else (derived as unknown as Record<string, unknown>)[k] = copy(v);
    }
    derived.corrF = {};
    for (const [k, v] of Object.entries(w.derived.corrF)) {
      sent.corrF.set(k, v);
      if (prev && sameArray(prev.corrF.get(k), v)) {
        (derived.corrF as Record<string, unknown>)[k] = null;
        same.corrF.push(k);
      } else derived.corrF[k] = copy(v);
    }
    // 地图上的河：在这里描好、打包转交（主线程不再描，见 core/river-pack.ts）。
    // 第八十轮：和上一次发的是同一份时不发（主线程按描河读的数组认，数组没变时用手上描好的）
    const rid = riversId(w);
    const rivers = prev && rid === this.rivers ? undefined : worldRivers(w);
    this.rivers = rid;
    if (rivers) transfer.push(...riverBuffers(rivers));
    // 发出去的数组之后不能就地改（下一次按它们比较）
    e.freezeDerived();
    this.last = sent;
    return {
      snap: {
        rivers,
        riversId: rid,
        settings: w.settings,
        causes,
        ...this.content.pack(w.small, !prev),
        derived,
        history: e.history,
        canUndo: e.canUndo,
        canRedo: e.canRedo,
        timings: e.lastTimings,
        stateId: e.stateId,
        ...(prev ? { same } : {}),
      },
      transfer,
    };
  }

  // 只改了名字、省份：推导数组没变，不必复制、传送约 10 MB 的数据
  light(e: Engine): { snap: LightSnapshot; transfer: Transferable[] } {
    const w = e.world;
    const province = w.causes.province.slice();
    const islandType = w.causes.islandType.slice();
    // 推导数组没变（主线程沿用）：下一份只带变了的数组的快照照样以这些数组为准，状态编号换成这一次的。
    // 省份、岛的种类主线程换成了这一次的内容：记下的副本跟着换（别的原因数组轻快照不改）
    const last = this.last;
    if (last) {
      last.state = e.stateId;
      for (const [k, v] of [
        ['province', w.causes.province],
        ['islandType', w.causes.islandType],
      ] as const) {
        if (!sameArray(last.causes.get(k), v)) last.causes.set(k, sliceOf(v));
      }
    }
    // 地物没变（只改了省份）：不发，主线程沿用
    const sameF = !!last && this.sameFeatures(w.derived.features);
    if (!last) this.features = null;
    return {
      snap: {
        light: true,
        ...this.content.pack(w.small, !last),
        features: sameF ? null : w.derived.features,
        province,
        islandType,
        history: e.history,
        canUndo: e.canUndo,
        canRedo: e.canRedo,
        timings: e.lastTimings,
        stateId: e.stateId,
      },
      transfer: [province.buffer, islandType.buffer],
    };
  }
}
