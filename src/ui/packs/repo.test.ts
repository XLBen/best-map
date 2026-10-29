import { describe, expect, it } from 'vitest';
import { kindOf } from '../../../core/content/registry';
import { DEFAULT_STYLE, type NameStyle, worldStyleId } from '../../../core/name-styles';
import { PACK_FORMAT, PACK_VERSION, type ResourcePack } from '../../../core/packs';

import { BUILTIN_STYLES } from '../../../core/packs/names';

import { continents, FANTASY_PACK, NAME_STYLES_SAMPLE } from '../../../core/testing/fixtures';
import type { LibraryEntry } from '../../library';
import { defaultStyleCommand, enabledCount, filterRows, repoKinds, repoRows, toggleCommand } from './repo';
import { blankItem, copyItem, defaultValue, editorIssues, isObj, newKey, parseTags, pathLabel, renameKey, setField, shownFields, tagsText, weightedRows, weightedValue } from './fields';
import { DEFAULT_SPECIES } from '../../../core/packs/nature';

// 资源库（第二十轮）：每一种内容在资源库里有哪些、在这个世界里启用了没有、开关与“默认”是哪条命令；通用编辑器的字段表

const entry = (key: string, pack: ResourcePack, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ key, pack, builtin: false, mine: false, installedAt: 1, ...extra });
const LIB: LibraryEntry[] = [entry('fantasy', FANTASY_PACK, { builtin: true, installedAt: 0 }), entry('name-styles', NAME_STYLES_SAMPLE, { builtin: true, installedAt: 0 })];
const styleKind = kindOf('nameStyle')!;
const biomeKind = kindOf('biome')!;
const germanic = BUILTIN_STYLES.find((s) => s.id === 'west-germanic')!;
const pack = (id: string, extra: Partial<ResourcePack>): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, ...extra });

describe('资源库：列表与开关', () => {
  it('左边的分类：地名风格在最前，自定义场不列', () => {
    const ids = repoKinds().map((k) => k.id);
    expect(ids[0]).toBe('nameStyle');
    expect(ids).toEqual(expect.arrayContaining(['biome', 'riverType', 'lakeType', 'islandType', 'planetForm']));
    expect(ids).not.toContain('field');
  });

  it('地名风格：内置的只列一次；中文·默认在世界里、是默认（第三十轮：普通内容，能移出）；启用、设为默认、停用默认都是一步，可以撤销', () => {
    const eng = continents();
    const w = eng.world;
    let rows = repoRows(styleKind, w, LIB);
    expect(rows.filter((r) => r.source === 'builtin').map((r) => r.id).sort()).toEqual(BUILTIN_STYLES.map((s) => s.id).sort());
    const zh = rows.find((r) => r.id === DEFAULT_STYLE)!;
    expect(zh.status).toMatchObject({ on: true, isDefault: true });
    expect(zh.status.locked).toBeUndefined();
    const row = () => repoRows(styleKind, eng.world, LIB).find((r) => r.id === 'west-germanic')!;
    expect(row().status).toEqual({ on: false });
    // 启用
    const on = toggleCommand(row(), w)!;
    expect(on).toMatchObject({ op: 'batch', label: '添加到本世界：地名风格“西欧·日耳曼”' });
    eng.exec(on);
    expect(row().status).toEqual({ on: true, worldId: 'west-germanic', isDefault: false });
    expect(enabledCount(styleKind, w)).toBe(2);
    // 设为默认
    expect(defaultStyleCommand(row(), w)).toEqual({ op: 'set_name_style', id: 'west-germanic' });
    eng.exec(defaultStyleCommand(row(), w)!);
    expect(row().status.isDefault).toBe(true);
    expect(defaultStyleCommand(row(), w)).toBeNull();
    // 停用默认：世界默认一起换回内置中文
    const off = toggleCommand(row(), w)!;
    expect(off).toMatchObject({ op: 'batch', commands: [{ op: 'set_name_style', id: null }, { op: 'set_content', item: null }] });
    eng.exec(off);
    expect([worldStyleId(w.small), row().status.on]).toEqual([DEFAULT_STYLE, false]);
    eng.undo();
    expect([worldStyleId(w.small), row().status.on]).toEqual(['west-germanic', true]);
    // 没启用的直接设为默认：启用和设为默认一起
    eng.undo();
    eng.undo();
    expect(row().status.on).toBe(false);
    const both = defaultStyleCommand(row(), w)!;
    expect(both).toMatchObject({ op: 'batch', commands: [{ op: 'set_content' }, { op: 'set_name_style', id: 'west-germanic' }] });
    rows = repoRows(styleKind, w, LIB);
    expect(rows.find((r) => r.id === DEFAULT_STYLE)!.status.isDefault).toBe(true);
  });

  it('有问题的地名风格：开关不能动，写着原因', () => {
    const bad: NameStyle = { ...germanic, id: 'bad', name: '坏的', types: { island: { patterns: [{ p: '{root}{nope}' }] } } } as NameStyle;
    const lib = [...LIB, entry('x', pack('x', { nameStyles: [bad] }))];
    const r = repoRows(styleKind, continents().world, lib).find((x) => x.id === 'bad')!;
    expect(r.source).toBe('imported');
    expect(r.status.on).toBe(false);
    expect(r.status.locked).toMatch(/nope/);
    expect(toggleCommand(r, continents().world)).toBeNull();
  });

  it('生态：内置的本来就在世界里；示例包的启用后在用；世界里自己做的单独列出；同 id 不同内容的启用后改名', () => {
    const eng = continents();
    const w = eng.world;
    const rows = repoRows(biomeKind, w, LIB);
    const builtin = rows.filter((r) => r.source === 'builtin');
    expect(builtin.filter((r) => r.status.on).map((r) => r.id)).toEqual(DEFAULT_SPECIES.map((s) => s.id));
    const crystal = builtin.find((r) => !r.status.on)!;
    expect(crystal).toBeDefined();
    eng.exec(toggleCommand(crystal, w)!);
    const again = repoRows(biomeKind, w, LIB).find((r) => r.key === crystal.key)!;
    expect(again.status.on).toBe(true);
    // 停用：删除那种生态
    expect(toggleCommand(again, w)).toEqual({ op: 'remove_species', id: again.status.worldId });
    // 世界里自己做的
    eng.exec({ op: 'add_species', species: { ...DEFAULT_SPECIES[0], id: 'mine_x', name: '我的林' } });
    const own = repoRows(biomeKind, w, LIB).find((r) => r.id === 'mine_x')!;
    expect([own.source, own.from, own.status.on]).toEqual(['world', '这个世界', true]);
    // 导入的包里有同 id、不同内容的：启用后叫别的名字
    const clash = { ...DEFAULT_SPECIES[0], color: '#123456' };
    const lib = [...LIB, entry('c', pack('c', { biomes: [clash] }))];
    const r = repoRows(biomeKind, w, lib).find((x) => x.entry === 'c')!;
    expect(r.status.on).toBe(false);
    expect(r.status.rename).toMatch(/2$/);
  });

  it('筛选：来源、在用、搜索、只看一个包；没有世界时开关不能动；星球形态只列出来', () => {
    const w = continents().world;
    const mine = entry('m', pack('m', { nameStyles: [{ ...germanic, id: 'my-g', name: '我的日耳曼' }] }), { mine: true });
    const rows = repoRows(styleKind, w, [...LIB, mine]);
    expect(filterRows(rows, 'mine').map((r) => r.id)).toEqual(['my-g']);
    expect(filterRows(rows, 'on').map((r) => r.id)).toEqual([DEFAULT_STYLE]);
    expect(filterRows(rows, 'builtin').length).toBe(BUILTIN_STYLES.length);
    expect(filterRows(rows, 'all', '日耳曼').map((r) => r.id)).toEqual(expect.arrayContaining(['west-germanic', 'my-g']));
    expect(filterRows(rows, 'all', '我的').map((r) => r.id)).toEqual(['my-g']);
    expect(filterRows(rows, 'all', '', 'm').map((r) => r.id)).toEqual(['my-g']);
    expect(repoRows(styleKind, null, LIB)[1].status).toEqual({ on: false, locked: '先新建或打开世界' });
    const forms = repoRows(kindOf('planetForm')!, w, LIB);
    expect(forms.length).toBeGreaterThan(0);
    expect(forms.every((r) => r.status.locked && toggleCommand(r, w) === null)).toBe(true);
  });
});

describe('通用编辑器的字段表', () => {
  const fields = styleKind.fields;
  it('模板式、音译式各显示自己的字段；换写法时去掉看不见的、补上必填的，词表和各类地物留着', () => {
    const tpl = styleKind.blank!() as Record<string, unknown>;
    const keys = (o: Record<string, unknown>) => shownFields(fields, o).map((f) => f.key);
    expect(keys(tpl)).toEqual(['id', 'name', 'description', 'kind', 'lists', 'types', 'readings']);
    const withReadings = setField(fields, tpl, 'readings', { 青: 'ao' });
    const ph = setField(fields, withReadings, 'kind', 'phonetic');
    expect(keys(ph)).toEqual(['id', 'name', 'description', 'kind', 'syllables', 'length', 'lists', 'forbid', 'types', 'translit', 'vowels', 'fallback']);
    expect(ph.readings).toBeUndefined();
    expect(ph.lists).toEqual(tpl.lists);
    expect(ph.types).toEqual(tpl.types);
    expect(ph.syllables).toEqual({ onsets: [], nuclei: [], codas: [] });
    expect(ph.translit).toEqual({});
    // 可以不写的字段空了就去掉
    expect('description' in setField(fields, tpl, 'description', '')).toBe(false);
    expect(defaultValue({ key: 'w', label: '权重', type: 'number', min: 0.01 })).toBe(1);
  });

  it('检查：新建的样子合格；坏的词表、内置中文的 id 不能用；出错的位置按字段的名字说；音译表缺字母是提醒', () => {
    expect(editorIssues(styleKind, styleKind.blank!())).toEqual({ errors: [], notes: [] });
    const bad = { ...(styleKind.blank!() as object), types: { island: { patterns: [{ p: '{zz}岛' }] } } };
    expect(editorIssues(styleKind, bad).errors[0].message).toMatch(/\{zz\}/);
    const noP = { ...(styleKind.blank!() as object), types: { island: { patterns: [{ w: 2 }] } } };
    const e = editorIssues(styleKind, noP).errors[0];
    expect(e.where).toBe('各类地物 · island · 模板 · 第 1 个 · 写法');
    expect(pathLabel(fields, germanic, ['syllables', 'onsets', 0])).toBe('音节 · 声母 · 第 1 个');
    // 刚换成音译式：空的音节表一处一处说
    const ph = editorIssues(styleKind, setField(fields, styleKind.blank!() as Record<string, unknown>, 'kind', 'phonetic')).errors;
    expect(ph.map((x) => `${x.where}：${x.message}`)).toEqual(expect.arrayContaining(['音节 · 声母：至少要有一个', '音节数：至少要有一个']));
    const thin = { ...germanic, translit: { ka: '卡' } };
    expect(editorIssues(styleKind, thin).notes[0]).toMatch(/音译表里没有/);
    expect(editorIssues(styleKind, germanic)).toEqual({ errors: [], notes: [] });
  });

  it('随机示例：每类地物几个名字，音译式带原文；换一批不一样', () => {
    const groups = styleKind.samples!(germanic, 1);
    expect(groups[0].label).toBe('省份');
    expect(groups.every((g) => g.lines.length === 4)).toBe(true);
    expect(groups[0].lines[0]).toMatch(/　[A-Z]/);
    expect(styleKind.samples!(germanic, 2)).not.toEqual(groups);
  });

  it('几种写法的转换、新建与复制不撞 id', () => {
    expect(parseTags('青 白、黑,赤')).toEqual(['青', '白', '黑', '赤']);
    expect(tagsText(['a', 'b'])).toBe('a b');
    const w = [['k', 3], 'v', ['', 6]];
    expect(weightedValue(weightedRows(w))).toEqual(w);
    expect(renameKey({ a: 1, b: 2 }, 'a', 'c')).toEqual({ c: 1, b: 2 });
    expect(Object.keys(renameKey({ a: 1, b: 2 }, 'a', 'b'))).toEqual(['a', 'b']);
    expect(newKey({ new: 1, new2: 1 })).toBe('new3');
    const taken = new Set(['my-style', 'west-germanic', 'west-germanic-2']);
    expect(blankItem(styleKind, taken)!.id).toBe('my-style-2');
    const c = copyItem(styleKind, germanic, taken);
    expect([c.id, c.name]).toEqual(['west-germanic-3', '西欧·日耳曼 3']);
    expect(isObj(c.types) && c.types !== germanic.types).toBe(true);
  });
});
