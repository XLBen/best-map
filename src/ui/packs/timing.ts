import { type ContentKind, kindOf } from '../../../core/content/registry';
import { canApply } from '../../../core/packs';
import type { ProvinceRules } from '../../../core/province-rules';
import { SCOPE_KINDS } from '../../../core/regen-base';
import type { Segment } from './page-segments';
import type { SourceKind } from './page-source';

// 改了什么时候用上（第九十轮）：一项的每一段标“即时 / 要重新生成 / 只影响新地图”之一。
// 以前只手标了两处（本世界的生态、省份划分的“湖”），别的看不出来；面板底下的“改了 N 项 · 重新生成”又把画的时候现读的几项也算了进去。
// 这里是唯一的一张表，标记和“改了 N 项”（regen.ts）都从它推：
//
//   看的是我的库          只影响新地图（改库不动当前世界，用它新建、添加时才用上）
//   看的是只读的库        不标（改不了）
//   本世界：
//     不在“要重新生成”的种类里（生态、河、湖、岛、地形类别、资源、地名风格、画风、派系）
//                         即时。它们的命令执行完引擎自己从该重算的那一层重算（种类的 dirty：生态到植被，地形类别、资源到人文的几层，
//                         地名风格重新起名），或者只在画、用的时候现读（画风、派系的影响力）
//     生成时才读的种类（REGEN_KINDS：人文、国家、城市、省份划分）
//                         要重新生成；其中画、用的时候现读的字段（INSTANT_KEYS，每一个都读过代码、有测试“改了以后重新生成，结果一样”）是即时
//
// 一段里几个字段不一样时按最慢的标（要重新生成），另写一句哪几个马上变。
// 不碰界面，测试直接调

export type Timing = 'instant' | 'regen' | 'new';

// 要重新生成才用上的种类，按重新生成哪一样分（core/regen-base.ts 的 SCOPE_KINDS：引擎发“上一次生成时的内容”、regen.ts 比“改过没有”用同一份）。
// 第九十轮：派系不在里面了——生成国家时不读派系，影响力是用到时按政体列的派系、派系的“多少”和人口现算的（core/human/country-layers.ts 的 countryFactions）
export const HUMAN_KINDS = SCOPE_KINDS.human;
export const COUNTRY_KINDS = SCOPE_KINDS.countries;
export const SETTLE_KINDS = SCOPE_KINDS.settlements;
export const PROVINCE_KIND = 'provinceRules';
export const REGEN_KINDS: readonly string[] = [...HUMAN_KINDS, ...COUNTRY_KINDS, ...SETTLE_KINDS, ...SCOPE_KINDS.provinces];

// 省份划分里重新划分才用上的几项（“湖”改了马上整理；名字、说明不上地图）
export const PROVINCE_KEYS: readonly (keyof ProvinceRules)[] = ['size', 'varied', 'wasteland', 'seaByDistance', 'riverCost', 'ridgeCost'];

// 每一种都不用重新生成的两项：地图按现在的颜色画，说明只在面板、档案里写
const COSMETIC: readonly string[] = ['description', 'color'];

// 生成时才读的种类里，画、用的时候现读的字段（改了马上变，不算“改了 N 项”）。读过的代码：
//   国家等级的首都四项    core/human/tiers.ts 的 capitalLook，只有画城市（ui/domain/settlements.ts）、排国名（ui/map/political.ts）时调
//   政体的“有哪些派系”    core/human/government.ts 的 governmentFactions，只有 countryFactions（档案、导出）用；生成国家的各步不读派系
//   城市等级的名字、图标、字号、浓淡、大小
//                         城市的表是现算的（core/human/city-table.ts 每次按世界里现在的等级定级）；生成城市只看有没有等级，
//                         道路读“连大道”、重要、首都用（isMajorRank），地标读重要（landmarks.ts）：这三项和定级的两项留在“要重新生成”
//   地标的名字、图标、名字的写法
//                         地标只记类型的 id 和格，名字每次按写法现起（core/human/landmarks.ts 的 landmarkName、landmarkList）
//   点的名字、图标、图片  点是自己放的，列表现读类型（core/human/points.ts 的 pointList）；“当作城市”留在“要重新生成”（进城市的表，道路、地标按表放）
const INSTANT_KEYS: Readonly<Record<string, readonly string[]>> = {
  countryTier: ['capitalIcon', 'capitalAlpha', 'capitalLabel', 'capitalBold'],
  government: ['factions'],
  cityRank: ['name', 'icon', 'label', 'alpha', 'iconScale', 'labelAlpha'],
  landmarkType: ['name', 'icon', 'label'],
  pointType: ['name', 'icon', 'image'],
};

const instantSets = new Map<string, ReadonlySet<string>>();
// 这一种里改了不用重新生成的字段（regen.ts 比“改过没有”时不看它们）
export function instantKeys(kind: string): ReadonlySet<string> {
  let s = instantSets.get(kind);
  if (!s) instantSets.set(kind, (s = new Set([...COSMETIC, ...(INSTANT_KEYS[kind] ?? [])])));
  return s;
}

// 本世界里一个字段改了什么时候用上
export function fieldTiming(kind: string, key: string): 'instant' | 'regen' {
  if (kind === PROVINCE_KIND) return (PROVINCE_KEYS as readonly string[]).includes(key) ? 'regen' : 'instant';
  if (!REGEN_KINDS.includes(kind)) return 'instant';
  return instantKeys(kind).has(key) ? 'instant' : 'regen';
}

export interface SegmentTiming {
  timing: Timing;
  // 要重新生成的一段里马上变的几个字段（名字）
  also: string[];
  // 写在这一段里的一句（没有时 null）
  note: string | null;
}

// 即时的种类里只管以后的几项：另写一句
const SEGMENT_NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  islandType: { basic: '形状、高低、岩石只影响以后放的岛' },
};

export const TIMING_LABEL: Record<Timing, string> = { instant: '即时', regen: '要重新生成', new: '只影响新地图' };
export const TIMING_TIP: Record<Timing, string> = { instant: '改了地图马上变', regen: '改完点底下的“重新生成”', new: '新建地图、添加到世界时用上' };

// 一段标什么。source：看的是哪一种来源；不能改的（只读的库、本世界的星球形态）、没有可改的（示例）不标
export function segmentTiming(source: SourceKind | null, kind: ContentKind, seg: Pick<Segment, 'id' | 'fields' | 'custom'>): SegmentTiming | null {
  if (seg.custom === 'samples' || (!seg.fields.length && !seg.custom)) return null;
  if (source === 'mine') return { timing: 'new', also: [], note: null };
  if (source !== 'world' || !canApply(kind)) return null;
  const note = SEGMENT_NOTES[kind.id]?.[seg.id] ?? null;
  // 本世界里时代的“变量”是一张单子：加一个变量是一条命令，现有的人原地分开，马上用上
  if (seg.custom === 'eraDims') return { timing: 'instant', also: [], note };
  const each = seg.fields.map((f) => ({ label: f.label, t: fieldTiming(kind.id, f.key) }));
  const regen = each.some((x) => x.t === 'regen');
  // 没有字段的自定义段（水系的勾）跟着种类
  if (!each.length) return { timing: REGEN_KINDS.includes(kind.id) ? 'regen' : 'instant', also: [], note };
  return { timing: regen ? 'regen' : 'instant', also: regen ? each.filter((x) => x.t === 'instant').map((x) => x.label) : [], note };
}

// 一种内容整个标什么（生态的编辑器不分段：顶上写一个）
export function kindTiming(source: SourceKind | null, kindId: string): Timing | null {
  const kind = kindOf(kindId);
  if (!kind) return null;
  if (source === 'mine') return 'new';
  if (source !== 'world' || !canApply(kind)) return null;
  return REGEN_KINDS.includes(kindId) ? 'regen' : 'instant';
}

// 要重新生成的一段里写的一句：“改完点底下的“重新生成”；颜色、说明马上变”
export function timingLine(t: SegmentTiming): string | null {
  const parts: string[] = [];
  if (t.timing === 'regen') parts.push(TIMING_TIP.regen);
  if (t.also.length) parts.push(`${t.also.join('、')}马上变`);
  if (t.note) parts.push(t.note);
  return parts.length ? parts.join('；') : null;
}
