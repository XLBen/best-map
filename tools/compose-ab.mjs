// 合成着色器逐字节对照（第三十九轮）：在无头 Chrome（SwiftShader）里让旧的提交与现在的渲染器画同样的画面，读回来的像素逐字节比。
//   node tools/compose-ab.mjs [--against <提交>] [--quick] [--time] [--keep] [--chrome <Chrome 的路径>]
//     --against：对照的提交（默认 b4aeaae，第三十八轮）；--quick：只看一种缩放；--keep：留下临时目录（页面、打包好的脚本）；
//     --time：不对照像素，只在大一些的画布上给整张合成计时（SwiftShader 在 CPU 上跑，只能看个大概）
//   做法：git archive 把那个提交的 src、core 解到临时目录，esbuild 把 tools/compose-ab-page.ts 连同两份 renderer.ts 打包成一个脚本，
//   写一个 file:// 页面，Chrome 无界面打开（--dump-dom），页面画完把结果写进 <pre>。不起开发服务器，不进 vitest。
//   退出码：有不同的组时 1
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
const time = argv.includes('--time');
const keep = argv.includes('--keep');

// node_modules 可能在上几层（git worktree 里；worktree 里的 node_modules 可能只有测试的缓存）
let nm = root;
while (!existsSync(join(nm, 'node_modules', 'zod')) && dirname(nm) !== nm) nm = dirname(nm);
nm = join(nm, 'node_modules');

const dir = mkdtempSync(join(tmpdir(), 'compose-ab-'));
try {
  // 旧的提交的 src、core
  const tar = execFileSync('git', ['archive', '--format=tar', against, 'src', 'core'], { cwd: root, maxBuffer: 1 << 30 });
  writeFileSync(join(dir, 'base.tar'), tar);
  execFileSync('mkdir', ['-p', join(dir, 'base')]);
  execFileSync('tar', ['-xf', join(dir, 'base.tar'), '-C', join(dir, 'base')]);
  symlinkSync(nm, join(dir, 'base', 'node_modules'));
  symlinkSync(nm, join(dir, 'node_modules'));
  writeFileSync(
    join(dir, 'entry.ts'),
    `import { Renderer as OldR } from './base/src/render/renderer';
import { Renderer as NewR } from ${JSON.stringify(join(root, 'src/render/renderer'))};
import { run } from ${JSON.stringify(join(root, 'tools/compose-ab-page'))};
window.addEventListener('load', () => run(OldR as never, NewR as never, { quick: ${quick}, time: ${time} }));
`,
  );
  const esbuild = await import('esbuild');
  await esbuild.build({ entryPoints: [join(dir, 'entry.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: join(dir, 'bundle.js'), logLevel: 'warning' });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><pre id="o">RUNNING</pre><script src="bundle.js"></script></body></html>');
  const t0 = Date.now();
  const html = execFileSync(
    chrome,
    ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=3600000', '--dump-dom', `file://${join(dir, 'index.html')}`],
    { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3600_000 },
  );
  const m = html.match(/<pre id="o">([\s\S]*?)<\/pre>/);
  const text = (m ? m[1] : html).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  console.log(text);
  console.log(`（Chrome ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  const done = text.match(/DONE 共 (\d+) 组，不同 (\d+) 组/);
  process.exitCode = time ? (text.includes('DONE 计时') && !text.includes('ERROR') ? 0 : 1) : !done || Number(done[2]) > 0 ? 1 : 0;
} finally {
  if (keep) console.log(`临时目录：${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
