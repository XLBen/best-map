import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MishapNote, RescueKind } from './crash-host';

// 第九十六轮：没接住的错的接线——不致命的交给顶上的一条（同一个错不反复刷屏），致命的交给整页的自救页（只一次）

type Host = typeof import('./crash-host');
let host: Host;
let minor: MishapNote[];
let fatal: [RescueKind, string][];
let win: { listeners: Map<string, ((ev: unknown) => void)[]>; addEventListener: (type: string, f: (ev: unknown) => void, capture?: boolean) => void };
const fire = (type: string, ev: unknown, which = 0) => win.listeners.get(type)![which](ev);
// 这个程序自己的文件里抛的错（测试里新建的 Error，调用栈写的是测试文件的地址：换成页面上的样子）
const err = (message: string, at = 'f'): Error => {
  const e = new Error(message);
  e.stack = `Error: ${message}\n    at ${at} (https://map.example/assets/index-a.js:1:2)`;
  return e;
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('location', { origin: 'https://map.example' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host = await import('./crash-host');
  minor = [];
  fatal = [];
  host.crashHooks.minor = (n) => minor.push(n);
  host.crashHooks.fatal = (kind, reason) => fatal.push([kind, reason]);
  host.crashState.rendered = true;
  win = {
    listeners: new Map(),
    addEventListener(type, f, capture) {
      const key = capture ? `${type}:capture` : type;
      this.listeners.set(key, [...(this.listeners.get(key) ?? []), f]);
    },
  };
  host.installCrashHandlers(win as unknown as Window);
});

describe('不致命的', () => {
  it('点击里抛的错：顶上说一句，带着翻成的人话和原话（连调用栈）', () => {
    const e = new TypeError("Cannot read properties of undefined (reading 'x')");
    e.stack = "TypeError: Cannot read properties of undefined (reading 'x')\n    at onClick (https://map.example/assets/index-a.js:1:2)";
    fire('error', { error: e, message: `Uncaught ${e.message}`, filename: 'https://map.example/assets/index-a.js' });
    expect(fatal).toEqual([]);
    expect(minor.length).toBe(1);
    expect(minor[0].human).toEqual({ text: '程序内部出错', detail: "TypeError: Cannot read properties of undefined (reading 'x')" });
    expect(minor[0].detail).toBe(e.stack);
    expect(minor[0].count).toBe(1);
  });

  it('没接住的 Promise', () => {
    fire('unhandledrejection', { reason: err('读不出“我的库”') });
    expect(minor.map((m) => m.human.text)).toEqual(['读不出“我的库”']);
  });

  it('同一个错再来：还是那一条，只加次数；关掉以后一分钟内不再说', () => {
    const e = new Error('坏了');
    e.stack = 'Error: 坏了\n    at f (https://map.example/a.js:1:1)';
    fire('error', { error: e });
    fire('error', { error: e });
    fire('error', { error: e });
    expect(minor.map((m) => [m.id, m.count])).toEqual([
      [minor[0].id, 1],
      [minor[0].id, 2],
      [minor[0].id, 3],
    ]);
    host.mishapGone();
    fire('error', { error: e });
    expect(minor.length).toBe(3);
    // 别的错照说，编号不一样
    fire('error', { error: err('另一个', 'g') });
    expect(minor.length).toBe(4);
    expect(minor[3].id).not.toBe(minor[0].id);
  });

  it('一块画不出来：带着那一块的名字', () => {
    expect(host.report('part', err('x'), { part: '资源库' })).toBe('minor');
    expect(minor[0].part).toBe('资源库');
  });

  it('不是这个程序的、无害的：什么都不说', () => {
    fire('error', { message: 'Script error.', filename: '', error: null });
    fire('error', { message: 'ResizeObserver loop completed with undelivered notifications.', error: null });
    fire('error', { error: new Error('x'), filename: 'chrome-extension://abc/content.js' });
    fire('unhandledrejection', { reason: Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }) });
    fire('unhandledrejection', { reason: new TypeError('Failed to fetch data:text/plain,x') });
    expect(minor).toEqual([]);
    expect(fatal).toEqual([]);
  });

  it('界面起来以后，后来才要的程序文件没读到：不整页盖掉', () => {
    fire('error:capture', { target: { tagName: 'SCRIPT', src: 'https://map.example/assets/later.js' } });
    expect(fatal).toEqual([]);
  });
});

describe('致命的', () => {
  it('根上的错误边界接到的：整页的自救页，只出一次；之后的错不再处理', () => {
    expect(host.report('boundary', new Error('渲染出错'))).toBe('fatal');
    expect(fatal.length).toBe(1);
    expect(fatal[0][0]).toBe('crash');
    expect(fatal[0][1]).toContain('渲染出错');
    expect(host.crashState.fatal).toBe(true);
    expect(host.report('boundary', new Error('又一个'))).toBe('ignore');
    fire('error', { error: new Error('后面的') });
    expect(fatal.length).toBe(1);
    expect(minor).toEqual([]);
  });

  it('界面还没画出来过就出的错：页面是白的', () => {
    host.crashState.rendered = false;
    fire('error', { error: err('模块载入出错') });
    expect(fatal.map((f) => f[0])).toEqual(['crash']);
  });

  it('程序的脚本、样式没读到、界面还没出来', () => {
    host.crashState.rendered = false;
    // 图片没读到不算
    fire('error:capture', { target: { tagName: 'IMG', src: 'https://map.example/a.png' } });
    expect(fatal).toEqual([]);
    fire('error:capture', { target: { tagName: 'SCRIPT', src: 'https://map.example/assets/index-a.js' } });
    expect(fatal.length).toBe(1);
    expect(fatal[0][1]).toContain('index-a.js');
  });

  it('浏览器画不了地图：另一种整页的说明', () => {
    host.reportNoWebgl(new Error('浏览器不支持 WebGL2'));
    expect(fatal).toEqual([['no-webgl', expect.stringContaining('浏览器不支持 WebGL2')]]);
    // 之后别的错不再盖一层
    expect(host.report('boundary', new Error('x'))).toBe('ignore');
  });
});
