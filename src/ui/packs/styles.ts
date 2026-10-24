import type { Command } from '../../../core/commands';
import type { GeoFeature } from '../../../core/features';
import { overrideKeyOf } from '../../../core/features';
import { DEFAULT_STYLE, missingStyles, worldStyleId, worldStyles } from '../../../core/name-styles';
import type { World } from '../../../core/world';

// 地名风格在“地名”“省份”里的选法：世界里启用的几种、给一个地物或省份换风格、按世界默认重起省名

export interface StyleChoice {
  id: string;
  name: string;
}

// 世界里启用的风格（内置中文在前）
export function styleChoices(small: World['small']): StyleChoice[] {
  return [{ id: DEFAULT_STYLE, name: '中文·默认' }, ...Object.values(worldStyles(small)).map((s) => ({ id: s.id, name: s.name }))];
}

export const styleNameOf = (small: World['small'], id: string): string => styleChoices(small).find((c) => c.id === id)?.name ?? id;

// 世界默认的风格（名字）
export const defaultStyleName = (small: World['small']): string => styleNameOf(small, worldStyleId(small));

// 一个地物换风格：写在落到它上面的改名上（与改叫法同一处）；null 换回世界默认
export function featureStyleCommand(w: World, f: GeoFeature, style: string | null): Command {
  return { op: 'set_feature_style', key: overrideKeyOf(w, f), style };
}

// 世界默认换了以后，已有的省名不变：按世界默认重起。锁定的、自己选了风格的省不动。一整步；没有要重起的省时 null
export function restyleProvincesCommand(w: World): Command | null {
  const ids = Object.entries(w.small.provinces)
    .filter(([, p]) => !p.locked && !p.style)
    .map(([id]) => Number(id));
  if (!ids.length) return null;
  return { op: 'batch', label: `按“${defaultStyleName(w.small)}”重起省名 · ${ids.length} 个`, commands: ids.map((id): Command => ({ op: 'set_province', id, style: null })) };
}

// 用着已停用的风格的地方有几处（世界默认、地物、省份）：起名时按世界默认
export const missingCount = (small: World['small']): number => missingStyles(small).length;

// 要不要提“重起省名”：世界默认不是内置中文，或者有省名带着原文（按别的风格起的）时
export function restyleOffer(w: World): Command | null {
  const ps = Object.values(w.small.provinces).filter((p) => !p.locked && !p.style);
  if (worldStyleId(w.small) === DEFAULT_STYLE && !ps.some((p) => p.orig)) return null;
  return restyleProvincesCommand(w);
}
