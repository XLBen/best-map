// 国家界面的测速（第八十轮）：在无头 Chrome 里让旧的提交与现在的界面做同样的事，量主线程上的时间。
//   node tools/bench-country-ui.mjs [--against <提交>] [--head <提交>] [--quick] [--keep] [--chrome <Chrome 的路径>]
//     --against：旧的一边（默认 1cd3bea，第七十九轮）；--head：新的一边也是检出的那个提交（默认现在的工作区）；
//     --quick：只用一块地区、少几次；--globe：只用星球；--keep：留下临时目录；--soft：WebGL 按软件画
//   做法同 tools/overlay-ab.mjs：git archive 把提交的 src、core 解到临时目录，esbuild 把 tools/bench-country-ui-page.ts 连同两份界面
//   （地图、底部条、图例、“这里”、抽屉）打成一个脚本，写一个 file:// 页面（带 src/styles.css），Chrome 无界面打开（--dump-dom）。
//   引擎、快照用现在的 core 与 src/worker-snapshot.ts（第八十轮以前的一边按那时的样子给原因数组的新副本），见页面那一半的说明
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const k = argv.indexOf(name);
  return k >= 0 ? argv[k + 1] : def;
};
const against = flag('--against', '1cd3bea');
const headRev = flag('--head', null);
const chrome = flag('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const quick = argv.includes('--quick');
// --globe：只量星球（--quick 只量地区）
const globeOnly = argv.includes('--globe');
const keep = argv.includes('--keep');
// --soft：WebGL 按软件画（SwiftShader，同 overlay-ab）；默认用这台机器的显卡（Metal），贴图上传的时间才像真的
const soft = argv.includes('--soft');

let nm = root;
while (!existsSync(join(nm, 'node_modules', 'zod')) && dirname(nm) !== nm) nm = dirname(nm);
nm = join(nm, 'node_modules');

const dir = mkdtempSync(join(tmpdir(), 'country-ui-'));
// 解出一个提交的 src、core
function extract(rev, name) {
  const tar = execFileSync('git', ['archive', '--format=tar', rev, 'src', 'core'], { cwd: root, maxBuffer: 1 << 30 });
  writeFileSync(join(dir, `${name}.tar`), tar);
  execFileSync('mkdir', ['-p', join(dir, name)]);
  execFileSync('tar', ['-xf', join(dir, `${name}.tar`), '-C', join(dir, name)]);
  symlinkSync(nm, join(dir, name, 'node_modules'));
  return join(dir, name);
}
// 认不认得“原因数组没变”（第八十轮起有 src/worker-snapshot.ts）
const reuses = (base) => existsSync(join(base, 'src', 'worker-snapshot.ts'));
const short = (rev) => execFileSync('git', ['rev-parse', '--short', rev], { cwd: root, encoding: 'utf8' }).trim();

try {
  const oldDir = extract(against, 'base');
  const newDir = headRev ? extract(headRev, 'head') : root;
  symlinkSync(nm, join(dir, 'node_modules'));
  const side = (base, tag) => {
    const p = (f) => JSON.stringify(join(base, f));
    return {
      imports: [
        `import * as S${tag} from ${p('src/state')};`,
        `import * as H${tag} from ${p('src/state/worker-host')};`,
        `import * as N${tag} from ${p('src/state/notes')};`,
        `import * as M${tag} from ${p('src/ui/MapView')};`,
        `import * as A${tag} from ${p('src/ui/CountryArchive')};`,
        `import * as CA${tag} from ${p('src/ui/country-archive')};`,
        `import * as T${tag} from ${p('src/ui/tools/countries')};`,
        `import { ContextBar as CB${tag} } from ${p('src/ui/shell/ContextBar')};`,
        `import { MapLegend as ML${tag} } from ${p('src/ui/shell/MapLegend')};`,
        `import { HereCard as HC${tag} } from ${p('src/ui/shell/HereCard')};`,
        `import { Sheet as SH${tag} } from ${p('src/ui/shell/Sheet')};`,
        `import ${p('src/ui/register-all')};`,
      ].join('\n'),
      obj: (name, reuse) =>
        `{ name: ${JSON.stringify(name)}, reuse: ${reuse}, S: S${tag}, H: H${tag}, N: N${tag}, M: M${tag}, A: A${tag}, CA: CA${tag}, T: T${tag}, Shell: { ContextBar: CB${tag}, MapLegend: ML${tag}, HereCard: HC${tag}, Sheet: SH${tag} } } as never`,
    };
  };
  const o = side(oldDir, 'o');
  const n = side(newDir, 'n');
  const cur = (f) => JSON.stringify(join(root, f));
  writeFileSync(
    join(dir, 'entry.ts'),
    `${o.imports}
${n.imports}
import { run } from ${cur('tools/bench-country-ui-page')};
window.addEventListener('load', () => run(${o.obj(short(against), reuses(oldDir))}, ${n.obj(headRev ? short(headRev) : '现在', reuses(newDir))}, { quick: ${quick}, globe: ${globeOnly} }));
`,
  );
  const esbuild = await import('esbuild');
  // Vite 才认的写法：Worker 的 URL、?raw 等（页面里用不到，给个空的）
  const stub = {
    name: 'vite-stubs',
    setup(b) {
      b.onResolve({ filter: /\?(worker&url|url|raw|worker)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
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
    loader: { '.css': 'empty' },
    plugins: [stub],
  });
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><pre id="o" style="position:relative;z-index:99999;background:#fff">RUNNING</pre><script src="bundle.js"></script></body></html>`);
  const t0 = Date.now();
  const html = execFileSync(
    chrome,
    ['--headless=new', ...(soft ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']), '--window-size=1400,900', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `file://${join(dir, 'index.html')}`],
    { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3600_000 },
  );
  const m = html.match(/<pre id="o"[^>]*>([\s\S]*?)<\/pre>/);
  const text = (m ? m[1] : html.slice(0, 2000)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  console.log(text);
  console.log(`（Chrome ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  process.exitCode = text.includes('DONE') && !text.includes('ERROR') ? 0 : 1;
} finally {
  if (keep) console.log(`临时目录：${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
