import { describe, expect, it } from 'vitest';
import { DRAW_FAILS, DrawHealth, MISHAP_QUIET_MS, type MishapInput, MishapLog, classify, signatureOf } from './mishap';

// 第九十六轮：没接住的错怎么分——不管的、顶上说一句的（界面还能用）、整页自救页的（界面画不出来）

const ORIGIN = 'https://map.example';
const at = (i: Partial<MishapInput>): MishapInput => ({ source: 'error', message: 'boom', rendered: true, hasError: true, ...i });

describe('不是这个程序的错、无害的：不管', () => {
  it('别的网站的脚本：只有一句 Script error.，没有文件、没有错误对象', () => {
    expect(classify(at({ message: 'Script error.', hasError: false }), ORIGIN)).toBe('ignore');
    expect(classify(at({ message: 'Script error', hasError: false, filename: '' }), ORIGIN)).toBe('ignore');
    // 带着错误对象的不是那一种
    expect(classify(at({ message: 'Script error.', hasError: true }), ORIGIN)).toBe('minor');
  });

  it('ResizeObserver 的那句警告', () => {
    expect(classify(at({ message: 'ResizeObserver loop limit exceeded' }), ORIGIN)).toBe('ignore');
    expect(classify(at({ message: 'ResizeObserver loop completed with undelivered notifications.' }), ORIGIN)).toBe('ignore');
  });

  it('隔离探针（计算 Worker 自查时故意试的 data:text/plain,x）', () => {
    expect(classify(at({ source: 'rejection', message: "Refused to connect to 'data:text/plain,x' because it violates the following Content Security Policy directive" }), ORIGIN)).toBe('ignore');
    expect(classify(at({ source: 'rejection', message: 'Failed to fetch data:text/plain,x' }), ORIGIN)).toBe('ignore');
  });

  it('浏览器扩展：文件是扩展的，或者调用栈里全是扩展的', () => {
    expect(classify(at({ filename: 'chrome-extension://abcdef/content.js' }), ORIGIN)).toBe('ignore');
    expect(classify(at({ filename: 'moz-extension://123/inject.js' }), ORIGIN)).toBe('ignore');
    expect(classify(at({ source: 'rejection', stack: 'Error: x\n    at f (chrome-extension://abcdef/content.js:1:2)\n    at g (chrome-extension://abcdef/content.js:3:4)' }), ORIGIN)).toBe('ignore');
    expect(classify(at({ source: 'rejection', stack: 'f@safari-web-extension://id/a.js:1:2' }), ORIGIN)).toBe('ignore');
    // 栈里有自己的文件：是自己的错（扩展只是调用了页面里的东西，或者反过来）
    expect(classify(at({ source: 'rejection', stack: `Error: x\n    at f (chrome-extension://abcdef/content.js:1:2)\n    at g (${ORIGIN}/assets/index-abc.js:3:4)` }), ORIGIN)).toBe('minor');
  });

  it('别的来源的脚本', () => {
    expect(classify(at({ filename: 'https://cdn.other.example/widget.js' }), ORIGIN)).toBe('ignore');
    expect(classify(at({ filename: `${ORIGIN}/assets/index-abc.js` }), ORIGIN)).toBe('minor');
    // 自己开的 Worker、自己做的地址
    expect(classify(at({ filename: 'blob:https://map.example/1234' }), ORIGIN)).toBe('minor');
  });

  it('页面是从文件直接打开的（来源是 null）：不是扩展的都算自己的', () => {
    expect(classify(at({ filename: 'file:///Users/me/map/dist/assets/index.js' }), 'null')).toBe('minor');
    expect(classify(at({ source: 'rejection', stack: 'Error: x\n    at f (file:///Users/me/map/dist/assets/index.js:1:2)' }), 'null')).toBe('minor');
    expect(classify(at({ filename: 'chrome-extension://abcdef/content.js' }), 'null')).toBe('ignore');
  });

  it('用户自己取消的（选文件的窗口点了取消）', () => {
    expect(classify(at({ source: 'rejection', name: 'AbortError', message: 'The user aborted a request.' }), ORIGIN)).toBe('ignore');
  });

  it('界面起来以后程序的文件没读到（后来才要的一块）：不整页盖掉', () => {
    expect(classify(at({ source: 'resource', message: 'Failed to load module script: x' }), ORIGIN)).toBe('ignore');
  });
});

describe('界面还能用：顶上说一句', () => {
  it('点击、定时器里抛的错，没接住的 Promise', () => {
    expect(classify(at({ message: "Cannot read properties of undefined (reading 'x')" }), ORIGIN)).toBe('minor');
    expect(classify(at({ source: 'rejection', message: '读不出来' }), ORIGIN)).toBe('minor');
    expect(classify(at({ source: 'rejection', message: 'x', stack: 'Error: x\n    at <anonymous>:1:7' }), ORIGIN)).toBe('minor');
  });

  it('一块（面板、弹窗）画不出来：那一块关上了，别的照常', () => {
    expect(classify(at({ source: 'part' }), ORIGIN)).toBe('minor');
    // 哪怕话像是别人的
    expect(classify(at({ source: 'part', message: 'Script error.', hasError: false }), ORIGIN)).toBe('minor');
  });
});

describe('界面画不出来：整页的自救页', () => {
  it('根上的错误边界接到的', () => {
    expect(classify(at({ source: 'boundary' }), ORIGIN)).toBe('fatal');
    expect(classify(at({ source: 'boundary', message: 'ResizeObserver loop limit exceeded' }), ORIGIN)).toBe('fatal');
  });

  it('界面还没画出来过就出的错（页面是白的）', () => {
    expect(classify(at({ rendered: false }), ORIGIN)).toBe('fatal');
    expect(classify(at({ source: 'rejection', rendered: false }), ORIGIN)).toBe('fatal');
    // 这时候别人的错照样不管
    expect(classify(at({ rendered: false, message: 'Script error.', hasError: false }), ORIGIN)).toBe('ignore');
    expect(classify(at({ rendered: false, filename: 'chrome-extension://abcdef/content.js' }), ORIGIN)).toBe('ignore');
  });

  it('程序的文件没读到、界面还没出来', () => {
    expect(classify(at({ source: 'resource', rendered: false }), ORIGIN)).toBe('fatal');
  });
});

describe('同一个错不反复刷屏', () => {
  it('正显示着的再来只加一；关掉以后一分钟内不再说；过了再说一次', () => {
    let now = 0;
    const log = new MishapLog(() => now);
    expect(log.note('a')).toBe('show');
    expect(log.note('a')).toBe('bump');
    expect(log.note('a')).toBe('bump');
    expect(log.count('a')).toBe(3);
    log.gone();
    now += 1000;
    expect(log.note('a')).toBe('quiet');
    now += MISHAP_QUIET_MS - 1001;
    expect(log.note('a')).toBe('quiet');
    now += 2;
    expect(log.note('a')).toBe('show');
    expect(log.count('a')).toBe(6);
  });

  it('不同的错各说各的；被顶掉的那一个也从那时起安静', () => {
    let now = 0;
    const log = new MishapLog(() => now);
    expect(log.note('a')).toBe('show');
    expect(log.note('b')).toBe('show');
    // a 被 b 顶掉了：马上再来不重新弹
    expect(log.note('a')).toBe('quiet');
    expect(log.note('b')).toBe('bump');
    now += MISHAP_QUIET_MS + 1;
    expect(log.note('a')).toBe('show');
  });

  it('每一帧都抛的同一个错：一千次只说一次', () => {
    let now = 0;
    const log = new MishapLog(() => now);
    let shows = 0;
    for (let k = 0; k < 1000; k++) {
      now += 16;
      const r = log.note('draw');
      if (r === 'show') shows++;
      // 用户中途关掉过
      if (k === 100) log.gone();
    }
    expect(shows).toBe(1);
  });

  it('记号：名字、原话、调用栈的第一处', () => {
    const a = signatureOf({ name: 'TypeError', message: 'x', stack: 'TypeError: x\n    at f (a.js:1:2)\n    at g (a.js:3:4)' });
    const b = signatureOf({ name: 'TypeError', message: 'x', stack: 'TypeError: x\n    at f (a.js:1:2)\n    at h (b.js:9:9)' });
    const c = signatureOf({ name: 'TypeError', message: 'x', stack: 'TypeError: x\n    at k (c.js:1:2)' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(signatureOf({ message: 'x' })).toBe('|x|');
  });
});

describe('地图的一帧画不出来', () => {
  it('偶尔一帧不算；连着几帧才算坏了', () => {
    const h = new DrawHealth();
    for (let k = 0; k < 10; k++) {
      expect(h.fail()).toBe(false);
      expect(h.fail()).toBe(false);
      h.ok();
    }
    expect(h.broken).toBe(false);
    for (let k = 0; k < DRAW_FAILS - 1; k++) expect(h.fail()).toBe(false);
    expect(h.fail()).toBe(true);
    expect(h.broken).toBe(true);
    h.reset();
    expect(h.broken).toBe(false);
    expect(h.fail()).toBe(false);
  });
});
