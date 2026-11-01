import { afterEach, describe, expect, it } from 'vitest';
import { type FieldDesc, allKinds, kindOf } from '../../../core/content/registry';
import { cultureGroupSchema, cultureSchema } from '../../../core/human/era';
import { worldTiers } from '../../../core/human/tiers';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES } from '../../../core/packs/eras';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { continents } from '../../../core/testing/fixtures';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { DEDICATED, applyEdit, canRename, canReorder, editable, isDirty, renameCommand, renamed, reorderById, restoreCommand, sameShelf, startEdit } from './edit';
import { defaultValue, isTitleField, moveItem, pathLabel, setField } from './fields';
import { LINE_H, findRow, treeLines, visibleRange } from './lines';
import { DEFAULT_PREFS, PREFS_KEY, loadRepoPrefs, saveRepoPrefs } from './prefs';
import { GOVERNMENT_DIM, refItem, refLabel, refOptions, refOptionsOf, searchRefs } from './refs';
import { type RepoRow, type TreeNode, packTree, treeRows } from './repo';
import { openRepo, patchRepo, repo } from './store';
import { addDim, addValue, erasWritten, removeDim, removeValue, setWeight, shares, tableAt, tendencyRows } from './tendency';

// 第四十五轮：资源库更好编辑——引用从下拉里选、倾向的表、改内置的一项（同 id、同名，写“改过”，能恢复内置）、
// 双击改名、拖动换先后、记着展开的样子（存不了时照默认）、长列表只画看得见的行

const LIB: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ctx = (world: World | null = null) => ({ world, lib: LIB });

afterEach(() => {
  repo.value = null;
});
const current = () => repo.value;

// 整棵树里按条件找一项
const rowsOf = (nodes: readonly TreeNode[]) => nodes.flatMap(treeRows);

describe('字段表：没有原样的 JSON 了，引用都写了是什么', () => {
  it('每一种内容的字段（一层层往下）都没有不带 of 的 json', () => {
    const raw: string[] = [];
    const walk = (kind: string, fs: readonly FieldDesc[] | undefined, at: string) => {
      for (const f of fs ?? []) {
        if (f.type === 'json' && !f.of) raw.push(`${kind}.${at}${f.key}`);
        walk(kind, f.of, `${at}${f.key}.`);
        if (f.value) walk(kind, [f.value], `${at}${f.key}.`);
        walk(kind, f.items, `${at}${f.key}.`);
      }
    };
    for (const k of allKinds()) walk(k.id, k.fields, '');
    expect(raw).toEqual([]);
  });

  it('文化、文化组、取值、政体的换说法、格局：引用写着是哪一种；称号、年份、音节数是成块的字段', () => {
    const f = (kind: string, key: string) => kindOf(kind)!.fields.find((x) => x.key === key)!;
    expect([f('culture', 'group').ref, f('culture', 'nameStyle').ref, f('cultureGroup', 'nameStyle').ref]).toEqual(['cultureGroup', 'nameStyle', 'nameStyle']);
    expect([f('popValue', 'dimension').ref, f('popValue', 'group').ref, f('valueGroup', 'dimension').ref]).toEqual(['dimension', 'valueGroup', 'dimension']);
    const rule = f('government', 'names').of!;
    expect(rule.map((x) => x.ref ?? x.keyRef)).toEqual(['cultureGroup', 'culture', 'valueGroup', 'popValue', 'countryTier', 'countryTier']);
    expect(f('countryLayout', 'weights').keyRef).toBe('countryTier');
    expect(f('era', 'tiers').keyRef).toBe('countryTier');
    expect(kindOf('government')!.fields.filter(isTitleField).map((x) => x.key)).toEqual(['titles', 'rulers']);
    expect([f('era', 'years').type, f('cultureGroup', 'tendencies').type, f('culture', 'eraTendencies').byEra]).toEqual(['tuple', 'tendencies', true]);
    expect(defaultValue(f('era', 'years'))).toEqual([500, 1000]);
    expect(pathLabel(kindOf('era')!.fields, { years: [1, 2] }, ['years', 1])).toBe('年份 · 现在');
  });
});

describe('引用从带搜索的下拉里选', () => {
  it('文化组：资源库里的都列着（名字、颜色），按名字或 id 搜到；选了写进文化，格式照样对', () => {
    const opts = refOptions('cultureGroup', ctx());
    const germanic = BUILTIN_CULTURE_GROUPS.find((g) => g.id === 'germanic')!;
    expect(opts.length).toBeGreaterThanOrEqual(BUILTIN_CULTURE_GROUPS.length);
    expect(opts.find((o) => o.id === 'germanic')).toMatchObject({ label: germanic.name, color: germanic.color });
    expect(searchRefs(opts, germanic.name).list[0].id).toBe('germanic');
    expect(searchRefs(opts, 'GERMAN').list.map((o) => o.id)).toContain('germanic');
    // 一次最多列这么多，其余的写“还有几个”
    const few = searchRefs(opts, '', 10);
    expect([few.list.length, few.more]).toEqual([10, opts.length - 10]);
    const culture = { ...BUILTIN_CULTURES[0] };
    const picked = setField(kindOf('culture')!.fields, culture as Record<string, unknown>, 'group', 'germanic');
    expect(cultureSchema.parse(picked).group).toBe('germanic');
    expect(refLabel(opts, 'germanic')).toBe(germanic.name);
    expect(refLabel(opts, 'no-such')).toBe('no-such');
  });

  it('维度来自时代（另有政体）；取值带维度（倾向的表按它筛）；文化写组名；国家等级从高到低', () => {
    const dims = refOptions('dimension', ctx());
    expect(dims.map((d) => d.id)).toEqual(expect.arrayContaining(['religion', GOVERNMENT_DIM]));
    const values = refOptions('popValue', ctx());
    expect(values.find((v) => v.id === 'catholic')).toMatchObject({ dimension: 'religion' });
    const cultures = refOptions('culture', ctx());
    const c = BUILTIN_CULTURES.find((x) => x.group === 'germanic')!;
    expect(cultures.find((o) => o.id === c.id)!.hint).toBe(BUILTIN_CULTURE_GROUPS.find((g) => g.id === 'germanic')!.name);
    const w = continents().world;
    const tiers = refOptions('countryTier', ctx(w));
    const order = new Map(worldTiers(w.small).map((t) => [t.id, t.order]));
    expect(tiers.map((t) => order.get(t.id) ?? -Infinity)).toEqual([...tiers.map((t) => order.get(t.id) ?? -Infinity)].sort((a, b) => b - a));
    // 称号的键：文化或文化组合在一起
    expect(refOptionsOf(['culture', 'cultureGroup'], ctx()).some((o) => o.id === 'germanic')).toBe(true);
    expect(refItem('cultureGroup', 'germanic', ctx())?.name).toBe(BUILTIN_CULTURE_GROUPS.find((g) => g.id === 'germanic')!.name);
  });
});

describe('倾向的表', () => {
  const group = () => structuredClone(BUILTIN_CULTURE_GROUPS.find((g) => g.id === 'germanic')!) as unknown as Record<string, unknown>;

  it('行是维度，每行几个取值与权重；改权重、加取值、删取值，格式照样对', () => {
    const g = group();
    const rows = tendencyRows(tableAt(g, null));
    const religion = rows.find((r) => r.dim === 'religion')!;
    expect(religion.entries.length).toBeGreaterThan(0);
    const first = religion.entries[0].id;
    const w5 = setWeight(g, null, 'religion', first, 5);
    expect(tendencyRows(tableAt(w5, null)).find((r) => r.dim === 'religion')!.entries[0]).toEqual({ id: first, w: 5 });
    // 权重 1 存回只写 id 的样子
    const w1 = setWeight(w5, null, 'religion', first, 1);
    expect((tableAt(w1, null).religion as unknown[])[0]).toBe(first);
    const added = addValue(w5, null, 'religion', 'orthodox');
    expect(tendencyRows(tableAt(added, null)).find((r) => r.dim === 'religion')!.entries.map((e) => e.id)).toContain('orthodox');
    const gone = removeValue(added, null, 'religion', 'orthodox');
    expect(JSON.stringify(gone)).toBe(JSON.stringify(w5));
    expect(cultureGroupSchema.safeParse(added).success).toBe(true);
    // 百分比
    expect(shares({ dim: 'x', entries: [{ id: 'a', w: 3 }, { id: 'b', w: 1 }] })).toEqual([0.75, 0.25]);
  });

  it('选了时代改的是按时代的倾向：加一维、加取值；删光了这个时代就去掉，整个空了去掉字段', () => {
    const g = group();
    delete g.eraTendencies;
    const a = addDim(g, 'medieval', GOVERNMENT_DIM);
    expect(tableAt(a, 'medieval')).toEqual({ government: [] });
    const b = addValue(a, 'medieval', GOVERNMENT_DIM, 'feudal-monarchy');
    expect(erasWritten(b)).toEqual(['medieval']);
    expect(tableAt(b, 'medieval')).toEqual({ government: ['feudal-monarchy'] });
    // 不分时代的那一份不动
    expect(tableAt(b, null)).toEqual(tableAt(g, null));
    expect(cultureGroupSchema.safeParse(b).success).toBe(true);
    const c = removeDim(b, 'medieval', GOVERNMENT_DIM);
    expect('eraTendencies' in c).toBe(false);
    // 不分时代的删光了：字段去掉
    let d = g;
    for (const r of tendencyRows(tableAt(g, null))) d = removeDim(d, null, r.dim);
    expect('tendencies' in d).toBe(false);
  });
});

describe('改内置的一项：同 id、同名，写“改过”，能恢复内置', () => {
  it('本世界里的内置国家等级：改了用到本世界，id、名字不变，两段都写改过；恢复内置换回原样', () => {
    const eng = continents();
    const tier = worldTiers(eng.world.small)[0];
    const key = `w:countryTier:${tier.id}`;
    const row = findRow(packTree(eng.world, LIB, 'countryTier').world, key)!;
    expect(row.status.modified).toBeFalsy();
    const edit = startEdit(row, eng.world)!;
    expect([edit.how, edit.worldId, isDirty(edit)]).toEqual(['edit', tier.id, false]);
    edit.item = { ...edit.item, area: (tier.area as number) + 1 };
    expect(isDirty(edit)).toBe(true);
    eng.exec(applyEdit(edit, kindOf('countryTier')!, eng.world, row)!);
    const after = packTree(eng.world, LIB, 'countryTier');
    const changed = findRow(after.world, key)!;
    expect([changed.id, changed.name, changed.status.modified]).toEqual([tier.id, tier.name, true]);
    // 资源库那一段的内置项：在本世界，也写改过（不是“添加后叫 X 2”）
    const builtin = rowsOf(after.library).find((r) => r.id === tier.id && r.source === 'builtin')!;
    expect([builtin.status.on, builtin.status.modified, builtin.status.rename]).toEqual([true, true, undefined]);
    const back = restoreCommand(kindOf('countryTier')!, tier.id, eng.world)!;
    expect(back).toMatchObject({ op: 'batch', label: `恢复内置：国家等级“${tier.name}”` });
    eng.exec(back);
    const restored = findRow(packTree(eng.world, LIB, 'countryTier').world, key)!;
    expect(restored.status.modified).toBeFalsy();
    expect(worldTiers(eng.world.small).find((t) => t.id === tier.id)).toEqual(tier);
    expect(restoreCommand(kindOf('countryTier')!, tier.id, eng.world)).toBeNull();
  });

  it('不在本世界的内置文化组：改了直接用到本世界，不另起 id、不带编号，记着来自内置的包；没改时照“添加”', () => {
    const eng = continents();
    const lib = rowsOf(packTree(eng.world, LIB, 'cultureGroup').library).find((r) => r.id === 'germanic')!;
    expect(lib.status.on).toBe(false);
    const edit = startEdit(lib, eng.world)!;
    expect(edit.worldId).toBeUndefined();
    expect(edit.from).toEqual(lib.path);
    // 没改：照资源库的“添加”
    expect(applyEdit(edit, lib.kind, eng.world, lib)).toMatchObject({ label: `添加到本世界：文化组“${lib.name}”` });
    edit.item = { ...edit.item, color: '#123456' };
    const cmd = applyEdit(edit, lib.kind, eng.world, lib)!;
    eng.exec(cmd);
    const world = rowsOf(packTree(eng.world, LIB, 'cultureGroup').world).find((r) => r.id === 'germanic')!;
    expect([world.name, world.status.modified, world.path?.[0]]).toEqual([lib.name, true, lib.path![0]]);
    eng.exec(restoreCommand(lib.kind, 'germanic', eng.world)!);
    expect(rowsOf(packTree(eng.world, LIB, 'cultureGroup').world).find((r) => r.id === 'germanic')!.status.modified).toBeFalsy();
  });

  it('能编辑的种类：生态、河、湖、岛的种类有自己的编辑器，星球形态不在这里改', () => {
    expect([...DEDICATED].map((id) => editable(kindOf(id)!))).toEqual([false, false, false, false]);
    expect([editable(kindOf('planetForm')!), editable(kindOf('culture')!), editable(kindOf('countryLayout')!)]).toEqual([false, true, true]);
  });
});

describe('双击改名、拖动换先后', () => {
  it('本世界里的一项改名是一步命令；空的、太长的名字不行；内置的包里的不能改名', () => {
    const eng = continents();
    const tree = packTree(eng.world, LIB, 'countryTier');
    const row = rowsOf(tree.world)[0];
    expect(canRename(row)).toBe(true);
    const r = renameCommand(row, '  大帝国  ', eng.world);
    expect(r.ok && r.cmd).toMatchObject({ op: 'batch', label: '改名为“大帝国”' });
    if (r.ok) eng.exec(r.cmd);
    expect(worldTiers(eng.world.small).find((t) => t.id === row.id)!.name).toBe('大帝国');
    expect(renamed(row.kind, row.item, '   ')).toEqual({ ok: false, error: '名字不能空着' });
    expect(renamed(row.kind, row.item, '名'.repeat(80)).ok).toBe(false);
    const builtin = rowsOf(tree.library)[0];
    expect([canRename(builtin), canReorder(builtin)]).toEqual([false, false]);
  });

  it('我的资源里的能改名、拖动；只能拖到同一个小包、同一种的另一项上；按 id 换先后', () => {
    const kind = kindOf('countryTier')!;
    const mk = (id: string, path: string[]): RepoRow => ({ kind, key: `l:${path.join('/')}:${id}`, id, name: id, item: { id, name: id }, source: 'mine', pack: { id: 'mine', name: 'mine' }, from: '我的资源', entry: path[0], path, status: { on: false } });
    const a = mk('a', ['mine']);
    const b = mk('b', ['mine']);
    const c = mk('c', ['mine', 'sub']);
    expect([canRename(a), canReorder(a)]).toEqual([true, true]);
    expect([sameShelf(a, b), sameShelf(a, c), sameShelf(a, a)]).toEqual([true, false, false]);
    const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    expect(reorderById(kind, list, 'd', 'a').map((x) => (x as { id: string }).id)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderById(kind, list, 'a', 'c').map((x) => (x as { id: string }).id)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderById(kind, list, 'a', 'zz')).toEqual(list);
    // 编辑器里的列表（换说法的几条……）拖动换先后
    expect(moveItem(['x', 'y', 'z'], 2, 0)).toEqual(['z', 'x', 'y']);
    expect(moveItem(['x', 'y'], 0, 5)).toEqual(['x', 'y']);
  });
});

describe('记着展开的样子：存不了时照默认', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } };
  };

  it('记下种类、展开的包、收起的段，读回来一样；改一项别的照旧', () => {
    const s = memory();
    expect(loadRepoPrefs(s)).toEqual(DEFAULT_PREFS);
    expect(saveRepoPrefs({ kind: 'culture', open: ['l:medieval'], collapsed: ['world'] }, s)).toBe(true);
    expect(saveRepoPrefs({ kind: 'government' }, s)).toBe(true);
    expect(loadRepoPrefs(s)).toEqual({ kind: 'government', open: ['l:medieval'], collapsed: ['world'] });
    s.setItem(PREFS_KEY, '{坏的');
    expect(loadRepoPrefs(s)).toEqual(DEFAULT_PREFS);
  });

  it('读写都抛错、拿 localStorage 都抛错时照默认，不报错；资源库照样打开', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } } as unknown as Storage;
    expect(loadRepoPrefs(bad)).toEqual(DEFAULT_PREFS);
    expect(saveRepoPrefs({ kind: 'culture' }, bad)).toBe(false);
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    try {
      expect(loadRepoPrefs()).toEqual(DEFAULT_PREFS);
      expect(saveRepoPrefs({ kind: 'culture' })).toBe(false);
      openRepo();
      expect(repo.value?.kind).toBe('all');
      patchRepo({ kind: 'culture' });
      expect(repo.value?.kind).toBe('culture');
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('存得了时：打开资源库用上次的种类', () => {
    const s = memory();
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: s });
    try {
      openRepo({ kind: 'era' });
      repo.value = null;
      openRepo();
      expect(current()?.kind).toBe('era');
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('长列表只画看得见的行', () => {
  it('410 个文化全展开时一长列有几百行，画出来的只有几十行；收起的段、没展开的包不摊开', () => {
    const tree = packTree(null, LIB, 'culture');
    const all = new Set<string>();
    const walk = (n: TreeNode) => {
      all.add(n.key);
      n.children.forEach(walk);
    };
    tree.library.forEach(walk);
    const sections = [
      { side: 'world' as const, title: '本世界', nodes: tree.world, count: 0, empty: '先新建或打开世界' },
      { side: 'library' as const, title: '资源库', nodes: tree.library, count: 0, empty: '没有内容' },
    ];
    const lines = treeLines(sections, all, new Set(), false);
    expect(lines.filter((l) => l.t === 'item').length).toBeGreaterThanOrEqual(BUILTIN_CULTURES.length);
    const [a, b] = visibleRange(LINE_H * 200, 600, lines.length);
    expect(b - a).toBeLessThan(45);
    expect(a).toBeLessThanOrEqual(200);
    expect(b).toBeGreaterThan(200 + 600 / LINE_H);
    // 都没展开：只有段和最上面的包
    const shut = treeLines(sections, new Set(), new Set(), false);
    expect(shut.every((l) => l.t !== 'item')).toBe(true);
    // 收起资源库这一段：只剩段的标题
    const folded = treeLines(sections, all, new Set(['library']), false);
    expect(folded.filter((l) => l.side === 'library').map((l) => l.t)).toEqual(['section']);
    // 搜索时包都展开
    expect(treeLines(sections, new Set(), new Set(), true).length).toBe(lines.length);
    expect(visibleRange(0, 0, 0)).toEqual([0, 0]);
  });
});
