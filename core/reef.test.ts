import { describe, expect, it } from 'vitest';
import type { Engine } from './engine';
import { coastValues, pointIsLand } from './subcell';
import { coastNoiseField, coastSeed, roundKm } from './terrain';
import { engineFor, snapshot } from './testing/fixtures';

// 第八轮：小礁——只占一格的小岛，屏幕和导出都画成约半格大；海岸曲折调到 0 到 2 都还在

const WORLDS = {
  地区: { cells: 6000, seed: 1 },
  星球: { cells: 6000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 },
} as const;

// 群岛：海平面随海岸曲折挪动，比空白海洋难一些
function base(name: keyof typeof WORLDS): Engine {
  return snapshot(`reef:${name}`, () => {
    const eng = engineFor(WORLDS[name]);
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'archipelago' }, reset: true });
    return eng;
  });
}

// 往外走 steps 圈以内的格（含自己）
function within(eng: Engine, c: number, steps: number): number[] {
  const { mesh } = eng.world;
  const seen = new Set([c]);
  let front = [c];
  for (let r = 0; r < steps; r++) {
    const next: number[] = [];
    for (const i of front) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (seen.has(mesh.adj[e])) continue;
        seen.add(mesh.adj[e]);
        next.push(mesh.adj[e]);
      }
    }
    front = next;
  }
  return [...seen];
}

// 放小礁的地方：深海里（两圈以内都是海，紧挨着的格海岸值都在 −200 m 以下），离地图边、接缝、两极远一些，
// 彼此至少隔四圈。海岸噪声最低、最高的先挑（改海岸曲折时最容易没的就是它们）
function spots(eng: Engine, count: number): number[] {
  const w = eng.world;
  const { mesh } = w;
  const s = coastValues(w);
  const k = coastNoiseField(mesh, coastSeed(w));
  const cand: number[] = [];
  for (let c = 0; c < mesh.n; c++) {
    if (mesh.x[c] < 0.2 || mesh.x[c] > 1.8 || mesh.y[c] < 0.25 || mesh.y[c] > 0.75) continue;
    const near = within(eng, c, 2);
    if (near.every((i) => !w.causes.land[i]) && within(eng, c, 1).every((i) => s[i] < -200)) cand.push(c);
  }
  cand.sort((a, b) => k[a] - k[b]);
  const out: number[] = [];
  const taken = new Set<number>();
  for (let t = 0; out.length < count && t < cand.length; t++) {
    const c = t % 2 ? cand[cand.length - 1 - (t >> 1)] : cand[t >> 1];
    if (taken.has(c)) continue;
    out.push(c);
    for (const i of within(eng, c, 4)) taken.add(i);
  }
  return out;
}

// 画出来的小岛占这一格的多大比例：在两圈范围里按 40×40 的网格取点，看屏幕、导出用的同一个判断
function renderedFraction(eng: Engine, c: number): number {
  const w = eng.world;
  const { mesh } = w;
  const s = coastValues(w);
  const cells = within(eng, c, 2);
  const xs = cells.map((i) => mesh.x[i]);
  const ys = cells.map((i) => mesh.y[i]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let land = 0;
  let own = 0;
  let hint = c;
  for (let a = 0; a < 40; a++) {
    for (let b = 0; b < 40; b++) {
      const r = pointIsLand(w, s, w.derived.elevation, x0 + ((a + 0.5) / 40) * (x1 - x0), y0 + ((b + 0.5) / 40) * (y1 - y0), hint);
      hint = r.nearest;
      if (r.nearest === c) own++;
      if (r.land) land++;
    }
  }
  return land / own;
}

// 放好小礁的世界：第一个单独放（看历史里的说明），其余的一次放下。每个世界只放一次，给出副本
type Placed = { eng: Engine; at: number[]; before: Uint8Array; summary: string };
const placed = new Map<string, Placed>();
function withReefs(name: keyof typeof WORLDS): Placed {
  let p = placed.get(name);
  if (!p) {
    const eng = base(name);
    const { mesh } = eng.world;
    const at = spots(eng, 8);
    const before = eng.world.causes.land.slice();
    eng.exec({ op: 'add_island', island: { x: mesh.x[at[0]], y: mesh.y[at[0]], kind: 'reef' } });
    const summary = eng.history.at(-1)!.summary;
    eng.exec({ op: 'batch', label: '小礁', commands: at.slice(1).map((c) => ({ op: 'add_island' as const, island: { x: mesh.x[c], y: mesh.y[c], kind: 'reef' as const } })) });
    placed.set(name, (p = { eng, at, before, summary }));
  }
  return { ...p, eng: p.eng.clone() };
}

describe('小礁', () => {
  for (const name of ['地区', '星球'] as const) {
    it(`小礁只占一格，画出来约半格大（${name}）`, () => {
      const { eng, at, before, summary } = withReefs(name);
      const w = eng.world;
      expect(at.length).toBe(8);
      expect(summary).toBe(`放了一个小礁（直径约 ${roundKm(w.mesh.spacing * w.kmPerUnit * 0.5)} km）`);
      // 每个小礁正好一格新陆地，就是点下去的那一格
      const gained = [...w.causes.land.keys()].filter((i) => w.causes.land[i] && !before[i]);
      expect(gained).toEqual([...at].sort((a, b) => a - b));
      // 画出来的大小：每个都看得见、都不到一格（格以下的海岸细节让它们有大有小），平均约四分之一格（宽约半格）
      const fr = at.map((c) => renderedFraction(eng, c));
      for (const f of fr) {
        expect(f).toBeGreaterThan(0);
        expect(f).toBeLessThan(1);
      }
      const mean = fr.reduce((a, b) => a + b, 0) / fr.length;
      expect(mean).toBeGreaterThanOrEqual(0.15);
      expect(mean).toBeLessThanOrEqual(0.4);
    });

    it(`海岸曲折调到 0 和 2 小礁还在（${name}）`, () => {
      const { eng, at } = withReefs(name);
      for (const rough of [0, 0.35, 2]) {
        const e = eng.clone();
        e.exec({ op: 'set_coast_style', roughness: rough });
        expect(
          at.filter((c) => !e.world.causes.land[c]),
          `海岸曲折 ${rough}`,
        ).toEqual([]);
      }
    });
  }

  it('小礁已经是陆地的地方放不下；岛链里没有小礁', () => {
    const eng = base('地区');
    const w = eng.world;
    const land = [...w.causes.land.keys()].find((i) => w.causes.land[i])!;
    expect(() => eng.exec({ op: 'add_island', island: { x: w.mesh.x[land], y: w.mesh.y[land], kind: 'reef' } })).toThrow('放不下');
    expect(() => eng.exec({ op: 'add_island_chain', chain: { points: [[0.3, 0.3], [0.8, 0.4]], kind: 'reef' as 'volcanic' } })).toThrow();
  });
});
