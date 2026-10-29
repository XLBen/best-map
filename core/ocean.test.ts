import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { seededEngine } from './testing/fixtures';

// 简化的洋流：一块副热带大陆两侧的暖流、寒流、上涌，南半球与反向自转时方向镜像，强弱滑块

const globe = { cells: 20000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 };
const latOf = (y: number) => 90 - 180 * y;
const lonOf = (x: number) => 180 * (x - 1);

// 一块 60° 宽的大陆；south = true 时放在南半球
function continent(opts: { south?: boolean; rotation?: 1 | -1; currents?: number } = {}) {
  const eng = seededEngine(globe);
  const m = eng.world.mesh;
  const cells: number[] = [];
  for (let i = 0; i < m.n; i++) {
    const la = latOf(m.y[i]) * (opts.south ? -1 : 1);
    const lo = lonOf(m.x[i]);
    if (la > 10 && la < 65 && lo > -30 && lo < 30) cells.push(i);
  }
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  if (opts.rotation === -1) eng.exec({ op: 'set_planet', patch: { rotation: -1 } });
  if (opts.currents !== undefined) eng.exec({ op: 'set_planet', patch: { currents: opts.currents } });
  return eng;
}

// 一个经纬框里（海或陆）的平均值；south：纬度取反
function box(eng: Engine, lo0: number, lo1: number, la0: number, la1: number, land: boolean, south = false) {
  const { mesh, causes, derived: d } = eng.world;
  let cs = 0;
  let sp = 0;
  let an = 0;
  let t = 0;
  let p = 0;
  let k = 0;
  for (let i = 0; i < mesh.n; i++) {
    const la = latOf(mesh.y[i]) * (south ? -1 : 1);
    const lo = lonOf(mesh.x[i]);
    if (la < la0 || la > la1 || lo < lo0 || lo > lo1 || (causes.land[i] === 1) !== land) continue;
    cs += d.currentY[i];
    sp += Math.hypot(d.currentX[i], d.currentY[i]);
    an += d.sstAnom[i];
    t += d.tMean[i];
    p += d.precip[i];
    k++;
  }
  return { south: cs / k, speed: sp / k, anom: an / k, t: t / k, p: p / k };
}

describe('洋流', () => {
  const eng = continent();
  const off = continent({ currents: 0 });

  it('大陆东岸外是向极的暖流，西岸外是向赤道的寒流', () => {
    const east = box(eng, 31, 40, 20, 35, false);
    const west = box(eng, -40, -31, 15, 35, false);
    // y 朝南：向北（向极）流是负的南分量
    expect(east.south).toBeLessThan(-0.5);
    expect(west.south).toBeGreaterThan(0);
    let median: number[] = [];
    for (let i = 0; i < eng.world.mesh.n; i++) if (!eng.world.causes.land[i]) median.push(Math.hypot(eng.world.derived.currentX[i], eng.world.derived.currentY[i]));
    median = median.sort((a, b) => a - b);
    expect(east.speed).toBeGreaterThan(2 * median[Math.floor(median.length / 2)]);
    expect(east.anom).toBeGreaterThan(1.5);
    expect(west.anom).toBeLessThan(-1);
    expect(east.t - west.t).toBeGreaterThan(3);
  });

  it('西岸低纬更凉更干，高纬的西岸比没有洋流时暖', () => {
    const wl = box(eng, -30, -24, 15, 32, true);
    const wl0 = box(off, -30, -24, 15, 32, true);
    expect(wl.p).toBeLessThan(wl0.p * 0.95);
    expect(wl.t).toBeLessThan(wl0.t);
    const hi = box(eng, -30, -22, 50, 62, true);
    const hi0 = box(off, -30, -22, 50, 62, true);
    expect(hi.t - hi0.t).toBeGreaterThan(0.8);
  });

  it('南半球、反向自转：方向镜像', () => {
    const s = continent({ south: true });
    // 南半球向极 = 向南（正的南分量）；向赤道 = 向北
    expect(box(s, 31, 40, 20, 35, false, true).south).toBeGreaterThan(0.5);
    expect(box(s, -40, -31, 15, 35, false, true).south).toBeLessThan(0);
    expect(box(s, 31, 40, 20, 35, false, true).anom).toBeGreaterThan(1.5);
    const r = continent({ rotation: -1 });
    // 反向自转：暖流在大陆西岸，寒流在东岸
    expect(box(r, -40, -31, 20, 35, false).anom).toBeGreaterThan(box(r, 31, 40, 20, 35, false).anom + 1.5);
  });

  it('洋流强弱：0 时没有洋流、没有偏离；2 时偏离加倍', () => {
    const d0 = off.world.derived;
    expect(d0.currentX.every((v) => v === 0)).toBe(true);
    expect(d0.sstAnom.every((v) => v === 0)).toBe(true);
    const strong = continent({ currents: 2 });
    const a1 = box(eng, 31, 40, 20, 35, false).anom;
    const a2 = box(strong, 31, 40, 20, 35, false).anom;
    expect(a2 / a1).toBeGreaterThan(1.8);
    expect(a2 / a1).toBeLessThan(2.2);
    expect(off.history[off.history.length - 1].summary).toBe('调整 · 洋流强弱');
  });

  it('全是海的星球：没有东西差别，海温几乎不偏离', () => {
    const aqua = seededEngine(globe);
    aqua.update();
    let mx = 0;
    for (const v of aqua.world.derived.sstAnom) mx = Math.max(mx, Math.abs(v));
    expect(mx).toBeLessThan(0.8);
  });

  it('整个星球不能南北挪、没有“地图外面”', () => {
    expect(() => eng.exec({ op: 'set_planet', patch: { latShift: 5 } })).toThrow('整个星球不能南北挪动');
    expect(() => eng.exec({ op: 'set_planet', patch: { outsideOcean: false } })).toThrow('整个星球没有');
  });
});
