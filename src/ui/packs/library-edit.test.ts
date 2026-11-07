import { describe, expect, it } from 'vitest';
import { type FieldDesc, allKinds, kindOf } from '../../../core/content/registry';
import { cultureGroupSchema, cultureSchema } from '../../../core/human/era';
import { worldTiers } from '../../../core/human/tiers';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES } from '../../../core/packs/eras';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { continents } from '../../../core/testing/fixtures';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { defaultValue, isTitleField, moveItem, pathLabel, setField } from './fields';
import { GOVERNMENT_DIM, refItem, refLabel, refOptions, refOptionsOf, searchRefs } from './refs';
import { addDim, addValue, erasWritten, removeDim, removeValue, setWeight, shares, tableAt, tendencyRows } from './tendency';

// 第四十五轮：资源库更好编辑——字段表、引用从下拉里选、倾向的表（新面板的表单沿用这些）

const LIB: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ctx = (world: World | null = null) => ({ world, lib: LIB });

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

describe('编辑器里的列表', () => {
  it('换说法的几条……拖动换先后', () => {
    expect(moveItem(['x', 'y', 'z'], 2, 0)).toEqual(['z', 'x', 'y']);
    expect(moveItem(['x', 'y'], 0, 5)).toEqual(['x', 'y']);
  });
});
