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
export const seedCommands = (): Command[] => (seedCmds ??= newWorldContentCommands());

// 第五十五轮之前的生态：内置生态去掉高度范围，也去掉那两种高山生态（biome-legacy.test.ts 拿它和那时记下的摘要对照）
export function withoutHeights(cmds: readonly Command[]): Command[] {
  const one = (c: Command): Command[] => {
    if (c.op === 'batch') return [{ ...c, commands: c.commands.flatMap(one) }];
    if (c.op !== 'add_species') return [c];
    if (c.species.id.startsWith('alpine_')) return [];
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

export function engineFor(settings: Partial<Settings>, opts: { bare?: boolean } = {}): Engine {
  const eng = new Engine(settings, meshFor(settings));
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
export function continents(opts: { cells?: number; latNorth?: number; latSouth?: number; provinces?: boolean; plain?: boolean } = {}): Engine {
  const { cells = 12000, latNorth = 72, latSouth = 20, provinces = false, plain = false } = opts;
  return snapshot(`continents:${cells}:${latNorth}:${latSouth}:${provinces}:${plain}`, () => {
    const eng = plain ? plainEngine({ cells, seed: 1, latNorth, latSouth }, meshFor({ cells, seed: 1, latNorth, latSouth })) : engineFor({ cells, seed: 1, latNorth, latSouth });
    eng.exec(NO_CURRENTS);
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    if (provinces) eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    return eng;
  });
}

// ---------- 人文（第三十轮：生成之前先把时代包的内容加进世界） ----------

// 把这些包里生成要用的内容加进世界（packImportCommands，内置的树）
export function importPacks(eng: Engine, picks: ImportPicks): void {
  for (const c of packImportCommands(builtinPacks(), picks, eng.world)) eng.exec(c);
}

// 以前的 generate_human {era, groups, …}：先加进时代包（和选的文化组，勾选的包里没有的在别的包里找），再生成。
// 返回生成的命令（packs 换成了时代包），测试可以拿去比较、重放
export function humanCommand(era: string, groups: readonly { id: string; weight: number; cultures?: string[] }[], more: Record<string, unknown> = {}): Command {
  return { op: 'generate_human', packs: [[era]], groups: groups.map((g) => ({ ...g })), ...more } as Command;
}
export function generateHuman(eng: Engine, era: string, groups: readonly { id: string; weight: number; cultures?: string[] }[], more: Record<string, unknown> = {}): string {
  importPacks(eng, { packs: [[era]], groups: groups.map((g) => g.id) });
  return eng.exec(humanCommand(era, groups, more));
}

// 执行生成人文、国家的命令（以前的写法也认：era 换成 packs: [[era]]）：先把用的包（以前写的时代、命令里的 packs，省略时是世界记着的）
// 与选的文化组加进世界（packImportCommands），再执行。返回命令的说明
export type HumanCommand = { op: 'generate_human' | 'regenerate_human' | 'generate_countries' | 'regenerate_countries'; era?: string; packs?: string[][]; groups?: { id: string; weight: number; cultures?: string[] }[]; [k: string]: unknown };
export function humanExec(eng: Engine, cmd: HumanCommand | Command): string {
  const { era, ...rest } = cmd as HumanCommand;
  const h = eng.world.small.human;
  const packs = rest.packs ?? (era ? [[era]] : h && eng.world.small.genStamp?.packs) ?? [];
  const groups = (rest.groups ?? h?.groups ?? []).map((g) => g.id);
  importPacks(eng, { packs, groups });
  const out = { ...rest, ...(era || rest.packs || cmd.op === 'generate_human' ? { packs } : {}) };
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

