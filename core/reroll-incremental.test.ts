import { describe, expect, it } from 'vitest';
import { digestWorld, hashArray } from '../tools/hash';
import { Engine } from './engine';
import type { Reroll } from './generate';
import { type Mesh, buildMesh } from './mesh';
import { buildSphereMesh } from './sphere';
import { ensureBase, previewTerrain, sortedOrder } from './terrain';
import { type World, createWorld } from './world';
import { seededEngine } from './testing/fixtures';

// 重画一片（以及撤销、重做）只重算重画圈里的格；海平面的排序用基数排序。
// 两者都必须与从头整张重算逐位相同

const flat = buildMesh(3000, 2, 1);
const sphere = buildSphereMesh(3000, 1);

function worldOf(mesh: Mesh, rerolls: Reroll[]): World {
  const w = mesh.kind === 'sphere' ? createWorld({ cells: mesh.n, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, mesh) : createWorld({ cells: mesh.n, seed: 1 }, mesh);
  w.small.terrain.gen = { seed: 4, type: 'continents', mountains: 1.2, rerolls };
  return w;
}

// 基础场的全部数组（逐位的哈希）
function snapshot(w: World) {
  const c = ensureBase(w);
  const comp = c.components!;
  return {
    b0: hashArray(comp.b0),
    mountB: hashArray(comp.mountB),
    mountU: hashArray(comp.mountU),
    hillU: hashArray(comp.hillU),
    erod: hashArray(comp.erod),
    landness: hashArray(c.landness),
    uplift: hashArray(c.uplift),
    seaLevel: c.seaLevel,
  };
}

describe('重画一片：局部重算与整张重算逐位相同', () => {
  for (const [name, mesh, x0] of [
    ['一块地区', flat, 0.9],
    ['整个星球（接缝上）', sphere, 1.98],
  ] as const) {
    it(name, () => {
      const a: Reroll = { x: x0, y: 0.45, radius: 0.12, variant: 1 };
      // 与 a 重叠
      const b: Reroll = { x: x0 + 0.07, y: 0.5, radius: 0.1, variant: 2 };
      const c: Reroll = { x: 0.3, y: 0.7, radius: 0.08, variant: 3 };
      // 重画、再重画（重叠）、撤销、重做、换掉中间的一次、全部撤销
      const steps: Reroll[][] = [[a], [a, b], [a], [a, b], [a, c, b], [b], []];
      const w = worldOf(mesh, []);
      ensureBase(w);
      for (const rerolls of steps) {
        const cones = ensureBase(w).model!.cones;
        w.small.terrain.gen!.rerolls = rerolls.map((r) => ({ ...r }));
        const inc = snapshot(w);
        // 走的是局部重算（模型照用）
        expect(ensureBase(w).model!.cones).toBe(cones);
        expect(inc).toEqual(snapshot(worldOf(mesh, rerolls)));
      }
    });
  }
});

describe('海平面排序', () => {
  it('与带比较函数的稳定排序逐个相同（重复值、±0、负数）', () => {
    const vals = [0, -0, 1.5, -1.5, 3, 3, -2e-310, 2e-310, -1e300, 1e300, 7.25, -7.25, 0, -0, 1.5];
    const v = new Float64Array(4000);
    let s = 12345;
    for (let i = 0; i < v.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      v[i] = i % 3 ? vals[s % vals.length] : (s / 2 ** 32 - 0.5) * 8000;
    }
    const expected = Array.from({ length: v.length }, (_, i) => i).sort((a, b) => v[a] - v[b]);
    expect(Array.from(sortedOrder(v))).toEqual(expected);
  });

  it('拖海岸破碎度时两个值来回切换，预览与从头算的一致', () => {
    const w = worldOf(flat, []);
    ensureBase(w);
    for (const rough of [1.3, 0.6, 1.3, 1.8]) {
      expect(previewTerrain(w, { rough })).toEqual(previewTerrain(worldOf(flat, []), { rough }));
    }
  });
});

describe('重画、撤销之后没写的陆地比例取默认值', () => {
  it('新世界 → 陆地比例 0.4 → 重画一片 → 撤销两次：每一步都与按文档重新打开的相同', () => {
    const eng = seededEngine({ seed: 2, cells: 3000 });
    const same = (tag: string) => {
      const a = digestWorld(eng.world);
      const b = digestWorld(Engine.fromDoc(eng.toDoc()).world);
      expect(Object.keys(a).filter((k) => !k.startsWith('mesh.') && a[k] !== b[k]), tag).toEqual([]);
    };
    eng.exec({ op: 'set_worldgen', params: { seed: 12, type: 'continents' }, reset: true });
    eng.exec({ op: 'set_worldgen', params: { seed: 12, type: 'continents', mountains: 1, rerolls: [], landFraction: 0.4 } });
    eng.exec({ op: 'reroll_region', x: 0.867, y: 0.4225, radius: 0.08, variant: 2 });
    same('重画');
    eng.undo();
    same('撤销一次');
    eng.undo();
    same('撤销两次');
    eng.redo();
    same('重做');
  });
});
