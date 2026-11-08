import { describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { digest } from '../../../core/digest';
import { Engine } from '../../../core/engine';
import { type Government, worldCultureGroups, worldEras, worldGovernments, worldTerrainClasses } from '../../../core/human';
import { type PackNode, packItems } from '../../../core/packs';
import { BASE_PATH, LIBRARY_BASE_PACKS, builtinPacks } from '../../../core/packs/builtin-tree';
import { importGates } from '../../../core/packs/closure';
import { packImportCommands } from '../../../core/packs/import';
import { defaultsOf } from '../../../core/testing/eras';
import { type HumanCommand, continents, humanExec, lastOf, meshFor, snapshot } from '../../../core/testing/fixtures';
import type { LibraryEntry } from '../../library';
import { governmentChoices, governmentCommand } from './countries';
import { formChoices, formsInPacks, newWorldCommands } from './forms';
import { type HumanChoice, NO_ERA, chooseLibrary, choiceEra, choiceProblem, defaultChoice, generateCommand, regenerateCommand, regenerateWith, switchNote, withPackImports } from './human';
import { beyondGroups, choicePacks, defaultGroupsOf, humanImportCommands, isLibrary, libraryOptions, libraryRule, packGroups, worldContentCommands, worldLibrary } from './packChoice';
import { skippedKind, skippedSummary } from './skipped';

// 第五十二轮的界面：新建向导选一个库（文化组从这个库里列、星球形态只列这个库里的），新建与生成的命令（先加内容再生成），
// 重新生成默认是世界用的库，缺了内容跳过的说明，档案里换成本世界没有的政体。换库的内容见 core/packs/switch.test.ts

const LIB: LibraryEntry[] = builtinPacks().map((p) => ({ key: p.id, pack: p, builtin: true, mine: false, installedAt: 0 }));
const flat = (cmds: readonly Command[]): Command[] => cmds.flatMap((c) => (c.op === 'batch' ? flat(c.commands) : [c]));
const fromOf = (c: Command) => (c as { from?: string[] }).from;

const GEN: HumanCommand = { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {} };
const nations = () =>
  snapshot('r30-ui:nations', () => {
    const e = continents();
    humanExec(e, GEN);
    return e;
  });

// 向导新建一个世界（与 Wizard 的 create 同样的命令），返回引擎与每一步跳过的说明
function wizardWorld(c: HumanChoice) {
  const settings = { cells: 6000, seed: 1, latNorth: 60, latSouth: 20 };
  const eng = new Engine(settings, meshFor(settings));
  const cmds = newWorldCommands({ seed: 5, type: 'continents', landFraction: 0.4 }, '像地球', 5, [], generateCommand(c, null, LIB), worldContentCommands(c, LIB));
  const skipped: string[] = [];
  for (const cmd of cmds) {
    eng.exec(cmd);
    for (const x of eng.lastSkipped) if (!skipped.includes(x)) skipped.push(x);
  }
  return { eng, cmds, skipped };
}

describe('选一个库', () => {
  it('新建默认选中世纪与近世（基础、自然、中文地名……都在里面）；规则来自它，文化组是它默认带的', () => {
    const c = defaultChoice(null, true, LIB);
    expect(c.library).toBe('medieval');
    expect(choicePacks(c)).toEqual([['medieval']]);
    const rule = libraryRule(c.library, LIB)!;
    expect([rule.name, rule.era.id, rule.path]).toEqual(['中世纪与近世', 'medieval', ['medieval']]);
    expect(c.groups).toEqual(defaultsOf({ id: 'medieval' }).map((g) => g.id));
    expect(choiceProblem(c, null, LIB)).toBeNull();
  });

  it('能选的是内置的六个，加上我的库里够完整的；只有几项内容的包不列，新建世界还要有基础和自然', () => {
    const base = builtinPacks().find((p) => p.id === 'medieval')!;
    const era = (base.packs as PackNode[]).find((n) => n.id === 'era')!;
    const cultures = (base.packs as PackNode[]).find((n) => n.id === 'cultures')!;
    const nature = (base.packs as PackNode[]).find((n) => n.id === 'nature')!;
    const basePack = (base.packs as PackNode[]).find((n) => n.id === 'base')!;
    const mine = (key: string, packs: PackNode[]): LibraryEntry => ({ key, pack: { format: 'map2-pack', version: 1, id: key, name: key, packs } as LibraryEntry['pack'], builtin: false, mine: true, installedAt: 1 });
    const lib = [...LIB, mine('only-era', [era]), mine('for-humans', [era, cultures]), mine('whole', [era, cultures, basePack, nature])];
    expect(libraryOptions(lib).map((o) => o.key)).toEqual(['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi', 'for-humans', 'whole']);
    expect(libraryOptions(lib, true).map((o) => o.key)).toEqual(['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi', 'whole']);
    expect(libraryOptions(lib).filter((o) => !o.builtin).map((o) => o.key)).toEqual(['for-humans', 'whole']);
    expect(isLibrary(lib.find((e) => e.key === 'only-era')!.pack as PackNode)).toBe(false);
  });

  it('换一个库：规则、文化组都换成它的（不合起来）；奇幻不带历史库的组', () => {
    const c = defaultChoice(null, true, LIB);
    const f = chooseLibrary(c, 'fantasy', LIB);
    expect(f.library).toBe('fantasy');
    expect(choiceEra(f, LIB)!.id).toBe('fantasy');
    expect(f.groups).toEqual(defaultsOf({ id: 'fantasy' }).map((g) => g.id));
    expect(f.groups.includes('germanic')).toBe(false);
    expect(chooseLibrary(f, 'medieval', LIB).groups).toEqual(c.groups);
    // 一个都不勾时写明
    expect(choiceProblem({ ...c, groups: [] }, null, LIB)).toBe('至少勾一个文化组');
    expect(choiceProblem({ ...c, library: null }, null, LIB)).toBe(NO_ERA);
    expect(generateCommand({ ...c, library: null }, null, LIB)).toBeNull();
  });

  it('文化组的列表：默认的在前，别的 EU4 组比重是 0（收着的那些）；奇幻没有收着的', () => {
    const groups = packGroups('medieval', LIB);
    expect(groups.filter((g) => g.weight !== 0).map((g) => g.group.id)).toEqual(defaultsOf({ id: 'medieval' }).map((g) => g.id));
    expect(groups.filter((g) => g.weight === 0).length).toBe(53);
    expect(packGroups('fantasy', LIB).filter((g) => g.weight === 0)).toEqual([]);
    expect(packGroups('不存在', LIB)).toEqual([]);
  });

  it('星球形态只列选的库里的；奇幻的在“其他库里的形态”', () => {
    const choices = formChoices(LIB);
    const c = defaultChoice(null, true, LIB);
    const { shown, rest } = formsInPacks(choices, choicePacks(c));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((f) => f.path[0] === 'medieval')).toBe(true);
    // 同一种形态每个库都有，只列一次；选奇幻时也列得出来，段名写奇幻
    expect(new Set(shown.map((f) => f.key)).size).toBe(shown.length);
    const fantasy = formsInPacks(choices, [['fantasy']]);
    expect(fantasy.rest).toEqual([]);
    expect(fantasy.shown.every((f) => f.path[0] === 'fantasy')).toBe(true);
    expect(rest.every((f) => f.path[0] === 'fantasy')).toBe(true);
    expect(formsInPacks(choices, []).shown).toEqual([]);
  });
});

describe('向导走得通（六个库）', () => {
  for (const id of ['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi']) {
    it(`${id}：向导自己的命令新建，规则、文化组、国家都是这个库的，世界的底子来自它；奇幻库另带奇幻的生态、河、湖（第五十七轮）`, () => {
      const c = chooseLibrary(defaultChoice(null, true, LIB), id, LIB);
      const { eng, skipped } = wizardWorld(c);
      const small = eng.world.small;
      expect(skipped).toEqual([]);
      expect(small.human!.era).toBe(id);
      expect(small.genStamp!.packs).toEqual([[id]]);
      expect(small.human!.groups).toEqual(defaultsOf({ id }).map((g) => g.id));
      expect(Object.keys(small.countries!).length).toBeGreaterThan(0);
      expect(small.origin!.terrainClass.plains[0]).toBe(id);
      expect(small.origin!.era[id][0]).toBe(id);
      expect(small.species.every((sp) => !sp.id.startsWith('fantasy'))).toBe(true);
      const fantasy = id === 'fantasy';
      const fromNature = small.species.filter((sp) => small.origin!.biome[sp.id]?.join('/') === `${id}/nature`).length;
      expect(fromNature).toBe(16);
      expect(small.species.length).toBe(fantasy ? 21 : 16);
      expect((small.riverTypes ?? []).filter((t) => small.origin!.riverType[t.id]?.join('/') === `${id}/water`).length).toBe(7);
      expect((small.lakeTypes ?? []).filter((t) => small.origin!.lakeType[t.id]?.join('/') === `${id}/water`).length).toBe(7);
      expect((small.riverTypes ?? []).length).toBe(fantasy ? 17 : 7);
      expect((small.lakeTypes ?? []).length).toBe(fantasy ? 11 : 7);
    });
  }
});

describe('新建与生成的命令', () => {
  it('向导：世界的底子在新建的一步里（生成之前）加，库里生成要用的与生成人文是第二步；生成命令带上这个库', () => {
    const c = defaultChoice(null, true, LIB);
    const { eng, cmds, skipped } = wizardWorld(c);
    expect(cmds.map((x) => x.op)).toEqual(['batch', 'batch', 'generate_provinces']);
    const first = flat([cmds[0]]);
    const worldgen = first.findIndex((x) => x.op === 'set_worldgen');
    expect(first.slice(0, worldgen).some((x) => fromOf(x)?.join('/') === BASE_PATH.join('/'))).toBe(true);
    // 第五十一轮：第一步只有世界的底子，时代、文化在第二步
    expect(first.every((x) => !fromOf(x) || LIBRARY_BASE_PACKS.has(fromOf(x)![1]))).toBe(true);
    // 第二步：先加时代包里的（不再加一遍基础），再生成
    const second = flat([cmds[1]]);
    expect(second.at(-1)).toMatchObject({ op: 'generate_human', packs: [['medieval']], groups: c.groups });
    expect(second.slice(0, -1).every((x) => x.op === 'order_content' || fromOf(x)?.[0] === 'medieval')).toBe(true);
    expect(skipped).toEqual([]);
    expect(worldEras(eng.world.small).map((e) => e.id)).toEqual(['medieval']);
    expect(eng.world.small.genStamp!.packs).toEqual([['medieval']]);
    expect(Object.keys(eng.world.small.countries ?? {}).length).toBeGreaterThan(0);
  });

  it('自己的库里没有基础：照样新建，缺的那几步跳过并写明（地形类别、城市等级……）', () => {
    const med = builtinPacks().find((p) => p.id === 'medieval')!;
    const noBase: LibraryEntry = { key: 'no-base', pack: { ...med, id: 'no-base', packs: (med.packs as PackNode[]).filter((n) => n.id !== 'base') }, builtin: false, mine: true, installedAt: 1 };
    const lib = [...LIB, noBase];
    const c = chooseLibrary(defaultChoice(null, true, lib), 'no-base', lib);
    const settings = { cells: 6000, seed: 1, latNorth: 60, latSouth: 20 };
    const eng = new Engine(settings, meshFor(settings));
    const skipped: string[] = [];
    for (const cmd of newWorldCommands({ seed: 5, type: 'continents', landFraction: 0.4 }, '像地球', 5, [], generateCommand(c, null, lib), worldContentCommands(c, lib))) {
      eng.exec(cmd);
      skipped.push(...eng.lastSkipped);
    }
    expect(worldTerrainClasses(eng.world.small)).toEqual([]);
    expect(skipped.some((x) => x.startsWith('没有地形类别'))).toBe(true);
    expect(skipped.some((x) => x.startsWith('没有岛的种类'))).toBe(true);
    expect(eng.world.small.human).toBeTruthy();
    // 新建时选不到它（不够完整），第一步也不缺别的：自然照样带
    expect(libraryOptions(lib, true).some((o) => o.key === 'no-base')).toBe(false);
    expect(eng.world.small.species.length).toBeGreaterThan(0);
  });

  it('跳过的说明：认出缺的是哪一种，只缺一种时资源库筛成它', () => {
    expect(skippedKind('没有城市等级：没有放城市和道路')).toBe('cityRank');
    expect(skippedKind('没有时代：没有生成人文（先从资源库添加一个时代包）')).toBe('era');
    expect(skippedKind('别的话')).toBeUndefined();
    expect(skippedSummary(['没有地标类型：没有放地标'])).toEqual({ head: '跳过了一步：没有地标类型：没有放地标', kind: 'landmarkType' });
    expect(skippedSummary(['没有生态：植被为空', '没有资源：没有资源层'])).toEqual({ head: '缺了内容，跳过了 2 步', kind: 'all' });
  });

  it('已有的世界第一次生成人文：默认是世界的底子来自的库；世界的底子已经在世界里，不再加', () => {
    const eng = continents();
    const c = defaultChoice(eng.world.small, true, LIB);
    expect(c.library).toBe('medieval');
    const cmds = flat(humanImportCommands(c, eng.world.small, LIB));
    expect(cmds.every((x) => !fromOf(x) || !LIBRARY_BASE_PACKS.has(fromOf(x)![1]))).toBe(true);
  });

  it('重新生成：默认是世界用的库与文化组；只改文化组、总人口时保留手改的，不重新长国家', () => {
    const w = nations().world;
    const c = defaultChoice(w.small, true, LIB);
    expect(choicePacks(c)).toEqual(w.small.genStamp!.packs);
    expect(regenerateWith(c, w.small, LIB)).toBeNull();
    const more = regenerateWith({ ...c, groups: [...c.groups, 'scandinavian'] }, w.small, LIB)!;
    expect(more.op).toBe('batch');
    expect(lastOf(more)).toMatchObject({ op: 'regenerate_human', packs: [['medieval']], keepManual: true });
    expect('countries' in lastOf(more)).toBe(false);
    expect(flat([more]).some((x) => (x as { kind?: string; id?: string }).kind === 'cultureGroup' && (x as { id?: string }).id === 'scandinavian')).toBe(true);
    // 换库：国家也重新长，不保留手改的，生成的命令带着名单（core/packs/switch.test.ts）
    const other = regenerateWith(chooseLibrary(c, 'fantasy', LIB, w.small), w.small, LIB)!;
    expect(lastOf(other)).toMatchObject({ keepManual: false, countries: {}, packs: [['fantasy']] });
    expect((lastOf(other) as Extract<Command, { op: 'regenerate_human' }>).switchLibrary!.drop.length).toBeGreaterThan(0);
  });

  it('自己移出的地形类别重新生成时不回来；重新生成国家之前加回世界用的库里整理掉的政体', () => {
    const eng = nations();
    const cls = worldTerrainClasses(eng.world.small).find((x) => x.id !== 'plains')!;
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: cls.id, item: null });
    const c = { library: 'medieval', groups: eng.world.small.human!.groups };
    const cmds = flat(humanImportCommands(c, eng.world.small, LIB));
    expect(cmds.some((x) => (x as { kind?: string }).kind === 'terrainClass')).toBe(false);
    eng.exec(eng.planTidy({ only: Object.keys(eng.world.small.content!.government!).map((id) => ({ kind: 'government', id })) }).command!);
    const regen = withPackImports({ op: 'regenerate_countries' }, eng.world.small, LIB);
    expect(regen.op).toBe('batch');
    expect(flat([regen]).some((x) => (x as { kind?: string }).kind === 'government')).toBe(true);
  });

  it('后来从别的库加进世界的文化组：“重新生成”和“换库、文化组…”都带上，列在世界加的里', () => {
    const eng = nations();
    for (const x of packImportCommands(builtinPacks(), { packs: [['fantasy', 'cultures', 'elven']], groups: ['elven'] }, eng.world)) eng.exec(x);
    const c = defaultChoice(eng.world.small, true, LIB);
    expect(c.groups.at(-1)).toEqual('elven');
    eng.exec(regenerateCommand(eng.world.small, LIB));
    expect(eng.world.small.human!.groups.includes('elven')).toBe(true);
    expect(Object.values(eng.world.small.popGroups!).some((t) => worldCultureGroups(eng.world.small).find((g) => g.id === 'elven') && t.culture && (eng.world.small.content!.culture![t.culture] as { group: string }).group === 'elven')).toBe(true);
    // 没有加过时命令和以前一样
    expect(lastOf(regenerateCommand(nations().world.small, LIB))).toEqual({ op: 'regenerate_human' });
  });
});

describe('已有的世界换库（界面发的命令，内容的门槛见 core/packs/switch.test.ts）', () => {
  const contentOf = (eng: Engine, kind: string) => digest(eng.world.small.content?.[kind] ?? null);
  const GEN = ['era', 'popValue', 'valueGroup', 'government', 'faction', 'cultureGroup', 'culture', 'nameStyle', 'resource', 'landmarkType'];

  for (const [a, b] of [['medieval', 'modern'], ['medieval', 'fantasy'], ['fantasy', 'scifi']] as const) {
    it(`向导建的 ${a} 世界换成 ${b}：一步，能撤销；内容和向导直接建 ${b} 相同；写明移出几项`, () => {
      const { eng } = wizardWorld(chooseLibrary(defaultChoice(null, true, LIB), a, LIB));
      const small = eng.world.small;
      const before = GEN.map((k) => contentOf(eng, k));
      const c = chooseLibrary(defaultChoice(small, true, LIB), b, LIB, small);
      expect(c.library).toBe(b);
      expect(c.groups).toEqual(defaultsOf({ id: b }).map((g) => g.id));
      const cmd = regenerateWith(c, small, LIB)!;
      expect(cmd.op).toBe('batch');
      const drop = (lastOf(cmd) as Extract<Command, { op: 'regenerate_human' }>).switchLibrary!.drop;
      expect((cmd as { label?: string }).label).toBe(`换库“${LIB.find((e) => e.key === b)!.pack.name}” · 移出 ${drop.length} 项`);
      expect(switchNote(c, small, LIB)).toMatch(new RegExp(`^换库：移出旧库的 ${drop.length} 项，加入 \\d+ 项。可以撤销$`));
      eng.exec(cmd);
      eng.update();
      const { eng: direct } = wizardWorld(chooseLibrary(defaultChoice(null, true, LIB), b, LIB));
      expect(GEN.map((k) => contentOf(eng, k))).toEqual(GEN.map((k) => contentOf(direct, k)));
      expect(eng.world.small.human!.era).toBe(b);
      expect(eng.world.small.genStamp!.packs).toEqual([[b]]);
      expect(worldLibrary(eng.world.small)).toBe(b);
      eng.undo();
      eng.update();
      expect(GEN.map((k) => contentOf(eng, k))).toEqual(before);
      expect(worldLibrary(eng.world.small)).toBe(a);
    });
  }

  it('选回世界正在用的库：文化组回到上次生成的，不算换库', () => {
    const eng = nations();
    const small = eng.world.small;
    const c = defaultChoice(small, true, LIB);
    const f = chooseLibrary(c, 'fantasy', LIB, small);
    expect(switchNote(f, small, LIB)).not.toBeNull();
    const back = chooseLibrary(f, 'medieval', LIB, small);
    expect(back.groups).toEqual(c.groups);
    expect(switchNote(back, small, LIB)).toBeNull();
    expect(regenerateWith(back, small, LIB)).toBeNull();
  });

  it('换库时勾上新库默认不带的组：参与，来源记新库', () => {
    const eng = nations();
    const small = eng.world.small;
    const c = chooseLibrary(defaultChoice(small, true, LIB), 'modern', LIB, small);
    const spare = packGroups('modern', LIB).find((g) => g.weight === 0)!.group.id;
    eng.exec(regenerateWith({ ...c, groups: [...c.groups, spare] }, small, LIB)!);
    expect(eng.world.small.human!.groups.includes(spare)).toBe(true);
    expect(eng.world.small.origin!.cultureGroup[spare]).toEqual(['modern', 'cultures', spare]);
    expect(worldCultureGroups(eng.world.small).find((g) => g.id === spare)!.weight).toBeUndefined();
  });

  it('世界里从别的库加的文化组：换库后还列着、默认参与；旧库的不列', () => {
    const eng = nations();
    for (const x of packImportCommands(builtinPacks(), { packs: [['fantasy', 'cultures', 'elven']], groups: ['elven'] }, eng.world)) eng.exec(x);
    const small = eng.world.small;
    expect(beyondGroups(small, 'medieval', LIB).map((g) => g.id)).toEqual(['elven']);
    const c = chooseLibrary(defaultChoice(small, true, LIB), 'scifi', LIB, small);
    expect(beyondGroups(small, 'scifi', LIB).map((g) => g.id)).toEqual(['elven']);
    expect(c.groups.at(-1)).toEqual('elven');
    eng.exec(regenerateWith(c, small, LIB)!);
    expect(eng.world.small.human!.groups).toContain('elven');
    expect(eng.world.small.content!.cultureGroup!.elven).toBeDefined();
    expect(eng.world.small.content!.cultureGroup!.germanic).toBeUndefined();
    expect(eng.world.small.origin!.cultureGroup.elven[0]).toBe('fantasy');
  });

  it('“本世界加的”组取消之后，重开面板不再勾上；再勾上就回来（第五十九轮）', () => {
    const eng = nations();
    for (const x of packImportCommands(builtinPacks(), { packs: [['fantasy', 'cultures', 'elven']], groups: ['elven'] }, eng.world)) eng.exec(x);
    const start = defaultChoice(eng.world.small, true, LIB);
    expect(start.groups).toContain('elven');
    // 取消：组还在世界里，比重写 0；人口不用重算
    const off = { ...start, groups: start.groups.filter((g) => g !== 'elven') };
    const before = eng.world.small.human;
    eng.exec(regenerateWith(off, eng.world.small, LIB)!);
    expect(worldCultureGroups(eng.world.small).find((g) => g.id === 'elven')!.weight).toBe(0);
    expect(eng.world.small.human).toEqual(before);
    // 重开：不勾；“重新生成”也不带上
    const again = defaultChoice(eng.world.small, true, LIB);
    expect(again.groups).not.toContain('elven');
    expect(beyondGroups(eng.world.small, 'medieval', LIB).map((g) => g.id)).toEqual(['elven']);
    expect(JSON.stringify(regenerateCommand(eng.world.small, LIB))).not.toContain('"elven"');
    // 再勾上：去掉这个 0，参与生成
    eng.exec(regenerateWith({ ...again, groups: [...again.groups, 'elven'] }, eng.world.small, LIB)!);
    expect(worldCultureGroups(eng.world.small).find((g) => g.id === 'elven')!.weight).toBeUndefined();
    expect(eng.world.small.human!.groups).toContain('elven');
  });

  it('没有人文的世界第一次选别的库：生成的命令带着名单，世界用的库变了', () => {
    const eng = continents();
    const small = eng.world.small;
    expect(defaultChoice(small, true, LIB).library).toBe('medieval');
    const c = chooseLibrary(defaultChoice(small, true, LIB), 'fantasy', LIB, small);
    const cmd = generateCommand(c, small, LIB)!;
    expect((lastOf(cmd) as Extract<Command, { op: 'generate_human' }>).switchLibrary).toBeDefined();
    eng.exec(cmd);
    expect(worldLibrary(eng.world.small)).toBe('fantasy');
    // 没换库时命令和以前一样，不带名单
    const same = generateCommand(defaultChoice(small.human ? continents().world.small : small, true, LIB), continents().world.small, LIB)!;
    expect('switchLibrary' in lastOf(same)).toBe(false);
  });
});

describe('比重是 0 的组（第五十一轮）', () => {
  it('向导里默认不勾；勾上后生成时参与，世界里的那一项不写 0', () => {
    const c = defaultChoice(null, true, LIB);
    expect(c.groups.includes('kongo')).toBe(false);
    expect(packGroups(c.library, LIB).find((g) => g.group.id === 'kongo')!.weight).toBe(0);
    const { eng } = wizardWorld({ ...c, groups: [...c.groups, 'kongo'] });
    expect(eng.world.small.human!.groups.includes('kongo')).toBe(true);
    expect(worldCultureGroups(eng.world.small).find((g) => g.id === 'kongo')!.weight).toBeUndefined();
  });

  it('世界里已经有比重是 0 的组（从库里整包加进来的）：用户勾上就去掉这个 0；上一次就选着、后来改成 0 的不动', () => {
    const eng = nations();
    for (const x of packImportCommands(builtinPacks(), { packs: [['medieval', 'cultures', 'kongo']] }, eng.world)) eng.exec(x);
    const zero = (id: string) => worldCultureGroups(eng.world.small).find((g) => g.id === id)!.weight;
    expect(zero('kongo')).toBe(0);
    const c = defaultChoice(eng.world.small, true, LIB);
    eng.exec(regenerateWith({ ...c, groups: [...c.groups, 'kongo'] }, eng.world.small, LIB)!);
    expect(zero('kongo')).toBeUndefined();
    expect(eng.world.small.human!.groups.includes('kongo')).toBe(true);
    const was = worldCultureGroups(eng.world.small).find((g) => g.id === 'kongo')!;
    eng.exec({ op: 'set_content', kind: 'cultureGroup', id: 'kongo', item: { ...was, weight: 0 } as unknown as Record<string, unknown> });
    const again = defaultChoice(eng.world.small, true, LIB);
    eng.exec(regenerateWith({ ...again, groups: [...again.groups, 'scandinavian'] }, eng.world.small, LIB)!);
    expect(zero('kongo')).toBe(0);
    expect(eng.world.small.human!.groups.includes('kongo')).toBe(false);
  });
});

describe('世界里改过的内容（第五十轮）', () => {
  it('包没换的再生成：改过的项不再多一份 id-2，世界里那份留着并参与生成；整理掉的才补回来', () => {
    const eng = nations();
    const w = eng.world;
    const govs = Object.keys(w.small.content!.government!);
    const id = govs[0];
    eng.exec({ op: 'set_content', kind: 'government', id, item: { ...(w.small.content!.government![id] as object), name: '改过的' } as Record<string, unknown> });
    eng.exec(withPackImports({ op: 'regenerate_countries', seed: 9 }, w.small, LIB));
    expect(Object.keys(w.small.content!.government!).sort()).toEqual([...govs].sort());
    expect((w.small.content!.government![id] as { name: string }).name).toBe('改过的');
    // 换了选择（多一个组）也一样
    const h = w.small.human!;
    const choice = { on: true, library: 'medieval', groups: [...h.groups, 'scandinavian'], countries: { on: true }, settlements: { on: false, landmarks: false } } as unknown as HumanChoice;
    eng.exec(regenerateWith(choice, w.small, LIB)!);
    expect(Object.keys(w.small.content!.government!).sort()).toEqual([...govs].sort());
    expect(w.small.human!.groups.includes('scandinavian')).toBe(true);
    // 整理掉的补回来，改过的还是改过的
    const used = new Set(Object.values(w.small.countries!).map((c) => c.government));
    const idle = govs.find((g) => !used.has(g))!;
    eng.exec({ op: 'set_content', kind: 'government', id: idle, item: null });
    eng.exec(withPackImports({ op: 'regenerate_countries', seed: 3 }, w.small, LIB));
    expect(w.small.content!.government![idle]).toBeDefined();
    expect((w.small.content!.government![id] as { name: string }).name).toBe('改过的');
  });

  it('组的比重是 0 时选上库不跟着勾它', () => {
    const node: PackNode = { id: 'p', name: 'p', cultureGroups: [{ id: 'a', name: 'A', color: '#111111' }, { id: 'b', name: 'B', color: '#222222', weight: 0 }] as unknown as PackNode['cultureGroups'] };
    expect(defaultGroupsOf(node)).toEqual(['a']);
  });
});

describe('档案里换政体', () => {
  it('灰的政体不列（第六十五轮）：列着的都换得成，要变量、“限谁用”落空的不在', () => {
    const eng = nations();
    const w = eng.world;
    const m = Object.values(w.small.countries!)[0];
    eng.exec(eng.planTidy({ only: Object.keys(w.small.content!.government!).map((id) => ({ kind: 'government', id })) }).command!);
    const list = governmentChoices(w, m.government, LIB);
    const medieval = LIB.find((e) => e.key === 'medieval')!.pack;
    const gates = importGates(medieval, { t: 'world', world: w });
    const grey = packItems<Government>(medieval, 'governments').filter((g) => gates.of({ kind: 'government', id: g.id }).t === 'gated');
    expect(grey.length).toBeGreaterThan(0);
    for (const g of grey) expect(list.some((c) => c.gov.id === g.id), g.id).toBe(false);
    const fromLib = list.filter((c) => c.path);
    expect(fromLib.length).toBeGreaterThan(0);
    for (const c of fromLib) expect(governmentCommand(w, m, c, LIB), c.gov.id).not.toBeNull();
    eng.undo();
  });

  it('列出世界用的包里本世界没有的政体；选它时先从资源库加进来（带 from），再换', () => {
    const eng = nations();
    const w = eng.world;
    const m = Object.values(w.small.countries!)[0];
    // 第五十轮：生成后都留着，整理掉的才要从资源库加回来
    eng.exec(eng.planTidy({ only: Object.keys(w.small.content!.government!).map((id) => ({ kind: 'government', id })) }).command!);
    const list = governmentChoices(w, m.government, LIB);
    const have = new Set(worldGovernments(w.small).map((g) => g.id));
    const fromLib = list.find((g) => g.path && !have.has(g.gov.id))!;
    expect(fromLib.path![0]).toBe('medieval');
    const cmd = governmentCommand(w, m, fromLib, LIB)!;
    expect(cmd.op).toBe('batch');
    const inner = flat([cmd]);
    expect(inner[0]).toMatchObject({ op: 'set_content', kind: 'government', id: fromLib.gov.id, from: fromLib.path });
    expect(inner.at(-1)).toMatchObject({ op: 'set_country', id: m.id, patch: { government: fromLib.gov.id } });
    eng.exec(cmd);
    expect(eng.world.small.countries![m.id].government).toBe(fromLib.gov.id);
    // 本世界有的：直接换
    const own = list.find((g) => !g.path && g.gov.id !== m.government);
    if (own) expect(governmentCommand(w, m, own, LIB)).toEqual({ op: 'set_country', id: m.id, patch: { government: own.gov.id } });
    expect(governmentCommand(w, m, { gov: w.small.content!.government![m.government] as Government }, LIB)).toBeNull();
  });
});
