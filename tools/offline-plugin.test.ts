import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { PRECACHE_HEAD as HEAD_IN_SW, precacheLine, readPrecache } from '../src/offline/sw-core';
import { importGraph } from '../src/testing/imports';
import { LICENSES_FILE, PRECACHE_HEAD, SW_FILE, bundleSw, licensesText, listFiles, precacheOf, sha256, swFile, thirdParty } from './offline-plugin';

// 离线（第一百零一轮）：打包时生成的清单、service worker 的那一个文件、第三方许可证的那一份；页面的 manifest 和图标

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e = (path: string, content = path) => ({ path, sha: sha256(content) });

describe('清单', () => {
  const entries = [e('index.html'), e('assets/index-A.js'), e('assets/index-B.css'), e('assets/f-1.woff2'), e('assets/f-2.woff'), e('icon.svg'), e('sw.js'), e('.map2-source-hash'), e('assets/.DS_Store')];

  it('壳是程序的全部文件，字体另算；service worker 自己和点开头的不进', () => {
    const p = precacheOf(entries, '/* sw */');
    expect(p.shell).toEqual(['assets/index-A.js', 'assets/index-B.css', 'icon.svg', 'index.html']);
    expect(p.lazy).toEqual(['assets/f-1.woff2', 'assets/f-2.woff']);
    expect(p.sums['index.html']).toBe(sha256('index.html'));
    expect(Object.keys(p.sums).sort()).toEqual([...p.shell, ...p.lazy].sort());
    expect(p.version).toMatch(/^[0-9a-f]{16}$/);
    // src/offline/sw-core.ts 认得它
    expect(readPrecache(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('版本只看内容：先后不同一样，任何一个文件、service worker 的代码变了就不同', () => {
    const v = precacheOf(entries, '/* sw */').version;
    expect(precacheOf([...entries].reverse(), '/* sw */').version).toBe(v);
    expect(precacheOf(entries.map((x) => (x.path === 'assets/f-1.woff2' ? e(x.path, '改了') : x)), '/* sw */').version).not.toBe(v);
    expect(precacheOf(entries.map((x) => (x.path === 'index.html' ? e(x.path, '改了') : x)), '/* sw */').version).not.toBe(v);
    expect(precacheOf(entries, '/* sw 改了 */').version).not.toBe(v);
    // 不进清单的变了不算
    expect(precacheOf(entries.map((x) => (x.path === '.map2-source-hash' ? e(x.path, '改了') : x)), '/* sw */').version).toBe(v);
  });

  it('没有 index.html 不算打包成了', () => {
    expect(() => precacheOf([e('assets/index-A.js')], '')).toThrow(/index\.html/);
  });

  it('sw.js 的第一行就是清单，写法和 service worker 里读的一样', () => {
    expect(PRECACHE_HEAD).toBe(HEAD_IN_SW);
    const p = precacheOf(entries, 'code();');
    const text = swFile(p, 'code();');
    expect(text.split('\n')[0] + '\n').toBe(precacheLine(p));
    expect(text.endsWith('\ncode();')).toBe(true);
  });
});

describe('service worker 的那一个文件', () => {
  it('src/sw.ts 只引用 offline/sw-core.ts（不带界面、状态、引擎）', () => {
    const files = [...importGraph(resolve(root, 'src/sw.ts'))].map((f) => relative(root, f)).sort();
    expect(files).toEqual(['src/offline/sw-core.ts', 'src/sw.ts']);
  });

  it('打成一个普通的脚本：没有 import / export，接了装、启用、请求、消息四样，不自己顶掉正在用的一版', async () => {
    const code = await bundleSw(root);
    expect(code.length).toBeLessThan(20000);
    // 当普通脚本（不是模块）也读得通
    const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as { body: { type: string }[] };
    expect(ast.body.some((n) => /^(Import|Export)/.test(n.type))).toBe(false);
    for (const ev of ['install', 'activate', 'fetch', 'message']) expect(code, ev).toMatch(new RegExp(`addEventListener\\([\`'"]${ev}[\`'"]`));
    // 存进缓存的两处（装的时候、用到时）都先核对内容：整个文件里 cache.put 只在核对的那一个函数和抄别的版本存过的两处
    expect(code.match(/crypto\.subtle\.digest/g)).toHaveLength(1);
    // skipWaiting 只在收到页面的那句话时调：整个文件里只出现一次
    expect(code.match(/skipWaiting\(/g)).toHaveLength(1);
    expect(code).toMatch(/[`'"]skip-waiting[`'"]/);
  }, 120000);

  it('整个程序打包时 base 是相对的：页面里的地址都以 ./ 开头，带着 manifest、图标、主题色', async () => {
    const out = await build({ root, logLevel: 'silent', build: { write: false, reportCompressedSize: false } });
    const files = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : []));
    const html = files.find((f) => f.fileName === 'index.html');
    const text = html && html.type === 'asset' ? String(html.source) : '';
    const refs = [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(4);
    for (const r of refs) expect(r, r).toMatch(/^\.\//);
    expect(text).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
    expect(text).toContain('<link rel="icon" href="./icon.svg" type="image/svg+xml" />');
    expect(text).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />');
    expect(text).toContain('<meta name="theme-color" content="#15181d" />');
    // 样式里字体的地址也是相对的
    const css = files.find((f) => /^assets\/index-[\w-]+\.css$/.test(f.fileName));
    const cssText = css && css.type === 'asset' ? String(css.source) : '';
    expect(cssText).toMatch(/url\(\.\/lxgwwenkai-/);
    expect(cssText).not.toMatch(/url\(\/assets\//);
    // 只在内存里打包（测试）时不写 dist/：没有许可证的那一份、没有 sw.js
    expect(files.some((f) => f.fileName === LICENSES_FILE || f.fileName === SW_FILE)).toBe(false);
  }, 180000);
});

describe('页面的 manifest 和图标', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8')) as { name: string; display: string; start_url: string; scope: string; theme_color: string; background_color: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };

  it('名字、独立窗口、相对的地址；颜色就是界面的底色', () => {
    expect(manifest.name).toBe('架空世界编辑器');
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain(`<title>${manifest.name}</title>`);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    const bg = /--bg:\s*(#[0-9a-f]{6})/.exec(readFileSync(join(root, 'src/styles.css'), 'utf8'))![1];
    expect(manifest.theme_color).toBe(bg);
    expect(manifest.background_color).toBe(bg);
  });

  it('图标都在 public/ 里，PNG 的大小和写的一样', () => {
    const size = (file: string) => {
      const b = readFileSync(join(root, 'public', file));
      // PNG：8 字节的头，IHDR 里先宽后高
      expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
      return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
    };
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(false);
      expect(existsSync(join(root, 'public', icon.src)), icon.src).toBe(true);
      if (icon.type === 'image/png') expect(size(icon.src)).toBe(icon.sizes);
    }
    expect(manifest.icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
    expect(size('apple-touch-icon.png')).toBe('180x180');
    expect(readFileSync(join(root, 'public/icon.svg'), 'utf8')).toContain('<svg');
  });
});

describe('第三方许可证的那一份', () => {
  const list = thirdParty(root);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; license?: string };

  it('打进程序的库一个不落（连它们各自依赖的），每个都有许可证的原文', () => {
    const names = list.map((t) => t.name);
    for (const d of Object.keys(pkg.dependencies)) expect(names, d).toContain(d);
    // d3-delaunay 带进来的
    expect(names).toContain('delaunator');
    expect(names).toContain('robust-predicates');
    for (const t of list) {
      expect(t.license, t.name).not.toBe('');
      expect(t.texts.length, t.name).toBeGreaterThan(0);
    }
  });

  it('字体带着 OFL 的原文', () => {
    const font = list.find((t) => t.name === 'lxgw-wenkai-webfont')!;
    expect(font.texts.map((x) => x.file)).toContain('OFL.txt');
    const text = licensesText(list);
    expect(text).toContain('SIL Open Font License');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(text).toContain('Permission is hereby granted, free of charge');
  });

  it('README 里的第三方表和 node_modules 里写的许可证对得上', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    // 一行一个：名字、版本、许可证（都和 node_modules 里的一样）
    for (const t of list) expect(readme, t.name).toContain(`| \`${t.name}\` | ${t.version} | ${t.license}`);
    expect(pkg.license).toBe('MIT');
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 XLBen');
  });
});

describe('走一遍目录', () => {
  it('列出全部文件（相对的路径，/ 分隔，排好序）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'map2-offline-'));
    try {
      const files = listFiles(join(root, 'public'));
      expect(files).toEqual([...files].sort());
      expect(files).toContain('manifest.webmanifest');
      expect(listFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
