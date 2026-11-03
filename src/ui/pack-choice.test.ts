import { describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import { Engine } from '../../core/engine';
import { type Government, worldCultureGroups, worldEras, worldGovernments, worldTerrainClasses } from '../../core/human';
import type { PackNode } from '../../core/packs';
import { BASE_PATH, LIBRARY_BASE_PACKS, builtinPacks } from '../../core/packs/builtin-tree';
import { packImportCommands } from '../../core/packs/import';
import { defaultsOf } from '../../core/testing/eras';
import { type HumanCommand, continents, humanExec, lastOf, meshFor, snapshot } from '../../core/testing/fixtures';
import type { LibraryEntry } from '../library';
import { governmentChoices, governmentCommand } from './countries';
import { formChoices, formsInPacks, newWorldCommands } from './forms';
import { type HumanChoice, NO_ERA, choiceEra, choiceProblem, choosePack, chooseRule, defaultChoice, generateCommand, regenerateWith, withPackImports } from './human';
import { defaultGroupsOf, humanImportCommands, packGroups, packState, rulePack, worldContentCommands } from './packChoice';
import { skippedKind, skippedSummary } from './skipped';

// 第三十轮的界面：新建向导的“内容”（资源包的勾选、规则来自哪个包、文化组从勾选的包里列、星球形态只列勾选的包里的），
// 新建与生成的命令（先加内容再生成），重新生成默认是世界用的包，缺了内容跳过的说明，档案里换成本世界没有的政体

const LIB: LibraryEntry[] = builtinPacks().map((p) => ({ key: p.id, pack: p, builtin: true, mine: false, installedAt: 0 }));
const flat = (cmds: readonly Command[]): Command[] => cmds.flatMap((c) => (c.op === 'batch' ? flat(c.commands) : [c]));
const fromOf = (c: Command) => (c as { from?: string[] }).from;

const GEN: HumanCommand = { op: 'generate_human', era: 'medieval', groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {} };
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
  const cmds = newWorldCommands({ seed: 5, type: 'continents', landFraction: 0.4 }, '像地球', 5, [], generateCommand(c, null, LIB), worldContentCommands(c, LIB, c.on));
  const skipped: string[] = [];
  for (const cmd of cmds) {
    eng.exec(cmd);
    for (const x of eng.lastSkipped) if (!skipped.includes(x)) skipped.push(x);
  }
  return { eng, cmds, skipped };
}

describe('勾选资源包', () => {
  it('新建默认勾上中世纪与近世这个库（基础、自然、中文地名……都在里面）；规则来自中世纪，文化组是它默认带的', () => {
    const c = defaultChoice(null, true, LIB);
    expect(c.packs).toEqual([['medieval']]);
    const rule = rulePack(c.packs, LIB)!;
    expect([rule.name, rule.era.id, rule.path]).toEqual(['中世纪与近世', 'medieval', ['medieval']]);
    expect(c.groups).toEqual(defaultsOf({ id: 'medieval' }));
    expect(choiceProblem(c, null, LIB)).toBeNull();
    // 勾着一个小包时大包是“部分”，勾着大包时小包是“整个包在”
    expect(packState([['fantasy', 'biomes']], ['fantasy'])).toBe('partial');
    expect(packState([[...BASE_PATH]], [...BASE_PATH])).toBe('on');
    expect(packState(c.packs, [...BASE_PATH])).toBe('covered');
    expect(packState(c.packs, ['medieval', 'governments'])).toBe('covered');
    expect(packState(c.packs, ['fantasy'])).toBe('off');
  });

  it('再勾奇幻：规则还是第一个时代包的，奇幻默认的文化组跟着勾上；设为规则后规则来自奇幻；去掉奇幻时它的组跟着去掉', () => {
    const c = { ...defaultChoice(null, true, LIB), pop: 1e8 };
    const both = choosePack(c, ['fantasy'], true, LIB);
    expect(choiceEra(both, LIB)!.id).toBe('medieval');
    expect(both.pop).toBeNull();
    expect(both.groups.map((g) => g.id)).toEqual(expect.arrayContaining(['elven', 'dwarven', 'germanic', 'chinese']));
    // 列出来的文化组：两个包里的（同一组只列一次，在先勾的包里）
    const listed = packGroups(both.packs, LIB);
    expect(listed.find((g) => g.group.id === 'germanic')!.pack).toEqual(['medieval']);
    expect(listed.find((g) => g.group.id === 'elven')!.pack).toEqual(['fantasy']);
    const ruled = chooseRule(both, ['fantasy']);
    expect(ruled.packs[0]).toEqual(['fantasy']);
    expect(rulePack(ruled.packs, LIB)!.name).toBe('奇幻');
    const back = choosePack(ruled, ['fantasy'], false, LIB);
    expect(choiceEra(back, LIB)!.id).toBe('medieval');
    expect(back.groups.some((g) => g.id === 'elven')).toBe(false);
    // 两个包都有的组（western）留着
    expect(back.groups.some((g) => g.id === 'germanic')).toBe(true);
  });

  it('勾大包时下面勾着的小包并进去；都不带时代时写明不生成人文', () => {
    const c = defaultChoice(null, true, LIB);
    const whole = choosePack(choosePack(c, ['fantasy', 'biomes'], true, LIB), ['fantasy'], true, LIB);
    expect(whole.packs.filter((p) => p[0] === 'fantasy')).toEqual([['fantasy']]);
    const none = choosePack(c, ['medieval'], false, LIB);
    expect(rulePack(none.packs, LIB)).toBeUndefined();
    expect(none.groups).toEqual([]);
    expect(choiceProblem(none, null, LIB)).toBe(NO_ERA);
    expect(generateCommand(none, null, LIB)).toBeNull();
  });

  it('星球形态只列勾选的包里的；奇幻的在“其他包里的形态”', () => {
    const choices = formChoices(LIB);
    const c = defaultChoice(null, true, LIB);
    const { shown, rest } = formsInPacks(choices, c.packs);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((f) => f.path[0] === 'medieval')).toBe(true);
    // 同一种形态每个库都有，只列一次；只勾奇幻时也列得出来，段名写奇幻
    expect(new Set(shown.map((f) => f.key)).size).toBe(shown.length);
    const fantasy = formsInPacks(choices, [['fantasy']]);
    expect(fantasy.rest).toEqual([]);
    expect(fantasy.shown.every((f) => f.path[0] === 'fantasy')).toBe(true);
    expect(rest.every((f) => f.path[0] === 'fantasy')).toBe(true);
    const more = formsInPacks(choices, choosePack(c, ['fantasy', 'forms'], true, LIB).packs);
    expect(more.rest).toEqual([]);
    expect(formsInPacks(choices, []).shown).toEqual([]);
  });
});

describe('新建与生成的命令', () => {
  it('向导：不带时代的包在新建的一步里（生成之前）加，时代包与生成人文是第二步；生成命令带上勾选的包', () => {
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
    expect(second.at(-1)).toMatchObject({ op: 'generate_human', packs: c.packs, groups: c.groups });
    expect(second.slice(0, -1).every((x) => x.op === 'order_content' || fromOf(x)?.[0] === 'medieval')).toBe(true);
    expect(skipped).toEqual([]);
    expect(worldEras(eng.world.small).map((e) => e.id)).toEqual(['medieval']);
    expect(eng.world.small.genStamp!.packs).toEqual(c.packs);
    expect(Object.keys(eng.world.small.countries ?? {}).length).toBeGreaterThan(0);
  });

  it('去掉基础：照样新建，缺的那几步跳过并写明（地形类别、城市等级……）', () => {
    // 第五十一轮：勾着整个库时基础跟着库走，不要基础就单独勾小包
    const c = { ...defaultChoice(null, true, LIB), packs: [['medieval', 'era'], ['medieval', 'nature'], ['medieval', 'names', 'zh']] };
    const { eng, skipped } = wizardWorld(c);
    expect(worldTerrainClasses(eng.world.small)).toEqual([]);
    expect(skipped.some((x) => x.startsWith('没有地形类别'))).toBe(true);
    expect(skipped.some((x) => x.startsWith('没有岛的种类'))).toBe(true);
    expect(eng.world.small.human).toBeTruthy();
  });

  it('跳过的说明：认出缺的是哪一种，只缺一种时资源库筛成它', () => {
    expect(skippedKind('没有城市等级：没有放城市和道路')).toBe('cityRank');
    expect(skippedKind('没有时代：没有生成人文（先从资源库添加一个时代包）')).toBe('era');
    expect(skippedKind('别的话')).toBeUndefined();
    expect(skippedSummary(['没有地标类型：没有放地标'])).toEqual({ head: '跳过了一步：没有地标类型：没有放地标', kind: 'landmarkType' });
    expect(skippedSummary(['没有生态：植被为空', '没有资源：没有资源层'])).toEqual({ head: '缺了内容，跳过了 2 步', kind: 'all' });
  });

  it('已有的世界第一次生成人文：默认勾上中世纪这个库；世界的底子已经在世界里，不再加', () => {
    const eng = continents();
    const c = defaultChoice(eng.world.small, true, LIB);
    expect(c.packs).toEqual([['medieval']]);
    const cmds = flat(humanImportCommands(c, eng.world.small, LIB));
    expect(cmds.every((x) => !fromOf(x) || !LIBRARY_BASE_PACKS.has(fromOf(x)![1]))).toBe(true);
  });

  it('重新生成：默认是世界用的包与文化组；加勾奇幻时先加它的内容，规则没换时保留手改的', () => {
    const w = nations().world;
    const c = defaultChoice(w.small, true, LIB);
    expect(c.packs).toEqual(w.small.genStamp!.packs);
    expect(regenerateWith(c, w.small, LIB)).toBeNull();
    const more = choosePack(c, ['fantasy'], true, LIB);
    const cmd = regenerateWith(more, w.small, LIB)!;
    expect(cmd.op).toBe('batch');
    expect(lastOf(cmd)).toMatchObject({ op: 'regenerate_human', packs: [['medieval'], ['fantasy']], keepManual: true });
    expect(flat([cmd]).some((x) => fromOf(x)?.[0] === 'fantasy')).toBe(true);
    const eng = nations();
    eng.exec(cmd);
    expect(worldCultureGroups(eng.world.small).some((g) => g.id === 'elven')).toBe(true);
    // 换规则：国家也重新长，不保留手改的
    expect(lastOf(regenerateWith(chooseRule(more, ['fantasy']), w.small, LIB)!)).toMatchObject({ keepManual: false, countries: {} });
  });

  it('已有的世界：在用的基础包再生成时只补整理时可能移出的几种，自己移出的地形类别不会加回来', () => {
    const eng = nations();
    const cls = worldTerrainClasses(eng.world.small).find((x) => x.id !== 'plains')!;
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: cls.id, item: null });
    const c = { packs: [[...BASE_PATH], ['medieval']], groups: eng.world.small.human!.groups.map((g) => ({ id: g.id, weight: g.weight })) };
    const cmds = flat(humanImportCommands(c, eng.world.small, LIB));
    expect(cmds.some((x) => (x as { kind?: string }).kind === 'terrainClass')).toBe(false);
    // 第一次勾上的（没在用的）整个加进来
    const fresh = flat(humanImportCommands({ ...c, packs: [...c.packs, ['fantasy', 'biomes']] }, eng.world.small, LIB));
    expect(fresh.some((x) => fromOf(x)?.join('/') === 'fantasy/biomes')).toBe(true);
    // 重新生成国家之前：加回世界用的包里整理掉的政体
    eng.exec(eng.planTidy({ only: Object.keys(eng.world.small.content!.government!).map((id) => ({ kind: 'government', id })) }).command!);
    const regen = withPackImports({ op: 'regenerate_countries' }, eng.world.small, LIB);
    expect(regen.op).toBe('batch');
    expect(flat([regen]).some((x) => (x as { kind?: string }).kind === 'government')).toBe(true);
  });
});

describe('比重是 0 的组（第五十一轮）', () => {
  it('向导里默认不勾；勾上后生成时参与，世界里的那一项不写 0', () => {
    const c = defaultChoice(null, true, LIB);
    expect(c.groups.some((g) => g.id === 'kongo')).toBe(false);
    expect(packGroups(c.packs, LIB).find((g) => g.group.id === 'kongo')!.weight).toBe(0);
    const { eng } = wizardWorld({ ...c, groups: [...c.groups, { id: 'kongo', weight: 1 }] });
    expect(eng.world.small.human!.groups.some((g) => g.id === 'kongo')).toBe(true);
    expect(worldCultureGroups(eng.world.small).find((g) => g.id === 'kongo')!.weight).toBeUndefined();
  });

  it('世界里已经有比重是 0 的组（从库里整包加进来的）：用户勾上就去掉这个 0；上一次就选着、后来改成 0 的不动', () => {
    const eng = nations();
    for (const x of packImportCommands(builtinPacks(), { packs: [['medieval', 'cultures', 'kongo']] }, eng.world)) eng.exec(x);
    const zero = (id: string) => worldCultureGroups(eng.world.small).find((g) => g.id === id)!.weight;
    expect(zero('kongo')).toBe(0);
    const c = defaultChoice(eng.world.small, true, LIB);
    eng.exec(regenerateWith({ ...c, groups: [...c.groups, { id: 'kongo', weight: 1 }] }, eng.world.small, LIB)!);
    expect(zero('kongo')).toBeUndefined();
    expect(eng.world.small.human!.groups.some((g) => g.id === 'kongo')).toBe(true);
    const was = worldCultureGroups(eng.world.small).find((g) => g.id === 'kongo')!;
    eng.exec({ op: 'set_content', kind: 'cultureGroup', id: 'kongo', item: { ...was, weight: 0 } as unknown as Record<string, unknown> });
    const again = defaultChoice(eng.world.small, true, LIB);
    eng.exec(regenerateWith({ ...again, pop: 123456 }, eng.world.small, LIB)!);
    expect(zero('kongo')).toBe(0);
    expect(eng.world.small.human!.groups.some((g) => g.id === 'kongo')).toBe(false);
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
    const choice = { on: true, packs: w.small.genStamp!.packs.map((p) => [...p]), groups: [...h.groups.map((g) => ({ id: g.id, weight: g.weight })), { id: 'scandinavian', weight: 1 }], pop: null, countries: { on: true, fragmentation: 0.5 }, settlements: { on: false, landmarks: false } } as unknown as HumanChoice;
    eng.exec(regenerateWith(choice, w.small, LIB)!);
    expect(Object.keys(w.small.content!.government!).sort()).toEqual([...govs].sort());
    expect(w.small.human!.groups.some((g) => g.id === 'scandinavian')).toBe(true);
    // 整理掉的补回来，改过的还是改过的
    const used = new Set(Object.values(w.small.countries!).map((c) => c.government));
    const idle = govs.find((g) => !used.has(g))!;
    eng.exec({ op: 'set_content', kind: 'government', id: idle, item: null });
    eng.exec(withPackImports({ op: 'regenerate_countries', seed: 3 }, w.small, LIB));
    expect(w.small.content!.government![idle]).toBeDefined();
    expect((w.small.content!.government![id] as { name: string }).name).toBe('改过的');
  });

  it('组的比重是 0 时勾上包不跟着勾它', () => {
    const node: PackNode = { id: 'p', name: 'p', cultureGroups: [{ id: 'a', name: 'A', color: '#111111' }, { id: 'b', name: 'B', color: '#222222', weight: 0 }] as unknown as PackNode['cultureGroups'] };
    expect(defaultGroupsOf(node).map((g) => g.id)).toEqual(['a']);
  });
});

describe('档案里换政体', () => {
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
