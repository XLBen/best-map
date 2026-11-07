import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { digest, worldDigest } from '../digest';
import { Engine } from '../engine';
import { packItems } from '../packs';
import { addDimensionCommand } from '../packs/add-dimension';
import { builtinPacks, worldPartsOf } from '../packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../packs/import';
import { NO_CURRENTS, engineFor, humanDigest } from '../testing/fixtures';
import { mapDiff } from '../tidy';
import type { World } from '../world';
import { cleanableContent, cleanableSet, isCleanable } from './cleanable';
import { danglingLinks, linkTable, worldScope } from './links';
import { itemId, kindOf } from './registry';
import { unusedContent } from './unused';

// 第六十二轮：变淡的就是清理会清的（cleanableContent）。门槛：几种世界清理后所有推导数组、人文摘要逐值相同，撤销回到原样，重放一致

const LIB = builtinPacks();
const ROOTS = LIB.map((p) => ({ key: p.id, pack: p }));
const defaults = (lib: string) =>
  packItems<{ id: string; weight?: number }>(LIB.find((p) => p.id === lib)!, 'cultureGroups')
    .filter((g) => g.weight !== 0)
    .map((g) => g.id);

let bare: Engine;
beforeAll(() => {
  bare = engineFor({ cells: 6000, seed: 2 }, { bare: true });
  bare.exec(NO_CURRENTS);
  bare.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  bare.exec({ op: 'generate_provinces', rules: { seed: 5 } });
});

function worldOf(lib: string, groups = defaults(lib), opts: { countries?: boolean; settlements?: boolean } = { countries: true, settlements: true }): Engine {
  const e = bare.clone();
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf(lib))) e.exec(c);
  // 整个库的组都带进世界（和“全部添加”一样），生成时只选几个：世界里留着很多没用到的
  for (const c of packImportCommands(ROOTS, { packs: [[lib]], groups: packItems<{ id: string }>(LIB.find((p) => p.id === lib)!, 'cultureGroups').map((g) => g.id) }, e.world)) e.exec(c);
  e.exec({ op: 'generate_human', packs: [[lib]], groups, ...(opts.countries ? { countries: {} } : {}), ...(opts.settlements ? { settlements: {} } : {}) });
  e.update();
  return e;
}

// 所有推导数组
function derivedDigests(w: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(w.derived)) {
    if (v && (ArrayBuffer.isView(v) || Array.isArray(v))) out[k] = digest(v);
  }
  return out;
}

const WORLDS: [string, () => Engine][] = [
  ['现实库（中世纪，少选几组）', () => worldOf('medieval', defaults('medieval').slice(0, 3))],
  ['奇幻库', () => worldOf('fantasy')],
  ['科幻库，只有人文', () => worldOf('scifi', defaults('scifi').slice(0, 3), { countries: false })],
  [
    '奇幻库加了变量',
    () => {
      const e = worldOf('fantasy');
      e.exec(addDimensionCommand(ROOTS, e.world, 'ideology', 'modern')!);
      e.update();
      return e;
    },
  ],
];

describe('范围', () => {
  it('没有生成人文：什么都不算；没有国家：政体、派系不算', () => {
    const e = bare.clone();
    for (const c of newWorldContentCommands(ROOTS, worldPartsOf('medieval'))) e.exec(c);
    for (const c of packImportCommands(ROOTS, { packs: [['medieval']], groups: ['germanic'] }, e.world)) e.exec(c);
    e.update();
    expect(cleanableContent(e.world)).toEqual([]);
    e.exec({ op: 'generate_human', packs: [['medieval']], groups: ['germanic'] });
    e.update();
    const kinds = new Set(cleanableContent(e.world).map((r) => r.kind));
    expect(kinds.has('government')).toBe(false);
    expect(kinds.has('faction')).toBe(false);
  });

  it('生态、河、湖、画风不算（一格都没有的水系也留着）', () => {
    const e = worldOf('medieval');
    const all = unusedContent(e.world);
    // 这个世界确实有一格都没有的水系
    expect(all.some((r) => r.kind === 'riverType' || r.kind === 'lakeType')).toBe(true);
    const kinds = new Set(cleanableContent(e.world).map((r) => r.kind));
    for (const k of ['biome', 'riverType', 'lakeType', 'mapStyle', 'field']) expect(kinds.has(k), k).toBe(false);
  });

  it.each(WORLDS)('%s：和没压人口的 unusedContent 逐项相同（同样的先后）', (_, make) => {
    const e = make();
    const skip = new Set(['biome', 'riverType', 'lakeType', 'mapStyle', 'field', ...(e.world.small.human?.countryRules ? [] : ['government', 'faction'])]);
    const expected = unusedContent(e.world).filter((r) => !skip.has(r.kind));
    expect(cleanableContent(e.world)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('改了人口之后跟着变：涂一个没人的文化，这个文化不再算', () => {
    const e = worldOf('medieval', defaults('medieval').slice(0, 2));
    const gone = cleanableContent(e.world).find((r) => r.kind === 'culture')!;
    const land = [...e.world.derived.elevation.keys()].filter((i) => e.world.causes.popTotal![i] > 0).slice(0, 5);
    e.exec({ op: 'paint_culture', cells: land, culture: gone.id, amount: 1 } as Command);
    e.update();
    expect(isCleanable(cleanableSet(e.world), 'culture', gone.id)).toBe(false);
    // 文化组也跟着不算
    const c = (e.world.small.content!.culture as Record<string, { group: string }>)[gone.id];
    expect(isCleanable(cleanableSet(e.world), 'cultureGroup', c.group)).toBe(false);
  });
});

describe('清理前后地图不变', () => {
  it.each(WORLDS)('%s：所有推导数组、人文摘要逐值相同，撤销回到原样，重放一致', (_, make) => {
    const e = make();
    const before = { human: humanDigest(e.world), derived: derivedDigests(e.world), content: JSON.stringify(e.world.small.content), all: worldDigest(e.world) };
    const list = cleanableContent(e.world);
    const plan = e.planTidy({ only: list });
    // 变淡的都清得掉：没有“留着”的
    expect(plan.kept).toEqual([]);
    expect(plan.command!.items!.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(list.map((r) => `${r.kind}:${r.id}`).sort());
    e.exec(plan.command!);
    e.update();
    expect(humanDigest(e.world)).toEqual(before.human);
    const after = derivedDigests(e.world);
    for (const k of Object.keys(before.derived)) {
      // 编号跟着内容换的几个数组由 mapDiff 按 id 比
      if (k === 'popCulture' || k === 'popCultureGroup' || k === 'popValue') continue;
      expect(after[k], k).toBe(before.derived[k]);
    }
    const base = make();
    expect(mapDiff(base.world, e.world)).toEqual([]);
    // 清完没有没用到的；没有找不到的 hard 引用（清之前就有的不算）
    expect(cleanableContent(e.world)).toEqual([]);
    const danglingHard = (w: World) => danglingLinks(linkTable(worldScope(w))).filter((d) => d.link.cls === 'hard').map((d) => `${d.from.kind}:${d.from.id}:${d.link.id}`);
    const was = new Set(danglingHard(base.world));
    expect(danglingHard(e.world).filter((x) => !was.has(x))).toEqual([]);
    // 重放一致
    const again = Engine.fromDoc(e.toDoc(), e.world.mesh);
    expect(worldDigest(again.world)).toBe(worldDigest(e.world));
    // 撤销回到原样
    e.undo();
    e.update();
    expect(JSON.stringify(e.world.small.content)).toBe(before.content);
    expect(worldDigest(e.world)).toBe(before.all);
  });

  it('清理之后改一笔、重新生成照常', () => {
    const e = worldOf('medieval', defaults('medieval').slice(0, 3));
    e.exec(e.planTidy({ only: cleanableContent(e.world) }).command!);
    e.exec({ op: 'regenerate_human' });
    e.exec({ op: 'regenerate_countries' });
    e.update();
    expect(Object.keys(e.world.small.countries ?? {}).length).toBeGreaterThan(0);
    const k = kindOf('culture')!;
    expect(k.inWorld(e.world).map((x) => itemId(k, x)).length).toBeGreaterThan(0);
  });
});

describe('明确删除（第六十二轮：内容留在世界里）', () => {
  it('删除国家：导入的、改过的政体留着，再生成国家照样用', () => {
    const e = worldOf('medieval', defaults('medieval').slice(0, 3));
    const k = kindOf('government')!;
    const g = k.inWorld(e.world)[0] as Record<string, unknown>;
    e.exec({ op: 'set_content', kind: 'government', id: String(g.id), item: { ...g, name: '改过的政体' } });
    e.exec({ op: 'remove_countries' });
    expect(e.lastRemoved).toEqual([]);
    expect(cleanableContent(e.world).some((r) => r.kind === 'government')).toBe(false);
    expect((k.inWorld(e.world).find((x) => (x as { id: string }).id === g.id) as { name: string }).name).toBe('改过的政体');
    e.exec({ op: 'generate_countries' });
    e.update();
    expect(Object.keys(e.world.small.countries ?? {}).length).toBeGreaterThan(0);
    expect((k.inWorld(e.world).find((x) => (x as { id: string }).id === g.id) as { name: string }).name).toBe('改过的政体');
  });

  it('删除人文之后再生成：人口、国家和第一次逐值相同（内容一样）', () => {
    const groups = defaults('medieval').slice(0, 3);
    const e = worldOf('medieval', groups);
    const { cities: _c, roads: _r, landmarks: _l, ...first } = humanDigest(e.world);
    e.exec({ op: 'remove_human' });
    e.update();
    expect(e.world.small.human).toBeUndefined();
    expect(cleanableContent(e.world)).toEqual([]);
    e.exec({ op: 'generate_human', packs: [['medieval']], groups, countries: {}, settlements: {} });
    e.update();
    expect(humanDigest(e.world)).toMatchObject(first);
  });
});

describe('快', () => {
  it('压过的人口只有几条：文化多的世界一样', () => {
    const e = worldOf('medieval');
    const t0 = performance.now();
    cleanableContent(e.world);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
