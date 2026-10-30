import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { digest } from '../tools/hash';
import { computeElevation, elevationMemo, lakeArea, oceanSteps, seafloor, seafloorStats } from './elevation';
import { Engine } from './engine';
import { exportPackage } from './export';
import { oceanFloor } from './generate';
import { graphDistance } from './mesh';
import { seabedFields } from './terrain';
import { continents, engineFor, snapshot } from './testing/fixtures';
import type { World } from './world';

// 第十二轮：海底按离岸距离的剖面（大陆架、陆架坡折、陆坡、陆隆、深海），湖底的形状

// 只走海格的离岸距离（km，到格心）
function seaDistance(w: World): Float64Array {
  const { mesh, causes } = w;
  const coast: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      if (causes.land[mesh.adj[e]]) {
        coast.push(i);
        break;
      }
    }
  }
  const d = graphDistance(mesh, coast, Infinity, (_i, j, e) => (causes.land[j] ? Infinity : mesh.dist[e]));
  const half = 0.5 * mesh.spacing * w.kmPerUnit;
  return d.map((v) => v * w.kmPerUnit + half);
}

const quantile = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(p * (s.length - 1))];
};

const planet = () =>
  snapshot('seabed:planet', () => {
    const eng = engineFor({ seed: 4, cells: 10000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    return eng;
  });

describe('海底的剖面', () => {
  for (const [label, make] of [
    ['一块地区', () => continents()],
    ['整个星球', planet],
  ] as const) {
    it(`${label}：岸边浅、大陆架之外陡落、远洋深，没有 −2 m 的一圈`, () => {
      const w = make().world;
      const { mesh, causes } = w;
      const elev = w.derived.elevation;
      const dist = seaDistance(w);
      const sea: number[] = [];
      const coastal: number[] = [];
      const shelf: number[] = [];
      const deep: number[] = [];
      for (let i = 0; i < mesh.n; i++) {
        if (causes.land[i]) continue;
        sea.push(elev[i]);
        if (dist[i] <= mesh.spacing * w.kmPerUnit) coastal.push(elev[i]);
        if (dist[i] <= 60) shelf.push(elev[i]);
        if (dist[i] > 1200 && dist[i] < Infinity) deep.push(elev[i]);
      }
      // 海里没有高于 −1 m 的，也没有一大圈正好 −2 m 的（以前的夹值）
      expect(Math.max(...sea)).toBeLessThanOrEqual(-1);
      expect(sea.filter((v) => v === -2).length).toBeLessThan(sea.length * 0.002);
      // 挨着岸的一圈：大多几十米深；没有一格就掉进深海的（岛的四周也是）
      expect(quantile(coastal, 0.5)).toBeGreaterThan(-90);
      expect(quantile(coastal, 0.5)).toBeLessThan(-5);
      expect(Math.min(...coastal)).toBeGreaterThan(-2000);
      // 离岸 60 km 以内：九成在大陆架上（浅于 −250 m）
      if (shelf.length > 20) expect(shelf.filter((v) => v > -250).length).toBeGreaterThan(shelf.length * 0.85);
      // 远洋：大多 −4000 到 −5800 m
      expect(quantile(deep, 0.5)).toBeLessThan(-4000);
      expect(quantile(deep, 0.5)).toBeGreaterThan(-5800);
      // 陆架坡折明显：浅于 −200 m 的大陆架与深于 −3000 m 的深海之外，中间深度的格不多（陆坡窄、只有陆缘台地在中间）
      const mid = sea.filter((v) => v < -300 && v > -2500).length;
      expect(mid).toBeLessThan(sea.length * 0.2);
      expect(Math.min(...sea)).toBeGreaterThan(-11000);
    });
  }

  it('洋底随洋壳年龄变深，海沟很深', () => {
    const at = (age: number) => oceanFloor(age, 0, 1700, 2600, 0, 0);
    expect(at(0)).toBeCloseTo(-2600, 0);
    expect(at(0.05)).toBeLessThan(at(0));
    expect(at(0.2)).toBeLessThan(at(0.05));
    expect(at(1)).toBeLessThan(-5200);
    expect(oceanFloor(1, 1, 1700, 2600, 0, 0)).toBeLessThan(-9000);
    expect(oceanFloor(0.3, 0.6, 1700, 2600, 0, 0)).toBeLessThan(-7000);
    // 星球上真的有海沟（−6500 m 以下）
    const w = planet().world;
    let min = 0;
    for (let i = 0; i < w.mesh.n; i++) if (!w.causes.land[i]) min = Math.min(min, w.derived.elevation[i]);
    expect(min).toBeLessThan(-6500);
  });

  it('只写海格：陆格、陆海的分界一格不动；结果确定，缓存与从头算逐值相同', () => {
    const w = continents().world;
    const land = w.causes.land.slice();
    const e = new Float32Array(w.mesh.n).fill(Number.NaN);
    seafloorStats.on = false;
    try {
      seafloor(w, e);
      const again = new Float32Array(w.mesh.n).fill(Number.NaN);
      seafloor(w, again);
      expect(digest(again)).toBe(digest(e));
    } finally {
      seafloorStats.on = true;
    }
    for (let i = 0; i < w.mesh.n; i++) {
      if (land[i]) expect(Number.isNaN(e[i])).toBe(true);
      else expect(e[i]).toBeLessThanOrEqual(-1);
    }
    expect(digest(w.causes.land)).toBe(digest(land));
    // 引擎里的高程：海格与这里相同
    for (let i = 0; i < w.mesh.n; i++) if (!land[i]) expect(w.derived.elevation[i]).toBe(e[i]);
    // 缓存开着：同样的输入直接用上次的结果
    const r0 = seafloorStats.reused;
    const memo = new Float32Array(w.mesh.n).fill(Number.NaN);
    seafloor(w, memo);
    expect(seafloorStats.reused).toBe(r0 + 1);
    expect(digest(memo)).toBe(digest(e));
  });

  it('重新打开（整段重放）的世界：生成器的场是另一份、内容相同，海底照用缓存，与整个重算逐位相同', () => {
    const eng = continents();
    const w = eng.world;
    const before = w.derived.elevation.slice();
    const r0 = seafloorStats.reused;
    const opened = Engine.fromDoc(eng.toDoc(), w.mesh);
    const w2 = opened.world;
    expect(seafloorStats.reused).toBeGreaterThan(r0);
    seafloorStats.on = false;
    try {
      const fresh = new Float32Array(w2.mesh.n).fill(Number.NaN);
      seafloor(w2, fresh);
      let bad = 0;
      for (let i = 0; i < w2.mesh.n; i++) if (!w2.causes.land[i] && (w2.derived.elevation[i] !== fresh[i] || before[i] !== fresh[i])) bad++;
      expect(bad).toBe(0);
    } finally {
      seafloorStats.on = true;
    }
  });

  it('只改陆上的抬升（海岸上的没变）：海底照用缓存；改了海陆：与从头算相同', () => {
    const eng = continents();
    const w = eng.world;
    const dist = seaDistance(w);
    // 内陆一格（离海三格以上）
    const { mesh, causes } = w;
    const far = graphDistance(
      mesh,
      [...Array(mesh.n).keys()].filter((i) => !causes.land[i]),
      Infinity,
    );
    const inland = [...Array(mesh.n).keys()].filter((i) => causes.land[i] && far[i] > mesh.spacing * 4).slice(0, 3);
    expect(inland.length).toBe(3);
    const r0 = seafloorStats.reused;
    eng.exec({ op: 'paint_relief', cells: inland, t: [0, 0, 0], strength: 0.5 });
    expect(seafloorStats.reused).toBeGreaterThan(r0);
    // 画一笔海（离岸近的陆地）
    const shore = [...Array(mesh.n).keys()].filter((i) => causes.land[i] && far[i] <= mesh.spacing * 1.5).slice(0, 40);
    eng.exec({ op: 'paint_land', cells: shore, t: shore.map(() => 0.2), mode: 'sea' });
    const got = w.derived.elevation.slice();
    seafloorStats.on = false;
    elevationMemo.on = false;
    try {
      const fresh = computeElevation(w).elevation;
      for (let i = 0; i < mesh.n; i++) if (!w.causes.land[i]) expect(got[i]).toBe(fresh[i]);
    } finally {
      seafloorStats.on = true;
      elevationMemo.on = true;
    }
    expect(dist.length).toBe(mesh.n);
  });

  for (const [label, make] of [
    ['一块地区', () => continents()],
    ['整个星球', planet],
  ] as const) {
    it(`${label}：只重算改动附近（画陆地、画海、放岛、堆山、撤销）与整个重算逐位相同`, () => {
      const eng = make();
      const w = eng.world;
      const { mesh } = w;
      // 缓存里先放这个世界现在的结果（别的测试留下的缓存与它无关）
      seafloor(w, new Float32Array(mesh.n));
      // 与整个重算（不读缓存）逐位相同；path：这一步海底应走的路（partial：只重算改动附近，reused：照用上一次的结果）
      let last = { ...seafloorStats };
      const check = (what: string, path?: 'partial' | 'reused') => {
        const got = w.derived.elevation;
        const now = { ...seafloorStats };
        if (path === 'partial') {
          expect(now.partial, what).toBeGreaterThan(last.partial);
          expect(now.computed, what).toBe(last.computed);
        }
        if (path === 'reused') {
          expect(now.reused, what).toBeGreaterThan(last.reused);
          expect(now.partial + now.computed, what).toBe(last.partial + last.computed);
        }
        seafloorStats.on = false;
        try {
          const fresh = new Float32Array(mesh.n).fill(Number.NaN);
          seafloor(w, fresh);
          let bad = 0;
          for (let i = 0; i < mesh.n; i++) if (!w.causes.land[i] && !Object.is(got[i], fresh[i])) bad++;
          expect(bad, what).toBe(0);
        } finally {
          seafloorStats.on = true;
          last = { ...seafloorStats };
        }
      };
      // 沿海随机几处画陆地、画海（确定的伪随机）
      let r = 12345;
      const rand = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 2 ** 32);
      const coastal = () => {
        const out: number[] = [];
        for (let i = 0; i < mesh.n; i++) {
          if (w.causes.land[i]) continue;
          for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (w.causes.land[mesh.adj[e]]) {
            out.push(i);
            break;
          }
        }
        return out;
      };
      const disc = (c: number, rad: number) => [...Array(mesh.n).keys()].filter((i) => Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < mesh.spacing * rad);
      const p0 = seafloorStats.partial;
      for (let step = 0; step < 4; step++) {
        const list = coastal();
        const c = list[Math.floor(rand() * list.length)];
        const cells = disc(c, 2.5);
        eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0.3), mode: step % 2 ? 'sea' : 'land' });
        check(`第 ${step + 1} 笔`, 'partial');
      }
      // 远洋里放一个岛（离岸最远的海格）
      const far = seaDistance(w);
      let o = -1;
      for (let i = 0; i < mesh.n; i++) if (!w.causes.land[i] && far[i] < Infinity && (o < 0 || far[i] > far[o])) o = i;
      eng.exec({ op: 'add_island', island: { x: mesh.x[o], y: mesh.y[o], kind: 'continental', size: 300, variant: 0 } });
      check('放岛', 'partial');
      // 岛的岸边再画一笔陆地（岛变大：岛上所有岸边海格的陆块大小都变）、再画一笔海（岛变小，可能断成两块）
      const isleCoast = coastal().filter((i) => Math.hypot(mesh.x[i] - mesh.x[o], mesh.y[i] - mesh.y[o]) < 0.3);
      if (isleCoast.length) {
        const grow = disc(isleCoast[0], 1.5);
        eng.exec({ op: 'paint_land', cells: grow, t: grow.map(() => 0), mode: 'land' });
        check('岛的岸边画陆地', 'partial');
        const cut = disc(o, 1.2).filter((i) => w.causes.land[i]);
        if (cut.length) {
          eng.exec({ op: 'paint_land', cells: cut, t: cut.map(() => 0), mode: 'sea' });
          check('岛上画海', 'partial');
        }
      }
      // 远洋里画一个岛
      const sea = [...Array(mesh.n).keys()].filter((i) => !w.causes.land[i]);
      const o2 = sea[Math.floor(rand() * sea.length)];
      const isle = disc(o2, 1.5);
      eng.exec({ op: 'paint_land', cells: isle, t: isle.map(() => 0), mode: 'land' });
      check('远洋画的岛', 'partial');
      // 内陆堆山（挨着海的陆格的抬升不变）：照用上一次的结果
      const toSea = graphDistance(mesh, sea, Infinity);
      const inland = [...Array(mesh.n).keys()].filter((i) => w.causes.land[i] && toSea[i] > mesh.spacing * 4);
      if (inland.length) {
        const hillIn = disc(inland[Math.floor(inland.length / 2)], 1.2).filter((i) => w.causes.land[i] && toSea[i] > mesh.spacing * 2.5);
        eng.exec({ op: 'paint_relief', cells: hillIn, t: hillIn.map(() => 0), strength: 1 });
        check('内陆堆山', 'reused');
      }
      // 海岸上堆山（只改抬升）
      const hill = coastal().slice(0, 1).flatMap((c) => disc(c, 3)).filter((i) => w.causes.land[i]);
      if (hill.length) {
        eng.exec({ op: 'paint_relief', cells: hill, t: hill.map(() => 0), strength: 1 });
        check('海岸上堆山');
      }
      eng.undo();
      check('撤销');
      eng.undo();
      check('再撤销');
      eng.redo();
      check('重做');
      expect(seafloorStats.partial).toBeGreaterThan(p0);
    });
  }

  for (const [label, make] of [
    ['一块地区', () => continents()],
    ['整个星球', planet],
  ] as const) {
    it(`${label}：离洋壳的格数只重算陆海变了的格附近，与整个重算逐值相同`, () => {
      const w = make().world;
      const { mesh, causes } = w;
      const fields = seabedFields(w);
      expect(fields).not.toBeNull();
      const land0 = causes.land.slice();
      // 岸边（离洋壳近的地方）画陆地、画海：离洋壳的格数会变
      const toOcean0 = oceanSteps(w, fields, 3, undefined, null);
      const shore: number[] = [];
      for (let i = 0; i < mesh.n; i++) {
        if (land0[i] || toOcean0[i] < 0 || toOcean0[i] > 1) continue;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (land0[mesh.adj[e]]) {
          shore.push(i);
          break;
        }
      }
      expect(shore.length).toBeGreaterThan(10);
      let changedSome = false;
      try {
        for (const steps of [3, 8]) {
          for (let k = 0; k < 12; k++) {
            causes.land.set(land0);
            const base = oceanSteps(w, fields, steps, undefined, null);
            const c = shore[Math.floor(((k * 7 + steps) / 61) * shore.length) % shore.length];
            const flips: number[] = [];
            for (let i = 0; i < mesh.n; i++) {
              if (Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) >= mesh.spacing * (1.5 + (k % 3))) continue;
              const v = k % 2 ? 0 : 1;
              if (causes.land[i] !== v) {
                causes.land[i] = v;
                flips.push(i);
              }
            }
            const inc = oceanSteps(w, fields, steps, { toOcean: base } as never, flips);
            const ref = oceanSteps(w, fields, steps, undefined, null);
            expect(digest(inc), `${steps} ${k}`).toBe(digest(ref));
            if (digest(ref) !== digest(base)) changedSome = true;
          }
        }
      } finally {
        causes.land.set(land0);
      }
      expect(changedSome).toBe(true);
    });
  }

  it('画的海：按离岸距离变深，宽的海中间是海盆；洋壳上画的岛只有窄窄的岛架', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh, causes } = w;
    // 陆地中央画一大片海
    const far = graphDistance(
      mesh,
      [...Array(mesh.n).keys()].filter((i) => !causes.land[i]),
      Infinity,
    );
    let center = -1;
    for (let i = 0; i < mesh.n; i++) if (causes.land[i] && (center < 0 || far[i] > far[center])) center = i;
    const r = Math.min(far[center] * 0.8, 0.12);
    const cells: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      const d = Math.hypot(mesh.x[i] - mesh.x[center], mesh.y[i] - mesh.y[center]);
      if (d < r) {
        cells.push(i);
        t.push(d / r);
      }
    }
    eng.exec({ op: 'paint_land', cells, t, mode: 'sea' });
    expect(causes.land[center]).toBe(0);
    const dist = seaDistance(w);
    const painted = cells.filter((i) => !causes.land[i]);
    const nearShore = painted.filter((i) => dist[i] <= mesh.spacing * w.kmPerUnit).map((i) => w.derived.elevation[i]);
    expect(quantile(nearShore, 0.5)).toBeGreaterThan(-90);
    const deepest = Math.min(...painted.map((i) => w.derived.elevation[i]));
    expect(deepest).toBeLessThan(quantile(nearShore, 0.5) - 100);
    // 越往里越深（按离岸距离分两半比）
    const mid = quantile(painted.map((i) => dist[i]), 0.5);
    const inner = painted.filter((i) => dist[i] > mid).map((i) => w.derived.elevation[i]);
    const outer = painted.filter((i) => dist[i] <= mid).map((i) => w.derived.elevation[i]);
    expect(quantile(inner, 0.5)).toBeLessThan(quantile(outer, 0.5));

    // 远洋里画一个小岛：岸边一圈很快变深（岛架窄）
    const dist0 = seaDistance(w);
    let open = -1;
    for (let i = 0; i < mesh.n; i++) if (!causes.land[i] && dist0[i] > 900 && dist0[i] < Infinity && (open < 0 || dist0[i] > dist0[open])) open = i;
    expect(open).toBeGreaterThanOrEqual(0);
    const isle: number[] = [];
    for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - mesh.x[open], mesh.y[i] - mesh.y[open]) < mesh.spacing * 1.6) isle.push(i);
    eng.exec({ op: 'paint_land', cells: isle, t: isle.map(() => 0), mode: 'land' });
    expect(causes.land[open]).toBe(1);
    const d2 = seaDistance(w);
    const ring2 = [];
    for (let i = 0; i < mesh.n; i++) {
      if (causes.land[i]) continue;
      const near = Math.hypot(mesh.x[i] - mesh.x[open], mesh.y[i] - mesh.y[open]) < mesh.spacing * 5;
      if (near && d2[i] > mesh.spacing * w.kmPerUnit * 1.2) ring2.push(w.derived.elevation[i]);
    }
    expect(ring2.length).toBeGreaterThan(0);
    expect(quantile(ring2, 0.5)).toBeLessThan(-1500);
  });
});

describe('湖底', () => {
  // 内陆一块低平的地方
  function inlandLow(w: World): number {
    const { mesh, causes } = w;
    const far = graphDistance(
      mesh,
      // 离海、离自然的湖与干湖底都远（第三十二轮：内陆的低处多半是洼地，本来就有湖）
      [...Array(mesh.n).keys()].filter((i) => !causes.land[i] || w.derived.lake[i] !== 0),
      Infinity,
    );
    // 离图边也远（贴着图边的洼地会从图边流走，成不了湖）
    const edge = graphDistance(
      mesh,
      [...Array(mesh.n).keys()].filter((i) => mesh.boundary[i]),
      Infinity,
    );
    let best = -1;
    for (let i = 0; i < mesh.n; i++) {
      if (!causes.land[i] || far[i] < mesh.spacing * 6 || edge[i] < mesh.spacing * 6) continue;
      if (best < 0 || w.derived.elevation[i] < w.derived.elevation[best]) best = i;
    }
    return best;
  }

  it('放的湖：岸边浅滩、往里陡落、最深处就是给的深度；很深的湖湖底在海平面以下', () => {
    const eng = continents();
    const w = eng.world;
    const cell = inlandLow(w);
    const radius = w.mesh.spacing * w.kmPerUnit * 3.2;
    eng.exec({ op: 'add_lake', lake: { cell, radius, depth: 300, perennial: true } });
    const d = w.derived;
    const area = lakeArea(w, cell, radius);
    expect(area.length).toBeGreaterThan(10);
    const depth = (i: number) => d.water[i] - d.elevation[i];
    const max = Math.max(...area.map(depth));
    // 湖面 = 溢出口，最深处 = 溢出口以下 1 m + 300 m
    expect(max).toBeGreaterThan(295);
    expect(max).toBeLessThan(310);
    // 岸边一圈（离湖心 80% 以外）很浅，中间（30% 以内）很深
    const rU = radius / w.kmPerUnit;
    const dist = graphDistance(w.mesh, [cell], rU);
    const edge = area.filter((i) => dist[i] > 0.8 * rU).map(depth);
    const core = area.filter((i) => dist[i] < 0.3 * rU).map(depth);
    expect(quantile(edge, 0.5)).toBeLessThan(0.2 * 300);
    expect(Math.min(...core)).toBeGreaterThan(0.75 * 300);

    // 很深的湖：湖底在海平面以下（像死海、贝加尔湖）
    eng.exec({ op: 'remove_lake', id: w.small.lakes[0].id });
    eng.exec({ op: 'add_lake', lake: { cell, radius, depth: 1800, perennial: true } });
    const bottom = Math.min(...area.map((i) => w.derived.elevation[i]));
    expect(bottom).toBeLessThan(0);
    expect(w.derived.lake[cell]).toBe(1);
    // 导出的高度图：湖最深处的像素在海平面的灰度以下
    const width = 512;
    const height = 256;
    const { zip } = exportPackage(w, eng.toDoc(), { width, height, seaLevelGray: 95, maxElevation: 6000 });
    const bmp = unzipSync(zip)['heightmap.bmp'];
    const offset = new DataView(bmp.buffer, bmp.byteOffset).getUint32(10, true);
    const row = Math.ceil(width / 4) * 4;
    let low = area[0];
    for (const i of area) if (w.derived.elevation[i] < w.derived.elevation[low]) low = i;
    expect(w.derived.elevation[low]).toBeLessThan(-200);
    const px = Math.floor((w.mesh.x[low] / w.mesh.width) * width);
    const py = Math.floor((w.mesh.y[low] / w.mesh.height) * height);
    const gray = bmp[offset + (height - 1 - py) * row + px];
    expect(gray).toBeLessThan(95);
  });

  it('自然的湖：岸边浅、中间深，最深处随面积', () => {
    const w = snapshot('seabed:natural-lake', () => {
      const eng = engineFor({ seed: 1, cells: 12000 });
      eng.exec({ op: 'set_worldgen', params: { seed: 1, type: 'continents' }, reset: true });
      return eng;
    }).world;
    const d = w.derived;
    const lakes: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && d.lake[i] === 1) lakes.push(i);
    expect(lakes.length).toBeGreaterThan(0);
    for (const i of lakes) expect(d.water[i] - d.elevation[i]).toBeGreaterThan(0.4);
    // 挨着岸的湖格比湖里面的浅
    const shore = (i: number) => {
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) if (d.lake[w.mesh.adj[e]] !== 1) return true;
      return false;
    };
    const inner = lakes.filter((i) => !shore(i));
    if (inner.length) {
      const depth = (i: number) => d.water[i] - d.elevation[i];
      expect(quantile(inner.map(depth), 0.5)).toBeGreaterThan(quantile(lakes.filter(shore).map(depth), 0.5));
    }
    // 3 格约 4 万 km² 的湖：最深处约 12 × 面积^0.3 ≈ 290 m
    expect(Math.max(...lakes.map((i) => d.water[i] - d.elevation[i]))).toBeGreaterThan(100);
  });
});
