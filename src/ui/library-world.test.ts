import { afterEach, describe, expect, it } from 'vitest';
import type { VNode } from 'preact';

import type { Command } from '../../core/commands';
import { type ContentKind, kindOf } from '../../core/content/registry';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_ERAS } from '../../core/packs/eras';

import { PACK_FORMAT, PACK_VERSION, type PackWorld, type ResourcePack, packFromWorld, packItems, planPack, readPack } from '../../core/packs';
import { builtinPacks } from '../../core/packs/builtin-tree';
import { importCommand } from '../../core/packs/closure';
import { worldCultureGroups, worldCultures, worldEras, worldResources } from '../../core/human';
import { continents, snapshot, FANTASY_PACK, NAME_STYLES_SAMPLE, type HumanCommand, humanExec } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import type { LibraryEntry } from '../library';
import { world } from '../state';
import { type TypeChoice, openLibraryFor } from './shell/type-picker';
import { LIBRARY_ADD_LABEL } from './copy';
import { chooseLibrary, defaultChoice, generateCommand } from './domain/human';
import { choicePacks, humanImportCommands, packGroups } from './domain/packChoice';
import { defaultsOf, eraOf } from '../../core/testing/eras';
import { exportPicks, exportSections, packEmpty } from './packs/PackDialog';
import { itemPack, libraryRows, removeCommand, rowUsage, saveableItem, worldRows } from './packs/rows';
import { libPanel } from './packs/panel-store';
import { CultureMenu } from './panels/culture';
import { ResourceMenu } from './panels/human';
import { IslandTypeMenu } from './panels/islandTypes';
import { PointMenu } from './panels/settlements';

// 第二十八轮的界面：资源库与本世界——选择器只列本世界的、最后一项“从资源库添加…”；资源库里添加、移出（在用的不能移出，
// 写着用在哪里、能定位）、存进资源库、单独一项导出再导入；生成人文的选择（向导列资源库，重新生成只列本世界）；导出带上人文的几种

const entry = (key: string, pack: ResourcePack, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ key, pack, builtin: false, mine: false, installedAt: 1, ...extra });
const LIB: LibraryEntry[] = [entry('fantasy', FANTASY_PACK, { builtin: true, installedAt: 0 }), entry('name-styles', NAME_STYLES_SAMPLE, { builtin: true, installedAt: 0 })];
const pack = (id: string, extra: Partial<ResourcePack>): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, ...extra });
// 面板上的“添加”：走导入的闭包
const addCmd = (e: LibraryEntry, kind: ContentKind, id: string, w: PackWorld): Command => importCommand({ source: e.pack, target: { t: 'world', world: w }, picks: [{ kind: kind.id, id }] }, { path: [e.key] }).command!;
const MEDIEVAL = entry('medieval', builtinPacks().find((p) => p.id === 'medieval')!, { builtin: true, installedAt: 0 });

const GEN: HumanCommand = { op: 'generate_human', era: 'medieval', groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {}, settlements: {} };
const peopled = () =>
  snapshot('r28-ui:peopled', () => {
    const e = continents();
    humanExec(e, GEN);
    return e;
  });

// 组件直接调：返回的是 <TypePicker …/>，看它的 items 与 library
const pickerOf = (v: unknown) => (v as VNode<{ items: TypeChoice[]; library?: string; onNew?: () => void }>).props;

afterEach(() => {
  world.value = null;
});

describe('选择器只列本世界的，最后一项“从资源库添加…”', () => {
  it('文化：只有本世界的文化（按文化组分段），没有别的组；最后一项打开资源库、筛到不在本世界的文化', () => {
    const w = peopled().world;
    world.value = w;
    const p = pickerOf(CultureMenu());
    expect(p.items.map((x) => x.label).sort()).toEqual(worldCultures(w.small).map((c) => c.name).sort());
    expect(new Set(p.items.map((x) => x.group))).toEqual(new Set(worldCultureGroups(w.small).map((g) => g.name)));
    expect(p.library).toBe('culture');
    expect(p.onNew).toBeUndefined();
    openLibraryFor(p.library!);
    expect(libPanel.value!.stack.at(-1)).toEqual({ p: 'list', kind: 'culture', hideOn: true });
    expect(LIBRARY_ADD_LABEL).toBe('从资源库添加…');
  });

  it('资源、点的类型、岛的种类：本世界的（内置的总在），带着“从资源库添加…”；奇幻的资源不在本世界时不列', () => {
    const w = continents().world;
    world.value = w;
    const res = pickerOf(ResourceMenu());
    expect(res.library).toBe('resource');
    expect(res.items.length).toBe(2 + worldResources(w.small).length);
    expect(res.items.some((x) => x.label === '秘银')).toBe(false);
    expect(pickerOf(PointMenu()).library).toBe('pointType');
    const isle = pickerOf(IslandTypeMenu({ which: 'island' }));
    expect([isle.library, !!isle.onNew]).toEqual(['islandType', true]);
  });

  it('生成人文的选择（第五十二轮）：文化组列库里的；重新生成默认是世界用的库与文化组', () => {
    const w = peopled().world;
    // 第五十一轮：库里默认带的在前，比重是 0 的（别的 EU4 文化组）也列着，但不默认勾
    expect(packGroups('medieval', []).filter((g) => g.weight !== 0).map((g) => g.group.id)).toEqual(defaultsOf(eraOf('medieval')).map((g) => g.id));
    const c = defaultChoice(w.small);
    expect(choicePacks(c)).toEqual(w.small.genStamp!.packs);
    expect(c.groups.map((g) => g.id).sort()).toEqual(['chinese', 'germanic']);
  });

  it('向导选了资源包里的时代、文化组：生成之前先添加到本世界（文化组带上包里的文化和地名风格），一整步', () => {
    const era = { ...BUILTIN_ERAS[0], id: 'my-era', name: '我的时代' };
    const group = { ...BUILTIN_CULTURE_GROUPS[0], id: 'my-group', name: '我的组' };
    const style = { ...NAME_STYLES_SAMPLE.nameStyles![0], id: 'my-style', name: '我的风格' };
    const culture = { id: 'my-culture', group: 'my-group', name: '我的人', color: '#335577', nameStyle: 'my-style' };
    const lib = [...LIB, entry('mine', pack('mine', { eras: [era], cultureGroups: [group], cultures: [culture], nameStyles: [style] } as Partial<ResourcePack>), { mine: true })];
    // 选这个库（没写权重时库里的组都勾上）；生成要用的内容一次加进来，生成的命令带上这个库
    const choice = chooseLibrary(defaultChoice(null, true, lib), 'mine', lib);
    expect(choice.groups).toEqual([{ id: 'my-group', weight: 1 }]);
    const imports = humanImportCommands(choice, null, lib);
    const inner = imports.flatMap((x) => (x.op === 'batch' ? x.commands : [x]));
    expect(inner.map((x) => (x as { kind: string }).kind)).toEqual(['nameStyle', 'era', 'cultureGroup', 'culture']);
    const cmd = generateCommand(choice, null, lib)!;
    expect(cmd).toMatchObject({ op: 'batch', commands: [...imports.map(() => ({ op: 'batch' })), { op: 'generate_human', packs: [['mine']] }] });
    const eng = continents();
    eng.exec(cmd);
    expect(worldEras(eng.world.small).map((e) => e.id)).toEqual(['my-era']);
    expect(worldCultures(eng.world.small).map((c) => c.id)).toEqual(['my-culture']);
    // 内置的时代也要先加（第三十轮：生成只读世界里的内容）
    expect(humanImportCommands(defaultChoice(null, true, lib), null, lib).length).toBe(1);
  });
});

describe('资源库：添加到本世界、移出本世界', () => {
  it('血河在库里、不在本世界；添加是一步，可以撤销', () => {
    const eng = continents({ noWater: true });
    const w = eng.world;
    const kind = kindOf('riverType')!;
    const blood = () => libraryRows(LIB[0], kind, eng.world).find((r) => r.id === 'blood_river')!;
    expect(worldRows(kind, w)).toEqual([]);
    expect(blood().status.on).toBe(false);
    expect(removeCommand(blood(), w)).toBeNull();
    eng.exec(addCmd(LIB[0], kind, 'blood_river', w));
    expect(w.small.riverTypes!.map((t) => t.id)).toEqual(['blood_river']);
    expect(blood().status.on).toBe(true);
    // 移出：按规则套上的河不算在用，能移出（那些河换回普通的河）；画的河选了它才算
    expect(rowUsage(blood(), w)).toBeNull();
    eng.exec(removeCommand(blood(), w)!);
    expect(w.small.riverTypes ?? []).toEqual([]);
    eng.undo();
    eng.undo();
    expect(w.small.riverTypes ?? []).toEqual([]);
  });

  it('在用的文化不能移出（写着几处、能定位），没人的能移出', () => {
    const eng = peopled();
    const w = eng.world;
    const kind = kindOf('culture')!;
    const rows = worldRows(kind, w);
    const used = rows.find((r) => rowUsage(r, w))!;
    expect(used).toBeDefined();
    expect(removeCommand(used, w)).toBeNull();
    expect(rowUsage(used, w)!.cells!.length).toBeGreaterThan(0);
    // 加一个没人的文化，就能移出
    const idle = libraryRows(MEDIEVAL, kind, w).find((r) => !r.status.on)!;
    eng.exec(addCmd(MEDIEVAL, kind, idle.id, w));
    const row = worldRows(kind, eng.world).find((r) => r.id === idle.id)!;
    expect(rowUsage(row, eng.world)).toBeNull();
    const off = removeCommand(row, eng.world)!;
    expect(off).toMatchObject({ op: 'batch', label: `移出本世界：文化“${row.name}”`, commands: [{ op: 'set_content', kind: 'culture', id: idle.id, item: null }] });
    eng.exec(off);
    expect(worldCultures(w.small).some((c) => c.id === idle.id)).toBe(false);
    // 第三十轮：内置的地形类别也是普通内容，没画过的能移出
    const cls = worldRows(kindOf('terrainClass')!, w)[0];
    expect(rowUsage(cls, w)).toBeNull();
    expect(removeCommand(cls, w)).not.toBeNull();
  });

  it('世界里的一项能存进资源库，库里的一行不用存', () => {
    const eng = continents();
    eng.exec({ op: 'set_content', kind: 'pointType', id: 'r28-camp', item: { id: 'r28-camp', name: '营地', color: '#336699' } });
    const kind = kindOf('pointType')!;
    const own = worldRows(kind, eng.world).find((r) => r.id === 'r28-camp')!;
    expect([own.source, own.path]).toEqual(['world', undefined]);
    expect(saveableItem(own)).toEqual({ id: 'r28-camp', name: '营地', color: '#336699' });
    const mine = entry('my', pack('my', { pointTypes: [{ id: 'r28-camp', name: '营地', color: '#336699' }] } as Partial<ResourcePack>), { mine: true });
    const row = libraryRows(mine, kind, eng.world)[0];
    // 库里有一模一样的：在本世界
    expect([row.source, row.status.on]).toEqual(['lib', true]);
    expect(saveableItem(row)).toBeNull();
  });

  it('单独一项导出成文件，再从文件导入：读回来是同一项，能添加到别的世界', () => {
    const kind = kindOf('riverType')!;
    const row = libraryRows(LIB[0], kind, continents().world).find((r) => r.id === 'blood_river')!;
    const p = itemPack(row);
    expect(p).toMatchObject({ format: PACK_FORMAT, name: '血河' });
    expect(packItems(p, 'riverTypes')).toEqual([row.item]);
    const read = readPack(JSON.stringify(p));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(packItems(read.pack, 'riverTypes')).toEqual([row.item]);
    const eng = continents({ noWater: true });
    eng.exec(planPack(eng.world, read.pack, { riverTypes: ['blood_river'] }).command);
    expect(eng.world.small.riverTypes!.map((t) => t.name)).toEqual(['血河']);
    // 生态带上用到的自定义场
    const holy = libraryRows(LIB[0], kindOf('biome')!, continents().world).find((r) => itemPack(r).fields?.length)!;
    expect(holy).toBeDefined();
    expect(readPack(JSON.stringify(itemPack(holy))).ok).toBe(true);
  });
});

describe('从本世界存进资源库：人文的几种也能勾', () => {
  it('改过的文化、自己的政体在勾选里；只有人文内容的世界也能导出', () => {
    const eng = peopled();
    const w: World = eng.world;
    const c = worldCultures(w.small)[0];
    eng.exec({ op: 'set_content', kind: 'culture', id: c.id, item: { ...c, color: '#010203' } });
    const gov = Object.values(w.small.content!.government!)[0] as { id: string; name: string };
    eng.exec({ op: 'set_content', kind: 'government', id: 'r28-gov', item: { ...gov, id: 'r28-gov', name: '试验政体' } });
    const sections = exportSections(w);
    const keys = sections.map((s) => s.kind.id);
    expect(keys).toEqual(expect.arrayContaining(['culture', 'government']));
    expect(keys).not.toContain('biome');
    const picks = exportPicks(sections, new Set(), false);
    const p = packFromWorld(w, picks, { name: '人文' });
    expect(packEmpty(p)).toBe(false);
    expect(packItems<{ id: string }>(p, 'cultures').map((x) => x.id)).toEqual([c.id]);
    expect(packItems<{ id: string }>(p, 'governments').map((x) => x.id)).toEqual(['r28-gov']);
    // 去掉勾：这一项不带
    const p2 = packFromWorld(w, exportPicks(sections, new Set([`cultures:${c.id}`]), false), { name: '人文' });
    expect(packItems(p2, 'cultures')).toEqual([]);
    expect(packItems(p2, 'governments').length).toBe(1);
    // 什么都没改的世界：没有能导出的
    expect(packEmpty(packFromWorld(continents({ noWater: true }).world, exportPicks(exportSections(continents({ noWater: true }).world), new Set(), false), { name: 'x' }))).toBe(true);
  });
});
