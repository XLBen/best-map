import { afterEach, describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import type { Command } from '../../core/commands';
import { kindOf } from '../../core/content/registry';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_ERAS } from '../../core/packs/eras';
import { FANTASY_PACK } from '../../core/packs/fantasy';
import { NAME_STYLES_PACK } from '../../core/packs/names';
import { PACK_FORMAT, PACK_VERSION, type ResourcePack, packFromWorld, packItems, planPack, readPack } from '../../core/packs';
import { worldCultureGroups, worldCultures, worldEras, worldResources } from '../../core/human';
import { continents, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import type { LibraryEntry } from '../library';
import { world } from '../state';
import { LIBRARY_LABEL, type TypeChoice, openLibraryFor } from './components/TypePicker';
import { choiceLists, chooseEra, defaultChoice, generateCommand, importCommands } from './human';
import { exportPicks, exportSections, packEmpty } from './packs/PackDialog';
import { REPO_FILTERS, addCommand, canDeleteFromLibrary, filterRows, itemPack, removeCommand, repoRows, rowUsage, saveableItem } from './packs/repo';
import { repo } from './packs/store';
import { CultureMenu } from './panels/culture';
import { ResourceMenu } from './panels/human';
import { IslandTypeMenu } from './panels/islandTypes';
import { PointMenu } from './panels/settlements';

// 第二十八轮的界面：资源库与本世界——选择器只列本世界的、最后一项“从资源库添加…”；资源库里添加、移出（在用的不能移出，
// 写着用在哪里、能定位）、存进资源库、单独一项导出再导入；生成人文的选择（向导列资源库，重新生成只列本世界）；导出带上人文的几种

const entry = (key: string, pack: ResourcePack, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ key, pack, builtin: false, mine: false, installedAt: 1, ...extra });
const LIB: LibraryEntry[] = [entry('fantasy', FANTASY_PACK, { builtin: true, installedAt: 0 }), entry('name-styles', NAME_STYLES_PACK, { builtin: true, installedAt: 0 })];
const pack = (id: string, extra: Partial<ResourcePack>): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, ...extra });

const GEN: Command = { op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }], countries: {}, settlements: {} };
const peopled = () =>
  snapshot('r28-ui:peopled', () => {
    const e = continents();
    e.exec(GEN);
    return e;
  });

// 组件直接调：返回的是 <TypePicker …/>，看它的 items 与 library
const pickerOf = (v: unknown) => (v as VNode<{ items: TypeChoice[]; library?: string; onNew?: () => void }>).props;

afterEach(() => {
  world.value = null;
  repo.value = null;
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
    expect(repo.value).toMatchObject({ kind: 'culture', filter: 'off' });
    expect(LIBRARY_LABEL).toBe('从资源库添加…');
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

  it('生成人文的选择：向导、第一次生成列资源库里的全部；重新生成只列本世界的', () => {
    const w = peopled().world;
    const lib = choiceLists(null, 'library');
    expect(lib.eras.map((e) => e.id)).toEqual(BUILTIN_ERAS.map((e) => e.id));
    expect(lib.groups.length).toBe(BUILTIN_CULTURE_GROUPS.length);
    const own = choiceLists(w.small, 'world');
    expect(own.eras.map((e) => e.id)).toEqual(worldEras(w.small).map((e) => e.id));
    expect(own.eras.map((e) => e.id)).toEqual(['medieval']);
    expect(own.groups.map((g) => g.id).sort()).toEqual(['eastern', 'western']);
    // 本世界只列着的组里换时代：默认的组只从列着的里挑
    const c = chooseEra({ ...defaultChoice(w.small), era: 'x' }, 'medieval', w.small, own);
    expect(c.groups.every((g) => own.groups.some((x) => x.id === g.id))).toBe(true);
  });

  it('向导选了资源包里的时代、文化组：生成之前先添加到本世界（文化组带上包里的文化和地名风格），一整步', () => {
    const era = { ...BUILTIN_ERAS[0], id: 'my-era', name: '我的时代' };
    const group = { ...BUILTIN_CULTURE_GROUPS[0], id: 'my-group', name: '我的组' };
    const style = { ...NAME_STYLES_PACK.nameStyles![0], id: 'my-style', name: '我的风格' };
    const culture = { id: 'my-culture', group: 'my-group', name: '我的人', color: '#335577', nameStyle: 'my-style' };
    const lib = [...LIB, entry('mine', pack('mine', { eras: [era], cultureGroups: [group], cultures: [culture], nameStyles: [style] } as Partial<ResourcePack>), { mine: true })];
    expect(choiceLists(null, 'library', lib).eras.some((e) => e.id === 'my-era')).toBe(true);
    const choice = { ...defaultChoice(null), era: 'my-era', groups: [{ id: 'my-group', weight: 1 }] };
    const imports = importCommands(choice, null, lib);
    expect(imports.map((x) => (x as { kind: string }).kind)).toEqual(['nameStyle', 'era', 'cultureGroup', 'culture']);
    const cmd = generateCommand(choice, null, lib)!;
    expect(cmd).toMatchObject({ op: 'batch', commands: [...imports.map(() => ({ op: 'set_content' })), { op: 'generate_human', era: 'my-era' }] });
    const eng = continents();
    eng.exec(cmd);
    expect(worldEras(eng.world.small).map((e) => e.id)).toEqual(['my-era']);
    expect(worldCultures(eng.world.small).map((c) => c.id)).toEqual(['my-culture']);
    // 内置的不用先加（生成时自动复制进来）
    expect(importCommands(defaultChoice(null), null, lib)).toEqual([]);
  });
});

describe('资源库：添加到本世界、移出本世界', () => {
  it('筛选“本世界”“不在本世界”；血河在资源库里、不在本世界；添加是一步，可以撤销', () => {
    expect(REPO_FILTERS.map(([k]) => k)).toEqual(['all', 'on', 'off', 'builtin', 'imported', 'mine']);
    const eng = continents();
    const w = eng.world;
    const kind = kindOf('riverType')!;
    const rows = repoRows(kind, w, LIB);
    const blood = () => repoRows(kind, eng.world, LIB).find((r) => r.id === 'blood_river')!;
    expect(filterRows(rows, 'off').some((r) => r.id === 'blood_river')).toBe(true);
    expect(filterRows(rows, 'on')).toEqual([]);
    expect(blood().status.on).toBe(false);
    expect(removeCommand(blood(), w)).toBeNull();
    eng.exec(addCommand(blood(), w)!);
    expect(w.small.riverTypes!.map((t) => t.id)).toEqual(['blood_river']);
    expect(blood().status.on).toBe(true);
    expect(addCommand(blood(), w)).toBeNull();
    // 移出：在用（有自然的河是血河）时不能移出，写着用在哪里；没在用时能移出
    const u = rowUsage(blood(), w);
    const off = removeCommand(blood(), w);
    if (u) {
      expect(off).toBeNull();
      expect(u.label).toMatch(/格的河是这一种/);
      expect(u.cells!.length).toBeGreaterThan(0);
    } else {
      eng.exec(off!);
      expect(w.small.riverTypes ?? []).toEqual([]);
      eng.undo();
    }
    eng.undo();
    expect(w.small.riverTypes ?? []).toEqual([]);
  });

  it('在用的文化不能移出（写着几处、能定位），没人的能移出；总在的内置项没有移出', () => {
    const eng = peopled();
    const w = eng.world;
    const kind = kindOf('culture')!;
    const rows = repoRows(kind, w, LIB);
    const used = rows.find((r) => r.status.on && rowUsage(r, w))!;
    expect(used).toBeDefined();
    expect(removeCommand(used, w)).toBeNull();
    expect(rowUsage(used, w)!.cells!.length).toBeGreaterThan(0);
    // 加一个没人的文化，就能移出
    const idle = rows.find((r) => !r.status.on && r.source === 'builtin')!;
    eng.exec(addCommand(idle, w)!);
    const row = repoRows(kind, eng.world, LIB).find((r) => r.id === idle.id)!;
    expect(rowUsage(row, eng.world)).toBeNull();
    const off = removeCommand(row, eng.world)!;
    expect(off).toMatchObject({ op: 'batch', label: `移出本世界：文化“${row.name}”`, commands: [{ op: 'set_content', kind: 'culture', id: idle.id, item: null }] });
    eng.exec(off);
    expect(worldCultures(w.small).some((c) => c.id === idle.id)).toBe(false);
    // 内置的地形类别总在：没有移出
    const cls = repoRows(kindOf('terrainClass')!, w, LIB).find((r) => r.status.always)!;
    expect(removeCommand(cls, w)).toBeNull();
    expect(rowUsage(cls, w)).toBeNull();
  });

  it('本世界做的能存进资源库；只有我的能从库里删', () => {
    const eng = continents();
    eng.exec({ op: 'set_content', kind: 'pointType', id: 'r28-camp', item: { id: 'r28-camp', name: '营地', color: '#336699' } });
    const kind = kindOf('pointType')!;
    const own = repoRows(kind, eng.world, LIB).find((r) => r.id === 'r28-camp')!;
    expect(own.source).toBe('world');
    expect(saveableItem(own)).toEqual({ id: 'r28-camp', name: '营地', color: '#336699' });
    expect(canDeleteFromLibrary(own)).toBe(false);
    const lib = [...LIB, entry('my', pack('my', { pointTypes: [{ id: 'r28-camp', name: '营地', color: '#336699' }] } as Partial<ResourcePack>), { mine: true })];
    const rows = repoRows(kind, eng.world, lib).filter((r) => r.id === 'r28-camp');
    // 资源库里有一模一样的：本世界那一份不再单独列
    expect(rows.map((r) => [r.source, r.status.on])).toEqual([['mine', true]]);
    expect(saveableItem(rows[0])).toBeNull();
    expect(canDeleteFromLibrary(rows[0])).toBe(true);
    expect(canDeleteFromLibrary(repoRows(kind, eng.world, lib).find((r) => r.source === 'builtin')!)).toBe(false);
  });

  it('单独一项导出成文件，再从文件导入：读回来是同一项，能添加到别的世界', () => {
    const kind = kindOf('riverType')!;
    const row = repoRows(kind, continents().world, LIB).find((r) => r.id === 'blood_river')!;
    const p = itemPack(row);
    expect(p).toMatchObject({ format: PACK_FORMAT, name: '血河' });
    expect(packItems(p, 'riverTypes')).toEqual([row.item]);
    const read = readPack(JSON.stringify(p), 'x');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(packItems(read.pack, 'riverTypes')).toEqual([row.item]);
    const eng = continents();
    eng.exec(planPack(eng.world, read.pack, { riverTypes: ['blood_river'] }).command);
    expect(eng.world.small.riverTypes!.map((t) => t.name)).toEqual(['血河']);
    // 生态带上用到的自定义场
    const holy = repoRows(kindOf('biome')!, continents().world, LIB).find((r) => r.entry === 'fantasy' && itemPack(r).fields?.length)!;
    expect(holy).toBeDefined();
    expect(readPack(JSON.stringify(itemPack(holy)), 'x').ok).toBe(true);
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
    expect(packEmpty(packFromWorld(continents().world, exportPicks(exportSections(continents().world), new Set(), false), { name: 'x' }))).toBe(true);
  });
});
