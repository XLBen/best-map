import { CommandError } from './errors';
import type { Mesh } from './mesh';
import {
  type CellOutputs,
  type CellResult,
  type InputValue,
  type ScriptInputs,
  type ScriptIssue,
  ScriptError,
  compileScript,
  runScript,
} from './script';
import { SPECIES_SCRIPT_KINDS, type Species } from './species';
import type { World } from './world';

// 生态的脚本（第三批）在世界上运行：长在哪里（placement）、颜色（color）。
// 脚本只在引擎的 worker 里跑；主线程只读结果（derived.placeF、derived.look）。
//
// 速度：每段脚本按格记住上一次的结果，只重算“它读到的输入变了”的格（脚本必须是纯的，提交前由 checkPurity 检查）。
// 运行时记下脚本实际读了哪些输入（变量、field() 的自定义场、river() 的河岸场），下次逐格比较这些输入的内容；
// 种类、生态、源码、种子、整体的值（世界参数、颜色脚本的 color）放在记录的键里。只取决于网格的位置（x、y、px…）不用比较。
// 读的时候还没有的自定义场、河岸场（field() 回退成同名的内置变量、river() 为 0）也记下：以后有了就整个重算。
// 记住的东西按网格存（与 features.ts 的 memoized 一样按内容比较，不按数组对象）：同一网格上的副本、预览、
// 撤销缓存都能用，结果与从头算逐值相同——每格的结果只取决于这一格的输入、种子和源码。
// 涂生态（硬覆盖）不改脚本读的东西，一格也不用重算；涂自定义场只重算涂到的格；改气候只重算跟着变了的一片

// 生态脚本显示用的名字（出错说明、看门狗提示）
export const speciesOwner = (sp: Species) => sp.name || sp.id;

// 世界种子（脚本的噪声、rand 用它）：与 worldInputs 的 seed 相同
export const worldSeedOf = (world: World) => world.small.terrain.gen?.seed ?? world.settings.seed;

// 添加、修改生态时检查脚本：只能是“长在哪里”“颜色”两种，语法要对。语法错误抛 ScriptError（是 CommandError），
// applyCommand 据此整条命令不生效，并用中文说明哪一行错了。运行时的错误不在这里查（那是软失败，见下）
export function checkSpeciesScripts(sp: Species): void {
  const box = sp.scripts;
  if (!box) return;
  for (const [kind, s] of Object.entries(box)) {
    if (!s) continue;
    if (!(SPECIES_SCRIPT_KINDS as readonly string[]).includes(kind)) throw new CommandError(`生态“${speciesOwner(sp)}”只能有“长在哪里”和“颜色”两种脚本`);
    compileScript(kind as (typeof SPECIES_SCRIPT_KINDS)[number], s.src, speciesOwner(sp));
  }
}

// 带长在哪里脚本的生态在 placeF 里的位置：slot[s] 为第几个（按生态的顺序），没有脚本为 −1；P 是个数。
// placeF[i·P + slot[s]] 是生态 s 在格 i 的系数
export function placementSlots(species: readonly Species[]): { slot: Int32Array; P: number } {
  const slot = new Int32Array(species.length).fill(-1);
  let P = 0;
  species.forEach((sp, s) => {
    if (sp.scripts?.placement) slot[s] = P++;
  });
  return { slot, P };
}

// ---------- 按格记住结果 ----------

type Typed = Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Uint8ClampedArray;

// 只取决于网格的输入：不用比较
const STATIC_KEYS = new Set(['x', 'y', 'px', 'py', 'pz']);

interface Snap {
  copy: Typed;
  ver: number;
}

interface Entry {
  // 每格的结果（stride 个数），valid[i] 为 1 时与 deps 里各输入的快照对应
  out: Float32Array | Uint8Array;
  valid: Uint8Array;
  // 读到的输入 → 当时快照的版本。null：这一次改过、还没对上快照（finish 之前；没走到 finish 时下次整个重算）
  deps: Map<string, number> | null;
  // 读的时候还没有的自定义场、河岸场（'field:名字'、'river:类型'）：这次有了就整个重算
  absent: Set<string>;
}

interface Store {
  // 每个输入最近的内容（各段脚本共用一份）
  snaps: Map<string, Snap>;
  // 键：种类、源码、种子、整体的值（世界参数、颜色……）；最近用过的在后
  entries: Map<string, Entry>;
  ver: number;
}

const MAX_ENTRIES = 32;

// 统计（测试用）：累计实际运行脚本的格数
export const scriptRunStats = { placement: 0, color: 0 };
const stores = new WeakMap<Mesh, Store>();

// 忘掉这个网格上记下的结果，下一次全部从头算（测试用它对照“从头算”）
export function forgetScriptResults(mesh: Mesh): void {
  stores.delete(mesh);
}

function storeOf(mesh: Mesh): Store {
  let s = stores.get(mesh);
  if (!s) stores.set(mesh, (s = { snaps: new Map(), entries: new Map(), ver: 0 }));
  return s;
}

function copyOf(v: ArrayLike<number>): Typed {
  return ArrayBuffer.isView(v) ? (v as Typed).slice() : Float64Array.from(v);
}

// 逐格比较（按位：0 与 −0、不同的 NaN 都算变了）。长度、类型不同时返回 null（整个重算）
function diffInto(prev: Typed, cur: ArrayLike<number>, out: Uint8Array): boolean | null {
  const n = out.length;
  if (prev.length !== n || cur.length !== n) return null;
  let any = false;
  if (ArrayBuffer.isView(cur) && cur.constructor === prev.constructor) {
    const c = cur as Typed;
    const size = prev.BYTES_PER_ELEMENT;
    if (size === 4 || size === 8) {
      const words = size / 4;
      const a = new Int32Array(prev.buffer, prev.byteOffset, n * words);
      const b = (c.byteOffset & 3) === 0 ? new Int32Array(c.buffer, c.byteOffset, n * words) : new Int32Array(copyOf(c).buffer, 0, n * words);
      if (words === 1) {
        for (let i = 0; i < n; i++) {
          if (a[i] !== b[i]) {
            out[i] = 1;
            any = true;
          }
        }
      } else {
        for (let i = 0; i < n; i++) {
          if (a[2 * i] !== b[2 * i] || a[2 * i + 1] !== b[2 * i + 1]) {
            out[i] = 1;
            any = true;
          }
        }
      }
      return any;
    }
    for (let i = 0; i < n; i++) {
      if (prev[i] !== c[i]) {
        out[i] = 1;
        any = true;
      }
    }
    return any;
  }
  return null;
}

// 一次推导（一遍植被、一遍颜色）里运行的一组脚本：各输入与快照的差别只算一次，结束时一起更新快照
export class ScriptSession {
  private readonly store: Store;
  private readonly n: number;
  // 本次各输入逐格变了没有（null：没有快照或对不上，要整个重算）
  private readonly changedOf = new Map<string, Uint8Array | null>();
  // 本次各输入的值
  private readonly current = new Map<string, ArrayLike<number>>();
  private readonly pending: { entry: Entry; deps: string[] }[] = [];

  constructor(readonly world: World) {
    this.store = storeOf(world.mesh);
    this.n = world.mesh.n;
  }

  private changed(key: string, cur: ArrayLike<number>): Uint8Array | null {
    if (this.changedOf.has(key)) return this.changedOf.get(key)!;
    const snap = this.store.snaps.get(key);
    let mask: Uint8Array | null = null;
    if (snap) {
      mask = new Uint8Array(this.n);
      if (diffInto(snap.copy, cur, mask) === null) mask = null;
    }
    this.changedOf.set(key, mask);
    return mask;
  }

  // 对 mask 里的格（cells 是它们按编号排好的列表）运行一段脚本，结果按格放（stride 个数一格：系数 1 个，颜色 3 个），
  // 只有 mask 里的格有意义。出错时 ok 为 false：调用方这一次整段按没有这段脚本处理（系数 1、基础颜色）。
  // alias：给这次运行专有的输入（颜色脚本的 share）换一个键，免得与别的生态的混在一起
  run<K extends 'placement' | 'color'>(
    kind: K,
    sp: Species,
    src: string,
    inputs: ScriptInputs,
    cells: Int32Array,
    mask: Uint8Array,
    seed: number,
    alias: Record<string, string> = {},
  ): { ok: true; out: K extends 'placement' ? Float32Array : Uint8Array } | { ok: false; issue: ScriptIssue } {
    const owner = speciesOwner(sp);
    const opts = { owner, id: sp.id, seedKey: sp.seedKey, seed };
    const stride = kind === 'placement' ? 1 : 3;
    const n = this.n;
    let params: readonly { key: string; mode: string }[];
    try {
      params = compileScript(kind, src, owner).params;
    } catch (e) {
      // 语法错误（添加、修改的命令会拒绝，正常到不了这里）、安全模式下的说明都由 runScript 给出
      if (!(e instanceof ScriptError)) throw e;
      return { ok: false, issue: e.issue };
    }
    // 整体的值（世界参数、颜色脚本的 color……）放进键里：变了就是另一段记录
    const scalars = params.map((p) => {
      if (p.mode === 'cell') return null;
      const v = inputs.get(p.key);
      return v !== undefined && typeof v === 'object' ? null : (v ?? null);
    });
    const colorArg = kind === 'color' ? inputs.get('color') : undefined;
    // 键里有生态的 id：两种生态的源码、seedKey 都相同时（复制出来的生态）也各记各的（颜色脚本读的 share 各不相同）
    const key = JSON.stringify([kind, sp.id, src, sp.seedKey ?? sp.id, seed, inputs.globe, scalars, colorArg ? Array.from(colorArg as ArrayLike<number>) : null]);
    const store = this.store;
    let entry = store.entries.get(key);
    if (entry) {
      store.entries.delete(key);
      store.entries.set(key, entry);
    }
    const toAlias = (k: string) => alias[k] ?? k;
    const fromAlias = new Map(Object.entries(alias).map(([k, v]) => [v, k]));
    // 按键取这次的值：field:名字、river:类型、别的按变量名
    const valueOf = (dep: string): ArrayLike<number> | undefined => {
      const cached = this.current.get(dep);
      if (cached) return cached;
      let v: InputValue | undefined;
      if (dep.startsWith('field:')) v = inputs.field?.(dep.slice(6));
      else if (dep.startsWith('river:')) v = inputs.river?.(dep.slice(6));
      else v = inputs.get(fromAlias.get(dep) ?? dep);
      if (v === undefined || typeof v !== 'object') return undefined;
      this.current.set(dep, v as ArrayLike<number>);
      return v as ArrayLike<number>;
    };
    // 要重算的格：记录里没有的，和读到的输入变了的
    let batch: Int32Array = cells;
    let changes: Uint8Array[] = [];
    let full = true;
    // 上次没有、这次有了的自定义场、河岸场：脚本读到的值变了（不再回退成内置变量或 0），整个重算
    const appeared = (dep: string) => (dep.startsWith('field:') ? inputs.field?.(dep.slice(6)) : inputs.river?.(dep.slice(6))) !== undefined;
    if (entry && entry.deps && entry.out.length === n * stride && ![...entry.absent].some(appeared)) {
      changes = [];
      for (const [dep, ver] of entry.deps) {
        const snap = store.snaps.get(dep);
        const cur = valueOf(dep);
        const ch = snap && snap.ver === ver && cur ? this.changed(dep, cur) : null;
        if (!ch) {
          changes = [];
          break;
        }
        changes.push(ch);
      }
      if (changes.length === entry.deps.size) {
        full = false;
        const list: number[] = [];
        for (let j = 0; j < cells.length; j++) {
          const i = cells[j];
          let redo = entry.valid[i] === 0;
          for (let k = 0; k < changes.length && !redo; k++) if (changes[k][i]) redo = true;
          if (redo) list.push(i);
        }
        batch = list.length === cells.length ? cells : Int32Array.from(list);
      }
    }
    // 运行时记下读了哪些输入
    const read = new Map<string, ArrayLike<number>>();
    const note = (dep: string, v: InputValue | undefined) => {
      // 每格一个值的数组才算（颜色脚本的 color 是整体的值，已经在键里）
      if (v !== undefined && typeof v === 'object' && (v as ArrayLike<number>).length === n && !STATIC_KEYS.has(dep)) {
        read.set(dep, v as ArrayLike<number>);
        if (!this.current.has(dep)) this.current.set(dep, v as ArrayLike<number>);
      }
      return v;
    };
    // 读了却还没有的自定义场、河岸场
    const absent = new Set<string>();
    const maybe = (dep: string, v: ArrayLike<number> | undefined) => {
      if (v === undefined) absent.add(dep);
      return note(dep, v) as ArrayLike<number> | undefined;
    };
    const recording: ScriptInputs = {
      n: inputs.n,
      globe: inputs.globe,
      get: (k) => note(toAlias(k), inputs.get(k)),
      field: (name) => maybe(`field:${name}`, inputs.field?.(name)),
      // 总是给 river：还没有河流类型（inputs.river 为空）时也记下读了哪一种
      river: (id) => maybe(`river:${id}`, inputs.river?.(id)),
    };
    scriptRunStats[kind] += batch.length;
    const r = (batch.length ? runScript({ kind, src }, { ...opts, inputs: recording, cells: batch }) : { ok: true, output: null }) as
      | CellResult<K>
      | { ok: true; output: null };
    if (!r.ok) {
      // 出错：这次整段按没有脚本处理；记录作废（下次从头算，出错的那一格还会再出错）。
      // 只重算一部分格时，出错的一定是这部分里的格（别的格输入没变，上次没出错），第一处出错的格与从头算时相同
      store.entries.delete(key);
      return { ok: false, issue: r.issue };
    }
    if (!entry || full || entry.out.length !== n * stride) {
      entry = { out: stride === 1 ? new Float32Array(n) : new Uint8Array(n * stride), valid: new Uint8Array(n), deps: null, absent };
      store.entries.delete(key);
      store.entries.set(key, entry);
    } else {
      for (const dep of absent) entry.absent.add(dep);
      // 不在这次范围里、输入却变了的格：记录对不上新的快照了
      for (let i = 0; i < n; i++) {
        if (!entry.valid[i] || mask[i]) continue;
        for (let k = 0; k < changes.length; k++) {
          if (changes[k][i]) {
            entry.valid[i] = 0;
            break;
          }
        }
      }
    }
    if (r.output) {
      const src3 = kind === 'placement' ? (r.output as CellOutputs['placement']).factor : (r.output as CellOutputs['color']).rgb;
      for (let j = 0; j < batch.length; j++) {
        const i = batch[j];
        for (let t = 0; t < stride; t++) entry.out[i * stride + t] = src3[j * stride + t];
        entry.valid[i] = 1;
      }
    }
    const deps = new Set(full || !entry.deps ? read.keys() : [...entry.deps.keys(), ...read.keys()]);
    // 结果已经改了，要等 finish 更新了快照才对得上：在那之前算作没有记录（中途抛错没走到 finish 时，下次整个重算）
    entry.deps = null;
    this.pending.push({ entry, deps: [...deps] });
    return { ok: true, out: entry.out as K extends 'placement' ? Float32Array : Uint8Array };
  }

  // 本次的脚本都跑完了：更新快照（内容变了的才换、版本加一），记录对上新的版本；去掉多余的记录与快照
  finish(): void {
    const store = this.store;
    const bumped = new Map<string, number>();
    for (const { deps } of this.pending) {
      for (const dep of deps) {
        if (bumped.has(dep)) continue;
        const cur = this.current.get(dep);
        if (!cur) continue;
        let snap = store.snaps.get(dep);
        const ch = snap ? this.changed(dep, cur) : null;
        if (!snap || !ch) {
          snap = { copy: copyOf(cur), ver: ++store.ver };
          store.snaps.set(dep, snap);
        } else {
          let any = false;
          for (let i = 0; i < ch.length && !any; i++) if (ch[i]) any = true;
          if (any) {
            snap.copy.set(cur as ArrayLike<number>);
            snap.ver = ++store.ver;
          }
        }
        bumped.set(dep, snap.ver);
      }
    }
    for (const { entry, deps } of this.pending) {
      const map = new Map<string, number>();
      for (const dep of deps) {
        const v = bumped.get(dep);
        if (v === undefined) {
          // 这个输入这次取不到了：记录作废
          entry.valid.fill(0);
          map.clear();
          break;
        }
        map.set(dep, v);
      }
      entry.deps = map;
    }
    while (store.entries.size > MAX_ENTRIES) store.entries.delete(store.entries.keys().next().value!);
    const used = new Set<string>();
    for (const e of store.entries.values()) if (e.deps) for (const dep of e.deps.keys()) used.add(dep);
    for (const dep of [...store.snaps.keys()]) if (!used.has(dep)) store.snaps.delete(dep);
    this.pending.length = 0;
  }
}
