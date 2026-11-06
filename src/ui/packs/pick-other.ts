import type { ArrangeRelation } from '../../../core/content/arrange';
import type { ContentRef } from '../../../core/content/links';
import { itemId, itemName, kindOf } from '../../../core/content/registry';
import type { PopValue } from '../../../core/human/era';
import { packItems } from '../../../core/packs';
import { type ImportGates, type ImportPreview, type ImportTarget, importGates } from '../../../core/packs/closure';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import { showToast } from '../../state';
import { ADD_DIMENSION_NOTE } from '../copy';
import { type PageCtx, type SourceRef, entryOf, itemsOf } from './page-source';
import { type AddDone, runAdd } from './pick-add';
import type { RefOption } from './refs';

// 从别的库加（第六十一轮写在导入窗口里，第六十七轮窗口并进资源库面板）：
//   面板右上角“从库里添加…”切到哪个库（上次用的；没有时世界用的库以外第一个内置库）
//   列表、上级页面“加派系”这类下拉里别的库的项：选了直接加（一步，能撤销），不开窗口
//   清单底下要重新生成才用得上时的一句

export interface OntoRef {
  relation: ArrangeRelation;
  parent: string;
  child: ContentRef;
}

// ---------- 从库里添加…：切到哪个库 ----------

let lastFrom: string | null = null;
// 面板上看过、勾过的库（读进来的文件不算：关掉就没了）
export const rememberFrom = (key: string) => void (lastFrom = key);

// 上次用的；没有时目的地用的库以外第一个内置的。target：加到哪里（本世界、我的库）
export function defaultFrom(target: SourceRef, ctx: PageCtx): string | null {
  const usable = ctx.lib.filter((e) => !e.file && !(target.t === 'lib' && e.key === target.key));
  if (lastFrom && usable.some((e) => e.key === lastFrom)) return lastFrom;
  const here = target.t === 'world' && ctx.world ? worldLibrary(ctx.world.small) : target.t === 'lib' ? target.key : undefined;
  return (usable.find((e) => e.builtin && e.key !== here) ?? usable.find((e) => e.key === DEFAULT_LIBRARY) ?? usable[0])?.key ?? null;
}

// ---------- 别的库里的（列表和上级页面“加”的下拉） ----------

interface Other {
  id: string;
  name: string;
  color?: string;
  lib: string;
  libName: string;
  item: unknown;
}
const otherMemo = new WeakMap<object, Map<string, Other[]>>();

function othersOf(kindId: string, ctx: PageCtx): Other[] {
  let m = otherMemo.get(ctx.lib);
  if (!m) otherMemo.set(ctx.lib, (m = new Map()));
  const hit = m.get(kindId);
  if (hit) return hit;
  const k = kindOf(kindId);
  const out: Other[] = [];
  if (k) {
    for (const e of ctx.lib) {
      for (const x of packItems(e.pack, k.pack.key)) {
        const c = (x as { color?: unknown }).color;
        out.push({ id: itemId(k, x), name: itemName(k, x), lib: e.key, libName: e.pack.name, item: x, ...(typeof c === 'string' && c.startsWith('#') ? { color: c } : {}) });
      }
    }
  }
  m.set(kindId, out);
  return out;
}

// 这一份能不能接收别的库的内容（世界、库）
function targetFor(src: SourceRef, ctx: PageCtx): ImportTarget | null {
  if (src.t === 'world') return ctx.world ? { t: 'world', world: ctx.world } : null;
  const e = entryOf(src, ctx);
  return e ? { t: 'pack', pack: e.pack } : null;
}

// 别的库里有、这一份里没有的（同一个 id 列第一个库的）。fits：这个上级下面放得下。灰的、放不下的不列（第六十五轮）
export function otherLibOptions(kindId: string, src: SourceRef, ctx: PageCtx, fits?: (item: unknown) => boolean): (RefOption & { lib: string })[] {
  const k = kindOf(kindId);
  if (!k) return [];
  const here = new Set(itemsOf(src, k, ctx).map((x) => itemId(k, x)));
  const seen = new Set<string>();
  const out: (RefOption & { lib: string })[] = [];
  const target = targetFor(src, ctx);
  const gatesOfLib = new Map<string, ImportGates>();
  const grey = (lib: string, id: string): boolean => {
    const e = ctx.lib.find((x) => x.key === lib);
    if (!target || !e) return false;
    let g = gatesOfLib.get(lib);
    if (!g) gatesOfLib.set(lib, (g = importGates(e.pack, target)));
    const t = g.of({ kind: kindId, id }).t;
    return t === 'gated' || t === 'full';
  };
  for (const o of othersOf(kindId, ctx)) {
    if (src.t === 'lib' && o.lib === src.key) continue;
    if (here.has(o.id) || seen.has(o.id) || (fits && !fits(o.item)) || grey(o.lib, o.id)) continue;
    seen.add(o.id);
    out.push({ id: o.id, label: o.name, hint: o.libName, lib: o.lib, ...(o.color ? { color: o.color } : {}) });
  }
  return out;
}

// 下拉里选了别的库的一项：直接加到这一份（本世界或我的库），一步，能撤销；onto：放到这个上级下面（同一步）
export async function addOther(src: SourceRef, from: string, pick: ContentRef, ctx: PageCtx, onto?: OntoRef): Promise<AddDone> {
  const e = ctx.lib.find((x) => x.key === from);
  const target = targetFor(src, ctx);
  if (!e || !target) return { ok: false, count: 0, error: '来源或目的地不在了' };
  const r = await runAdd({ ask: { source: e.pack, target, picks: [pick] }, target: src, ...(e.file ? {} : { path: [from] }), lead: pick, ...(onto ? { onto } : {}) }, ctx);
  if (r.error) showToast(r.error, true);
  return r;
}

// ---------- 清单底下的一句 ----------

const VALUE_NOTE = '新加的取值已有人口不变，重新生成人文才分到人';

// 这次加的取值里有没有写到已有变量的（新变量的取值 add_dimension 会分给人）
function addsToOldDim(p: ImportPreview): boolean {
  const k = kindOf('popValue');
  const adding = new Set(p.rows.filter((r) => r.kind === 'popValue').map((r) => r.id));
  if (!k || !adding.size) return false;
  const fresh = new Set(p.dims.map((d) => d.id));
  return ((p.plan.finals.get(k) ?? []) as PopValue[]).some((v) => adding.has(v.id) && !fresh.has(v.dimension));
}

// 添加后要重新生成才影响地图时写一句（没有“添加并重新生成”按钮时清单底下写它，见 LibBasket.tsx）
export function regenLine(p: ImportPreview, target: ImportTarget): string | null {
  if (target.t !== 'world') return null;
  const small = target.world.small;
  const values = !!small.human && addsToOldDim(p);
  if (p.dims.length && small.human) return values ? `${ADD_DIMENSION_NOTE}；${VALUE_NOTE}` : ADD_DIMENSION_NOTE;
  const adding = new Set(p.rows.map((r) => r.kind));
  const has = (...kinds: string[]) => kinds.some((k) => adding.has(k));
  const out: string[] = [];
  if (values) out.push(VALUE_NOTE);
  if (small.human && (has('era', 'cultureGroup', 'culture') || (has('popValue', 'valueGroup') && !values))) out.push('重新生成人文后才用上');
  else if (!out.length && has('government', 'faction', 'countryTier', 'countryLayout') && small.human?.countryRules) out.push('重新生成国家后才用上');
  if (has('cityRank', 'landmarkType', 'pointType') && small.settlementRules) out.push('重新生成城市后才放到地图上');
  return out.length ? out.join('；') : null;
}
