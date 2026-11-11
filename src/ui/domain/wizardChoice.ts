import { WORLD_TYPE_INFO, type WorldType, type WorldgenInput } from '../../../core/generate';
import type { Command } from '../../../core/commands';
import { CLIMATE_ZONES, MAP_SIZES, type MapSize, PLANET_SIZES, type PlanetSize, TYPE_DEFAULTS, planetCells, planetSettings, settingsAt } from '../../../core/presets';
import type { Settings } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { DEFAULT_PLANET, type FormChoice, formChoices, formGen, formsInPacks, newWorldCommands, wizardWorldName } from './forms';
import { type HumanChoice, defaultChoice, generateCommand } from './human';
import { choicePacks, packLabel, worldContentCommands } from './packChoice';
import { type WizardTerrain, terrainCommands, withTerrain } from './wizardTerrain';

// 新建向导里选的东西，和它怎样变成一个世界（第九十八轮从 Wizard.tsx 搬出来：第一屏只有缩略图，别的都收在“自定义…”里，
// 所以“什么都不选时是什么”要有一处说得清、测得到）。纯函数，不碰界面：
//   - defaultWizardChoice：向导一打开时的选择（和以前逐项相同：一块地区、群岛之海、一片海域、热带、不动地形、默认的库和它的文化组、带国家和城市）；
//   - wizardWorld：点一张缩略图发出去的设置和命令（domain/wizard-choice.test.ts 钉着：默认的选择点第一张，和第九十七轮逐字相同）；
//   - wizardSummary：“自定义…”收着时那一行小字，写明现在用的是什么

export interface WizardChoice {
  kind: 'region' | 'planet';
  // 整个星球：星球形态（FormChoice 的 key）、大小
  ptype: string;
  psize: PlanetSize;
  // 一块地区：世界的种类、大小、地图中心的纬度
  type: WorldType;
  size: MapSize;
  center: number;
  // 地形：只记动过的几项
  terrain: WizardTerrain;
  // 库与人文
  human: HumanChoice;
}

// 一块地区的格数（整个星球按半径，见 core/presets.ts 的 planetCells）
export const REGION_CELLS = 40000;

export function defaultWizardChoice(lib: readonly LibraryEntry[]): WizardChoice {
  return {
    kind: 'region',
    ptype: DEFAULT_PLANET,
    psize: 'earth',
    type: 'archipelago',
    size: TYPE_DEFAULTS.archipelago.size,
    center: CLIMATE_ZONES[TYPE_DEFAULTS.archipelago.zone].lat,
    terrain: {},
    human: defaultChoice(null, true, lib),
  };
}

// 选着的星球形态：选的那个；不在了（删掉了）时是这个库里的第一个，再没有时随便第一个
export function chosenForm(c: Pick<WizardChoice, 'ptype' | 'human'>, choices: readonly FormChoice[]): FormChoice | undefined {
  return choices.find((x) => x.key === c.ptype) ?? formsInPacks(choices, choicePacks(c.human)).shown[0] ?? choices[0];
}

// 这种世界不动滑块时的生成参数
export const wizardBaseGen = (c: Pick<WizardChoice, 'kind' | 'type'>, seed: number, form: FormChoice | undefined): WorldgenInput =>
  c.kind === 'planet' ? (form ? formGen(seed, form.form) : { seed, type: 'continents' }) : { seed, type: c.type };
export const wizardGen = (c: Pick<WizardChoice, 'kind' | 'type' | 'terrain'>, seed: number, form: FormChoice | undefined): WorldgenInput => withTerrain(wizardBaseGen(c, seed, form), c.terrain);
export const wizardSettings = (c: Pick<WizardChoice, 'kind' | 'psize' | 'size' | 'center'>, cells: number): Partial<Settings> => (c.kind === 'planet' ? planetSettings(c.psize, cells) : settingsAt(c.size, c.center, cells));
export const wizardCells = (c: Pick<WizardChoice, 'kind' | 'psize'>): number => (c.kind === 'planet' ? planetCells(PLANET_SIZES[c.psize].radiusKm) : REGION_CELLS);

// 新建的命令：gen、name 是这个世界的生成参数和叫法；地形里动过的、人文、库里世界的底子按选的
export const wizardCommands = (c: Pick<WizardChoice, 'terrain' | 'human'>, gen: WorldgenInput, name: string, seed: number, lib: readonly LibraryEntry[]): Command[] =>
  newWorldCommands(gen, name, seed, terrainCommands(c.terrain), generateCommand(c.human, null, lib), worldContentCommands(c.human, lib));

// 点一张缩略图（种子 seed）：新建这个世界的设置和命令
export function wizardWorld(c: WizardChoice, seed: number, lib: readonly LibraryEntry[], choices: readonly FormChoice[] = formChoices(lib)): { settings: Partial<Settings>; commands: Command[] } {
  const form = chosenForm(c, choices);
  return { settings: wizardSettings(c, wizardCells(c)), commands: wizardCommands(c, wizardGen(c, seed, form), wizardWorldName(c.kind, c.ptype, choices, c.type), seed, lib) };
}

// “自定义…”收着时的一行：群岛之海 · 一片海域 · 中世纪与近世 · 带国家和城市
export function wizardSummary(c: WizardChoice, lib: readonly LibraryEntry[], choices: readonly FormChoice[] = formChoices(lib)): string {
  const what = c.kind === 'planet' ? [chosenForm(c, choices)?.form.name ?? '整个星球', `大小：${PLANET_SIZES[c.psize].name}`] : [WORLD_TYPE_INFO[c.type].name, MAP_SIZES[c.size].name];
  const h = c.human;
  const people = !h.on ? '不生成人文' : h.countries.on ? (h.settlements.on ? '带国家和城市' : '带国家') : '只有人口和文化';
  return [...what, ...(Object.keys(c.terrain).length ? ['地形调过'] : []), ...(c.human.library ? [packLabel(lib, [c.human.library])] : []), people].join(' · ');
}
