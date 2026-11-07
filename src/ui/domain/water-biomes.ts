import type { Species } from '../../../core/species';
import type { WaterType } from '../../../core/water-types';

// 河湖类型的“出现在这些生态里”（第七十二轮）：只在生态编辑器和总表里改，河湖的编辑器里只写一行（旁边“去总表改”）。
// 这种水没列生态时是全部；列了时按世界（这一份）里生态的先后写前几种的名字

const SHOW = 3;

export function waterBiomesText(species: readonly Pick<Species, 'id' | 'name'>[], t: Pick<WaterType, 'biomes'>): string {
  if (!t.biomes) return '全部生态';
  const on = species.filter((s) => t.biomes!.includes(s.id));
  if (!on.length) return '没有生态';
  if (on.length === species.length) return '全部生态';
  const names = on.slice(0, SHOW).map((s) => s.name || s.id);
  return on.length > SHOW ? `${names.join('、')} 等 ${on.length} 种` : names.join('、');
}
