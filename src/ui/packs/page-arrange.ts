import { type Arrange, type ArrangeRelation, type ItemsOf, type LinkTable, PRESET_ARRANGE, RELATIONS, arrangeOf, canMerge, linkTable, mergeInto, parentsFor, splitOut } from '../../../core/content/arrange';
import { kindOf } from '../../../core/content/registry';
import { worldLibrary } from '../../../core/packs/switch';
import { type PageCtx, type SourceRef, entryOf, itemsOf, kindTitle, sourceKind } from './page-source';

// 融入（第六十轮）的界面逻辑：这一份用哪张安排、卡片和安排怎么对应、卡片拖到另一张上行不行、“⋯”里有什么。
// 核心（哪些组合讲得通、下面有哪些）在 core/content/arrange.ts。不碰界面，测试直接调

// ---------- 这一份的安排 ----------

// 库：库自己写的，没写时预设。世界没有自己的安排：看它来自的那个库（世界里什么都不记，生成、摘要一点不变）；那个库不在了用预设
export function arrangeFor(src: SourceRef, ctx: PageCtx): Arrange {
  if (src.t === 'lib') return arrangeOf(entryOf(src, ctx)?.pack);
  const key = ctx.world ? worldLibrary(ctx.world.small) : undefined;
  const e = key ? ctx.lib.find((x) => x.key === key) : undefined;
  return e ? arrangeOf(e.pack) : PRESET_ARRANGE;
}

// 只有我的库能改
export const canArrange = (src: SourceRef, ctx: PageCtx): boolean => sourceKind(src, ctx) === 'mine';

// ---------- 谁属于谁，按这一份记着 ----------

interface View {
  items: Map<string, readonly unknown[]>;
  tables: Map<ArrangeRelation, LinkTable>;
}
const views = new WeakMap<object, View>();
const NO_HOLDER = {};

export interface LinkView {
  items: ItemsOf;
  table: (r: ArrangeRelation) => LinkTable;
}

// 同一份内容（世界、库的树根换了才换）只读一遍树、只算一遍表：文化组的每一页、每一次渲染都要用
export function linkView(src: SourceRef, ctx: PageCtx): LinkView {
  const holder = src.t === 'world' ? (ctx.world ?? NO_HOLDER) : (entryOf(src, ctx)?.pack ?? NO_HOLDER);
  let v = views.get(holder);
  if (!v) views.set(holder, (v = { items: new Map(), tables: new Map() }));
  const memo = v;
  const items: ItemsOf = (id) => {
    let list = memo.items.get(id);
    if (!list) {
      const k = kindOf(id);
      memo.items.set(id, (list = k ? itemsOf(src, k, ctx) : []));
    }
    return list;
  };
  return {
    items,
    table: (r) => {
      let t = memo.tables.get(r);
      if (!t) memo.tables.set(r, (t = linkTable(r, items)));
      return t;
    },
  };
}

// 这一份里融入到这种内容下面的几条关系
export const mergedInto = (arrange: Arrange, parentKind: string): ArrangeRelation[] => RELATIONS.filter((r) => r.parent === parentKind && arrange[r.child] === parentKind);
// 这种内容现在融入到哪里（没有时 undefined）
export function mergedRelation(arrange: Arrange, child: string): ArrangeRelation | undefined {
  const parent = arrange[child];
  return parent ? RELATIONS.find((r) => r.child === child && r.parent === parent) : undefined;
}

// ---------- 卡片和安排 ----------

const EXTRA_TITLE: Record<string, string> = { variables: '变量', water: '生态与水系', table: '总表' };
export const arrangeTitle = (key: string): string => {
  if (EXTRA_TITLE[key]) return EXTRA_TITLE[key];
  if (key.startsWith('dim:')) return '取值';
  const k = kindOf(key);
  return k ? kindTitle(k) : key;
};

// 拖一张卡片时拖的是哪种下级：一维的卡片就是取值
export const cardChild = (cardId: string): string => (cardId.startsWith('dim:') ? 'popValue' : cardId);
// 这张卡片作为上级是哪种内容：取值融入取值组时，一维的卡片就是取值组（首页不再单独列取值组）
export const cardParent = (cardId: string, arrange: Arrange): string | null => (cardId.startsWith('dim:') ? (arrange.popValue === 'valueGroup' ? 'valueGroup' : null) : cardId);

export interface DropVerdict {
  // merge：融入 parent；out：拆出来；none：什么都不做；no：不接受，text 是原因
  t: 'merge' | 'out' | 'none' | 'no';
  text: string;
  child: string;
  parent?: string;
}

// 为什么不能融入（一句话）
export function whyNotMerge(child: string): string {
  const name = arrangeTitle(child);
  const ps = parentsFor(child).map(arrangeTitle);
  return ps.length ? `${name}只能融入${ps.join('、')}` : `${name}不能融入别的内容`;
}

// 把一种下级拖到一张卡片上（over：卡片的 id，'era' 是时代规则；null：没在任何卡片上）
export function dropVerdict(child: string, over: string | null, arrange: Arrange, self: string | null = null): DropVerdict {
  const cur = arrange[child];
  const title = arrangeTitle(child);
  if (over === null) return cur ? { t: 'out', child, text: `拆出${title}，单独成卡` } : { t: 'none', child, text: '' };
  if (over === self) return { t: 'none', child, text: '' };
  const parent = cardParent(over, arrange);
  if (parent && parent === cur) return { t: 'none', child, text: `${title}已经在${arrangeTitle(parent)}里` };
  if (parent && canMerge(child, parent)) return { t: 'merge', child, parent, text: `融入${arrangeTitle(parent)}` };
  return { t: 'no', child, text: whyNotMerge(child) };
}

// 松手之后的安排（不变时 null）
export function verdictArrange(v: DropVerdict, arrange: Arrange): Arrange | null {
  if (v.t === 'merge' && v.parent) return mergeInto(arrange, v.child, v.parent);
  if (v.t === 'out') return splitOut(arrange, v.child);
  return null;
}

// ---------- 卡片的“⋯” ----------

export interface ArrangeAction {
  id: string;
  label: string;
  next: Arrange;
}

// kids：这张卡片现在含着的。没有鼠标、触摸时靠它；什么都不能做的卡片没有“⋯”
export function cardActions(cardId: string, arrange: Arrange, kids: readonly { key: string; title: string }[] = []): ArrangeAction[] {
  const child = cardChild(cardId);
  const out: ArrangeAction[] = [];
  for (const p of parentsFor(child)) {
    if (p === arrange[child]) continue;
    out.push({ id: `into:${p}`, label: `融入到${arrangeTitle(p)}`, next: mergeInto(arrange, child, p) });
  }
  if (arrange[child] && !kids.some((k) => k.key === child)) out.push({ id: 'out', label: '拆出来', next: splitOut(arrange, child) });
  for (const k of kids) out.push({ id: `out:${k.key}`, label: `拆出${k.title}`, next: splitOut(arrange, k.key) });
  return out;
}
