// 一键开启：双击根目录的「启动-Mac.command」「启动-Windows.bat」时运行的就是这个（直接用 node 跑，不用先装别的）。
// 1. 检查 Node 的版本；2. 第一次（或 package-lock.json 改过）先装依赖；3. 地图已经开着就只打开浏览器；
// 4. 否则先打包（源码没变时跳过，见 sourceHash），再用打包好的程序开地图（vite preview），等它能打开了再打开浏览器。
//    打包好的程序比开发服务器快，而且检查点（打开时直接恢复，不必重放所有步）只在有版本号时写。打包失败时退回开发服务器。
//    关掉这个窗口（或按 Ctrl+C）地图就停了。改代码时用 npm run dev（开发服务器，热更新）。
// 地址固定是 http://localhost:5191：浏览器按地址保存世界，换了地址就看不到之前自动保存的世界。
// 测试用：MAP2_PORT 换端口，MAP2_NO_OPEN=1 不打开浏览器
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.MAP2_PORT) || 5191;
const url = `http://localhost:${port}/`;
const win = process.platform === 'win32';
// 页面的标题，用来认出端口上开着的是不是这个地图
const TITLE = '<title>架空世界编辑器</title>';

function stop(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

// Vite 8 要 Node 20.19 以上（或 22.12 以上）
function nodeOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22 || major === 21;
}

function run(cmd, args) {
  return new Promise((done) => {
    // Windows 上的 npm 是 npm.cmd，要经过命令行才能运行
    const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: win });
    p.on('exit', (code) => done(code === 0));
    p.on('error', () => done(false));
  });
}

// 用这个 Node 运行（不经过命令行：Node 的路径里可能有空格）
function runNode(args) {
  return new Promise((done) => {
    const p = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    p.on('exit', (code) => done(code === 0));
    p.on('error', () => done(false));
  });
}

// 依赖没装、或者 package-lock.json 比上次装的时候新（比如更新过代码）：装一次
function needInstall() {
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const stamp = join(root, 'node_modules', '.package-lock.json');
  if (!existsSync(vite) || !existsSync(stamp)) return true;
  return statSync(join(root, 'package-lock.json')).mtimeMs > statSync(stamp).mtimeMs;
}

// 端口上的情况：'map'（地图已经开着）、'other'（被别的程序占了）、'free'
async function probe() {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return (await res.text()).includes(TITLE) ? 'map' : 'other';
  } catch {
    return 'free';
  }
}

function openBrowser() {
  if (process.env.MAP2_NO_OPEN) return;
  const [cmd, args] = win
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: win }).unref();
}

if (!nodeOk()) {
  stop(`Node.js 版本太旧（现在是 ${process.versions.node}）。请到 https://nodejs.org 下载安装 LTS 版，再双击启动。`);
}

const state = await probe();
if (state === 'map') {
  console.log(`地图已经开着，正在打开浏览器：${url}`);
  openBrowser();
  process.exit(0);
}
if (state === 'other') {
  stop(`端口 ${port} 被别的程序占用了。关掉那个程序再双击启动。`);
}

if (needInstall()) {
  console.log('第一次启动：正在安装需要的组件（要联网，大约一两分钟）…');
  if (!(await run('npm', ['install', '--no-audit', '--no-fund']))) {
    stop('安装失败。检查网络后再双击启动试一次。');
  }
}

// 打包要看的源码：src、core 下的文件（测试除外），页面、依赖的版本与打包设置。内容的哈希一样就不必重新打包
const SOURCES = ['src', 'core', 'index.html', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', join('tools', 'isolated-engine.ts'), 'public'];
const STAMP = join(root, 'dist', '.map2-source-hash');
function sourceHash() {
  const h = createHash('sha256');
  const add = (abs) => {
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) add(join(abs, name));
      return;
    }
    if (/\.test\.tsx?$/.test(abs)) return;
    h.update(relative(root, abs).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(abs));
    h.update('\0');
  };
  for (const s of SOURCES) add(join(root, s));
  return h.digest('hex');
}

const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const hash = sourceHash();
let built = existsSync(join(root, 'dist', 'index.html')) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === hash;
if (!built) {
  console.log('正在打包地图（代码更新后第一次要一会儿）…');
  built = await runNode([vite, 'build', '--logLevel', 'error']);
  if (built) writeFileSync(STAMP, hash);
  else console.log('打包没有成功，改用开发模式开启（慢一些，打开世界时要从头算）。');
}

console.log('正在开启地图…');
const args = built ? [vite, 'preview', '--port', String(port), '--strictPort'] : [vite, '--port', String(port), '--strictPort'];
const server = spawn(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => server.kill(sig));

// 等地图能打开了再打开浏览器（最多等一分钟）
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if ((await probe()) === 'map') {
    console.log(`\n地图开好了：${url}\n用完关掉这个窗口（或按 Ctrl+C）就停止。世界会自动保存在浏览器里，重要的世界请用「世界 → 保存」另存一份文件。\n`);
    openBrowser();
    break;
  }
}
