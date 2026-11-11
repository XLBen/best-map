import type { CountryLore, CountryMeta, RulerMeta, SmallState, World } from '../world';
import { loreOf, putLore } from './archive-store';
import { baseOf, one, titleFor, titleRand } from './blocs';
import { rulerTitleOf, titleContext } from './countries/records';
import { type Era, worldEra } from './era';
import { govTitles, governmentById, titled } from './government';

// 国名、称号跟着资源库变（第九十一轮）。
// 国名（CountryMeta.name / orig）和统治者的称号（RulerMeta.title）照旧存在世界里，但它们是推导出来的：
// 国名 = 词根（base）+ 政体给这个国家的称号（government.ts 的 govTitles：按等级、主流文化、文化组、主流文化最典型的取值换说法）。
// 以前只在生成国家时算一次，之后在资源库里改称号，地图上什么都不变。现在每条命令之后（commands.ts 的 applyCommand）：
// 称号会读的内容换了（TITLE_FIELDS 的那几项），就拿“改之前的内容给这个国家的称号”和“现在的”比——
//   - 不一样、国名没有手改过（nameLocked）、而且现在的国名正是按改之前的称号起的：换成按现在的称号起的；
//   - 这一国没有手改过称号（titleLocked）、称号正是改之前那个词的统治者（在位的、以前的都算）：换成现在的词。
// 所以只有适用的称号真的变了的国家才改名：改一个不相干的词、涂人口、改国界，谁也不会跟着改名（最典型的取值按资源库里文化写的倾向算，
// 不看地图上的人口，见 records.ts 的 typical）。词根、国界、人口、颜色、旗一个不动；历史那一段文字、大事是写下的字，不跟着改。
// 结果只取决于改之前、改之后的内容和国家的档案，重放逐值相同；撤销整步退回（国名在 small 的副本里，档案按引用换回）。
// 给一个国家换政体、主流文化（set_country）时国名照旧由它自己重起，在位的统治者的称号跟着换（followRuler），以前的统治者不动。
// 集团（帝国、联邦、同盟）的名字和联邦成员邦的名字用的是时代的“集团的称号”（blocs.ts 的 titleFor，按集团的编号挑一种）：
// 同一条规则——时代的这几种称号换了，名字正是按改之前的称号起的（集团没手改过名字）就换成按现在的起的

type Content = SmallState['content'];

// 称号会读的内容：种类 → 读哪几项（别的项改了不用比）。
//   政体      称号、统治者称号、换说法
//   国家等级  高低（称号按等级的 id 写，没写这一级时取最近的一级）
//   文化      文化组、倾向（最典型的取值从它来）
//   文化组    倾向（文化没写时用组的）
//   取值      属于哪个变量、哪个取值组
//   时代      有哪些变量；集团的称号（帝国、联邦、同盟的名字，联邦成员邦的名字）
export const TITLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  government: ['titles', 'rulers', 'names'],
  countryTier: ['order'],
  culture: ['group', 'tendencies', 'eraTendencies'],
  cultureGroup: ['tendencies', 'eraTendencies'],
  popValue: ['dimension', 'group'],
  era: ['dimensions', 'relations'],
};
export const TITLE_KINDS: readonly string[] = Object.keys(TITLE_FIELDS);

type Store = Record<string, Record<string, unknown>>;

// 一项里称号会读的那几项写成字（按对象记：内容不改动）
const sigs = new WeakMap<object, string>();
function sig(kind: string, x: Record<string, unknown>): string {
  let s = sigs.get(x);
  if (s === undefined) sigs.set(x, (s = JSON.stringify(TITLE_FIELDS[kind].map((k) => x[k] ?? null))));
  return s;
}

// 这一种里称号会读的东西变了没有（项的增减、先后也算：取值的先后决定“必须有”的变量取哪个）
function kindChanged(kind: string, a: Store[string] | undefined, b: Store[string] | undefined): boolean {
  if (a === b) return false;
  const ka = Object.keys(a ?? {});
  const kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) return true;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return true;
    const x = a![ka[i]];
    const y = b![kb[i]];
    if (x !== y && sig(kind, x as Record<string, unknown>) !== sig(kind, y as Record<string, unknown>)) return true;
  }
  return false;
}

// 改之前的：内容和世界的时代（命令执行前记下，见 applyCommand）
export interface TitleBefore {
  content: Content;
  era: string | undefined;
}
export const titleBefore = (small: SmallState): TitleBefore => ({ content: small.content, era: small.human?.era });

// 称号会读的东西变了没有。绝大多数命令（画笔、改别的内容）内容还是同一个对象：只比几个引用
export function titleInputsChanged(before: TitleBefore, small: SmallState): boolean {
  if (before.era !== small.human?.era) return true;
  const a = before.content as Store | undefined;
  const b = small.content as Store | undefined;
  if (a === b) return false;
  for (const kind of TITLE_KINDS) if (kindChanged(kind, a?.[kind], b?.[kind])) return true;
  return false;
}

type One = { zh: string; orig?: string };
interface Titles {
  title?: One;
  ruler?: One;
}
const sameOne = (a: One | undefined, b: One | undefined) => a?.zh === b?.zh && a?.orig === b?.orig;

// 政体给这个国家的称号（世界里没有这个政体时 null：没法推）
function titlesIn(world: Pick<World, 'small'>, m: Pick<CountryMeta, 'government' | 'primaryCulture' | 'tier'>): Titles | null {
  const g = governmentById(world.small, m.government);
  return g ? govTitles(g, titleContext(world, m)) : null;
}

// 按现在的资源库，这个国家该叫什么（手改过名字的、世界里没有它的政体的：现在的名字）
export function derivedCountryName(world: Pick<World, 'small'>, m: CountryMeta): One {
  const t = m.nameLocked ? null : titlesIn(world, m);
  return t ? titled(m.base, t.title) : { zh: m.name, ...(m.orig ? { orig: m.orig } : {}) };
}

function setName(m: CountryMeta, n: One) {
  m.name = n.zh;
  if (n.orig) m.orig = n.orig;
  else delete m.orig;
}

// 一位统治者换称号（to 是 undefined 时去掉）
function withTitle(r: RulerMeta, to: string | undefined): RulerMeta {
  if (to) return { ...r, title: to };
  const { title: _, ...rest } = r;
  return rest;
}

// 命令之后：称号会读的内容换了时，国名、统治者的称号跟着换。返回改了几个国家（国名或称号）
export function retitle(world: World, before: TitleBefore): number {
  const small = world.small;
  const metas = small.countries;
  if (!metas || !titleInputsChanged(before, small)) return 0;
  const was = { small: { content: before.content, ...(before.era ? { human: { era: before.era } } : {}) } } as unknown as Pick<World, 'small'>;
  // （政体、主流文化、等级）一样的国家称号一样：每种只算一次（最典型的取值要走一遍文化的倾向，一次几十微秒）
  const memo = new Map<string, { old: Titles; now: Titles } | null>();
  let lores: Record<string, CountryLore> | undefined;
  let count = 0;
  for (const m of Object.values(metas)) {
    const key = `${m.government}|${m.primaryCulture}|${m.tier ?? ''}`;
    let t = memo.get(key);
    if (t === undefined) {
      const old = titlesIn(was, m);
      const now = titlesIn(world, m);
      t = old && now && !(sameOne(old.title, now.title) && old.ruler?.zh === now.ruler?.zh) ? { old, now } : null;
      memo.set(key, t);
    }
    if (!t) continue;
    let touched = false;
    if (!m.nameLocked && !sameOne(t.old.title, t.now.title)) {
      const o = titled(m.base, t.old.title);
      if (m.name === o.zh && m.orig === o.orig) {
        setName(m, titled(m.base, t.now.title));
        touched = true;
      }
    }
    const from = t.old.ruler?.zh;
    const to = t.now.ruler?.zh;
    if (from !== to) {
      const lore = (lores ?? small.archive?.countries)?.[m.id];
      if (lore?.rulers.some((r) => !r.titleLocked && r.title === from)) {
        lores ??= { ...small.archive!.countries };
        lores[m.id] = { ...lore, rulers: lore.rulers.map((r) => (!r.titleLocked && r.title === from ? withTitle(r, to) : r)) };
        touched = true;
      }
    }
    if (touched) count++;
  }
  if (lores) small.archive = { ...small.archive!, countries: lores };
  return count + retitleBlocs(world, worldEra(was.small), worldEra(small));
}

const sameName = (x: { name: string; orig?: string }, n: One) => x.name === n.zh && x.orig === n.orig;

// 时代的“集团的称号”换了：集团的名字、联邦成员邦的名字跟着换。返回改了几个。
// 集团的名字 = 某个成员（多半是盟主）的地名 + 称号：找到名字正是按改之前的称号起的那个成员，地名不换，只换称号
function retitleBlocs(world: World, was: Era | undefined, now: Era | undefined): number {
  const blocs = world.small.blocs;
  if (!blocs?.length || was === now || JSON.stringify(was?.relations ?? null) === JSON.stringify(now?.relations ?? null)) return 0;
  const metas = world.small.countries ?? {};
  let count = 0;
  for (const b of blocs) {
    const r = titleRand(b.id);
    const old = one(titleFor(was, b.kind, r));
    const next = one(titleFor(now, b.kind, r));
    if (!b.nameLocked && !sameOne(old, next)) {
      const from = [b.leader, ...b.members.filter((x) => x !== b.leader)].find((id) => metas[id] && sameName(b, titled(baseOf(metas[id]), old)));
      if (from !== undefined) {
        const n = titled(baseOf(metas[from]), next);
        b.name = n.zh;
        if (n.orig) b.orig = n.orig;
        else delete b.orig;
        count++;
      }
    }
    if (b.kind !== 'federation') continue;
    // 成员邦：名字 = 自己的地名 + 成员的称号（federate.ts；生成时就锁着名字，所以不看 nameLocked，只看是不是还叫那个名字）
    const mOld = one(titleFor(was, 'member', r));
    const mNext = one(titleFor(now, 'member', r));
    if (sameOne(mOld, mNext)) continue;
    for (const id of b.members) {
      const m = metas[id];
      if (!m || !sameName(m, titled(baseOf(m), mOld))) continue;
      setName(m, titled(baseOf(m), mNext));
      count++;
    }
  }
  return count;
}

// 给一个国家换了政体、主流文化之后（set_country）：在位的统治者（名单的最后一位）没手改过称号、称号正是换之前政体给的那个词时，
// 换成现在的；以前的统治者不动（他们在位时就是那个称号）。was 是换之前 rulerTitleOf 给的
export function followRuler(world: World, m: CountryMeta, was: string | undefined) {
  const now = rulerTitleOf(world, m);
  if (now === was) return;
  const lore = loreOf(world.small, m.id);
  const k = lore.rulers.length - 1;
  const r = lore.rulers[k];
  if (!r || r.titleLocked || r.title !== was) return;
  const rulers = [...lore.rulers];
  rulers[k] = withTitle(r, now);
  putLore(world, m.id, { ...lore, rulers });
}
