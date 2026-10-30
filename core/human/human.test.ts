import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../../tools/hash';
import { CommandError } from '../commands';
import { Engine, passStats } from '../engine';
import { TERRAIN_COLORS, exportPackage } from '../export';
import { BUILTIN_STYLES } from '../packs/names';
import { continents, engineFor } from '../testing/fixtures';
import { HUMAN_DERIVED, type World } from '../world';
import { CATEGORY_LABEL, PEAK_MIN, RESOURCE_NONE, biomeMovement, cellArchive, cellMovement, cellName, cellParadoxTerrain, paradoxTerrain, classAt, classCode, peakCells, peakMarks, resourceAt, resourceCode, worldResources, worldTerrainClasses } from './index';
import { BUILTIN_CLASSES, FANTASY_RESOURCES, GENERAL_RESOURCES } from '../packs/base';

// 第二十一轮：地形类别、资源、山峰、格的档案

// 人文的几层（推导）与画过的（原因）的摘要：金标准的 digestWorld 不含它们，这里单独比
function humanDigest(w: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HUMAN_DERIVED) out[k] = digest(w.derived[k]);
  if (w.causes.terrainClass) out.causesClass = digest(w.causes.terrainClass);
  if (w.causes.resource) out.causesResource = digest(w.causes.resource);
  out.cells = JSON.stringify(w.small.cells ?? null);
  return out;
}

const autoDigest = (w: World) => ({ classes: digest(w.derived.terrainClassAuto), resources: digest(w.derived.resourceAuto), peaks: digest(w.derived.peak) });
// 第三十二轮重录：地形有了大格局（高程、湖、河、生态往后都变了），人文跟着变
const RECORDED = {
  region: { classes: '032e78a98d864be4', resources: '54672009644f1e24', peaks: 'c0d15985a2043082' },
  planet: { classes: 'd37e59b2a097d840', resources: 'e679cff81a910fa2', peaks: '335569a00999870e' },
};

const planet = () => {
  const eng = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
  return eng;
};
const dryCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] !== 1);
const codeOf = (w: World, id: string) => classCode(w.small, id);

describe('地形类别：自动规则', () => {
  it('每块干的陆地都有类别，水面没有；类别只管起伏：高山是山地、山峰，低平的荒漠、冰盖也是平原', () => {
    const w = continents().world;
    const d = w.derived;
    const dry = new Set(dryCells(w));
    for (let i = 0; i < w.mesh.n; i++) {
      if (dry.has(i)) expect(d.terrainClass[i], `格 ${i}`).toBeGreaterThan(0);
      else expect(d.terrainClass[i]).toBe(0);
    }
    const id = (i: number) => classAt(w.small, d.terrainClass[i])!.id;
    const high = [...dry].filter((i) => d.elevation[i] >= 2200);
    expect(high.length).toBeGreaterThan(20);
    for (const i of high) expect(['mountains', 'peaks']).toContain(id(i));
    const sp = (i: number) => w.small.species[d.dominant[i]]?.id;
    // 第二十七轮：植被不再是类别——低平的荒漠、森林、冰盖都是平原
    for (const b of ['desert', 'taiga']) {
      const flat = [...dry].filter((i) => sp(i) === b && d.elevation[i] < 600 && d.slope[i] < 2);
      expect(flat.length, b).toBeGreaterThan(5);
      for (const i of flat) expect(id(i)).toBe('plains');
    }
    // 5 种都出现
    const seen = new Set([...dry].map(id));
    for (const c of ['plains', 'hills', 'highlands', 'mountains', 'peaks']) expect(seen, c).toContain(c);
  });

  it('内置的只有 5 种起伏；每格的类别与高度、坡度的阈值一致，山峰最高、平原最低', () => {
    expect(BUILTIN_CLASSES.map((c) => c.id)).toEqual(['plains', 'hills', 'highlands', 'mountains', 'peaks']);
    expect(BUILTIN_CLASSES.map((c) => c.name)).toEqual(['平原', '丘陵', '高原', '山地', '山峰']);
    // 规则里只有高度、坡度
    for (const c of BUILTIN_CLASSES) for (const r of c.rules) for (const k of Object.keys(r)) expect(['elevMin', 'elevMax', 'slopeMin', 'slopeMax'], `${c.id}.${k}`).toContain(k);
    for (const eng of [continents(), planet()]) {
      const w = eng.world;
      const d = w.derived;
      const expected = (i: number) => {
        const e = d.elevation[i];
        const s = d.slope[i];
        if ((e >= 3000 && s >= 8) || (e >= 4200 && s >= 3)) return 'peaks';
        if (e >= 1900 || (e >= 1100 && s >= 7)) return 'mountains';
        if (e >= 1100 && s <= 4) return 'highlands';
        if (s >= 4.5 || (e >= 700 && s >= 2.5)) return 'hills';
        return 'plains';
      };
      const sum: Record<string, [number, number]> = {};
      for (const i of dryCells(w)) {
        const c = classAt(w.small, d.terrainClass[i])!.id;
        expect(c, `格 ${i}`).toBe(expected(i));
        const e = (sum[c] ??= [0, 0]);
        e[0] += d.elevation[i];
        e[1]++;
      }
      const mean = (c: string) => sum[c][0] / sum[c][1];
      expect(mean('peaks')).toBeGreaterThan(mean('mountains'));
      expect(mean('mountains')).toBeGreaterThan(mean('highlands'));
      expect(mean('highlands')).toBeGreaterThan(mean('hills'));
      expect(mean('hills')).toBeGreaterThan(mean('plains'));
    }
  });

  it('通行难度 = 起伏 × 植被：平地的草原为 1，林、沼泽、荒漠更难走，丘陵上的森林比平地的森林难走', () => {
    const w = continents().world;
    const d = w.derived;
    const x = { n: w.mesh.n, dry: Uint8Array.from(w.causes.land, (v, i) => (v && d.lake[i] !== 1 ? 1 : 0)), biome: d.dominant };
    const move = cellMovement(w.small, x, d.terrainClass);
    const sp = (i: number) => w.small.species[d.dominant[i]]?.id;
    const at = (cls: string, biome: string) => dryCells(w).find((i) => classAt(w.small, d.terrainClass[i])!.id === cls && sp(i) === biome);
    expect(move[at('plains', 'steppe')!]).toBe(1);
    for (const b of ['taiga', 'desert', 'tundra']) expect(move[at('plains', b)!], b).toBeGreaterThan(1.2);
    const hillForest = at('hills', 'taiga');
    expect(move[hillForest!]).toBeCloseTo(1.5 * biomeMovement(w.small.species.find((s) => s.id === 'taiga')!), 5);
    expect(move[hillForest!]).toBeGreaterThan(move[at('plains', 'taiga')!]);
    // 第三十轮：通行倍数写在生态自己身上（与以前的 BIOME_MOVEMENT 表相同，见 r30-era-packs.test.ts）
    for (const sp of w.small.species) expect(biomeMovement(sp), sp.id).toBe(sp.movement);
    // 生态写了 movement 就用它
    expect(biomeMovement({ ...w.small.species[0], movement: 7 })).toBe(7);
  });

  it('没画过时生效的就是自动的；同一个世界算两遍逐值相同', () => {
    const a = continents().world;
    expect(a.causes.terrainClass).toBeUndefined();
    expect(a.derived.terrainClass).toEqual(a.derived.terrainClassAuto);
    const b = engineFor({ cells: 12000, seed: 1, latNorth: 72, latSouth: 20 });
    b.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    expect(humanDigest(b.world)).toEqual(humanDigest(a));
  });

  it('整个星球上也一样：重放逐值相同', () => {
    const eng = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(humanDigest(again.world)).toEqual(humanDigest(eng.world));
    expect(dryCells(eng.world).every((i) => eng.world.derived.terrainClass[i] > 0)).toBe(true);
    expect(autoDigest(eng.world)).toEqual(RECORDED.planet);
  });

  // 人文的几层的金标准（第二十一轮记下）：以后提速、重构，自动的类别、资源、山峰必须逐值不变；有意改了规则时重录
  // （第二十七轮重录：地形类别只管起伏，资源的规则按生态的地形写，冰盖上的山也算山峰）
  it('金标准：自动的类别、资源、山峰逐值不变', () => {
    expect(autoDigest(continents().world)).toEqual(RECORDED.region);
  });
});

describe('地形类别：画', () => {
  it('只改类别、不改高度，只重算人文的几层；撤销、重放、检查点一致', () => {
    const eng = continents();
    const w = eng.world;
    const before = digestWorld(w);
    const human0 = humanDigest(w);
    const elevation = w.derived.elevation;
    const cells = dryCells(w).slice(0, 40);
    const sea = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i])!;
    const passes = passStats.passes;
    const summary = eng.exec({ op: 'set_cell_class', cells: [...cells, sea], class: 'highlands' });
    expect(summary).toBe('地形类别“高原” · 40 格');
    expect(passStats.passes).toBe(passes);
    // 自然的推导是同一份数组（没有重算），只有人文的几层换了
    expect(w.derived.elevation).toBe(elevation);
    expect(digestWorld(w)).toEqual({ ...before, 'causes.terrainClass': digest(w.causes.terrainClass!) });
    for (const i of cells) expect(w.derived.terrainClass[i]).toBe(codeOf(w, 'highlands'));
    expect(w.causes.terrainClass![sea]).toBe(0);
    expect(w.derived.terrainClassAuto).toEqual(continents().world.derived.terrainClassAuto);
    // 重放、检查点
    const doc = eng.toDoc();
    expect(humanDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(humanDigest(w));
    const cp = structuredClone(eng.toCheckpoint());
    expect(humanDigest(Engine.fromCheckpoint(cp, doc, w.mesh)!.world)).toEqual(humanDigest(w));
    // 恢复自动的一半，再撤销两次：数组去掉，与没画过一样
    eng.exec({ op: 'set_cell_class', cells: cells.slice(0, 20), class: null });
    expect(w.derived.terrainClass[cells[0]]).toBe(w.derived.terrainClassAuto[cells[0]]);
    expect(w.derived.terrainClass[cells[30]]).toBe(codeOf(w, 'highlands'));
    eng.undo();
    eng.undo();
    expect(w.causes.terrainClass).toBeUndefined();
    expect(humanDigest(w)).toEqual(human0);
    expect(digestWorld(w)).toEqual(before);
    eng.redo();
    expect(w.derived.terrainClass[cells[0]]).toBe(codeOf(w, 'highlands'));
  });

  it('在海上、恢复自动没画过的格不算改动；不认识的类别报错', () => {
    const eng = continents();
    const w = eng.world;
    const sea = [...Array(w.mesh.n).keys()].filter((i) => !w.causes.land[i]).slice(0, 5);
    eng.exec({ op: 'set_cell_class', cells: sea, class: 'hills' });
    expect(eng.lastNoop).toBe(true);
    eng.exec({ op: 'set_cell_class', cells: dryCells(w).slice(0, 5), class: null });
    expect(eng.lastNoop).toBe(true);
    expect(() => eng.exec({ op: 'set_cell_class', cells: [1], class: 'volcano' })).toThrow(CommandError);
    // 第二十七轮以前的植被类别（森林、沙漠……）：旧命令照样能重放，画成它们的格恢复自动
    const cells = dryCells(w).slice(0, 5);
    eng.exec({ op: 'set_cell_class', cells, class: 'hills' });
    eng.exec({ op: 'set_cell_class', cells, class: 'forest' });
    for (const i of cells) expect(w.derived.terrainClass[i]).toBe(w.derived.terrainClassAuto[i]);
  });

  it('预览就是执行的结果', () => {
    const eng = continents();
    const cmd = { op: 'set_cell_class' as const, cells: dryCells(eng.world).slice(100, 160), class: 'hills' };
    const p = eng.previewWorld(cmd);
    // 只有人文的几层变了
    expect(Object.keys(p.patch.derived)).toContain('terrainClass');
    for (const k of Object.keys(p.patch.derived)) expect(HUMAN_DERIVED).toContain(k);
    expect(p.result.summary).toBe('地形类别“丘陵” · 60 格');
    eng.exec(cmd);
    const other = continents();
    other.exec(cmd);
    expect(humanDigest(eng.world)).toEqual(humanDigest(other.world));
  });

  it('自己加的类别排在内置的后面；停用一种后画成它的格恢复自动、后面的编号往前挪；改内置的不挪编号', () => {
    const eng = continents();
    const w = eng.world;
    const n = BUILTIN_CLASSES.length;
    const a = { id: 'volcanic', name: '火山地', color: '#552222', priority: 85, rules: [{ elevMin: 99999 }] };
    const b = { id: 'badlands', name: '荒地', color: '#aa7744', priority: 0, rules: [] };
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'volcanic', item: a });
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'badlands', item: b });
    expect(worldTerrainClasses(w.small).map((c) => c.id).slice(n)).toEqual(['volcanic', 'badlands']);
    expect(codeOf(w, 'badlands')).toBe(n + 2);
    const cells = dryCells(w);
    eng.exec({ op: 'set_cell_class', cells: cells.slice(0, 10), class: 'volcanic' });
    eng.exec({ op: 'set_cell_class', cells: cells.slice(10, 20), class: 'badlands' });
    // 没有规则的类别不会自动出现
    expect(w.derived.terrainClassAuto.includes(n + 2)).toBe(false);
    // 停用 volcanic：它的格恢复自动，荒地的格编号挪成 n + 1
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'volcanic', item: null });
    expect(codeOf(w, 'badlands')).toBe(n + 1);
    for (const i of cells.slice(0, 10)) expect(w.causes.terrainClass![i]).toBe(0);
    for (const i of cells.slice(10, 20)) expect(classAt(w.small, w.derived.terrainClass[i])!.id).toBe('badlands');
    // 撤销：编号、画的格都回来
    eng.undo();
    expect(classAt(w.small, w.derived.terrainClass[cells[0]])!.id).toBe('volcanic');
    // 改内置的平原（换颜色）：编号不变
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'plains', item: { ...BUILTIN_CLASSES[0], color: '#ffffff' } });
    expect(worldTerrainClasses(w.small)[0].color).toBe('#ffffff');
    expect(codeOf(w, 'volcanic')).toBe(n + 1);
    // 第三十轮：内置的也是普通内容，停用了就不在世界里（后面的编号往前挪），从资源库能加回来
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'plains', item: null });
    expect(worldTerrainClasses(w.small).some((c) => c.id === 'plains')).toBe(false);
    expect(codeOf(w, 'volcanic')).toBe(n);
    // 规则里不能按地形类别
    expect(() => eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'x', item: { ...b, id: 'x', rules: [{ classes: ['hills'] }] } })).toThrow(/不能按地形类别/);
  });

  it('改规则只重算人文的几层：自动的类别跟着变', () => {
    const eng = continents();
    const w = eng.world;
    const passes = passStats.passes;
    // 丘陵的规则改成永远不满足：原来的丘陵变成别的
    const hills = codeOf(w, 'hills');
    const had = dryCells(w).filter((i) => w.derived.terrainClassAuto[i] === hills);
    expect(had.length).toBeGreaterThan(50);
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'hills', item: { ...BUILTIN_CLASSES.find((c) => c.id === 'hills')!, rules: [] } });
    expect(passStats.passes).toBe(passes);
    expect(w.derived.terrainClassAuto.includes(hills)).toBe(false);
    eng.undo();
    expect(dryCells(w).filter((i) => w.derived.terrainClassAuto[i] === hills)).toEqual(had);
  });
});

describe('资源', () => {
  it('确定：同一个世界同样的结果；稀有的少、常见的多；山地上只有矿或没有', () => {
    const w = continents().world;
    const d = w.derived;
    const dry = dryCells(w);
    const count = new Map<string, number>();
    for (const i of dry) {
      const r = resourceAt(w.small, d.resource[i]);
      count.set(r?.id ?? '', (count.get(r?.id ?? '') ?? 0) + 1);
    }
    // 大约四成的陆地没有资源（不会全有、也不会全没有）
    const none = (count.get('') ?? 0) / dry.length;
    expect(none).toBeGreaterThan(0.2);
    expect(none).toBeLessThan(0.7);
    expect(count.get('iron') ?? 0).toBeGreaterThan(count.get('gold') ?? 0);
    expect(count.get('livestock') ?? 0).toBeGreaterThan(count.get('gems') ?? 0);
    const mountains = dry.filter((i) => ['mountains', 'peaks'].includes(classAt(w.small, d.terrainClass[i])!.id));
    for (const i of mountains) {
      const r = resourceAt(w.small, d.resource[i]);
      if (r) expect(['ore', 'luxury'], r.id).toContain(r.category);
    }
    // 鱼只在挨着水的地方
    const fish = resourceCode(w.small, 'fish');
    const thr = w.small.planet.riverThreshold;
    for (const i of dry.filter((i) => d.resource[i] === fish)) {
      let wet = d.discharge[i] >= thr;
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) {
        const j = w.mesh.adj[e];
        if (!w.causes.land[j] || d.lake[j] === 1) wet = true;
      }
      expect(wet).toBe(true);
    }
    // 奇幻的默认不在（新世界从“通用 ▸ 基础”加进来的是通用的一套）
    expect(worldResources(w.small)).toEqual(GENERAL_RESOURCES);
  });

  it('换一个世界种子分布就换；按地图上的位置，与成片的大小有关', () => {
    const a = continents().world.derived.resourceAuto;
    const eng = engineFor({ cells: 12000, seed: 1, latNorth: 72, latSouth: 20 });
    eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents', landFraction: 0.4 }, reset: true });
    expect(digest(eng.world.derived.resourceAuto)).not.toBe(digest(a));
  });

  it('画资源：明确没有、恢复自动；撤销逐值一致；不认识的报错', () => {
    const eng = continents();
    const w = eng.world;
    const h0 = humanDigest(w);
    const withRes = dryCells(w).filter((i) => w.derived.resource[i]).slice(0, 10);
    expect(eng.exec({ op: 'set_cell_resource', cells: withRes, resource: 'none' })).toBe('去掉资源 · 10 格');
    for (const i of withRes) {
      expect(w.causes.resource![i]).toBe(RESOURCE_NONE);
      expect(w.derived.resource[i]).toBe(0);
    }
    expect(eng.exec({ op: 'set_cell_resource', cells: withRes.slice(0, 4), resource: 'gold' })).toBe('资源“金” · 4 格');
    expect(w.derived.resource[withRes[0]]).toBe(resourceCode(w.small, 'gold'));
    eng.exec({ op: 'set_cell_resource', cells: withRes, resource: null });
    expect(w.derived.resource[withRes[0]]).toBe(w.derived.resourceAuto[withRes[0]]);
    expect(() => eng.exec({ op: 'set_cell_resource', cells: [1], resource: 'unobtainium' })).toThrow(CommandError);
    eng.undo();
    eng.undo();
    eng.undo();
    expect(w.causes.resource).toBeUndefined();
    expect(humanDigest(w)).toEqual(h0);
    eng.redo();
    eng.redo();
    expect(humanDigest(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toEqual(humanDigest(w));
  });

  it('启用奇幻的资源：排在后面，高山上有秘银；停用后画成它的格恢复自动，“明确没有”不动', () => {
    const eng = continents();
    const w = eng.world;
    const mithril = FANTASY_RESOURCES.find((r) => r.id === 'mithril')!;
    eng.exec({ op: 'set_content', kind: 'resource', id: 'mithril', item: { ...mithril, rarity: 0.5 } });
    const code = resourceCode(w.small, 'mithril');
    expect(code).toBe(GENERAL_RESOURCES.length + 1);
    const cells = dryCells(w).filter((i) => w.derived.resource[i] === code);
    expect(cells.length).toBeGreaterThan(0);
    for (const i of cells) expect(w.derived.elevation[i]).toBeGreaterThanOrEqual(2200);
    const some = dryCells(w).slice(0, 6);
    eng.exec({ op: 'set_cell_resource', cells: some.slice(0, 3), resource: 'mithril' });
    eng.exec({ op: 'set_cell_resource', cells: some.slice(3), resource: 'none' });
    eng.exec({ op: 'set_content', kind: 'resource', id: 'mithril', item: null });
    for (const i of some.slice(0, 3)) expect(w.causes.resource![i]).toBe(0);
    for (const i of some.slice(3)) expect(w.causes.resource![i]).toBe(RESOURCE_NONE);
    // 第三十轮：通用的也是普通内容，能停用（画成它的格恢复自动）
    eng.exec({ op: 'set_content', kind: 'resource', id: 'iron', item: null });
    expect(resourceCode(w.small, 'iron')).toBe(0);
  });
});

describe('山峰', () => {
  it('山峰比四周都高、不低于门槛、在山地或山峰类别里；山脉的主峰在里面，档案用地物的名字', () => {
    const w = continents().world;
    const d = w.derived;
    const peaks = peakCells(w);
    expect(peaks.length).toBeGreaterThan(5);
    for (let k = 1; k < peaks.length; k++) expect(d.elevation[peaks[k]]).toBeLessThanOrEqual(d.elevation[peaks[k - 1]]);
    for (const i of peaks) {
      expect(d.elevation[i]).toBeGreaterThanOrEqual(PEAK_MIN);
      expect(classAt(w.small, d.terrainClass[i])!.peaks).toBe(true);
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) expect(d.elevation[w.mesh.adj[e]]).toBeLessThanOrEqual(d.elevation[i]);
    }
    const named = d.features.filter((f) => f.type === 'peak');
    expect(named.length).toBeGreaterThan(0);
    const f = named[0];
    const a = cellArchive(w, f.anchor);
    expect(a.peak).toMatchObject({ name: f.name, feature: f.key, elevation: Math.round(d.elevation[f.anchor]) });
    expect(a.name).toBe(f.name);
    // 别的山峰按这一格用“山峰”的模板起名
    const plain = [...peaks].find((i) => !named.some((x) => x.anchor === i))!;
    const b = cellArchive(w, plain);
    expect(b.peak?.name).toBe(b.name);
    expect(b.feature).toBeUndefined();
    expect(b.name).toMatch(/[峰山岳顶]/);
    // 地图上画的山峰：全部，按海拔
    const marks = peakMarks(w);
    expect(marks.length).toBeGreaterThanOrEqual(peaks.length);
    expect(marks.find((m) => m.cell === f.anchor)?.name).toBe(f.name);
  });

  it('改主峰的名字（rename_feature）档案跟着；格自己起了名字时用格的', () => {
    const eng = continents();
    const w = eng.world;
    const f = w.derived.features.find((x) => x.type === 'peak')!;
    eng.exec({ op: 'rename_feature', key: cellArchive(w, f.anchor).feature!, name: '天柱峰' });
    expect(cellArchive(w, f.anchor).peak?.name).toBe('天柱峰');
    eng.exec({ op: 'set_cell', cell: f.anchor, name: '老君顶' });
    expect(cellArchive(w, f.anchor)).toMatchObject({ name: '老君顶', custom: true });
    expect(cellArchive(w, f.anchor).feature).toBeUndefined();
  });
});

describe('格的档案', () => {
  it('小地名：自动起、换一个、自己起（带原文）、恢复自动；备注；空了就去掉', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const cell = dryCells(w).find((i) => !w.derived.peak[i])!;
    const auto = cellName(w, cell);
    expect(auto.custom).toBe(false);
    expect(auto.zh.length).toBeGreaterThan(0);
    expect(cellName(w, cell)).toEqual(auto);
    expect(eng.exec({ op: 'set_cell', cell, reroll: true })).toBe('换名字');
    expect(cellName(w, cell).zh).not.toBe(auto.zh);
    eng.exec({ op: 'set_cell', cell, name: '石桥', orig: 'Shiqiao' });
    expect(cellArchive(w, cell)).toMatchObject({ name: '石桥', orig: 'Shiqiao', custom: true });
    eng.exec({ op: 'set_cell', cell, name: '石桥镇' });
    expect(cellArchive(w, cell).orig).toBeUndefined();
    expect(eng.exec({ op: 'set_cell', cell, note: '  古战场  ' })).toBe('写备注');
    expect(cellArchive(w, cell).note).toBe('古战场');
    eng.exec({ op: 'set_cell', cell, name: null, note: null, salt: 0 });
    expect(w.small.cells).toBeUndefined();
    expect(cellName(w, cell)).toEqual(auto);
    // 撤销到起名之前
    for (let k = 0; k < 4; k++) eng.undo();
    expect(w.small.cells?.[cell]?.salt).toBe(1);
  });

  it('按所在省份的风格起名（有原文）；档案里的类别、资源、经纬度', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const cell = dryCells(w).find((i) => w.causes.province[i] >= 0 && !w.derived.peak[i])!;
    const style = BUILTIN_STYLES.find((s) => s.id === 'west-germanic')!;
    eng.exec({ op: 'set_content', kind: 'nameStyle', id: style.id, item: style as unknown as Record<string, unknown> });
    eng.exec({ op: 'set_province', id: w.causes.province[cell], style: style.id });
    const a = cellArchive(w, cell);
    expect(a.style).toBe('west-germanic');
    expect(a.orig).toMatch(/^[A-Z]/);
    expect(a.surface).toBe('land');
    expect(a.terrainClass?.id).toBe(classAt(w.small, w.derived.terrainClass[cell])!.id);
    expect(a.terrainClass?.auto).toBe(true);
    expect(a.provinceName).toBe(w.small.provinces[w.causes.province[cell]].name);
    if (a.resource) expect(a.resource.categoryLabel).toBe(CATEGORY_LABEL[a.resource.category]);
    else expect(['无矿', '无']).toContain(a.resourceNone);
    const sea = cellArchive(w, [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i])!);
    expect(sea.surface).toBe('sea');
    expect(sea.terrainClass).toBeUndefined();
    expect(sea.resourceNone).toBeUndefined();
  });

  it('山地上没有资源时写“无矿”', () => {
    const eng = continents();
    const w = eng.world;
    const cell = dryCells(w).find((i) => classAt(w.small, w.derived.terrainClass[i])!.id === 'mountains')!;
    eng.exec({ op: 'set_cell_resource', cells: [cell], resource: 'none' });
    expect(cellArchive(w, cell)).toMatchObject({ resourceNone: '无矿', resourceAuto: false });
  });
});

describe('导出与没用到的世界', () => {
  it('导出地形类别、资源的图与表；省份表最后两列', () => {
    const eng = continents({ provinces: true });
    const pkg = exportPackage(eng.world, eng.toDoc(), { width: 200, height: 100, seaLevelGray: 95, maxElevation: 6000 });
    const files = unzipSync(pkg.zip);
    for (const f of ['terrain_class.bmp', 'resources.bmp']) expect(files[f].length).toBe(54 + 200 * 3 * 100);
    const classes = strFromU8(files['terrain_classes.csv']).trim().split('\n');
    expect(classes[0]).toBe('code,id,name,red,green,blue,terrain,cells');
    expect(classes[1]).toMatch(/^1,plains,平原,\d+,\d+,\d+,plains,\d+$/);
    expect(classes.length).toBe(BUILTIN_CLASSES.length + 1);
    const res = strFromU8(files['resources.csv']).trim().split('\n');
    expect(res[1]).toMatch(/^1,grain,粮食,农,/);
    const summary = strFromU8(files['provinces_summary.csv']).trim().split('\n');
    expect(summary[0]).toMatch(/,terrain_class,resource$/);
    expect(summary.slice(1).some((l) => /,(plains|hills|highlands|mountains|peaks),[a-z-]*$/.test(l))).toBe(true);
  });

  it('导出的地形三处一致：terrain.bmp 逐像素、terrain_classes.csv 的 terrain、省份汇总的 terrain 都按 paradoxTerrain', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const W = 300;
    const H = 150;
    const files = unzipSync(exportPackage(w, eng.toDoc(), { width: W, height: H, seaLevelGray: 95, maxElevation: 6000 }).zip);
    const px = (bmp: Uint8Array, p: number) => {
      const row = Math.ceil((W * 3) / 4) * 4;
      const y = Math.floor(p / W);
      const o = 54 + (H - 1 - y) * row + (p % W) * 3;
      return `${bmp[o + 2]},${bmp[o + 1]},${bmp[o]}`;
    };
    const rgb = (t: string) => TERRAIN_COLORS[t].join(',');
    // 表：起伏的几类写自己的地形，平原写 plains
    const rows = strFromU8(files['terrain_classes.csv']).trim().split('\n').slice(1).map((l) => l.split(','));
    const byColor = new Map(rows.map((r) => [`${r[3]},${r[4]},${r[5]}`, r]));
    expect(rows.map((r) => r[6])).toEqual(['plains', 'hills', 'highlands', 'mountains', 'mountains']);
    // 逐像素：terrain_class.bmp 里是丘陵、高原、山地、山峰的像素，terrain.bmp 是表里那种地形的颜色；平原的像素是某种生态地形的颜色
    const biomeColors = new Set([...new Set(w.small.species.map((sp) => sp.terrain)), 'plains'].map(rgb));
    const terrainBmp = files['terrain.bmp'];
    const classBmp = files['terrain_class.bmp'];
    const water = new Set([rgb('ocean'), rgb('lake')]);
    let relief = 0;
    let flat = 0;
    for (let p = 0; p < W * H; p++) {
      const c = px(classBmp, p);
      if (water.has(c)) {
        expect(px(terrainBmp, p)).toBe(c);
        continue;
      }
      const row = byColor.get(c)!;
      expect(row, `像素 ${p}`).toBeDefined();
      if (row[6] !== 'plains') {
        expect(px(terrainBmp, p), `像素 ${p}`).toBe(rgb(row[6]));
        relief++;
      } else {
        expect(biomeColors.has(px(terrainBmp, p)), `像素 ${p}`).toBe(true);
        flat++;
      }
    }
    expect(relief).toBeGreaterThan(500);
    expect(flat).toBeGreaterThan(500);
    // 省份汇总：每个陆地省的 terrain 是省里各格导出地形的多数
    const cellT = cellParadoxTerrain(w);
    const count = new Map<number, Map<string, number>>();
    for (let i = 0; i < w.mesh.n; i++) {
      const p = w.causes.province[i];
      if (p < 0 || cellT[i] === 'ocean' || cellT[i] === 'lake') continue;
      const m = count.get(p) ?? new Map<string, number>();
      count.set(p, m);
      m.set(cellT[i], (m.get(cellT[i]) ?? 0) + 1);
    }
    const summary = strFromU8(files['provinces_summary.csv']).trim().split('\n').slice(1).map((l) => l.split(','));
    let checked = 0;
    for (const r of summary) {
      if (r[2] !== '1' || r[3] !== 'land') continue;
      const m = [...count.get(Number(r[0]))!].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      expect(r[4], `省份 ${r[0]}`).toBe(m[0][0]);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    // 起伏以外按生态：同一格的生态改了地形，导出的地形跟着变（丘陵以上不变）
    expect(paradoxTerrain({ terrain: 'hills' }, 'desert', 0, 0)).toBe('hills');
    expect(paradoxTerrain({ terrain: 'plains' }, 'desert', 0, 0)).toBe('desert');
    expect(paradoxTerrain(undefined, 'forest', 2500, 1)).toBe('mountains');
    expect(paradoxTerrain(undefined, 'forest', 100, 1)).toBe('forest');
  });

  it('没用到这些的世界：原因、小数据里没有新的项（小数据里只有新建时从资源包加的内容）', () => {
    const w = continents({ provinces: true }).world;
    expect(w.causes.terrainClass).toBeUndefined();
    expect(w.causes.resource).toBeUndefined();
    expect(w.small.cells).toBeUndefined();
    expect(Object.keys(w.small.content!).sort()).toEqual(['cityRank', 'landmarkType', 'nameStyle', 'pointType', 'resource', 'terrainClass']);
  });

  it('新建世界清掉画的类别、资源、格的档案', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_cell_class', cells: dryCells(w).slice(0, 5), class: 'hills' });
    eng.exec({ op: 'set_cell', cell: 3, note: '记一笔' });
    eng.exec({ op: 'set_worldgen', params: { seed: 9, type: 'continents' }, reset: true });
    expect(w.causes.terrainClass!.every((v) => v === 0)).toBe(true);
    expect(w.small.cells).toBeUndefined();
  });
});
