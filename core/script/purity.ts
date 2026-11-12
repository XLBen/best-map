import { codeOnly } from './format';
import type { ScriptIssue } from './issues';
import type { CellResult } from './run';

// 纯度检查：正反两遍、隔一格一遍，再比内置对象前后有没有被改（第一百零一轮从 core/script.ts 原样搬来）

// ---------- 纯度检查 ----------

export interface PurityResult {
  pure: boolean;
  // 几次结果不同的第一格
  cell?: number;
  // 脚本改了的内置对象（如 "JSON.memo"）；检查结束时已经改回去了
  changed?: string;
  // 有一次运行失败（编辑器显示 issue.message）
  issue?: ScriptIssue;
  // 不纯时的中文说明（编辑器的红字）
  text?: string;
}

// 脚本能碰到的内置对象：全局的构造函数、命名空间，以及字面量背后的原型。
// 遮名字挡不住 [].constructor.prototype、JSON、Math.sin 这些路，脚本在上面挂的东西会留到下一格、下一次运行
const INTRINSIC_NAMES = [
  'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Proxy', 'Reflect', 'JSON', 'Math', 'Intl', 'Atomics',
  'Iterator', 'Temporal',
];

interface ObjSnap {
  name: string;
  proto: object | null;
  ext: boolean;
  props: Map<PropertyKey, PropertyDescriptor>;
}
interface IntrinsicSnap {
  objs: Map<object, ObjSnap>;
  globals: Set<PropertyKey>;
}

const isObj = (v: unknown): v is object => v !== null && (typeof v === 'object' || typeof v === 'function');

// 比较、复原用的函数在载入时就取好：脚本把 Reflect.ownKeys 换掉也骗不过检查
const { ownKeys, getOwnPropertyDescriptor: ownDesc, getPrototypeOf, setPrototypeOf, isExtensible, defineProperty, deleteProperty } = Reflect;
const sameValue = Object.is;

function intrinsicRoots(): [string, unknown][] {
  const roots: [string, unknown][] = [];
  for (const name of INTRINSIC_NAMES) {
    // 只读数据属性，不触发宿主的懒加载 getter
    const d = ownDesc(globalThis, name);
    if (d && 'value' in d) roots.push([name, d.value]);
  }
  const proto = (v: unknown) => getPrototypeOf(v as object);
  const arrayIter = proto([][Symbol.iterator]());
  roots.push(
    ['%TypedArray%', proto(Int8Array)],
    ['%ArrayIteratorPrototype%', arrayIter],
    ['%IteratorPrototype%', proto(arrayIter)],
    ['%StringIteratorPrototype%', proto(''[Symbol.iterator]())],
    ['%MapIteratorPrototype%', proto(new Map().entries())],
    ['%SetIteratorPrototype%', proto(new Set().values())],
    ['%GeneratorFunction%', proto(function* () {})],
    ['%AsyncFunction%', proto(async () => {})],
  );
  return roots;
}

function takeObj(o: object, name: string): ObjSnap {
  const props = new Map<PropertyKey, PropertyDescriptor>();
  for (const k of ownKeys(o)) props.set(k, ownDesc(o, k)!);
  return { name, proto: getPrototypeOf(o), ext: isExtensible(o), props };
}

// 记下内置对象（和它们上面一层的函数、对象，如 Math.sin、Array.prototype.map）自己的属性，以及全局有哪些名字
function snapshotIntrinsics(): IntrinsicSnap {
  const objs = new Map<object, ObjSnap>();
  const add = (v: unknown, name: string) => {
    if (isObj(v) && !objs.has(v)) objs.set(v, takeObj(v, name));
  };
  for (const [name, v] of intrinsicRoots()) {
    add(v, name);
    if (!isObj(v)) continue;
    const p = ownDesc(v, 'prototype');
    if (p && 'value' in p) add(p.value, `${name}.prototype`);
  }
  for (const s of [...objs.values()]) for (const [k, d] of s.props) if ('value' in d) add(d.value, `${s.name}.${String(k)}`);
  return { objs, globals: new Set(ownKeys(globalThis)) };
}

const sameDesc = (a: PropertyDescriptor, b: PropertyDescriptor) =>
  sameValue(a.value, b.value) && a.get === b.get && a.set === b.set && a.writable === b.writable && a.enumerable === b.enumerable && a.configurable === b.configurable;

// 与快照比较：变了的尽量改回去（加的删掉、改的复原），返回第一处变化（如 "JSON.memo"），没变返回 null。
// 全局对象只看有没有多出来的名字（宿主的懒加载属性第一次读时会从 getter 变成值，不算）
function restoreIntrinsics(snap: IntrinsicSnap): string | null {
  const changes: string[] = [];
  for (const [o, s] of snap.objs) {
    if (getPrototypeOf(o) !== s.proto) {
      changes.push(`${s.name} 的原型`);
      setPrototypeOf(o, s.proto);
    }
    for (const k of ownKeys(o)) {
      const before = s.props.get(k);
      if (!before) {
        changes.push(`${s.name}.${String(k)}`);
        deleteProperty(o, k);
      } else if (!sameDesc(before, ownDesc(o, k)!)) {
        changes.push(`${s.name}.${String(k)}`);
        defineProperty(o, k, before);
      }
    }
    for (const [k, before] of s.props) {
      if (ownDesc(o, k)) continue;
      changes.push(`${s.name}.${String(k)}`);
      defineProperty(o, k, before);
    }
    if (isExtensible(o) !== s.ext) changes.push(`${s.name}（被冻结了）`);
  }
  for (const k of ownKeys(globalThis)) {
    if (snap.globals.has(k)) continue;
    changes.push(`globalThis.${String(k)}`);
    deleteProperty(globalThis, k);
  }
  return changes.length ? changes[0] : null;
}

// y 的第 j 项对应 x 的第 at(j) 项（x 有 mx 项，y 有 my 项）：逐值相同返回 −1，否则返回第一处不同在 x 里的下标
function firstDiff(x: object, mx: number, y: object, my: number, at: (j: number) => number): number {
  const xs = x as Record<string, ArrayLike<number>>;
  const ys = y as Record<string, ArrayLike<number>>;
  for (const key of Object.keys(xs)) {
    const s = mx ? xs[key].length / mx : 0;
    for (let j = 0; j < my; j++) {
      const i = at(j);
      for (let t = 0; t < s; t++) if (!sameValue(xs[key][i * s + t], ys[key][j * s + t])) return i;
    }
  }
  return -1;
}

function compareRuns(run: (cells: Int32Array) => CellResult, fwd: Int32Array): PurityResult {
  const m = fwd.length;
  const a = run(fwd);
  if (!a.ok) return { pure: false, issue: a.issue };
  // 倒着算：“记住上一格”的脚本露馅
  const b = run(fwd.slice().reverse());
  if (!b.ok) return { pure: false, issue: b.issue };
  let i = firstDiff(a.output, m, b.output, m, (j) => m - 1 - j);
  if (i < 0) {
    // 隔一格算一格：结果不能取决于同一批里还有哪些格（只重算变了的格时，批里的格每次都不同）
    const odd = fwd.filter((_, j) => j % 2 === 1);
    const c = run(odd);
    if (!c.ok) return { pure: false, issue: c.issue };
    i = firstDiff(a.output, m, c.output, odd.length, (j) => 2 * j + 1);
  }
  if (i >= 0) return { pure: false, cell: fwd[i], text: '地图上有一处几次算出的结果不一样：不要记住别的格的结果' };
  return { pure: true };
}

// 纯度检查：同一批格正着算一遍、倒着算一遍、隔一格算一遍，结果逐值相同，而且没有改动任何内置对象，才算纯。
// 只对纯的脚本才能做“只重算输入变了的格”，而且撤销、重放、检查点恢复的结果才会逐值一致，所以提交前要检查。
// 脚本在内置对象上挂的东西检查完会被删掉（验证用的 worker 里不留下痕迹）
export function checkPurity(run: (cells: Int32Array) => CellResult, cells: ArrayLike<number>): PurityResult {
  const snap = snapshotIntrinsics();
  let res: PurityResult = { pure: true };
  try {
    res = compareRuns(run, Int32Array.from(cells));
  } finally {
    const changed = restoreIntrinsics(snap);
    if (changed) res = { ...res, pure: false, changed, text: `脚本改了内置的 ${changed}：不能用它在格之间传东西` };
  }
  return res;
}

// 源码里用到了生态的辅助函数（biome、dominantBiome、biomeAtSource、biomeAtMouth）：要先算一遍不计水体类型的植被
const BIOME_CALL = /(?<![\p{ID_Continue}$.])(biome|dominantBiome|biomeAtSource|biomeAtMouth)\s*\(/u;
export function usesBiomeHelpers(src: string): boolean {
  return BIOME_CALL.test(codeOnly(src));
}
