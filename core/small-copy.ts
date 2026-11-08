import type { SmallState } from './world';

// 小数据的副本（第四十七轮）：small.content 当作不可变的，副本里按引用共用，别的部分照旧是一段 JSON。
// 带着一整个库的世界 content 有 300 KB 上下，以前每条命令序列化两次、撤销解析一次，每步的撤销记录都留一整份。
// 所有改 content 的地方都是整个换掉（setContent、orderContent），没变的种类、项还是原来的对象，
// 所以几步之间、撤销记录之间共用，只有改到的那一种多一份浅拷贝（查的办法：content-share.test.ts 把 content 冻住跑一遍）。
//
// JSON 里 content 的位置上留一个占位（0）：解析出来键的先后不变，写回去的世界文件、摘要逐字节相同。
// 第五十四轮：人口群体（small.popGroups）也一样。也是整个换掉的（GroupTable.commit、compactGroups），世界加了几个变量后有上万个群体，
// 每条命令序列化一遍就是几十毫秒。
// 第八十五轮：国家的档案（small.archive：统治者、家族、备注、大事）也一样，改档案的命令整个换掉它（human/archive-store.ts）
export type Content = NonNullable<SmallState['content']>;
type PopGroups = NonNullable<SmallState['popGroups']>;
type Archive = NonNullable<SmallState['archive']>;

export interface SmallCopy {
  small: string;
  content?: Content;
  popGroups?: PopGroups;
  archive?: Archive;
}

// 不带内容的小数据：content 的位置上是占位（键的先后不变）
export const withoutContent = (small: SmallState): SmallState => (small.content === undefined ? small : { ...small, content: 0 as unknown as Content });
// 内容、档案都没换时发给主线程的：两样的位置上都是占位（见 src/content-post.ts：档案按对象比，没换时不发）
export const postedSmall = (small: SmallState): SmallState => (small.archive === undefined ? withoutContent(small) : { ...withoutContent(small), archive: 0 as unknown as Archive });

// 副本里 JSON 的部分：content、popGroups、archive 的位置上是占位
const shared = (small: SmallState): SmallState => (small.popGroups === undefined ? postedSmall(small) : { ...postedSmall(small), popGroups: 0 as unknown as PopGroups });

export function copySmall(small: SmallState): SmallCopy {
  const out: SmallCopy = { small: JSON.stringify(shared(small)) };
  if (small.content !== undefined) out.content = small.content;
  if (small.popGroups !== undefined) out.popGroups = small.popGroups;
  if (small.archive !== undefined) out.archive = small.archive;
  return out;
}

export function restoreSmall(copy: SmallCopy): SmallState {
  const out = JSON.parse(copy.small) as SmallState;
  // 赋给已有的键，位置不变
  if (copy.content !== undefined) out.content = copy.content;
  if (copy.popGroups !== undefined) out.popGroups = copy.popGroups;
  if (copy.archive !== undefined) out.archive = copy.archive;
  return out;
}

// 结构化克隆，内容、档案照旧共用（预览的副本）
export function cloneSmall(small: SmallState): SmallState {
  const out = structuredClone(postedSmall(small));
  if (small.content !== undefined) out.content = small.content;
  if (small.archive !== undefined) out.archive = small.archive;
  return out;
}

// 两个值的 JSON 一字不差吗（键的先后也算）。depth 层以内逐键比，同一个对象不用序列化；
// JSON 里没有的值（undefined）不算键，和序列化以后比完全一样
function sameJson(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (depth === 0 || a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = Object.keys(x).filter((k) => x[k] !== undefined);
  const ky = Object.keys(y).filter((k) => y[k] !== undefined);
  if (kx.length !== ky.length) return false;
  for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i] || !sameJson(x[kx[i]], y[ky[i]], depth - 1)) return false;
  return true;
}

// 与副本一字不差吗（等于比两段完整的 JSON）：内容按 种类 ▸ 项 逐层比，只序列化换过的项
export const sameAsCopy = (small: SmallState, copy: SmallCopy): boolean =>
  JSON.stringify(shared(small)) === copy.small && sameJson(small.content, copy.content, 2) && sameJson(small.popGroups, copy.popGroups, 1) && sameJson(small.archive, copy.archive, 2);
