import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { Engine } from './engine';
import { elevationMemo } from './elevation';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { sampledBaseMemo } from './terrain';
import { seededEngine } from './testing/fixtures';

// 空闲预热（第三十一轮，Engine.warmSteps）：从检查点恢复到新的网格上（所有按网格的缓存都是空的，像刷新页面后打开），
// 预热完再改一笔，与不预热直接改、与一直开着的世界上改同一笔逐值相同；预热以后这一笔只重算改到的陆块、不再采样生成器。
// 预热到一半停下、中途世界变了再接着预热，结果也一样

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

function drain(steps: Generator<void>): number {
  let chunks = 0;
  while (!steps.next().done) chunks++;
  return chunks;
}

for (const [label, settings] of [
  ['一块地区', { cells: 5000, seed: 4 }],
  ['整个星球', { cells: 4000, seed: 4, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const) {
  describe(`空闲预热：${label}`, () => {
    const eng = seededEngine(settings);
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    eng.exec({ op: 'reroll_region', x: 0.9, y: 0.5, radius: 0.1, variant: 1 });
    const land = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.land[i]);
    const hill = land.slice(200, 260);
    eng.exec({ op: 'paint_relief', cells: hill, t: hill.map(() => 0), strength: 0.6 });
    const doc = eng.toDoc();
    const cp = structuredClone(eng.toCheckpoint());
    const cells = land.slice(900, 960);
    const edit: Command = { op: 'paint_relief', cells, t: cells.map(() => 0.3), strength: 0.5 };
    const open = () => Engine.fromCheckpoint(structuredClone(cp), doc, fresh(eng.world.mesh))!;

    it('预热后改一笔 = 不预热改一笔 = 一直开着时改一笔；预热后只重算改到的陆块、不再采样', () => {
      const cold = open();
      const c0 = elevationMemo.computed;
      cold.exec(edit);
      const coldComputed = elevationMemo.computed - c0;

      const warm = open();
      const before = digestWorld(warm.world);
      const h0 = sampledBaseMemo.hits;
      const chunks = drain(warm.warmSteps());
      expect(chunks).toBeGreaterThanOrEqual(5);
      // 预热把分段采好的放进了按网格的缓存，这个世界的缓存命中了它
      expect(sampledBaseMemo.hits).toBe(h0 + 1);
      // 预热不改世界
      expect(digestWorld(warm.world)).toEqual(before);
      const w0 = elevationMemo.computed;
      warm.exec(edit);
      const warmComputed = elevationMemo.computed - w0;
      // 再预热一轮：都已经在缓存里，没有要做的
      expect(drain(warm.warmSteps())).toBeLessThanOrEqual(2);

      const hot = Engine.fromDoc(doc, eng.world.mesh);
      const k0 = elevationMemo.computed;
      hot.exec(edit);
      // 预热后与一直开着时一样只重算改到的几块陆地，不预热时全部重算
      expect(warmComputed).toBe(elevationMemo.computed - k0);
      expect(coldComputed).toBeGreaterThan(warmComputed);
      const expected = digestWorld(hot.world);
      expect(digestWorld(cold.world)).toEqual(expected);
      expect(digestWorld(warm.world)).toEqual(expected);
    });

    it('预热到一半停下、或中途世界变了接着预热完，之后的结果照样相同', () => {
      const a = open();
      const steps = a.warmSteps();
      steps.next();
      steps.next();
      steps.next();
      steps.return(undefined);
      a.exec(edit);

      const b = open();
      const s2 = b.warmSteps();
      for (let k = 0; k < 4; k++) s2.next();
      // 预热还没做完时执行了一笔（Worker 里不会：收到请求就停下；这里故意接着做完）
      b.exec(edit);
      drain(s2);
      const more = land.slice(1500, 1540);
      const edit2: Command = { op: 'paint', field: 'erodDelta', cells: more, value: 0.4, mode: 'add' };
      b.exec(edit2);
      a.exec(edit2);

      const hot = Engine.fromDoc(doc, eng.world.mesh);
      hot.exec(edit);
      hot.exec(edit2);
      const expected = digestWorld(hot.world);
      expect(digestWorld(a.world)).toEqual(expected);
      expect(digestWorld(b.world)).toEqual(expected);
    });
  });
}
