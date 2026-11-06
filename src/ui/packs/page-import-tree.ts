import { type Arrange, type ArrangeRelation, type ItemsOf, type LinkTable, RELATIONS, arrangeOf, childrenOf, linkTable, looseItems, relationOf } from '../../../core/content/arrange';
import { DIMENSION } from '../../../core/content/link-rules';
import { type ContentRef, linkKey } from '../../../core/content/links';
import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import { type PackNode, canApply, packItems, packSections } from '../../../core/packs';
import type { ImportGate, ImportGates, ImportNeed, ImportPreview, ImportRow, ImportTarget } from '../../../core/packs/closure';
import { infoOf } from '../../../core/packs/import-gates';
import { HOME_LAYOUT, WATER_KINDS } from './page-layout';
import { kindTitle } from './page-source';

// 导入窗口要画的（第六十五轮）。左边：每一段是首页的一张卡片，段里按这个库的安排（arrange）排成树，和面板上看到的结构一样；
// 一行是什么状态、灰字写什么。右边：preview.list 分小标题、取值挂到变量下面。都是算出来的，组件（ImportList、ImportBasket）只画

export const refKey = (r: ContentRef): string => linkKey(r.kind, r.id);

// ---------- 左边：树 ----------

export interface PickRow {
  kind: string;
  id: string;
  name: string;
  color?: string;
  hint?: string;
  item?: unknown;
  // 下面的（政体的派系、组里的文化）。一项有几个上级时每处一行，勾的是同一项
  children: PickRow[];
  // 搜索：下面有搜到的，这一行展开
  opened?: boolean;
}

export interface PickSection {
  // 这一段的键：种类的 id，变量是 dim:变量
  key: string;
  kind: string;
  title: string;
  // 变量的一段：整段勾就是勾这个变量（带全部取值）
  head?: ContentRef;
  rows: PickRow[];
  // 段里的每一项（不重复；树里下面的也算，不算 head）
  refs: ContentRef[];
}

// 按首页的先后：时代规则、人文、政治、城市与地标、地理、外观
function layoutCards(): string[] {
  const out = ['era'];
  for (const s of HOME_LAYOUT) {
    for (const c of s.cards) {
      if (c === 'water') out.push(...WATER_KINDS);
      else out.push(c);
    }
  }
  return out;
}

const sectionMemo = new WeakMap<object, Map<string, PickSection[]>>();

function buildSections(source: PackNode, target: ImportTarget): PickSection[] {
  const info = infoOf(source);
  const arrange: Arrange = arrangeOf(source as { arrange?: Arrange });
  const usable = (k: ContentKind | undefined): k is ContentKind => !!k && (target.t !== 'world' || canApply(k));
  const items: ItemsOf = (id) => {
    const k = kindOf(id);
    return k ? packItems(source, k.pack.key) : [];
  };
  const tables = new Map<ArrangeRelation, LinkTable>();
  const table = (r: ArrangeRelation): LinkTable => {
    let t = tables.get(r);
    if (!t) tables.set(r, (t = linkTable(r, items)));
    return t;
  };

  const dimRow = (id: string, label: string): PickRow => {
    const n = info.dims.get(id)?.values.length ?? 0;
    return { kind: DIMENSION, id, name: label, children: [], ...(n ? { hint: `${n} 种取值` } : {}) };
  };
  const leaf = (k: ContentKind, x: unknown): PickRow => {
    const c = (x as { color?: unknown }).color;
    return { kind: k.id, id: itemId(k, x), name: itemName(k, x), item: x, children: [], ...(typeof c === 'string' && c.startsWith('#') ? { color: c } : {}) };
  };
  // 融入表只有一层（时代 ▸ 变量的取值写在变量那一段），所以下面的都是叶子
  const rowOf = (k: ContentKind, x: unknown): PickRow => {
    const children = childrenOf(arrange, k.id, x, items, table).flatMap(({ relation, items: kids }) => {
      if (relation.child === 'variables') return kids.map((d) => dimRow(String((d as { id: unknown }).id), String((d as { label: unknown }).label)));
      const ck = kindOf(relation.child);
      return usable(ck) ? kids.map((y) => leaf(ck, y)) : [];
    });
    return { ...leaf(k, x), children };
  };
  // 不属于任何上级的散项：列在上级后面（looseCard 的地标还有自己的一段）
  const looseOf = (parent: string): PickRow[] =>
    RELATIONS.filter((r) => r.parent === parent && arrange[r.child] === parent && !r.looseCard && r.child !== 'variables' && r.child !== 'popValue').flatMap((r) => {
      const ck = kindOf(r.child);
      return usable(ck) ? looseItems(r, items, table(r)).map((y) => leaf(ck, y)) : [];
    });

  const finish = (s: Omit<PickSection, 'refs'>): PickSection[] => {
    if (!s.rows.length) return [];
    const seen = new Map<string, ContentRef>();
    const walk = (list: readonly PickRow[]) => {
      for (const r of list) {
        const ref = { kind: r.kind, id: r.id };
        if (!seen.has(refKey(ref))) seen.set(refKey(ref), ref);
        walk(r.children);
      }
    };
    walk(s.rows);
    return [{ ...s, refs: [...seen.values()] }];
  };

  const kindSection = (id: string): PickSection[] => {
    const k = kindOf(id);
    if (!usable(k)) return [];
    const parent = arrange[id];
    const rel = parent ? relationOf(id, parent) : undefined;
    let list: readonly unknown[] = items(id);
    if (rel) {
      if (!rel.looseCard) return [];
      list = looseItems(rel, items, table(rel));
    }
    return finish({ key: id, kind: id, title: kindTitle(k), rows: [...list.map((x) => rowOf(k, x)), ...looseOf(id)] });
  };

  // 每个变量一段：取值融入取值组时是组（下面取值）和不在组里的取值
  const dimSections = (): PickSection[] => {
    const vk = kindOf('popValue');
    const gk = kindOf('valueGroup');
    if (!usable(vk) || !usable(gk)) return [];
    const merged = arrange.popValue === 'valueGroup' ? relationOf('popValue', 'valueGroup') : undefined;
    const loose = merged ? looseItems(merged, items, table(merged)) : items('popValue');
    return [...info.dims].flatMap(([id, d]) => {
      const inDim = (x: unknown) => (x as { dimension?: string }).dimension === id;
      const rows = [...(merged ? items('valueGroup').filter(inDim).map((g) => rowOf(gk, g)) : []), ...loose.filter(inDim).map((v) => leaf(vk, v))];
      const named = d.owners.length > 0;
      return finish({ key: `dim:${id}`, kind: DIMENSION, title: named ? d.label : kindTitle(vk), rows, ...(named && d.values.length ? { head: { kind: DIMENSION, id } } : {}) });
    });
  };

  const seen = new Set<string>();
  const out: PickSection[] = [];
  for (const card of layoutCards()) {
    if (card === 'dims') {
      seen.add('popValue');
      out.push(...dimSections());
    } else if (card === 'variables') {
      if (arrange.variables === 'era' && items('era').length) continue;
      const rows = [...info.dims].filter(([, d]) => d.owners.length > 0).map(([id, d]) => dimRow(id, d.label));
      out.push(...finish({ key: 'variables', kind: 'variables', title: '变量', rows }));
    } else {
      seen.add(card);
      // 取值融入取值组时组列在变量的一段里
      if (card === 'valueGroup' && arrange.popValue === 'valueGroup') continue;
      out.push(...kindSection(card));
    }
  }
  // 首页没写到的种类排在最后
  for (const k of packSections()) if (!seen.has(k.id)) out.push(...kindSection(k.id));
  return out;
}

// 同一个来源、同一类目的地（世界里放不进去的种类不列）只排一遍
export function pickSections(source: PackNode, target: ImportTarget): PickSection[] {
  let m = sectionMemo.get(source);
  if (!m) sectionMemo.set(source, (m = new Map()));
  let out = m.get(target.t);
  if (!out) m.set(target.t, (out = buildSections(source, target)));
  return out;
}

export function matchRow(r: PickRow, q: string): boolean {
  return r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q);
}

// 搜索：这一行搜到了留着；下面搜到的只留搜到的，并且展开
export function filterRows(rows: readonly PickRow[], q: string): PickRow[] {
  if (!q) return rows as PickRow[];
  return rows.flatMap((r) => {
    const kids = r.children.filter((c) => matchRow(c, q));
    if (kids.length) return [{ ...r, children: kids, opened: true }];
    return matchRow(r, q) ? [r] : [];
  });
}

// 一开始展开哪里：勾好的项所在的段，它在树里时连上级一起
export function initialOpen(sections: readonly PickSection[], picks: readonly ContentRef[]): { sections: Set<string>; rows: Set<string> } {
  const want = new Set(picks.map(refKey));
  const out = { sections: new Set<string>(), rows: new Set<string>() };
  if (!want.size) return out;
  for (const s of sections) {
    if (s.head && want.has(refKey(s.head))) out.sections.add(s.key);
    for (const r of s.refs) if (want.has(refKey(r))) out.sections.add(s.key);
    if (!out.sections.has(s.key)) continue;
    for (const r of s.rows) if (r.children.some((c) => want.has(refKey(c)))) out.rows.add(rowPath(s.key, r));
  }
  return out;
}

// 树里一行的路径（一项有几个上级时每处一行，展开各管各的）
export const rowPath = (up: string, r: Pick<PickRow, 'kind' | 'id'>): string => `${up}/${refKey(r)}`;

// ---------- 左边：一行的状态 ----------

// on 勾了；child 作为子项勾上的（可以单独去掉）；follow 跟着来的（半勾，写为什么）；have 已经有了（✓）；grey 灰的（写原因）；off 没勾
export type RowMark = 'on' | 'child' | 'follow' | 'have' | 'grey' | 'off';

export interface RowLook {
  mark: RowMark;
  // 在勾选里（灰了的还能取消）
  picked: boolean;
  // 灰字
  note: string | null;
  // 灰的：点它能把要的一起勾上（第六十六轮，pick-store.ts 的 pickWithNeeds）；choices 不止一个时让用户选（几选一）
  resolvable?: boolean;
  choices?: ImportNeed[];
}

export interface LookCtx {
  picks: ReadonlySet<string>;
  planned: ReadonlyMap<string, ImportRow>;
  gates: ImportGates;
  // “本世界”“我的库”：有一份不同的时写
  here: string;
}

const fixNote = (g: ImportGate | undefined): string => (g?.t === 'fixable' && g.restores.length ? `补回${g.restores.join('、')}` : '勾上才参与生成');
const differsNote = (here: string) => `${here}有一份不同的，添加后并存`;

// “直隶人 要它”“封建君主制 里的”：写在界面上不要空格，几处要它时合起来
export function whyText(because: readonly string[]): string {
  const needs = because.flatMap((b) => (b.endsWith(' 要它') ? [b.slice(0, -3)] : []));
  if (needs.length && needs.length === because.length) return `${needs.slice(0, 2).join('、')}${needs.length > 2 ? ` 等 ${needs.length} 项` : ''}要它`;
  return (because[0] ?? '').replace(/ (要它|里的)$/, '$1');
}

export function rowLook(r: ContentRef, c: LookCtx): RowLook {
  const key = refKey(r);
  const picked = c.picks.has(key);
  const gate = c.gates.of(r);
  const row = c.planned.get(key);
  if (row) {
    const state = row.state === 'rename' ? differsNote(c.here) : row.state === 'fix' ? fixNote(gate) : null;
    if (row.role === 'pick') return { mark: 'on', picked, note: state };
    if (row.role === 'child') return { mark: 'child', picked, note: state };
    // 跟着来的补回只有比重（勾的文化带来的组，第六十六轮）：写谁要它
    return { mark: 'follow', picked, note: row.state === 'rename' ? state : whyText(row.because) };
  }
  switch (gate.t) {
    case 'gated':
      return { mark: 'grey', picked, note: gate.reason, resolvable: gate.resolvable, ...(gate.any ? { choices: gate.choices } : {}) };
    case 'full':
      return { mark: 'grey', picked, note: gate.reason, resolvable: false };
    case 'have':
      return { mark: 'have', picked, note: null };
    case 'fixable':
      return { mark: picked ? 'on' : 'off', picked, note: fixNote(gate) };
    default:
      return { mark: picked ? 'on' : 'off', picked, note: gate.differs ? differsNote(c.here) : null };
  }
}

const canPick = (g: ImportGate): boolean => g.t === 'free' || g.t === 'fixable';

// 这一段整段勾的时候勾哪些：能选的行（下面的跟着来）；已经有了的行看它下面的；灰的行不看
function actsOf(rows: readonly PickRow[], gates: ImportGates): ContentRef[] {
  return rows.flatMap((r) => {
    const g = gates.of(r);
    if (canPick(g)) return [{ kind: r.kind, id: r.id }];
    return g.t === 'have' ? actsOf(r.children, gates) : [];
  });
}

export interface SectionLook {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  // 段里将导入几项
  count: number;
  total: number;
  note: string | null;
  // 整段勾时勾哪些
  acts: ContentRef[];
}

export function sectionLook(s: PickSection, c: LookCtx): SectionLook {
  const count = s.refs.filter((r) => c.planned.has(refKey(r))).length;
  const total = s.refs.length;
  const head = s.head && rowLook(s.head, c);
  if (s.head && head && head.mark !== 'have') {
    const rest = s.refs.some((r) => !c.planned.has(refKey(r)) && canPick(c.gates.of(r)));
    const full = head.mark === 'on' || head.mark === 'child';
    return { checked: full && !rest, mixed: (full && rest) || (!full && count > 0), disabled: head.mark === 'grey' && !head.picked, count, total, note: head.mark === 'grey' ? head.note : null, acts: [s.head] };
  }
  const acts = actsOf(s.rows, c.gates);
  const all = count > 0 && acts.every((r) => c.planned.has(refKey(r)));
  return { checked: all, mixed: count > 0 && !all, disabled: !count && !acts.length, count, total, note: null, acts };
}

// ---------- 右边：清单 ----------

export interface BasketNode {
  row: ImportRow;
  children: BasketNode[];
}
export interface BasketGroup {
  title: string;
  nodes: BasketNode[];
}

const dimOfRow = (source: PackNode, r: Pick<ImportRow, 'kind' | 'id'>): string | undefined => (infoOf(source).table.nodes.get(refKey(r))?.item as { dimension?: string } | undefined)?.dimension;

// 按种类分小标题。取值、取值组：变量也在清单里时挂到变量下面（“└ 15 种取值”），变量已经有了时小标题写变量的名字
export function basketGroups(p: ImportPreview, source: PackNode): BasketGroup[] {
  const nodeOf = (r: ImportRow): BasketNode => ({ row: r, children: r.children.map(nodeOf) });
  const roots = p.list.map(nodeOf);
  const dims = new Map<string, BasketNode>();
  const walk = (list: readonly BasketNode[]) => {
    for (const n of list) {
      if (n.row.kind === DIMENSION) dims.set(n.row.id, n);
      walk(n.children);
    }
  };
  walk(roots);
  const groups = new Map<string, BasketGroup>();
  for (const n of roots) {
    let title = n.row.kindLabel;
    if (n.row.kind === 'popValue' || n.row.kind === 'valueGroup') {
      const dim = dimOfRow(source, n.row);
      const up = dim === undefined ? undefined : dims.get(dim);
      if (up) {
        up.children.push(n);
        continue;
      }
      const d = dim === undefined ? undefined : infoOf(source).dims.get(dim);
      if (d?.owners.length) title = d.label;
    }
    let g = groups.get(title);
    if (!g) groups.set(title, (g = { title, nodes: [] }));
    g.nodes.push(n);
  }
  return [...groups.values()];
}

// 收起时写什么：“15 种取值、3 个组”“28 个文化、1 个地名风格”
export function foldText(children: readonly BasketNode[]): string {
  const counts = new Map<string, number>();
  for (const c of children) {
    const label = c.row.kind === 'popValue' ? '种取值' : c.row.kind === 'valueGroup' ? '个组' : `个${c.row.kindLabel}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} ${label}`).join('、');
}

// 新加的变量里只有一种取值：写明，所有人都是它
export function soleValue(p: ImportPreview, source: PackNode, r: ImportRow): string | null {
  if (r.kind !== DIMENSION || r.count !== 1) return null;
  return p.rows.find((x) => x.kind === 'popValue' && dimOfRow(source, x) === r.id)?.name ?? null;
}

export const soleText = (value: string): string => `里面只有${value}，所有人都是它`;

// 跟着来的文化组比重写 0：写一句。勾的文化带来的组不写 0（第六十六轮），所以只有别的引用带来的组才算
export function hasZeroWeightGroup(p: ImportPreview): boolean {
  const k = kindOf('cultureGroup');
  const finals = (k && (p.plan.finals.get(k) as { id: string; weight?: number }[] | undefined)) ?? [];
  return p.rows.some((r) => r.kind === 'cultureGroup' && r.role === 'follow' && finals.some((g) => g.id === r.id && g.weight === 0));
}
