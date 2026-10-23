import { afterEach, describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { Engine } from './engine';
import { DEFAULT_PACK } from './names';
import {
  PACK_MAX,
  PACK_SECTIONS,
  type PackWorld,
  type ResourcePack,
  applyPackCommands,
  biomeFields,
  defaultPicks,
  exportableBiomes,
  newBiomeCells,
  packFileName,
  packForms,
  packFromWorld,
  packProblems,
  parsePack,
  packSummary,
  planPack,
  readPack,
  registerPackSection,
  rewriteRiverRefs,
  scriptRefs,
} from './packs';
import { FANTASY_BIOMES } from './packs/fantasy-biomes';
import { FANTASY_PACK } from './packs/fantasy';
import { FANTASY_FORMS, POLAR_CONTINENTS, TWIN_CONTINENTS } from './packs/fantasy-forms';
import { findScripts } from './script';
import { DEFAULT_SPECIES, type Species, withRect } from './species';
import { continents, engineFor } from './testing/fixtures';
import { riverNet } from './river-types';

// 资源包：格式、检查、用到世界（一整步、撞 id 改名、一模一样的跳过）、从世界导出、内置示例包

const pack = (extra: Partial<ResourcePack> = {}): ResourcePack => ({ format: 'map2-pack', version: 1, id: 'p', name: '测试包', ...extra });

const biome = (id: string, extra: Partial<Species> = {}): Species =>
  withRect({ id, name: id, color: '#336699', terrain: 'plains', competition: 3, tolerances: [], ...extra }, { t0: 0, t1: 20, m0: 0.5, m1: 2 });

// 只有生态、场、文字包的小世界（不用生成地形）
const fakeWorld = (species: Species[] = structuredClone(DEFAULT_SPECIES), fields: string[] = []): PackWorld =>
  ({ small: { species, wordPack: null }, causes: { fields: Object.fromEntries(fields.map((f) => [f, new Float32Array(1)])) } }) as unknown as PackWorld;

describe('资源包的格式', () => {
  it('不认识的部分直接报错，不悄悄丢掉', () => {
    const r = readPack(JSON.stringify({ ...pack(), monsters: [] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toEqual(['不认识的部分：monsters']);
  });

  it('不是 JSON、版本不对、项写错时用中文说出在哪里', () => {
    const bad = readPack('{oops');
    expect(!bad.ok && bad.errors[0]).toMatch(/^不是 JSON 文件/);
    const v2 = readPack(JSON.stringify({ ...pack(), version: 2 }));
    expect(!v2.ok && v2.errors[0]).toBe('这个资源包是第 2 版的格式，这里只认第 1 版');
    const color = readPack(JSON.stringify(pack({ biomes: [{ ...biome('a'), name: '红林', color: 'red' }] })));
    expect(!color.ok && color.errors).toEqual(['生态第 1 个「红林」的 color：颜色需为 #rrggbb']);
    // 河流类型按它的格式查（缺 id、缺颜色都说出来）
    const river = readPack(JSON.stringify(pack({ riverTypes: [{ name: '无名' } as never] })));
    expect(!river.ok && river.errors).toEqual(['河流类型第 1 个「无名」的 id：缺少这一项', '河流类型第 1 个「无名」的 color：缺少这一项']);
    const kept = readPack(JSON.stringify(pack({ riverTypes: [{ id: 'styx', name: '冥河', color: '#2c2742', style: 'dashed' }] })));
    expect(kept.ok && kept.pack.riverTypes).toEqual([{ id: 'styx', name: '冥河', color: '#2c2742', style: 'dashed' }]);
    // 星球形态按 planet-form.ts 的格式查（见下面“资源包里的星球形态”）
  });

  it('记事本存的（开头带 BOM）照样能读；长短、多少不对时说人话', () => {
    expect(readPack(`\uFEFF${JSON.stringify(pack())}`).ok).toBe(true);
    const empty = readPack(JSON.stringify(pack({ id: '' })));
    expect(!empty.ok && empty.errors).toEqual(['资源包的 id：不能是空的']);
    const long = readPack(JSON.stringify(pack({ name: '名'.repeat(61) })));
    expect(!long.ok && long.errors).toEqual(['资源包的名字：太长了，最多 60 个字']);
    // 一个文件里的项有上限（几百种生态一下子加进大星球会算不动）
    const many = readPack(JSON.stringify(pack({ biomes: Array.from({ length: PACK_MAX.biomes + 1 }, (_, k) => biome(`s${k}`)) })));
    expect(!many.ok && many.errors).toEqual([`生态：太多了，最多 ${PACK_MAX.biomes} 个`]);
    expect(readPack('x'.repeat(16_000_001)).ok).toBe(false);
  });

  it('文字包的名字比资源包的允许的长：截短后照样装得进、列得出（读出来的就是合格的资源包）', () => {
    const words = readPack(JSON.stringify({ ...DEFAULT_PACK, id: 'my words/v2', name: '很长的名字'.repeat(20) }));
    expect(words.ok && words.legacy).toBe('wordPack');
    if (!words.ok) return;
    expect(words.pack.name.length).toBe(60);
    expect(words.pack.id).toBe('my-words-v2');
    // 文字包本身原样
    expect(words.pack.textPacks![0].name).toBe('很长的名字'.repeat(20));
    expect(parsePack(words.pack).ok).toBe(true);
  });

  it('旧格式照旧能读：生态数组、文字包，转成资源包走同一条路', () => {
    const list = readPack(JSON.stringify([biome('a'), biome('b')]));
    expect(list.ok && list.legacy).toBe('biomes');
    expect(list.ok && list.pack.biomes?.map((b) => b.id)).toEqual(['a', 'b']);
    const words = readPack(JSON.stringify(DEFAULT_PACK));
    expect(words.ok && words.legacy).toBe('wordPack');
    expect(words.ok && words.pack.textPacks).toEqual([DEFAULT_PACK]);
    expect(readPack('{"a":1}').ok).toBe(false);
  });

  it('列表里的一行、文件名', () => {
    expect(packSummary(FANTASY_PACK)).toMatch(/^生态 5/);
    expect(packSummary(pack({ biomes: [biome('a')], riverTypes: [{ id: 'r' }, { id: 's' }], textPacks: [DEFAULT_PACK] }))).toBe('生态 1 · 河流 2 · 文字包 1');
    expect(packFileName({ id: 'x', name: '我的 奇幻/生态' })).toBe('我的-奇幻-生态.map2pack.json');
  });
});

describe('资源包的检查（不运行脚本）', () => {
  it('重复的 id、悬空的侵占目标、没写的场和河流类型、不存在的词表、太多生态', () => {
    const p = pack({
      fields: ['holy'],
      biomes: [
        biome('a', { effects: { invade: { targets: ['taiga', 'b', 'ghost'], strength: 1 } } }),
        biome('a'),
        biome('b', {
          scripts: { placement: { api: 1, src: "// field('commented')\nreturn field('holy') * field('mana') * field('elevation') * river('lava') + river(name);" } },
          feature: { label: '林', names: [{ p: '{color}{nope}林' }] },
        }),
      ],
      riverTypes: [{ id: 'blood' }],
    });
    expect(packProblems(p)).toEqual([
      '有两个生态的 id 都是 a',
      '「a」侵占的 ghost 不在这个资源包里，也不是内置的生态：世界里没有它时不起作用',
      '「b」用到了自定义场 mana，资源包里没有写这个场（用的时候会新加一个空的）',
      '「b」用到了河流类型 lava，资源包里没有：没有这种河时按离得很远算',
      '「b」的起名模板“{color}{nope}林”用到了不存在的词表 {nope}',
    ]);
    // 岛上特有的默认不勾
    const isl = pack({ biomes: [biome('x'), { ...biome('island_y'), dispersal: { origins: [1], range: 100, gapCost: 4, seaCost: 30 } }] });
    expect(defaultPicks(isl).biomes).toEqual(['x']);
    // 用的时候同一个 id 只用第一个
    expect(planPack(fakeWorld(), p, defaultPicks(p)).command.commands.filter((c) => c.op === 'add_species').map((c) => (c.op === 'add_species' ? c.species.id : ''))).toEqual(['a', 'b']);
    const many = pack({ biomes: Array.from({ length: 49 }, (_, k) => biome(`s${k}`)) });
    expect(packProblems(many)).toEqual(['生态有 49 种：超过 48 种时界面会很挤，计算也会变慢']);
    const words = pack({ textPacks: [{ ...DEFAULT_PACK, types: { island: { patterns: [{ p: '{missing}岛' }] } } }] });
    expect(packProblems(words)[0]).toMatch(/^文字包「.+」：“island”的模板“\{missing\}岛”用到了不存在的词表/);
  });

  it('脚本里不合规的场名：提醒一句，不当成要加的场（加也加不了，导出的文件也读不回来）', () => {
    const sp = biome('a', { scripts: { placement: { api: 1, src: "return field('圣地') * field('my field') * field('海拔') * field('mana');" } } });
    expect(biomeFields(sp)).toEqual(['mana']);
    expect(packProblems(pack({ fields: ['mana'], biomes: [sp] }))).toEqual([
      '「a」用到了自定义场「圣地」：场名只能用字母、数字、下划线和连字符，世界里不会有这个场',
      '「a」用到了自定义场「my field」：场名只能用字母、数字、下划线和连字符，世界里不会有这个场',
    ]);
    expect(planPack(fakeWorld(), pack({ biomes: [sp] }), { biomes: ['a'] }).fields).toEqual(['mana']);
    const out = packFromWorld(fakeWorld([...structuredClone(DEFAULT_SPECIES), sp]), {}, { name: 'x' });
    expect(out.fields).toEqual(['mana']);
    expect(readPack(JSON.stringify(out)).ok).toBe(true);
  });

  it('内置示例包：没有问题（四种河都在包里，起名模板用的词表都有）', () => {
    expect(FANTASY_PACK.riverTypes?.map((t) => t.name)).toEqual(['血河', '晶川', '冥河', '熔岩河']);
    expect(packProblems(FANTASY_PACK)).toEqual([]);
    // 河流类型的模板用到了不存在的词表、不合规的场名：提醒
    const bad = pack({ riverTypes: [{ id: 'r', name: '红河', color: '#aa0000', names: [{ p: '{nope}河' }], scripts: { match: { api: 1, src: "return field('圣地') > 0;" } } }] });
    expect(packProblems(bad)).toEqual([
      '河流类型「红河」用到了自定义场「圣地」：场名只能用字母、数字、下划线和连字符，世界里不会有这个场',
      '河流类型「红河」的起名模板“{nope}河”用到了不存在的词表 {nope}',
    ]);
  });

  it('找出包里全部的脚本（信任检查用）', () => {
    const found = findScripts(FANTASY_PACK);
    const biomeScripts = FANTASY_BIOMES.flatMap((b) => Object.keys(b.scripts ?? {}));
    expect(found.filter((s) => s.path.startsWith('biomes')).length).toBe(biomeScripts.length);
    expect(found.find((s) => s.path === 'biomes[1].scripts.color')?.owner).toBe('死亡森林');
    expect(found.every((s) => /^[0-9a-f]{16}$/.test(s.hash))).toBe(true);
  });

  it('脚本里的引用：只认代码里的字面量，改名时只换它', () => {
    const src = "// river('a') 注释里的不算\nconst s = \"river('a')\";\nreturn river( 'a' ) + river(\"b\") + field('c');";
    expect(scriptRefs(src).map((r) => `${r.fn}:${r.name}`)).toEqual(['river:a', 'river:b', 'field:c']);
    expect(rewriteRiverRefs(src, new Map([['a', 'a-2']]))).toBe("// river('a') 注释里的不算\nconst s = \"river('a')\";\nreturn river( 'a-2' ) + river(\"b\") + field('c');");
  });
});

describe('资源包用到世界', () => {
  const saved = { ...PACK_SECTIONS.riverTypes };
  afterEach(() => {
    PACK_SECTIONS.riverTypes = saved;
  });

  it('一整步：先加用到的场，再加生态；文字包勾了才换', () => {
    const w = fakeWorld();
    const cmd = applyPackCommands(w, FANTASY_PACK);
    expect(cmd.op).toBe('batch');
    expect(cmd.label).toBe('用了资源包「奇幻生态示例」');
    // 场、河流类型、湖泊类型、生态（生态的脚本、条件要用到河流、湖泊类型）
    expect(cmd.commands.map((c) => c.op)).toEqual([
      'add_field',
      ...FANTASY_PACK.riverTypes!.map(() => 'set_river_type'),
      ...FANTASY_PACK.lakeTypes!.map(() => 'set_lake_type'),
      ...FANTASY_BIOMES.map(() => 'add_species'),
    ]);
    expect(cmd.commands[0]).toEqual({ op: 'add_field', name: 'holy' });
    // 只挑一种：只加它，它不用的场不加
    const one = planPack(w, FANTASY_PACK, { biomes: ['crystal_jungle'], riverTypes: [], lakeTypes: [] });
    expect(one.command.commands.map((c) => c.op)).toEqual(['add_species']);
    expect(one.fields).toEqual([]);
    // 场已经有了：不再加
    expect(planPack(fakeWorld(undefined, ['holy']), FANTASY_PACK, defaultPicks(FANTASY_PACK)).fields).toEqual([]);
    // 文字包
    const words = pack({ textPacks: [{ ...DEFAULT_PACK, id: 'w2', name: '另一套' }] });
    expect(planPack(w, words, { textPack: null }).command.commands).toEqual([]);
    expect(planPack(w, words, { textPack: 'w2' }).command.commands.map((c) => c.op)).toEqual(['set_word_pack']);
  });

  it('同 id 不同内容的改名为 -2，包里对它的引用一起改，种子不变', () => {
    const changed = { ...structuredClone(FANTASY_BIOMES[0]), color: '#000000' };
    const plain = biome('plain');
    const p = pack({ biomes: [...FANTASY_BIOMES, plain, biome('user', { effects: { invade: { targets: ['plain'], strength: 1 } } })] });
    const w = fakeWorld([...structuredClone(DEFAULT_SPECIES), changed, biome('plain', { color: '#ffffff' })]);
    const plan = planPack(w, p, defaultPicks(p));
    expect(plan.added.filter((a) => a.from !== a.id).map((a) => [a.from, a.id])).toEqual([
      ['crystal_jungle', 'crystal_jungle-2'],
      ['plain', 'plain-2'],
    ]);
    const added = plan.command.commands.flatMap((c) => (c.op === 'add_species' ? [c.species as Species] : []));
    const crystal = added.find((s) => s.id === 'crystal_jungle-2')!;
    // 花纹的种子：自带 seedKey 的照旧，没有的用原来的 id
    expect(crystal.seedKey).toBe('fantasy/crystal_jungle');
    expect(added.find((s) => s.id === 'plain-2')!.seedKey).toBe('plain');
    // 名字带上编号，列表里和世界里那份分得清；没改名的名字不变
    expect(crystal.name).toBe('水晶丛林 2');
    expect(plan.added.find((a) => a.from === 'crystal_jungle')!.name).toBe('水晶丛林 2');
    expect(added.find((s) => s.id === 'dead_forest')!.name).toBe('死亡森林');
    // 虫群侵占的水晶丛林、user 侵占的 plain 都换成改名后的
    expect(added.find((s) => s.id === 'swarm_zone')!.effects!.invade!.targets).toContain('crystal_jungle-2');
    expect(added.find((s) => s.id === 'swarm_zone')!.effects!.invade!.targets).not.toContain('crystal_jungle');
    expect(added.find((s) => s.id === 'user')!.effects!.invade!.targets).toEqual(['plain-2']);
    // 包里自己的数据不被改动
    expect(FANTASY_BIOMES[2].effects!.invade!.targets).toContain('crystal_jungle');
  });

  it('世界里已有一模一样的跳过；同一个包用两次，第二次什么都不加', () => {
    const eng = continents();
    const first = planPack(eng.world, FANTASY_PACK, defaultPicks(FANTASY_PACK));
    expect(first.skipped).toEqual([]);
    eng.exec(first.command);
    const again = planPack(eng.world, FANTASY_PACK, defaultPicks(FANTASY_PACK));
    expect(again.command.commands).toEqual([]);
    expect(again.skipped.map((s) => s.id)).toEqual([...FANTASY_BIOMES.map((b) => b.id), ...FANTASY_PACK.riverTypes!.map((t) => t.id), ...FANTASY_PACK.lakeTypes!.map((t) => t.id)]);
    // 改名过的那一项也认得出来：世界里的水晶丛林换了颜色，用包时加了 crystal_jungle-2；再用一次全部跳过
    const w = fakeWorld([...structuredClone(DEFAULT_SPECIES), { ...structuredClone(FANTASY_BIOMES[0]), color: '#000000' }]);
    const p1 = planPack(w, FANTASY_PACK, defaultPicks(FANTASY_PACK));
    for (const c of p1.command.commands) if (c.op === 'add_species') w.small.species.push(c.species as Species);
    const p2 = planPack(w, FANTASY_PACK, defaultPicks(FANTASY_PACK));
    expect(p2.command.commands.filter((c) => c.op === 'add_species')).toEqual([]);
    expect(p2.skipped.find((s) => s.from === 'crystal_jungle')?.id).toBe('crystal_jungle-2');
  });

  it('湖泊类型：先加湖泊类型、再加生态；撞 id 改名，生态脚本里的 nearLake()、hasLake() 和条件 lake:x 跟着改；导出再导入一样', () => {
    const user = biome('lakeside', {
      tolerances: [{ field: 'lake:blood_pool', min: 0.1, optLow: 0.5, optHigh: 1, max: 1 }],
      scripts: { placement: { api: 1, src: "return hasLake('blood_pool') ? nearLake('blood_pool') : river('blood_pool');" } },
    });
    const p = pack({ biomes: [user], lakeTypes: [{ id: 'blood_pool', name: '血池', color: '#9b1b1b' }] });
    // river('blood_pool') 是河流类型（包里没有），湖泊类型的引用都在
    expect(packProblems(p)).toEqual(['「lakeside」用到了河流类型 blood_pool，资源包里没有：没有这种河时按离得很远算']);
    expect(planPack(fakeWorld(), p, defaultPicks(p)).command.commands.map((c) => c.op)).toEqual(['set_lake_type', 'add_species']);
    const w = fakeWorld();
    (w.small as { lakeTypes?: unknown }).lakeTypes = [{ id: 'blood_pool', name: '别的血池', color: '#000000' }];
    const renamed = planPack(w, p, defaultPicks(p));
    const set = renamed.command.commands[0];
    expect(set.op === 'set_lake_type' && set.type).toEqual({ id: 'blood_pool-2', name: '血池 2', color: '#9b1b1b', seedKey: 'blood_pool' });
    const sp = renamed.command.commands.find((c) => c.op === 'add_species');
    const s = sp?.op === 'add_species' ? (sp.species as Species) : null;
    expect(s!.scripts!.placement!.src).toBe("return hasLake('blood_pool-2') ? nearLake('blood_pool-2') : river('blood_pool');");
    expect(s!.tolerances.map((t) => t.field)).toContain('lake:blood_pool-2');
    expect(s!.tolerances.map((t) => t.field)).not.toContain('lake:blood_pool');
    // 引用了包里没有的湖泊类型：提醒一句
    expect(packProblems(pack({ biomes: [user] }))).toContain('「lakeside」用到了湖泊类型 blood_pool，资源包里没有：没有这种湖时按离得很远算');
    // 导出再导入：一模一样
    const back = readPack(JSON.stringify(FANTASY_PACK));
    expect(back.ok && back.pack.lakeTypes).toEqual(FANTASY_PACK.lakeTypes);
  });

  it('河流类型：先加河流类型、再加生态；撞 id 改名，生态脚本里的 river()、hasRiver() 跟着改', () => {
    // 注册好的：用到世界时是 set_river_type（在生态之前，生态的脚本、条件要用它）
    const p = pack({ biomes: [FANTASY_BIOMES[4]], riverTypes: [{ id: 'blood_river', name: '血河', color: '#8f1414' }] });
    expect(PACK_SECTIONS.riverTypes.note).toBeUndefined();
    expect(planPack(fakeWorld(), p, defaultPicks(p)).command.commands.map((c) => c.op)).toEqual(['set_river_type', 'add_species']);
    // 世界里有一种不一样的 blood_river：改叫 blood_river-2，名字带编号，种子用原来的 id
    const w = fakeWorld();
    (w.small as { riverTypes?: unknown }).riverTypes = [{ id: 'blood_river', name: '别的血河', color: '#000000' }];
    const renamed = planPack(w, p, defaultPicks(p));
    const set = renamed.command.commands[0];
    expect(set.op === 'set_river_type' && set.type).toEqual({ id: 'blood_river-2', name: '血河 2', color: '#8f1414', seedKey: 'blood_river' });
    const sp0 = renamed.command.commands.find((c) => c.op === 'add_species');
    const src0 = sp0?.op === 'add_species' ? (sp0.species as Species).scripts!.placement!.src : '';
    expect(src0).toContain("hasRiver('blood_river-2')");
    expect(src0).toContain("river('blood_river-2')");
    registerPackSection('riverTypes', {
      inWorld: () => [{ id: 'blood_river', name: '别的血河', color: '#000000' }],
      command: (item) => ({ op: 'batch', label: `河流类型 ${item.id}`, commands: [] }),
    });
    expect(PACK_SECTIONS.riverTypes.note).toBeUndefined();
    const plan = planPack(fakeWorld(), p, defaultPicks(p));
    expect(plan.command.commands.map((c) => (c.op === 'batch' ? c.label : c.op))).toEqual(['河流类型 blood_river-2', 'add_species']);
    const sp = plan.command.commands.find((c) => c.op === 'add_species');
    const src = sp?.op === 'add_species' ? (sp.species as Species).scripts!.placement!.src : '';
    expect(src).toContain("river('blood_river-2')");
    expect(src).not.toContain("river('blood_river')");
  });
});

describe('河流类型的资源包', () => {
  it('从世界导出、读回来一模一样；用到另一个世界是同样的几种，再用一次什么都不加', () => {
    const eng = continents();
    const crystal = FANTASY_PACK.riverTypes![1];
    eng.exec({ op: 'set_river_type', type: { id: 'red', name: '红河', color: '#aa0000', style: 'double', bank: { radiusKm: 120, dT: 1 }, names: [{ p: '{color}红河' }] } as never });
    eng.exec({ op: 'set_river_type', type: crystal as never });
    const out = packFromWorld(eng.world, { biomes: [] }, { name: '我的河' });
    expect(out.riverTypes?.map((t) => t.id)).toEqual(['red', 'crystal_river']);
    expect(packFromWorld(eng.world, { biomes: [], riverTypes: ['red'] }, { name: 'x' }).riverTypes?.map((t) => t.id)).toEqual(['red']);
    const back = readPack(JSON.stringify(out));
    expect(back.ok && back.pack).toEqual(out);
    expect(findScripts(out).map((x) => x.path)).toEqual(['riverTypes[1].scripts.match']);
    const other = continents({ latNorth: 25, latSouth: -25 });
    other.exec(applyPackCommands(other.world, out));
    expect(other.world.small.riverTypes).toEqual(eng.world.small.riverTypes);
    expect(other.history.at(-1)!.summary).toBe('用了资源包「我的河」');
    expect(applyPackCommands(other.world, out).commands).toEqual([]);
    // 写错的河流类型：读的时候用中文说出在哪里
    const bad = readPack(JSON.stringify(pack({ riverTypes: [{ id: 'x', name: '', color: 'red' }] })));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join('；')).toContain('河流类型第 1 个「x」');
  });
});

describe('从世界导出', () => {
  it('只收不是内置原样的生态（改过的内置算），岛上特有的不收；带上用到的场', () => {
    const taiga = { ...structuredClone(DEFAULT_SPECIES[2]), color: '#123456' };
    const endemic = { ...biome('island_x'), dispersal: { origins: [1, 2], range: 100, gapCost: 4, seaCost: 30 } };
    const holy = FANTASY_BIOMES[3];
    const species = [...structuredClone(DEFAULT_SPECIES).filter((s) => s.id !== 'taiga'), taiga, holy, endemic];
    const w = fakeWorld(species, ['holy']);
    expect(exportableBiomes(w).map((s) => s.id)).toEqual(['taiga', 'holy_land']);
    const out = packFromWorld(w, {}, { name: '我的包', author: '我' });
    expect(out).toEqual({ format: 'map2-pack', version: 1, id: '我的包', name: '我的包', author: '我', fields: ['holy'], biomes: [taiga, holy] });
    // 只勾一种；文字包是内置的（null）时不带
    expect(packFromWorld(w, { biomes: ['taiga'], wordPack: true }, { name: 'x' }).biomes).toEqual([taiga]);
    expect(packFromWorld(w, { biomes: ['taiga'], wordPack: true }, { name: 'x' }).textPacks).toBeUndefined();
    // 什么都没勾：只有名字
    expect(packFromWorld(fakeWorld(), {}, { name: '空' })).toEqual({ format: 'map2-pack', version: 1, id: '空', name: '空' });
  });
});

describe('内置示例包', () => {
  it('用到 1.2 万格的地区：一步；每种示例生态至少 1 格、占陆地不超过 8%；导出再导入内容不变', () => {
    const eng = continents();
    const w = eng.world;
    const steps = eng.history.length;
    const plan = planPack(w, FANTASY_PACK, defaultPicks(FANTASY_PACK));
    // 确切预览（世界的副本上执行同一条命令）说的“会有多少格变成新生态”，就是执行后的
    const copy = eng.clone();
    copy.exec(plan.command);
    const predicted = newBiomeCells(plan, copy.world);
    eng.exec(applyPackCommands(w, FANTASY_PACK, defaultPicks(FANTASY_PACK)));
    expect(newBiomeCells(plan, w)).toEqual(predicted);
    expect([...predicted.values()].reduce((a, c) => a + c.length, 0)).toBeGreaterThan(0);
    expect(eng.history.length).toBe(steps + 1);
    expect(eng.history.at(-1)!.summary).toBe('用了资源包「奇幻生态示例」');
    expect(w.derived.scriptIssues).toBeUndefined();
    let land = 0;
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i]) land++;
    for (const sp of FANTASY_BIOMES) {
      const s = w.small.species.findIndex((x) => x.id === sp.id);
      let count = 0;
      for (let i = 0; i < w.mesh.n; i++) if (w.derived.dominant[i] === s) count++;
      expect(count, sp.name).toBeGreaterThanOrEqual(1);
      expect(count / land, sp.name).toBeLessThanOrEqual(0.08);
    }
    // 导出：五种示例生态与它们用到的场；导出的文件再读进来一模一样
    // 四种河至少三种出现（冥河只能自己画），但不是大部分的河都带类型
    const rt = w.derived.riverType!;
    const kinds = new Set<number>();
    let typedCells = 0;
    let riverCells = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (rt[i]) {
        kinds.add(rt[i]);
        typedCells++;
      }
      if (w.causes.land[i] && w.derived.lake[i] !== 1 && w.derived.discharge[i] >= w.small.planet.riverThreshold) riverCells++;
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    expect(typedCells / riverCells).toBeLessThan(0.5);
    expect(w.derived.features.some((f) => f.tags.includes('rtype:blood_river') && f.name.match(/血河|血川/))).toBe(true);
    const out = packFromWorld(w, {}, { name: '奇幻生态示例', author: 'map_2' });
    expect(out.biomes).toEqual(FANTASY_BIOMES);
    expect(out.riverTypes).toEqual(FANTASY_PACK.riverTypes);
    expect(out.fields).toEqual(['holy']);
    const back = readPack(JSON.stringify(out, null, 2));
    expect(back.ok && back.pack).toEqual(out);
    expect(back.ok && back.legacy).toBeNull();
    // 再用到同一个世界：全是一模一样的，什么都不加
    expect(applyPackCommands(w, out).commands).toEqual([]);
  });

  it('用到 8 千格的星球（格子粗、坡度小）：四种河至少三种出现，每条河整条是同一种，不是大部分的河都带类型', () => {
    const eng = engineFor({ cells: 8000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents' }, reset: true });
    const w = eng.world;
    eng.exec(applyPackCommands(w, FANTASY_PACK));
    expect(w.derived.scriptIssues).toBeUndefined();
    const rt = w.derived.riverType!;
    const net = riverNet(w, w.derived);
    const kinds = new Set<number>();
    let typedCells = 0;
    let riverCells = 0;
    for (const cells of net.stems) {
      for (const c of cells) expect(rt[c]).toBe(rt[cells[0]]);
      if (rt[cells[0]]) kinds.add(rt[cells[0]]);
      typedCells += rt[cells[0]] ? cells.length : 0;
      riverCells += cells.length;
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    expect(typedCells / riverCells).toBeLessThan(0.5);
  });
});

describe('用了资源包之后的世界', () => {
  it('撤销回到原样；存成文件再打开（从头重放）逐值相同', () => {
    const eng = continents();
    const before = digestWorld(eng.world);
    eng.exec(applyPackCommands(eng.world, FANTASY_PACK));
    const after = digestWorld(eng.world);
    expect(after['derived.placeF']).toBeDefined();
    expect(after['derived.look']).toBeDefined();
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    expect(doc.version).toBe(5);
    expect(digestWorld(Engine.fromDoc(doc, eng.world.mesh).world)).toEqual(after);
    eng.undo();
    expect(digestWorld(eng.world)).toEqual(before);
    eng.redo();
    expect(digestWorld(eng.world)).toEqual(after);
  });

  it('撞 id 改了名的生态，长在哪里的系数与没改名时逐值相同（种子用原来的 id，不用新 id）', () => {
    // 包里的生态没有自带 seedKey：种子就是它的 id
    const { seedKey: _, ...crystal } = { ...structuredClone(FANTASY_BIOMES[0]), id: 'crystal' };
    const p = pack({ biomes: [crystal] });
    const column = (eng: Engine, id: string) => {
      const scripted = eng.world.small.species.filter((x) => x.scripts?.placement);
      const k = scripted.findIndex((x) => x.id === id);
      const f = eng.world.derived.placeF!;
      return Float32Array.from({ length: eng.world.mesh.n }, (_, i) => f[i * scripted.length + k]);
    };
    const a = continents();
    a.exec(applyPackCommands(a.world, p));
    const ca = column(a, 'crystal');
    expect(ca.some((v) => v > 0 && v < 1)).toBe(true);
    // 世界里已有一种不一样的 crystal（没有脚本）：包里的改叫 crystal-2，种子还是 crystal
    const b = continents();
    b.exec({ op: 'add_species', species: biome('crystal', { color: '#000000' }) });
    const plan = planPack(b.world, p, defaultPicks(p));
    expect(plan.added).toEqual([{ section: 'biomes', from: 'crystal', id: 'crystal-2', name: '水晶丛林 2' }]);
    b.exec(plan.command);
    expect(column(b, 'crystal-2')).toEqual(ca);
    // 对照：不带 seedKey 直接用新 id，花纹就不一样了
    const c = continents();
    c.exec({ op: 'add_species', species: biome('crystal', { color: '#000000' }) });
    c.exec({ op: 'add_species', species: { ...crystal, id: 'crystal-2' } });
    expect(column(c, 'crystal-2')).not.toEqual(ca);
  });
});

describe('资源包里的星球形态', () => {
  it('内置的三种形态：存成文件再读回来一样；写错时用中文说是哪一个；只列出来，不在“用到这个世界”里用', () => {
    expect(packForms(FANTASY_PACK).map((f) => f.name)).toEqual(['双子大陆', '环形内海', '极地大陆']);
    expect(packSummary(FANTASY_PACK)).toBe('生态 5 · 河流 4 · 湖泊 4 · 星球 3');
    const back = readPack(JSON.stringify(FANTASY_PACK));
    expect(back.ok && back.pack.planetForms).toEqual(FANTASY_FORMS);
    const bad = readPack(JSON.stringify(pack({ planetForms: [{ ...TWIN_CONTINENTS, base: 'moon' } as never] })));
    expect(!bad.ok && bad.errors.length).toBe(1);
    expect(!bad.ok && bad.errors[0]).toMatch(/^星球形态第 1 个「双子大陆」的 base：/);
    const noName = readPack(JSON.stringify(pack({ planetForms: [{ ...TWIN_CONTINENTS, name: '' }] as never })));
    expect(!noName.ok && noName.errors[0]).toMatch(/^星球形态第 1 个「twin_continents」的 name：/);
    expect(PACK_SECTIONS.planetForms.note).toBe('星球形态在 调整 → 星球形态 里换，或新建世界时选');
    expect(planPack(fakeWorld(), FANTASY_PACK, { biomes: [] }).command.commands).toEqual([]);
  });

  it('从世界导出：带上世界在用的形态（一份副本）；不勾就不带；没有形态的世界不带', () => {
    const eng = engineFor({ cells: 2000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', form: POLAR_CONTINENTS }, reset: true });
    const out = packFromWorld(eng.world, {}, { name: '我的星球' });
    expect(out.planetForms).toEqual([POLAR_CONTINENTS]);
    expect(out.planetForms![0]).not.toBe(eng.world.small.terrain.gen!.form);
    expect(packFromWorld(eng.world, { planetForms: [] }, { name: 'x' }).planetForms).toBeUndefined();
    // 导出的文件读回来，用里面的形态新建同一个种子的星球：与原来逐值相同
    const back = readPack(JSON.stringify(out, null, 2));
    expect(back.ok && back.pack).toEqual(out);
    if (!back.ok) return;
    const again = engineFor({ cells: 2000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    again.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', form: packForms(back.pack)[0] }, reset: true });
    expect(digestWorld(again.world)).toEqual(digestWorld(eng.world));
    // 没有形态的世界
    const plain = engineFor({ cells: 2000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    plain.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    expect(packFromWorld(plain.world, {}, { name: 'x' }).planetForms).toBeUndefined();
  });
});
