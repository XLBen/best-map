import { type Command, popText } from '../../core/commands';
import { type CultureGroup, type Era, type PopValue, type Culture, worldCultureGroups, worldCultures, worldEra, worldEras, worldPopValues } from '../../core/human';
import type { CountryLayout, World } from '../../core/world';
import { builtinOf } from '../../core/content/registry';
import { type PackNode, type PackWorld, ownItems, packItems, subPacks, walkPacks } from '../../core/packs';
import { builtinOrigin, builtinPacks, isBuiltinSame, originOf } from '../../core/packs/builtin-tree';
import { type PackRoot, packImportCommands } from '../../core/packs/import';
import type { LibraryEntry } from '../library';

// 人文（第二十二轮）的界面逻辑：新建向导的“人文”一步与“文化 ⋯”里的“生成人文”共用的选择（时代、文化组与各占多少、总人口），
// 人数、密度的写法。不碰界面，测试直接调。内置的时代、文化组从内置的树读（core/packs/builtin-tree.ts）。
// 第三十轮（核心）：时代就是资源包，生成之前把要用的内容加进世界（core/packs/import.ts 的 packImportCommands），
// generate_human 带上用的包。这里只做了让它照旧能用的最少改动（时代 → 它所在的大包），勾选几个包的界面另做

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
export const eraChoices = (small?: Small | null, lib: readonly LibraryEntry[] = []): Era[] => merged(withLibrary(builtinOf<Era>('era'), lib, 'eras'), small ? worldEras(small) : []);
export const groupChoices = (small?: Small | null, lib: readonly LibraryEntry[] = []): CultureGroup[] => merged(withLibrary(builtinOf<CultureGroup>('cultureGroup'), lib, 'cultureGroups'), small ? worldCultureGroups(small) : []);
export const cultureChoices = (small?: Small | null, lib: readonly LibraryEntry[] = []): Culture[] => merged(withLibrary(builtinOf<Culture>('culture'), lib, 'cultures'), small ? worldCultures(small) : []);
export const valueChoices = (small?: Small | null): PopValue[] => merged(builtinOf<PopValue>('popValue'), small ? worldPopValues(small) : []);

// 资源库的包（内置的大包在前，再是装上的、我的）
const rootsOf = (lib: readonly LibraryEntry[]): PackRoot[] => [...builtinPacks().map((p) => ({ key: p.id, pack: p as PackNode })), ...lib.filter((e) => !e.builtin).map((e) => ({ key: e.key, pack: e.pack as PackNode }))];

// 时代所在的大包（资源库里第一个有它的；都没有时用世界里记着的来源的大包，再没有时 null）
export function eraPack(eraId: string, lib: readonly LibraryEntry[] = [], small?: Small | null): string[] | null {
  for (const r of rootsOf(lib)) if (packItems<Era>(r.pack, 'eras').some((e) => e.id === eraId)) return [r.key];
  const rec = small?.origin?.era?.[eraId];
  return rec?.length ? [rec[0]] : null;
}

// 时代包里默认带的文化组与权重（时代包的“文化”小包，第三十轮：以前是时代项里的 defaultGroups）
export function eraPackGroups(eraId: string, lib: readonly LibraryEntry[] = []): { id: string; weight: number }[] {
  const at = eraPack(eraId, lib);
  const root = at && rootsOf(lib).find((r) => r.key === at[0]);
  if (!root) return [];
  const out: { id: string; weight: number }[] = [];
  walkPacks(root.pack, (n) => {
    if (n.id !== 'cultures') return;
    for (const c of subPacks(n)) {
      const g = ownItems<CultureGroup>(c, 'cultureGroups')[0];
      if (g && !out.some((x) => x.id === g.id)) out.push({ id: g.id, weight: typeof c.weight === 'number' ? c.weight : 1 });
    }
  });
  return out;
}

// 生成人文的选择里列哪些（第二十八轮）：library 是资源库里的全部（新建向导、第一次生成），world 只列本世界的（重新生成；
// 别的从资源库添加）
export type ChoiceScope = 'library' | 'world';
export function choiceLists(small: Small | null | undefined, scope: ChoiceScope, lib: readonly LibraryEntry[] = []): { eras: Era[]; groups: CultureGroup[] } {
  if (scope === 'world' && small) return { eras: [...worldEras(small)], groups: [...worldCultureGroups(small)] };
  return { eras: eraChoices(small, lib), groups: groupChoices(small, lib) };
}

// 一个文化组里有几个文化（向导的组旁写“3 个文化”）
export const culturesIn = (small: Small | null | undefined, group: string, lib: readonly LibraryEntry[] = []) => cultureChoices(small, lib).filter((c) => c.group === group);

// 生成之前把要用的内容加进本世界（第三十轮：时代所在的大包里的时代、取值、政体、派系、地标，选的文化组与它们的文化、
// 地名风格；见 core/packs/import.ts），每条带 from
export function importCommands(c: Pick<HumanChoice, 'era' | 'groups'>, small: Small | null | undefined, lib: readonly LibraryEntry[]): Command[] {
  const packs = eraPack(c.era, lib, small);
  if (!packs) return [];
  const world = small ? ({ small, causes: { fields: {} } } as unknown as PackWorld) : undefined;
  return packImportCommands(rootsOf(lib), { packs: [packs], groups: c.groups.map((g) => g.id) }, world);
}

const REGEN_LABELS: Partial<Record<Command['op'], string>> = { generate_human: '生成人文', regenerate_human: '重新生成人文', generate_countries: '生成国家', regenerate_countries: '重新生成国家' };

// 重新生成人文、生成国家之前（第三十轮）：生成后没用到的政体、派系、取值清理掉了，再生成之前把世界用的包再加一遍
// （世界里有的跳过，先后排回包里的），与第一次生成看到的一样。没有人文时原样
export function withPackImports(cmd: Command, small: Small, lib: readonly LibraryEntry[] = []): Command {
  const h = small.human;
  if (!h) return cmd;
  const world = { small, causes: { fields: {} } } as unknown as PackWorld;
  const imports = packImportCommands(rootsOf(lib), { packs: h.packs, groups: h.groups.map((g) => g.id) }, world);
  const label = cmd.op === 'batch' ? cmd.label : REGEN_LABELS[cmd.op];
  return imports.length ? { op: 'batch', ...(label ? { label } : {}), commands: [...imports, cmd] } : cmd;
}

// ---------- 按资源包分组（第二十九轮：向导、重新生成里的时代、文化组） ----------

export const LOOSE_GROUP = '离群';
export const WORLD_GROUP = '本世界';

// 大包的名字：资源库里的（装上的、我的、内置的）；builtinFlat：内置的都写“内置”（时代：每个内置时代自己就是一个大包）
function topName(id: string, lib: readonly LibraryEntry[], builtinFlat: boolean): string {
  const b = builtinPacks().find((p) => p.id === id);
  if (b) return builtinFlat ? '内置' : b.name;
  return lib.find((e) => e.key === id)?.pack.name ?? id;
}

// 一项列在哪一组：本世界的按记着的来源（没有来源的是“离群”）；资源库的按它在哪个包里（内置原样的按内置的树，
// 别的按资源库里第一个有它的包；都没有时是“本世界”）
export function choiceGroup(kind: string, item: { id: string }, small: Small | null | undefined, lib: readonly LibraryEntry[], scope: ChoiceScope, builtinFlat = false): string {
  if (scope === 'world' && small) {
    const path = originOf(small, kind, item.id, item);
    return path?.length ? topName(path[0], lib, builtinFlat) : LOOSE_GROUP;
  }
  if (isBuiltinSame(kind, item)) {
    const path = builtinOrigin(kind, item.id);
    if (path) return topName(path[0], lib, builtinFlat);
  }
  const key = kind === 'era' ? 'eras' : kind === 'cultureGroup' ? 'cultureGroups' : `${kind}s`;
  const e = lib.find((x) => !x.builtin && packItems<{ id: string }>(x.pack, key).some((y) => y.id === item.id));
  if (e) return e.pack.name;
  return small && (small.content?.[kind] as Record<string, unknown> | undefined)?.[item.id] !== undefined ? WORLD_GROUP : '内置';
}

// 分成几组（按第一次出现的先后；离群、本世界放最后）
export function groupByPack<T>(items: readonly T[], labelOf: (x: T) => string): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const x of items) {
    const label = labelOf(x);
    const hit = out.find((g) => g.label === label);
    if (hit) hit.items.push(x);
    else out.push({ label, items: [x] });
  }
  const last = (l: string) => (l === LOOSE_GROUP || l === WORLD_GROUP ? 1 : 0);
  return out.sort((a, b) => last(a.label) - last(b.label));
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

// 时代建议的文化组（时代包的“文化”小包里的）；没有时为 null（不限）
export function suggestedGroups(era: Era | undefined, lib: readonly LibraryEntry[] = []): Set<string> | null {
  if (!era) return null;
  const ids = eraPackGroups(era.id, lib).map((g) => g.id);
  return ids.length ? new Set(ids) : null;
}

// 这个时代默认勾的文化组：时代包的“文化”小包里的（认得的，权重按小包的 weight），没有时是前三个。
// known：能选的文化组（省略时是内置的 + 世界里的）
export function eraGroups(era: Era | undefined, small?: Small | null, known0?: readonly { id: string }[], lib: readonly LibraryEntry[] = []): { id: string; weight: number }[] {
  const known = new Set((known0 ?? groupChoices(small, lib)).map((g) => g.id));
  const def = era ? eraPackGroups(era.id, lib).filter((g) => known.has(g.id) && g.weight > 0) : [];
  if (def.length) return def;
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
  const gen = generateOnly(c, eraPack(c.era, lib, small));
  return imports.length ? { op: 'batch', label: '生成人文', commands: [...imports, gen] } : gen;
}

function generateOnly(c: HumanChoice, pack: string[] | null): Command {
  return {
    op: 'generate_human',
    packs: pack ? [pack] : [],
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
export function regenerateWith(c: HumanChoice, small: Small, lib: readonly LibraryEntry[] = []): Command | null {
  const h = small.human;
  if (!h || choiceProblem(c, small)) return null;
  const groups = c.groups.map((g) => ({ id: g.id, weight: g.weight }));
  const same = c.era === h.era && JSON.stringify(groups) === JSON.stringify(h.groups.map((g) => ({ id: g.id, weight: g.weight })));
  if (same && c.pop === null) return null;
  const countries = h.countryRules && c.era !== h.era ? { countries: {} } : {};
  const pack = eraPack(c.era, lib, small);
  const regen: Command = { op: 'regenerate_human', packs: pack ? [pack] : h.packs, groups, ...(c.pop !== null ? { totalPop: Math.round(c.pop) } : {}), keepManual: c.era === h.era, ...countries };
  const imports = importCommands(c, small, lib);
  return imports.length ? { op: 'batch', label: '重新生成人文', commands: [...imports, regen] } : regen;
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
