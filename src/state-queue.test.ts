import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { ProvincesPreview } from '../core/engine';
import { continents } from '../core/testing/fixtures';
import type { Request, Response } from './protocol';
import { type Again, busy, changeNote, editsIdle, exec, newWorld, onlyEditsPending, previewProvinces, toast, whenEditsIdle, world } from './state';

// 主线程与 Worker 之间的排队：这里没有真的 Worker，换成一个假的，记下发来的请求，测试决定什么时候回复

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
  // 回复编号为 id 的请求
  reply(id: number, r: Omit<Extract<Response, { ok: true }>, 'id'>) {
    this.onmessage?.({ data: { id, ...r } });
  }
}
vi.stubGlobal('Worker', FakeWorker);

const kinds = (fw: FakeWorker) => fw.sent.map((m) => m.req.kind);
const lastId = (fw: FakeWorker) => fw.sent[fw.sent.length - 1].id;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('排队与“换个形状”', () => {
  it('后面还有排队的编辑时不换（换掉的会是排在最后的那一步）；算完再换；连点两下照样换', async () => {
    world.value = continents().world;
    const island: Command = { op: 'set_planet', patch: { solar: 1 } };
    const stroke: Command = { op: 'set_planet', patch: { solar: 1.01 } };
    const again: Again = { label: '换个形状', next: vi.fn(() => island) };
    const a = exec(island, '正在造岛…', again);
    const fw = FakeWorker.last!;
    fw.reply(lastId(fw), { ok: true, summary: '放了一个岛' });
    await a;
    const run = changeNote.value!.again!.run;
    // 岛算完了，后面又排了一笔
    const b = exec(stroke);
    toast.value = null;
    run();
    expect(toast.value).toMatchObject({ text: '等排队的几步算完再换' });
    expect(again.next).not.toHaveBeenCalled();
    expect(kinds(fw)).toEqual(['exec', 'exec']);
    fw.reply(lastId(fw), { ok: true, summary: '画了一笔' });
    await b;
    // 排队的都算完了：换的就是最后一步
    run();
    run();
    expect(again.next).toHaveBeenCalledTimes(2);
    expect(kinds(fw)).toEqual(['exec', 'exec', 'replaceLast', 'replaceLast']);
    for (const m of fw.sent.slice(2)) fw.reply(m.id, { ok: true, summary: '换了个形状' });
    await tick();
  });
});

describe('省份的轻预览', () => {
  const provinces = (k: number): ProvincesPreview => ({ province: Int32Array.of(k), provinces: {}, seams: null, summary: `${k}`, changed: true });
  const regen = (k: number): Command => ({ op: 'regenerate_provinces', cells: [k] });

  it('同一时间只算一个：排着的被新的顶掉（得到 null）；回来时世界已经变了也是 null', async () => {
    const w = continents().world;
    world.value = w;
    const p1 = previewProvinces(regen(1));
    const fw = FakeWorker.last!;
    const from = fw.sent.length - 1;
    const p2 = previewProvinces(regen(2));
    const p3 = previewProvinces(regen(3));
    // 第一个已经发出去了；第二个还没发就被第三个顶掉
    expect(await p2).toBeNull();
    expect(fw.sent.slice(from).map((m) => m.req)).toEqual([{ kind: 'previewProvinces', cmd: regen(1) }]);
    fw.reply(fw.sent[from].id, { ok: true, provinces: provinces(1) });
    expect((await p1)?.summary).toBe('1');
    await tick();
    expect(fw.sent.slice(from).map((m) => m.req)).toEqual([
      { kind: 'previewProvinces', cmd: regen(1) },
      { kind: 'previewProvinces', cmd: regen(3) },
    ]);
    // 第三个算的时候世界换了（前面的编辑算完了）：结果是旧世界的，不要
    world.value = { ...w };
    fw.reply(lastId(fw), { ok: true, provinces: provinces(3) });
    expect(await p3).toBeNull();
  });
});

describe('新建、打开：网格、快照换上之前一直算在忙', () => {
  it('引擎回复了但网格还没建好（快照没换上）时，排队的编辑、whenEditsIdle 都还要等', async () => {
    const w = continents().world;
    world.value = w;
    const opened = newWorld(w.settings, []);
    // newWorld 里先 await 了几步才发出去
    for (let k = 0; k < 5; k++) await Promise.resolve();
    const fw = FakeWorker.last!;
    const init = fw.sent.find((m) => m.req.kind === 'init')!;
    expect(init).toBeTruthy();
    let idle = false;
    void whenEditsIdle().then(() => (idle = true));
    fw.reply(init.id, { ok: true, summary: '新的世界' });
    // 回复到了，可网格（测试里是让出一帧后就地建）还没好、快照还没换上
    for (let k = 0; k < 5; k++) await Promise.resolve();
    expect(editsIdle()).toBe(false);
    expect(onlyEditsPending()).toBe(false);
    expect(busy.value).not.toBeNull();
    expect(idle).toBe(false);
    expect(await opened).toBe(true);
    expect(editsIdle()).toBe(true);
    expect(busy.value).toBeNull();
    await tick();
    expect(idle).toBe(true);
  });
});
