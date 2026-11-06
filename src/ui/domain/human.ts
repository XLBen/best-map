import { type Command, popText } from '../../../core/commands';
import { type Era, cultureGroupById, worldEra } from '../../../core/human';
import type { LibrarySwitchPlan } from '../../../core/packs/switch';
import type { CountryLayout, World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { type PackChoice, beyondGroups, choicePacks, revivedGroups, defaultGroupsOf, defaultLibrary, humanImportCommands, isLibrary, libraryRule, nodeAt, packLabel, switchPlanOf, worldLibrary } from './packChoice';

// 人文（第二十二轮）的界面逻辑：新建向导与“文化 ⋯”里的“生成人文”共用的选择（勾选的包、文化组与各占多少、总人口），
// 人数、密度的写法。不碰界面，测试直接调。
// 第三十轮：时代就是资源包，生成之前把要用的内容从资源库加进世界（core/packs/import.ts）。
// 第五十二轮：不再勾选，选一个库（packChoice.ts）；选的库和世界用的不一样就是换库（core/packs/switch.ts）

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

// ---------- 生成人文的选择（第五十二轮：选一个库，见 packChoice.ts） ----------

// 一份“生成人文”的选择。library：选的库；groups：选的文化组与权重；pop：总人口（null 按时代的默认密度）。
// countries（第二十三轮）：同时生成国家，fragmentation 是“分裂 ↔ 统一”（0 统一、1 分裂、0.5 按时代），layout 是格局（第二十六轮）。
// settlements（第二十四轮）：同时生成城市与道路（要有国家），landmarks：地标
export interface HumanChoice extends PackChoice {
  on: boolean;
  pop: number | null;
  countries: { on: boolean; fragmentation: number; layout?: CountryLayout };
  settlements: { on: boolean; landmarks: boolean };
}

// 世界里自己的、从别的库加来的组（比重不是 0 的）默认参与；这个库默认不带、从资源库面板加进来的组也是（第六十七轮，revivedGroups）
const extraGroups = (small: Small | null | undefined, library: string | null, lib: readonly LibraryEntry[]) => [...beyondGroups(small, library, lib), ...revivedGroups(small, library, lib)];
export const beyondWeights = (small: Small | null | undefined, library: string | null, lib: readonly LibraryEntry[], has: readonly { id: string }[]) =>
  extraGroups(small, library, lib)
    .filter((g) => g.weight !== 0 && !has.some((x) => x.id === g.id))
    .map((g) => ({ id: g.id, weight: 1 }));

// 默认的选择：世界里已有人文时照它（用的库、文化组）；没有时是世界的底子来自的库，再没有时中世纪与近世，文化组是库默认带的
export function defaultChoice(small?: Small | null, on = true, lib: readonly LibraryEntry[] = []): HumanChoice {
  const h = small?.human;
  const countries = { on: true, fragmentation: h?.countryRules?.fragmentation ?? 0.5, layout: h?.countryRules?.layout ?? ('era' as CountryLayout) };
  const settlements = { on: true, landmarks: small?.settlementRules?.landmarks ?? true };
  if (h) {
    const library = worldLibrary(small!) ?? null;
    const groups = h.groups.map((g) => ({ id: g.id, weight: g.weight }));
    return { on, library, groups: [...groups, ...beyondWeights(small, library, lib, groups)], pop: null, countries, settlements };
  }
  const was = small ? worldLibrary(small) : undefined;
  const node = was ? nodeAt(lib, [was]) : undefined;
  const library = node && isLibrary(node) ? was! : defaultLibrary(lib);
  return chooseLibrary({ on, library: null, groups: [], pop: null, countries, settlements }, library, lib, small);
}

// 规则用的时代（选的库的；没有时 undefined）
export const choiceEra = (c: Pick<PackChoice, 'library'>, lib: readonly LibraryEntry[] = [], small?: Small | null): Era | undefined => libraryRule(c.library, lib, small)?.era;

// 选一个库：文化组换成它默认带的，世界里自己的、从别的库加来的还在；是世界正在用的库时回到上次生成的组。总人口回到自动（人口密度跟着时代）
export function chooseLibrary(c: HumanChoice, library: string | null, lib: readonly LibraryEntry[] = [], small?: Small | null): HumanChoice {
  const h = small?.human;
  if (h && library && library === worldLibrary(small!)) return { ...defaultChoice(small, c.on, lib), countries: c.countries, settlements: c.settlements };
  const node = library ? nodeAt(lib, [library]) : undefined;
  const groups = node ? defaultGroupsOf(node) : [];
  return { ...c, library, groups: [...groups, ...beyondWeights(small, library, lib, groups)], pop: null };
}

// 勾上、去掉一个文化组（勾上时用小包写的默认权重，没有时 1）
export function toggleGroup(c: HumanChoice, id: string, on: boolean, weight = 1): HumanChoice {
  const has = c.groups.some((g) => g.id === id);
  if (on === has) return c;
  return { ...c, groups: on ? [...c.groups, { id, weight }] : c.groups.filter((g) => g.id !== id) };
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

// 不能生成时的原因（库里没有时代、一个文化组都没勾）
export const NO_ERA = '这个库里没有时代，不生成人文';
export function choiceProblem(c: HumanChoice, small?: Small | null, lib: readonly LibraryEntry[] = []): string | null {
  if (!choiceEra(c, lib, small)) return NO_ERA;
  if (!c.groups.length) return '至少勾一个文化组';
  return null;
}

// 换库的一步在历史和结果里的说法：移出几项写明，撤销都回来（第五十二轮）
function switchLabel(c: PackChoice, plan: LibrarySwitchPlan, lib: readonly LibraryEntry[]): string {
  const name = c.library ? packLabel(lib, [c.library]) : '';
  return `换库“${name}”${plan.drop.length ? ` · 移出 ${plan.drop.length} 项` : ''}${plan.kept.length ? ` · ${plan.kept.length} 项还在用，留下` : ''}`;
}
// 面板上提前写一句
export function switchNote(c: PackChoice, small: Small | null | undefined, lib: readonly LibraryEntry[]): string | null {
  const plan = switchPlanOf(c, small, lib);
  if (!plan) return null;
  return `换库：移出旧库的 ${plan.drop.length} 项，加入 ${plan.added} 项。可以撤销`;
}
const switchInput = (plan: LibrarySwitchPlan) => ({ switchLibrary: { drop: plan.drop, rehome: plan.rehome } });

// 生成的命令（没打开、选得不对时 null）：先把库里生成要用的内容加进本世界（一整步，每项带 from），再生成。
// small 为 null（新建向导）：世界的底子已经在新建的那一步里加了（worldContentCommands），这里只加库里生成要用的。
// 世界用着别的库时是换库
export function generateCommand(c: HumanChoice, small?: Small | null, lib: readonly LibraryEntry[] = []): Command | null {
  if (!c.on || choiceProblem(c, small, lib)) return null;
  const plan = switchPlanOf(c, small, lib);
  const imports = [...(plan ? plan.imports : humanImportCommands(c, small, lib)), ...reviveGroups(c, small), ...retireGroups(c, small, lib)];
  const gen = { ...generateOnly(c), ...(plan ? switchInput(plan) : {}) } as Command;
  return imports.length ? { op: 'batch', label: plan ? switchLabel(c, plan, lib) : '生成人文', commands: [...imports, gen] } : gen;
}

// 第五十一轮：世界里比重是 0 的组（从库里整包加进来的、依赖带来的）不参与生成；用户把它勾上就是要它参与，先去掉这个 0。
// 上一次生成就选着它的不动（用户后来把比重改成了 0：照旧退出）
function reviveGroups(c: Pick<PackChoice, 'groups'>, small?: Small | null): Command[] {
  if (!small) return [];
  return c.groups.flatMap((g): Command[] => {
    const item = cultureGroupById(small, g.id);
    if (!item || item.weight !== 0 || small.human?.groups.some((x) => x.id === g.id)) return [];
    const { weight: _, ...rest } = item;
    return [{ op: 'set_content', kind: 'cultureGroup', id: g.id, item: rest as unknown as Record<string, unknown> }];
  });
}

// 第五十九轮：“本世界加的”组用户取消了就记下来（比重写 0），重开面板时不再勾上。再勾上时 reviveGroups 去掉这个 0
function retireGroups(c: Pick<PackChoice, 'library' | 'groups'>, small: Small | null | undefined, lib: readonly LibraryEntry[]): Command[] {
  return extraGroups(small, c.library, lib)
    .filter((g) => g.weight !== 0 && !c.groups.some((x) => x.id === g.id))
    .map((g): Command => ({ op: 'set_content', kind: 'cultureGroup', id: g.id, item: { ...g, weight: 0 } as unknown as Record<string, unknown> }));
}

function generateOnly(c: HumanChoice): Command {
  return {
    op: 'generate_human',
    packs: choicePacks(c),
    groups: c.groups.map((g) => ({ id: g.id, weight: g.weight })),
    ...(c.pop !== null ? { totalPop: Math.round(c.pop) } : {}),
    ...(c.countries.on
      ? { countries: { ...(c.countries.fragmentation !== 0.5 ? { fragmentation: c.countries.fragmentation } : {}), ...(c.countries.layout && c.countries.layout !== 'era' ? { layout: c.countries.layout } : {}) } }
      : {}),
    // 城市与道路要有国家（第二十四轮）
    ...(c.countries.on && c.settlements.on ? { settlements: c.settlements.landmarks ? {} : { landmarks: false } } : {}),
  };
}

// 已有人文时按新的选择重新生成（文化组、总人口换掉，拖过的发源地留着）：选择与现在的一样时 null。
// 换了库：先换内容（core/packs/switch.ts），国家也重新长（锁定的留着），手改过的格不留。没换时领土不动
export function regenerateWith(c: HumanChoice, small: Small, lib: readonly LibraryEntry[] = []): Command | null {
  const h = small.human;
  if (!h || choiceProblem(c, small, lib)) return null;
  const groups = c.groups.map((g) => ({ id: g.id, weight: g.weight }));
  const totalPop = c.pop !== null ? { totalPop: Math.round(c.pop) } : {};
  const plan = switchPlanOf(c, small, lib);
  if (plan) {
    const regen: Command = { op: 'regenerate_human', packs: choicePacks(c), groups, ...totalPop, keepManual: false, ...(h.countryRules ? { countries: {} } : {}), ...switchInput(plan) };
    return { op: 'batch', label: switchLabel(c, plan, lib), commands: [...plan.imports, ...reviveGroups(c, small), ...retireGroups(c, small, lib), regen] };
  }
  if (JSON.stringify(groups) === JSON.stringify(h.groups.map((g) => ({ id: g.id, weight: g.weight }))) && c.pop === null) {
    // 只取消了“本世界加的”组：人口不用重算，只记下这一笔
    const retired = retireGroups(c, small, lib);
    return retired.length ? { op: 'batch', label: '不参与生成', commands: retired } : null;
  }
  const regen: Command = { op: 'regenerate_human', packs: choicePacks(c), groups, ...totalPop, keepManual: true };
  const imports = [...humanImportCommands(c, small, lib), ...reviveGroups(c, small), ...retireGroups(c, small, lib)];
  return imports.length ? { op: 'batch', label: '重新生成人文', commands: [...imports, regen] } : regen;
}

// “重新生成”这个按钮：上次的选择，加上后来从别的库加进世界的文化组（用户加进来就是要它参与）
// withCountries：国家也重新长（第六十二轮，面板顶上的按钮：文化和政体都改了时一步做完）
export function regenerateCommand(small: Small, lib: readonly LibraryEntry[] = [], withCountries = false): Command {
  const h = small.human;
  const more = h ? beyondWeights(small, worldLibrary(small) ?? null, lib, h.groups) : [];
  return withPackImports({ op: 'regenerate_human', ...(more.length ? { groups: [...h!.groups, ...more] } : {}), ...(withCountries ? { countries: {} } : {}) }, small, lib);
}

const REGEN_LABELS: Partial<Record<Command['op'], string>> = { generate_human: '生成人文', regenerate_human: '重新生成人文', generate_countries: '生成国家', regenerate_countries: '重新生成国家' };

// 重新生成人文、生成国家之前（第三十轮）：世界用的库再加一遍（世界里有的跳过，先后排回库里的），整理过的世界也与第一次生成
// 看到的一样；世界里已有的 id 不动（改过的也不再多一份），没整理过的什么都不加（第五十轮：生成后内容都留着）。没有人文时原样
export function withPackImports(cmd: Command, small: Small, lib: readonly LibraryEntry[] = []): Command {
  const h = small.human;
  if (!h) return cmd;
  const imports = humanImportCommands({ library: worldLibrary(small) ?? null, groups: h.groups.map((g) => ({ id: g.id, weight: g.weight })) }, small, lib);
  const label = cmd.op === 'batch' ? cmd.label : REGEN_LABELS[cmd.op];
  return imports.length ? { op: 'batch', ...(label ? { label } : {}), commands: [...imports, cmd] } : cmd;
}

// ---------- 按资源包分组（第二十九轮：向导里的星球形态） ----------

// 分成几组（按第一次出现的先后；“离群”放最后）
export function groupByPack<T>(items: readonly T[], labelOf: (x: T) => string): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const x of items) {
    const label = labelOf(x);
    const hit = out.find((g) => g.label === label);
    if (hit) hit.items.push(x);
    else out.push({ label, items: [x] });
  }
  const last = (l: string) => (l === LOOSE_GROUP ? 1 : 0);
  return out.sort((a, b) => last(a.label) - last(b.label));
}
export const LOOSE_GROUP = '离群';

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
