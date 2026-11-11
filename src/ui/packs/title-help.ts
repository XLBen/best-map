import type { Command } from '../../../core/commands';
import { enableCommand, kindOf } from '../../../core/content/registry';
import { currentRuler, titled } from '../../../core/human';
import { packItems } from '../../../core/packs';
import type { World } from '../../../core/world';
import { type Obj, type TitleRow, isObj, titleRows } from './fields';
import type { PageCtx, SourceRef } from './page-source';
import { refLabel, refOptionsOf } from './refs';

// 称号编辑器旁边帮新手看懂的三样（第九十一轮）。不碰界面，测试直接调：
//   示例：这一行的称号写出来是什么国名（本世界里用地图上真的国家的词根，库里用固定的例子）、统治者怎么称呼；
//   谁盖过它：政体默认的称号表里，哪几条换说法满足时用的是别的词（有换说法满足时默认的这一行用不上）；
//   把一个词换成另一个：这个库（本世界）各政体的称号、统治者称号、换说法里整个就是这个词的地方一次改完（先数有几处）。
// 国名怎么拼和引擎是同一个函数（core/human/government.ts 的 titled）

export type TitleField = 'titles' | 'rulers';

// ---------- 示例 ----------

// 库里看时、地图上没有国家时用的
export const SAMPLE_BASE = { zh: '青岚', orig: 'Qinglan' } as const;
export const SAMPLE_RULER = '安澜';

export interface TitleWords {
  base: { zh: string; orig?: string };
  ruler: string;
}

// 示例用哪个国家的词根：本世界里先找用这个政体、又是这一级的国家，再找用这个政体的，再是随便一个国家（没改过名字的优先）；
// 都没有、看的是库时用固定的例子
export function sampleWords(w: World | null, govId: string | undefined, tier: string | undefined): TitleWords {
  const list = Object.values(w?.small.countries ?? {}).filter((m) => m.base?.zh);
  const free = list.filter((m) => !m.nameLocked);
  const pool = free.length ? free : list;
  const m = pool.find((x) => x.government === govId && tier !== undefined && x.tier === tier) ?? pool.find((x) => x.government === govId) ?? pool[0];
  if (!w || !m) return { base: SAMPLE_BASE, ruler: SAMPLE_RULER };
  return { base: m.base, ruler: currentRuler(w.small, m.id)?.name ?? SAMPLE_RULER };
}

// 一行称号写出来的样子：国家称号是国名（有外文写法时跟在后面），统治者称号是“称号 + 名字”。中文空着时没有示例
export function titleSample(field: TitleField, row: Pick<TitleRow, 'zh' | 'orig'>, words: TitleWords): string {
  const zh = row.zh.trim();
  if (!zh) return '';
  if (field === 'rulers') return `${zh}${words.ruler}`;
  const n = titled(words.base, row.orig.trim() ? { zh, orig: row.orig.trim() } : { zh });
  return n.orig ? `${n.zh}　${n.orig}` : n.zh;
}

// ---------- 谁盖过它 ----------

export interface TitleOverride {
  // 第几条换说法（0 起）
  rule: number;
  // 给谁换（“阿尔泰、鞑靼”“阿尔泰 且 逊尼派”；一个条件都没写时“所有国家”）
  who: string;
  // 换成什么
  zh: string;
}

const RULE_REFS: readonly (readonly [string, string])[] = [
  ['cultures', 'culture'],
  ['cultureGroups', 'cultureGroup'],
  ['values', 'popValue'],
  ['valueGroups', 'valueGroup'],
];
type LabelOf = (ref: string, id: string) => string;

// 一条换说法给谁换：几样都写了时都要满足（“且”），一样里几个是“之一”（顿号）
export function ruleWho(rule: Obj, labelOf: LabelOf): string {
  const parts = RULE_REFS.flatMap(([key, ref]) => {
    const ids = Array.isArray(rule[key]) ? (rule[key] as unknown[]).map(String) : [];
    return ids.length ? [ids.map((id) => labelOf(ref, id)).join('、')] : [];
  });
  return parts.length ? parts.join(' 且 ') : '所有国家';
}

// 政体默认的称号表里 rowKey 这一行（等级的 id，或“其余”default）会被哪几条换说法盖过：
// 换说法的表里写了这一级、或写了“其余”、或只写了一种（各级都用它）的那几条——和引擎挑称号时一样（government.ts 的 pickFor：
// 满足的换说法里第一条写了这一级的起作用，都没写才用默认的）
export function titleOverrides(gov: Obj, field: TitleField, rowKey: string, labelOf: LabelOf): TitleOverride[] {
  const rules = Array.isArray(gov.names) ? gov.names : [];
  const out: TitleOverride[] = [];
  rules.forEach((r, k) => {
    if (!isObj(r) || r[field] === undefined) return;
    const rows = titleRows(r[field]).filter((x) => x.zh.trim());
    const hit = rows.find((x) => x.key === rowKey) ?? rows.find((x) => x.key === 'default');
    if (hit) out.push({ rule: k, who: ruleWho(r, labelOf), zh: hit.zh.trim() });
  });
  return out;
}

const MAX_OVERRIDES = 3;
// 写在那一行下面的一句：“阿尔泰、鞑靼写“汗国””，多了写“等 N 条”；没有时 ''
export function overridesLine(list: readonly TitleOverride[]): string {
  if (!list.length) return '';
  const shown = list.slice(0, MAX_OVERRIDES).map((o) => `${o.who}写“${o.zh}”`);
  return `${shown.join('；')}${list.length > MAX_OVERRIDES ? ` 等 ${list.length} 条` : ''}`;
}

// 称号编辑器从上下文里拿的（PageItem 在政体的“称号”一段外面给）
export interface TitleHelp {
  // 一行的示例；rowKey 是这一行的等级（挑同一级的国家当例子）
  sample(field: TitleField, row: TitleRow): string;
  // 政体默认的那两张表里一行下面的一句（换说法里的表不写）
  overrides(field: TitleField, rowKey: string): string;
}

export function titleHelpOf(gov: Obj, src: SourceRef, ctx: PageCtx): TitleHelp {
  const w = src.t === 'world' ? (ctx.world as World | null) : null;
  const id = typeof gov.id === 'string' ? gov.id : undefined;
  const labelOf: LabelOf = (ref, rid) => refLabel(refOptionsOf(ref, ctx), rid);
  const words = new Map<string, TitleWords>();
  const wordsFor = (tier: string): TitleWords => {
    let x = words.get(tier);
    if (!x) words.set(tier, (x = sampleWords(w, id, tier === 'default' ? undefined : tier)));
    return x;
  };
  return {
    sample: (field, row) => titleSample(field, row, wordsFor(row.key)),
    overrides: (field, rowKey) => overridesLine(titleOverrides(gov, field, rowKey, labelOf)),
  };
}

// ---------- 把一个词换成另一个 ----------

type One = string | { zh: string; orig?: string };

// 一张称号表（一种写法，或 键 → 写法）里整个就是 from 的写法换成 to；返回换了几处
function replaceInTitle(t: unknown, from: string, to: string): { next: unknown; hits: number } {
  let hits = 0;
  const one = (x: unknown): unknown => {
    if (typeof x === 'string') {
      if (x.trim() !== from) return x;
      hits++;
      return to;
    }
    if (isObj(x) && typeof x.zh === 'string' && x.zh.trim() === from) {
      hits++;
      return { ...x, zh: to };
    }
    return x;
  };
  if (t === undefined || t === null) return { next: t, hits };
  if (typeof t === 'string' || (isObj(t) && 'zh' in t)) return { next: one(t as One), hits };
  if (!isObj(t)) return { next: t, hits };
  const next = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, one(v)]));
  return { next, hits };
}

// 一个政体里（称号、统治者称号、每条换说法的两张表）换；没有要换的时 null
export function replaceInGovernment(gov: Obj, from: string, to: string): { next: Obj; hits: number } | null {
  let hits = 0;
  const swap = (t: unknown) => {
    const r = replaceInTitle(t, from, to);
    hits += r.hits;
    return r.next;
  };
  const next: Obj = { ...gov };
  for (const key of ['titles', 'rulers'] as const) if (gov[key] !== undefined) next[key] = swap(gov[key]);
  if (Array.isArray(gov.names)) {
    next.names = gov.names.map((r) => {
      if (!isObj(r)) return r;
      const out: Obj = { ...r };
      for (const key of ['titles', 'rulers'] as const) if (r[key] !== undefined) out[key] = swap(r[key]);
      return out;
    });
  }
  return hits ? { next, hits } : null;
}

export interface ReplacePlan {
  from: string;
  to: string;
  // 一共几处、在几个政体里
  hits: number;
  items: { id: string; next: Obj; hits: number }[];
}

// 这一份（本世界或一个库）里的全部政体
export function governmentsIn(src: SourceRef, ctx: PageCtx): Obj[] {
  if (src.t === 'world') return ctx.world ? (kindOf('government')!.inWorld(ctx.world as World) as Obj[]) : [];
  if (src.t !== 'lib') return [];
  const pack = ctx.lib.find((e) => e.key === src.key)?.pack;
  return pack ? packItems<Obj>(pack, 'governments') : [];
}

// 会改哪些：from、to 去掉两头的空白；空的、一样的、一处都没有时 null。to 最长 16 个字（称号的格式）
export const TITLE_MAX = 16;
export function replacePlan(govs: readonly Obj[], fromText: string, toText: string): ReplacePlan | null {
  const from = fromText.trim();
  const to = toText.trim();
  if (!from || !to || from === to || to.length > TITLE_MAX) return null;
  const items: ReplacePlan['items'] = [];
  let hits = 0;
  for (const g of govs) {
    const r = replaceInGovernment(g, from, to);
    if (!r) continue;
    items.push({ id: String(g.id), next: r.next, hits: r.hits });
    hits += r.hits;
  }
  return hits ? { from, to, hits, items } : null;
}

// 这一份里有几处称号整个就是这个词
export function countWord(govs: readonly Obj[], word: string): number {
  const from = word.trim();
  if (!from) return 0;
  let n = 0;
  for (const g of govs) n += replaceInGovernment(g, from, '')?.hits ?? 0;
  return n;
}

// 写在按钮旁的一句：“会改 12 处（5 个政体）”；没有时说为什么
export function replaceNote(govs: readonly Obj[], fromText: string, toText: string): string {
  const from = fromText.trim();
  const to = toText.trim();
  if (!from) return '';
  const count = countWord(govs, from);
  if (!count) return `没有写着“${from}”的称号`;
  if (!to || to === from) return `有 ${count} 处写着“${from}”`;
  if (to.length > TITLE_MAX) return `称号最长 ${TITLE_MAX} 个字`;
  const plan = replacePlan(govs, from, to)!;
  return `会改 ${plan.hits} 处（${plan.items.length} 个政体）`;
}

export const replaceLabel = (p: Pick<ReplacePlan, 'from' | 'to' | 'hits'>): string => `称号“${p.from}”换成“${p.to}” · ${p.hits} 处`;

// 本世界：一条批量命令（一步，能撤销；执行完没手改过的国名、称号马上跟着变）
export function replaceCommand(plan: ReplacePlan, w: World): Command {
  const kind = kindOf('government')!;
  return { op: 'batch', label: replaceLabel(plan), commands: plan.items.map((x) => enableCommand(kind, x.next, w)) };
}
