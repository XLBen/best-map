import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { Engine } from './engine';
import { islandCode, provinceLand } from './island-types';
import { BUILTIN_ISLAND_TYPES } from './packs/base';

// 内置的五种岛（新世界默认加进来，编号 1–5；自己的接着往后）
const BUILTIN_COUNT = BUILTIN_ISLAND_TYPES.length;
import { previewWorldOf } from './preview-world';
import { rasterizeWorld } from './subcell';
import { type IslandSpec, centerCell, chainIslands, combineStamps, lakeIslandStamp } from './terrain';
import { continents } from './testing/fixtures';
import { FREE_HEIGHT, type World } from './world';

// 第十五轮：湖面和海一样能放岛（岛的脚本、湖心岛撤掉了）

const all = (w: World) => [...Array(w.mesh.n).keys()];

// 内陆放一个大湖（常年蓄满），返回湖心那一格
function withLake(provinces = false): { eng: Engine; c: number } {
  const eng = continents({ provinces });
  const w = eng.world;
  const inland = all(w).find((i) => w.causes.land[i] && w.derived.lake[i] !== 1 && w.derived.continentality[i] > 0.6 && w.derived.slope[i] < 5)!;
  eng.exec({ op: 'add_lake', lake: { cell: inland, radius: 300, depth: 150, perennial: true } });
  return { eng, c: inland };
}

// 从 c 起连成一片、水面一样高的湖面格
function lakeAt(w: World, c: number): number[] {
  const level = w.derived.water[c];
  const out = [c];
  const seen = new Set(out);
  for (let h = 0; h < out.length; h++) {
    for (let e = w.mesh.off[out[h]]; e < w.mesh.off[out[h] + 1]; e++) {
      const j = w.mesh.adj[e];
      if (!seen.has(j) && w.derived.lake[j] === 1 && Math.abs(w.derived.water[j] - level) < 1e-3) {
        seen.add(j);
        out.push(j);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

// 一片格四周一圈（不在这片里的邻格）
function ringOf(w: World, cells: number[]): number[] {
  const set = new Set(cells);
  const out = new Set<number>();
  for (const c of cells) for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (!set.has(w.mesh.adj[e])) out.add(w.mesh.adj[e]);
  return [...out].sort((a, b) => a - b);
}

// 世界的摘要（小数据按 JSON 比：撤销时小数据是从 JSON 读回来的，值为 undefined 的键没有了）
const dig = (w: World) => ({ ...digestWorld(w), small: JSON.stringify(w.small) });

const heights = (w: World) => all(w).filter((i) => w.causes.islandHeight !== undefined && w.causes.islandHeight[i] !== FREE_HEIGHT);
const at = (w: World, c: number, kind: string, size = 150, variant = 0): IslandSpec => ({ x: w.mesh.x[c], y: w.mesh.y[c], kind, size, variant });

const tall = { id: 'tall', name: '高岛', shape: 'round' as const, height: 'high' as const, province: 'land' as const, names: [{ p: '{color}峰岛' }] };
const shoal = { id: 'shoal', name: '沙洲', shape: 'long' as const, height: 'flat' as const, province: 'sea' as const };

describe('湖里的岛', () => {
  // 每一种：高出湖面的干陆地，湖面不变，湖只少了岛占的格；只改这个湖里不挨岸的格；是一个有名字的岛（一格的小礁和海里一样没有名字）
  const cases: [string, number, number][] = [
    ['continental', 3, 600],
    ['low', 2, 12.5],
    ['atoll', 1, 4.5],
    ['reef', 2, 2.5],
    ['tall', 5, 1600],
  ];
  for (const [kind, lo, hi] of cases) {
    it(`${kind}：岛在湖面上，四周一圈湖水，湖面高度、别的格都不变`, () => {
      const { eng, c } = withLake();
      const w = eng.world;
      if (kind === 'tall') eng.exec({ op: 'set_island_type', type: tall });
      const level = w.derived.water[c];
      const lake = lakeAt(w, c);
      const lakeSet = new Set(lake);
      const before = { elev: w.derived.elevation.slice(), landDelta: w.causes.landDelta.slice(), uplift: w.causes.upliftDelta.slice(), erod: w.causes.erodDelta.slice(), land: w.causes.land.slice() };
      const otherLakes = all(w).filter((i) => w.derived.lake[i] === 1 && !lakeSet.has(i));
      expect(eng.exec({ op: 'add_island', island: at(w, c, kind) })).toMatch(/^在湖里放/);
      const isle = heights(w);
      expect(isle.length).toBeGreaterThan(0);
      const code = islandCode(w.small, kind);
      for (const i of isle) {
        // 只占这个湖里不挨岸的格
        expect(lakeSet.has(i)).toBe(true);
        for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) expect(lakeSet.has(w.mesh.adj[e])).toBe(true);
        expect(w.derived.lake[i]).toBe(0);
        expect(w.causes.islandType[i]).toBe(code);
        expect(w.derived.elevation[i]).toBe(w.causes.islandHeight![i]);
        expect(w.derived.elevation[i] - level).toBeGreaterThanOrEqual(lo - 1e-3);
        expect(w.derived.elevation[i] - level).toBeLessThanOrEqual(hi);
      }
      // 陆海、陆度、抬升、岩石一格不变；别的格高程不变
      expect(w.causes.land).toEqual(before.land);
      expect(w.causes.landDelta).toEqual(before.landDelta);
      expect(w.causes.upliftDelta).toEqual(before.uplift);
      expect(w.causes.erodDelta).toEqual(before.erod);
      const isleSet = new Set(isle);
      for (const i of all(w)) if (!isleSet.has(i)) expect(w.derived.elevation[i]).toBe(before.elev[i]);
      // 湖：只少了岛占的格，剩下的连成一片、湖面高度不变；别的湖不变
      const after = lake.filter((i) => !isleSet.has(i));
      for (const i of after) {
        expect(w.derived.lake[i]).toBe(1);
        expect(w.derived.water[i]).toBe(level);
      }
      expect(lakeAt(w, after[0])).toEqual(after);
      for (const i of otherLakes) expect(w.derived.lake[i]).toBe(1);
      for (const j of ringOf(w, isle)) if (!isleSet.has(j)) expect(w.derived.lake[j]).toBe(1);
      // 有名字的岛（一格的小礁和海里一样不单独起名）
      const f = w.derived.features.find((x) => x.type === 'island' && x.cells.some((i) => isleSet.has(i)));
      if (kind === 'reef') expect(isle.length).toBe(1);
      else {
        expect(f?.name).toBeTruthy();
        if (kind === 'tall') expect(f!.name).toMatch(/峰岛$/);
      }
    });
  }

  it('环礁：潟湖还是湖，从离得最近的地方打开一个口子与外面的湖连成一片', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    const level = w.derived.water[c];
    const lake = lakeAt(w, c);
    eng.exec({ op: 'add_island', island: at(w, c, 'atoll', 260, 2) });
    const isle = new Set(heights(w));
    const rest = lake.filter((i) => !isle.has(i));
    expect(lakeAt(w, rest[0])).toEqual(rest);
    for (const i of rest) expect(w.derived.water[i]).toBe(level);
  });

  it('点在干的陆地上：放岛工具照旧说“这里已经是陆地”，命令照旧（不定高度）；干盐湖算陆地；湖太窄放不下', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    const lake = lakeAt(w, c);
    const lakeSet = new Set(lake);
    // 挨着湖岸的湖面格上放小礁：放不下（岛四周要留一圈湖面）
    const shore = lake.find((i) => {
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) if (!lakeSet.has(w.mesh.adj[e])) return true;
      return false;
    })!;
    expect(() => eng.exec({ op: 'add_island', island: at(w, shore, 'reef') })).toThrow('湖太窄，放不下岛');
    expect(lakeIslandStamp(w, at(w, shore, 'reef'), w.derived).cells).toEqual([]);
    // 干的陆地：不定高度
    const dry = all(w).find((i) => w.causes.land[i] && w.derived.lake[i] === 0 && w.derived.continentality[i] > 0.7)!;
    try {
      eng.exec({ op: 'add_island', island: at(w, dry, 'low', 60) });
    } catch {
      // 放不下也行
    }
    expect(w.causes.islandHeight).toBeUndefined();
  });

  it('岛链画过海、陆地、湖：海里的照旧，湖里的按湖里的岛，干的陆地上的不放；全在海上的岛链与以前逐值相同', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    // 从湖心往外画到海里
    const sea = all(w).filter((i) => !w.causes.land[i] && !w.mesh.boundary[i]);
    const far = sea.reduce((b, i) => (Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < Math.hypot(w.mesh.x[b] - w.mesh.x[c], w.mesh.y[b] - w.mesh.y[c]) ? i : b));
    const chain = { points: [[w.mesh.x[c], w.mesh.y[c]], [w.mesh.x[far] + (w.mesh.x[far] - w.mesh.x[c]) * 0.8, w.mesh.y[far] + (w.mesh.y[far] - w.mesh.y[c]) * 0.8]] as [number, number][], kind: 'low', size: 60, density: 1.5, variant: 0 };
    const lakes = () => w.derived;
    const islands = chainIslands(w, chain, lakes);
    const where = islands.map((s) => {
      const k = centerCell(w.mesh, s.x, s.y);
      return !w.causes.land[k] ? 'sea' : w.derived.lake[k] === 1 ? 'lake' : 'land';
    });
    expect(where).toContain('lake');
    expect(where).toContain('sea');
    expect(where).not.toContain('land');
    // 不给湖面时（以前）：岛心在陆格上的都不放
    expect(chainIslands(w, chain).length).toBe(where.filter((x) => x === 'sea').length);
    const land0 = w.causes.land.slice();
    const s = eng.exec({ op: 'add_island_chain', chain });
    expect(s).toMatch(/^画岛链 · \d+ 个低平岛$/);
    const isle = heights(w);
    expect(isle.length).toBeGreaterThan(0);
    for (const i of isle) expect(land0[i]).toBe(1);
    expect(all(w).some((i) => w.causes.land[i] && !land0[i])).toBe(true);

    // 全在海上：与不给湖面时（以前的算法）逐值相同
    const eng2 = continents();
    const w2 = eng2.world;
    const s2 = all(w2).filter((i) => !w2.causes.land[i] && !w2.mesh.boundary[i]);
    const a = s2[Math.floor(s2.length * 0.3)];
    const seaChain = { points: [[w2.mesh.x[a], w2.mesh.y[a]], [w2.mesh.x[a] + 0.15, w2.mesh.y[a] + 0.02]] as [number, number][], kind: 'continental', size: 60, density: 1, variant: 3 };
    const old = combineStamps(w2, chainIslands(w2, seaChain));
    const now = combineStamps(w2, chainIslands(w2, seaChain, () => w2.derived), () => w2.derived);
    expect(now).toEqual(old);
  });

  it('归海省的种类在湖里跟着湖：湖单独成省时在那个湖的湖省里，并进陆地省时在旁边的陆地省里，从不成海省', () => {
    const { eng, c } = withLake(true);
    const w = eng.world;
    eng.exec({ op: 'set_lake_mode', mode: 'separate' });
    eng.exec({ op: 'set_island_type', type: shoal });
    const lakeProv = w.causes.province[c];
    expect(w.small.provinces[lakeProv].kind).toBe('lake');
    const lake = lakeAt(w, c);
    eng.exec({ op: 'add_island', island: at(w, c, 'shoal', 120) });
    // 再放一个小礁：湖里离岛最远、不挨岸的湖面格
    const set = new Set(lake);
    const inner = lake.filter((i) => w.derived.lake[i] === 1 && [...Array(w.mesh.off[i + 1] - w.mesh.off[i]).keys()].every((k) => set.has(w.mesh.adj[w.mesh.off[i] + k]) && w.derived.lake[w.mesh.adj[w.mesh.off[i] + k]] === 1));
    const far = inner.reduce((b, i) => (Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) > Math.hypot(w.mesh.x[b] - w.mesh.x[c], w.mesh.y[b] - w.mesh.y[c]) ? i : b));
    eng.exec({ op: 'add_island', island: at(w, far, 'reef') });
    const isle = heights(w);
    expect(isle.length).toBeGreaterThan(1);
    const pland = provinceLand(w);
    for (const i of isle) {
      expect(pland[i]).toBe(1);
      expect(w.small.provinces[w.causes.province[i]].kind).toBe('lake');
    }
    // 导出：岛上的像素不归海省
    const W = 480;
    const H = 260;
    const raster = rasterizeWorld(w, W, H);
    const isleSet = new Set(isle);
    let px = 0;
    for (let p = 0; p < W * H; p++) {
      if (!isleSet.has(raster.cell[p])) continue;
      px++;
      expect(w.small.provinces[w.causes.province[raster.cell[p]]].kind).not.toBe('sea');
    }
    expect(px).toBeGreaterThan(0);
    // 并进陆地省
    eng.exec({ op: 'set_lake_mode', mode: 'merge' });
    for (const i of isle) expect(w.small.provinces[w.causes.province[i]].kind).toBe('land');
    // 改回单独成省；把种类改成归陆地省：岛换到陆地省里
    eng.exec({ op: 'set_lake_mode', mode: 'separate' });
    for (const i of isle) expect(w.small.provinces[w.causes.province[i]].kind).toBe('lake');
    eng.exec({ op: 'set_island_type', type: { ...shoal, province: 'land' } });
    for (const i of isle.filter((k) => w.causes.islandType[k] === islandCode(w.small, 'shoal'))) expect(w.small.provinces[w.causes.province[i]].kind).toBe('land');
    // 重放逐值相同
    const again = Engine.fromDoc(JSON.parse(JSON.stringify(eng.toDoc())), w.mesh);
    expect(again.world.causes.province).toEqual(w.causes.province);
    expect(again.world.small.provinces).toEqual(w.small.provinces);
  });

  it('重放、撤销、重做、检查点与现场逐值相同；撤销到放之前去掉定高度的数组', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    eng.exec({ op: 'set_island_type', type: tall });
    const before = dig(w);
    const cp = structuredClone(eng.toCheckpoint());
    const steps = eng.history.length;
    eng.exec({ op: 'add_island_chain', chain: { points: [[w.mesh.x[c] - 0.1, w.mesh.y[c]], [w.mesh.x[c] + 0.1, w.mesh.y[c] + 0.05]], kind: 'low', size: 50, density: 1, variant: 1 } });
    expect(heights(w).length).toBeGreaterThan(0);
    eng.exec({ op: 'add_island', island: at(w, c, 'tall', 60) });
    expect(eng.history.length).toBe(steps + 2);
    const after = dig(w);
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    expect(dig(Engine.fromDoc(doc, w.mesh).world)).toEqual(after);
    // 检查点在放岛之前：恢复后补上两步
    const short = { ...doc, commands: doc.commands.slice(0, -2) };
    expect(dig(Engine.fromCheckpoint(cp, doc, w.mesh)!.world)).toEqual(after);
    // 检查点在放岛之后：恢复后撤掉两步
    const cp2 = structuredClone(eng.toCheckpoint());
    expect(dig(Engine.fromCheckpoint(cp2, short, w.mesh)!.world)).toEqual(before);
    eng.undo();
    eng.undo();
    expect(w.causes.islandHeight).toBeUndefined();
    expect(dig(w)).toEqual(before);
    eng.redo();
    eng.redo();
    expect(dig(w)).toEqual(after);
  });

  it('批量命令里不能往湖里放岛（海里的照样能放）', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    expect(() => eng.exec({ op: 'batch', commands: [{ op: 'add_island', island: at(w, c, 'low') }] })).toThrow('批量命令里的岛只能放在海里');
    expect(w.causes.islandHeight).toBeUndefined();
    const sea = all(w).find((i) => !w.causes.land[i] && !w.mesh.boundary[i] && w.mesh.x[i] > 0.3)!;
    expect(() => eng.exec({ op: 'batch', commands: [{ op: 'add_island', island: at(w, sea, 'low', 60) }] })).not.toThrow();
  });

  it('画陆地 / 海、恢复原样画到的地方不再定高度（又是湖）；删湖、改湖的大小后岛留着（小丘），撤销回来', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    eng.exec({ op: 'add_island', island: at(w, c, 'continental') });
    const isle = heights(w);
    const h = isle.map((i) => w.causes.islandHeight![i]);
    // 恢复原样：又是湖
    eng.exec({ op: 'restore_terrain', cells: isle, t: isle.map(() => 0) });
    for (const i of isle) {
      expect(w.causes.islandHeight![i]).toBe(FREE_HEIGHT);
      expect(w.causes.islandType[i]).toBe(0);
      expect(w.derived.lake[i]).toBe(1);
    }
    eng.undo();
    // 删湖：岛上的格还是那个高度，是干的陆地
    const id = w.small.lakes[0].id;
    eng.exec({ op: 'remove_lake', id });
    isle.forEach((i, k) => {
      expect(w.causes.islandHeight![i]).toBe(h[k]);
      expect(w.derived.elevation[i]).toBe(h[k]);
      expect(w.derived.lake[i]).toBe(0);
    });
    eng.undo();
    // 湖改大：岛照旧是干的
    eng.exec({ op: 'update_lake', id, patch: { radius: 400 } });
    for (const i of isle) expect(w.derived.lake[i]).toBe(0);
    eng.undo();
    for (const i of isle) expect(w.derived.lake[i]).toBe(0);
  });

  it('预览就是结果：放岛、岛链的预览世界与执行后的世界逐值相同；主线程算的岛占的格与结果相同', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    const spec = at(w, c, 'atoll', 200, 4);
    const cells = lakeIslandStamp(w, spec, w.derived).cells;
    const cmds: Command[] = [
      { op: 'add_island', island: spec },
      { op: 'add_island_chain', chain: { points: [[w.mesh.x[c] - 0.12, w.mesh.y[c]], [w.mesh.x[c] + 0.12, w.mesh.y[c]]], kind: 'reef', size: 30, density: 1, variant: 0 } },
    ];
    for (const cmd of cmds) {
      const { patch } = eng.previewWorld(cmd);
      const shown = previewWorldOf(w, structuredClone(patch));
      const copy = eng.clone();
      copy.exec(cmd);
      expect(digestWorld(shown), cmd.op).toEqual(digestWorld(copy.world));
    }
    eng.exec(cmds[0]);
    expect(heights(w)).toEqual(cells);
    // 第十八轮加了碎岛
    expect(BUILTIN_COUNT).toBe(5);
  });
});
