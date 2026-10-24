import { describe, expect, it } from 'vitest';
import { cellLayers } from '../src/render/colors';
import { displayCellAt, displayCoast } from './display';
import { Engine } from './engine';
import { BUILTIN_COUNT, LAGOON_BIT, MAX_ISLAND_TYPES, landProvinceCells, provinceLand } from './island-types';
import { applyPackCommands, packFromWorld, parsePack } from './packs';
import { rasterizeWorld } from './subcell';
import { continents } from './testing/fixtures';
import type { World } from './world';

// 第十四轮：岛的种类（内置的与自己的）、小礁归海省、破碎的陆地归陆地省

function ocean(): Engine {
  const eng = new Engine({ seed: 4, cells: 12000, latNorth: 18, latSouth: 8 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
  return eng;
}

const freshCells = (w: World, before: Uint8Array) => {
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && !before[i]) out.push(i);
  return out;
};

const black = { id: 'black', name: '黑沙岛', shape: 'round' as const, height: 'hilly' as const, color: '#202020', rock: 0.6, province: 'land' as const };

describe('自己的岛的种类', () => {
  it('新建、放岛：新长出的陆地记着它的编号、按它的岩石；地形着色是它的颜色；改颜色马上用到已经放的岛上', () => {
    const eng = ocean();
    eng.exec({ op: 'set_island_type', type: black });
    const before = eng.world.causes.land.slice();
    expect(eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'black', size: 80, variant: 1 } })).toContain('黑沙岛');
    const w = eng.world;
    const fresh = freshCells(w, before);
    expect(fresh.length).toBeGreaterThan(5);
    for (const i of fresh) {
      expect(w.causes.islandType[i]).toBe(BUILTIN_COUNT + 1);
      expect(w.causes.erod[i]).toBeCloseTo(0.6, 4);
    }
    const opts = { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false } as const;
    const dark = (ww: World) => {
      const L = cellLayers(ww, opts);
      return fresh.filter((i) => !ww.derived.lake[i]).reduce((s, i) => s + L.smooth[4 * i] + L.smooth[4 * i + 1] + L.smooth[4 * i + 2], 0) / fresh.length / 3;
    };
    expect(dark(w)).toBeLessThan(80);
    eng.exec({ op: 'set_island_type', type: { ...black, color: '#f0f0f0' } });
    expect(dark(eng.world)).toBeGreaterThan(170);
    // 只改颜色：地形一格不变
    expect(eng.world.causes.land).toEqual(w.causes.land);
  });

  it('删掉一种：这种岛变成大陆岛（潟湖还是潟湖），后面的编号往前挪；撤销回来', () => {
    const eng = ocean();
    eng.exec({ op: 'set_island_type', type: { id: 'ring', name: '环', shape: 'ring', height: 'flat', province: 'land' } });
    eng.exec({ op: 'set_island_type', type: black });
    eng.exec({ op: 'add_island', island: { x: 0.7, y: 0.5, kind: 'ring', size: 90, variant: 2 } });
    eng.exec({ op: 'add_island', island: { x: 1.3, y: 0.5, kind: 'black', size: 60, variant: 1 } });
    const w = eng.world;
    const types = w.causes.islandType.slice();
    const elev = w.derived.elevation.slice();
    const lagoon = [...types.keys()].filter((i) => types[i] & LAGOON_BIT);
    expect(lagoon.length).toBeGreaterThan(3);
    eng.exec({ op: 'remove_island_type', id: 'ring' });
    const now = eng.world.causes.islandType;
    for (let i = 0; i < now.length; i++) {
      const c = types[i] & 0x7f;
      const want = c === BUILTIN_COUNT + 1 ? 1 : c === BUILTIN_COUNT + 2 ? BUILTIN_COUNT + 1 : c;
      expect(now[i] & 0x7f).toBe(want);
      expect(now[i] & LAGOON_BIT).toBe(types[i] & LAGOON_BIT);
    }
    // 地形不变（潟湖照旧浅）
    expect(eng.world.derived.elevation).toEqual(elev);
    expect(eng.world.small.islandTypes?.map((t) => t.id)).toEqual(['black']);
    eng.undo();
    expect(eng.world.causes.islandType).toEqual(types);
    expect(eng.world.small.islandTypes?.map((t) => t.id)).toEqual(['ring', 'black']);
  });

  it('不能用内置的 id；最多 64 种；找不到的种类放不了', () => {
    const eng = ocean();
    expect(() => eng.exec({ op: 'set_island_type', type: { ...black, id: 'reef' } })).toThrow();
    expect(() => eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'nope', size: 80 } })).toThrow('没有“nope”这种岛');
    const many = Array.from({ length: MAX_ISLAND_TYPES }, (_, k) => ({ op: 'set_island_type' as const, type: { ...black, id: `t${k}`, name: `岛${k}` } }));
    eng.exec({ op: 'batch', commands: many });
    expect(() => eng.exec({ op: 'set_island_type', type: { ...black, id: 'one-more' } })).toThrow('最多');
  });

  it('起名模板：岛的大半是这一种时按它起名；以后才加的模板只重新起名就用上', () => {
    const eng = ocean();
    eng.exec({ op: 'set_island_type', type: black });
    eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'black', size: 80, variant: 1 } });
    const isl = () => eng.world.derived.features.find((f) => f.type === 'island' && f.cells.some((c) => eng.world.causes.islandType[c]));
    expect(isl()?.tags).toContain('itype:black');
    eng.exec({ op: 'set_island_type', type: { ...black, names: [{ p: '黑石屿' }] } });
    expect(isl()?.name).toBe('黑石屿');
  });

  it('资源包：带上自己的岛的种类，用到别的世界；同一个包用两次第二次跳过', () => {
    const a = ocean();
    a.exec({ op: 'set_island_type', type: black });
    const pack = packFromWorld(a.world, {}, { name: '岛' });
    expect(pack.islandTypes?.map((t) => t.id)).toEqual(['black']);
    const parsed = parsePack(JSON.parse(JSON.stringify(pack)));
    expect(parsed.ok).toBe(true);
    const b = ocean();
    b.exec(applyPackCommands(b.world, pack));
    expect(b.world.small.islandTypes).toEqual(a.world.small.islandTypes);
    const again = applyPackCommands(b.world, pack);
    expect(again.commands.filter((c) => c.op === 'set_island_type')).toEqual([]);
  });

  it('画陆地画到岛上：画笔中心那一圈成了普通的陆地（不再是小礁、不再归海省）', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const reef = coastalSea(w);
    eng.exec({ op: 'add_island', island: { x: w.mesh.x[reef], y: w.mesh.y[reef], kind: 'reef', size: 1 } });
    expect(eng.world.causes.islandType[reef]).toBe(4);
    eng.exec({ op: 'paint_land', cells: [reef], t: [0], mode: 'land' });
    expect(eng.world.causes.islandType[reef]).toBe(0);
    const p = eng.world.causes.province[reef];
    expect(eng.world.small.provinces[p].land).toBe(true);
  });
});

// 挨着大陆的一格海（它的邻格里有陆地格）
function coastalSea(w: World, skip = 0): number {
  const { mesh, causes } = w;
  let k = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i] || mesh.boundary[i]) continue;
    let land = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (causes.land[mesh.adj[e]]) land++;
    if (land >= 2 && k++ >= skip) return i;
  }
  throw new Error('没有挨着陆地的海');
}

describe('小礁归海省', () => {
  it('贴着大陆放的小礁：并进旁边的海省，不并进大陆的陆地省；省份按格分陆海时它算海', () => {
    const eng = continents({ provinces: true });
    for (let k = 0; k < 6; k++) {
      const w = eng.world;
      const c = coastalSea(w, k * 7);
      const sea = w.causes.province[c];
      expect(w.small.provinces[sea].land).toBe(false);
      eng.exec({ op: 'add_island', island: { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'reef', size: 1 } });
      const now = eng.world;
      expect(now.causes.land[c]).toBe(1);
      const p = now.causes.province[c];
      expect(now.small.provinces[p].land, `#${c}`).toBe(false);
      expect(now.small.provinces[p].kind).toBe('sea');
      expect(provinceLand(now)[c]).toBe(0);
    }
  });

  it('划省：小礁能划进海省，不能划进陆地省；自己的种类改成归海省，它的格就换到海省里', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const c = coastalSea(w);
    eng.exec({ op: 'add_island', island: { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'reef', size: 1 } });
    let landP = -1;
    for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
      const j = w.mesh.adj[e];
      if (eng.world.causes.land[j] && eng.world.causes.province[j] >= 0) landP = eng.world.causes.province[j];
    }
    expect(landP).toBeGreaterThanOrEqual(0);
    expect(() => eng.exec({ op: 'assign_province', cells: [c], province: landP })).toThrow('陆海不符');
    const seaP = Object.entries(eng.world.small.provinces).find(([, m]) => !m.land)![0];
    eng.exec({ op: 'assign_province', cells: [c], province: Number(seaP) });
    expect(eng.world.causes.province[c]).toBe(Number(seaP));

    // 自己的种类：归陆地省的放在海上，改成归海省
    const o = ocean();
    o.exec({ op: 'generate_provinces', rules: { seed: 1 } });
    o.exec({ op: 'set_island_type', type: { ...black, shape: 'cell' } });
    o.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'black', size: 1 } });
    const cell = o.world.causes.islandType.findIndex((v) => v === BUILTIN_COUNT + 1);
    expect(o.world.small.provinces[o.world.causes.province[cell]].land).toBe(true);
    o.exec({ op: 'set_island_type', type: { ...black, shape: 'cell', province: 'sea' } });
    expect(o.world.small.provinces[o.world.causes.province[cell]].land).toBe(false);
  });
});

describe('破碎的陆地归陆地省', () => {
  it('每个水面格（与小礁）取离它最近的陆地省的格：沿网格一圈圈找，陆地省的格是自己', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const table = landProvinceCells(w);
    const pland = provinceLand(w);
    const { mesh } = w;
    // 沿网格的步数
    const hop = new Int32Array(mesh.n).fill(-1);
    let q: number[] = [];
    for (let i = 0; i < mesh.n; i++) if (pland[i] && w.derived.lake[i] !== 1) {
      hop[i] = 0;
      q.push(i);
    }
    for (let d = 1; q.length; d++) {
      const next: number[] = [];
      for (const c of q) for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (hop[mesh.adj[e]] < 0) {
        hop[mesh.adj[e]] = d;
        next.push(mesh.adj[e]);
      }
      q = next;
    }
    for (let i = 0; i < mesh.n; i++) {
      const t = table[i];
      expect(pland[t] === 1 && w.derived.lake[t] !== 1).toBe(true);
      if (hop[i] === 0) expect(t).toBe(i);
    }
  });

  // 海岸很碎时陆地像素常常落在海格里
  function broken(): Engine {
    const eng = continents({ provinces: true }).clone();
    eng.exec({ op: 'set_coast_style', roughness: 2.6 });
    const w = eng.world;
    // 加几个小礁：礁上的像素归海省
    for (let k = 0; k < 4; k++) {
      const c = coastalSea(w, k * 11);
      eng.exec({ op: 'add_island', island: { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'reef', size: 1 } });
    }
    return eng;
  }

  it('导出：画成陆地的像素都归陆地省（小礁上的除外），海上的像素都不归陆地省', () => {
    const w = broken().world;
    const W = 480;
    const H = 260;
    const raster = rasterizeWorld(w, W, H);
    const pland = provinceLand(w);
    let landPx = 0;
    for (let p = 0; p < W * H; p++) {
      const c = raster.cell[p];
      const meta = w.small.provinces[w.causes.province[c]];
      if (!meta) continue;
      if (raster.land[p]) {
        landPx++;
        if (pland[c] || w.causes.land[c] !== 1) expect(meta.land, `${p}`).toBe(true);
        else expect(meta.land).toBe(false);
      } else expect(meta.land).toBe(false);
    }
    expect(landPx).toBeGreaterThan(1000);
  });

  it('屏幕（着色器的 CPU 版）与悬停、选省：画成陆地的点归陆地省（小礁上的除外），画成水面的点不归陆地省', () => {
    const w = broken().world;
    const { mesh } = w;
    const coast = displayCoast(w).coast;
    const pland = provinceLand(w);
    let hint = 0;
    let onWater = 0;
    for (let py = 0; py < 160; py++) {
      for (let px = 0; px < 300; px++) {
        const x = ((px + 0.5) / 300) * mesh.width;
        const y = ((py + 0.5) / 160) * mesh.height;
        const d = displayCellAt(w, x, y, hint);
        hint = d.cell;
        if (d.province < 0) continue;
        const meta = w.small.provinces[w.causes.province[d.province]];
        if (!meta) continue;
        if (d.water) expect(meta.land && w.derived.lake[d.province] !== 1, `${px},${py}`).toBe(false);
        else {
          if (coast[d.cell] < 0) onWater++;
          if (pland[d.province] || w.causes.land[d.province] !== 1) expect(meta.land, `${px},${py}`).toBe(true);
        }
      }
    }
    // 真有落在水面格里的陆地点
    expect(onWater).toBeGreaterThan(20);
  });
});

describe('重放', () => {
  it('放岛、自己的种类、画陆地、删种类、撤销重做之后：重放的岛的种类、省份逐格相同', () => {
    const eng = continents({ provinces: true }).clone();
    const w = eng.world;
    eng.exec({ op: 'set_island_type', type: { ...black, shape: 'ring', province: 'sea' } });
    eng.exec({ op: 'add_island', island: { x: 0.3, y: 0.85, kind: 'atoll', size: 120, variant: 1 } });
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.2, 0.1], [0.9, 0.15]], kind: 'black', size: 80, variant: 2 } });
    const c = coastalSea(w, 3);
    eng.exec({ op: 'add_island', island: { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'reef', size: 1 } });
    eng.exec({ op: 'paint_land', cells: [c], t: [0], mode: 'sea' });
    eng.exec({ op: 'remove_island_type', id: 'black' });
    eng.undo();
    eng.redo();
    const again = Engine.fromDoc(eng.toDoc(), w.mesh);
    expect(again.world.causes.islandType).toEqual(eng.world.causes.islandType);
    expect(again.world.causes.province).toEqual(eng.world.causes.province);
    expect(again.world.causes.land).toEqual(eng.world.causes.land);
  });

  it('删掉一种岛再用同一个 id 新建、给它起名模板：已经放的岛名字与重放相同（不留旧的 itype: 标签）', () => {
    const eng = new Engine({ seed: 4, cells: 12000, latNorth: 18, latSouth: 8 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
    const t = { id: 'island-type-1', name: '黑沙岛', shape: 'round' as const, height: 'hilly' as const, province: 'land' as const };
    eng.exec({ op: 'set_island_type', type: t });
    eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'island-type-1', size: 80, variant: 1 } });
    eng.exec({ op: 'remove_island_type', id: 'island-type-1' });
    const islands = (e: Engine) => e.world.derived.features.filter((f) => f.type === 'island').map((f) => `${f.name}[${f.tags.join(',')}]`);
    expect(islands(eng).join()).not.toContain('itype:');
    eng.exec({ op: 'set_island_type', type: { ...t, name: '新的岛 1', shape: 'rugged' } });
    eng.exec({ op: 'set_island_type', type: { ...t, name: '新的岛 1', shape: 'rugged', names: [{ p: '模板{__species}屿' }] } });
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(islands(eng)).toEqual(islands(again));
  });
});
