import type { Command } from '../commands';
import { digest } from '../digest';
import { Engine } from '../engine';
import type { Mesh } from '../mesh';
import { type PackNode, type PackItem, PACK_FORMAT, PACK_VERSION, type ResourcePack } from '../packs';
import { builtinPacks } from '../packs/builtin-tree';
import { FANTASY_BIOMES, FANTASY_FIELDS } from '../packs/fantasy-biomes';
import { FANTASY_FORMS } from '../packs/fantasy-forms';
import { FANTASY_LAKE_TYPES } from '../packs/fantasy-lakes';
import { FANTASY_RIVER_TYPES } from '../packs/fantasy-rivers';
import { type ImportPicks, newWorldContentCommands, packImportCommands } from '../packs/import';
import { BUILTIN_STYLES } from '../packs/names';
import type { NameStyle } from '../name-styles';
import { type Settings, type World, buildMeshFor, meshKey, settingsSchema } from '../world';
import { BUILTIN_ERAS } from '../packs/eras';
import { COUNTRY_KM2 } from '../human/countries';
import type { Era } from '../human/era';
import { ruleEra } from '../human/generate';
import { type ProvinceRules, worldProvinceRules } from '../province-rules';

// 测试共用的世界：网格按设置缓存；建好的世界按名字留一份模板，每次给出它的副本（Engine.clone），
// 不必每个测试都从头生成一遍。副本与重新生成的世界逐值相同（推导只取决于原因）。
// 第三十轮：新世界里没有内容（生态、基础、中文地名都从资源包加进来），这里建的世界默认先加上新建时默认勾上的几个包
// （与向导新建的一样：基础、自然、中文地名），bare 时什么都不加

// 一个世界里人文与地图的摘要（第三十轮的 r29-digests.json 就是它记的；第五十一轮以前 human 里的 packs 不算，所以去掉它不改摘要）
export function humanDigest(w: World): Record<string, string> {
  const c = w.causes;
  const s = w.small;
  return {
    pop: digest([c.popTotal, c.popGroup, c.popShare]),
    popGroups: digest(s.popGroups ?? null),
    human: digest(s.human ?? null),
    country: digest(c.country ?? null),
    countries: digest(s.countries ?? null),
    blocs: digest(s.blocs ?? null),
    cities: digest(s.cities ?? null),
    roads: digest(s.roads ?? null),
    landmarks: digest(s.landmarks ?? null),
    provinces: digest(Object.values(s.provinces).map((p) => [p.name, p.orig ?? ''])),
    features: digest(w.derived.features.map((f) => [f.key, f.name, f.orig ?? ''])),
    habitability: digest(w.derived.habitability),
    terrainClass: digest(w.derived.terrainClass),
    resource: digest(w.derived.resource),
  };
}

const meshes = new Map<string, Mesh>();

export function meshFor(raw: Partial<Settings>): Mesh {
  const s = settingsSchema.parse(raw);
  const key = meshKey(s);
  let m = meshes.get(key);
  if (!m) meshes.set(key, (m = buildMeshFor(s)));
  return m;
}

// 新世界默认加的内容（基础、自然、中文地名）：一条 batch
let seedCmds: Command[] | null = null;
// 第八十六轮：退回第八十五轮的地形时（testing/round85.ts）新世界也不加那时没有的红树林
export const fixtureFlags = { noMangrove: false };
export const seedCommands = (): Command[] => {
  seedCmds ??= newWorldContentCommands();
  return fixtureFlags.noMangrove ? withoutMangrove(seedCmds) : seedCmds;
};
function withoutMangrove(cmds: readonly Command[]): Command[] {
  const one = (c: Command): Command[] => {
    if (c.op === 'batch') return [{ ...c, commands: c.commands.flatMap(one) }];
    return c.op === 'add_species' && c.species.id === 'mangrove' ? [] : [c];
  };
  return cmds.flatMap(one);
}

// 没有现实水系的世界（第五十七轮，core/water-real.test.ts 拿它和带着的对照；要自己定河湖类型的测试用它）
export function withoutWater(cmds: readonly Command[]): Command[] {
  const one = (c: Command): Command[] => {
    if (c.op === 'batch') return [{ ...c, commands: c.commands.flatMap(one) }];
    return c.op === 'set_river_type' || c.op === 'set_lake_type' ? [] : [c];
  };
  return cmds.flatMap(one);
}

// 第五十五轮之前的生态：内置生态去掉高度范围，也去掉那两种高山生态（biome-legacy.test.ts 拿它和那时记下的摘要对照）；
// 第五十七轮起也去掉现实的水系（那时还没有），毛皮的规则也写回去（高山苔原是第五十七轮加的）
export function withoutHeights(cmds: readonly Command[]): Command[] {
  const one = (c: Command): Command[] => {
    if (c.op === 'batch') return [{ ...c, commands: c.commands.flatMap(one) }];
    if (c.op === 'set_river_type' || c.op === 'set_lake_type') return [];
    // 第五十八轮：地形类别的典型高度那时也没有（地图不读它，只差在小数据的摘要上）
    if (c.op === 'set_content' && c.kind === 'terrainClass' && c.item) {
      const { height: _, ...item } = c.item as unknown as { height?: number };
      return [{ ...c, item } as unknown as Command];
    }
    if (c.op === 'set_content' && c.kind === 'resource' && c.id === 'fur' && c.item) {
      const item = c.item as unknown as { rules: { biomes?: string[] }[] };
      return [{ ...c, item: { ...c.item, rules: item.rules.map((r) => (r.biomes ? { ...r, biomes: r.biomes.filter((b) => b !== 'alpine_tundra') } : r)) } }];
    }
    if (c.op !== 'add_species') return [c];
    // 第八十六轮的红树林那时也没有
    if (c.species.id.startsWith('alpine_') || c.species.id === 'mangrove') return [];
    const { height: _, ...species } = c.species;
    return [{ ...c, species }];
  };
  return cmds.flatMap(one);
}

// 给一个新的引擎加上默认的内容（与新建世界时一样，在一切之前）
export function seedEngine(eng: Engine): Engine {
  for (const c of seedCommands()) eng.exec(c);
  return eng;
}

// 只要世界（测试纯函数用）：新引擎加上默认的内容后的世界
export function seededWorld(input: Partial<Settings> = {}, mesh?: Mesh): World {
  const e = new Engine(input, mesh);
  seedEngine(e);
  return e.world;
}

// noWater：没有现实的水系（测试自己定河湖类型时：类型的下标从 1 起，没有类型的世界里没有 riverType 这个键）
export function engineFor(settings: Partial<Settings>, opts: { bare?: boolean; noWater?: boolean } = {}): Engine {
  const eng = new Engine(settings, meshFor(settings));
  if (opts.noWater) {
    for (const c of withoutWater(seedCommands())) eng.exec(c);
    return eng;
  }
  return opts.bare ? eng : seedEngine(eng);
}

// 加上默认内容的新引擎（网格不缓存时用；与 new Engine 一样的参数）
export function seededEngine(settings: Partial<Settings> = {}, mesh?: Mesh): Engine {
  return seedEngine(new Engine(settings, mesh));
}

// 第五十五轮之前的生态的新引擎（同 seededEngine）：比的是算法和旧的代码逐值相同（记着旧代码的值、与生态无关）的测试用它
export function plainEngine(settings: Partial<Settings> = {}, mesh?: Mesh): Engine {
  const eng = new Engine(settings, mesh);
  for (const c of withoutHeights(seedCommands())) eng.exec(c);
  return eng;
}

const templates = new Map<string, Engine>();

export function snapshot(key: string, build: () => Engine): Engine {
  let t = templates.get(key);
  if (!t) templates.set(key, (t = build()));
  return t.clone();
}

// 几个测试文件共用的大陆世界：1.2 万格、北纬 20°–72°、陆地 40%；provinces：再划好省份。
// 第四十六轮：一块地区有了洋流（默认强弱 1）。这个世界核对的是人文、地名、河这些，关掉洋流（强弱 0，与第四十五轮逐值相同，
// 见 core/ocean-plane.test.ts），它们的金标准与阈值照旧；区域洋流的结果由 golden-hashes、golden-full 与 ocean-plane 的测试管
export const NO_CURRENTS: Command = { op: 'set_planet', patch: { currents: 0 } };
export function continents(opts: { cells?: number; latNorth?: number; latSouth?: number; provinces?: boolean; plain?: boolean; noWater?: boolean } = {}): Engine {
  const { cells = 12000, latNorth = 72, latSouth = 20, provinces = false, plain = false, noWater = false } = opts;
  return snapshot(`continents:${cells}:${latNorth}:${latSouth}:${provinces}:${plain}:${noWater}`, () => {
    const eng = plain ? plainEngine({ cells, seed: 1, latNorth, latSouth }, meshFor({ cells, seed: 1, latNorth, latSouth })) : engineFor({ cells, seed: 1, latNorth, latSouth }, { noWater });
    eng.exec(NO_CURRENTS);
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    if (provinces) eng.exec({ op: 'generate_provinces', seed: 5 });
    return eng;
  });
}

// 同上，没有现实的水系（第五十七轮）：自己定河湖类型的测试 import { dryContinents as continents }
export const dryContinents = (opts: Parameters<typeof continents>[0] = {}): Engine => continents({ ...opts, noWater: true });

// ---------- 人文（第三十轮：生成之前先把时代包的内容加进世界） ----------

// 把这些包里生成要用的内容加进世界（packImportCommands，内置的树）
// weights（第七十七轮）：加进来的文化组写上这个比重（改加进世界的那一项，不多一步：撤销的步数和以前一样）
export function importPacks(eng: Engine, picks: ImportPicks, weights?: ReadonlyMap<string, number>): void {
  const patch = (c: Command): Command => {
    if (c.op === 'batch') return { ...c, commands: c.commands.map(patch) };
    if (c.op !== 'set_content' || c.kind !== 'cultureGroup' || !c.item || !weights?.has(c.id)) return c;
    const w = weights.get(c.id)!;
    const { weight: _, ...rest } = c.item as { weight?: number };
    return { ...c, item: w === 1 ? rest : { ...rest, weight: w } };
  };
  for (const c of packImportCommands(builtinPacks(), picks, eng.world)) eng.exec(patch(c));
}

// 测试里写的文化组：id，或 id 与比重。第七十七轮起生成的命令只写 id，各组占多少是世界里组的比重（cultureGroup.weight，省略为 1）：
// 写了比重的，生成之前把它写进世界里的组（加进来的组改加进来的那一项；世界里已有、比重不同的另用一整步 set_content，和在资源库里改比重一样）。
// 以前命令写的权重照这样换过来，结果逐值相同
export type TestGroup = string | { id: string; weight?: number };
export const groupId = (g: TestGroup): string => (typeof g === 'string' ? g : g.id);
const weightsOf = (groups: readonly TestGroup[]): Map<string, number> => new Map(groups.flatMap((g) => (typeof g === 'string' || g.weight === undefined ? [] : [[g.id, g.weight] as const])));
export function groupWeightCommand(world: World, groups: readonly TestGroup[]): Command | null {
  const out: Command[] = [];
  for (const g of groups) {
    if (typeof g === 'string' || g.weight === undefined) continue;
    if (g.weight === 0) throw new Error(`比重 0 的组不参与生成（${g.id}）：测试里不要这样写`);
    const item = world.small.content?.cultureGroup?.[g.id] as { weight?: number } | undefined;
    if (!item || (item.weight ?? 1) === g.weight) continue;
    const { weight: _, ...rest } = item;
    out.push({ op: 'set_content', kind: 'cultureGroup', id: g.id, item: (g.weight === 1 ? rest : { ...rest, weight: g.weight }) as Record<string, unknown> });
  }
  return out.length ? { op: 'batch', label: '文化组的比重', commands: out } : null;
}
export function setGroupWeights(eng: Engine, groups: readonly TestGroup[]): void {
  const c = groupWeightCommand(eng.world, groups);
  if (c) eng.exec(c);
}

// 先加进时代包（和选的文化组，勾选的包里没有的在别的包里找）、写上比重，再生成
export function generateHuman(eng: Engine, era: string, groups: readonly TestGroup[], more: Record<string, unknown> = {}): string {
  importPacks(eng, { packs: [[era]], groups: groups.map(groupId) }, weightsOf(groups));
  setGroupWeights(eng, groups);
  return eng.exec({ op: 'generate_human', packs: [[era]], groups: groups.map(groupId), ...more } as Command);
}

// ---------- 第七十七轮去掉的生成参数，在测试里换成资源库里的规则（结果逐值相同） ----------

// 以前的“分裂 ↔ 统一”fragmentation f：时代的国家大小换成 countryKm2 × 8^(1−2f)。以前生成时就是这样乘的（同样两个数相乘），
// 平均的国家面积逐值相同；f = 0.5 时就是时代的 countryKm2。eraId 是内置的时代（按它没改过的 countryKm2 算）
export const fragKm2 = (eraId: string, f: number): number => (BUILTIN_ERAS.find((e) => e.id === eraId)!.countryKm2 ?? COUNTRY_KM2) * Math.pow(8, 1 - 2 * f);
// 以前内置的四种格局（core/packs/countries/tiers.json 的 layouts）：以前选了格局时各等级按它的比例，现在写进时代的 tiers，生效的比例逐值相同
export const OLD_LAYOUTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  mixed: { city: 2, small: 3, medium: 2, large: 1.5, empire: 0.6 },
  petty: { city: 3, small: 4, medium: 1.5, large: 0.2, empire: 0 },
  unified: { city: 0.3, small: 0.7, medium: 1, large: 2, empire: 1.5 },
  powers: { city: 0.5, small: 2, medium: 0.4, large: 2.5, empire: 0.6 },
};
// 改世界里规则用的时代（packs 省略时按世界记着的包；世界里要已经有它）：patch 盖在现在的上面，一整步
export function eraCommand(world: World, patch: Partial<Era>, packs?: readonly (readonly string[])[]): Command {
  const era = ruleEra(world.small, packs ?? world.small.genStamp?.packs ?? []);
  if (!era) throw new Error('世界里没有时代');
  return { op: 'set_content', kind: 'era', id: era.id, item: { ...structuredClone(era), ...patch } as unknown as Record<string, unknown> };
}
export function setEra(eng: Engine, patch: Partial<Era>, packs?: readonly (readonly string[])[]): void {
  eng.exec(eraCommand(eng.world, patch, packs));
}

// ---------- 第七十八轮：省份划分的规则是世界里的内容 ----------

// 以前 generate_provinces 的 rules（大小、按地形、无人区、湖……）换成改世界里的“省份划分”（set_content，patch 盖在现在的上面，一整步），
// 再 generate_provinces 只写种子。以前的 size（小 · 中 · 大）是 20 · 40 · 80 格，sizeCells 就是 size。划出来的省份逐值相同
export const OLD_SIZES = { small: 20, medium: 40, large: 80 } as const;
export function provinceRulesCommand(world: World, patch: Partial<ProvinceRules>): Command {
  const now = worldProvinceRules(world.small);
  const item = { ...now, ...patch };
  return { op: 'set_content', kind: 'provinceRules', id: now.id, item: item as unknown as Record<string, unknown> };
}
export function setProvinceRules(eng: Engine, patch: Partial<ProvinceRules>): void {
  eng.exec(provinceRulesCommand(eng.world, patch));
}
// 先改规则（和现在的一样时不多一步），再划分
export function divideProvinces(eng: Engine, patch: Partial<ProvinceRules> = {}, seed?: number): string {
  const now = worldProvinceRules(eng.world.small);
  if (Object.entries(patch).some(([k, v]) => now[k as keyof ProvinceRules] !== v)) setProvinceRules(eng, patch);
  return eng.exec({ op: 'generate_provinces', ...(seed !== undefined ? { seed } : {}) });
}

// 执行生成人文、国家的命令：先把用的包（命令里的 packs，省略时是世界记着的）与选的文化组加进世界（packImportCommands），
// 写上比重（groupWeightCommand），再执行。返回命令的说明。第七十七轮去掉了以前的写法 era（写 packs: [[era]]）
export type HumanCommand = { op: 'generate_human' | 'regenerate_human' | 'generate_countries' | 'regenerate_countries'; packs?: string[][]; groups?: readonly TestGroup[]; [k: string]: unknown };
// era：生成之前改规则用的时代（以前命令里的 fragmentation、layout 换成时代的 countryKm2、tiers，见 fragKm2、OLD_LAYOUTS）
export function humanExec(eng: Engine, cmd: HumanCommand | Command, era?: Partial<Era>): string {
  const c = cmd as HumanCommand;
  if ('era' in c) throw new Error('第七十七轮去掉了 era 的写法：写 packs: [[era]]');
  const h = eng.world.small.human;
  const packs = c.packs ?? (h && eng.world.small.genStamp?.packs) ?? [];
  const groups = c.groups ?? h?.groups ?? [];
  importPacks(eng, { packs, groups: groups.map(groupId) }, weightsOf(groups));
  setGroupWeights(eng, groups);
  if (era) setEra(eng, era, packs);
  const out = { ...c, ...(c.groups ? { groups: c.groups.map(groupId) } : {}), ...(c.packs || c.op === 'generate_human' ? { packs } : {}) };
  return eng.exec(out as unknown as Command);
}

// ---------- 以前的“奇幻生态示例”包（第三十轮起在内置的树“奇幻”里；测试照旧拿它当一个带生态、河湖、星球形态的包） ----------

const asItems = (list: readonly unknown[]): PackItem[] => list as PackItem[];
export const FANTASY_SAMPLE: ResourcePack = {
  format: PACK_FORMAT,
  version: PACK_VERSION,
  id: 'fantasy',
  name: '奇幻生态示例',
  author: 'map_2',
  fields: [...FANTASY_FIELDS],
  biomes: FANTASY_BIOMES,
  riverTypes: asItems(FANTASY_RIVER_TYPES),
  lakeTypes: asItems(FANTASY_LAKE_TYPES),
  planetForms: asItems(FANTASY_FORMS),
};

// 一整步里最后一条（界面生成人文是“加内容 + 生成”的一步，测试看生成的那一条）；不是 batch 时是它自己
export const lastOf = (cmd: Command): Command => (cmd.op === 'batch' ? cmd.commands[cmd.commands.length - 1] : cmd);

// 以前的 set_word_pack（第三十轮去掉了）：把一个文字包当作模板式的地名风格加进世界，设为世界默认（中文·默认还在，
// 生态、河湖的中文模板缺词表时用它）。null：换回中文·默认
export function wordPackCommand(pack: { id: string; name: string; lists: Record<string, string[]>; types: Record<string, unknown> } | null): Command {
  if (!pack) return { op: 'set_name_style', id: 'zh-default' };
  return {
    op: 'batch',
    commands: [
      { op: 'set_content', kind: 'nameStyle', id: pack.id, item: { ...pack, kind: 'template' } as unknown as Record<string, unknown> },
      { op: 'set_name_style', id: pack.id },
    ],
  };
}

// 以前的 FANTASY_PACK（测试里的名字照旧）
export const FANTASY_PACK = FANTASY_SAMPLE;

// 中文·默认（以前的 DEFAULT_PACK：内置的中文文字包）
export const ZH_STYLE = BUILTIN_STYLES.find((s) => s.id === 'zh-default')! as Extract<NameStyle, { kind: 'template' }>;

// 以前的“地名风格示例”包：除中文·默认以外的内置地名风格
export const NAME_STYLES_SAMPLE: ResourcePack = { format: PACK_FORMAT, version: PACK_VERSION, id: 'name-styles', name: '地名风格示例', author: 'map_2', nameStyles: BUILTIN_STYLES.filter((s) => s.id !== 'zh-default') };

// 内置的大包（按 id）
export const builtinPack = (id: string): PackNode => builtinPacks().find((p) => p.id === id)!;

