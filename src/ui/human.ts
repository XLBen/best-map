import { type Command, popText } from '../../core/commands';
import { type CultureGroup, type Era, type PopValue, type Culture, weightedList, worldCultureGroups, worldCultures, worldEra, worldEras, worldPopValues } from '../../core/human';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from '../../core/packs/eras';
import type { CountryLayout, World } from '../../core/world';
import { packItems } from '../../core/packs';
import type { LibraryEntry } from '../library';

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

// 资源库里（装上的资源包、我的资源）的一种：同 id 的只取第一个
function fromLibrary<T extends { id: string }>(lib: readonly LibraryEntry[], key: string): T[] {
  const out: T[] = [];
  for (const e of lib) for (const x of packItems<T>(e.pack, key)) if (!out.some((y) => y.id === x.id)) out.push(x);
  return out;
}
// 内置的在前，资源库里另有的接在后面（同 id 的用内置的）
const withLibrary = <T extends { id: string }>(builtin: readonly T[], lib: readonly LibraryEntry[], key: string): T[] => [...builtin, ...fromLibrary<T>(lib, key).filter((x) => !builtin.some((b) => b.id === x.id))];

// 能选的时代、文化组、文化、取值：资源库（内置的 + 资源包、我的资源里的，lib 省略时只有内置的）+ 世界里有的（没有世界时只有资源库的）。
// 新建向导、第一次生成人文用它（选了资源库里的就添加到本世界，见 importCommands）；重新生成只列本世界的（worldLists）
export const eraChoices = (small?: Small | null, lib: readonly LibraryEntry[] = []): Era[] => merged(withLibrary(BUILTIN_ERAS, lib, 'eras'), small ? worldEras(small) : []);
export const groupChoices = (small?: Small | null, lib: readonly LibraryEntry[] = []): CultureGroup[] => merged(withLibrary(BUILTIN_CULTURE_GROUPS, lib, 'cultureGroups'), small ? worldCultureGroups(small) : []);
export const cultureChoices = (small?: Small | null, lib: readonly LibraryEntry[] = []): Culture[] => merged(withLibrary(BUILTIN_CULTURES, lib, 'cultures'), small ? worldCultures(small) : []);
export const valueChoices = (small?: Small | null): PopValue[] => merged(BUILTIN_POP_VALUES, small ? worldPopValues(small) : []);

// 生成人文的选择里列哪些（第二十八轮）：library 是资源库里的全部（新建向导、第一次生成），world 只列本世界的（重新生成；
// 别的从资源库添加）
export type ChoiceScope = 'library' | 'world';
export function choiceLists(small: Small | null | undefined, scope: ChoiceScope, lib: readonly LibraryEntry[] = []): { eras: Era[]; groups: CultureGroup[] } {
  if (scope === 'world' && small) return { eras: [...worldEras(small)], groups: [...worldCultureGroups(small)] };
  return { eras: eraChoices(small, lib), groups: groupChoices(small, lib) };
}

// 一个文化组里有几个文化（向导的组旁写“3 个文化”）
export const culturesIn = (small: Small | null | undefined, group: string, lib: readonly LibraryEntry[] = []) => cultureChoices(small, lib).filter((c) => c.group === group);

// 选了资源库里（资源包、我的资源）、本世界还没有的时代、文化组：生成之前先添加到本世界（文化组带上包里这一组的文化和它们的地名风格）。
// 内置的不用：生成时自动复制进来
export function importCommands(c: Pick<HumanChoice, 'era' | 'groups'>, small: Small | null | undefined, lib: readonly LibraryEntry[]): Command[] {
  const out: Command[] = [];
  const has = (kind: string, id: string) => !!small?.content?.[kind]?.[id];
  const set = (kind: string, item: { id: string }) => out.push({ op: 'set_content', kind, id: item.id, item: structuredClone(item) as unknown as Record<string, unknown> });
  if (!has('era', c.era) && !BUILTIN_ERAS.some((e) => e.id === c.era)) {
    const e = fromLibrary<Era>(lib, 'eras').find((x) => x.id === c.era);
    if (e) set('era', e);
  }
  for (const g of c.groups) {
    if (has('cultureGroup', g.id) || BUILTIN_CULTURE_GROUPS.some((x) => x.id === g.id)) continue;
    const entry = lib.find((e) => packItems<CultureGroup>(e.pack, 'cultureGroups').some((x) => x.id === g.id));
    if (!entry) continue;
    set('cultureGroup', packItems<CultureGroup>(entry.pack, 'cultureGroups').find((x) => x.id === g.id)!);
    const styles = new Map(packItems<{ id: string }>(entry.pack, 'nameStyles').map((x) => [x.id, x]));
    for (const cu of packItems<Culture>(entry.pack, 'cultures')) {
      if (cu.group !== g.id || has('culture', cu.id)) continue;
      set('culture', cu);
      const st = styles.get(cu.nameStyle);
      if (st && !has('nameStyle', st.id) && !out.some((x) => x.op === 'set_content' && x.kind === 'nameStyle' && x.id === st.id)) set('nameStyle', st);
    }
  }
  // 地名风格先加（文化引用它），再是时代、文化组、文化
  return [...out.filter((x) => x.op === 'set_content' && x.kind === 'nameStyle'), ...out.filter((x) => !(x.op === 'set_content' && x.kind === 'nameStyle'))];
}

// 一份“生成人文”的选择。pop：总人口（null 按时代的默认密度）。
// countries（第二十三轮）：同时生成国家，fragmentation 是“分裂 ↔ 统一”（0 统一、1 分裂、0.5 按时代），layout 是格局（第二十六轮）。
// settlements（第二十四轮）：同时生成城市与道路（要有国家），landmarks：地标
export interface HumanChoice {
  on: boolean;
  era: string;
  groups: { id: string; weight: number }[];
  pop: number | null;
  countries: { on: boolean; fragmentation: number; layout?: CountryLayout };
  settlements: { on: boolean; landmarks: boolean };
}

// 时代建议的文化组（defaultGroups 与 cultureGroups 里的）；都没写时为 null（不限）
export function suggestedGroups(era: Era | undefined): Set<string> | null {
  if (!era) return null;
  const ids = [...weightedList(era.defaultGroups).map(([id]) => id), ...(era.cultureGroups ?? [])];
  return ids.length ? new Set(ids) : null;
}

// 这个时代默认勾的文化组：defaultGroups（认得的），没写时是能用的文化组各 1，再没有时是前三个。
// known：能选的文化组（省略时是内置的 + 世界里的）
export function eraGroups(era: Era | undefined, small?: Small | null, known0?: readonly { id: string }[]): { id: string; weight: number }[] {
  const known = new Set((known0 ?? groupChoices(small)).map((g) => g.id));
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
  const countries = { on: true, fragmentation: h?.countryRules?.fragmentation ?? 0.5, layout: h?.countryRules?.layout ?? ('era' as CountryLayout) };
  const settlements = { on: true, landmarks: small?.settlementRules?.landmarks ?? true };
  if (h) return { on, era: h.era, groups: h.groups.map((g) => ({ id: g.id, weight: g.weight })), pop: null, countries, settlements };
  const era = eraChoices(small)[0];
  return { on, era: era?.id ?? '', groups: eraGroups(era, small), pop: null, countries, settlements };
}

// 换时代：文化组换成那个时代的默认，总人口回到自动。lists：选择里列着的时代、文化组（省略时是内置的 + 世界里的）
export function chooseEra(c: HumanChoice, eraId: string, small?: Small | null, lists?: { eras: readonly Era[]; groups: readonly CultureGroup[] }): HumanChoice {
  if (c.era === eraId) return c;
  const era = (lists?.eras ?? eraChoices(small)).find((e) => e.id === eraId);
  return { ...c, era: eraId, groups: eraGroups(era, small, lists?.groups), pop: null };
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
export function choiceProblem(c: HumanChoice, small?: Small | null, lib: readonly LibraryEntry[] = []): string | null {
  if (!eraChoices(small, lib).some((e) => e.id === c.era)) return '先选一个时代';
  if (!c.groups.length) return '至少勾一个文化组';
  return null;
}

// 生成的命令（没打开、选得不对时 null）。选了资源库里、本世界还没有的时代、文化组时，先添加到本世界（一整步）
export function generateCommand(c: HumanChoice, small?: Small | null, lib: readonly LibraryEntry[] = []): Command | null {
  if (!c.on || choiceProblem(c, small, lib)) return null;
  const imports = importCommands(c, small, lib);
  const gen = generateOnly(c);
  return imports.length ? { op: 'batch', label: '生成人文', commands: [...imports, gen] } : gen;
}

function generateOnly(c: HumanChoice): Command {
  return {
    op: 'generate_human',
    era: c.era,
    groups: c.groups.map((g) => ({ id: g.id, weight: g.weight })),
    ...(c.pop !== null ? { totalPop: Math.round(c.pop) } : {}),
    ...(c.countries.on
      ? { countries: { ...(c.countries.fragmentation !== 0.5 ? { fragmentation: c.countries.fragmentation } : {}), ...(c.countries.layout && c.countries.layout !== 'era' ? { layout: c.countries.layout } : {}) } }
      : {}),
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
