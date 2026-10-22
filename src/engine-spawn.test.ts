import { describe, expect, it } from 'vitest';
import { DATA_URL_MAX, EngineWorker, HELLO_AGAIN_MS, HELLO_MS, type RawWorker, type SpawnDeps, type SpawnMemory, engineDataUrl, readHello } from './engine-spawn';

// 开计算 Worker：先试 data: 地址的（隔离），等它打招呼才发请求；拿不到代码、代码太大、报错、5 秒不打招呼都退回普通的。
// 只有 data: 的 Worker 的第一条招呼算数。这里的 Worker、计时都是假的

class FakeRaw implements RawWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  terminated = false;
  constructor(readonly url: string) {}
  postMessage(msg: unknown) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

// throwData：浏览器不许开 data: 的 Worker（一开就抛错）
function setup(code: string | null | Error = 'self.onmessage = () => {};', memory?: SpawnMemory, throwData = false) {
  const made: FakeRaw[] = [];
  const said: boolean[] = [];
  const timers: { f: () => void; ms: number; on: boolean }[] = [];
  const deps: SpawnDeps = {
    code: () => (code instanceof Error ? Promise.reject(code) : Promise.resolve(code)),
    url: '/assets/worker.js',
    create: (url) => {
      if (throwData && url.startsWith('data:')) throw new DOMException('不许', 'SecurityError');
      const w = new FakeRaw(url);
      made.push(w);
      return w;
    },
    isolated: (on) => said.push(on),
    setTimer: (f, ms) => {
      const t = { f, ms, on: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { on: boolean }).on = false;
    },
    memory,
  };
  const w = new EngineWorker(deps);
  const got: unknown[] = [];
  w.onmessage = (ev) => got.push(ev.data);
  const fire = () => {
    for (const t of timers.splice(0)) if (t.on) t.f();
  };
  return { w, made, said, timers, got, fire };
}

const settle = async () => {
  for (let k = 0; k < 5; k++) await Promise.resolve();
};

describe('开计算 Worker', () => {
  it('拿到代码：开 data: 地址的 Worker，打招呼之前请求先排着；招呼说隔离了才算隔离', async () => {
    const t = setup();
    t.w.postMessage({ id: 1 });
    await settle();
    expect(t.made).toHaveLength(1);
    expect(t.made[0].url.startsWith('data:text/javascript;base64,')).toBe(true);
    expect(t.timers[0].ms).toBe(HELLO_MS);
    expect(t.made[0].sent).toEqual([]);
    t.made[0].emit({ kind: 'hello', isolated: true });
    expect(t.said).toEqual([true]);
    expect(t.w.mode).toBe('data');
    // 排着的请求送过去；之后的直接送
    expect(t.made[0].sent).toEqual([{ id: 1 }]);
    t.w.postMessage({ id: 2 });
    expect(t.made[0].sent).toEqual([{ id: 1 }, { id: 2 }]);
    // 回复转给 EngineHost；之后的招呼（可能是脚本伪造的）不算，也不转
    t.made[0].emit({ id: 1, ok: true });
    t.made[0].emit({ kind: 'hello', isolated: false });
    expect(t.got).toEqual([{ id: 1, ok: true }]);
    expect(t.said).toEqual([true]);
    // 招呼来了就不再计时
    t.fire();
    expect(t.made).toHaveLength(1);
  });

  it('data: 的 Worker 自查没通过：照样用它，但说没隔离；isolated 只认 true', async () => {
    const t = setup();
    await settle();
    t.made[0].emit({ kind: 'hello', isolated: 'yes' });
    expect(t.said).toEqual([false]);
    expect(t.w.mode).toBe('data');
  });

  it('拿不到代码（取文件失败、出错）、代码太大：直接开普通的 Worker，没隔离，请求照样送到', async () => {
    for (const code of [null, new Error('离线'), 'x'.repeat(DATA_URL_MAX)]) {
      const t = setup(code);
      t.w.postMessage({ id: 1 });
      await settle();
      expect(t.made.map((w) => w.url)).toEqual(['/assets/worker.js']);
      expect(t.said).toEqual([false]);
      expect(t.w.mode).toBe('plain');
      expect(t.made[0].sent).toEqual([{ id: 1 }]);
      // 普通 Worker 的招呼不算（它是同源的），也不转
      t.made[0].emit({ kind: 'hello', isolated: true });
      t.made[0].emit({ id: 1, ok: true });
      expect(t.said).toEqual([false]);
      expect(t.got).toEqual([{ id: 1, ok: true }]);
    }
  });

  it('data: 的 Worker 报错（浏览器不支持）：停掉它，换普通的；排着的请求送到普通的那里', async () => {
    const t = setup();
    t.w.postMessage({ id: 1 });
    await settle();
    let crashed = 0;
    t.w.onerror = () => crashed++;
    t.made[0].onerror?.({});
    expect(t.made[0].terminated).toBe(true);
    expect(t.made.map((w) => w.url.slice(0, 5))).toEqual(['data:', '/asse']);
    expect(t.made[1].sent).toEqual([{ id: 1 }]);
    expect(t.said).toEqual([false]);
    // 招呼之前的错误不当成崩了；换成普通的之后的错误照常交给 EngineHost
    expect(crashed).toBe(0);
    t.made[1].onerror?.({});
    expect(crashed).toBe(1);
  });

  it('5 秒内没有打招呼：停掉它，换普通的；之后它再打招呼也不算', async () => {
    const t = setup();
    t.w.postMessage({ id: 1 });
    await settle();
    const first = t.made[0];
    t.fire();
    expect(first.terminated).toBe(true);
    expect(first.onmessage).toBeNull();
    expect(t.made[1].url).toBe('/assets/worker.js');
    expect(t.made[1].sent).toEqual([{ id: 1 }]);
    expect(t.said).toEqual([false]);
  });

  it('data: 的 Worker 不行过一次：这个页面里之后直接开普通的（不再白等 5 秒）；开得起来就一直试', async () => {
    const memory = {};
    const t = setup(undefined, memory);
    await settle();
    t.fire();
    expect(t.made.map((w) => w.url.slice(0, 5))).toEqual(['data:', '/asse']);
    const u = setup(undefined, memory);
    await settle();
    expect(u.made.map((w) => w.url)).toEqual(['/assets/worker.js']);
    expect(u.said).toEqual([false]);
    // 一开就抛错（浏览器不许 data: 的 Worker）：换普通的，同样记下
    const memory2: { dataFailed?: boolean } = {};
    const v = setup(undefined, memory2, true);
    v.w.postMessage({ id: 1 });
    await settle();
    expect(v.made.map((w) => w.url)).toEqual(['/assets/worker.js']);
    expect(v.made[0].sent).toEqual([{ id: 1 }]);
    expect(memory2.dataFailed).toBe(true);
    // 拿不到代码不算 data: 的 Worker 不行（下次照样试）
    const memory3: { dataFailed?: boolean } = {};
    setup(null, memory3);
    await settle();
    expect(memory3.dataFailed).toBeUndefined();
    // 打过招呼的：之后照样开 data: 的
    const ok = {};
    const a = setup(undefined, ok);
    await settle();
    a.made[0].emit({ kind: 'hello', isolated: true });
    const b = setup(undefined, ok);
    await settle();
    expect(b.made[0].url.startsWith('data:')).toBe(true);
  });

  it('这个页面里隔离运行过：之后开的 data: Worker 多等一会儿，还不行就当作崩了（交给 EngineHost），不悄悄换成没隔离的', async () => {
    const memory: SpawnMemory = {};
    const a = setup(undefined, memory);
    await settle();
    a.made[0].emit({ kind: 'hello', isolated: true });
    expect(memory.isolatedOnce).toBe(true);
    // 没打招呼：多等一会儿，到时当作崩了
    const b = setup(undefined, memory);
    b.w.postMessage({ id: 1 });
    let crashed = 0;
    b.w.onerror = () => crashed++;
    await settle();
    expect(b.timers[0].ms).toBe(HELLO_AGAIN_MS);
    b.fire();
    await settle();
    expect(b.made).toHaveLength(1);
    expect(b.made[0].terminated).toBe(true);
    expect(crashed).toBe(1);
    expect(b.said).toEqual([]);
    expect(memory.dataFailed).toBe(false);
    // 停下之后的请求不再送
    b.w.postMessage({ id: 2 });
    expect(b.made[0].sent).toEqual([]);
    // 报错、一开就抛错：同样当作崩了
    const c = setup(undefined, memory);
    let cCrashed = 0;
    c.w.onerror = () => cCrashed++;
    await settle();
    c.made[0].onerror?.({});
    await settle();
    expect(c.made).toHaveLength(1);
    expect(cCrashed).toBe(1);
    const d = setup(undefined, memory, true);
    let dCrashed = 0;
    d.w.onerror = () => dCrashed++;
    await settle();
    expect(d.made).toEqual([]);
    expect(dCrashed).toBe(1);
    // 下一个照样试 data: 的
    const e = setup(undefined, memory);
    await settle();
    expect(e.made[0].url.startsWith('data:')).toBe(true);
    // 两个同时开、一个超时（记下了不行）一个打了招呼：之后照样试 data: 的，不会每个都当作崩了
    const both: SpawnMemory = {};
    const p = setup(undefined, both);
    const q = setup(undefined, both);
    await settle();
    p.fire();
    expect(both.dataFailed).toBe(true);
    q.made[0].emit({ kind: 'hello', isolated: true });
    expect(both).toEqual({ dataFailed: false, isolatedOnce: true });
    const r = setup(undefined, both);
    await settle();
    expect(r.made.map((w) => w.url.slice(0, 5))).toEqual(['data:']);
    r.made[0].emit({ kind: 'hello', isolated: true });
    expect(r.said).toEqual([true]);
    // 自查没通过（data: 的 Worker 不隔离）不算隔离运行过：之后照常可以退回普通的
    const other: SpawnMemory = {};
    const f = setup(undefined, other);
    await settle();
    f.made[0].emit({ kind: 'hello', isolated: false });
    expect(other.isolatedOnce).toBeUndefined();
    const g = setup(undefined, other);
    await settle();
    g.fire();
    expect(g.made.map((w) => w.url.slice(0, 5))).toEqual(['data:', '/asse']);
  });

  it('打招呼之前的别的消息不要；停掉之后不再开 Worker、不再说隔离不隔离', async () => {
    const t = setup();
    await settle();
    t.made[0].emit({ id: 9, ok: true });
    expect(t.got).toEqual([]);
    t.w.terminate();
    expect(t.made[0].terminated).toBe(true);
    t.fire();
    expect(t.made).toHaveLength(1);
    expect(t.said).toEqual([]);
    // 还在取代码时就停掉了
    const u = setup();
    u.w.terminate();
    await settle();
    expect(u.made).toEqual([]);
    expect(u.said).toEqual([]);
  });

  it('data: 地址：UTF-8 再 base64，中文原样；太长时为 null', () => {
    const code = 'const 名字 = "水晶丛林";\nself.postMessage(名字);';
    const url = engineDataUrl(code)!;
    expect(url.startsWith('data:text/javascript;base64,')).toBe(true);
    const bin = atob(url.slice('data:text/javascript;base64,'.length));
    expect(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))).toBe(code);
    expect(engineDataUrl('x'.repeat(1_300_000))).not.toBeNull();
    expect(engineDataUrl('x'.repeat(1_400_000))).toBeNull();
    // 中文按 UTF-8 的字节算（一个字三个字节）
    expect(engineDataUrl('名'.repeat(450_000))).toBeNull();
  });

  it('招呼：只认 {kind:"hello"}，isolated 只认 true', () => {
    expect(readHello({ kind: 'hello', isolated: true })).toEqual({ isolated: true });
    expect(readHello({ kind: 'hello', isolated: 1 })).toEqual({ isolated: false });
    expect(readHello({ kind: 'hello' })).toEqual({ isolated: false });
    expect(readHello({ kind: 'script', isolated: true })).toBeNull();
    expect(readHello(null)).toBeNull();
    expect(readHello('hello')).toBeNull();
    expect(readHello([{ kind: 'hello' }])).toBeNull();
  });
});
