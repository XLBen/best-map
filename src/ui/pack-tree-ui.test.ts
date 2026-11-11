import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import { splitWorldContent } from '../../core/compact';
import { type ContentKind, kindOf } from '../../core/content/registry';
import { worldCultures } from '../../core/human';

import { DEFAULT_STYLE } from '../../core/name-styles';
import { PACK_FORMAT, PACK_VERSION, type PackWorld, type ResourcePack, findPack, packItems, packSections } from '../../core/packs';
import { importCommand, importGates } from '../../core/packs/closure';
import { BASE_PATH, builtinPacks } from '../../core/packs/builtin-tree';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_ERAS } from '../../core/packs/eras';

import { continents, snapshot, type HumanCommand, humanExec } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { compactJob, onlyBuiltinScripts } from '../compact-job';
import { type LibraryEntry, keepInLibrary, library, refreshLibrary, removePack, worldPackName, worthKeeping } from '../library';
import { world } from '../state';
import { openFile } from './packs/lib-file';
import { originGroups } from './shell/type-picker';
import { formChoices } from './domain/forms';
import { LOOSE_GROUP, groupByPack } from './domain/human';
import { humanImportCommands, packGroups, packLabel } from './domain/packChoice';
import { ResourceMenu } from './panels/human';
import { WORLD_SOURCE, sourceMenu } from './packs/page-source';
import { libraryRows, removeCommand, rowUsage, worldRows } from './packs/rows';
import { packDialog } from './packs/store';
import { tidyLines, tidyText } from './packs/tidy';
import { FANTASY_RESOURCES, GENERAL_RESOURCES } from '../../core/packs/base';
import { DEFAULT_SPECIES } from '../../core/packs/nature';

// 第二十九轮的界面：世界里的一项记着来源的小包（自己做的没有来源），添加记上来源，移出；
// 选择器、向导按包分组，拿掉的自己做的存进“来自《世界名》”（不重复存），打开世界文件时拆开，导出时压缩，旧的生态文件只进资源库，
// Worker 的整理计划

const entry = (key: string, pack: ResourcePack, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ key, pack, builtin: false, mine: false, installedAt: 1, ...extra });
const BUILTIN: LibraryEntry[] = builtinPacks().map((p) => entry(p.id, p, { builtin: true, installedAt: 0 }));
const pack = (id: string, extra: Partial<ResourcePack>): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, ...extra });
const topName = (id: string) => builtinPacks().find((p) => p.id === id)!.name;

const GEN: HumanCommand = { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {}, settlements: {} };
const peopled = () =>
  snapshot('r29-ui:peopled', () => {
    const e = continents();
    humanExec(e, GEN);
    return e;
  });

const of = (key: string) => BUILTIN.find((e) => e.key === key)!;
const pathIs = (path: readonly string[]) => (r: { path?: string[] }) => r.path?.join('/') === path.join('/');
// 面板上的“添加”“全部添加”：走导入的闭包
const addCmd = (e: LibraryEntry, kind: ContentKind, ids: readonly string[], w: PackWorld) => importCommand({ source: e.pack, target: { t: 'world', world: w }, picks: ids.map((id) => ({ kind: kind.id, id })) }, { path: [e.key] }).command!;

// 本世界做的一个文化（没有来源）
const myCulture = { id: 'my-c', group: 'germanic', name: '我的人', color: '#335577', nameStyle: DEFAULT_STYLE };
const addMine: Command = { op: 'set_content', kind: 'culture', id: myCulture.id, item: myCulture };

afterEach(() => {
  world.value = null;
  packDialog.value = null;
});

describe('来源：库里的小包、世界里记着的', () => {
  it('标题的下拉：内置的库按时代的先后，之后是我的；库里的基础是普通的小包（第三十轮）', () => {
    const mine = entry('我的资源', pack('我的资源', { cultures: [myCulture] } as Partial<ResourcePack>), { mine: true });
    const w = continents().world;
    const m = sourceMenu(WORLD_SOURCE, { world: w, lib: [...BUILTIN, mine] });
    expect(m.builtin.map((x) => (x.src as { key: string }).key)).toEqual(['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi']);
    expect(m.mine.map((x) => x.name)).toEqual(['我的资源']);
    // 新世界里基础的都在
    const base = packSections().flatMap((k) => libraryRows(of('medieval'), k, w).filter(pathIs(BASE_PATH)));
    expect(base.length).toBeGreaterThan(0);
    expect(base.filter((r) => r.kind.id !== 'planetForm').every((r) => r.status.on)).toBe(true);
    // 中世纪 ▸ 政体：19 种，一种都还不在本世界
    const gov = libraryRows(of('medieval'), kindOf('government')!, w).filter(pathIs(['medieval', 'governments']));
    expect([gov.length, gov.filter((r) => r.status.on).length]).toEqual([19, 0]);
    expect(libraryRows(mine, kindOf('culture')!, w).map((r) => [r.source, r.name])).toEqual([['lib', '我的人']]);
  });

  it('世界里的一项记着来源：生成时带进来的是中世纪的包，本世界做的没有来源', () => {
    const eng = peopled();
    eng.exec(addMine);
    expect(worldRows(kindOf('era')!, eng.world).map((r) => [r.id, r.path])).toEqual([['medieval', ['medieval', 'era']]]);
    const rows = worldRows(kindOf('culture')!, eng.world);
    expect(rows.filter((r) => !r.path).map((r) => r.id)).toEqual(['my-c']);
    expect(rows.filter((r) => r.path).every((r) => r.path![0] === 'medieval')).toBe(true);
    expect(rows.filter((r) => r.path).map((r) => r.id).sort()).toEqual(worldCultures(eng.world.small).filter((c) => c.id !== 'my-c').map((c) => c.id).sort());
    // 新世界加的 15 种生态在默认的库“自然”，基础内容在“基础”
    const w0 = continents().world;
    expect(worldRows(kindOf('biome')!, w0).map((r) => [r.id, r.path])).toEqual(DEFAULT_SPECIES.map((s) => [s.id, ['medieval', 'nature']]));
    expect(packSections().some((k) => worldRows(k, w0).some(pathIs(BASE_PATH)))).toBe(true);
  });

  it('只列那一种：现实的河六个库都有（第五十七轮）', () => {
    const w = continents({ noWater: true }).world;
    const kind = kindOf('riverType')!;
    expect(worldRows(kind, w)).toEqual([]);
    expect(BUILTIN.filter((e) => libraryRows(e, kind, w).length).map((e) => e.key)).toEqual(BUILTIN.map((e) => e.key));
    expect(libraryRows(of('fantasy'), kind, w).map((r) => r.name)).toContain('血河');
  });

  it('单项添加记上来源；移出是一步，可以撤销', () => {
    const eng = continents({ noWater: true });
    const kind = kindOf('riverType')!;
    const blood = () => libraryRows(of('fantasy'), kind, eng.world).find((r) => r.id === 'blood_river')!;
    eng.exec(addCmd(of('fantasy'), kind, ['blood_river'], eng.world));
    expect(eng.world.small.origin?.riverType?.blood_river).toEqual(['fantasy', 'rivers']);
    expect(blood().status.on).toBe(true);
    const row = worldRows(kind, eng.world).find((r) => r.id === 'blood_river')!;
    expect(row.path).toEqual(['fantasy', 'rivers']);
    expect(rowUsage(row, eng.world)).toBeNull();
    eng.exec(removeCommand(row, eng.world)!);
    expect(worldRows(kind, eng.world).some((r) => r.id === 'blood_river')).toBe(false);
    expect(eng.world.small.origin?.riverType?.blood_river).toBeUndefined();
    eng.undo();
    expect(eng.world.small.origin?.riverType?.blood_river).toEqual(['fantasy', 'rivers']);
  });

  it('全部添加：一整步，每一项记着小包的路径；只列几项的清理只清没在用的', () => {
    const eng = peopled();
    const kind = kindOf('government')!;
    // 第五十轮：生成后都留着，先整理掉没用到的政体
    const first = eng.planTidy({ only: Object.keys(eng.world.small.content!.government!).map((id) => ({ kind: 'government', id })) });
    // 内置原样的移出时不存（本来就在包里）
    expect(worthKeeping(first.removed)).toEqual([]);
    eng.exec(first.command!);
    const rows = () => libraryRows(of('medieval'), kind, eng.world).filter(pathIs(['medieval', 'governments']));
    const used = rows().filter((r) => r.status.on).length;
    expect(used).toBeGreaterThan(0);
    // 第六十四轮：“限谁用”全部落空的灰着，勾了也进不来（伊克塔只给穆斯林，这个世界的组里没有）
    const off = rows().filter((r) => !r.status.on).map((r) => r.id);
    const gates = importGates(of('medieval').pack, { t: 'world', world: eng.world });
    const grey = off.filter((id) => gates.of({ kind: 'government', id }).t === 'gated');
    expect(grey.length).toBeGreaterThan(0);
    const cmd = addCmd(of('medieval'), kind, off, eng.world);
    expect(cmd.op).toBe('batch');
    const govs = (cmd as Extract<Command, { op: 'batch' }>).commands.filter((c) => c.op === 'set_content' && c.kind === 'government');
    expect(govs).toHaveLength(19 - used - grey.length);
    expect(govs.every((c) => JSON.stringify((c as { from?: string[] }).from) === JSON.stringify(['medieval', 'governments']))).toBe(true);
    eng.exec(cmd);
    expect(rows().filter((r) => r.status.on).length).toBe(19 - grey.length);
    const left = worldRows(kind, eng.world).filter(pathIs(['medieval', 'governments']));
    expect(left.length).toBe(19 - grey.length);
    const plan = eng.planTidy({ only: left.map((r) => ({ kind: 'government', id: r.id })) });
    expect(plan.removed).toHaveLength(19 - used - grey.length);
    eng.exec(plan.command!);
    expect(worldRows(kind, eng.world).filter(pathIs(['medieval', 'governments'])).length).toBe(used);
  });
});

describe('选择器、向导按包分组', () => {
  it('选择器：本世界的按来源的大包分段，离群的放最后；只有一段时不写小标题', () => {
    const eng = continents();
    world.value = eng.world;
    const items = () => (ResourceMenu() as unknown as { props: { items: Parameters<typeof originGroups>[0] } }).props.items;
    // 只有基础的资源：一段，不分
    expect(originGroups(items(), 'resource', eng.world, BUILTIN).every((x) => x.group === undefined)).toBe(true);
    // 加一种奇幻资源（从“奇幻 ▸ 资源”）、一种本世界做的
    const res = libraryRows(of('fantasy'), kindOf('resource')!, eng.world).find(pathIs(['fantasy', 'resources']))!;
    eng.exec(addCmd(of('fantasy'), res.kind, [res.id], eng.world));
    eng.exec({ op: 'set_content', kind: 'resource', id: 'my-res', item: { ...structuredClone(GENERAL_RESOURCES[0]), id: 'my-res', name: '我的资源种' } as unknown as Record<string, unknown> });
    world.value = eng.world;
    const shown = originGroups(items(), 'resource', eng.world, BUILTIN);
    // 恢复自动、无在最前，不分组
    expect(shown.slice(0, 2).map((x) => [x.label, x.group])).toEqual([
      ['恢复自动', undefined],
      ['无', undefined],
    ]);
    const groups = [...new Set(shown.slice(2).map((x) => x.group))];
    expect(groups).toEqual([topName('medieval'), topName('fantasy'), LOOSE_GROUP].filter((g) => groups.includes(g)));
    expect(groups.at(-1)).toBe(LOOSE_GROUP);
    expect(shown.find((x) => x.label === res.name)!.group).toBe(topName('fantasy'));
    expect(shown.find((x) => x.label === '我的资源种')!.group).toBe(LOOSE_GROUP);
    expect(FANTASY_RESOURCES.some((r) => r.id === res.id)).toBe(true);
    // 写了 group 的（文化按文化组）照旧
    expect(originGroups([{ label: 'a', on: false, group: 'g', id: 'x', onPick: () => {} }], 'culture', eng.world, BUILTIN)[0].group).toBe('g');
  });

  it('向导：文化组列选的库里的；包的叫法用路径上的名字；“离群”放最后', () => {
    expect(packLabel(BUILTIN, ['fantasy', 'cultures'])).toBe(`${topName('fantasy')} ▸ 文化`);
    // 库里默认带的组写着权重，别的 EU4 文化组是 0（第五十一轮）
    const mine = packGroups('medieval', BUILTIN);
    expect(mine.length).toBe(71);
    expect(mine.filter((g) => (g.weight ?? 0) > 0).length).toBe(18);
    expect(mine.filter((g) => g.weight === 0).length).toBe(53);
    expect(groupByPack(['a', 'b', 'c'], (x) => (x === 'a' ? LOOSE_GROUP : 'P')).map((s) => s.label)).toEqual(['P', LOOSE_GROUP]);
  });

  it('向导的星球形态：内置的在“奇幻 ▸ 星球形态”里也列得出来，按包分', () => {
    const list = formChoices(BUILTIN);
    expect(list.length).toBeGreaterThan(0);
    // 第三十轮：以前写死的六种星球在库里的“星球形态”（第五十一轮：只列一次，按默认的库）
    expect(new Set(list.map((c) => c.pack))).toEqual(new Set([topName('fantasy'), topName('medieval')]));
  });

  it('选了资源包里的时代、文化组：只带时代和它的维度的取值、组所在小包里的文化和地名风格，记上来源', () => {
    const dim = { id: 'faith', label: '信仰' };
    const era = { ...BUILTIN_ERAS[0], id: 'my-era', name: '我的时代', dimensions: [dim] };
    const value = { id: 'my-faith', dimension: 'faith', name: '我的信仰', color: '#884422' };
    const otherValue = { id: 'other-v', dimension: 'other', name: '别的', color: '#224488' };
    const group = { ...BUILTIN_CULTURE_GROUPS[0], id: 'my-group', name: '我的组' };
    const style = { ...packItems<{ id: string; name: string }>(findPack(builtinPacks().find((p) => p.id === 'medieval')!, ['names'])!, 'nameStyles')[0], id: 'my-style', name: '我的风格' };
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
    const cmds = humanImportCommands({ library: 'lib', groups: ['my-group'] }, null, lib).flatMap((c) => (c.op === 'batch' ? c.commands : [c])) as (Command & { kind: string; id: string; from?: string[] })[];
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
    await removePack(e.key);
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
    // 那个库里列着，在本世界的打勾
    expect(libraryRows(e, kindOf('culture')!, eng.world).map((r) => [r.id, r.status.on])).toEqual([['my-c', true]]);
    await removePack(e.key);
  });

  it('导出、存进我的地图时压缩：加了又移出的命令去掉，核对过才用；有自己写的脚本时不压缩', () => {
    const eng = continents({ cells: 3000 });
    const river = libraryRows(of('fantasy'), kindOf('riverType')!, eng.world).find(pathIs(['fantasy', 'rivers']))!;
    eng.exec(addCmd(of('fantasy'), river.kind, [river.id], eng.world));
    eng.exec({ op: 'remove_river_type', id: river.id });
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

  it('旧的生态文件（第七十二轮以前生态编辑器导出的数组）不再认：弹窗写原因，世界不变', async () => {
    const eng = continents();
    world.value = eng.world as World;
    const before = eng.world.small.species.map((s) => s.id);
    const text = JSON.stringify([{ ...structuredClone(DEFAULT_SPECIES[0]), id: 'old_one', name: '旧的' }]);
    expect(await openFile({ name: '旧生态.json', size: text.length, text: async () => text })).toBeNull();
    const v = packDialog.value;
    expect(v?.view).toBe('import');
    expect(v?.view === 'import' && !v.read.ok && v.read.errors).toEqual(['旧版的生态文件不再能读：请用新版导出的文件']);
    expect(eng.world.small.species.map((s) => s.id)).toEqual(before);
    packDialog.value = null;
  });

  it('清理的问话：移出的按种类一行，留着的一行一项', () => {
    const plan = { command: null, removed: [{ kind: 'government', id: 'g', name: '王国', item: {}, builtinSame: true }], kept: [{ kind: 'biome', id: 'b', name: '沙漠', reason: '移出后地图会变：3 格的生态' }] };
    expect(tidyLines(plan)).toEqual([
      { label: `${kindOf('government')!.label} 1`, hint: '王国' },
      { label: '留着：沙漠', hint: '移出后地图会变：3 格的生态' },
    ]);
    expect(tidyText(plan)).toContain('删除 1 项');
  });
});
