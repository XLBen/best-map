import { DIMENSION } from '../../../core/content/link-rules';
import { type ContentRef, linkKey } from '../../../core/content/links';
import { kindOf } from '../../../core/content/registry';
import type { PackNode } from '../../../core/packs';
import type { ImportGate, ImportGates, ImportNeed, ImportPreview, ImportRow } from '../../../core/packs/closure';
import { infoOf } from '../../../core/packs/import-gates';
import { bringsNote, bringsOf, haveNote } from './pick-help';

// 资源库面板上勾选的样子（第六十五轮写给导入窗口，第六十七轮窗口并进面板）：每一行是什么状态、灰字写什么（列表、融入的子项、
// 一项的页面顶上都用 rowLook）；列表头的“全选”勾哪些；右栏的清单按种类分小标题、取值挂到变量下面。都是算出来的，组件只画

export const refKey = (r: ContentRef): string => linkKey(r.kind, r.id);

// ---------- 一行的状态 ----------

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
    // 第九十二轮：勾着的一行写它连带了几样（pick-help.ts）
    if (row.role === 'pick') {
      const n = state ? 0 : (bringsOf(c.planned.values(), c.planned).get(row.name) ?? 0);
      return { mark: 'on', picked, note: n ? bringsNote(n) : state };
    }
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
      // 第九十二轮：不能勾的每一行都写明为什么
      return { mark: 'have', picked, note: haveNote(c.here) };
    case 'fixable':
      return { mark: picked ? 'on' : 'off', picked, note: fixNote(gate) };
    default:
      return { mark: picked ? 'on' : 'off', picked, note: gate.differs ? differsNote(c.here) : null };
  }
}

const canTake = (g: ImportGate): boolean => g.t === 'free' || g.t === 'fixable';

export interface AllLook {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  // 这一页将添加几项
  count: number;
  // 勾“全选”时勾哪些（灰的、已经有了的跳过）
  acts: ContentRef[];
  // 取消“全选”时取消哪些
  clears: ContentRef[];
}

// 列表头的“全选”（第六十七轮）：refs 是这一页的行。head：一个变量的取值页上是这个变量（勾它就是勾全部取值，同第六十五轮的整段勾）
export function allLook(refs: readonly ContentRef[], c: LookCtx, head?: ContentRef): AllLook {
  const count = refs.filter((r) => c.planned.has(refKey(r))).length;
  const clears = head ? [head, ...refs] : [...refs];
  const h = head && rowLook(head, c);
  if (head && h && h.mark !== 'have') {
    const rest = refs.some((r) => !c.planned.has(refKey(r)) && canTake(c.gates.of(r)));
    const full = h.mark === 'on' || h.mark === 'child';
    return { checked: full && !rest, mixed: (full && rest) || (!full && count > 0), disabled: h.mark === 'grey' && !h.picked, count, acts: [head], clears };
  }
  const acts = refs.filter((r) => canTake(c.gates.of(r)));
  const all = count > 0 && acts.every((r) => c.planned.has(refKey(r)));
  return { checked: all, mixed: count > 0 && !all, disabled: !count && !acts.length, count, acts, clears };
}

// ---------- 清单（右栏底部） ----------

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
