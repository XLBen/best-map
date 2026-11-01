import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import { splitWorldContent } from '../../core/compact';
import { kindOf } from '../../core/content/registry';
import { worldCultures } from '../../core/human';

import { DEFAULT_STYLE } from '../../core/name-styles';
import { PACK_FORMAT, PACK_VERSION, type ResourcePack, findPack, packItems } from '../../core/packs';
import { BASE_PATH, builtinPacks } from '../../core/packs/builtin-tree';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_ERAS } from '../../core/packs/eras';

import { continents, snapshot, type HumanCommand, humanExec } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { compactJob, onlyBuiltinScripts } from '../compact-job';
import { type LibraryEntry, keepInLibrary, library, refreshLibrary, removeItem, worldPackName, worthKeeping } from '../library';
import { world } from '../state';
import { importBiomeFile } from './ClimateChart';
import { originGroups } from './components/TypePicker';
import { formChoices } from './forms';
import { LOOSE_GROUP, groupByPack } from './human';
import { humanImportCommands, packGroups, packLabel } from './packChoice';
import { ResourceMenu } from './panels/human';
import { type TreeNode, addCommand, filterTree, packAddCommand, packRemoveRefs, packTree, removeCommand, rowUsage, treeRows } from './packs/repo';
import { packDialog, repo } from './packs/store';
import { tidyLines, tidyText } from './packs/tidy';
import { FANTASY_RESOURCES, GENERAL_RESOURCES } from '../../core/packs/base';
import { DEFAULT_SPECIES } from '../../core/packs/nature';

// 第二十九轮的界面：资源库两栏（本世界按来源的包分组、离群在最后；资源库是包的树，整包添加记上来源，单项添加、移出，种类筛选），
// 选择器、向导按包分组，拿掉的自己做的存进“来自《世界名》”（不重复存），打开世界文件时拆开，导出时压缩，旧的生态文件只进资源库，
// Worker 的整理计划

const entry = (key: string, pack: ResourcePack, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ key, pack, builtin: false, mine: false, installedAt: 1, ...extra });
const BUILTIN: LibraryEntry[] = builtinPacks().map((p) => entry(p.id, p, { builtin: true, installedAt: 0 }));
const pack = (id: string, extra: Partial<ResourcePack>): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, ...extra });
const topName = (id: string) => builtinPacks().find((p) => p.id === id)!.name;

const GEN: HumanCommand = { op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }], countries: {}, settlements: {} };
const peopled = () =>
  snapshot('r29-ui:peopled', () => {
    const e = continents();
    humanExec(e, GEN);
    return e;
  });

const find = (nodes: readonly TreeNode[], key: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = find(n.children, key);
    if (hit) return hit;
  }
  return undefined;
};

// 本世界做的一个文化（没有来源）
const myCulture = { id: 'my-c', group: 'western', name: '我的人', color: '#335577', nameStyle: DEFAULT_STYLE };
const addMine: Command = { op: 'set_content', kind: 'culture', id: myCulture.id, item: myCulture };

afterEach(() => {
  world.value = null;
  repo.value = null;
  packDialog.value = null;
});

describe('资源库两栏：packTree', () => {
  it('资源库一栏：内置的大包按时代的先后、通用在最后，之后是我的、装上的；通用 ▸ 基础是普通的包（第三十轮）', () => {
    const mine = entry('我的资源', pack('我的资源', { cultures: [myCulture] } as Partial<ResourcePack>), { mine: true });
    const t = packTree(continents().world, [...BUILTIN, mine]);
    expect(t.library.map((n) => n.path[0])).toEqual(['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi', 'common', '我的资源']);
    const base = find(t.library, `l:${BASE_PATH.join('/')}`)!;
    expect(Object.keys(base)).not.toContain('base');
    // 新世界里基础的都在：没有能加的
    expect(packAddCommand(base, continents().world)).toBeNull();
    expect(base.on).toBe(base.count);
    // 中世纪 ▸ 政体：13 种，一种都还不在本世界
    const gov = find(t.library, 'l:medieval/governments')!;
    expect([gov.name, gov.count, gov.on]).toEqual(['政体', 13, 0]);
    expect(t.library.at(-1)!.rows.map((r) => [r.source, r.name])).toEqual([['mine', '我的人']]);
  });

  it('本世界一栏：按来源的包分组（大包 ▸ 小包），先后照资源库；本世界做的在最后的“离群”', () => {
    const eng = peopled();
    eng.exec(addMine);
    const t = packTree(eng.world, BUILTIN);
    const tops = t.world.map((n) => n.name);
    expect(tops.at(-1)).toBe('离群');
    expect(tops).toEqual(expect.arrayContaining([topName('medieval'), topName('common')]));
    expect(tops.indexOf(topName('medieval'))).toBeLessThan(tops.indexOf(topName('common')));
    expect(t.world.at(-1)!.rows.map((r) => r.id)).toEqual(['my-c']);
    // 生成时带进来的时代、文化记着中世纪的包
    const era = find(t.world, 'w:medieval/era')!;
    expect(era.rows.map((r) => r.id)).toEqual(['medieval']);
    const cultures = worldCultures(eng.world.small).filter((c) => c.id !== 'my-c');
    const listed = treeRows(t.world.find((n) => n.path[0] === 'medieval')!).filter((r) => r.kind.id === 'culture');
    expect(listed.map((r) => r.id).sort()).toEqual(cultures.map((c) => c.id).sort());
    // 新世界加的 13 种生态在“通用 ▸ 自然”，基础内容在“通用 ▸ 基础”
    const w0 = packTree(continents().world, BUILTIN);
    expect(find(w0.world, 'w:common/nature')!.rows.map((r) => r.id)).toEqual(DEFAULT_SPECIES.map((s) => s.id));
    expect(find(w0.world, `w:${BASE_PATH.join('/')}`)!.rows.length).toBeGreaterThan(0);
  });

  it('种类筛选：只列那一种；搜索：名字对上的项和它们所在的包', () => {
    const w = continents().world;
    const t = packTree(w, BUILTIN, 'riverType');
    expect(t.world).toEqual([]);
    expect(t.library.map((n) => n.path[0])).toEqual(['fantasy']);
    expect(new Set(t.library.flatMap(treeRows).map((r) => r.kind.id))).toEqual(new Set(['riverType']));
    const all = packTree(w, BUILTIN);
    const hit = filterTree(all.library, '血');
    expect(hit.flatMap(treeRows).map((r) => r.name)).toContain('血河');
    expect(hit.flatMap(treeRows).every((r) => r.name.includes('血') || r.id.includes('血'))).toBe(true);
    // 只列不在本世界的
    const off = filterTree(all.library, '', true);
    expect(off.flatMap(treeRows).some((r) => r.status.on)).toBe(false);
  });

  it('单项添加记上来源，左栏归到那个包；移出是一步，可以撤销', () => {
    const eng = continents();
    const blood = () => find(packTree(eng.world, BUILTIN, 'riverType').library, 'l:fantasy/rivers')!.rows.find((r) => r.id === 'blood_river')!;
    const add = addCommand(blood(), eng.world)!;
    expect(add).toMatchObject({ op: 'batch', commands: [{ op: 'set_river_type', from: ['fantasy', 'rivers'] }] });
    eng.exec(add);
    expect(eng.world.small.origin?.riverType?.blood_river).toEqual(['fantasy', 'rivers']);
    expect(blood().status.on).toBe(true);
    const left = packTree(eng.world, BUILTIN, 'riverType').world;
    const row = find(left, 'w:fantasy/rivers')!.rows[0];
    expect([row.id, find(left, 'w:fantasy/rivers')!.name]).toEqual(['blood_river', '奇幻的河']);
    expect(rowUsage(row, eng.world)).toBeNull();
    eng.exec(removeCommand(row, eng.world)!);
    expect(packTree(eng.world, BUILTIN, 'riverType').world).toEqual([]);
    expect(eng.world.small.origin?.riverType?.blood_river).toBeUndefined();
    eng.undo();
    expect(eng.world.small.origin?.riverType?.blood_river).toEqual(['fantasy', 'rivers']);
  });

  it('全部添加：一整步，每一项记着小包的路径；左栏一个包“移出没用到的”只移没在用的', () => {
    const eng = peopled();
    const node = () => find(packTree(eng.world, BUILTIN, 'government').library, 'l:medieval/governments')!;
    const used = node().on;
    expect(used).toBeGreaterThan(0);
    const cmd = packAddCommand(node(), eng.world)!;
    expect(cmd).toMatchObject({ op: 'batch', label: '添加到本世界：“政体”' });
    const cmds = (cmd as Extract<Command, { op: 'batch' }>).commands;
    expect(cmds).toHaveLength(13 - used);
    expect(cmds.every((c) => c.op === 'set_content' && JSON.stringify((c as { from?: string[] }).from) === JSON.stringify(['medieval', 'governments']))).toBe(true);
    eng.exec(cmd);
    expect([node().on, node().count]).toEqual([13, 13]);
    expect(packAddCommand(node(), eng.world)).toBeNull();
    // 左栏：中世纪 ▸ 政体 13 种；移出没用到的
    const left = find(packTree(eng.world, BUILTIN, 'government').world, 'w:medieval/governments')!;
    expect(left.count).toBe(13);
    const refs = packRemoveRefs(left);
    expect(refs).toHaveLength(13);
    const plan = eng.planTidy({ only: refs });
    expect(plan.removed).toHaveLength(13 - used);
    eng.exec(plan.command!);
    expect(find(packTree(eng.world, BUILTIN, 'government').world, 'w:medieval/governments')!.count).toBe(used);
    // 内置原样的移出时不存（本来就在包里）
    expect(worthKeeping(plan.removed)).toEqual([]);
  });
});

describe('选择器、向导按包分组', () => {
  it('选择器：本世界的按来源的大包分段，离群的放最后；只有一段时不写小标题', () => {
    const eng = continents();
    world.value = eng.world;
    const items = () => (ResourceMenu() as unknown as { props: { items: Parameters<typeof originGroups>[0] } }).props.items;
    // 只有通用的资源：一段，不分
    expect(originGroups(items(), 'resource', eng.world, BUILTIN).every((x) => x.group === undefined)).toBe(true);
    // 加一种奇幻资源（从“奇幻 ▸ 资源”）、一种本世界做的
    const res = find(packTree(eng.world, BUILTIN, 'resource').library, 'l:fantasy/resources')!.rows[0];
    eng.exec(addCommand(res, eng.world)!);
    eng.exec({ op: 'set_content', kind: 'resource', id: 'my-res', item: { ...structuredClone(GENERAL_RESOURCES[0]), id: 'my-res', name: '我的资源种' } as unknown as Record<string, unknown> });
    world.value = eng.world;
    const shown = originGroups(items(), 'resource', eng.world, BUILTIN);
    // 恢复自动、无在最前，不分组
    expect(shown.slice(0, 2).map((x) => [x.label, x.group])).toEqual([
      ['恢复自动', undefined],
      ['无', undefined],
    ]);
    const groups = [...new Set(shown.slice(2).map((x) => x.group))];
    expect(groups).toEqual([topName('fantasy'), topName('common'), LOOSE_GROUP].filter((g) => groups.includes(g)));
    expect(groups.at(-1)).toBe(LOOSE_GROUP);
    expect(shown.find((x) => x.label === res.name)!.group).toBe(topName('fantasy'));
    expect(shown.find((x) => x.label === '我的资源种')!.group).toBe(LOOSE_GROUP);
    expect(FANTASY_RESOURCES.some((r) => r.id === res.id)).toBe(true);
    // 写了 group 的（文化按文化组）照旧
    expect(originGroups([{ label: 'a', on: false, group: 'g', id: 'x', onPick: () => {} }], 'culture', eng.world, BUILTIN)[0].group).toBe('g');
  });

  it('向导（第三十轮）：文化组按勾着的包分段（时代包、通用 ▸ 文化）；“离群”放最后', () => {
    const groups = packGroups([['medieval'], ['common', 'cultures']], BUILTIN);
    const labels = [...new Set(groups.map((g) => packLabel(BUILTIN, g.pack)))];
    expect(labels).toEqual([topName('medieval'), `${topName('common')} ▸ 文化`]);
    // 时代包里的组带默认的权重，通用的没有
    expect(groups.filter((g) => g.pack[0] === 'medieval').every((g) => (g.weight ?? 0) > 0)).toBe(true);
    expect(groups.filter((g) => g.pack[0] === 'common').every((g) => g.weight === undefined)).toBe(true);
    expect(groupByPack(['a', 'b', 'c'], (x) => (x === 'a' ? LOOSE_GROUP : 'P')).map((s) => s.label)).toEqual(['P', LOOSE_GROUP]);
  });

  it('向导的星球形态：内置的在“奇幻 ▸ 星球形态”里也列得出来，按包分', () => {
    const list = formChoices(BUILTIN);
    expect(list.length).toBeGreaterThan(0);
    // 第三十轮：以前写死的六种星球在“通用 ▸ 星球形态”里
    expect(new Set(list.map((c) => c.pack))).toEqual(new Set([topName('fantasy'), topName('common')]));
  });

  it('选了资源包里的时代、文化组：只带时代和它的维度的取值、组所在小包里的文化和地名风格，记上来源', () => {
    const dim = { id: 'faith', label: '信仰' };
    const era = { ...BUILTIN_ERAS[0], id: 'my-era', name: '我的时代', dimensions: [dim] };
    const value = { id: 'my-faith', dimension: 'faith', name: '我的信仰', color: '#884422' };
    const otherValue = { id: 'other-v', dimension: 'other', name: '别的', color: '#224488' };
    const group = { ...BUILTIN_CULTURE_GROUPS[0], id: 'my-group', name: '我的组' };
    const style = { ...packItems<{ id: string; name: string }>(findPack(builtinPacks().find((p) => p.id === 'common')!, ['names'])!, 'nameStyles')[0], id: 'my-style', name: '我的风格' };
    const culture = { id: 'my-culture', group: 'my-group', name: '我的人', color: '#335577', nameStyle: 'my-style' };
    const stray = { id: 'stray', group: 'other-group', name: '别组的人', color: '#335577', nameStyle: 'my-style' };
    const p = pack('lib', {
      packs: [
        { id: 'era', name: '时代', eras: [era], popValues: [value, otherValue] },
        { id: 'g', name: '我的组', cultureGroups: [group], cultures: [culture], nameStyles: [style] },
        { id: 'other', name: '别的', cultures: [stray] },
      ],
    } as Partial<ResourcePack>);
    const lib = [...BUILTIN, entry('lib', p, { mine: true })];
    const cmds = humanImportCommands({ packs: [['lib']], groups: [{ id: 'my-group', weight: 1 }] }, null, lib).flatMap((c) => (c.op === 'batch' ? c.commands : [c])) as (Command & { kind: string; id: string; from?: string[] })[];
    // 第三十轮：一个 batch（core/packs/import.ts）；只有一项的种类不排先后
    expect(cmds.map((c) => [c.kind, c.id, c.from])).toEqual([
      ['nameStyle', 'my-style', ['lib', 'g']],
      ['era', 'my-era', ['lib', 'era']],
      ['popValue', 'my-faith', ['lib', 'era']],
      ['cultureGroup', 'my-group', ['lib', 'g']],
      ['culture', 'my-culture', ['lib', 'g']],
    ]);
  });
});

describe('拿掉的不丢', () => {
  it('移出的自己做的存进“来自《世界名》”（按种类分小包），一模一样的不重复存；内置原样的不存；能从库里删掉', async () => {
    const eng = continents();
    eng.exec(addMine);
    eng.exec({ op: 'set_content', kind: 'culture', id: 'my-c', item: null });
    const removed = eng.lastRemoved;
    expect(removed.map((r) => [r.kind, r.id])).toEqual([['culture', 'my-c']]);
    const name = '移出测试';
    expect(await keepInLibrary(name, removed)).toMatchObject({ saved: 1 });
    const e = library.value.find((x) => x.key === worldPackName(name))!;
    expect([e.mine, e.pack.name, e.pack.packs?.map((n) => n.id)]).toEqual([true, '来自《移出测试》', ['cultures']]);
    expect(packItems<{ id: string }>(e.pack, 'cultures').map((c) => c.id)).toEqual(['my-c']);
    // 再存一次：一模一样的不重复存；别的世界的包里有了，这里也不存
    expect(await keepInLibrary(name, removed)).toMatchObject({ saved: 0 });
    expect(await keepInLibrary('另一个世界', removed)).toMatchObject({ saved: 0 });
    // 内置原样（Worker 认不出的奇幻的河也按完整的树再看一遍）
    const blood = packItems(findPack(builtinPacks().find((p) => p.id === 'fantasy')!, ['rivers'])!, 'riverTypes')[0];
    expect(worthKeeping([{ kind: 'riverType', item: blood, builtinSame: false }])).toEqual([]);
    // 从库里删除：分了小包的包里也删得掉，空了整个包去掉
    expect(await removeItem(e.key, 'cultures', 'my-c')).toEqual({ ok: true });
    expect((await refreshLibrary()).some((x) => x.key === e.key)).toBe(false);
  });

  it('打开世界文件时拆开：自己做的内容存进“来自《文件名》”，再打开一次不重复存', async () => {
    const eng = continents();
    eng.exec(addMine);
    const items = splitWorldContent(eng.world);
    expect(items.map((x) => [x.kind, x.id])).toEqual([['culture', 'my-c']]);
    expect(await keepInLibrary('拆开测试', items)).toMatchObject({ saved: 1 });
    expect(await keepInLibrary('拆开测试', splitWorldContent(eng.world))).toMatchObject({ saved: 0 });
    const e = library.value.find((x) => x.key === worldPackName('拆开测试'))!;
    // 资源库一栏里列着，在本世界的打勾
    const t = packTree(eng.world, library.value, 'culture');
    const node = t.library.find((n) => n.entry === e.key)!;
    expect(treeRows(node).map((r) => [r.id, r.status.on, r.source])).toEqual([['my-c', true, 'mine']]);
    await removeItem(e.key, 'cultures', 'my-c');
  });

  it('导出、存进我的地图时压缩：加了又移出的命令去掉，核对过才用；有自己写的脚本时不压缩', () => {
    const eng = continents({ cells: 3000 });
    const t = packTree(eng.world, BUILTIN, 'riverType');
    eng.exec(addCommand(find(t.library, 'l:fantasy/rivers')!.rows[0], eng.world)!);
    eng.exec({ op: 'remove_river_type', id: find(t.library, 'l:fantasy/rivers')!.rows[0].id });
    const doc = eng.toDoc();
    const r = compactJob({ compact: doc });
    expect('compacted' in r && r.ok).toBe(true);
    const c = (r as Extract<typeof r, { compacted: unknown }>).compacted;
    expect(c.verified).toBe(true);
    expect(c.dropped).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(c.doc).length).toBeLessThan(JSON.stringify(doc).length);
    expect(onlyBuiltinScripts(builtinPacks())).toBe(true);
    const own = { commands: [{ op: 'add_species', species: { id: 'x', name: 'x', scripts: { placement: { src: 'return 0.5' } } } }] };
    expect(onlyBuiltinScripts(own)).toBe(false);
    expect(compactJob({ compact: { ...doc, commands: [...doc.commands, ...(own.commands as unknown as Command[])] } })).toEqual({ ok: true, skipped: '有自己写的脚本' });
  });

  it('旧的生态文件只进资源库：打开导入的确认，世界不变', () => {
    const eng = continents();
    world.value = eng.world as World;
    const before = eng.world.small.species.map((s) => s.id);
    importBiomeFile(JSON.stringify([{ ...structuredClone(DEFAULT_SPECIES[0]), id: 'old_one', name: '旧的' }]), '旧生态.json');
    const v = packDialog.value;
    expect(v?.view).toBe('import');
    expect(v?.view === 'import' && v.read.ok && v.read.legacy).toBe('biomes');
    expect(eng.world.small.species.map((s) => s.id)).toEqual(before);
  });

  it('整理本世界的问话：移出的、留着的一行一项', () => {
    const plan = { command: null, removed: [{ kind: 'government', id: 'g', name: '王国', item: {}, builtinSame: true }], kept: [{ kind: 'biome', id: 'b', name: '沙漠', reason: '移出后地图会变：3 格的生态' }] };
    expect(tidyLines(plan)).toEqual([
      { label: '王国', hint: kindOf('government')!.label },
      { label: '留着：沙漠', hint: '移出后地图会变：3 格的生态' },
    ]);
    expect(tidyText(plan)).toContain('移出 1 项');
  });
});
