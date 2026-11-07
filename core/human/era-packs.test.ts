import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { builtinOf } from '../content/registry';
import { digest } from '../digest';
import { Engine } from '../engine';
import { DEFAULT_STYLE, worldStyleId } from '../name-styles';
import { findPack, ownItems, packItems } from '../packs';
import { BASE_PATH, DEFAULT_WORLD_PACKS, FORMS_PATH, builtinPacks, isBuiltinSame } from '../packs/builtin-tree';
import { REAL_RIVER_TYPES } from '../packs/water';
import { BUILTIN_ERAS, ERA_PACKS } from '../packs/eras';
import { BUILTIN_GOVERNMENTS } from '../packs/governments';
import { packImportCommands, packImportPlan } from '../packs/import';
import { DEFAULT_SPECIES } from '../packs/nature';
import { BUILTIN_PLANET_FORMS } from '../packs/planet-forms';
import { biomeHabitability, classHabitability } from './habitability';
import { biomeMovement } from './terrain-class';
import { worldEra, worldDimensions } from './era';
import { eraGovernments } from './government';
import { BUILTIN_CLASSES, GENERAL_RESOURCES } from '../packs/base';
import { NO_CURRENTS, engineFor, humanDigest, importPacks, meshFor, seedCommands, setGroupWeights } from '../testing/fixtures';
import type { World } from '../world';
import { writeFileSync } from 'node:fs';
import { r29Digest } from '../testing/r29';
import saved from './r29-digests.json';

// 第三十轮：时代就是资源包，生成只读世界里的内容（见 packs/import.ts、human/generate.ts、content/missing.ts）

const LIB = builtinPacks();
const BUILTIN_RESOURCES_IDS = () => GENERAL_RESOURCES.map((r) => r.id);

// 与第二十九轮的代码同样的设置下生成的摘要（r29-digests.json 是用第二十九轮的代码记下的：同一块大陆、同样的时代与文化组，
// 生成人文 + 国家 + 城市地标；再“重新生成国家”一遍）。第三十二轮地形变了（大格局），用第三十二轮的代码重录一次：
// 第三十三轮（平原与河口，高程变了）再重录一次。第四十三轮：内置的文化、宗教、政体换成 EU4 的，几种设置的组换成 EU4 的组
// （日耳曼、汉、阿尔泰……）后重录；没有人文的那一项（nature）没变。
// 第五十五轮重录：生态跟高度走（第五十一轮记着的奇幻的 resource 这次一起进了文件）。去掉高度范围时还是以前的值，见 core/biome-legacy.test.ts。
// 第五十七轮重录：只有 resource（14 项）：毛皮多一种生态（高山苔原）。现实的水系一项都不变（core/water-real.test.ts）。
// 第七十四轮重录：国家有意改了（各时代的历史格局、民族主义）。有国家的几项里人口（首都一带、移民、殖民地的新土认同）、群体、人文、
// 国家、集团、城市、道路、地标、省名（省名按住着的文化）跟着变，现代的地物名也是；没有国家的 nature、medieval-pop 和宜居度、地形类别、资源一项没变。
// 第七十五轮重录：奇幻（种族王国）、科幻（殖民据点）的国家有意改了，这两种设置里人文的几项跟着变；古典、中世纪、近现代、现代只重录 countries：
// 档案多了格局里的角色（role），核对过不写 role 时这四个时代的 14 项与原来的值逐个相同。
// R29_RECORD=1 npx vitest run core/human/era-packs.test.ts（只在有意改变结果时）
// 第七十七轮：生成的命令不再写权重、“分裂 ↔ 统一”、格局，human 只记组的 id、countryRules 只有种子，组带着库里的比重，没有格局。只重录 13 项的 human（人口、国家、城市、地名……一个没变）；核对过两边的世界只差这几样（见 docs/dev/history/第77轮.md）
const record = !!process.env.R29_RECORD;
const old: Record<string, unknown> = record ? {} : saved;
const check = (got: unknown, key: string) => {
  if (record) old[key] = got;
    else expect(got, key).toEqual(r29Digest(key));
};
const SCENES = [
  { id: 'medieval', era: 'medieval', groups: [['germanic', 3], ['chinese', 3], ['levantine', 2], ['hindustani', 2], ['east-slavic', 1.5], ['altaic', 1.5]], countries: true, settlements: true },
  { id: 'antiquity', era: 'antiquity', groups: [['latin', 3], ['levantine', 3], ['chinese', 3]], countries: true, settlements: false },
  { id: 'industrial', era: 'industrial', groups: [['germanic', 3], ['chinese', 3], ['east-slavic', 2]], countries: true, settlements: true },
  { id: 'modern', era: 'modern', groups: [['chinese', 4], ['hindustani', 4], ['kongo', 3], ['germanic', 2]], countries: true, settlements: true },
  { id: 'fantasy', era: 'fantasy', groups: [['germanic', 3], ['elven', 2], ['dwarven', 1.5], ['orcish', 1.5]], countries: true, settlements: true },
  { id: 'scifi', era: 'scifi', groups: [['chinese', 3], ['tidal', 1.5], ['lithic', 1.5]], countries: true, settlements: false },
  // 第五十一轮：奇幻、科幻不带 EU4 的文化，这两种设置里的日耳曼、汉由 packImportCommands 在资源库里找（比重不是 0 的第一个）
  { id: 'medieval-pop', era: 'medieval', groups: [['germanic', 1], ['scandinavian', 2]], countries: false, settlements: false },
] as const;

let base: Engine | null = null;
function world(): Engine {
  if (!base) {
    base = engineFor({ cells: 12000, seed: 1, latNorth: 72, latSouth: 20 });
    // 第四十六轮：与 continents() 一样关掉区域的洋流（见 fixtures 的 NO_CURRENTS）
    base.exec(NO_CURRENTS);
    base.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    base.exec({ op: 'generate_provinces', rules: { seed: 5 } });
  }
  return base.clone();
}

const groupsOf = (g: readonly (readonly [string, number])[]) => g.map(([id, weight]) => ({ id, weight }));

// 第七十六轮：中文地名风格的模板“某某沙漠 / 冻原 / 冰原”改成“荒漠 / 苔原 / 冰盖”，重录变了的几项（地名、小数据里的地名风格、世界文件）；核对过两边的世界只差这三个字
describe('生成只读世界里的内容', () => {
  it('不先加时代包：不生成人文，结果里写明缺时代（命令照样能执行，不报错）', () => {
    const eng = world();
    eng.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'] });
    expect(eng.world.small.human).toBeUndefined();
    expect(eng.lastSkipped[0]).toMatch(/^没有时代/);
    // 有时代、没有文化：也不生成，写明缺文化
    importPacks(eng, { packs: [['medieval']], groups: [] });
    expect(eng.world.small.content?.era?.medieval).toBeDefined();
    expect(eng.world.small.content?.culture).toBeUndefined();
    eng.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'] });
    expect(eng.world.small.human).toBeUndefined();
    expect(eng.lastSkipped[0]).toMatch(/^没有文化/);
  });

  it('生成人文的结果与第二十九轮同样的设置一样（时代、文化、人口、国家、城市地标、地名的摘要逐个相同；清理过再生成国家也一样）', () => {
    const base = world();
    check(humanDigest(base.world), 'nature');
    for (const sc of SCENES) {
      const e = base.clone();
      const groups = groupsOf(sc.groups);
      importPacks(e, { packs: [[sc.era]], groups: groups.map((g) => g.id) });
      // 第七十七轮：各组占多少是世界里组的比重（以前是命令写的权重）：写进世界里的组，命令只写 id，结果逐值相同
      setGroupWeights(e, groups);
      e.exec({ op: 'generate_human', packs: [[sc.era]], groups: groups.map((g) => g.id), ...(sc.countries ? { countries: {} } : {}), ...(sc.settlements ? { settlements: {} } : {}) });
      check(humanDigest(e.world), sc.id);
      expect(e.world.small.genStamp?.packs).toEqual([[sc.era]]);
      if (!sc.countries) continue;
      // 重新生成之前再加一遍（界面的 withPackImports；世界里都有，只排回包里的先后），结果与第二十九轮一样
      importPacks(e, { packs: [[sc.era]], groups: groups.map((g) => g.id) });
      e.exec({ op: 'regenerate_countries', seed: 9 });
      check(humanDigest(e.world), `${sc.id}:again`);
    }
    if (record) writeFileSync(new URL('./r29-digests.json', import.meta.url), `${JSON.stringify(old, null, 1)}\n`);
  });

  it('加进来的每一项记着来源（时代包里的小包）；生成后都留着', () => {
    const eng = world();
    importPacks(eng, { packs: [['medieval']], groups: ['germanic'] });
    const o = eng.world.small.origin!;
    expect(o.era.medieval).toEqual(['medieval', 'era']);
    expect(o.government['feudal-monarchy']).toEqual(['medieval', 'governments']);
    expect(o.cultureGroup.germanic).toEqual(['medieval', 'cultures', 'germanic']);
    expect(o.nameStyle['west-germanic']).toEqual(['medieval', 'cultures', 'germanic']);
    // 中文·默认是新建时从默认的库“地名 ▸ 中文”加进来的
    expect(o.nameStyle[DEFAULT_STYLE]).toEqual(['medieval', 'names', 'zh']);
    const govs = Object.keys(eng.world.small.content!.government!);
    expect(govs).toEqual(ERA_PACKS.get('medieval')!.governments);
    eng.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'], countries: {} });
    expect(Object.keys(eng.world.small.content!.government!)).toEqual(govs);
    expect(eng.lastRemoved).toEqual([]);
    // 整理才移出（界面判断是不是内置原样，内置原样的不另存）
    const plan = eng.planTidy();
    expect(plan.removed.some((r) => r.kind === 'government')).toBe(true);
    expect(plan.removed.every((r) => isBuiltinSame(r.kind, r.item))).toBe(true);
  });
});

describe('几个包合起来生成', () => {
  const combo = (packs: string[][]) => {
    const eng = world();
    const groups = ['germanic', 'elven'];
    importPacks(eng, { packs, groups });
    setGroupWeights(eng, groups.map((id) => ({ id, weight: 1 })));
    eng.exec({ op: 'generate_human', packs, groups, countries: {} });
    return eng;
  };

  it('中世纪 + 奇幻：规则和维度来自中世纪，政体、派系、文化是两个包的合集', () => {
    const eng = combo([['medieval'], ['fantasy']]);
    const small = eng.world.small;
    expect(small.human!.era).toBe('medieval');
    expect(worldEra(small)!.id).toBe('medieval');
    expect(worldDimensions(small).map((d) => d.id)).toEqual(['religion']);
    // 只带了规则包的时代项；取值只带中世纪的维度（宗教）的，奇幻的种族不带
    const plan = packImportPlan(LIB, { packs: [['medieval'], ['fantasy']], groups: ['germanic', 'elven'] });
    expect(plan.era).toEqual({ id: 'medieval', path: ['medieval', 'era'] });
    const fresh = world();
    for (const c of plan.commands) fresh.exec(c);
    expect(Object.keys(fresh.world.small.content!.era!)).toEqual(['medieval']);
    expect(new Set(Object.values(fresh.world.small.content!.popValue!).map((v) => (v as { dimension: string }).dimension))).toEqual(new Set(['religion']));
    // 政体是两个包的合集，先中世纪、后奇幻（同一个政体只带一次）
    const govs = eraGovernments(fresh.world.small).map((g) => g.id);
    const want = [...new Set([...ERA_PACKS.get('medieval')!.governments, ...ERA_PACKS.get('fantasy')!.governments])];
    expect(govs).toEqual(want);
    expect(Object.keys(fresh.world.small.content!.cultureGroup!)).toEqual(['germanic', 'elven']);
    // 时代包里奇幻的生态、河湖、资源不带（要单独勾那几个小包）
    expect(fresh.world.small.species.length).toBe(DEFAULT_SPECIES.length);
    expect(fresh.world.small.riverTypes?.map((t) => t.id)).toEqual(REAL_RIVER_TYPES.map((t) => t.id));
  });

  it('顺序反过来：规则来自奇幻（维度是种族、宗教）', () => {
    const eng = combo([['fantasy'], ['medieval']]);
    const small = eng.world.small;
    expect(small.human!.era).toBe('fantasy');
    expect(worldDimensions(small).map((d) => d.id)).toEqual(BUILTIN_ERAS.find((e) => e.id === 'fantasy')!.dimensions.map((d) => d.id));
    expect(small.genStamp!.packs).toEqual([['fantasy'], ['medieval']]);
  });

  it('单独勾奇幻的生态小包时才带进奇幻的生态（没写自然生成的关掉），来源是那个小包', () => {
    const eng = world();
    for (const c of packImportCommands(LIB, { packs: [['fantasy', 'biomes']] }, eng.world)) eng.exec(c);
    const fant = packItems<{ id: string }>(findPack(LIB.find((p) => p.id === 'fantasy')!, ['biomes'])!, 'biomes');
    expect(eng.world.small.species.length).toBe(DEFAULT_SPECIES.length + fant.length);
    expect(eng.world.small.origin!.biome[fant[0].id]).toEqual(['fantasy', 'biomes']);
    expect(eng.world.small.species.find((s) => s.id === fant[0].id)!.natural).toBe((fant[0] as { natural?: boolean }).natural ?? false);
  });

  it('再加一遍是空的（世界里都有了）；排先后的命令只在先后不一样时改世界', () => {
    const eng = world();
    importPacks(eng, { packs: [['modern']], groups: ['chinese'] });
    const again = packImportCommands(LIB, { packs: [['modern']], groups: ['chinese'] }, eng.world);
    expect(again.flatMap((c) => (c.op === 'batch' ? c.commands : [c])).filter((c) => c.op !== 'order_content')).toEqual([]);
    const before = JSON.stringify(eng.world.small);
    for (const c of again) eng.exec(c);
    expect(JSON.stringify(eng.world.small)).toBe(before);
  });

  it('order_content：列着的排进它们占着的位置，没列的不动', () => {
    const eng = world();
    importPacks(eng, { packs: [['medieval']], groups: [] });
    const ids = Object.keys(eng.world.small.content!.government!);
    eng.exec({ op: 'order_content', kind: 'government', ids: [ids[2], ids[0]] });
    expect(Object.keys(eng.world.small.content!.government!)).toEqual([ids[2], ids[1], ids[0], ...ids.slice(3)]);
    eng.undo();
    expect(Object.keys(eng.world.small.content!.government!)).toEqual(ids);
  });
});

describe('基础、自然、地名都是普通内容：缺了跳过并写明', () => {
  const settings = { cells: 3000, seed: 4 };
  const bare = (packs: readonly (readonly string[])[]) => {
    const eng = new Engine(settings, meshFor(settings));
    const cmds = packImportCommands(LIB, { packs });
    eng.exec({ op: 'batch', commands: [...cmds.flatMap((c) => (c.op === 'batch' ? c.commands : [c])), { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true }] });
    return eng;
  };

  it('新建时默认的几个包：基础、自然、中文地名、画风（第三十八轮）、国家等级（第四十二轮）、水系（第五十七轮）', () => {
    expect(DEFAULT_WORLD_PACKS).toEqual([BASE_PATH, ['medieval', 'nature'], ['medieval', 'names', 'zh'], ['medieval', 'styles'], ['medieval', 'tiers'], ['medieval', 'water']]);
    const eng = bare(DEFAULT_WORLD_PACKS);
    expect(eng.lastSkipped).toEqual([]);
    const s = eng.world.small;
    expect(s.species.map((x) => x.id)).toEqual(DEFAULT_SPECIES.map((x) => x.id));
    expect(s.islandTypes!.map((t) => t.id)).toEqual(['continental', 'low', 'atoll', 'reef', 'shards']);
    expect(worldStyleId(s)).toBe(DEFAULT_STYLE);
    expect(eng.world.derived.features.some((f) => f.name)).toBe(true);
    // 新世界默认的内容就是 seedCommands
    expect(seedCommands()).toEqual(packImportCommands(LIB, { packs: DEFAULT_WORLD_PACKS }));
  });

  it('什么都不勾：没有生态、地形类别、资源、岛的种类、地名风格，各自跳过、写明，不报错', () => {
    const eng = bare([]);
    expect(eng.lastSkipped).toEqual(['没有生态：植被为空', '没有地形类别：类别层为空，通行、宜居按平地算', '没有资源：没有资源层', '没有岛的种类：放的岛都是普通的岛', '没有地名风格：不起名']);
    const w = eng.world;
    expect(w.derived.dominant.every((x) => x < 0)).toBe(true);
    expect(w.derived.terrainClass.every((x) => x === 0)).toBe(true);
    expect(w.derived.resource.every((x) => x === 0)).toBe(true);
    expect(w.derived.features.length).toBeGreaterThan(0);
    expect(w.derived.features.every((f) => f.name === '')).toBe(true);
    // 放岛：普通的岛（编号 0）
    eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'continental', size: 300, variant: 0 } });
    expect(w.causes.islandType.every((x) => x === 0)).toBe(true);
    eng.exec({ op: 'generate_provinces', rules: { seed: 4 } });
    expect(Object.values(w.small.provinces).every((p) => p.name === '')).toBe(true);
    // 生成人文：时代包照样能用（没有地形类别时宜居按平地算）；没有城市等级、地标类型时不放城市、地标
    importPacks(eng, { packs: [['medieval']], groups: ['germanic'] });
    eng.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'], countries: {}, settlements: {} });
    expect(w.small.human).toBeDefined();
    expect(Object.keys(w.small.cities ?? {})).toEqual([]);
    expect(eng.lastSkipped).toContain('没有城市等级：没有放城市和道路');
  });

  it('只有生态和资源、没有地形类别：类别层为空，资源规则里的类别按平地算', () => {
    const eng = new Engine(settings, meshFor(settings));
    const ids = BUILTIN_RESOURCES_IDS();
    const cmds = packImportCommands(LIB, { packs: [['medieval', 'nature']], extra: [{ path: [...BASE_PATH], picks: { resources: ids } }] });
    eng.exec({ op: 'batch', commands: [...cmds.flatMap((c) => (c.op === 'batch' ? c.commands : [c])), { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true }] });
    const w = eng.world;
    expect(Object.keys(w.small.content!.resource!)).toEqual(ids);
    expect(w.small.content!.terrainClass).toBeUndefined();
    expect(eng.lastSkipped).toContain('没有地形类别：类别层为空，通行、宜居按平地算');
    expect(w.derived.terrainClass.every((x) => x === 0)).toBe(true);
    // 粮食只写了平地的条件：照样长；只写了山地的（锡）不长
    const code = (id: string) => ids.indexOf(id) + 1;
    expect(w.derived.resource.some((x) => x === code('grain'))).toBe(true);
    expect(w.derived.resource.some((x) => x === code('tin'))).toBe(false);
  });

  it('只缺城市等级、地标类型：城市、地标各自跳过', () => {
    const eng = bare(DEFAULT_WORLD_PACKS);
    const ranks = Object.keys(eng.world.small.content!.cityRank!);
    eng.exec({ op: 'batch', commands: ranks.map((id) => ({ op: 'set_content', kind: 'cityRank', id, item: null }) as Command) });
    importPacks(eng, { packs: [['medieval']], groups: ['germanic'] });
    const marks = Object.keys(eng.world.small.content!.landmarkType!);
    eng.exec({ op: 'batch', commands: marks.map((id) => ({ op: 'set_content', kind: 'landmarkType', id, item: null }) as Command) });
    eng.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'], countries: {}, settlements: {} });
    expect(eng.world.small.countries).toBeDefined();
    expect(Object.keys(eng.world.small.cities ?? {})).toEqual([]);
    expect(Object.keys(eng.world.small.landmarks ?? {})).toEqual([]);
    expect(eng.lastSkipped).toEqual(['没有城市等级：没有放城市和道路', '没有地标类型：没有放地标']);
  });

  it('没有政体：不生成国家，写明', () => {
    const eng = bare(DEFAULT_WORLD_PACKS);
    importPacks(eng, { packs: [['medieval']], groups: ['germanic'] });
    const govs = Object.keys(eng.world.small.content!.government!);
    eng.exec({ op: 'batch', commands: govs.map((id) => ({ op: 'set_content', kind: 'government', id, item: null }) as Command) });
    eng.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'], countries: {} });
    expect(eng.world.small.human).toBeDefined();
    expect(eng.world.small.countries).toBeUndefined();
    expect(eng.lastSkipped).toContain('没有政体：没有生成国家');
  });

  it('档案里换成世界里没有的政体：报错，说先从资源库添加（引擎不再从内置的复制）', () => {
    const eng = world();
    importPacks(eng, { packs: [['medieval']], groups: ['germanic'] });
    eng.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'], countries: {} });
    const id = Number(Object.keys(eng.world.small.countries!)[0]);
    const unused = BUILTIN_GOVERNMENTS.find((g) => !eng.world.small.content!.government![g.id])!;
    expect(() => eng.exec({ op: 'set_country', id, patch: { government: unused.id } })).toThrow('先从资源库添加它');
    eng.exec({ op: 'set_content', kind: 'government', id: unused.id, item: unused as unknown as Record<string, unknown>, from: ['medieval', 'governments'] });
    eng.exec({ op: 'set_country', id, patch: { government: unused.id } });
    expect(eng.world.small.countries![id].government).toBe(unused.id);
  });
});

describe('生态、地形类别自己带的字段替代按 id 查的算法表', () => {
  // 第二十九轮的 BIOME_HABITABILITY、BIOME_MOVEMENT、features.ts 的大类、CLASS_HABITABILITY（逐个抄下来对）
  const OLD_HAB: Record<string, number> = { ice: 0.002, tundra: 0.1, taiga: 0.31, temperate_forest: 0.72, steppe: 0.6, shrubland: 0.71, subtropical_forest: 0.68, savanna: 0.57, dry_forest: 0.54, monsoon_forest: 0.53, rainforest: 0.25, wetland: 0.18, desert: 0.042 };
  const OLD_MOVE: Record<string, number> = { ice: 3, tundra: 1.3, taiga: 1.4, temperate_forest: 1.3, steppe: 1, shrubland: 1.25, subtropical_forest: 1.4, savanna: 1, dry_forest: 1.25, monsoon_forest: 1.8, rainforest: 2, wetland: 2, desert: 1.5 };
  const OLD_GROUP: Record<string, string> = { ice: 'icecap', tundra: 'tundra', taiga: 'forest', temperate_forest: 'forest', subtropical_forest: 'forest', dry_forest: 'forest', monsoon_forest: 'forest', rainforest: 'forest', wetland: 'wetland', desert: 'desert' };
  const OLD_CLASS: Record<string, number> = { plains: 1, hills: 0.92, highlands: 0.82, mountains: 0.5, peaks: 0.09 };

  it('内置 13 种生态（第五十五轮多的两种高山生态不算）的宜居度、通行难度、大类与原来的表逐个相同；5 种地形类别的宜居倍数也相同', () => {
    for (const sp of DEFAULT_SPECIES.filter((x) => !x.id.startsWith('alpine_'))) {
      expect(biomeHabitability(sp), sp.id).toBe(OLD_HAB[sp.id]);
      expect(biomeMovement(sp), sp.id).toBe(OLD_MOVE[sp.id]);
      expect(sp.group, sp.id).toBe(OLD_GROUP[sp.id]);
      expect(sp.natural).toBe(true);
    }
    for (const c of BUILTIN_CLASSES) expect(classHabitability(c), c.id).toBe(OLD_CLASS[c.id]);
    // 没写的按中性的估法（与以前给自己做的生态的一样）
    expect(biomeMovement({ id: 'x', terrain: 'plains' })).toBe(1);
    expect(classHabitability({ ...BUILTIN_CLASSES[0], habitability: undefined })).toBe(1);
  });

  it('没有生态的世界：植被为空，照常生成地形、省份，不报错', () => {
    const settings = { cells: 3000, seed: 4 };
    const eng = new Engine(settings, meshFor(settings));
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 4 } });
    expect(eng.world.small.species).toEqual([]);
    expect(eng.world.derived.dominant.every((x) => x < 0)).toBe(true);
  });
});

describe('星球形态：以前的六种星球是每个库“星球形态”里的普通形态', () => {
  it('每一种都在那个小包里，用它新建的世界与以前选那种星球新建的逐值相同', () => {
    const forms = ownItems(findPack(LIB.find((p) => p.id === FORMS_PATH[0])!, FORMS_PATH.slice(1))!, 'planetForms');
    expect(forms).toEqual(BUILTIN_PLANET_FORMS);
    // 以前的 PLANET_TYPES：生成器的种类 + 岛多少（海洋星球是 0.7）
    const OLD = [
      ['continents', 'continents', undefined],
      ['continent', 'continent', undefined],
      ['fragmented', 'fragmented', undefined],
      ['archipelago', 'archipelago', undefined],
      ['ocean_islands', 'ocean', 0.7],
      ['blank', 'ocean', undefined],
    ] as const;
    expect(BUILTIN_PLANET_FORMS.map((f) => f.id)).toEqual(OLD.map((o) => o[0]));
    const settings = { cells: 4000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 };
    const arrays = (w: World) => digest([w.causes, Object.fromEntries(Object.entries(w.derived).filter(([k]) => k !== 'scriptIssues'))]);
    for (const [id, type, islands] of OLD) {
      const form = BUILTIN_PLANET_FORMS.find((f) => f.id === id)!;
      const a = engineFor(settings);
      a.exec({ op: 'set_worldgen', params: { seed: 11, type, ...(islands !== undefined ? { islands } : {}) }, reset: true });
      const b = engineFor(settings);
      b.exec({ op: 'set_worldgen', params: { seed: 11, type: form.base, form }, reset: true });
      expect(arrays(b.world), id).toBe(arrays(a.world));
      expect(b.history.at(-1)!.summary).toBe(`新世界“${form.name}”`);
    }
  });
});

describe('内置的树（第三十轮）', () => {
  it('时代项只有规则；时代包有时代、维度的取值、政体、派系、地标、文化组的小包（带默认权重）', () => {
    for (const era of BUILTIN_ERAS) {
      for (const k of ['governments', 'factions', 'defaultGroups', 'cultureGroups', 'resources']) expect(era, `${era.id}.${k}`).not.toHaveProperty(k);
      const top = LIB.find((p) => p.id === era.id)!;
      expect(ownItems(findPack(top, ['era'])!, 'eras')).toEqual([era]);
      expect(packItems<{ id: string }>(findPack(top, ['governments'])!, 'governments').map((g) => g.id)).toEqual(ERA_PACKS.get(era.id)!.governments);
      const cultures = findPack(top, ['cultures'])!;
      // 时代默认带的在前（第五十一轮：别的 EU4 文化组在后面，比重是 0）
      expect(cultures.packs!.filter((g) => g.weight !== 0).map((g) => [g.id, g.weight])).toEqual(ERA_PACKS.get(era.id)!.cultures.map(([id, w]) => [id, w]));
      expect(cultures.packs!.slice(0, ERA_PACKS.get(era.id)!.cultures.length).every((g) => g.weight !== 0)).toBe(true);
      expect(packItems(findPack(top, ['landmarks'])!, 'landmarkTypes').length).toBeGreaterThan(0);
    }
  });

  it('登记表的内置项由树给出（主线程接上）；中文·默认在每个库的“地名 ▸ 中文”', () => {
    expect(builtinOf('biome')).toEqual(expect.arrayContaining(DEFAULT_SPECIES));
    expect(builtinOf<{ id: string }>('era').map((e) => e.id)).toEqual(BUILTIN_ERAS.map((e) => e.id));
    for (const top of LIB) expect(ownItems<{ id: string }>(findPack(top, ['names', 'zh'])!, 'nameStyles').map((s) => s.id)).toEqual([DEFAULT_STYLE]);
  });
});
