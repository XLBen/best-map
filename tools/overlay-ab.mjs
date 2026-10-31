// 叠加层与排版的前后对照（第四十轮）：在无头 Chrome 里让旧的提交与现在的叠加层画同样的画面，计时、读回像素比。
//   node tools/overlay-ab.mjs [--against <提交>] [--quick] [--keep] [--chrome <Chrome 的路径>]
//     --against：对照的提交（默认 b4aeaae，第三十八轮；第三十九轮没改叠加层）；--quick：只用一块地区、少几次；--keep：留下临时目录
//   做法同 tools/compose-ab.mjs：git archive 把那个提交的 src、core 解到临时目录，esbuild 把 tools/overlay-ab-page.ts 连同两份
//   overlay.ts（与国家的档案、列表）打成一个脚本，写一个 file:// 页面，Chrome 无界面打开（--dump-dom），结果写进 <pre>。
//   画布按 2 倍像素（Mac 的屏幕），软件画（willReadFrequently），每次画完读回一个像素，量到的是主线程上画叠加层的全部时间。
//   退出码：直接画的像素与旧的不同时 1
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const k = argv.indexOf(name);
  return k >= 0 ? argv[k + 1] : def;
};
const against = flag('--against', 'b4aeaae');
const chrome = flag('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const quick = argv.includes('--quick');
const keep = argv.includes('--keep');

let nm = root;
while (!existsSync(join(nm, 'node_modules', 'zod')) && dirname(nm) !== nm) nm = dirname(nm);
nm = join(nm, 'node_modules');

const dir = mkdtempSync(join(tmpdir(), 'overlay-ab-'));
try {
  const tar = execFileSync('git', ['archive', '--format=tar', against, 'src', 'core'], { cwd: root, maxBuffer: 1 << 30 });
  writeFileSync(join(dir, 'base.tar'), tar);
  execFileSync('mkdir', ['-p', join(dir, 'base')]);
  execFileSync('tar', ['-xf', join(dir, 'base.tar'), '-C', join(dir, 'base')]);
  symlinkSync(nm, join(dir, 'base', 'node_modules'));
  symlinkSync(nm, join(dir, 'node_modules'));
  const cur = (p) => JSON.stringify(join(root, p));
  writeFileSync(
    join(dir, 'entry.ts'),
    `import * as OldO from './base/src/render/overlay';
import * as NewO from ${cur('src/render/overlay')};
import * as OldA from './base/src/ui/CountryArchive';
import * as NewA from ${cur('src/ui/CountryArchive')};
import * as OldL from './base/src/ui/panels/countries';
import * as NewL from ${cur('src/ui/panels/countries')};
import * as OldS from './base/src/state';
import * as NewS from ${cur('src/state')};
import * as OldT from './base/src/ui/tools/countries';
import * as NewT from ${cur('src/ui/tools/countries')};
import { run } from ${cur('tools/overlay-ab-page')};
window.addEventListener('load', () => run({ O: OldO, A: OldA, L: OldL, S: OldS, T: OldT } as never, { O: NewO, A: NewA, L: NewL, S: NewS, T: NewT } as never, { quick: ${quick} }));
`,
  );
  const esbuild = await import('esbuild');
  // Vite 才认的写法：引擎的地址、Worker 的 URL（页面里用不到，给个空的）
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
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><pre id="o">RUNNING</pre><div id="ui"></div><script src="bundle.js"></script></body></html>');
  const t0 = Date.now();
  const html = execFileSync(
    chrome,
    ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-device-scale-factor=2', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `file://${join(dir, 'index.html')}`],
    { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3600_000 },
  );
  const m = html.match(/<pre id="o">([\s\S]*?)<\/pre>/);
  const text = (m ? m[1] : html).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  console.log(text);
  console.log(`（Chrome ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  process.exitCode = text.includes('DONE') && !text.includes('ERROR') && !/直接画与旧的不同 [1-9]/.test(text) ? 0 : 1;
} finally {
  if (keep) console.log(`临时目录：${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
