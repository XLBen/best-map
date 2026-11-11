import { signal } from '@preact/signals';
import { DIMENSION } from '../../../core/content/link-rules';
import type { ContentRef } from '../../../core/content/links';
import { canApply } from '../../../core/packs';
import { kindOf } from '../../../core/content/registry';
import type { ImportAsk, ImportNeed, ImportPreview } from '../../../core/packs/closure';
import { infoOf } from '../../../core/packs/import-gates';
import { ECOLOGY_KINDS } from './page-layout';
import type { Card, PageCtx, SourceRef } from './pages';
import { type LookCtx, type RowLook, refKey, rowLook } from './pick-look';
import { type PickDest, type PickState, destFor, pickAsk, pickNeedsIn, pickPreview, pickStore, picksOf, removePickIn, togglePickIn } from './pick-store';

// 看库就是添加（第六十七轮）：资源库面板上一个库的勾选怎么画、点了做什么。状态在 pick-store.ts（按库记），
// 每行的样子在 pick-look.ts（rowLook）。组件（PickBox、PageList、PageChildren、PageItem、PageHome、LibBasket）只画

export interface PickView {
  key: string;
  dest: PickDest;
  ask: ImportAsk;
  // 清单（because 写好“为了 X 加的”）
  preview: ImportPreview;
  look: LookCtx;
  state: PickState;
}

// 第八十一轮：从别的库挑是一种模式（资源库面板顶上“从别的库添加…”进，“完成”出，panel-store.ts 记着）。
// 不在这个模式时库里不画勾、不出清单：组件用 shownPick，不直接用 pickView
export const pickMode = signal(false);
export const shownPick = (src: SourceRef, ctx: PageCtx): PickView | null => (pickMode.value ? pickView(src, ctx) : null);

// 同一个库、同一份勾选、同一个世界和资源库只算一遍（列表上每一行都要问）
const memo = new Map<string, { store: unknown; world: unknown; lib: unknown; view: PickView | null }>();

// 这个库现在的勾选（不能勾的来源：本世界、没地方加的：null）
export function pickView(src: SourceRef, ctx: PageCtx): PickView | null {
  if (src.t !== 'lib') return null;
  const store = pickStore.value;
  const hit = memo.get(src.key);
  if (hit && hit.store === store && hit.world === ctx.world && hit.lib === ctx.lib) return hit.view;
  const dest = destFor(src.key, ctx);
  const ask = dest && pickAsk(src.key, ctx, dest);
  const preview = dest && pickPreview(src.key, ctx, dest);
  const state = picksOf(src.key);
  const view: PickView | null =
    dest && ask && preview
      ? { key: src.key, dest, ask, preview, state, look: { picks: new Set(state.picks.map(refKey)), planned: new Map(preview.rows.map((r) => [refKey(r), r])), gates: preview.gates, here: dest === 'world' ? '这张地图' : '这个库' } }
      : null;
  memo.set(src.key, { store, world: ctx.world, lib: ctx.lib, view });
  return view;
}

// 这一种内容在这里能不能勾：加到世界时世界里放不进的种类（星球形态）不能
export const kindPickable = (v: PickView, kindId: string): boolean => {
  if (kindId === DIMENSION) return true;
  const k = kindOf(kindId);
  return !!k && (v.dest !== 'world' || canApply(k));
};

export const lookOf = (v: PickView, r: ContentRef): RowLook => rowLook(r, v.look);

// ---------- 点一行的勾 ----------

// 点了做什么：勾的、灰了还勾着的取消；子项去掉（× 一样）；没勾的、跟着来的勾上（跟着来的勾上是勾整项）；
// 灰的能解时把要的一起勾上（几个里选一个时 choices 给界面弹小菜单）；已经有了的、不能解的灰行不能点
export type Press = { t: 'on' } | { t: 'off' } | { t: 'remove' } | { t: 'needs'; choices: ImportNeed[] } | { t: 'none' };
export function pressOf(look: RowLook): Press {
  if (look.mark === 'on' || (look.mark === 'grey' && look.picked)) return { t: 'off' };
  if (look.mark === 'child') return { t: 'remove' };
  if (look.mark === 'follow' || look.mark === 'off') return { t: 'on' };
  if (look.mark === 'grey' && look.resolvable) return { t: 'needs', choices: look.choices && look.choices.length > 1 ? look.choices : [] };
  return { t: 'none' };
}

// 点一行：做了 true。几选一没选（choice 没给）时 false，界面弹菜单
export function pressRow(key: string, r: ContentRef, look: RowLook, ctx: PageCtx, choice?: ContentRef): boolean {
  const p = pressOf(look);
  switch (p.t) {
    case 'on':
      togglePickIn(key, r, true, ctx);
      return true;
    case 'off':
      togglePickIn(key, r, false, ctx);
      return true;
    case 'remove':
      removePickIn(key, r, ctx);
      return true;
    case 'needs':
      if (p.choices.length && !choice) return false;
      return pickNeedsIn(key, r, ctx, choice);
    default:
      return false;
  }
}

// 勾选框画成什么：勾着、半勾（跟着来的）、能不能点
export function boxOf(look: RowLook): { checked: boolean; mixed: boolean; disabled: boolean } {
  const p = pressOf(look);
  return { checked: look.mark === 'on' || look.mark === 'child' || look.picked, mixed: look.mark === 'follow', disabled: p.t === 'none' };
}

// ---------- 首页卡片上的“已勾 N” ----------

// 卡片管哪几种内容：它自己、融入它的（“含派系”），生态与水系是那几种，时代规则含变量
const KID_KIND: Record<string, string> = { variables: DIMENSION };
export function cardPicks(card: Pick<Card, 'id' | 'kids'>, v: PickView | null): number {
  if (!v || !v.state.picks.length) return 0;
  const picks = v.state.picks;
  if (card.id.startsWith('dim:')) {
    const dim = card.id.slice(4);
    const nodes = infoOf(v.ask.source).table.nodes;
    return picks.filter((r) => (r.kind === DIMENSION ? r.id === dim : (r.kind === 'popValue' || r.kind === 'valueGroup') && (nodes.get(refKey(r))?.item as { dimension?: string } | undefined)?.dimension === dim)).length;
  }
  const kinds = new Set(card.id === 'ecology' ? ECOLOGY_KINDS : [card.id, ...(card.kids ?? []).map((k) => KID_KIND[k.key] ?? k.key)]);
  return picks.filter((r) => kinds.has(r.kind)).length;
}
