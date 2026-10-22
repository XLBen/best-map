import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { Visual } from '../core/species';
import { continents } from '../core/testing/fixtures';
import type { World } from '../core/world';
import type { LightSnapshot, Request, Response } from './protocol';
import { exec, setSpeciesVisualOverride, visualOverrides, world } from './state';

// 拖花纹、发光滑块时的外观覆盖：结果换上时，用不着的覆盖自己去掉（编辑面板忘了去掉时，地图也不会一直画着世界里没有的样子）。
// 没有真的 Worker：换成一个假的，测试决定回什么

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: { data: Response }) => void) | null = null;
  sent: { id: number; req: Request }[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: { id: number; req: Request }) {
    this.sent.push(m);
  }
}
vi.stubGlobal('Worker', FakeWorker);

// 只改了生态外观的一步：Worker 回一个轻快照（推导数组沿用主线程上的）
function lightOf(w: World, species: World['small']['species']): LightSnapshot {
  return {
    light: true,
    small: { ...w.small, species },
    features: w.derived.features,
    province: w.causes.province,
    history: [{ summary: '改了外观', done: true }],
    canUndo: true,
    canRedo: false,
    timings: { total: 1 },
    stateId: 1,
  };
}

// 执行一步，Worker 回 snapshot
async function run(cmd: Command, snapshot: LightSnapshot) {
  const p = exec(cmd);
  const fw = FakeWorker.last!;
  const { id } = fw.sent[fw.sent.length - 1];
  fw.onmessage?.({ data: { id, ok: true, summary: '改了外观', snapshot } });
  await p;
}

describe('拖花纹、发光滑块时的外观覆盖', () => {
  it('松手提交的结果到了：覆盖的与存着的一样就去掉（键的先后、颜色的大小写不算）；别的生态的覆盖留着', async () => {
    const w = continents().world;
    world.value = w;
    const dragged: Visual = { glow: 0.4, pattern: 'spots', color2: '#AABBCC' };
    const other: Visual = { pattern: 'mottle', amount: 0.3 };
    setSpeciesVisualOverride('steppe', dragged);
    setSpeciesVisualOverride('taiga', other);
    expect(visualOverrides.value.size).toBe(2);
    // 存进世界的那份：经过校验，键按定义的顺序、颜色是小写
    const committed: Visual = { pattern: 'spots', color2: '#aabbcc', glow: 0.4 };
    const species = w.small.species.map((s) => (s.id === 'steppe' ? { ...s, visual: committed } : s));
    await run({ op: 'update_species', id: 'steppe', patch: { visual: committed } }, lightOf(w, species));
    expect(world.value!.small.species.find((s) => s.id === 'steppe')!.visual).toEqual(committed);
    expect([...visualOverrides.value.keys()]).toEqual(['taiga']);
    // 编辑面板照约定再去掉一次：什么都不变
    const before = visualOverrides.value;
    setSpeciesVisualOverride('steppe', null);
    expect(visualOverrides.value).toBe(before);
  });

  it('还在拖（结果与覆盖的不一样）时留着；那种生态没有了（撤销、删掉）就去掉', async () => {
    const w = continents().world;
    world.value = w;
    visualOverrides.value = new Map();
    setSpeciesVisualOverride('steppe', { pattern: 'cracks', size: 2 });
    setSpeciesVisualOverride('gone', { pattern: 'sparkle' });
    // 排在前面的一步算完了（steppe 的外观还是旧的）
    await run({ op: 'set_planet', patch: { solar: 1 } }, lightOf(w, w.small.species));
    expect([...visualOverrides.value.keys()]).toEqual(['steppe']);
    // steppe 被撤销掉了
    await run({ op: 'set_planet', patch: { solar: 1.01 } }, lightOf(w, w.small.species.filter((s) => s.id !== 'steppe')));
    expect(visualOverrides.value.size).toBe(0);
  });
});
