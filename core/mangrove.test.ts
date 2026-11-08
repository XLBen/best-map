import { describe, expect, it } from 'vitest';
import { settingsFor } from './presets';
import { engineFor, snapshot } from './testing/fixtures';
import { clearShelterMemo, shelterGetter } from './vegetation';
import type { World } from './world';

// 第八十九轮：红树林只长在热带、低平、有遮蔽的海岸（海湾、河口）上。以前热带群岛约 16% 的陆地是红树林（岛上低平的岸几乎都长满了）
function mangroves(w: World) {
  const d = w.derived;
  const sp = w.small.species.findIndex((s) => s.id === 'mangrove');
  const shelter = shelterGetter(w, d);
  let land = 0;
  const cells: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) {
    if (!w.causes.land[i] || d.lake[i]) continue;
    land++;
    if (d.dominant[i] === sp) cells.push(i);
  }
  return { share: cells.length / land, cells, shelter };
}

// 新建一个热带群岛（向导里“群岛之海”的默认：一片海域、热带）
const archipelago = () =>
  snapshot('mangrove:archipelago', () => {
    const eng = engineFor({ ...settingsFor('region', 'tropical', 40000), seed: 1 });
    eng.exec({ op: 'set_worldgen', params: { seed: 1, type: 'archipelago' }, reset: true });
    return eng;
  }).world;

describe('红树林（第八十九轮）', () => {
  it('热带群岛约占陆地的 1–3%，一般的世界更少；长的格都在有遮蔽的海岸上、35 m 以下、热带', () => {
    const a = mangroves(archipelago());
    expect(a.share).toBeGreaterThan(0.01);
    expect(a.share).toBeLessThan(0.03);
    const plain = engineFor({ seed: 1 });
    plain.exec({ op: 'set_worldgen', params: { seed: 1, type: 'continents' }, reset: true });
    const b = mangroves(plain.world);
    expect(b.share).toBeGreaterThan(0);
    expect(b.share).toBeLessThan(a.share);
    for (const [w, m] of [
      [archipelago(), a],
      [plain.world, b],
    ] as const) {
      for (const i of m.cells) {
        expect(m.shelter(i)).toBeGreaterThanOrEqual(0.55);
        expect(w.derived.elevation[i]).toBeLessThan(35);
        expect(w.derived.tMean[i]).toBeGreaterThan(17);
      }
    }
  });

  it('有遮蔽的海岸：不挨着海的格是 0，挨着海的陆地格在 [0, 1]（一格的小岛四周全是海时是 0）；逐格问两遍一样', () => {
    const w = archipelago();
    const g = shelterGetter(w, w.derived);
    const { off, adj } = w.mesh;
    let inland = 0;
    let coast = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const v = g(i);
      if (!w.causes.land[i]) {
        expect(v).toBe(0);
        continue;
      }
      let sea = false;
      for (let e = off[i]; e < off[i + 1]; e++) if (!w.causes.land[adj[e]]) sea = true;
      if (!sea) {
        expect(v).toBe(0);
        inland++;
      } else {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        coast++;
      }
      expect(g(i)).toBe(v);
    }
    expect(inland).toBeGreaterThan(0);
    expect(coast).toBeGreaterThan(0);
  });

  it('记着的陆地比例：改了陆海（放岛、画海）以后与从头算逐值相同', () => {
    const eng = engineFor({ ...settingsFor('region', 'tropical', 40000), seed: 1 });
    eng.exec({ op: 'set_worldgen', params: { seed: 1, type: 'archipelago' }, reset: true });
    const all = (fresh: boolean) => {
      if (fresh) clearShelterMemo();
      const w = eng.world;
      const g = shelterGetter(w, w.derived);
      return Float64Array.from({ length: w.mesh.n }, (_, i) => g(i));
    };
    all(false);
    const { mesh } = eng.world;
    const sea = [...eng.world.causes.land.keys()].find((i) => !eng.world.causes.land[i] && mesh.x[i] > mesh.width * 0.4)!;
    eng.exec({ op: 'add_island', island: { x: mesh.x[sea], y: mesh.y[sea], kind: 'continental', size: 200, variant: 0 } } as never);
    const a = all(false);
    expect(a).toEqual(all(true));
    const land = [...eng.world.causes.land.keys()].filter((i) => eng.world.causes.land[i]).slice(0, 300);
    eng.exec({ op: 'paint_land', cells: land, t: land.map(() => 0), mode: 'sea' } as never);
    const b = all(false);
    expect(b).toEqual(all(true));
    expect(b).not.toEqual(a);
  });
});
