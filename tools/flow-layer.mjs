// 风向、洋流两个图层（第四十八轮）的帧时间与看不看得清：在无头 Chrome 里量（file://，不起服务器）。
//   node tools/flow-layer.mjs [--quick] [--soft] [--only frames|contrast] [--png <目录>] [--chrome <Chrome 的路径>]
//     --quick：只用一块地区、少几次；--soft：帧时间连软件光栅化一起量；--only：只量帧时间，或只量看不看得清；--png：把看不看得清那几张图写进目录
//   做法同 tools/overlay-ab.mjs：esbuild 打包 tools/flow-layer-page.ts，Chrome 无界面打开（--dump-dom），结果写进 <pre>。画布按 2 倍像素
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const k = argv.indexOf(name);
  return k >= 0 ? argv[k + 1] : def;
};
const chrome = flag('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const quick = argv.includes('--quick');
const soft = argv.includes('--soft');
const only = flag('--only', '');
const pngDir = flag('--png', '');

let nm = root;
while (!existsSync(join(nm, 'node_modules', 'zod')) && dirname(nm) !== nm) nm = dirname(nm);
nm = join(nm, 'node_modules');

const dir = mkdtempSync(join(tmpdir(), 'flow-layer-'));
try {
  symlinkSync(nm, join(dir, 'node_modules'));
  writeFileSync(
    join(dir, 'entry.ts'),
    `import { run } from ${JSON.stringify(join(root, 'tools/flow-layer-page'))};
window.addEventListener('load', () => run({ quick: ${quick}, soft: ${soft}, png: ${!!pngDir}, only: ${JSON.stringify(only)} }));
`,
  );
  const esbuild = await import('esbuild');
  const stub = {
    name: 'vite-stubs',
    setup(b) {
      b.onResolve({ filter: /\?worker&url$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
    },
  };
  await esbuild.build({
    entryPoints: [join(dir, 'entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: join(dir, 'bundle.js'),
    logLevel: 'error',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { 'import.meta.env': '{"DEV":false,"BASE_URL":"/"}', 'import.meta.url': '"file:///x"' },
    plugins: [stub],
  });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><pre id="o">RUNNING</pre><script src="bundle.js"></script></body></html>');
  const t0 = Date.now();
  const html = execFileSync(
    chrome,
    ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-device-scale-factor=2', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `file://${join(dir, 'index.html')}`],
    { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3600_000 },
  );
  const m = html.match(/<pre id="o">([\s\S]*?)<\/pre>/);
  const text = (m ? m[1] : html).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  console.log(text);
  if (pngDir) {
    mkdirSync(pngDir, { recursive: true });
    for (const p of html.matchAll(/<pre id="png-([^"]+)">data:image\/png;base64,([^<]+)<\/pre>/g)) writeFileSync(join(pngDir, `${p[1]}.png`), Buffer.from(p[2], 'base64'));
  }
  console.log(`（Chrome ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  process.exitCode = text.includes('DONE') && !text.includes('ERROR') ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
