import { type Command, popText } from '../../core/commands';
import { type CultureGroup, type Era, type PopValue, type Culture, weightedList, worldCultureGroups, worldCultures, worldEra, worldEras, worldPopValues } from '../../core/human';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from '../../core/packs/eras';
import type { World } from '../../core/world';

// 人文（第二十二轮）的界面逻辑：新建向导的“人文”一步与“文化 ⋯”里的“生成人文”共用的选择（时代、文化组与各占多少、总人口），
// 人数、密度的写法。不碰界面，测试直接调。内置的时代、文化组每次都从 core/packs/eras 读：加了新的时代、文化组自动出现

export { popText };

type Small = World['small'];

// 人数：4.0 亿、35.2 万、820
export const peopleText = (n: number) => `${popText(n)} 人`;

// 密度：人 / km²（小于 10 时一位小数）
export function densityText(d: number): string {
  if (!(d > 0)) return '无人';
  return `${d < 10 ? (Math.round(d * 10) / 10).toString() : Math.round(d).toLocaleString()} 人/km²`;
}

// 占比：37%（不到 1% 写“<1%”）
export const shareText = (s: number) => (s > 0 && s < 0.005 ? '<1%' : `${Math.round(s * 100)}%`);

// 世界里的（改过、加的）在前面同 id 的内置项的位置上，世界里另加的排在后面
function merged<T extends { id: string }>(builtin: readonly T[], own: readonly T[]): T[] {
  const mine = new Map(own.map((x) => [x.id, x]));
  const out = builtin.map((b) => mine.get(b.id) ?? b);
  for (const x of own) if (!builtin.some((b) => b.id === x.id)) out.push(x);
  return out;
}

// 能选的时代、文化组、文化、取值：内置的 + 世界里启用的（没有世界时只有内置的）
export const eraChoices = (small?: Small | null): Era[] => merged(BUILTIN_ERAS, small ? worldEras(small) : []);
export const groupChoices = (small?: Small | null): CultureGroup[] => merged(BUILTIN_CULTURE_GROUPS, small ? worldCultureGroups(small) : []);
export const cultureChoices = (small?: Small | null): Culture[] => merged(BUILTIN_CULTURES, small ? worldCultures(small) : []);
export const valueChoices = (small?: Small | null): PopValue[] => merged(BUILTIN_POP_VALUES, small ? worldPopValues(small) : []);

// 一个文化组里有几个文化（向导的组旁写“3 个文化”）
export const culturesIn = (small: Small | null | undefined, group: string) => cultureChoices(small).filter((c) => c.group === group);

// 一份“生成人文”的选择。pop：总人口（null 按时代的默认密度）。
// countries（第二十三轮）：同时生成国家，fragmentation 是“分裂 ↔ 统一”（0 统一、1 分裂、0.5 按时代）。
// settlements（第二十四轮）：同时生成城市与道路（要有国家），landmarks：地标
export interface HumanChoice {
  on: boolean;
  era: string;
  groups: { id: string; weight: number }[];
  pop: number | null;
  countries: { on: boolean; fragmentation: number };
  settlements: { on: boolean; landmarks: boolean };
}

// 时代建议的文化组（defaultGroups 与 cultureGroups 里的）；都没写时为 null（不限）
export function suggestedGroups(era: Era | undefined): Set<string> | null {
  if (!era) return null;
  const ids = [...weightedList(era.defaultGroups).map(([id]) => id), ...(era.cultureGroups ?? [])];
  return ids.length ? new Set(ids) : null;
}

// 这个时代默认勾的文化组：defaultGroups（认得的），没写时是能用的文化组各 1，再没有时是前三个
export function eraGroups(era: Era | undefined, small?: Small | null): { id: string; weight: number }[] {
  const known = new Set(groupChoices(small).map((g) => g.id));
  const def = weightedList(era?.defaultGroups)
    .filter(([id, w]) => known.has(id) && w > 0)
    .map(([id, weight]) => ({ id, weight }));
  if (def.length) return def;
  const allowed = (era?.cultureGroups ?? []).filter((id) => known.has(id)).map((id) => ({ id, weight: 1 }));
  if (allowed.length) return allowed;
  return [...known].slice(0, 3).map((id) => ({ id, weight: 1 }));
}

// 默认的选择：世界里已有人文时照它，否则第一个时代（内置的中世纪）
export function defaultChoice(small?: Small | null, on = true): HumanChoice {
  const h = small?.human;
  const countries = { on: true, fragmentation: h?.countryRules?.fragmentation ?? 0.5 };
  const settlements = { on: true, landmarks: small?.settlementRules?.landmarks ?? true };
  if (h) return { on, era: h.era, groups: h.groups.map((g) => ({ id: g.id, weight: g.weight })), pop: null, countries, settlements };
  const era = eraChoices(small)[0];
  return { on, era: era?.id ?? '', groups: eraGroups(era, small), pop: null, countries, settlements };
}

// 换时代：文化组换成那个时代的默认，总人口回到自动
export function chooseEra(c: HumanChoice, eraId: string, small?: Small | null): HumanChoice {
  if (c.era === eraId) return c;
  const era = eraChoices(small).find((e) => e.id === eraId);
  return { ...c, era: eraId, groups: eraGroups(era, small), pop: null };
}

// 勾上、去掉一个文化组（勾上时权重 1）
export function toggleGroup(c: HumanChoice, id: string, on: boolean): HumanChoice {
  const has = c.groups.some((g) => g.id === id);
  if (on === has) return c;
  return { ...c, groups: on ? [...c.groups, { id, weight: 1 }] : c.groups.filter((g) => g.id !== id) };
}

export function setGroupWeight(c: HumanChoice, id: string, weight: number): HumanChoice {
  return { ...c, groups: c.groups.map((g) => (g.id === id ? { ...g, weight } : g)) };
}

// 各组占多少（0–1）
export function groupShares(c: HumanChoice): Map<string, number> {
  const sum = c.groups.reduce((a, g) => a + g.weight, 0);
  return new Map(c.groups.map((g) => [g.id, sum > 0 ? g.weight / sum : 0]));
}

// 组的权重滑块：0.1–10，按对数
export const WEIGHT_RANGE: [number, number] = [0.1, 10];
export const roundWeight = (v: number) => (v < 1 ? Math.round(v * 20) / 20 : Math.round(v * 4) / 4);

// 不能生成时的原因（没选时代、一个文化组都没勾）
export function choiceProblem(c: HumanChoice, small?: Small | null): string | null {
  if (!eraChoices(small).some((e) => e.id === c.era)) return '先选一个时代';
  if (!c.groups.length) return '至少勾一个文化组';
  return null;
}

// 生成的命令（没打开、选得不对时 null）
export function generateCommand(c: HumanChoice, small?: Small | null): Command | null {
  if (!c.on || choiceProblem(c, small)) return null;
  return {
    op: 'generate_human',
    era: c.era,
    groups: c.groups.map((g) => ({ id: g.id, weight: g.weight })),
    ...(c.pop !== null ? { totalPop: Math.round(c.pop) } : {}),
    ...(c.countries.on ? { countries: c.countries.fragmentation !== 0.5 ? { fragmentation: c.countries.fragmentation } : {} } : {}),
    // 城市与道路要有国家（第二十四轮）
    ...(c.countries.on && c.settlements.on ? { settlements: c.settlements.landmarks ? {} : { landmarks: false } } : {}),
  };
}

// 已有人文时按新的选择重新生成（时代、文化组、总人口换掉，拖过的发源地留着）：选择与现在的一样时 null。
// 有国家、换了时代时国家也重新长（锁定的留着）；没换时代时领土不动
export function regenerateWith(c: HumanChoice, small: Small): Command | null {
  const h = small.human;
  if (!h || choiceProblem(c, small)) return null;
  const groups = c.groups.map((g) => ({ id: g.id, weight: g.weight }));
  const same = c.era === h.era && JSON.stringify(groups) === JSON.stringify(h.groups.map((g) => ({ id: g.id, weight: g.weight })));
  if (same && c.pop === null) return null;
  const countries = h.countryRules && c.era !== h.era ? { countries: {} } : {};
  return { op: 'regenerate_human', era: c.era, groups, ...(c.pop !== null ? { totalPop: Math.round(c.pop) } : {}), keepManual: c.era === h.era, ...countries };
}

// 向导里还没有世界：陆地面积按地图（或星球）的面积 × 陆地多少估（与建好后的默认总人口差不多）
export function estimateLandKm2(o: { globe: boolean; radiusKm?: number; mapKm?: number; landFraction: number }): number {
  const area = o.globe ? 4 * Math.PI * (o.radiusKm ?? 6371) ** 2 : (o.mapKm ?? 5000) * ((o.mapKm ?? 5000) / 2);
  return area * Math.max(0, o.landFraction);
}

// 总人口的滑块：默认的 1/10 到 10 倍，按对数；取两位有效数字
export const popRange = (def: number): [number, number] => [Math.max(1, def / 10), Math.max(10, def * 10)];
export function roundPop(v: number): number {
  if (v < 100) return Math.round(v);
  const k = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / k) * k;
}
export const popPos = (v: number, def: number) => {
  const [lo, hi] = popRange(def);
  return Math.max(0, Math.min(1, Math.log(v / lo) / Math.log(hi / lo)));
};
export const popAt = (p: number, def: number) => {
  const [lo, hi] = popRange(def);
  return roundPop(lo * (hi / lo) ** Math.max(0, Math.min(1, p)));
};

// 世界的时代（界面用：名字、维度）
export const eraOf = (small: Small): Era | undefined => worldEra(small);

// 第一句（卡片上只写一句）
export function firstLine(s: string | undefined): string {
  if (!s) return '';
  const k = s.indexOf('。');
  return k > 0 ? s.slice(0, k + 1) : s;
}
