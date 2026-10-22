import { EventEmitter } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { DATA_URL_MAX, engineDataUrl } from '../src/engine-spawn';
import { ENGINE_PATH, bundleEngine, devConnectSrc, isolatedEngine } from './isolated-engine';

// 打包的结果（隔离那一步）：计算 Worker 从 data: 地址开，加载不了别的模块，所以必须是一整个文件
// （没有 import、export、动态 import()，也不用 import.meta）；页面带 CSP。开发时现打包的那份同样要求

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' data: blob:; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'";

// 代码里引用别的模块、用 import.meta 的地方
function moduleLinks(code: string): string[] {
  const found: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const node = n as { type?: unknown } & Record<string, unknown>;
    if (typeof node.type === 'string' && /^(Import|Export)/.test(node.type)) found.push(node.type);
    if (node.type === 'MetaProperty') found.push('import.meta');
    for (const [k, v] of Object.entries(node)) if (k !== 'loc' && v && typeof v === 'object') walk(v);
  };
  walk(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
  return found;
}

const text = (src: string | Uint8Array) => (typeof src === 'string' ? src : new TextDecoder().decode(src));

describe('打包的结果', () => {
  it('打包好的程序：计算 Worker、存储 Worker 各是一整个文件，计算 Worker 能做成 data: 地址；index.html 带 CSP', async () => {
    const out = await build({ root, logLevel: 'silent', build: { write: false, reportCompressedSize: false } });
    const files = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : []));
    const asset = (re: RegExp) => {
      const hit = files.filter((f) => re.test(f.fileName));
      expect(hit, String(re)).toHaveLength(1);
      const f = hit[0];
      return f.type === 'asset' ? text(f.source) : f.code;
    };
    const engine = asset(/^assets\/worker-[\w-]+\.js$/);
    expect(moduleLinks(engine)).toEqual([]);
    expect(engineDataUrl(engine)!.length).toBeLessThan(DATA_URL_MAX);
    // 里面没有 IndexedDB 的读写（只有自查时试开一个库）
    expect(engine).toContain('map2-isolation-probe');
    expect(engine).not.toMatch(/['"]checkpoint['"],\s*['"]readwrite['"]/);
    const storage = asset(/^assets\/storage-worker-[\w-]+\.js$/);
    expect(moduleLinks(storage)).toEqual([]);
    // 存储 Worker 里没有编译脚本的代码
    expect(storage).not.toContain('new Function');
    const html = asset(/^index\.html$/);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    // CSP 在任何脚本之前
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
  });

  it('开发时现打包的引擎：同样是一整个文件，做成 data: 地址不超长', async () => {
    const code = await bundleEngine(root);
    expect(moduleLinks(code)).toEqual([]);
    expect(code).toContain('map2-isolation-probe');
    expect(engineDataUrl(code)!.length).toBeLessThan(DATA_URL_MAX);
  });

  it('开发时 CSP 里加上热更新的 WebSocket（只加本机地址、当前端口）', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;
    expect(devConnectSrc(html, 5191)).toContain("connect-src 'self' ws://localhost:5191 ws://127.0.0.1:5191 ws://[::1]:5191;");
    expect(devConnectSrc(html, null)).toBe(html);
  });
});

// 开发服务器上的 /__map2/engine.js：不真的开服务器，服务器、打包都是假的
describe('开发服务器的引擎文件', () => {
  function fakeServer() {
    const watcher = new EventEmitter();
    const routes = new Map<string, (req: unknown, res: FakeRes) => void>();
    const errors: string[] = [];
    const server = {
      watcher,
      middlewares: { use: (path: string, fn: (req: unknown, res: FakeRes) => void) => routes.set(path, fn) },
      config: { logger: { error: (m: string) => errors.push(m) } },
      httpServer: { address: () => ({ port: 5191 }) },
    };
    return { server, watcher, routes, errors };
  }
  interface FakeRes {
    statusCode: number;
    headers: Record<string, string>;
    body?: string;
    setHeader(k: string, v: string): void;
    end(body?: string): void;
  }
  const get = (handler: (req: unknown, res: FakeRes) => void) =>
    new Promise<FakeRes>((done) => {
      const res: FakeRes = {
        statusCode: 200,
        headers: {},
        setHeader: (k, v) => void (res.headers[k] = v),
        end: (body) => {
          res.body = body;
          done(res);
        },
      };
      handler({}, res);
    });

  it('第一次要时打包，之后用留着的；core/、src/ 下的文件改了就重打，别处的不算；打包失败回 500，下次再试', async () => {
    let builds = 0;
    let fail = false;
    const plugin = isolatedEngine('/proj/', async () => {
      builds++;
      if (fail) throw new Error('语法错误');
      return `// 第 ${builds} 次`;
    });
    const f = fakeServer();
    (plugin.configureServer as (s: unknown) => void)(f.server);
    const route = f.routes.get(ENGINE_PATH)!;
    const first = await get(route);
    expect(first.body).toBe('// 第 1 次');
    expect(first.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(first.headers['Cache-Control']).toBe('no-store');
    expect((await get(route)).body).toBe('// 第 1 次');
    f.watcher.emit('all', 'change', '/proj/README.md');
    f.watcher.emit('all', 'change', '/proj/tools/bench.ts');
    expect((await get(route)).body).toBe('// 第 1 次');
    f.watcher.emit('all', 'change', '/proj/core/rivers.ts');
    expect((await get(route)).body).toBe('// 第 2 次');
    f.watcher.emit('all', 'add', '/proj/src/new.ts');
    fail = true;
    const bad = await get(route);
    expect(bad.statusCode).toBe(500);
    expect(f.errors[0]).toContain('语法错误');
    fail = false;
    expect((await get(route)).body).toBe('// 第 4 次');
    expect(builds).toBe(4);
    // 页面的 CSP：加上开发服务器端口的 WebSocket
    const html = (plugin.transformIndexHtml as (h: string) => string)(`<meta content="connect-src 'self'; img-src 'self'" />`);
    expect(html).toContain("connect-src 'self' ws://localhost:5191 ");
    expect(plugin.apply).toBe('serve');
  });
});
