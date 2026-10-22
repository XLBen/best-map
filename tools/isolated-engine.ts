import { resolve } from 'node:path';
import { type Plugin, type ViteDevServer, build } from 'vite';

// 开发时也把计算 Worker 放进隔离的环境（隔离那一步）：打包好的程序里，主线程取 Vite 单独打包的引擎文件的文字，
// 做成 data: 地址开 Worker（见 src/engine-spawn.ts）。开发服务器上的 Worker 文件引用着一个个模块，data: 地址
// 开的 Worker 加载不了它们，所以这里提供 /__map2/engine.js：现打包成一整个文件（不引用别的模块、不压缩），
// 结果留着，core/、src/ 下的文件一改就作废，下次要时重打。
// 另外：开发时页面的 CSP 再加上开发服务器热更新用的 WebSocket（本机地址、当前端口）。按 CSP 3，connect-src 'self'
// 本来就包括同一主机的 ws:，这里写明，免得有的浏览器不这样认；打包好的程序里没有这一条

export const ENGINE_PATH = '/__map2/engine.js';

// 把 src/worker.ts 连同它引用的全部模块打包成一个文件的文字
export async function bundleEngine(root: string, opts: { minify?: boolean } = {}): Promise<string> {
  const out = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    mode: 'development',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    build: {
      write: false,
      minify: opts.minify ?? false,
      copyPublicDir: false,
      emptyOutDir: false,
      reportCompressedSize: false,
      lib: { entry: resolve(root, 'src/worker.ts'), formats: ['es'], fileName: 'engine' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const chunks = outputs.flatMap((o) => ('output' in o ? o.output : [])).filter((c) => c.type === 'chunk');
  if (chunks.length !== 1) throw new Error(`引擎应当打包成一个文件，实际是 ${chunks.length} 个`);
  return chunks[0].code;
}

// 改了这些地方的文件：打包好的引擎作废
function inSources(root: string, file: string): boolean {
  const rel = file.startsWith(root) ? file.slice(root.length).replace(/^[\\/]+/, '') : '';
  return /^(core|src)[\\/]/.test(rel);
}

// 开发时页面的 CSP 里加上热更新的 WebSocket（只加本机地址、当前端口）
export function devConnectSrc(html: string, port: number | null): string {
  if (!port) return html;
  const extra = [`ws://localhost:${port}`, `ws://127.0.0.1:${port}`, `ws://[::1]:${port}`].join(' ');
  return html.replace("connect-src 'self'", `connect-src 'self' ${extra}`);
}

// bundle：怎么打包（测试换成假的）
export function isolatedEngine(root: string, bundle: (root: string) => Promise<string> = bundleEngine): Plugin {
  // 每改一次文件加一；打包结果记着是哪一次的
  let version = 0;
  let cache: { version: number; code: Promise<string> } | null = null;
  let server: ViteDevServer | null = null;
  const current = (): Promise<string> => {
    if (cache && cache.version === version) return cache.code;
    const code = bundle(root);
    const mine = { version, code };
    cache = mine;
    // 打包失败：下次再试
    code.catch(() => {
      if (cache === mine) cache = null;
    });
    return code;
  };
  return {
    name: 'map2-isolated-engine',
    apply: 'serve',
    configureServer(s) {
      server = s;
      s.watcher.on('all', (_event, file) => {
        if (inSources(root, file)) version++;
      });
      s.middlewares.use(ENGINE_PATH, (_req, res) => {
        current().then(
          (code) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(code);
          },
          (e: unknown) => {
            // 主线程拿不到就退回普通的 Worker（没隔离），把原因写在控制台
            s.config.logger.error(`打包计算 Worker 失败：${(e as Error)?.message ?? e}`);
            res.statusCode = 500;
            res.end();
          },
        );
      });
    },
    transformIndexHtml(html) {
      const addr = server?.httpServer?.address();
      return devConnectSrc(html, addr && typeof addr === 'object' ? addr.port : null);
    },
  };
}
