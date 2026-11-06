import { type Link, linksBlanked, linksOf, stripLinks } from '../content/links';
import { stableJson } from '../content/refs';
import type { ContentKind } from '../content/registry';

// 导入时比较来源的一项和目的地同 id 的一项（第六十四轮，第六十六轮从 import-gates.ts 搬出来，原样）：比较用的字、
// 加进世界后的样子、目的地这一份是不是来源去掉几条引用后的样子、补得回哪几条、比重回不回来。都按对象记着

// ---------- 比较用的字 ----------

// 比较用的字（同 sameContent，按对象记着）：包和世界里的项都是不改动的数据，勾选每变一次都要比，一个库的地名风格就有约 1 MB
const contentKeys = new WeakMap<object, string>();
export function contentKey(k: ContentKind, x: unknown): string {
  let s = contentKeys.get(x as object);
  if (s === undefined) {
    const skip = k.pack.sameIgnore;
    s = stableJson(skip?.length ? Object.fromEntries(Object.entries(x as object).filter(([key]) => !skip.includes(key))) : x);
    contentKeys.set(x as object, s);
  }
  return s;
}

// 加进世界的最后一步之后的样子（同一项给同一个对象）
const finalMemo = new WeakMap<object, unknown>();
export function finalized(k: ContentKind, x: unknown): unknown {
  if (!k.pack.finalize) return x;
  let f = finalMemo.get(x as object);
  if (f === undefined) finalMemo.set(x as object, (f = k.pack.finalize(x)));
  return f;
}

// ---------- 目的地这一份和来源的关系 ----------

// same     一模一样
// trimmed  来源去掉几条引用（missing）后的样子。引用改过名（撞名时 a → a-2）的也算，但这种不补回（fixable 是 false）
// differs  同 id，内容不同
export interface Relation {
  t: 'same' | 'trimmed' | 'differs';
  missing: readonly Link[];
  fixable: boolean;
}

const SAME: Relation = { t: 'same', missing: [], fixable: true };
const DIFFERS: Relation = { t: 'differs', missing: [], fixable: false };

const relationMemos = { world: new WeakMap<object, WeakMap<object, Relation>>(), pack: new WeakMap<object, WeakMap<object, Relation>>() };

function computeRelation(k: ContentKind, x: unknown, y: unknown, world: boolean): Relation {
  const fin = (v: unknown) => (world ? finalized(k, v) : v);
  if (contentKey(k, y) === contentKey(k, fin(x))) return SAME;
  // 目的地这份写到的目标（a-2 是导入时撞名改的 a）
  const exact = new Set<string>();
  const based = new Set<string>();
  for (const l of linksOf(k, y)) {
    exact.add(l.id);
    based.add(l.id.replace(/-\d+$/, ''));
  }
  const links = linksOf(k, x);
  const here = (l: Link) => exact.has(l.id) || based.has(l.id);
  if (links.some((l) => !l.drop && !here(l))) return DIFFERS;
  const gone = links.filter((l) => l.drop && !here(l));
  const cand = gone.length ? stripLinks(k, x, (l) => !here(l)) : x;
  if (contentKey(k, linksBlanked(k, y)) !== contentKey(k, linksBlanked(k, fin(cand)))) return DIFFERS;
  return { t: 'trimmed', missing: gone, fixable: links.every((l) => exact.has(l.id) || !here(l)) };
}

export function relationOf(k: ContentKind, x: unknown, y: unknown, world: boolean): Relation {
  const memo = world ? relationMemos.world : relationMemos.pack;
  let of = memo.get(x as object);
  if (!of) memo.set(x as object, (of = new WeakMap()));
  let r = of.get(y as object);
  if (!r) of.set(y as object, (r = computeRelation(k, x, y, world)));
  return r;
}

// 现在补得回哪几条：按现在有的目标去掉引用后，还写着、目的地这份没写的（一处写了两个目标、缺一个时整处还是去掉，不算）
export function restoredLinks(k: ContentKind, x: unknown, y: unknown, rel: Relation, has: (l: Link) => boolean): Link[] {
  if (!rel.fixable || !rel.missing.some(has)) return [];
  const there = new Set(linksOf(k, y).map((l) => l.id));
  return linksOf(k, stripLinks(k, x, (l) => !has(l))).filter((l) => !there.has(l.id));
}

// 勾上这个组也算补回：跟着文化来的组比重写 0（不参与生成），来源不是 0
export const weightBack = (k: ContentKind, x: unknown, y: unknown): boolean => k.id === 'cultureGroup' && (y as { weight?: number }).weight === 0 && (x as { weight?: number }).weight !== 0;
