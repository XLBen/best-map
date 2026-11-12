import { describe, expect, it } from 'vitest';
import { APPLY_WAIT_MS, type ContainerLike, FILL_AFTER_MS, type OfflineDeps, OfflineWatch, type RegLike, type SwLike } from './register';
import type { SwInfo, ToSw } from './sw-core';

// 离线（第一百零一轮）：页面这一头——什么时候登记、新版本什么时候启用、什么时候才告诉界面。浏览器的那几样都是假的

const SCOPE = 'http://localhost:5191/';

class FakeSw implements SwLike {
  sent: ToSw[] = [];
  private fns: (() => void)[] = [];
  constructor(
    public state: string,
    readonly info: SwInfo | null = null,
  ) {}
  postMessage(msg: ToSw) {
    this.sent.push(msg);
  }
  addEventListener(_type: 'statechange', f: () => void) {
    this.fns.push(f);
  }
  to(state: string) {
    this.state = state;
    for (const f of this.fns) f();
  }
}
class FakeReg implements RegLike {
  scope = SCOPE;
  installing: FakeSw | null = null;
  waiting: FakeSw | null = null;
  active: FakeSw | null = null;
  unregistered = 0;
  private fns: (() => void)[] = [];
  addEventListener(_type: 'updatefound', f: () => void) {
    this.fns.push(f);
  }
  async unregister() {
    this.unregistered++;
    return true;
  }
  // 浏览器发现了新的 sw.js，开始装
  found(sw: FakeSw) {
    this.installing = sw;
    for (const f of this.fns) f();
  }
  // 装好了：没有在用的一版就直接启用，有就等着
  installed() {
    const sw = this.installing!;
    this.installing = null;
    if (this.active) {
      this.waiting = sw;
      sw.to('installed');
      return;
    }
    sw.to('installed');
    this.active = sw;
    sw.to('activating');
    sw.to('activated');
  }
}
class FakeContainer implements ContainerLike {
  controller: FakeSw | null = null;
  registered: string[] = [];
  fail = false;
  private fns: (() => void)[] = [];
  constructor(readonly reg: FakeReg | null = new FakeReg()) {}
  async register(url: string) {
    this.registered.push(url);
    if (this.fail || !this.reg) throw new Error('SecurityError');
    return this.reg;
  }
  async getRegistration() {
    return this.reg ?? undefined;
  }
  addEventListener(_type: 'controllerchange', f: () => void) {
    this.fns.push(f);
  }
  // 等着的那一版启用了，接管页面
  takeOver() {
    const sw = this.reg!.waiting!;
    this.reg!.waiting = null;
    this.reg!.active = sw;
    this.controller = sw;
    sw.to('activated');
    for (const f of this.fns) f();
  }
}

function setup(over: { prod?: boolean; protocol?: string; container?: FakeContainer | null; scripts?: string[] } = {}) {
  const log: string[] = [];
  const timers: { f: () => void; ms: number }[] = [];
  const container = over.container === undefined ? new FakeContainer() : over.container;
  const deps: OfflineDeps = {
    prod: over.prod ?? true,
    protocol: over.protocol ?? 'http:',
    container,
    url: './sw.js',
    scripts: () => over.scripts ?? [`${SCOPE}assets/index-OLD.js`],
    ask: async (sw) => (sw as FakeSw).info,
    onReady: () => log.push('ready'),
    onUpdate: () => log.push('update'),
    setTimer: (f, ms) => timers.push({ f, ms }),
  };
  return { watch: new OfflineWatch(deps), log, timers, container, reg: container?.reg ?? null };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const NEW: SwInfo = { version: 'v2', shell: ['index.html', 'assets/index-NEW.js'] };

describe('登记', () => {
  it('开发服务器、file://、没有 service worker 的浏览器：不登记，也不出错', async () => {
    for (const over of [{ prod: false }, { protocol: 'file:' }, { container: null }]) {
      const s = setup(over);
      await s.watch.start();
      expect(s.container?.registered ?? []).toEqual([]);
      expect(s.log).toEqual([]);
    }
  });

  it('开发服务器上：这个地址以前登记过的取消掉（开发时的行为和以前一样）；打包好的程序里不取消', async () => {
    const dev = setup({ prod: false });
    await dev.watch.start();
    expect(dev.reg!.unregistered).toBe(1);
    const none = setup({ prod: false, container: new FakeContainer(null) });
    await none.watch.start();
    const file = setup({ protocol: 'file:' });
    await file.watch.start();
    expect(file.reg!.unregistered).toBe(0);
  });

  it('登记失败：什么都不说，不抛错', async () => {
    const s = setup();
    s.container!.fail = true;
    await expect(s.watch.start()).resolves.toBeUndefined();
    expect(s.log).toEqual([]);
    // 这时点“重新载入”也只是重新载入
    let reloaded = 0;
    s.watch.apply(() => reloaded++);
    expect(reloaded).toBe(1);
  });

  it('第一次装：装好、启用了才说可以离线；不说“有新版本”；过一阵在后台补字体', async () => {
    const s = setup();
    await s.watch.start();
    expect(s.container!.registered).toEqual(['./sw.js']);
    const sw = new FakeSw('installing');
    s.reg!.found(sw);
    expect(s.log).toEqual([]);
    s.reg!.installed();
    await tick();
    expect(s.log).toEqual(['ready']);
    expect(s.timers.map((t) => t.ms)).toEqual([FILL_AFTER_MS]);
    s.timers[0].f();
    expect(sw.sent).toEqual([{ type: 'fill' }]);
  });

  it('已经装过（平常打开）：马上就是可以离线，只说一次', async () => {
    const s = setup();
    s.reg!.active = new FakeSw('activated');
    s.container!.controller = s.reg!.active;
    await s.watch.start();
    expect(s.log).toEqual(['ready']);
  });
});

describe('新版本', () => {
  const running = () => {
    const s = setup();
    s.reg!.active = new FakeSw('activated');
    s.container!.controller = s.reg!.active;
    return s;
  };

  it('在后台装好以后等着：告诉界面，不自己启用', async () => {
    const s = running();
    await s.watch.start();
    const next = new FakeSw('installing', NEW);
    s.reg!.found(next);
    s.reg!.installed();
    await tick();
    expect(s.log).toEqual(['ready', 'update']);
    expect(next.sent).toEqual([]);
    expect(s.reg!.waiting).toBe(next);
  });

  it('打开页面时已经有一版在等：同样告诉界面', async () => {
    const s = running();
    s.reg!.waiting = new FakeSw('installed', NEW);
    await s.watch.start();
    await tick();
    expect(s.log).toEqual(['ready', 'update']);
  });

  it('这个页面本来就是新的一版（联网时刷新拿到的）：马上启用，不用说', async () => {
    const s = setup({ scripts: [`${SCOPE}assets/index-NEW.js`] });
    s.reg!.active = new FakeSw('activated');
    s.container!.controller = s.reg!.active;
    await s.watch.start();
    const next = new FakeSw('installing', NEW);
    s.reg!.found(next);
    s.reg!.installed();
    await tick();
    expect(next.sent).toEqual([{ type: 'skip-waiting' }]);
    expect(s.log).toEqual(['ready']);
  });

  it('问不出它是哪一版（等不到回话）：当作这个页面是旧的', async () => {
    const s = running();
    await s.watch.start();
    const next = new FakeSw('installing', null);
    s.reg!.found(next);
    s.reg!.installed();
    await tick();
    expect(s.log).toEqual(['ready', 'update']);
    expect(next.sent).toEqual([]);
  });

  it('点“重新载入”：先让等着的那一版启用，它接管了才重新载入', async () => {
    const s = running();
    await s.watch.start();
    const next = new FakeSw('installing', NEW);
    s.reg!.found(next);
    s.reg!.installed();
    await tick();
    let reloaded = 0;
    s.watch.apply(() => reloaded++);
    expect(next.sent).toEqual([{ type: 'skip-waiting' }]);
    expect(reloaded).toBe(0);
    s.container!.takeOver();
    expect(reloaded).toBe(1);
    // 到点的那一下不再重新载入第二次
    for (const t of s.timers.filter((x) => x.ms === APPLY_WAIT_MS)) t.f();
    expect(reloaded).toBe(1);
  });

  it('等不到它接管：到点照样重新载入', async () => {
    const s = running();
    await s.watch.start();
    const next = new FakeSw('installing', NEW);
    s.reg!.found(next);
    s.reg!.installed();
    await tick();
    let reloaded = 0;
    s.watch.apply(() => reloaded++);
    expect(reloaded).toBe(0);
    s.timers.find((x) => x.ms === APPLY_WAIT_MS)!.f();
    expect(reloaded).toBe(1);
  });

  it('别的页面已经让它启用了：这个页面不被重新载入，点“重新载入”时直接重新载入', async () => {
    const s = running();
    await s.watch.start();
    const next = new FakeSw('installing', NEW);
    s.reg!.found(next);
    s.reg!.installed();
    await tick();
    let reloaded = 0;
    s.container!.takeOver();
    expect(reloaded).toBe(0);
    expect(s.log).toEqual(['ready', 'update']);
    s.watch.apply(() => reloaded++);
    expect(reloaded).toBe(1);
    expect(next.sent).toEqual([]);
  });

  it('连着来两版：只说一次', async () => {
    const s = running();
    await s.watch.start();
    for (const v of ['v2', 'v3']) {
      const next = new FakeSw('installing', { ...NEW, version: v });
      s.reg!.found(next);
      s.reg!.installed();
      await tick();
    }
    expect(s.log).toEqual(['ready', 'update']);
  });
});
