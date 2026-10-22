import { describe, expect, it, vi } from 'vitest';
import { FANTASY_FORMS } from '../core/packs/fantasy-forms';
import { findScripts } from '../core/script';
import type { Request } from './protocol';

// 向导的缩略图：带脚本的（星球形态）在另一个计算 Worker 里算，脚本看不到当前打开的世界，卡住了也只停掉那一个；
// 不带脚本的照旧在当前的 Worker 里算。这里没有真的 Worker：换成按请求自动回复的假的

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Request[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { id: number; req: Request }) {
    this.sent.push(m.req);
    queueMicrotask(() => this.onmessage?.({ data: { id: m.id, ok: true, thumb: new Uint8ClampedArray(4 * 8 * 4) } }));
  }
  terminate() {}
}
vi.stubGlobal('Worker', FakeWorker);

const { thumbnail } = await import('./state');

describe('向导的缩略图', () => {
  it('带脚本的星球形态在另一个 Worker 里算；不带脚本的照旧在当前的 Worker 里算', async () => {
    const scripted = FANTASY_FORMS.find((f) => findScripts(f).length > 0)!;
    const plain = { seed: 3, type: 'continents' as const };
    expect(await thumbnail({}, plain, 8, 4)).not.toBeNull();
    expect(FakeWorker.all).toHaveLength(1);
    expect(await thumbnail({}, { ...plain, form: scripted }, 8, 4)).not.toBeNull();
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[0].sent.map((r) => r.kind)).toEqual(['thumb']);
    expect(FakeWorker.all[1].sent.map((r) => r.kind)).toEqual(['thumb']);
    // 接着带脚本的还在那个 Worker 里算，不带脚本的还在当前的
    await thumbnail({}, { ...plain, seed: 4, form: scripted }, 8, 4);
    await thumbnail({}, { ...plain, seed: 4 }, 8, 4);
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all.map((w) => w.sent.length)).toEqual([2, 2]);
  });
});
