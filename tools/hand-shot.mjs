// 手绘画风的截图与叠加层计时（第八十七轮）：在无头 Chrome（SwiftShader）里画一块地区的手绘画风，存两张 PNG，量叠加层的时间。
//   node tools/hand-shot.mjs [--out <目录>] [--quick] [--keep] [--chrome <Chrome 的路径>]
//     --out：PNG 存到哪里（默认 out/hand-shot）；--quick：少量几次；--keep：留下临时目录
//   做法同 tools/overlay-ab.mjs：esbuild 把 tools/hand-shot-page.ts 连同现在的渲染器、叠加层打包成一个脚本，写一个 file:// 页面，
//   Chrome 无界面打开（--dump-dom），页面画完把结果写进 <pre>，截图是 data: 地址。不起开发服务器
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const k = argv.indexOf(name);
  return k >= 0 ? argv[k + 1] : def;
};
const chrome = flag('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const outDir = resolve(flag('--out', join(root, 'out', 'hand-shot')));
const quick = argv.includes('--quick');
const keep = argv.includes('--keep');

let nm = root;
while (!existsSync(join(nm, 'node_modules', 'zod')) && dirname(nm) !== nm) nm = dirname(nm);
nm = join(nm, 'node_modules');

const dir = mkdtempSync(join(tmpdir(), 'hand-shot-'));
try {
  symlinkSync(nm, join(dir, 'node_modules'));
  writeFileSync(join(dir, 'entry.ts'), `import { run } from ${JSON.stringify(join(root, 'tools/hand-shot-page'))};\nwindow.addEventListener('load', () => run({ quick: ${quick} }));\n`);
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
    ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `file://${join(dir, 'index.html')}`],
    { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3600_000 },
  );
  const m = html.match(/<pre id="o">([\s\S]*?)<\/pre>/);
  const text = (m ? m[1] : html).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  console.log(text);
  mkdirSync(outDir, { recursive: true });
  for (const [, k, data] of html.matchAll(/<pre id="png(\d+)">data:image\/png;base64,([A-Za-z0-9+/=]+)<\/pre>/g)) {
    const file = join(outDir, `hand-${k}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`存了 ${file}`);
  }
  console.log(`（Chrome ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  process.exitCode = text.includes('DONE') && !text.includes('ERROR') ? 0 : 1;
} finally {
  if (keep) console.log(`临时目录：${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
