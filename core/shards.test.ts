import { describe, expect, it } from 'vitest';
import { cellLayers, editGhost, ghostLayers } from '../src/render/colors';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { type DisplayCell, displayCellAt, displayCoast } from './display';
import { Engine } from './engine';
import { ISLET_FRAG } from './features';
import { brushCells } from './select';
import { fragLand, rasterizeWorld } from './subcell';
import { worldRivers } from './river-pack';
import { chainFragAt, chainIslands, crackAt, crackBlockSize, crackHalfWidth, crackSeed, fragmentStroke, islandStamp } from './terrain';
import { previewWorldOf } from './preview-world';
import { continents } from './testing/fixtures';
import type { World } from './world';

// 第十八轮：破碎地形——打碎笔刷（裂成碎块 / 只打碎海岸）、碎岛（比一格小、只是画出来的，格还是海）、岛链里的碎岛

// 离 x 最近的一格海岸陆地（挨着海的陆地格）
function coastCell(w: World, x: number, y: number): number {
  const { mesh, causes } = w;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || mesh.boundary[i]) continue;
    let coast = false;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) coast = true;
    if (!coast) continue;
    const d = Math.hypot(mesh.x[i] - x, mesh.y[i] - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// 离陆地至少 k 格的海格（离 (x, y) 最近的）
function openSea(w: World, x: number, y: number, k: number): number {
  const { mesh, causes } = w;
  const dist = new Int32Array(mesh.n).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i]) {
      dist[i] = 0;
      q.push(i);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (dist[j] < 0) {
        dist[j] = dist[c] + 1;
        q.push(j);
      }
    }
  }
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < mesh.n; i++) {
    if (dist[i] < k || mesh.boundary[i]) continue;
    const d = Math.hypot(mesh.x[i] - x, mesh.y[i] - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

const cellKm = (w: World) => w.mesh.spacing * w.kmPerUnit;

// 一块的栅格：只看 [x0, x1] × [y0, y1]，像素约 px 个一格
function rasterBox(w: World, cx: number, cy: number, half: number, perCell = 10) {
  const { mesh } = w;
  const scale = perCell / mesh.spacing;
  const W = Math.round(mesh.width * scale);
  const H = Math.round(mesh.height * scale);
  const r = rasterizeWorld(w, W, H);
  const x0 = Math.max(0, Math.floor((cx - half) * scale));
  const x1 = Math.min(W, Math.ceil((cx + half) * scale));
  const y0 = Math.max(0, Math.floor((cy - half) * scale));
  const y1 = Math.min(H, Math.ceil((cy + half) * scale));
  return { r, W, H, x0, x1, y0, y1, scale };
}

describe('破碎度为 0 时与以前逐位相同', () => {
  it('全是 0 的破碎度数组：导出的陆海、高程、格与屏幕上点到的格都与没有这个数组时逐位相同', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const a = rasterizeWorld(w, 320, 200);
    const samples: DisplayCell[] = [];
    for (let k = 0; k < 400; k++) samples.push(displayCellAt(w, ((k * 0.6180339887) % 1) * w.mesh.width, ((k * 0.7548776662) % 1) * w.mesh.height));
    w.causes.fragment = new Uint8Array(w.mesh.n);
    const b = rasterizeWorld(w, 320, 200);
    expect(Buffer.from(b.land.buffer).equals(Buffer.from(a.land.buffer))).toBe(true);
    expect(Buffer.from(b.elevation.buffer).equals(Buffer.from(a.elevation.buffer))).toBe(true);
    expect(Buffer.from(b.cell.buffer).equals(Buffer.from(a.cell.buffer))).toBe(true);
    for (let k = 0; k < 400; k++) expect(displayCellAt(w, ((k * 0.6180339887) % 1) * w.mesh.width, ((k * 0.7548776662) % 1) * w.mesh.height)).toEqual(samples[k]);
    expect(displayCoast(w).frag).toBeNull();
  });

  it('打碎之后撤销：破碎度的数组去掉，世界与打碎之前逐值相同', () => {
    const eng = continents();
    const before = digestWorld(eng.world);
    const c = coastCell(eng.world, 0.8, 0.5);
    const b = brushCells(eng.world, eng.world.mesh.x[c], eng.world.mesh.y[c], cellKm(eng.world) * 5);
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.6, mode: 'coast', size: cellKm(eng.world) * 5 });
    expect(eng.world.causes.fragment).toBeDefined();
    eng.undo();
    expect(eng.world.causes.fragment).toBeUndefined();
    expect(digestWorld(eng.world)).toEqual(before);
  });
});

describe('打碎笔刷', () => {
  it('裂成碎块：裂缝上的陆地变成真的海（至少一格宽，隔开碎块），力度越大陆地剩得越少', () => {
    const base = continents();
    const w0 = base.world;
    const c = coastCell(w0, 0.9, 0.55);
    const rKm = cellKm(w0) * 10;
    const b = brushCells(w0, w0.mesh.x[c], w0.mesh.y[c], rKm);
    const land0 = b.cells.filter((i) => w0.causes.land[i]).length;
    let prev = land0;
    for (const s of [0.2, 0.6, 1]) {
      const eng = base.clone();
      const w = eng.world;
      const r = fragmentStroke(w, b.cells, b.t, s, 'blocks', rKm);
      expect(r.cracked.length, `力度 ${s}`).toBeGreaterThan(5);
      eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: s, mode: 'blocks', size: rKm });
      const land = b.cells.filter((i) => w.causes.land[i]).length;
      expect(land, `力度 ${s}`).toBeLessThan(prev);
      prev = land;
      // 裂开的格大多真的成了海（个别围住的小块按老规矩并回陆地、挖成湖）
      const sea = r.cracked.filter((i) => !w.causes.land[i]).length;
      expect(sea).toBeGreaterThan(r.cracked.length * 0.8);
      // 中间（0.6 倍半径以内）：挨着的两格陆地（都不在裂缝上）在同一个碎块里——裂缝至少一格宽，隔开了碎块
      const B = crackBlockSize(w, rKm, s);
      const W = crackHalfWidth(w, s);
      const seed = crackSeed(w);
      const core = new Map<number, number>();
      b.cells.forEach((i, k) => {
        if (b.t[k] > 0.6 || !w.causes.land[i]) return;
        const a = crackAt(w, i, B, seed);
        if (a.d >= W) core.set(i, a.block);
      });
      let pairs = 0;
      for (const [i, blk] of core) {
        for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) {
          const j = w.mesh.adj[e];
          const bj = core.get(j);
          if (bj === undefined) continue;
          pairs++;
          expect(bj, `${i} 与 ${j} 隔着裂缝却连着`).toBe(blk);
        }
      }
      expect(pairs).toBeGreaterThan(0);
      // 破碎度抬高了；圈里原来的海不碰
      const f = w.causes.fragment!;
      expect(b.cells.some((i) => f[i] > 0)).toBe(true);
      for (const i of b.cells) if (!w0.causes.land[i]) expect(f[i]).toBe(0);
    }
    expect(prev).toBeLessThan(land0 * 0.85);
  });

  it('只打碎海岸：陆海一格不变，只有离海岸两格以内的破碎度抬高，画出碎岛', () => {
    const eng = continents();
    const w = eng.world;
    const land0 = w.causes.land.slice();
    const c = coastCell(w, 0.9, 0.55);
    const rKm = cellKm(w) * 8;
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], rKm);
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 1, mode: 'coast', size: rKm });
    expect(Buffer.from(w.causes.land.buffer).equals(Buffer.from(land0.buffer))).toBe(true);
    const f = w.causes.fragment!;
    // 离海岸几步
    const { mesh } = w;
    const step = new Int32Array(mesh.n).fill(-1);
    const q: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (land0[mesh.adj[e]] !== land0[i]) {
          step[i] = 0;
          q.push(i);
          break;
        }
      }
    }
    for (let h = 0; h < q.length; h++) {
      for (let e = mesh.off[q[h]]; e < mesh.off[q[h] + 1]; e++) {
        const j = mesh.adj[e];
        if (step[j] < 0) {
          step[j] = step[q[h]] + 1;
          q.push(j);
        }
      }
    }
    let coast = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (f[i]) expect(step[i], `格 ${i}`).toBeLessThanOrEqual(2);
      if (step[i] === 0 && b.t[b.cells.indexOf(i)] <= 0.5 && b.cells.includes(i)) {
        expect(f[i]).toBeGreaterThan(0);
        coast++;
      }
    }
    expect(coast).toBeGreaterThan(5);
    // 画出来：海格里有陆地像素（碎岛）
    const box = rasterBox(w, w.mesh.x[c], w.mesh.y[c], (rKm / w.kmPerUnit) * 1.1);
    let isles = 0;
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) if (box.r.land[y * box.W + x] && !w.causes.land[box.r.cell[y * box.W + x]]) isles++;
    expect(isles).toBeGreaterThan(50);
  });

  it('恢复原样清掉破碎度和裂开的海；画陆地 / 海画过的地方破碎度清零', () => {
    const eng = continents();
    const w = eng.world;
    const c = coastCell(w, 0.9, 0.55);
    const rKm = cellKm(w) * 8;
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], rKm);
    const before = { land: w.causes.land.slice(), landDelta: w.causes.landDelta.slice() };
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.7, mode: 'blocks', size: rKm });
    expect(b.cells.some((i) => w.causes.fragment![i] > 0)).toBe(true);
    // 恢复原样：用大一圈的画笔擦（中间七成全收回）
    const big = brushCells(w, w.mesh.x[c], w.mesh.y[c], rKm * 1.6);
    eng.exec({ op: 'restore_terrain', cells: big.cells, t: big.t });
    expect(w.causes.fragment!.every((v) => v === 0)).toBe(true);
    // 陆海、陆地的改动都回到打碎之前（省份按陆海的变化修补过，编号可能不同）
    expect(Buffer.from(w.causes.land.buffer).equals(Buffer.from(before.land.buffer))).toBe(true);
    expect(Buffer.from(w.causes.landDelta.buffer).equals(Buffer.from(before.landDelta.buffer))).toBe(true);
    // 画陆地：画笔中心破碎度清零
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.7, mode: 'coast', size: rKm });
    const core = b.cells.filter((_, k) => b.t[k] <= 0.7);
    expect(core.some((i) => w.causes.fragment![i] > 0)).toBe(true);
    eng.exec({ op: 'paint_land', cells: b.cells, t: b.t, mode: 'sea' });
    for (const i of core) expect(w.causes.fragment![i]).toBe(0);
  });
});

describe('碎岛', () => {
  it('放下去格还是海，画出一片比一格小的碎岛；屏幕（CPU）、悬停、导出都归那一格的海省', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const s0 = openSea(w, 1.0, 0.45, 7);
    const land0 = w.causes.land.slice();
    const x = w.mesh.x[s0];
    const y = w.mesh.y[s0];
    eng.exec({ op: 'add_island', island: { x, y, kind: 'shards', size: cellKm(w) * 2, variant: 3 } });
    expect(Buffer.from(w.causes.land.buffer).equals(Buffer.from(land0.buffer))).toBe(true);
    const f = w.causes.fragment!;
    expect(f[s0]).toBeGreaterThan(0);
    const half = w.mesh.spacing * 3;
    const box = rasterBox(w, x, y, half, 12);
    let isle = 0;
    let all = 0;
    const comp = new Int32Array(box.W * box.H).fill(-1);
    const sizes: number[] = [];
    for (let py = box.y0; py < box.y1; py++) {
      for (let px = box.x0; px < box.x1; px++) {
        const p = py * box.W + px;
        all++;
        if (!box.r.land[p]) continue;
        const cell = box.r.cell[p];
        expect(w.causes.land[cell]).toBe(0);
        expect(f[cell]).toBeGreaterThan(0);
        // 导出：碎岛的像素归它所在的那一格（海省）
        const prov = w.causes.province[cell];
        expect(w.small.provinces[prov]?.land).toBe(false);
        isle++;
        // 连成一片的碎岛有多大
        if (comp[p] >= 0) continue;
        const id = sizes.length;
        let n = 0;
        const stack = [p];
        comp[p] = id;
        while (stack.length) {
          const q = stack.pop()!;
          n++;
          const qx = q % box.W;
          const qy = (q - qx) / box.W;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = qx + dx;
            const ny = qy + dy;
            if (nx < box.x0 || nx >= box.x1 || ny < box.y0 || ny >= box.y1) continue;
            const r = ny * box.W + nx;
            if (comp[r] < 0 && box.r.land[r]) {
              comp[r] = id;
              stack.push(r);
            }
          }
        }
        sizes.push(n);
      }
    }
    // 画出来的陆地像素：不多不少（一两成到一半）
    expect(isle / all).toBeGreaterThan(0.04);
    expect(isle / all).toBeLessThan(0.5);
    // 一颗颗比一格小：一格约 12 × 12 像素（按面积约 0.87 · 144），多数碎岛不到一格
    sizes.sort((a, b) => a - b);
    expect(sizes.length).toBeGreaterThan(3);
    expect(sizes[Math.floor(sizes.length / 2)]).toBeLessThan(144 * 0.8);
    // 屏幕（与着色器同一套规则的 CPU 版本）：碎岛的点就是那一格，省份是那一格（海省）
    let seen = 0;
    for (let k = 0; k < 600; k++) {
      const px = x + (((k * 0.6180339887) % 1) * 2 - 1) * half;
      const py = y + (((k * 0.7548776662) % 1) * 2 - 1) * half;
      const d = displayCellAt(w, px, py, s0);
      if (!d.land || w.causes.land[d.cell]) continue;
      seen++;
      // 那一格破碎时就是它；在一片碎岛的边上（扭曲后取到旁边不碎的海格）时是挨着的破碎的海格
      if (f[d.cell]) {
        expect(d.here).toBe(d.cell);
        expect(d.province).toBe(d.cell);
      }
      for (const c of [d.here, d.province]) {
        expect(w.causes.land[c]).toBe(0);
        expect(f[c]).toBeGreaterThan(0);
      }
      expect(w.small.provinces[w.causes.province[d.province]]?.land).toBe(false);
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('一片碎岛起一个列岛 / 群岛的名字，能改名、删名；挨着的碎岛并在一起', () => {
    const eng = continents();
    const w = eng.world;
    const s0 = openSea(w, 1.0, 0.45, 6);
    const x = w.mesh.x[s0];
    const y = w.mesh.y[s0];
    eng.exec({ op: 'add_island', island: { x, y, kind: 'shards', size: cellKm(w) * 2, variant: 0 } });
    const isleCells = () => [...w.causes.fragment!.keys()].filter((i) => !w.causes.land[i] && w.causes.fragment![i] >= ISLET_FRAG);
    const named = () => eng.world.derived.features.filter((f) => f.type === 'archipelago' && f.cells.includes(s0));
    expect(isleCells().length).toBeGreaterThanOrEqual(3);
    expect(named().length).toBe(1);
    const a = named()[0];
    expect(a.name).toMatch(/群岛|列岛/);
    // 旁边再放一片：并进同一个名字（锚点、名字不变）
    eng.exec({ op: 'add_island', island: { x: x + w.mesh.spacing * 3, y, kind: 'shards', size: cellKm(w) * 1.5, variant: 1 } });
    expect(named().length).toBe(1);
    // 名字跟着地方走（锚点可能换了一格，名字照旧）
    const b = named()[0];
    expect(b.name).toBe(a.name);
    expect(b.cells.length).toBeGreaterThan(a.cells.length);
    eng.exec({ op: 'rename_feature', key: b.key, name: '碎玉列岛' });
    expect(named()[0].name).toBe('碎玉列岛');
    eng.exec({ op: 'rename_feature', key: b.key, hidden: true });
    expect(named()[0].hidden).toBe(true);
  });

  it('岛链里的碎岛：按编号均匀地换，100% 全是碎岛，同样的参数结果固定；比例 0 与以前相同', () => {
    const eng = continents();
    const w = eng.world;
    const s0 = openSea(w, 1.0, 0.45, 6);
    const x = w.mesh.x[s0];
    const y = w.mesh.y[s0];
    const sp = w.mesh.spacing;
    const spec = { points: [[x - 6 * sp, y] as [number, number], [x + 6 * sp, y] as [number, number]], kind: 'continental', size: cellKm(w) * 1.2, density: 1, variant: 0 };
    const plain = chainIslands(w, spec);
    expect(chainIslands(w, { ...spec, fragRatio: 0 })).toEqual(plain);
    const half = chainIslands(w, { ...spec, fragRatio: 0.5 });
    expect(half.map((s) => ({ ...s, kind: 'x' }))).toEqual(plain.map((s) => ({ ...s, kind: 'x' })));
    const shards = half.filter((s) => s.kind === 'shards').length;
    expect(shards).toBeGreaterThanOrEqual(Math.floor(plain.length / 2) - 1);
    expect(shards).toBeLessThanOrEqual(Math.ceil(plain.length / 2) + 1);
    // 按编号均匀地换：比例一半时一个隔一个（离陆地太近、去掉了的岛那里可能断开一次）
    expect([0, 1, 2, 3].map((k) => chainFragAt(k, 0.5))).toEqual([false, true, false, true]);
    let alternate = 0;
    for (let k = 1; k < half.length; k++) if ((half[k].kind === 'shards') !== (half[k - 1].kind === 'shards')) alternate++;
    expect(alternate).toBeGreaterThanOrEqual(half.length - 2);
    expect(chainIslands(w, { ...spec, fragRatio: 1 }).every((s) => s.kind === 'shards')).toBe(true);
    expect(chainIslands(w, { ...spec, fragRatio: 0.5 })).toEqual(half);
    // 种类本身是碎岛：全是碎岛
    expect(chainIslands(w, { ...spec, kind: 'shards' }).every((s) => s.kind === 'shards')).toBe(true);
    // 执行：碎岛只抬破碎度，别的岛照常长出陆地
    const land0 = w.causes.land.slice();
    eng.exec({ op: 'add_island_chain', chain: { ...spec, fragRatio: 0.5 } });
    let gained = 0;
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && !land0[i]) gained++;
    expect(gained).toBeGreaterThan(0);
    expect(w.causes.fragment!.some((v) => v > 0)).toBe(true);
  });
});

describe('重放、撤销、检查点', () => {
  it('打碎、碎岛、掺碎岛的岛链：撤销、重做、重放、检查点逐值一致', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const c = coastCell(w, 0.9, 0.55);
    const rKm = cellKm(w) * 7;
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], rKm);
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.5, mode: 'blocks', size: rKm });
    const c2 = coastCell(w, 0.4, 0.3);
    const b2 = brushCells(w, w.mesh.x[c2], w.mesh.y[c2], rKm);
    eng.exec({ op: 'fragment', cells: b2.cells, t: b2.t, strength: 0.8, mode: 'coast', size: rKm });
    const s0 = openSea(w, 1.0, 0.45, 6);
    eng.exec({ op: 'add_island', island: { x: w.mesh.x[s0], y: w.mesh.y[s0], kind: 'shards', size: cellKm(w) * 2, variant: 2 } });
    const sp = w.mesh.spacing;
    eng.exec({ op: 'add_island_chain', chain: { points: [[w.mesh.x[s0] - 5 * sp, w.mesh.y[s0] + 4 * sp], [w.mesh.x[s0] + 5 * sp, w.mesh.y[s0] + 4 * sp]], kind: 'low', size: cellKm(w), fragRatio: 0.6 } });
    const final = digestWorld(eng.world);
    const doc = eng.toDoc();
    const mesh = eng.world.mesh;
    expect(digestWorld(Engine.fromDoc(doc, mesh).world)).toEqual(final);
    const cp = structuredClone(eng.toCheckpoint());
    expect(digestWorld(Engine.fromCheckpoint(cp, doc, mesh)!.world)).toEqual(final);
    for (let k = 0; k < 4; k++) eng.undo();
    for (let k = 0; k < 4; k++) eng.redo();
    eng.update();
    expect(digestWorld(eng.world)).toEqual(final);
  });
});

describe('屏幕（CPU 版本）与导出逐像素一致', () => {
  it('有破碎度时：陆海、格、碎岛的格都与导出相同', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const c = coastCell(w, 0.9, 0.55);
    const rKm = cellKm(w) * 9;
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], rKm);
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.8, mode: 'blocks', size: rKm });
    const s0 = openSea(w, 1.0, 0.45, 5);
    eng.exec({ op: 'add_island', island: { x: w.mesh.x[s0], y: w.mesh.y[s0], kind: 'shards', size: cellKm(w) * 2.5, variant: 1 } });
    const { mesh, causes } = w;
    const W = 480;
    const H = 300;
    const raster = rasterizeWorld(w, W, H);
    let hint = 0;
    let isles = 0;
    let fragged = 0;
    const frag = causes.fragment!;
    const bad: string[] = [];
    for (let py = 0; py < H && bad.length < 6; py++) {
      const y = ((py + 0.5) / H) * mesh.height;
      for (let px = 0; px < W; px++) {
        const x = ((px + 0.5) / W) * mesh.width;
        const p = py * W + px;
        const d = displayCellAt(w, x, y, hint);
        hint = d.cell;
        if (frag[d.cell]) fragged++;
        if (d.land !== (raster.land[p] === 1)) bad.push(`${px},${py} 陆海`);
        else if ((causes.land[d.cell] === 1) === d.land && d.cell !== raster.cell[p]) bad.push(`${px},${py} 格`);
        else if ((causes.land[d.cell] === 1) !== d.land && d.here !== raster.cell[p]) bad.push(`${px},${py} 同类格`);
        if (d.land && !causes.land[raster.cell[p]]) isles++;
      }
    }
    expect(bad).toEqual([]);
    expect(fragged).toBeGreaterThan(500);
    expect(isles).toBeGreaterThan(20);
  });

  it('整个星球（小网格）：打碎、碎岛在球面上也一致', () => {
    const eng = new Engine({ cells: 2500, seed: 2, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    const w = eng.world;
    const c = coastCell(w, 1.0, 0.45);
    const rKm = cellKm(w) * 6;
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], rKm);
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.6, mode: 'blocks', size: rKm });
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.9, mode: 'coast', size: rKm });
    const { mesh, causes } = w;
    const W = 400;
    const H = 200;
    const raster = rasterizeWorld(w, W, H);
    let hint = 0;
    let fragged = 0;
    const bad: string[] = [];
    for (let py = 0; py < H && bad.length < 6; py++) {
      const y = ((py + 0.5) / H) * mesh.height;
      for (let px = 0; px < W; px++) {
        const x = ((px + 0.5) / W) * mesh.width;
        const p = py * W + px;
        const d = displayCellAt(w, x, y, hint);
        hint = d.cell;
        if (causes.fragment![d.cell]) fragged++;
        if (d.land !== (raster.land[p] === 1)) bad.push(`${px},${py} 陆海`);
        else if ((causes.land[d.cell] === 1) === d.land && d.cell !== raster.cell[p]) bad.push(`${px},${py} 格`);
        else if ((causes.land[d.cell] === 1) !== d.land && d.here !== raster.cell[p]) bad.push(`${px},${py} 同类格`);
      }
    }
    expect(bad).toEqual([]);
    expect(fragged).toBeGreaterThan(100);
  });
});

describe('预览与颜色', () => {
  it('确切预览就是结果：打碎（两种）、放碎岛、掺碎岛的岛链，预览的世界与执行后的世界逐值相同', () => {
    const eng = continents();
    const w = eng.world;
    const c = coastCell(w, 0.9, 0.55);
    const rKm = cellKm(w) * 6;
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], rKm);
    const s0 = openSea(w, 1.0, 0.45, 6);
    const sp = w.mesh.spacing;
    const cmds: Command[] = [
      { op: 'fragment', cells: b.cells, t: b.t, strength: 0.6, mode: 'blocks', size: rKm },
      { op: 'fragment', cells: b.cells, t: b.t, strength: 0.6, mode: 'coast', size: rKm },
      { op: 'add_island', island: { x: w.mesh.x[s0], y: w.mesh.y[s0], kind: 'shards', size: cellKm(w) * 1.5, variant: 4 } },
      { op: 'add_island_chain', chain: { points: [[w.mesh.x[s0] - 4 * sp, w.mesh.y[s0]], [w.mesh.x[s0] + 4 * sp, w.mesh.y[s0]]], kind: 'continental', size: cellKm(w), fragRatio: 0.5 } },
    ];
    for (const cmd of cmds) {
      const { patch } = eng.previewWorld(cmd);
      const shown = previewWorldOf(w, structuredClone(patch));
      const copy = eng.clone();
      copy.exec(cmd);
      expect(digestWorld(shown), cmd.op).toEqual(digestWorld(copy.world));
    }
  });

  it('碎岛画成陆地的颜色（不再是海色）；放碎岛时的幽灵（松手前）与结果的破碎度、颜色相同', () => {
    const eng = continents();
    const w = eng.world;
    const s0 = openSea(w, 1.0, 0.45, 6);
    const spec = { x: w.mesh.x[s0], y: w.mesh.y[s0], kind: 'shards', size: cellKm(w) * 2, variant: 0 };
    const o = { mode: 'terrain' as const, season: 'annual' as const, focusSpecies: null, borders: false };
    const base = cellLayers(w, o);
    const st = islandStamp(w, spec);
    const ghost = ghostLayers(w, base, editGhost(w, base, { cells: [], delta: [], frag: st.frag }), 'terrain');
    eng.exec({ op: 'add_island', island: spec });
    const after = cellLayers(eng.world, o);
    const { mesh } = w;
    let lonely = 0;
    for (let k = 0; k < st.frag!.cells.length; k++) {
      const i = st.frag!.cells[k];
      expect(ghost.frag![i]).toBeCloseTo(st.frag!.value[k] / 255, 6);
      expect(after.frag![i]).toBeCloseTo(st.frag!.value[k] / 255, 6);
      let landNb = false;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (w.causes.land[mesh.adj[e]]) landNb = true;
      if (landNb) continue;
      lonely++;
      const rgb = [0, 1, 2].map((c) => after.other[i * 4 + c]);
      const sea = [0, 1, 2].map((c) => after.smooth[i * 4 + c]);
      // 陆地的颜色：绿 / 黄 / 白，不是海的深蓝（海色的蓝明显多于红）
      expect(rgb).not.toEqual(sea);
      expect(rgb[0]).toBeGreaterThan(rgb[2] * 0.6);
      for (let c = 0; c < 4; c++) expect(ghost.other[i * 4 + c], `格 ${i}`).toBe(after.other[i * 4 + c]);
    }
    expect(lonely).toBeGreaterThan(3);
  });
});

// 优化检查查出的（第十八轮）：只改破碎度的一步之后，河口要重新描；引擎就地改破碎度时显示用的缓存不能拿旧的
describe('破碎度改了，河与显示的缓存跟着变', () => {
  const setup = () => {
    const e = new Engine({ seed: 3, cells: 6000 });
    e.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', landFraction: 0.4 }, reset: true });
    const { mesh } = e.world;
    const coast: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      if (!e.world.causes.land[i] || e.world.derived.lake[i] === 1 || mesh.boundary[i]) continue;
      for (let q = mesh.off[i]; q < mesh.off[i + 1]; q++)
        if (!e.world.causes.land[mesh.adj[q]]) {
          coast.push(i);
          break;
        }
    }
    coast.sort((a, b) => e.world.derived.discharge[b] - e.world.derived.discharge[a]);
    const km = mesh.spacing * e.world.kmPerUnit;
    const stroke = (c: number) => {
      const b = brushCells(e.world, mesh.x[c], mesh.y[c], 4 * km);
      e.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 1, mode: 'coast', size: 4 * km });
    };
    return { e, coast, stroke };
  };

  it('只打碎海岸之后，描出的河是新描的（不用旧的河）', () => {
    const e = new Engine({ seed: 3, cells: 6000 });
    e.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', landFraction: 0.4 }, reset: true });
    const w = e.world;
    const { mesh } = w;
    let best = -1;
    for (let i = 0; i < mesh.n; i++) {
      if (!w.causes.land[i] || w.derived.lake[i] === 1) continue;
      let coast = false;
      for (let q = mesh.off[i]; q < mesh.off[i + 1]; q++) if (!w.causes.land[mesh.adj[q]]) coast = true;
      if (coast && (best < 0 || w.derived.discharge[i] > w.derived.discharge[best])) best = i;
    }
    worldRivers(e.world);
    const km = mesh.spacing * w.kmPerUnit;
    const b = brushCells(w, mesh.x[best], mesh.y[best], 4 * km);
    e.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 1, mode: 'coast', size: 4 * km });
    const live = Array.from(worldRivers(e.world).pts);
    // 先描别的世界把缓存挤掉，再描同一个世界：就是从头描的
    worldRivers(new Engine({ seed: 9, cells: 1000 }).world);
    const fresh = Array.from(worldRivers(e.world).pts);
    expect(live).toEqual(fresh);
  });

  it('在两处打碎海岸（同一个破碎度数组）：fragLand、displayCoast、导出的栅格都按新的', () => {
    const { e, coast, stroke } = setup();
    stroke(coast[0]);
    const f1 = fragLand(e.world);
    const d1 = displayCoast(e.world).frag;
    stroke(coast[Math.floor(coast.length / 2)]);
    const again = Engine.fromDoc(e.toDoc(), e.world.mesh).world;
    expect(Array.from(fragLand(e.world)!)).toEqual(Array.from(fragLand(again)!));
    expect(Array.from(displayCoast(e.world).frag!)).toEqual(Array.from(displayCoast(again).frag!));
    expect(fragLand(e.world)).not.toBe(f1);
    expect(displayCoast(e.world).frag).not.toBe(d1);
    const a = rasterizeWorld(e.world, 200, 100);
    const b = rasterizeWorld(again, 200, 100);
    expect(Array.from(a.land)).toEqual(Array.from(b.land));
  });
});

