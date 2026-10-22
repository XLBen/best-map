import { describe, expect, it } from 'vitest';
import { digest, digestWorld, hashArray } from '../tools/hash';
import { deflectWind, smoothPass, windDeflectPasses } from './climate';
import type { Command } from './commands';
import { Engine, docVersion } from './engine';
import { gradient } from './mesh';
import { engineFor, meshFor } from './testing/fixtures';
import { type World, worldLatitude } from './world';

// 山挡风：高山让风拐弯。为 0（旧存档里没有这一项时也按 0）与原来的算法逐值相同；
// 打开后迎风坡的风顺着山走、离山远的地方风逐位不变；星球上先偏转再乘极地衰减，洋流照旧用背景风。
// 整个星球为 0 时的逐值对照（加长的操作，较慢）、打开后两极照样几乎无风（要 2 万格才有离极点 1° 以内的格）
// 在 planet-climate.test.ts

const windOff: Command = { op: 'set_planet', patch: { terrainWind: 0 } };

describe('山挡风为 0 时与旧算法逐值相同', () => {
  it('一块地区：与 golden-hashes 同一组参考操作', () => {
    // 加山挡风之前记下的哈希（core/golden-hashes.json 里气候往后的几项），以后重录金标准时这里也不改
    const FROZEN = { tS: '57ec5622', pS: 'c9bbd67f', discharge: 'da8eb618', dominant: '418d8605', corrT: 'c928e485', province: '52404e05' };
    const eng = new Engine({ seed: 3, cells: 40000 });
    const w = eng.world;
    eng.exec(windOff);
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    eng.exec({ op: 'add_island', island: { x: 1.2, y: 0.45, kind: 'volcanic', size: 'medium', variant: 0 } });
    const d = w.derived;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && d.lake[i] !== 1);
    eng.exec({ op: 'add_constraint', constraint: { cells: land.slice(2000, 2300), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 600 } });
    expect(w.small.planet.terrainWind).toBe(0);
    expect({
      tS: hashArray(d.tS),
      pS: hashArray(d.pS),
      discharge: hashArray(d.discharge),
      dominant: hashArray(d.dominant),
      corrT: hashArray(d.corrT),
      province: hashArray(w.causes.province),
    }).toEqual(FROZEN);
  });
});

// 与 pipeline.test 里“垂直于西风的山脉”同一个世界：北纬 30°–60°，x = 0.8 处南北走向的高山
function ridge(strength: number | null): World {
  const eng = engineFor({ cells: 8000, seed: 3, latNorth: 60, latSouth: 30 });
  const { world } = eng;
  if (strength !== null) eng.exec({ op: 'set_planet', patch: { terrainWind: strength } });
  const cells: number[] = [];
  const uplift: number[] = [];
  for (let i = 0; i < world.mesh.n; i++) {
    const x = world.mesh.x[i];
    if (x > 0.3 && x < 1.7) cells.push(i);
    if (Math.abs(x - 0.8) < 0.05) uplift.push(i);
  }
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  eng.exec({ op: 'paint_relief', cells: uplift, t: uplift.map(() => 0), strength: 1.4 });
  return world;
}

describe('山挡风打开', () => {
  const off = ridge(null);
  const on = ridge(1);
  const { mesh } = off;
  const inBand = (x0: number, x1: number) => [...Array(mesh.n).keys()].filter((i) => mesh.x[i] > x0 && mesh.x[i] < x1 && mesh.y[i] > 0.3 && mesh.y[i] < 0.7);
  const mean = (cells: number[], f: (i: number) => number) => cells.reduce((s, i) => s + f(i), 0) / cells.length;

  it('南北向山脉：迎风坡的风向北拐（北半球向左），远处的风逐位不变', () => {
    const a = off.derived;
    const b = on.derived;
    const windward = inBand(0.62, 0.76);
    // 风的南分量变小 = 往北拐
    expect(mean(windward, (i) => b.windSY[i] - a.windSY[i])).toBeLessThan(-0.08);
    const turn = (i: number) => {
      const t = Math.atan2(b.windSY[i], b.windSX[i]) - Math.atan2(a.windSY[i], a.windSX[i]);
      return (Math.abs(Math.atan2(Math.sin(t), Math.cos(t))) * 180) / Math.PI;
    };
    expect(mean(windward, turn)).toBeGreaterThanOrEqual(10);
    // 离山 300 km 以外的西边：变化不到 0.02，实际上逐位相同
    const far = inBand(0.35, 0.45);
    expect(mean(far, (i) => Math.hypot(b.windSX[i] - a.windSX[i], b.windSY[i] - a.windSY[i]))).toBeLessThan(0.02);
    for (const k of ['windSX', 'windSY', 'windWX', 'windWY'] as const) expect(digest(b[k].filter((_, i) => far.includes(i))), k).toBe(digest(a[k].filter((_, i) => far.includes(i))));
  });

  it('雨影照旧：背风侧比迎风侧干', () => {
    const p = (cells: number[]) => mean(cells, (i) => on.derived.precip[i]);
    expect(p(inBand(0.88, 1.05))).toBeLessThan(p(inBand(0.55, 0.72)) * 0.7);
  });

  it('海陆、高程不变：山挡风只改风和往后的气候', () => {
    for (const k of ['elevation', 'slope'] as const) expect(digest(on.derived[k]), k).toBe(digest(off.derived[k]));
    expect(digest(on.causes.land)).toBe(digest(off.causes.land));
  });

  it('只平滑变化量：与整张图逐遍扩散逐位相同（只算山附近的格不丢东西，远处正好是 0）', () => {
    // 与 planeTerrain 里同样的平滑高程与梯度
    const { kmPerUnit } = off;
    const n = mesh.n;
    const lat = Float64Array.from({ length: n }, (_, i) => worldLatitude(off, mesh.y[i]));
    let hPos = Float64Array.from({ length: n }, (_, i) => (off.causes.land[i] ? Math.max(0, off.derived.elevation[i]) : 0));
    let tmp = new Float64Array(n);
    for (let it = Math.max(1, Math.round((200 / kmPerUnit / mesh.spacing) ** 2 / 2)); it > 0; it--) {
      smoothPass(mesh, hPos, tmp);
      [hPos, tmp] = [tmp, hPos];
    }
    const hx = new Float64Array(n);
    const hy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const [gx, gy] = gradient(mesh, hPos, i);
      hx[i] = gx / kmPerUnit;
      hy[i] = gy / kmPerUnit;
    }
    const d = off.derived;
    const delta = (passes: number) => deflectWind(mesh, lat, hPos, hx, hy, 1, 1, passes, [[d.windSX, d.windSY], [d.windWX, d.windWY]]);
    // 不平滑（0 遍）就是逐格的变化量；之后每一遍都用 smoothPass 在整张图上扩散，作为参照
    const want = delta(0).map((pair) => pair.map((a) => a.slice()));
    for (let p = 1; p <= 6; p++) {
      const got = delta(p);
      let zero = 0;
      for (let s = 0; s < 2; s++) {
        for (let c = 0; c < 2; c++) {
          const next = new Float64Array(n);
          smoothPass(mesh, want[s][c], next);
          want[s][c] = next;
          expect(digest(got[s][c]), `${p} 遍`).toBe(digest(next));
          for (let i = 0; i < n; i++) if (got[s][c][i] === 0) zero++;
        }
      }
      // 确实有变化，离山远的格也确实一点没动
      expect(zero).toBeGreaterThan(n);
      expect(zero).toBeLessThan(4 * n - 200);
    }
    // 平滑约 150 km：格稀时至少 1 遍，1500 km 宽的群岛图（约 5.8 km 一格）封顶 48 遍
    expect([windDeflectPasses(300), windDeflectPasses(68.8), windDeflectPasses(5.8)]).toEqual([1, 2, 48]);
  });
});

describe('整个星球打开山挡风', () => {
  const settings = { cells: 6000, seed: 2, globe: true, aspect: 2, latNorth: 90, latSouth: -90 };
  const run = (strength: number | null) => {
    const eng = engineFor(settings);
    if (strength !== null) eng.exec({ op: 'set_planet', patch: { terrainWind: strength } });
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    return eng.world;
  };
  const off = run(null);
  const on = run(1);

  it('风确实拐了', () => {
    const { mesh } = on;
    const d = on.derived;
    let changed = 0;
    for (let i = 0; i < mesh.n; i++) if (d.windSX[i] !== off.derived.windSX[i] || d.windSY[i] !== off.derived.windSY[i]) changed++;
    expect(changed).toBeGreaterThan(mesh.n * 0.02);
  });

  it('洋流照旧用背景风：洋流、海上的海温偏离逐位不变，陆上的气候跟着新的风变', () => {
    const a = off.derived;
    const b = on.derived;
    expect(digest(b.currentX)).toBe(digest(a.currentX));
    expect(digest(b.currentY)).toBe(digest(a.currentY));
    const sea = [...Array(on.mesh.n).keys()].filter((i) => !on.causes.land[i]);
    expect(digest(Float32Array.from(sea, (i) => b.sstAnom[i]))).toBe(digest(Float32Array.from(sea, (i) => a.sstAnom[i])));
    expect(digest(b.precip)).not.toBe(digest(a.precip));
  });
});

describe('旧存档与文档版本', () => {
  it('设了山挡风的文档存成版本 4（batch 里的也算）；没设过的照旧是 2、3', () => {
    const on: Command = { op: 'set_planet', patch: { terrainWind: 1 } };
    expect(docVersion({ globe: false }, [on])).toBe(4);
    expect(docVersion({ globe: true }, [{ op: 'batch', label: '一组', commands: [{ op: 'set_planet', patch: { humidity: 1.2 } }, on] }])).toBe(4);
    expect(docVersion({ globe: false }, [{ op: 'set_planet', patch: { currents: 1 } }])).toBe(2);
    expect(docVersion({ globe: true }, [{ op: 'set_planet', patch: { currents: 1 } }])).toBe(3);
  });

  it('打开没设过的旧存档：照原样重放；末尾补一步“打开”，可撤销，存回去再打开就不再缺', () => {
    const settings = { cells: 3000, seed: 2 };
    const old = engineFor(settings);
    old.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    old.exec({ op: 'generate_provinces', rules: { seed: 2 } });
    const doc = old.toDoc();
    expect(doc.version).toBe(2);
    const mesh = meshFor(settings);
    const eng = Engine.fromDoc(doc, mesh);
    const replayed = digestWorld(eng.world);
    expect(replayed).toEqual(digestWorld(old.world));
    // 界面据此判断要不要补（src/state.ts 的 loadDoc）：重放完没有这一项 = 没有哪条命令设过它
    expect(eng.world.small.planet.terrainWind).toBeUndefined();
    const summary = eng.exec({ op: 'batch', label: '山挡风：旧存档也打开', commands: [{ op: 'set_planet', patch: { terrainWind: 1 } }] });
    expect(summary).toBe('山挡风：旧存档也打开');
    expect(digest(eng.world.derived.windSX)).not.toBe(replayed['derived.windSX']);
    const saved = eng.toDoc();
    expect(saved.version).toBe(4);
    const again = Engine.fromDoc(saved, mesh);
    expect(again.world.small.planet.terrainWind).toBe(1);
    expect(digestWorld(again.world)).toEqual(digestWorld(eng.world));
    eng.undo();
    expect(digestWorld(eng.world)).toEqual(replayed);
  });
});
