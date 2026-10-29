import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ResourcePack, packCounts, packFromWorld, packProblems, packSection, packSections, packSummary, parsePack, planPack, readPack } from '../packs';

import { BUILTIN_STYLES } from '../packs/names';
import { continents, FANTASY_PACK, NAME_STYLES_SAMPLE } from '../testing/fixtures';
import { allKinds, contentItems, disableCommand, enableCommand, isEnabled, kindByPackKey, kindOf, registerKind, unregisterKind } from './registry';

// 第二十轮：内容种类的登记表。登记一次，资源包的段、数、列表的一行、检查、用到世界、导出都跟着有；
// 现有的几种迁进来后资源包的格式不变

const pack = (extra: Partial<ResourcePack> = {}): ResourcePack => ({ format: 'map2-pack', version: 1, id: 'p', name: '测试包', ...extra });

describe('内容种类的登记表', () => {
  afterEach(() => unregisterKind('testThing'));

  it('现有的几种都登记了：段名、全称、简称、先后', () => {
    expect(allKinds().map((k) => [k.id, k.pack.key, k.label, k.short])).toEqual([
      ['biome', 'biomes', '生态', '生态'],
      ['riverType', 'riverTypes', '河的种类', '河流'],
      ['lakeType', 'lakeTypes', '湖的种类', '湖泊'],
      ['islandType', 'islandTypes', '岛的种类', '岛'],
      ['planetForm', 'planetForms', '星球形态', '星球'],
      ['nameStyle', 'nameStyles', '地名风格', '地名风格'],
      ['terrainClass', 'terrainClasses', '地形类别', '地形类别'],
      ['resource', 'resources', '资源', '资源'],
      ['era', 'eras', '时代', '时代'],
      ['popValue', 'popValues', '人口维度的取值', '取值'],
      ['cultureGroup', 'cultureGroups', '文化组', '文化组'],
      ['culture', 'cultures', '文化', '文化'],
      ['government', 'governments', '政体', '政体'],
      ['faction', 'factions', '派系', '派系'],
      ['cityRank', 'cityRanks', '城市等级', '城市等级'],
      ['landmarkType', 'landmarkTypes', '地标类型', '地标'],
      ['pointType', 'pointTypes', '自定义点的类型', '点'],
      ['field', 'fields', '自定义场', '场'],
    ]);
    expect(packSections().map((k) => k.id)).toEqual(['biome', 'riverType', 'lakeType', 'islandType', 'planetForm', 'nameStyle', 'terrainClass', 'resource', 'era', 'popValue', 'cultureGroup', 'culture', 'government', 'faction', 'cityRank', 'landmarkType', 'pointType']);
    expect(kindByPackKey('textPacks')?.id).toBe('nameStyle');
    // 每种都有编辑器的字段表
    for (const k of allKinds()) expect(k.fields.length, k.id).toBeGreaterThan(0);
  });

  it('每一种都能从世界导出、读回来一模一样（资源包的格式不变）', () => {
    const eng = continents();
    const w = eng.world;
    // 每种放一点进世界
    eng.exec(planPack(w, FANTASY_PACK, { biomes: ['holy_land'], riverTypes: ['blood_river'], lakeTypes: ['blood_pool'] }).command);
    // 第三十轮：与内置的树里一模一样的生态、地名风格不导出（它们在资源库里），这里放改过的
    eng.exec({ op: 'update_species', id: 'holy_land', patch: { color: '#123456' } });
    eng.exec({ op: 'set_island_type', type: { id: 'black_sand', name: '黑沙岛', shape: 'round', height: 'flat' } });
    eng.exec({ op: 'set_content', kind: 'nameStyle', id: 'my-germanic', item: { ...BUILTIN_STYLES[1], id: 'my-germanic', name: '我的日耳曼' } as unknown as Record<string, unknown> });
    const out = packFromWorld(w, {}, { name: '全部' });
    expect(Object.keys(out)).toEqual(['format', 'version', 'id', 'name', 'fields', 'biomes', 'riverTypes', 'lakeTypes', 'islandTypes', 'nameStyles']);
    const back = readPack(JSON.stringify(out));
    expect(back.ok && back.pack).toEqual(out);
    expect(packSummary(out)).toBe('生态 1 · 河流 1 · 湖泊 1 · 岛 1 · 地名风格 1');
    expect(packCounts(out)).toMatchObject({ biomes: 1, riverTypes: 1, lakeTypes: 1, islandTypes: 1, planetForms: 0, nameStyles: 1, fields: 1 });
    // 用到另一个世界：每一种都加上；再用一次全部跳过
    const other = continents();
    const plan = planPack(other.world, out, { biomes: ['holy_land'], riverTypes: ['blood_river'], lakeTypes: ['blood_pool'], islandTypes: ['black_sand'], nameStyles: ['my-germanic'] });
    expect(plan.command.commands.map((c) => c.op)).toEqual(['add_field', 'set_river_type', 'set_lake_type', 'set_island_type', 'add_species', 'set_content']);
    other.exec(plan.command);
    const again = planPack(other.world, out, { biomes: ['holy_land'], riverTypes: ['blood_river'], lakeTypes: ['blood_pool'], islandTypes: ['black_sand'], nameStyles: ['my-germanic'] });
    expect(again.command.commands).toEqual([]);
    expect(again.skipped.map((s) => s.section)).toEqual(['biomes', 'riverTypes', 'lakeTypes', 'islandTypes', 'nameStyles']);
    // 内置的示例包也读得回来
    for (const p of [FANTASY_PACK, NAME_STYLES_SAMPLE]) {
      const r = readPack(JSON.stringify(p));
      expect(r.ok && r.pack, p.id).toEqual(p);
      expect(packProblems(p), p.id).toEqual([]);
    }
  });

  it('新登记一种（放在 small.content）：资源包的段、数、列表的一行、检查、用到世界、启用停用都跟着有', () => {
    registerKind<{ id: string; name: string; size: number }>({
      id: 'testThing',
      label: '测试物',
      short: '物',
      order: 50,
      store: 'content',
      schema: z.object({ id: z.string(), name: z.string(), size: z.number().min(1) }),
      inWorld: (w) => Object.values(contentItems<{ id: string; name: string; size: number }>(w.small, 'testThing')),
      dirty: () => 'none',
      fields: [{ key: 'size', label: '大小', type: 'number', min: 1 }],
      pack: { key: 'things', max: 2, listed: true, checked: true },
    });
    const p = pack({ things: [{ id: 'a', name: '甲', size: 2 }] });
    const read = readPack(JSON.stringify(p));
    expect(read.ok && read.pack.things).toEqual([{ id: 'a', name: '甲', size: 2 }]);
    expect(packSummary(p)).toBe('物 1');
    const bad = readPack(JSON.stringify(pack({ things: [{ id: 'a', name: '甲', size: 0 }] })));
    expect(!bad.ok && bad.errors[0]).toMatch(/^测试物第 1 个“甲”的 size：/);
    const many = readPack(JSON.stringify(pack({ things: [1, 2, 3] })));
    expect(!many.ok && many.errors).toEqual(['测试物：太多，最多 2 个']);
    expect(packProblems(pack({ things: [{ id: 'a', name: '甲', size: 2 }, { id: 'a', name: '乙', size: 3 }] }))).toEqual(['有两个测试物的 id 都是 a']);
    // 用到世界：通用的 set_content；撤销回到没有 content
    const eng = continents();
    const plan = planPack(eng.world, p, { things: ['a'] });
    expect(plan.command.commands).toEqual([{ op: 'set_content', kind: 'testThing', id: 'a', item: { id: 'a', name: '甲', size: 2 }, from: ['p'] }]);
    eng.exec(plan.command);
    const kind = kindOf('testThing')!;
    expect(isEnabled(kind, eng.world, 'a')).toBe(true);
    eng.exec(disableCommand(kind, 'a', eng.world));
    expect(eng.world.small.content?.testThing).toBeUndefined();
    eng.exec(enableCommand(kind, { id: 'a', name: '甲', size: 3 }, eng.world));
    expect(contentItems(eng.world.small, 'testThing')).toEqual({ a: { id: 'a', name: '甲', size: 3 } });
    eng.undo();
    expect(eng.world.small.content?.testThing).toBeUndefined();
    unregisterKind('testThing');
    expect(parsePack(p).ok).toBe(false);
  });

  it('不能用到世界的一段（星球形态）只列出来，说明从登记表来', () => {
    expect(packSection('planetForms')!.pack.note).toBe('在“调整 → 星球形态”里换，或新建时选');
    expect(packSection('planetForms')!.enable).toBeUndefined();
  });
});
