import { describe, expect, it } from 'vitest';
import { kindOf } from '../../../core/content/registry';
import { BUILTIN_STYLES } from '../../../core/packs/names';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { packItems } from '../../../core/packs';
import { blankItem, colorHex, copyItem, defaultValue, editorIssues, isObj, newKey, plainHex, withHex, parseTags, pathLabel, renameKey, setField, shownFields, tagsText, weightedRows, weightedValue } from './fields';

// 通用编辑器的字段表：显示哪些字段、检查、示例、新建和复制不撞 id（第二十轮，从 repo.test.ts 搬来）

const styleKind = kindOf('nameStyle')!;
const germanic = BUILTIN_STYLES.find((s) => s.id === 'west-germanic')!;

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

describe('画风（第三十八轮）', () => {
  const mapKind = kindOf('mapStyle')!;

  it('编辑器：换成分层的海时露出来的几项从写实补上；颜色控件认 rgb()、留着不透明度', () => {
    const realistic = packItems<{ id: string }>(builtinPacks()[0], 'mapStyles').find((x) => x.id === 'realistic') as unknown as Record<string, unknown>;
    const copy = copyItem(mapKind, realistic, new Set(['realistic', 'atlas']));
    expect(copy).toMatchObject({ id: 'realistic-2', name: '写实 2' });
    const { tier1: _t, isobath: _i, ...bare } = copy;
    const tiers = setField(mapKind.fields, { ...bare, sea: 'shade' }, 'sea', 'tiers');
    expect(tiers).toMatchObject({ sea: 'tiers', tier1: 'rgb(204, 224.4, 226.95)', isobath: 'rgb(114.75, 147.9, 168.3)' });
    expect(editorIssues(mapKind, tiers).errors).toEqual([]);
    expect(shownFields(mapKind.fields, tiers).map((f) => f.key)).toContain('tier4');
    expect(shownFields(mapKind.fields, copy).map((f) => f.key)).not.toContain('tier4');
    expect(colorHex('rgb(237.15, 221.85, 183.6)')).toBe('#eddeb8');
    expect(colorHex('rgb(265.2, 260.1, 249.9)')).toBe('#fffffa');
    expect(withHex('rgba(52, 104, 168, 0.92)', '#102030')).toBe('rgba(16, 32, 48, 0.92)');
    expect(withHex('rgb(1, 2, 3)', '#102030')).toBe('#102030');
    expect([plainHex('#102030'), plainHex('rgb(1, 2, 3)')]).toEqual([true, false]);
    expect(editorIssues(mapKind, { ...copy, sea: 'tiers', tier2: 'blue' }).errors.map((e) => e.where)).toEqual(['第二层']);
  });
});
