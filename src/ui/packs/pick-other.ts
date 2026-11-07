import { kindOf } from '../../../core/content/registry';
import type { PopValue } from '../../../core/human/era';
import type { ImportPreview, ImportTarget } from '../../../core/packs/closure';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import { ADD_DIMENSION_NOTE } from '../copy';
import type { PageCtx, SourceRef } from './page-source';

// 从别的库加（第六十一轮写在导入窗口里，第六十七轮窗口并进资源库面板）：
//   面板右上角“从库里添加…”、列表上“从别的库加”的右栏（第六十八轮，other-view.ts）先看哪个库（上次用的；没有时世界用的库以外第一个内置库）
//   清单底下要重新生成才用得上时的一句

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
  else if (!out.length && has('government', 'faction', 'countryTier', 'countryPattern') && small.human?.countryRules) out.push('重新生成国家后才用上');
  if (has('cityRank', 'landmarkType', 'pointType') && small.settlementRules) out.push('重新生成城市后才放到地图上');
  // 第七十八轮：省份划分在“省份 ⋯”里划分省份时才用上（湖的归属马上整理）
  if (has('provinceRules') && Object.keys(small.provinces).length) out.push('在“省份 ⋯”里划分省份后才用上');
  return out.length ? out.join('；') : null;
}
