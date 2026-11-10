import type { Command } from '../../../core/commands';
import { itemFields } from '../../../core/content/links';
import { kindOf } from '../../../core/content/registry';
import { PACK_FORMAT, PACK_VERSION, type ResourcePack, packIdFor } from '../../../core/packs';
import {
  ALPINE_LOW,
  type ConditionId,
  HEIGHT_MAX,
  type HeightRange,
  type Rect,
  type Species,
  type Tolerance,
  advancedTolerances,
  elevationTolerances,
  freshSpecies,
  withCondition,
  withRect,
} from '../../../core/species';
import { landmassCells } from '../../../core/vegetation';
import type { World } from '../../../core/world';
import type { Patch } from './advanced';

// 生态编辑器（第七十二轮，生态抽屉和资源库的通用表单合成一个）每一处改动做出的补丁。补丁和 update_species 的一样：
// 写了的换掉，值为 null 的去掉。本世界里是 update_species（和以前的生态抽屉同一条命令），我的库里落到那一项上（applyPatch，和以前的表单一样换掉一项）。
// 补丁的算法照搬生态抽屉（测试 ecology/biome-edit.test.ts 拿以前的写法对照）

export type { Patch };

// 补丁落到一项上（库里用；和引擎执行 update_species 一样：null 去掉这个字段）
export function applyPatch(sp: Species, patch: Patch): Species {
  const next: Record<string, unknown> = { ...(sp as unknown as Record<string, unknown>), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
  return next as unknown as Species;
}

// 气候图上拖了色块
export const rectPatch = (sp: Species, r: Rect): Patch => ({ tolerances: withRect(sp, r).tolerances });

// 只长在海边、河边……的勾，雨季
export const conditionPatch = (sp: Species, id: ConditionId, on: boolean): Patch => ({ tolerances: withCondition(sp, id, on).tolerances });

// 高度范围：两头都不限时不写（和没写过一样）
export const heightPatch = (h: HeightRange): Patch => ({ height: h.low <= 0 && h.high >= HEIGHT_MAX ? null : h });

// 高度范围现在的样子（没写时两头不限）
export const heightOf = (sp: Pick<Species, 'height'>): HeightRange => sp.height ?? { low: 0, high: HEIGHT_MAX };

// “只长在高山上”：下限设到高山（上限不动）。已经是时再点一下回到不限下限
export const isAlpine = (sp: Pick<Species, 'height'>): boolean => heightOf(sp).low === ALPINE_LOW;
export function alpinePatch(sp: Pick<Species, 'height'>): Patch {
  const h = heightOf(sp);
  return heightPatch({ low: isAlpine(sp) ? 0 : ALPINE_LOW, high: Math.max(h.high, ALPINE_LOW) });
}

// “更精细的条件”里列的：矩形、命名条件以外的，海拔除外（海拔只在高度范围里设；读进来换不成高度范围的另写一行）
export const shownTolerances = (sp: Species): Tolerance[] => advancedTolerances(sp).filter((t) => t.field !== 'elevation');

// 改了“更精细的条件”：列着的几条换成 next，没列的（矩形、命名条件、海拔）照原样留在前面
export function tolerancesPatch(sp: Species, next: readonly Tolerance[]): Patch {
  const shown = shownTolerances(sp);
  return { tolerances: [...sp.tolerances.filter((t) => !shown.includes(t)), ...next] };
}

// 读进来的海拔条件换成高度范围（用户点了才换：过渡的宽窄不一样，地图会变）。已经有高度范围时只去掉海拔条件
export function elevationPatch(sp: Species): Patch | null {
  const el = elevationTolerances(sp);
  if (!el.length) return null;
  const low = Math.max(0, Math.min(HEIGHT_MAX, Math.max(...el.map((t) => t.optLow))));
  const high = Math.max(low, Math.min(HEIGHT_MAX, Math.min(...el.map((t) => t.optHigh))));
  return { tolerances: sp.tolerances.filter((t) => t.field !== 'elevation'), ...(sp.height ? {} : heightPatch({ low, high })) };
}

// 海拔条件写成一行字
export const elevationText = (t: Tolerance): string => `${Math.max(0, t.optLow)}–${Math.min(HEIGHT_MAX, t.optHigh)} m（${Math.max(0, t.min)} m 起、${Math.min(HEIGHT_MAX, t.max)} m 止）`;

// ---------- 本世界：新建、复制 ----------

const PALETTE = ['#8a6fb0', '#c0607a', '#4f9fb0', '#b08a3a', '#6aa050', '#d07a40', '#5a70c0', '#a05a9a'];

// 第九十轮：新建的生态自然生成开着（合适的地方马上长，“在地图上”那一行写长在几格；不要它自己长时关掉“自然生成”）。
// 样子和资源库列表上的“新建”一样（core/species.ts 的 freshSpecies），只差 id、名字带编号、颜色轮着取
export function newSpeciesCommand(w: Pick<World, 'small'>): { id: string; cmd: Command } {
  const all = w.small.species;
  let k = all.length + 1;
  let id = `custom_${k}`;
  while (all.some((s) => s.id === id)) id = `custom_${++k}`;
  return { id, cmd: { op: 'add_species', species: freshSpecies(id, `新生态 ${k}`, PALETTE[k % PALETTE.length]) } };
}

// 第九十轮：副本原样（以前悄悄关掉“自然生成”）：原来自然生成的，副本也自然生成，和原来的那种分地盘；原来关着的还关着
export function copySpeciesCommand(w: Pick<World, 'small'>, sp: Species): { id: string; cmd: Command } {
  let id = `${sp.id}_copy`;
  for (let k = 2; w.small.species.some((s) => s.id === id); k++) id = `${sp.id}_copy${k}`;
  return { id, cmd: { op: 'add_species', species: { ...structuredClone(sp), id, name: `${sp.name}（副本）` } } };
}

// ---------- 长在哪里 ----------

// 范围现在说的是哪里：岛的名字（那块陆地多大），圈的格数；岛沉了（那一格不是陆地了）时说一声
export function rangeText(w: World, sp: Species): string {
  const r = sp.range;
  if (!r) return '';
  if (r.kind === 'cells') return `圈的 ${r.cells.length} 格里`;
  const mass = landmassCells(w, r.cell);
  let n = 0;
  for (let i = 0; i < mass.length; i++) n += mass[i];
  if (!n) return '选的岛已不在，请重新选';
  const f = w.derived.features.find((x) => (x.type === 'island' || x.type === 'continent') && Array.prototype.includes.call(x.cells, r.cell));
  return `${f?.name ? `“${f.name}”` : '那块陆地'}上（${n} 格）`;
}

// ---------- 导出 ----------

// 一份里的全部生态导出成资源包（第七十二轮：以前是裸的生态数组）。世界里的按导出的样子（写明自然生成），带上用到的自定义场
export function biomesPack(name: string, biomes: readonly Species[], fromWorld: boolean): ResourcePack {
  const kind = kindOf('biome')!;
  const items = biomes.map((b) => (fromWorld && kind.pack.exportItem ? (kind.pack.exportItem(b) as Species) : structuredClone(b)));
  const pack: ResourcePack = { format: PACK_FORMAT, version: PACK_VERSION, id: packIdFor(name), name, biomes: items };
  const fields = [...new Set(items.flatMap((b) => itemFields(kind, b)))];
  if (fields.length) pack.fields = fields;
  return pack;
}
