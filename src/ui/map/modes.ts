import { computed, effect } from '@preact/signals';
import type { FeatureType, GeoFeature } from '../../../core/features';
import { worldDimensions } from '../../../core/human';
import type { World } from '../../../core/world';
import { type MapKind, type ViewMode, mode, prefs, setPrefs, world, worldEpoch } from '../../state';
import { hasCountries } from '../countries';
import { viewAvailable } from '../defs/layers';

// 地图模式（第二十五轮，像 EU4 的地图模式）：地理、国家、文化、文化组、时代的每一维（宗教、种族……）、人口。
// 模式就是人文的底图：底图换成哪一层，模式就是哪一种（图层里选人文的底图、工具换上它那一层，模式都跟着变；
// 别的底图都算地理）。每种模式在地图上画什么写在下面这张表里，地图、导出、图层面板都读它

export type { MapKind };

// 片区名按哪一种编码：国家、文化、文化组、某一维的取值
export type RegionSource = 'country' | 'culture' | 'cultureGroup' | `dim:${string}`;

export interface ModeDef {
  // 省界的浓淡：0 是不画（只在省份底图、省份工具里画），否则画、按这个浓淡
  provinces: number;
  // 国界：不画 / 细而淡 / 显眼
  countryBorders: 'none' | 'faint' | 'full';
  // 城市：geo 是地理图的规则（“城市”一类开着、或世界里没有国家时才画）；all 全部；capitals 只画首都、陪都
  cities: 'geo' | 'all' | 'capitals';
  // 写名字的城市：首都、陪都 / 都不写（非首都的城市在哪种模式里都不写名字）
  cityNames: 'capitals' | 'none';
  // 地标：全部 / 只画自然的 / 不画（自定义点照画）
  landmarks: 'all' | 'natural' | 'none';
  // 自然的地名：全部 / 只留海、湾、海峡、湖、山脉 / 只留大洋、海（用户自己的地名都照旧）
  features: 'all' | 'political' | 'ocean';
  // 沿片区弯着写的名字；null 不写
  regions: RegionSource | null;
}

const GEO: ModeDef = { provinces: 0, countryBorders: 'none', cities: 'geo', cityNames: 'capitals', landmarks: 'natural', features: 'all', regions: null };
const COUNTRY: ModeDef = { provinces: 0.45, countryBorders: 'full', cities: 'all', cityNames: 'capitals', landmarks: 'all', features: 'political', regions: 'country' };
// 文化、文化组、每一维：按这一层着色，国界淡淡地留着，写这一种的名字，只留首都的图标
const LAYER = (regions: RegionSource): ModeDef => ({ provinces: 0.25, countryBorders: 'faint', cities: 'capitals', cityNames: 'none', landmarks: 'none', features: 'ocean', regions });
const POP: ModeDef = { ...LAYER('culture'), regions: null };

export function modeDef(k: MapKind): ModeDef {
  if (k === 'geo') return GEO;
  if (k === 'country') return COUNTRY;
  if (k === 'popDensity') return POP;
  return LAYER(k);
}

// 底图是哪一种模式（人文的几层各是一种，别的底图都是地理）
export function kindOfView(v: ViewMode): MapKind {
  if (v === 'country' || v === 'culture' || v === 'cultureGroup' || v === 'popDensity' || v.startsWith('dim:')) return v as MapKind;
  return 'geo';
}

// 现在的模式（跟着底图）
export const mapKind = computed<MapKind>(() => kindOfView(mode.value));

// 一个世界里现在的模式：这个世界里没有那一层（预览的世界、刚删了人文）时是地理
export function modeOf(w: Pick<World, 'small' | 'causes'> | null, k: MapKind = mapKind.value): MapKind {
  if (!w || k === 'geo') return 'geo';
  if (k === 'country') return hasCountries(w) ? k : 'geo';
  return viewAvailable(w, k) ? k : 'geo';
}

// 模式按钮：名字、悬停的说明。没有人文时没有（只有地理）；没有国家时没有“国家”
export interface ModeButton {
  id: MapKind;
  label: string;
  title: string;
}
export function mapModes(w: Pick<World, 'small' | 'causes'> | null): ModeButton[] {
  if (!w?.small.human) return [];
  return [
    { id: 'geo', label: '地理', title: '地貌与自然的地名' },
    ...(hasCountries(w) ? [{ id: 'country' as MapKind, label: '国家', title: '国界、国名、城市与地标' }] : []),
    { id: 'culture', label: '文化', title: '各文化的分布' },
    { id: 'cultureGroup', label: '文化组', title: '各文化组的分布' },
    ...worldDimensions(w.small).map((d): ModeButton => ({ id: `dim:${d.id}`, label: d.label, title: `各${d.label}的分布` })),
    { id: 'popDensity', label: '人口', title: '人口密度' },
  ];
}

// 换模式：存进偏好；底图换成这一层（地理：人文的底图换回地貌，别的底图不动）
export function setMapKind(k: MapKind) {
  setPrefs({ map: k });
  const w = world.value;
  if (k === 'geo') {
    if (kindOfView(mode.value) !== 'geo') mode.value = 'terrain';
  } else if (!w || viewAvailable(w, k)) mode.value = k;
}

// ---------- 自然的地名 ----------

// 国家模式里标的自然地名：海、湾、海峡、湖、山脉；文化等模式里只标大洋、海（用户自己的地名、圈的地名照旧都标）
export const POLITICAL_TYPES: ReadonlySet<FeatureType> = new Set<FeatureType>(['ocean', 'sea', 'bay', 'strait', 'lake', 'range', 'region', 'spot']);
const OCEAN_TYPES: ReadonlySet<FeatureType> = new Set<FeatureType>(['ocean', 'sea', 'region', 'spot']);

const featureMemo = new Map<ModeDef['features'], { from: GeoFeature[]; out: GeoFeature[] }>();
export function modeFeatures(list: GeoFeature[], which: ModeDef['features']): GeoFeature[] {
  if (which === 'all') return list;
  const hit = featureMemo.get(which);
  if (hit?.from === list) return hit.out;
  const types = which === 'political' ? POLITICAL_TYPES : OCEAN_TYPES;
  const out = list.filter((f) => types.has(f.type) || f.custom || !!f.region);
  featureMemo.set(which, { from: list, out });
  return out;
}

// ---------- 打开、新建世界时 ----------

// 偏好里存着人文的模式时：新建、打开了世界，或者刚生成了那一层（人文、国家），底图是地貌就换上去
let seen: { epoch: number; avail: boolean } = { epoch: -1, avail: false };
effect(() => {
  const w = world.value;
  const epoch = worldEpoch.value;
  if (!w) return;
  const want = prefs.peek().map;
  const avail = modeOf(w, want) !== 'geo';
  const fresh = epoch !== seen.epoch || (avail && !seen.avail);
  seen = { epoch, avail };
  if (fresh && avail && mode.peek() === 'terrain') mode.value = want as ViewMode;
});
