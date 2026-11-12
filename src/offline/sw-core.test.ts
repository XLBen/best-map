import { describe, expect, it } from 'vitest';
import { CACHE_PREFIX, KEEP_VERSIONS, META_CACHE, PAGE, type Precache, afterActivate, cacheName, canRegister, filesOf, pageIsFrom, pageUsable, precacheLine, readInfo, readPrecache, readVersions, route } from './sw-core';

// 离线（第一百零一轮）：service worker 的规则——哪个请求怎么答、清单怎么认、旧的缓存留哪几份

const pre: Precache = {
  version: 'abc123def4567890',
  shell: ['index.html', 'assets/index-AAAA.js', 'assets/index-BBBB.css', 'assets/worker-CCCC.js', 'manifest.webmanifest', 'icon.svg'],
  lazy: ['assets/font-1-DDDD.woff2', 'assets/font-2-EEEE.woff2'],
  sums: {},
};
for (const [k, f] of [...pre.shell, ...pre.lazy].entries()) pre.sums[f] = k.toString(16).padStart(64, 'a');
const files = filesOf(pre);
const SCOPE = 'http://localhost:5191/';
const SUB = 'https://example.org/tools/map/';
const get = (url: string, mode = 'cors') => route({ method: 'GET', url, mode }, SCOPE, files);

describe('一个请求怎么答', () => {
  it('刷新、打开这个页面：先问网络，问不到给存下的（带着 ?、# 的也是这个页面）', () => {
    expect(get(SCOPE, 'navigate')).toEqual({ kind: 'page' });
    expect(get(`${SCOPE}index.html`, 'navigate')).toEqual({ kind: 'page' });
    expect(get(`${SCOPE}?smoke#map2-smoke-96`, 'navigate')).toEqual({ kind: 'page' });
    expect(get(`${SCOPE}#demo`, 'navigate')).toEqual({ kind: 'page' });
    // 这一段地址下别的页面（没有这样的页面）不管
    expect(get(`${SCOPE}other.html`, 'navigate')).toEqual({ kind: 'pass' });
    expect(get(`${SCOPE}docs/`, 'navigate')).toEqual({ kind: 'pass' });
  });

  it('程序的文件先看存下的：壳只认这一版自己存的，字体别的版本存过的也能用', () => {
    expect(get(`${SCOPE}assets/index-AAAA.js`, 'cors')).toEqual({ kind: 'file', path: 'assets/index-AAAA.js', mine: true, shared: false });
    expect(get(`${SCOPE}assets/worker-CCCC.js`, 'same-origin')).toEqual({ kind: 'file', path: 'assets/worker-CCCC.js', mine: true, shared: false });
    expect(get(`${SCOPE}manifest.webmanifest`)).toEqual({ kind: 'file', path: 'manifest.webmanifest', mine: true, shared: false });
    expect(get(`${SCOPE}assets/font-2-EEEE.woff2`)).toEqual({ kind: 'file', path: 'assets/font-2-EEEE.woff2', mine: true, shared: true });
    // 不是刷新、打开的 index.html（程序自己不会这样要，要了也给这一版的）
    expect(get(`${SCOPE}index.html`)).toEqual({ kind: 'file', path: PAGE, mine: true, shared: false });
  });

  it('旧页面要旧名字的文件：只看以前的版本存过没有，不存', () => {
    expect(get(`${SCOPE}assets/index-OLD1.js`)).toEqual({ kind: 'file', path: 'assets/index-OLD1.js', mine: false, shared: true });
  });

  it('不拦的：POST、别的网站、这一段地址以外、带着 ? 的、清单里没有的（开发服务器的模块就是这样的）', () => {
    const pass = { kind: 'pass' };
    expect(route({ method: 'POST', url: `${SCOPE}index.html`, mode: 'cors' }, SCOPE, files)).toEqual(pass);
    expect(route({ method: 'POST', url: SCOPE, mode: 'navigate' }, SCOPE, files)).toEqual(pass);
    expect(route({ method: 'HEAD', url: `${SCOPE}assets/index-AAAA.js`, mode: 'cors' }, SCOPE, files)).toEqual(pass);
    expect(get('https://example.com/assets/index-AAAA.js')).toEqual(pass);
    expect(get('http://localhost:5196/assets/index-AAAA.js')).toEqual(pass);
    expect(get('http://localhost:5191/', 'navigate')).toEqual({ kind: 'page' });
    expect(get(`${SCOPE}assets/index-AAAA.js?v=2`)).toEqual(pass);
    expect(get(`${SCOPE}index.html?x=1`)).toEqual(pass);
    for (const dev of ['src/main.tsx', '@vite/client', 'node_modules/.vite/deps/preact.js', '__map2/engine.js', 'src/assets/x.js', 'sw.js']) expect(get(SCOPE + dev), dev).toEqual(pass);
    expect(get('data:text/javascript;base64,AAAA')).toEqual(pass);
    expect(get('不是地址')).toEqual(pass);
  });

  it('放在子路径下：只管那一段地址', () => {
    const at = (url: string, mode = 'cors') => route({ method: 'GET', url, mode }, SUB, files);
    expect(at(SUB, 'navigate')).toEqual({ kind: 'page' });
    expect(at(`${SUB}assets/index-AAAA.js`)).toEqual({ kind: 'file', path: 'assets/index-AAAA.js', mine: true, shared: false });
    expect(at('https://example.org/', 'navigate')).toEqual({ kind: 'pass' });
    expect(at('https://example.org/tools/', 'navigate')).toEqual({ kind: 'pass' });
    expect(at('https://example.org/assets/index-AAAA.js')).toEqual({ kind: 'pass' });
    expect(at('https://example.org/tools/map2/assets/index-AAAA.js')).toEqual({ kind: 'pass' });
  });

  it('网络给的页面：正常的、让转去别处的用；出错的不用', () => {
    expect(pageUsable({ ok: true, type: 'basic' })).toBe(true);
    expect(pageUsable({ ok: false, type: 'opaqueredirect' })).toBe(true);
    expect(pageUsable({ ok: false, type: 'basic' })).toBe(false);
    expect(pageUsable({ ok: false, type: 'error' })).toBe(false);
  });
});

describe('清单', () => {
  it('写成一行、读回来一样', () => {
    const line = precacheLine(pre);
    expect(line.startsWith('self.__MAP2_PRECACHE={')).toBe(true);
    expect(line.endsWith(';\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(readPrecache(JSON.parse(line.slice('self.__MAP2_PRECACHE='.length, -2)))).toEqual(pre);
  });

  it('样子不对的不认', () => {
    expect(readPrecache(undefined)).toBeNull();
    expect(readPrecache(null)).toBeNull();
    expect(readPrecache([])).toBeNull();
    expect(readPrecache({ ...pre, version: '' })).toBeNull();
    expect(readPrecache({ ...pre, version: '../x' })).toBeNull();
    expect(readPrecache({ ...pre, shell: ['assets/a.js'] })).toBeNull();
    expect(readPrecache({ ...pre, shell: ['index.html', '/etc/passwd'] })).toBeNull();
    expect(readPrecache({ ...pre, lazy: ['../outside.woff2'] })).toBeNull();
    expect(readPrecache({ ...pre, lazy: [1] })).toBeNull();
    // 每个文件都要有内容的 sha256
    expect(readPrecache({ ...pre, sums: undefined })).toBeNull();
    expect(readPrecache({ ...pre, sums: [] })).toBeNull();
    expect(readPrecache({ ...pre, sums: { ...pre.sums, 'index.html': 'abc' } })).toBeNull();
    const { 'assets/font-2-EEEE.woff2': _gone, ...less } = pre.sums;
    expect(readPrecache({ ...pre, sums: less })).toBeNull();
  });
});

describe('启用一版之后留哪几份缓存', () => {
  const names = (...v: string[]) => [...v.map(cacheName), META_CACHE, 'someone-else'];

  it('第一次：只有自己', () => {
    expect(afterActivate([], 'v1', null, names('v1'))).toEqual({ activated: ['v1'], drop: [] });
  });

  it('留现在的一版和上一版，更早的删掉；别人的缓存、记事的那一份不碰', () => {
    expect(KEEP_VERSIONS).toBe(2);
    expect(afterActivate(['v1'], 'v2', null, names('v1', 'v2'))).toEqual({ activated: ['v1', 'v2'], drop: [] });
    expect(afterActivate(['v1', 'v2'], 'v3', null, names('v1', 'v2', 'v3'))).toEqual({ activated: ['v2', 'v3'], drop: [cacheName('v1')] });
    expect(afterActivate(['v2', 'v3'], 'v4', null, names('v2', 'v3', 'v4')).drop).not.toContain(META_CACHE);
    expect(META_CACHE.startsWith(CACHE_PREFIX)).toBe(false);
  });

  it('装好了但从没启用过的（被更新的一版顶掉了）删掉；正在装的那一版不删', () => {
    // v2 装好了在等，v3 又来了、先启用：v2 的缓存没用了
    expect(afterActivate(['v1'], 'v3', null, names('v1', 'v2', 'v3'))).toEqual({ activated: ['v1', 'v3'], drop: [cacheName('v2')] });
    // v3 启用的时候 v4 正在装
    expect(afterActivate(['v1', 'v2'], 'v3', 'v4', names('v1', 'v2', 'v3', 'v4'))).toEqual({ activated: ['v2', 'v3'], drop: [cacheName('v1')] });
  });

  it('同一版再启用一次（浏览器把它停了又起）：不重复记', () => {
    expect(afterActivate(['v1', 'v2'], 'v2', null, names('v1', 'v2'))).toEqual({ activated: ['v1', 'v2'], drop: [] });
    expect(afterActivate(['v1', 'v2'], 'v1', null, names('v1', 'v2'))).toEqual({ activated: ['v2', 'v1'], drop: [] });
  });

  it('记着的读出来不对时当作没有', () => {
    expect(readVersions(null)).toEqual([]);
    expect(readVersions('v1')).toEqual([]);
    expect(readVersions(['v1', 2, 'v3'])).toEqual(['v1', 'v3']);
  });
});

describe('页面那一头', () => {
  it('这个页面是不是那一版打包出来的：页面上的脚本都在那一版的壳里', () => {
    expect(pageIsFrom([`${SCOPE}assets/index-AAAA.js`], SCOPE, pre.shell)).toBe(true);
    expect(pageIsFrom([`${SCOPE}assets/index-OLD1.js`], SCOPE, pre.shell)).toBe(false);
    expect(pageIsFrom([`${SCOPE}assets/index-AAAA.js`, `${SCOPE}assets/extra-ZZZZ.js`], SCOPE, pre.shell)).toBe(false);
    // 没有脚本、别处的脚本：说不准，当作不是
    expect(pageIsFrom([], SCOPE, pre.shell)).toBe(false);
    expect(pageIsFrom(['https://cdn.example.com/assets/index-AAAA.js'], SCOPE, pre.shell)).toBe(false);
    expect(pageIsFrom([`${SUB}assets/index-AAAA.js`], SUB, pre.shell)).toBe(true);
    expect(pageIsFrom(['不是地址'], SCOPE, pre.shell)).toBe(false);
  });

  it('service worker 的回话：样子不对的不认', () => {
    expect(readInfo({ version: 'v1', shell: ['index.html'] })).toEqual({ version: 'v1', shell: ['index.html'] });
    expect(readInfo(null)).toBeNull();
    expect(readInfo({ version: 1, shell: [] })).toBeNull();
    expect(readInfo({ version: 'v1', shell: [1] })).toBeNull();
  });

  it('只在打包好的程序、http(s) 下登记', () => {
    expect(canRegister({ prod: true, protocol: 'https:', hasSw: true })).toBe(true);
    expect(canRegister({ prod: true, protocol: 'http:', hasSw: true })).toBe(true);
    // 开发服务器、测试
    expect(canRegister({ prod: false, protocol: 'http:', hasSw: true })).toBe(false);
    // file://（逐字节对照的页面）
    expect(canRegister({ prod: true, protocol: 'file:', hasSw: true })).toBe(false);
    // 浏览器没有
    expect(canRegister({ prod: true, protocol: 'https:', hasSw: false })).toBe(false);
  });
});
