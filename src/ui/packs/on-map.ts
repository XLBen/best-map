import type { Command } from '../../../core/commands';
import { type ContentKind, enableCommand, kindOf, usageOf } from '../../../core/content/registry';
import { peopleCells } from '../../../core/content/usage';
import { type Culture, type Era, type PopValue, cityList, cultureGroupById, worldEra } from '../../../core/human';
import type { Government } from '../../../core/human/government';
import { resourceCode } from '../../../core/human/resources';
import type { LandmarkType } from '../../../core/human/settle-types';
import { classCode } from '../../../core/human/terrain-class';
import type { CountryTierDef } from '../../../core/human/tiers';
import { lakeTypesOf } from '../../../core/lake-types';
import { worldMapStyleId } from '../../../core/map-style';
import { worldStyleId } from '../../../core/name-styles';
import { provinceSeed } from '../../../core/province-rules';
import { riverTypesOf } from '../../../core/river-types';
import type { Species } from '../../../core/species';
import { type WaterType, perCellRule } from '../../../core/water-types';
import type { World } from '../../../core/world';
import type { PanelId } from '../../state';
import { defaultChoice, regenerateWith, toggleGroup, withPackImports } from '../domain/human';
import { withPattern } from './era-patterns';
import type { PageCtx } from './page-source';
import type { Route } from './pages';
import { type RegenNeed, joiningGroups } from './regen';

// 一项顶上的“在地图上”一行（第九十轮，只在看本世界时）：这一项在这张地图上用在多少格、多少国家、多少城市；
// 没用上时写原因，能一下子解决的给一个按钮（“自然生成关着 · 打开”“所在的文化组没参与生成 · 加进来”“这张地图还没有国家 · 生成国家”）。
// 原因按每一种实际的生效条件写：生态看每格的主导生态和“自然生成”；河湖看类型的格、“自然生成”和有没有条件（core/water-types.ts 的 matchesNaturally）；
// 文化看所在的组有没有参与生成（small.human.groups，和 regen.ts 算“参与”的是同一份）；政体、等级看国家；城市等级看现算的城市表……
// 数的办法和“谁用到它”（page-used-by.ts）、删除前查的（core/content/usage.ts）是同一套。不碰界面，测试直接调

export type OnMapFix =
  // 一条命令（一步，能撤销）
  | { t: 'command'; label: string; busy: string; cmd: Command }
  // 面板底下的“重新生成”那一步
  | { t: 'regen'; label: string }
  // 展开这一页的一段
  | { t: 'segment'; label: string; seg: string }
  // 去资源库的另一页
  | { t: 'route'; label: string; route: Route }
  // 打开一个面板（生成人文要选库、选文化组）
  | { t: 'panel'; label: string; panel: PanelId };

export interface OnMap {
  used: boolean;
  // 用上了：“长在 1,204 格”；没用上：原因
  text: string;
  // 定位用的格
  cells?: number[];
  fix?: OnMapFix;
}

const MAX_CELLS = 20000;
const num = (n: number) => n.toLocaleString('en-US');
const used = (text: string, cells?: number[]): OnMap => ({ used: true, text, ...(cells?.length ? { cells: cells.slice(0, MAX_CELLS) } : {}) });
const unused = (text: string, fix?: OnMapFix): OnMap => ({ used: false, text, ...(fix ? { fix } : {}) });

function cellsWhere(arr: ArrayLike<number> | undefined, v: number): number[] {
  const out: number[] = [];
  if (arr) for (let i = 0; i < arr.length; i++) if (arr[i] === v) out.push(i);
  return out;
}

// ---------- 几种常见的原因 ----------

export const NO_HUMAN_YET = '这张地图还没有生成人文';
export const NO_COUNTRIES_YET = '这张地图还没有国家';
export const NO_CITIES_YET = '这张地图还没有城市';
export const AFTER_REGEN = '重新生成后才出现';
const REGEN_FIX: OnMapFix = { t: 'regen', label: '重新生成' };

const noHuman = (): OnMap => unused(NO_HUMAN_YET, { t: 'panel', label: '去生成', panel: 'cat:culture' });
const hasCountries = (w: World) => Object.keys(w.small.countries ?? {}).length > 0;
const noCountries = (w: World, lib: PageCtx['lib']): OnMap => unused(NO_COUNTRIES_YET, { t: 'command', label: '生成国家', busy: '正在生成…', cmd: withPackImports({ op: 'generate_countries' }, w.small, lib) });
// 这一样改了还没重新生成（面板底下有那一条）
const waits = (need: RegenNeed | null, scope: RegenNeed['scopes'][number]): boolean => !!need?.scopes.includes(scope);

// 让一个文化组参与生成：和“文化 ⋯”里勾上它再重新生成是同一条命令（多少是 0 的先去掉这个 0）
function joinGroupFix(w: World, lib: PageCtx['lib'], group: string): OnMapFix | undefined {
  const cmd = regenerateWith(toggleGroup(defaultChoice(w.small, true, lib), group, true), w.small, lib);
  return cmd ? { t: 'command', label: '加进来', busy: '正在生成…', cmd } : undefined;
}

// ---------- 每一种 ----------

function biome(w: World, sp: Species): OnMap {
  const k = w.small.species.findIndex((s) => s.id === sp.id);
  const cells = k >= 0 ? cellsWhere(w.derived.dominant, k) : [];
  if (cells.length) return used(`长在 ${num(cells.length)} 格`, cells);
  if (sp.natural === false) {
    const painted = w.small.constraints.some((c) => c.species === sp.id);
    return unused(painted ? '自然生成关着，涂的地方没长成' : '自然生成关着，也没涂它', { t: 'command', label: '打开', busy: '正在计算…', cmd: { op: 'update_species', id: sp.id, patch: { natural: true } } });
  }
  if (sp.range) return unused('选的范围里没有适合它的地方');
  if (sp.dispersal) return unused('起源地附近没有适合它的地方');
  return unused('没有适合它、又争得过别的生态的地方');
}

function water(w: World, kind: ContentKind, t: WaterType): OnMap {
  const river = kind.id === 'riverType';
  const noun = river ? '河' : '湖';
  const list = river ? riverTypesOf(w.small) : lakeTypesOf(w.small);
  const code = list.findIndex((x) => x.id === t.id) + 1;
  const cells = code > 0 ? cellsWhere(river ? w.derived.riverType : w.derived.lakeType, code) : [];
  if (cells.length) return used(`${river ? '河道' : '湖面'} ${num(cells.length)} 格`, cells);
  if (t.natural === false) {
    const next = { ...t, natural: true };
    return unused(`自然生成关着，也没有${river ? '画的河' : '放的湖'}选它`, { t: 'command', label: '打开', busy: '正在计算…', cmd: { op: 'batch', label: `“${t.name}”自然生成`, commands: [enableCommand(kind, next, w)] } });
  }
  if (!t.scripts?.match?.src && !perCellRule(t)) return unused('还没选生态、写条件', { t: 'segment', label: '去选', seg: 'where' });
  return unused(`没有符合条件的${noun}`, { t: 'segment', label: '看条件', seg: 'where' });
}

function painted(w: World, kind: ContentKind, id: string): OnMap {
  const d = w.derived;
  const cells = kind.id === 'terrainClass' ? cellsWhere(d.terrainClass, classCode(w.small, id) || -1) : cellsWhere(d.resource, resourceCode(w.small, id) || -1);
  if (cells.length) return used(`占 ${num(cells.length)} 格`, cells);
  return unused(kind.id === 'terrainClass' ? '没有符合自动规则的地方' : '没有符合条件的地方', { t: 'segment', label: '看规则', seg: 'rules' });
}

function island(w: World, kind: ContentKind, id: string): OnMap {
  const u = usageOf(kind, w, id);
  return u ? used(`${num(u.count)} 格是这种岛`, u.cells) : unused('还没放这种岛');
}

function nameStyle(w: World, kind: ContentKind, id: string): OnMap {
  const isDefault = worldStyleId(w.small) === id;
  const u = usageOf(kind, w, id);
  if (isDefault) return used(u ? `世界默认的地名风格，另有${u.label}` : '世界默认的地名风格', u?.cells);
  if (u) return used(u.label, u.cells);
  return unused('没有地名、文化用它', { t: 'command', label: '设为默认', busy: '正在起名…', cmd: { op: 'set_name_style', id } });
}

function mapStyle(w: World, id: string): OnMap {
  if (worldMapStyleId(w.small) === id) return used('地图正用这种画风');
  return unused('没在用', { t: 'command', label: '用它', busy: '正在计算…', cmd: { op: 'set_map_style', id } });
}

function provinceRules(w: World): OnMap {
  const n = Object.keys(w.small.provinces ?? {}).length;
  if (n) return used(`${num(n)} 个省份按它划分`);
  return unused('还没有划分省份', { t: 'command', label: '划分省份', busy: '正在划分…', cmd: { op: 'generate_provinces', seed: provinceSeed(w.small) } });
}

function era(w: World, id: string): OnMap {
  const h = w.small.human;
  if (!h) return noHuman();
  if (h.era !== id) {
    const now = worldEra(w.small);
    return unused(`这张地图用的是“${now?.name ?? h.era}”`);
  }
  const countries = Object.keys(w.small.countries ?? {}).length;
  const cities = Object.keys(w.small.cities ?? {}).length;
  const parts = [...(countries ? [`${num(countries)} 个国家`] : []), ...(cities ? [`${num(cities)} 座城市`] : [])];
  return used(parts.length ? `这张地图的时代：${parts.join('、')}` : '这张地图的时代');
}

function cultureGroup(w: World, id: string, item: { weight?: number }, ctx: PageCtx, need: RegenNeed | null): OnMap {
  const h = w.small.human;
  if (!h) return noHuman();
  // 只说地图上的：有这一组的人的格、接纳它的国家
  const cells = peopleCells(w, 'cultureGroup', id);
  const ctry = Object.values(w.small.countries ?? {}).filter((c) => c.acceptedGroups.includes(id)).length;
  if (cells.length) return used([`${num(cells.length)} 格有这一组的人`, ...(ctry ? [`${num(ctry)} 个国家`] : [])].join('、'), cells);
  if (!h.groups.includes(id)) {
    // 本世界自己加的组（多少不是 0）下次重新生成就会参与：底下有那一条时按它来
    if (waits(need, 'human') && joiningGroups(w.small, ctx.lib).has(id)) return unused(AFTER_REGEN, REGEN_FIX);
    return unused(item.weight === 0 ? '多少是 0，没参与生成' : '没参与生成', joinGroupFix(w, ctx.lib, id));
  }
  if (waits(need, 'human')) return unused(AFTER_REGEN, REGEN_FIX);
  return unused('这次生成没分到地方');
}

function culture(w: World, c: Culture, ctx: PageCtx, need: RegenNeed | null): OnMap {
  const h = w.small.human;
  if (!h) return noHuman();
  const cells = peopleCells(w, 'culture', c.id);
  const ctry = Object.values(w.small.countries ?? {}).filter((m) => m.primaryCulture === c.id).length;
  if (cells.length) return used([`${num(cells.length)} 格有这种文化的人`, ...(ctry ? [`${num(ctry)} 个国家的主流文化`] : [])].join('、'), cells);
  if (!h.groups.includes(c.group)) {
    if (waits(need, 'human') && joiningGroups(w.small, ctx.lib).has(c.group)) return unused(AFTER_REGEN, REGEN_FIX);
    const g = cultureGroupById(w.small, c.group);
    return unused(`所在的文化组“${g?.name ?? c.group}”没参与生成`, g ? joinGroupFix(w, ctx.lib, c.group) : undefined);
  }
  if (waits(need, 'human')) return unused(AFTER_REGEN, REGEN_FIX);
  return unused(c.weight === 0 ? '多少是 0，这次生成没分到地方' : '这次生成没分到地方');
}

function popValue(w: World, v: PopValue, need: RegenNeed | null): OnMap {
  const h = w.small.human;
  if (!h) return noHuman();
  const now = worldEra(w.small);
  const dim = now?.dimensions.find((d) => d.id === v.dimension);
  if (!dim) return unused(`这张地图的时代没有“${v.dimension}”这个变量`, now ? { t: 'route', label: '去加', route: { p: 'item', kind: 'era', id: now.id, seg: 'dims' } } : undefined);
  const cells = peopleCells(w, 'popValue', v.id);
  if (cells.length) return used(`${num(cells.length)} 格有这样的人`, cells);
  if (waits(need, 'human')) return unused(AFTER_REGEN, REGEN_FIX);
  return unused('这次生成没分到人');
}

function valueGroup(w: World, kind: ContentKind, id: string): OnMap {
  const u = usageOf(kind, w, id);
  return u ? used(u.label) : unused('组里还没有取值');
}

function government(w: World, kind: ContentKind, g: Government, ctx: PageCtx, need: RegenNeed | null): OnMap {
  if (!w.small.human) return noHuman();
  if (!hasCountries(w)) return noCountries(w, ctx.lib);
  const u = usageOf(kind, w, g.id);
  if (u) return used(`${num(u.count)} 个国家`, u.cells);
  if (waits(need, 'countries')) return unused(AFTER_REGEN, REGEN_FIX);
  if (g.weight === 0) return unused('多少是 0，没有国家选它', { t: 'segment', label: '去改', seg: 'basic' });
  if (g.only?.length) return unused('没有国家满足“限谁用”', { t: 'segment', label: '看条件', seg: 'only' });
  return unused('这次生成没有国家选它');
}

function faction(w: World, id: string, ctx: PageCtx): OnMap {
  const govs = kindOf('government')!.inWorld(w) as readonly Government[];
  const mine = new Set(govs.filter((g) => g.factions?.includes(id)).map((g) => g.id));
  if (!mine.size) return unused('没有政体列着它', { t: 'route', label: '去政体里加', route: { p: 'list', kind: 'government' } });
  if (!w.small.human) return noHuman();
  if (!hasCountries(w)) return noCountries(w, ctx.lib);
  const ctry = Object.values(w.small.countries ?? {}).filter((c) => mine.has(c.government));
  if (ctry.length) return used(`${num(ctry.length)} 个国家有它`, cellsOfCountries(w, new Set(ctry.map((c) => c.id))));
  return unused('列着它的政体这次没有国家');
}

function cellsOfCountries(w: World, ids: ReadonlySet<number>): number[] {
  const arr = w.causes.country;
  const out: number[] = [];
  if (arr) for (let i = 0; i < arr.length && out.length < MAX_CELLS; i++) if (ids.has(arr[i])) out.push(i);
  return out;
}

function countryTier(w: World, t: CountryTierDef, ctx: PageCtx, need: RegenNeed | null): OnMap {
  if (!w.small.human) return noHuman();
  if (!hasCountries(w)) return noCountries(w, ctx.lib);
  const ctry = Object.values(w.small.countries ?? {}).filter((c) => c.tier === t.id);
  if (ctry.length) return used(`${num(ctry.length)} 个国家`, cellsOfCountries(w, new Set(ctry.map((c) => c.id))));
  if (waits(need, 'countries')) return unused(AFTER_REGEN, REGEN_FIX);
  // 生效的比例（core/human/tiers.ts 的 tierWeights）：时代写了比例（有一级不是 0）时只按时代的，没写的等级就是 0
  const ratios = worldEra(w.small)?.tiers;
  const byEra = !!ratios && Object.values(ratios).some((v) => v > 0);
  if (byEra ? !(ratios![t.id] > 0) : t.weight === 0) return unused('时代里这一级的比例是 0', { t: 'route', label: '去调', route: { p: 'gen' } });
  return unused('这次生成没有这一级的国家');
}

function countryPattern(w: World, id: string): OnMap {
  if (!w.small.human) return noHuman();
  const now = worldEra(w.small) as Era | undefined;
  if (!now) return noHuman();
  if (now.patterns?.some((p) => p.pattern === id)) return used('这张地图的时代列着它');
  const next = withPattern(now as unknown as Record<string, unknown>, id);
  const eraKind = kindOf('era')!;
  return unused('时代没列这种格局', next ? { t: 'command', label: '加进时代', busy: '正在计算…', cmd: { op: 'batch', label: `时代加上格局“${id}”`, commands: [enableCommand(eraKind, next, w)] } } : undefined);
}

// 没有城市时：先要人文、国家；都有了给“生成城市”
function noCities(w: World, ctx: PageCtx): OnMap {
  if (!w.small.human) return noHuman();
  if (!hasCountries(w)) return noCountries(w, ctx.lib);
  return unused(NO_CITIES_YET, { t: 'command', label: '生成城市', busy: '正在生成…', cmd: { op: 'generate_settlements' } });
}

function cityRank(w: World, id: string, ctx: PageCtx): OnMap {
  if (!Object.keys(w.small.cities ?? {}).length) return noCities(w, ctx);
  // 城市的等级是现算的（按占本国人口的比例、人数；自己定的照定的）
  const mine = cityList(w).filter((c) => c.rank.id === id);
  if (mine.length) return used(`${num(mine.length)} 座城市`, mine.map((c) => c.cell));
  return unused('没有城市够得上这一级', { t: 'segment', label: '看条件', seg: 'rule' });
}

function landmarkType(w: World, kind: ContentKind, t: LandmarkType, ctx: PageCtx, need: RegenNeed | null): OnMap {
  const u = usageOf(kind, w, t.id);
  if (u) return used(`${num(u.count)} 个地标`, u.cells);
  if (t.manual) return unused('不自动放，用地标工具放');
  const rules = w.small.settlementRules;
  // 人造的由文化定：没有人文、国家时不放
  if (t.category !== 'natural' && !w.small.human) return noHuman();
  if (t.category !== 'natural' && t.per !== 'world' && !hasCountries(w)) return noCountries(w, ctx.lib);
  if (!rules) return unused('还没有生成城市和地标', { t: 'command', label: '生成', busy: '正在生成…', cmd: { op: 'generate_settlements' } });
  if (!rules.landmarks) return unused('生成城市时没放地标', { t: 'command', label: '放地标', busy: '正在生成…', cmd: { op: 'regenerate_settlements', landmarks: true } });
  if (waits(need, 'settlements') || waits(need, 'human') || waits(need, 'countries')) return unused(AFTER_REGEN, REGEN_FIX);
  if (t.category !== 'natural' && t.cultureGroups?.length) {
    const groups = new Set(t.cultureGroups);
    const cultures = (kindOf('culture')!.inWorld(w) as readonly Culture[]).filter((c) => groups.has(c.group)).map((c) => c.id);
    const any = Object.values(w.small.countries ?? {}).some((m) => cultures.includes(m.primaryCulture));
    if (!any) return unused('没有国家是限定的文化组', { t: 'segment', label: '看条件', seg: 'who' });
  }
  return unused('这次生成没放它', { t: 'segment', label: '看条件', seg: 'where' });
}

function pointType(w: World, kind: ContentKind, id: string): OnMap {
  const u = usageOf(kind, w, id);
  return u ? used(`${num(u.count)} 个点`, u.cells) : unused('还没放这种点');
}

// ---------- 入口 ----------

// 这一项在这张地图上用在哪里；这一种没有“在地图上”的说法（自定义场）、没有世界时 null。
// need：现在要不要重新生成（regen.ts；写“重新生成后才出现”用）
export function onMapOf(kind: ContentKind, id: string, item: unknown, ctx: PageCtx, need: RegenNeed | null = null): OnMap | null {
  const w = ctx.world as World | null;
  if (!w || !w.derived) return null;
  const m = lineOf(w, kind, id, item, ctx, need);
  // 没用上、但有手动指定它的地方（涂了没长成的生态……）：照样能定位到那里
  if (m && !m.used && !m.cells) {
    const cells = usageOf(kind, w, id)?.cells;
    if (cells?.length) return { ...m, cells: cells.slice(0, MAX_CELLS) };
  }
  return m;
}

function lineOf(w: World, kind: ContentKind, id: string, item: unknown, ctx: PageCtx, need: RegenNeed | null): OnMap | null {
  switch (kind.id) {
    case 'biome':
      return biome(w, item as Species);
    case 'riverType':
    case 'lakeType':
      return water(w, kind, item as WaterType);
    case 'islandType':
      return island(w, kind, id);
    case 'terrainClass':
    case 'resource':
      return painted(w, kind, id);
    case 'nameStyle':
      return nameStyle(w, kind, id);
    case 'mapStyle':
      return mapStyle(w, id);
    case 'provinceRules':
      return provinceRules(w);
    case 'planetForm':
      return used('这张地图的星球形态');
    case 'era':
      return era(w, id);
    case 'cultureGroup':
      return cultureGroup(w, id, item as { weight?: number }, ctx, need);
    case 'culture':
      return culture(w, item as Culture, ctx, need);
    case 'popValue':
      return popValue(w, item as PopValue, need);
    case 'valueGroup':
      return valueGroup(w, kind, id);
    case 'government':
      return government(w, kind, item as Government, ctx, need);
    case 'faction':
      return faction(w, id, ctx);
    case 'countryTier':
      return countryTier(w, item as CountryTierDef, ctx, need);
    case 'countryPattern':
      return countryPattern(w, id);
    case 'cityRank':
      return cityRank(w, id, ctx);
    case 'landmarkType':
      return landmarkType(w, kind, item as LandmarkType, ctx, need);
    case 'pointType':
      return pointType(w, kind, id);
    default:
      return null;
  }
}
