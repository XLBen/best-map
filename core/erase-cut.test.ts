import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { continents as sharedContinents, seededEngine } from './testing/fixtures';
import { findCell, graphDistance } from './mesh';
import { brushCells, cutProvinces, provinceCells } from './select';
import { previewLand, restoreStroke } from './terrain';
import type { World } from './world';

// 第五轮：恢复原样（地形、气候的橡皮擦）、剪刀沿线切省、最小的笔刷正好一格

const continents = () => sharedContinents({ provinces: true });

// 一个圆形笔画：中心 t = 0，往外到 1
function disc(w: World, center: number, radiusCells: number) {
  const { mesh } = w;
  const cells: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    const d = Math.hypot(mesh.x[i] - mesh.x[center], mesh.y[i] - mesh.y[center]) / (mesh.spacing * radiusCells);
    if (d <= 1) {
      cells.push(i);
      t.push(Math.round(d * 1000) / 1000);
    }
  }
  return { cells, t };
}

describe('恢复原样', () => {
  it('画过陆地、堆过山的地方擦一遍：陆海与生成时逐格一致，预览就是结果', () => {
    const eng = continents();
    const w = eng.world;
    const original = w.causes.land.slice();
    const sea = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i] && w.derived.elevation[i] > -400 && w.mesh.x[i] > 0.3)!;
    const land = disc(w, sea, 5);
    eng.exec({ op: 'paint_land', cells: land.cells, t: land.t, mode: 'land' });
    eng.exec({ op: 'paint_relief', cells: land.cells, t: land.t, strength: 0.8 });
    expect(land.cells.some((i) => w.causes.land[i] !== original[i])).toBe(true);
    // 擦的范围比画的大一圈，边上的过渡带也擦干净
    const erase = disc(w, sea, 7);
    const r = restoreStroke(w, erase.cells, erase.t);
    const p = previewLand(w, r.cells, r.delta);
    const before = w.causes.land.slice();
    eng.exec({ op: 'restore_terrain', cells: erase.cells, t: erase.t });
    const gained: number[] = [];
    const lost: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.causes.land[i] && !before[i]) gained.push(i);
      if (!w.causes.land[i] && before[i]) lost.push(i);
    }
    expect(gained).toEqual([...p.gained].sort((a, b) => a - b));
    expect(lost).toEqual([...p.lost].sort((a, b) => a - b));
    for (let i = 0; i < w.mesh.n; i++) expect(w.causes.land[i]).toBe(original[i]);
    for (const i of land.cells) {
      expect(w.causes.landDelta[i]).toBe(0);
      expect(w.causes.upliftDelta[i]).toBe(0);
    }
  });

  it('冷暖干湿的改动擦掉后，气温回到原来的样子', () => {
    const eng = continents();
    const w = eng.world;
    const center = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && w.derived.continentality[i] > 0.5)!;
    const tBefore = w.derived.tMean.slice();
    const brush = disc(w, center, 4);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: brush.cells, values: brush.t.map((u) => -4 * (1 - u)), mode: 'add' });
    expect(eng.history[eng.history.length - 1].summary).toMatch(/^变冷 · \d+ 格 · 最多 −4 °C$/);
    expect(Math.min(...brush.cells.map((i) => w.derived.tMean[i] - tBefore[i]))).toBeLessThan(-2);
    const erase = disc(w, center, 6);
    eng.exec({ op: 'restore_climate', cells: erase.cells, t: erase.t });
    for (const i of brush.cells) expect(w.causes.tempOffset[i]).toBe(0);
    for (let i = 0; i < w.mesh.n; i++) expect(w.derived.tMean[i]).toBe(tBefore[i]);
  });
});

describe('剪刀', () => {
  // 最大的一个陆地省和它的中心
  const biggest = (w: World) => {
    let best = -1;
    let size = 0;
    for (const id of Object.keys(w.small.provinces).map(Number)) {
      const n = provinceCells(w, id).length;
      if (w.small.provinces[id].land && n > size) {
        size = n;
        best = id;
      }
    }
    const cells = provinceCells(w, best);
    let x = 0;
    let y = 0;
    for (const c of cells) {
      x += w.mesh.x[c];
      y += w.mesh.y[c];
    }
    return { id: best, cells, cx: x / cells.length, cy: y / cells.length };
  };

  it('沿直线切：两边的格各成一块，切口就在线上', () => {
    const eng = continents();
    const w = eng.world;
    const { id, cells, cx, cy } = biggest(w);
    // 从省的一边划到另一边（两端都在省外）
    const half = 0.5;
    const line: [number, number][] = [
      [cx - half, cy - 0.02],
      [cx + half, cy + 0.02],
    ];
    const cut = cutProvinces(w, line);
    const plan = cut.plans.find((p) => p.id === id)!;
    expect(plan).toBeDefined();
    expect(plan.parts.length).toBeGreaterThanOrEqual(2);
    const side = (c: number) => Math.sign((line[1][0] - line[0][0]) * (w.mesh.y[c] - line[0][1]) - (line[1][1] - line[0][1]) * (w.mesh.x[c] - line[0][0]));
    // 被线分开的两块，各自的格都在线的同一侧（原来就不相连的飞地不算）
    for (const part of plan.parts.slice(1)) expect(new Set(part.map(side)).size).toBe(1);
    expect(plan.parts.flat().sort((a, b) => a - b)).toEqual([...cells].sort((a, b) => a - b));
  });

  it('线没画到省界外：两端自动延长，照样切开', () => {
    const eng = continents();
    const w = eng.world;
    const { id, cx, cy } = biggest(w);
    const s = w.mesh.spacing;
    const cut = cutProvinces(w, [
      [cx - 2 * s, cy],
      [cx + 2 * s, cy + 0.3 * s],
    ]);
    expect(cut.before + cut.after).toBeGreaterThan(0);
    expect(cut.plans.find((p) => p.id === id)?.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('剪刀：从邻省外一格画到另一边邻省外一格，只切开中间的省', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    const s = mesh.spacing;
    const prov = (x: number, y: number) => (x < 0 || y < 0 || x > mesh.width || y > mesh.height ? -1 : w.causes.province[findCell(mesh, x, y)]);
    // 陆地省从大到小，过形心沿几个方向各画一条：两端都在省界外一格（邻省里）
    const ids = Object.keys(w.small.provinces)
      .map(Number)
      .filter((id) => w.small.provinces[id].land)
      .map((id) => ({ id, cells: provinceCells(w, id) }))
      .filter((p) => p.cells.length >= 12)
      .sort((a, b) => b.cells.length - a.cells.length);
    let tested = 0;
    for (const { id, cells } of ids) {
      if (tested >= 24) break;
      const cx = cells.reduce((t, c) => t + mesh.x[c], 0) / cells.length;
      const cy = cells.reduce((t, c) => t + mesh.y[c], 0) / cells.length;
      if (prov(cx, cy) !== id) continue;
      for (const angle of [0.3, 1.4, 2.5]) {
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        // 从形心往一个方向走到出省，再往外一格
        const exit = (sign: number): [number, number] | null => {
          for (let t = 0; t < 60 * s; t += 0.1 * s) {
            const x = cx + sign * dx * t;
            const y = cy + sign * dy * t;
            if (prov(x, y) !== id) return [x + sign * dx * s, y + sign * dy * s];
          }
          return null;
        };
        const a = exit(-1);
        const b = exit(1);
        if (!a || !b || prov(a[0], a[1]) < 0 || prov(b[0], b[1]) < 0) continue;
        const line: [number, number][] = [a, b];
        // 只用不延长时正好切开这个省的线（线本身在邻省里那一格切不开邻省）
        const plain = cutProvinces(w, line, { extend: false });
        if (plain.plans.map((p) => p.id).join() !== String(id)) continue;
        const cut = cutProvinces(w, line);
        expect(cut.before + cut.after).toBe(0);
        expect(cut.plans.map((p) => p.id)).toEqual([id]);
        tested++;
      }
    }
    expect(tested).toBeGreaterThanOrEqual(20);
  });

  it('一条线来回切两次：切成三块，执行后多出两个省，可以撤销', () => {
    const eng = continents();
    const w = eng.world;
    const { id, cx, cy } = biggest(w);
    const s = w.mesh.spacing;
    const cut = cutProvinces(w, [
      [cx - 0.6, cy - 3 * s],
      [cx + 0.6, cy - 3 * s],
      [cx + 0.6, cy + 3 * s],
      [cx - 0.6, cy + 3 * s],
    ]);
    const plan = cut.plans.find((p) => p.id === id)!;
    expect(plan.parts.length).toBeGreaterThanOrEqual(3);
    const count = Object.keys(w.small.provinces).length;
    const extra = cut.plans.reduce((n, p) => n + p.parts.length - 1, 0);
    eng.exec({ op: 'batch', label: '切开', commands: cut.plans.flatMap((p) => p.parts.slice(1).map((cells) => ({ op: 'assign_province' as const, cells, province: 'new' as const }))) });
    expect(Object.keys(w.small.provinces).length).toBe(count + extra);
    eng.undo();
    expect(Object.keys(w.small.provinces).length).toBe(count);
  });
});

describe('画笔', () => {
  it('最小的笔刷：鼠标下那一格一定涂到，t = 0', () => {
    const eng = continents();
    const w = eng.world;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    for (let k = 0; k < 50; k++) {
      const x = 0.1 + ((k * 0.0371) % 1.8);
      const y = 0.1 + ((k * 0.0613) % 0.8);
      const b = brushCells(w, x, y, cellKm * 0.6);
      const under = findCell(w.mesh, x, y);
      expect(b.cells).toContain(under);
      expect(b.t[b.cells.indexOf(under)]).toBe(0);
      expect(b.cells.length).toBeLessThanOrEqual(3);
    }
  });

  it('只在附近找格，结果与在整张图上找相同', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    for (const rCells of [2, 5, 12]) {
      for (let k = 0; k < 10; k++) {
        const x = 0.2 + ((k * 0.173) % 1.6);
        const y = 0.15 + ((k * 0.091) % 0.7);
        const r = rCells * mesh.spacing;
        const dist = graphDistance(mesh, [findCell(mesh, x, y)], r * 1.6);
        const old: number[] = [];
        for (let i = 0; i < mesh.n; i++) if (dist[i] <= r * 1.6 && Math.hypot(mesh.x[i] - x, mesh.y[i] - y) <= r) old.push(i);
        expect(brushCells(w, x, y, r * w.kmPerUnit).cells).toEqual(old);
      }
    }
  });
});

describe('地图在星球上的位置', () => {
  it('整体往北挪：变冷；撤销回到原样；存档重放结果一致', () => {
    const eng = continents();
    const w = eng.world;
    const tBefore = w.derived.tMean.slice();
    const mean = (a: ArrayLike<number>) => {
      let s = 0;
      let k = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        if (!w.causes.land[i]) continue;
        s += a[i];
        k++;
      }
      return s / k;
    };
    eng.exec({ op: 'set_planet', patch: { latShift: 12 } });
    expect(mean(w.derived.tMean)).toBeLessThan(mean(tBefore) - 3);
    expect(eng.history[eng.history.length - 1].summary).toBe('调整 · 地图在星球上的位置');
    const replay = Engine.fromDoc(eng.toDoc(), w.mesh);
    for (let i = 0; i < w.mesh.n; i++) expect(replay.world.derived.tMean[i]).toBe(w.derived.tMean[i]);
    eng.undo();
    for (let i = 0; i < w.mesh.n; i++) expect(w.derived.tMean[i]).toBe(tBefore[i]);
  });
});

describe('调整整个世界', () => {
  it('改一项星球参数，不会把别的几项重置回默认值', () => {
    const eng = seededEngine({ seed: 1, cells: 4000 });
    eng.exec({ op: 'set_planet', patch: { tilt: 30 } });
    expect(eng.history[eng.history.length - 1].summary).toBe('调整 · 四季分明');
    eng.exec({ op: 'set_planet', patch: { solar: 1.1 } });
    expect(eng.history[eng.history.length - 1].summary).toBe('调整 · 整体冷暖');
    expect(eng.world.small.planet.tilt).toBe(30);
    expect(eng.world.small.planet.solar).toBe(1.1);
  });
});
