import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import { type TerrainPatch, previewTerrain as compute } from '../core/terrain';
import { continents } from '../core/testing/fixtures';
import { adjustPreview, commitTerrain, previewTerrain, world } from './state';

// “调整”的地形滑块：拖的时候、松手后算的期间，地图上一直是将来的海岸（不闪回旧的海岸）。
// Worker 换成一个按顺序处理的假 Worker：地形预览在主线程上算（与 Worker 里同一个函数），执行先挂着，由测试放行

let release: (() => void) | null = null;
// 发给 Worker 的预览依次是哪些值
const asked: number[] = [];
class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  private tail: Promise<void> = Promise.resolve();
  postMessage({ id, req }: { id: number; req: { kind: string; patch?: TerrainPatch } }) {
    this.tail = this.tail.then(async () => {
      let data: unknown;
      if (req.kind === 'previewTerrain') {
        asked.push(req.patch!.landFraction!);
        data = { id, ok: true, terrain: compute(world.value!, req.patch!) };
      } else {
        await new Promise<void>((r) => (release = r));
        release = null;
        // 这里只看预览：执行回一个“没有变化”
        data = { id, ok: true, noop: true };
      }
      await Promise.resolve();
      this.onmessage?.({ data });
    });
  }
}
vi.stubGlobal('Worker', FakeWorker);

const settle = () => new Promise((r) => setTimeout(r, 0));
const coastOf = (f: number) => Array.from(compute(world.value!, { landFraction: f }).coast);

describe('“调整”的地形滑块', () => {
  it('一直拖着：算好的值照样先显示（海岸线慢一步跟着滑块），不是一直不出来', async () => {
    world.value = continents().world;
    // 离上一次换预览已经过了一会儿（一秒最多换几次）
    await new Promise((r) => setTimeout(r, 200));
    const seen: Float32Array[] = [];
    const stop = adjustPreview.subscribe((v) => v && seen.push(v.coast));
    previewTerrain({ landFraction: 0.42 });
    previewTerrain({ landFraction: 0.43 });
    previewTerrain({ landFraction: 0.44 });
    await vi.waitFor(() => expect(seen.length).toBe(2));
    stop();
    // 0.43 被 0.44 取代、没有算；0.42 算好时 0.44 还在排队，照样先显示了
    expect(asked).toEqual([0.42, 0.44]);
    expect(Array.from(seen[0])).toEqual(coastOf(0.42));
    expect(Array.from(seen[1])).toEqual(coastOf(0.44));
    previewTerrain(null);
    expect(adjustPreview.value).toBeNull();
  });

  it('没停就松手：松手的值在执行之前算好，算的期间一直显示它；没有变化时才清掉', async () => {
    const w = continents().world;
    world.value = w;
    asked.length = 0;
    previewTerrain({ landFraction: 0.46 });
    previewTerrain({ landFraction: 0.47 });
    const cmd: Command = { op: 'set_worldgen', params: { ...w.small.terrain.gen!, landFraction: 0.48 } };
    const done = commitTerrain(cmd, '正在计算…', { landFraction: 0.48 });
    await vi.waitFor(() => expect(release).not.toBeNull());
    await settle();
    // 排队的 0.47 作废；在算的 0.46 不显示；松手的 0.48 排在执行前面
    expect(asked).toEqual([0.46, 0.48]);
    expect(Array.from(adjustPreview.value!.coast)).toEqual(coastOf(0.48));
    release!();
    await done;
    expect(adjustPreview.value).toBeNull();
  });

  it('停下看过了再松手：不再算一遍', async () => {
    const w = continents().world;
    world.value = w;
    asked.length = 0;
    previewTerrain({ landFraction: 0.5 });
    await vi.waitFor(() => expect(adjustPreview.value).not.toBeNull());
    const shown = adjustPreview.value;
    const cmd: Command = { op: 'set_worldgen', params: { ...w.small.terrain.gen!, landFraction: 0.5 } };
    const done = commitTerrain(cmd, '正在计算…', { landFraction: 0.5 });
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(asked).toEqual([0.5]);
    expect(adjustPreview.value).toBe(shown);
    release!();
    await done;
  });
});
