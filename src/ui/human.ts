import { type Command, popText } from '../../core/commands';
import { type Era, worldEra } from '../../core/human';
import type { CountryLayout, World } from '../../core/world';
import type { LibraryEntry } from '../library';
import { type PackChoice, defaultPacks, humanImportCommands, makeRule, rulePack, togglePack, worldDefaultPacks } from './packChoice';

// 人文（第二十二轮）的界面逻辑：新建向导与“文化 ⋯”里的“生成人文”共用的选择（勾选的包、文化组与各占多少、总人口），
// 人数、密度的写法。不碰界面，测试直接调。
// 第三十轮：时代就是资源包。选时代改成勾选资源包（packChoice.ts）：规则与维度取第一个带时代的包，别的包提供政体、派系、
// 文化……；生成之前把要用的内容从资源库加进世界（core/packs/import.ts），generate_human 带上勾选的包

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

// ---------- 生成人文的选择（第三十轮：勾选资源包，见 packChoice.ts） ----------

// 一份“生成人文”的选择。packs：勾选的包（按先后，规则与维度取第一个带时代的包）；groups：选的文化组与权重；
// pop：总人口（null 按时代的默认密度）。
// countries（第二十三轮）：同时生成国家，fragmentation 是“分裂 ↔ 统一”（0 统一、1 分裂、0.5 按时代），layout 是格局（第二十六轮）。
// settlements（第二十四轮）：同时生成城市与道路（要有国家），landmarks：地标
export interface HumanChoice extends PackChoice {
  on: boolean;
  pop: number | null;
  countries: { on: boolean; fragmentation: number; layout?: CountryLayout };
  settlements: { on: boolean; landmarks: boolean };
}

// 默认的选择：世界里已有人文时照它（用的包、文化组）；已有的世界第一次生成时勾上在用的包与中世纪；新建时勾上
// 基础、自然、中文地名、星球形态、中世纪与近世，文化组是时代包默认带的
export function defaultChoice(small?: Small | null, on = true, lib: readonly LibraryEntry[] = []): HumanChoice {
  const h = small?.human;
  const countries = { on: true, fragmentation: h?.countryRules?.fragmentation ?? 0.5, layout: h?.countryRules?.layout ?? ('era' as CountryLayout) };
  const settlements = { on: true, landmarks: small?.settlementRules?.landmarks ?? true };
  if (h) return { on, packs: h.packs.map((p) => [...p]), groups: h.groups.map((g) => ({ id: g.id, weight: g.weight })), pop: null, countries, settlements };
  const packs = small ? worldDefaultPacks(small, lib) : defaultPacks(lib);
  const base: HumanChoice = { on, packs: [], groups: [], pop: null, countries, settlements };
  return packs.reduce((c, p) => togglePack(c, p, true, lib), base);
}

// 规则用的时代（勾选的包里第一个带时代的；没有时 undefined）
export const choiceEra = (c: Pick<PackChoice, 'packs'>, lib: readonly LibraryEntry[] = [], small?: Small | null): Era | undefined => rulePack(c.packs, lib, small)?.era;

// 勾上、去掉一个包；把一个时代包设为规则（总人口回到自动：人口密度跟着时代）
export const choosePack = (c: HumanChoice, path: readonly string[], on: boolean, lib: readonly LibraryEntry[] = []): HumanChoice => ({ ...togglePack(c, path, on, lib), pop: null });
export const chooseRule = (c: HumanChoice, path: readonly string[]): HumanChoice => ({ ...makeRule(c, path), pop: null });

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

// 不能生成时的原因（勾选的包里没有时代、一个文化组都没勾）
export const NO_ERA = '勾选的包里没有时代，不生成人文';
export function choiceProblem(c: HumanChoice, small?: Small | null, lib: readonly LibraryEntry[] = []): string | null {
  if (!choiceEra(c, lib, small)) return NO_ERA;
  if (!c.groups.length) return '至少勾一个文化组';
  return null;
}

// 生成的命令（没打开、选得不对时 null）：先把勾选的包里生成要用的内容加进本世界（一整步，每项带 from），再生成。
// small 为 null（新建向导）：不带时代的包已经在新建的那一步里加了（worldContentCommands），这里只加时代包里的
export function generateCommand(c: HumanChoice, small?: Small | null, lib: readonly LibraryEntry[] = []): Command | null {
  if (!c.on || choiceProblem(c, small, lib)) return null;
  const imports = humanImportCommands(c, small, lib);
  const gen = generateOnly(c);
  return imports.length ? { op: 'batch', label: '生成人文', commands: [...imports, gen] } : gen;
}

function generateOnly(c: HumanChoice): Command {
  return {
    op: 'generate_human',
    packs: c.packs.map((p) => [...p]),
    groups: c.groups.map((g) => ({ id: g.id, weight: g.weight })),
    ...(c.pop !== null ? { totalPop: Math.round(c.pop) } : {}),
    ...(c.countries.on
      ? { countries: { ...(c.countries.fragmentation !== 0.5 ? { fragmentation: c.countries.fragmentation } : {}), ...(c.countries.layout && c.countries.layout !== 'era' ? { layout: c.countries.layout } : {}) } }
      : {}),
    // 城市与道路要有国家（第二十四轮）
    ...(c.countries.on && c.settlements.on ? { settlements: c.settlements.landmarks ? {} : { landmarks: false } } : {}),
  };
}

const samePacks = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]) => JSON.stringify(a) === JSON.stringify(b);

// 已有人文时按新的选择重新生成（包、文化组、总人口换掉，拖过的发源地留着）：选择与现在的一样时 null。
// 有国家、换了规则的时代时国家也重新长（锁定的留着）；没换时领土不动
export function regenerateWith(c: HumanChoice, small: Small, lib: readonly LibraryEntry[] = []): Command | null {
  const h = small.human;
  if (!h || choiceProblem(c, small, lib)) return null;
  const groups = c.groups.map((g) => ({ id: g.id, weight: g.weight }));
  const same = samePacks(c.packs, h.packs) && JSON.stringify(groups) === JSON.stringify(h.groups.map((g) => ({ id: g.id, weight: g.weight })));
  if (same && c.pop === null) return null;
  // 规则的时代没换：同一个包、同一个时代
  const now = rulePack(c.packs, lib, small);
  const was = rulePack(h.packs, lib, small);
  const sameEra = !!now && !!was && now.era.id === h.era && samePacks([now.path], [was.path]);
  const countries = h.countryRules && !sameEra ? { countries: {} } : {};
  const regen: Command = { op: 'regenerate_human', packs: c.packs.map((p) => [...p]), groups, ...(c.pop !== null ? { totalPop: Math.round(c.pop) } : {}), keepManual: sameEra, ...countries };
  const imports = humanImportCommands(c, small, lib);
  return imports.length ? { op: 'batch', label: '重新生成人文', commands: [...imports, regen] } : regen;
}

const REGEN_LABELS: Partial<Record<Command['op'], string>> = { generate_human: '生成人文', regenerate_human: '重新生成人文', generate_countries: '生成国家', regenerate_countries: '重新生成国家' };

// 重新生成人文、生成国家之前（第三十轮）：生成后没用到的政体、派系、取值清理掉了，再生成之前把世界用的包再加一遍
// （世界里有的跳过，先后排回包里的；不带时代的包只补会清理掉的几种），与第一次生成看到的一样。没有人文时原样
export function withPackImports(cmd: Command, small: Small, lib: readonly LibraryEntry[] = []): Command {
  const h = small.human;
  if (!h) return cmd;
  const imports = humanImportCommands({ packs: h.packs, groups: h.groups.map((g) => ({ id: g.id, weight: g.weight })) }, small, lib);
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
