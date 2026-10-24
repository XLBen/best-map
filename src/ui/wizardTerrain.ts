import type { Command } from '../../core/commands';
import { type WorldgenInput, resolvedParams, worldgenSchema } from '../../core/generate';
import { resolvedPlanetParams } from '../../core/planet-gen';
import { planetSchema } from '../../core/world';

// 新建向导里的“地形”（第十四轮：从“调整整个世界”挪过来）：陆地多少、岛多少、山多高、海岸曲折、最高的山。
// 只记动过的几项；一项都没动时建出来的世界与以前逐字节相同（命令里不多写任何东西）

export type TerrainKey = 'landFraction' | 'islands' | 'mountains' | 'coast' | 'mountainScale';
export type WizardTerrain = Partial<Record<TerrainKey, number>>;

export interface TerrainSlider {
  key: TerrainKey;
  label: string;
  hint: string;
  range: [number, number];
  step: number;
  scale?: 'log' | 'linear';
  format: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const level = (v: number, words: [string, string, string, string]) => (v < 0.25 ? words[0] : v < 0.5 ? words[1] : v < 0.8 ? words[2] : words[3]);

export const TERRAIN_SLIDERS: TerrainSlider[] = [
  { key: 'landFraction', label: '陆地多少', hint: '升降海平面', range: [0.03, 0.7], step: 0.01, format: pct },
  { key: 'islands', label: '岛多少', hint: '增减小岛，不动大陆的海岸', range: [0, 1], step: 0.01, format: (v) => level(v, ['很少', '较少', '较多', '很多']) },
  { key: 'mountains', label: '山多高', hint: '整体缩放造山带', range: [0, 2], step: 0.01, format: pct },
  {
    key: 'coast',
    label: '海岸曲折',
    hint: '越破碎，半岛、小岛越多',
    range: [0.2, 2],
    step: 0.05,
    format: (v) => `${v < 0.6 ? '平滑' : v < 1.4 ? '自然' : '破碎'}（${v.toFixed(2)}）`,
  },
  { key: 'mountainScale', label: '最高的山', hint: '整体缩放山的高度', range: [1000, 12000], step: 100, format: (v) => `约 ${Math.round(v / 100) * 100} m` },
];

const PLANET_DEFAULTS = planetSchema.parse({});
// 世界刚建好时海岸曲折是 1（core/world.ts 的空白世界）
const COAST_DEFAULT = 1;

// 这种世界（生成参数 gen）不动滑块时各项是多少：陆地多少、岛多少按世界类型（整个星球按星球的，带形态时按形态的）
export function terrainDefaults(gen: WorldgenInput, globe: boolean): Record<TerrainKey, number> {
  const p = worldgenSchema.parse(gen);
  const r = (globe ? resolvedPlanetParams : resolvedParams)(p);
  return { landFraction: r.landFraction, islands: r.islands, mountains: p.mountains, coast: COAST_DEFAULT, mountainScale: PLANET_DEFAULTS.mountainScale };
}

// 生成参数带上动过的陆地多少、岛多少、山多高（缩略图也按它画）
export function withTerrain(gen: WorldgenInput, t: WizardTerrain): WorldgenInput {
  const out: WorldgenInput = { ...gen };
  if (t.landFraction !== undefined) out.landFraction = t.landFraction;
  if (t.islands !== undefined) out.islands = t.islands;
  if (t.mountains !== undefined) out.mountains = t.mountains;
  return out;
}

// 海岸曲折、最高的山：在生成之前先设好（放在同一步里，生成只算一遍）
export function terrainCommands(t: WizardTerrain): Command[] {
  const out: Command[] = [];
  if (t.coast !== undefined && t.coast !== COAST_DEFAULT) out.push({ op: 'set_coast_style', roughness: t.coast });
  if (t.mountainScale !== undefined && t.mountainScale !== PLANET_DEFAULTS.mountainScale) out.push({ op: 'set_planet', patch: { mountainScale: t.mountainScale } });
  return out;
}
