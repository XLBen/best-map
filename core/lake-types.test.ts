import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { Engine, passStats } from './engine';
import { FANTASY_PACK } from './packs/fantasy';
import { type LakeType, PLAIN_LAKE, lakeBank, lakeParts, matchRunStats } from './lake-types';
import { graphDistance } from './mesh';
import { applyPackCommands, packFromWorld, readPack } from './packs';
import { arrayInputs, runScript } from './script';
import { continents } from './testing/fixtures';
import type { World } from './world';

// 湖泊类型（第九轮）：每个湖一种（放的湖、自然的湖选的，每个湖一次的 match）、湖岸场、颜色只重画、起名、资源包、重放

const blood: LakeType = { id: 'blood_pool', name: '血池', color: '#9b1b1b' };
const typeOf = (w: World, i: number) => w.derived.lakeType?.[i] ?? 0;

// 内陆几处平地（彼此隔开），放湖用
function inland(w: World, count: number): number[] {
  const d = w.derived;
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n && out.length < count; i++) {
    if (!w.causes.land[i] || d.lake[i] || d.continentality[i] < 0.55 || d.slope[i] > 6) continue;
    if (out.some((c) => Math.hypot(w.mesh.x[c] - w.mesh.x[i], w.mesh.y[c] - w.mesh.y[i]) < 0.12)) continue;
    out.push(i);
  }
  expect(out.length).toBe(count);
  return out;
}

// 放几个湖：大小不同（面积不同，规则能分开）
function withLakes(): { eng: Engine; cells: number[] } {
  const eng = continents();
  const cells = inland(eng.world, 4);
  cells.forEach((cell, k) => eng.exec({ op: 'add_lake', lake: { id: `L${k}`, cell, radius: 60 + 60 * k, depth: 150, perennial: true } }));
  return { eng, cells };
}

describe('湖泊类型：每个湖是哪一种', () => {
  it('没有湖泊类型的世界里没有 lakeType 这个键；新建再删掉后为 undefined', () => {
    const { eng } = withLakes();
    expect('lakeType' in eng.world.derived).toBe(false);
    expect(eng.world.small.lakeTypes).toBeUndefined();
    eng.exec({ op: 'set_lake_type', type: blood });
    expect(eng.world.derived.lakeType).toBeInstanceOf(Uint8Array);
    expect(eng.world.derived.lakeType!.every((v) => v === 0)).toBe(true);
    eng.exec({ op: 'remove_lake_type', id: blood.id });
    expect(eng.world.derived.lakeType).toBeUndefined();
  });

  it('match 每个湖只算一次（变量是整个湖的汇总），一个湖整片是同一种', () => {
    const { eng } = withLakes();
    const w = eng.world;
    const parts = lakeParts(w, w.derived);
    expect(parts.lakes.length).toBeGreaterThanOrEqual(4);
    const runs = matchRunStats.lakes;
    const passes = passStats.passes;
    // 面积在放的四个湖中间：有的是，有的不是
    const areas = parts.lakes.map((cells) => cells.reduce((a, c) => a + w.mesh.area[c], 0) * w.kmPerUnit * w.kmPerUnit).sort((a, b) => a - b);
    const cut = areas[Math.floor(areas.length / 2)];
    eng.exec({ op: 'set_lake_type', type: { ...blood, scripts: { match: { api: 1, src: `return 湖面积 > ${cut} && 放的湖 === 1;` } } } });
    expect(passStats.passes - passes).toBe(1);
    const after = lakeParts(w, w.derived);
    expect(matchRunStats.lakes - runs).toBe(after.lakes.length);
    let typed = 0;
    for (const cells of after.lakes) {
      const t = typeOf(w, cells[0]);
      for (const c of cells) expect(typeOf(w, c)).toBe(t);
      if (t) typed++;
    }
    expect(typed).toBeGreaterThan(0);
    expect(typed).toBeLessThan(after.lakes.length);
    // 不是湖的格一格都不带类型
    for (let i = 0; i < w.mesh.n; i++) if (!w.derived.lake[i]) expect(typeOf(w, i)).toBe(0);
    expect(w.derived.scriptIssues).toBeUndefined();
  });

  it('放的湖选的、自然的湖选的说了算；“普通的湖”不按规则变；规则出错按不匹配，说明记下', () => {
    const { eng, cells } = withLakes();
    const w = eng.world;
    eng.exec({ op: 'set_lake_type', type: { ...blood, scripts: { match: { api: 1, src: 'return true;' } } } });
    eng.exec({ op: 'set_lake_type', type: { id: 'ice', name: '冰湖', color: '#ccefff' } });
    expect(cells.every((c) => typeOf(w, c) === 1)).toBe(true);
    eng.exec({ op: 'update_lake', id: 'L0', patch: { type: PLAIN_LAKE } });
    eng.exec({ op: 'update_lake', id: 'L1', patch: { type: 'ice' } });
    // 自然的湖（这里用放的第三个湖所在的那片当作“这一格所在的湖”）
    eng.exec({ op: 'type_lake', cell: cells[2], type: 'ice' });
    expect(typeOf(w, cells[0])).toBe(0);
    expect(typeOf(w, cells[1])).toBe(2);
    expect(typeOf(w, cells[2])).toBe(2);
    expect(typeOf(w, cells[3])).toBe(1);
    // 改回按规则：去掉那一格的选择
    eng.exec({ op: 'type_lake', cell: cells[2], type: null });
    expect(w.small.lakeTyping).toBeUndefined();
    expect(typeOf(w, cells[2])).toBe(1);
    eng.exec({ op: 'set_lake_type', type: { ...blood, scripts: { match: { api: 1, src: 'const o = undefined;\nreturn o.x;' } } } });
    expect(typeOf(w, cells[3])).toBe(0);
    expect(w.derived.scriptIssues?.[0]).toMatchObject({ kind: 'match', id: blood.id, line: 2 });
  });

  it('删掉一种湖：放的湖、自然的湖上选的都去掉（撤销时一起回来）', () => {
    const { eng, cells } = withLakes();
    const w = eng.world;
    eng.exec({ op: 'set_lake_type', type: blood });
    eng.exec({ op: 'update_lake', id: 'L0', patch: { type: blood.id } });
    eng.exec({ op: 'type_lake', cell: cells[1], type: blood.id });
    eng.exec({ op: 'remove_lake_type', id: blood.id });
    expect(w.small.lakes[0].type).toBeUndefined();
    expect(w.small.lakeTyping).toBeUndefined();
    eng.undo();
    expect(w.small.lakes[0].type).toBe(blood.id);
    expect(w.small.lakeTyping).toEqual([{ cell: cells[1], type: blood.id }]);
    expect(typeOf(w, cells[0])).toBe(1);
    expect(typeOf(w, cells[1])).toBe(1);
  });

  it('只改颜色、画法：什么都不重算；改大小：湖重挖', () => {
    const { eng, cells } = withLakes();
    const w = eng.world;
    eng.exec({ op: 'set_lake_type', type: blood });
    eng.exec({ op: 'update_lake', id: 'L0', patch: { type: blood.id } });
    const passes = passStats.passes;
    eng.takeRecomputed();
    eng.exec({ op: 'set_lake_type', type: { ...blood, color: '#000000', style: 'glow', atlasColor: '#111111' } });
    expect(eng.takeRecomputed()).toBe(0);
    expect(passStats.passes).toBe(passes);
    const before = Array.from(w.derived.lake).filter((v, i) => v === 1 && lakeParts(w, w.derived).of[i] === lakeParts(w, w.derived).of[cells[0]]).length;
    eng.exec({ op: 'update_lake', id: 'L0', patch: { radius: 200 } });
    const parts = lakeParts(w, w.derived);
    const now = parts.lakes[parts.of[cells[0]]].length;
    expect(now).toBeGreaterThan(before);
    expect(typeOf(w, cells[0])).toBe(1);
  });
});

describe('湖岸场 lake:<id>', () => {
  it('在 0–1 之间，湖上为 1，范围以外为 0；生态的条件、脚本都能用', () => {
    const { eng, cells } = withLakes();
    const w = eng.world;
    eng.exec({ op: 'set_lake_type', type: { ...blood, bank: { radiusKm: 300 } } });
    eng.exec({ op: 'update_lake', id: 'L3', patch: { type: blood.id } });
    const d = w.derived;
    const bank = lakeBank(w, d, blood.id)!;
    const seeds: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (d.lakeType![i] === 1) seeds.push(i);
    expect(seeds).toContain(cells[3]);
    const R = 300 / w.kmPerUnit;
    const dist = graphDistance(w.mesh, seeds);
    let inside = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      expect(bank[i]).toBeGreaterThanOrEqual(0);
      expect(bank[i]).toBeLessThanOrEqual(1);
      if (dist[i] === 0) expect(bank[i]).toBe(1);
      if (dist[i] > R) expect(bank[i]).toBe(0);
      if (dist[i] > 0 && dist[i] < R * 0.5) inside++;
    }
    expect(inside).toBeGreaterThan(0);
    expect(lakeBank(w, d, blood.id)).toBe(bank);
    expect(lakeBank(w, d, 'nothing')).toBeUndefined();
    const tol = { field: `lake:${blood.id}`, min: 0.2, optLow: 0.5, optHigh: 1, max: 1 };
    eng.exec({ op: 'add_species', species: { id: 'red', name: '红原', color: '#aa2222', competition: 50, tolerances: [tol] } });
    eng.exec({ op: 'add_species', species: { id: 'red2', name: '红林', color: '#aa4422', competition: 0.01, tolerances: [], scripts: { placement: { api: 1, src: `return hasLake('${blood.id}') ? nearLake('${blood.id}') : 0;` } } } });
    const b2 = lakeBank(w, w.derived, blood.id)!;
    const red = w.small.species.findIndex((s) => s.id === 'red');
    let n = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.derived.dominant[i] !== red) continue;
      n++;
      expect(b2[i]).toBeGreaterThanOrEqual(0.2);
    }
    expect(n).toBeGreaterThan(0);
    const f = w.derived.placeF!;
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && w.derived.lake[i] !== 1) expect(f[i]).toBeCloseTo(b2[i], 6);
  });

  it('岸边的冷暖：湖边变暖，远处不变', () => {
    const { eng, cells } = withLakes();
    const w = eng.world;
    eng.exec({ op: 'set_lake_type', type: { ...blood, bank: { radiusKm: 200, dT: 4 } } });
    expect(w.derived.effT).toBeUndefined();
    eng.exec({ op: 'update_lake', id: 'L2', patch: { type: blood.id } });
    const t = w.derived.effT!;
    expect(t[cells[2]]).toBeGreaterThan(3);
    expect(t[cells[0]]).toBe(0);
  });
});

describe('湖的名字', () => {
  it('带起名模板的湖按模板起名；放的湖的名字只有地名一处（改名、换一个、恢复自动都是它）', () => {
    const { eng, cells } = withLakes();
    const w = eng.world;
    const lakeName = (cell: number) => w.derived.features.find((f) => f.type === 'lake' && f.cells.includes(cell))?.name;
    const plain = lakeName(cells[1]);
    expect(plain).toBeTruthy();
    eng.exec({ op: 'set_lake_type', type: { ...blood, names: [{ p: '{__species}之{color}潭' }] } });
    eng.exec({ op: 'type_lake', cell: cells[1], type: blood.id });
    expect(lakeName(cells[1])).toMatch(/^血池之.+潭$/);
    // 放的湖：名字是地名（rename_feature），湖上没有另一份名字
    const feature = () => w.derived.features.find((f) => f.cells.includes(cells[0]) && f.type === 'lake')!;
    const auto = lakeName(cells[0]);
    const key = feature().key;
    eng.takeRecomputed();
    eng.exec({ op: 'rename_feature', key, name: '镜海' });
    expect(eng.takeRecomputed()).toBe(1);
    expect(lakeName(cells[0])).toBe('镜海');
    expect(feature().custom).toBe(true);
    // 换一个：自己起的名字不要了，换一个自动的
    eng.exec({ op: 'reroll_feature', key });
    expect(feature().custom).toBe(false);
    expect(lakeName(cells[0])).not.toBe('镜海');
    expect(lakeName(cells[0])).not.toBe(auto);
    // 再改名、恢复自动：回到换过的那个自动名字
    const rerolled = lakeName(cells[0]);
    eng.exec({ op: 'rename_feature', key, name: '镜海' });
    eng.exec({ op: 'rename_feature', key, name: '' });
    expect(lakeName(cells[0])).toBe(rerolled);
    // 湖上不收名字
    expect(() => eng.exec({ op: 'update_lake', id: 'L0', patch: { name: 'x' } } as never)).toThrow();
    expect(w.small.lakes.every((l) => !('name' in l) && !('salt' in l))).toBe(true);
  });
});

describe('奇幻包里的湖、重放', () => {
  it('四种湖都用上；导出再导入一模一样；存成文件再打开逐值相同', () => {
    const { eng, cells } = withLakes();
    eng.exec(applyPackCommands(eng.world, FANTASY_PACK));
    const w = eng.world;
    expect(w.small.lakeTypes?.map((t) => t.name)).toEqual(['血池', '晶湖', '冥湖', '熔岩湖']);
    // 冥湖没有规则：只能自己选
    eng.exec({ op: 'update_lake', id: 'L1', patch: { type: 'styx_lake' } });
    expect(typeOf(w, cells[1])).toBe(3);
    const f = w.derived.features.find((x) => x.type === 'lake' && x.cells.includes(cells[1]))!;
    expect(f.name).toMatch(/冥湖|幽潭/);
    // 规则定得窄：大部分湖照旧是普通的湖
    const parts = lakeParts(w, w.derived);
    const typed = parts.lakes.filter((c) => typeOf(w, c[0]) !== 0).length;
    expect(typed).toBeLessThan(parts.lakes.length);
    const out = packFromWorld(w, { biomes: [], riverTypes: [] }, { name: 'x' });
    const back = readPack(JSON.stringify(out));
    expect(back.ok && back.pack.lakeTypes).toEqual(FANTASY_PACK.lakeTypes);
    const again = new Engine(w.settings, w.mesh);
    for (const c of eng.toDoc().commands) again.exec(c);
    expect(digestWorld(again.world)).toEqual(digestWorld(w));
  });
});

describe('match 脚本分河、湖：只给一种的变量另一种里没有，名字可以随便用', () => {
  const inputs = arrayInputs(2, { discharge: [1, 3], lakeArea: [10, 20], riverLength: [5, 50] });
  const run = (src: string, scope?: 'river' | 'lake') => runScript({ kind: 'match', src, scope }, { owner: 't', id: 't', seed: 1, inputs, cells: [0, 1] });
  it('河的脚本里 inflow、perennial 是自己的名字（第九轮之前能用的照样能用）', () => {
    const a = run('const inflow = discharge * 2;\nreturn inflow > 4;');
    expect(a.ok && Array.from(a.output.match)).toEqual([0, 1]);
    const b = run('const o = { perennial: 1, 干湖: 2 };\nreturn o.perennial + o.干湖 === 3;');
    expect(b.ok && Array.from(b.output.match)).toEqual([1, 1]);
    // 湖才有的变量在河里不是变量
    const c = run('return lakeArea > 15;');
    expect(c.ok).toBe(false);
  });
  it('湖的脚本能读湖的变量；河长在湖里是自己的名字', () => {
    const a = run('return 湖面积 > 15;', 'lake');
    expect(a.ok && Array.from(a.output.match)).toEqual([0, 1]);
    const b = run('const riverLength = 1;\nreturn riverLength > 0;', 'lake');
    expect(b.ok && Array.from(b.output.match)).toEqual([1, 1]);
  });
});

describe('新世界清掉自然湖选的类型', () => {
  it('set_worldgen reset 时 lakeTyping 去掉', () => {
    const { eng, cells } = withLakes();
    eng.exec({ op: 'set_lake_type', type: blood });
    eng.exec({ op: 'type_lake', cell: cells[0], type: blood.id });
    expect(eng.world.small.lakeTyping).toBeDefined();
    eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents', landFraction: 0.4 }, reset: true });
    expect(eng.world.small.lakeTyping).toBeUndefined();
  });
});
