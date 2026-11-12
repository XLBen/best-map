// 冒烟（第九十四轮）：在无头 Chrome 里把打包好的程序真的走一遍——新建 → 画一笔 → 刷新后还在。
//   node tools/smoke.mjs [--chrome <Chrome 的路径>] [--keep] [--show] [--shots <目录>]
//     环境变量 MAP2_SMOKE_CHROME_ARGS：另外给 Chrome 的参数（空格隔开；自动化检查的机器上用 --no-sandbox）
//     --keep：留下临时目录（Chrome 的用户目录）；--show：不用无头，看着它跑；
//     --shots：把几处界面截成图存进那个目录（第二个页面顶上的那一条、“世界”菜单的第一行），给人看排版
//     --only 12 / --only 13 / --only 14 / --only 15 / --only 16：新建以后直接走第十二段 / 第十三段 / 第十四段 / 第十五段 / 第十六段（改那一段时用，约一两分钟；交差要跑全的）
//   要先打包（npm run build）：用的是 dist/。不进 vitest（要 Chrome）。
//   做法：自己起一个只绑 127.0.0.1、随机空闲端口的静态服务器（跑完就关；不碰 5191 / 5196），Chrome 开在一个临时的用户目录里，
//   经调试端口（WebSocket，Node 自带的）点页面、拖鼠标、读浏览器里存的自动保存。
//   走的几步：
//     1. 新建（#demo 的小世界）→ 等第一次自动保存；
//     2. 在地图上画一笔陆地 → 等自动保存多一步 → 刷新 → 世界还在、那一笔还在（陆地的数组逐字节相同）；
//     3. 再画一笔，世界一变就马上刷新（不等 1.5 秒）→ 那一笔还在（关页面时同步写的那一下）；有没存的改动时浏览器先问了一句；
//     4. 再画一笔，马上把页面关掉、另开一个 → 那一笔还在；
//     5. 同一个地址再开一个页面 → 它顶上有“这个世界已在另一个页面打开”，原来的页面没有；点“在这里接着做”→ 换过来；
//        换过来以后这个页面画的存得进去，原来那个页面画的存不进去；写的那个页面关了，接着它存下的那一份做的页面不用点就接着保存；
//     6. 把存着的一步改成引擎不认识的命令（装“上次的世界打不开”）→ 刷新 → 不进向导，停在“上次的世界没能打开”的问话上（写着原因）；
//        点“新建”、在向导里建一个新世界 → 原来那一份在“留着的旧世界”里（写着没能打开和原因），顶上有一条说它还留着；
//     7. 把存着的命令删掉一条（装“没存完整”）→ 刷新 → 不当没有：挪进“留着的旧世界”，向导上面说“没存完整……存下的部分还留着”。
//   第九十五轮加的（插在中间）：
//     2b. 第一次自动保存之后已经留了一份以前的版本；“世界 → 以前的版本…”里有它；再画一笔、点“回到这一份”→ 世界回到那时的样子，
//         回去之前的样子也留了一份（再点它能回来）；
//     2c. 存到电脑上的文件：真的选择框无头浏览器点不了——把 showSaveFilePicker 换成给一个浏览器自己管的文件（OPFS）的句柄，
//         别的都是真的：点“世界 → 存到电脑上的文件…”→ 文件里就是世界文件；再画一笔 → 过一阵文件跟着变；刷新后还接着写；
//         装成“要重新给权限”→ 顶上有“没在写”的一条、不写；点“接着存到…”→ 写；“不再存到这个文件”→ 不再写；
//     5b. 写的那一页刷新（锁空出来过一下）时，世界不一样的那一页不说“已在另一个页面打开”，说“这个页面里的是旧的”，
//         主要的按钮是“重新载入”；点它 → 这个页面打开保存的那一份，原来的样子留在以前的版本里。
//   第九十六轮加的（接在后面）：不白屏、不卡死。下载都拦住（页面里记下文件名和内容，不真的下载；浏览器那边也设成不许下载）。
//     8. 计算程序卡住：经调试协议在计算 Worker 里跑一段忙等（不用程序配合，普通用户碰不到）→ 画一笔 → 几秒后“正在计算…”旁出现“停止”；
//        这时点“世界 → 世界文件（.json）”→ 几秒内拿到文件（到最后一条应答过的命令为止），顶上说还在算的那一步不在里面；
//        点“停止”→ 说“已停止，回到了这一步之前”，世界还在（陆地逐字节相同）；再画一笔照常；
//     9. WebGL 的上下文丢了（WEBGL_lose_context）→ 地图上盖一层“画面暂时不可用，正在恢复…”→ 恢复 → 画面和丢之前逐字节相同；
//        丢了不还 → 等一阵说“画面没能恢复”和世界存好了没有、有“重新载入”→ 之后还了照样恢复；
//    10. 没接住的错（定时器里抛）→ 顶上一条人话的提示，同一个错连着来只有一条，“原因”里是原话；一块画不出来 → 只关那一块；
//        整个界面画不出来（src/smoke-hooks.ts 的钩子：只在网址带 #map2-smoke-96 时才有）→ 整页的自救页，写着世界还在，
//        “导出文件”拿得到世界文件，“重新载入”后世界还在；
//    11. 启动时：记着连着两次没打开成 → 先问，不直接打开；打开卡住（冒烟把发给计算 Worker 的“打开”吞掉）→ 几秒后能“停止”→ 进向导、
//        那一份还在；浏览器画不了地图（把 webgl2 换成拿不到）→ 整页的说明，已有的世界还能导出；
//        程序的主体一运行就出错（第一次找 #app 说没有）→ 不是白的，是自救页，导出的是浏览器里存着的那一份。
//   第九十七轮加的（接在后面，写在 tools/smoke-progress.mjs）：生成的进度与取消。
//    12. 平常画一笔不闪进度条；开着一个世界时在向导里新建（整个星球、带人文）→ 约 1 秒后向导里出现步名、进度条、“取消”（页面上只有这一个）；步名在变、进度只增不减；
//        点“取消”→ 说“已取消，回到了原来的世界”，每一个数组逐字节不变；再完整生成一次 → 步名一步一步换、做完之前没画到头、
//        做完以后进度条和“取消”都没了，新世界照常自动保存；把计算 Worker 发“走到哪一步了”的那一下拖慢（调试协议）后画一笔 →
//        顶上出现进度条和“取消”→ 点了说“已取消，世界回到了这一步之前”，数组逐字节不变，计算程序还是原来那一个。
//   第九十六轮的第 8、11 段跟着改了：按钮叫“取消”，1 秒左右就出现（以前叫“停止”，5 秒没动静才出现）。
//   第九十八轮加的（接在后面，写在 tools/smoke-start.mjs）：第一次打开一键开始、重新生成前的确认。另开一个存储是空的浏览器环境：
//    13. 第一屏（1280×800、1024×700）六张缩略图、“自定义…”、“帮助”都在窗口里，不用滚动；没有世界时点“帮助”、按 ? 能开能关；
//        点一张 → 世界生成；再开向导、展开“自定义…”、什么都不改、点同一张 → 逐字节相同；在输入框里打 ? 不开帮助；
//        “文化 ⋯ → 重新生成”没有手改时不问就做；用人口笔刷手改几格后：只重新生成人文（留着手改的格）不问，换一个库重新生成
//        （不留）问、数对、点“先不”世界不变；“删除人文”的问话里写着国家、城市、道路的个数。
//   第九十九轮加的（接在后面，写在 tools/smoke-simple.mjs）：简单界面与帮助。另开一个存储是空的浏览器环境：
//    14. 一打开是简单界面（数得出每一类露着几个工具，藏着的那几排末尾有“还有 N 个”）；藏着的工具按它的数字键能用、露出来；
//        “还有 N 个”只展开这一排；“图层”“调整”里也只露常用的；打开一份没划分过省份的世界文件 → 省份只露“选择”，
//        点“划分省份”→ 画笔、剪刀自己露出来；“更多 → 偏好 → 完整界面”打开后全都在，刷新后还记着；
//        帮助最上面是现在这个工具，搜得到、没搜到时说一句，在搜索框里打 ? 不关帮助；向导里“回到缩略图”不挪动向导。
//   第一百轮加的（接在后面，写在 tools/smoke-touch.mjs）：触摸与平板。另开一个存储是空的浏览器环境，平板大小的视口，调试协议的触摸：
//    15. 768×1024：手指点一张缩略图建世界；粗指针下顶栏、底部条、滑块、面板里可点的都不小于 44 像素；一指画一笔（多一步）；
//        两指捏合、平移（镜头变了、没有多一步）；画到一半第二指落下（不算）；touchcancel（不算，之后还能画）；长按钉住“这里”；
//        “多选”开关；768×1024 和 1024×768 下顶栏、底部条、图层、资源库、帮助、向导、问话框都在视口里、没有横向溢出；
//        宽 390 时最上面说一句“屏幕太窄”。
//   第一百零一轮加的（接在后面，写在 tools/smoke-offline.mjs）：离线能用。另起一个把 dist/ 放在子路径下的服务器，另开一个存储是空的浏览器环境：
//    16. 打开一次 → service worker 装好、壳都存下、字体在后台补齐；画一笔、等自动保存；把那个服务器真的停掉 → 刷新 → 页面打开、
//        世界还在、还能画一笔；在原来的端口上起一份“新版本”→ 旧页面顶上说“有新版本，重新载入后用上”，没有被换掉、照常能画；
//        另开的页面拿到的就是新版本；旧页面要它那一版的文件还拿得到；点“重新载入”→ 用上新版本、世界还在；再停服务器也打得开。
//   service worker 在了以后前十五段照旧（它们没有哪一步靠“把请求挡掉”：都是往页面里注入脚本、换网址上的 ? 重新载入）。
//   退出码：有没过的 1
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineSteps } from './smoke-offline.mjs';
import { progressSteps } from './smoke-progress.mjs';
import { safetySteps } from './smoke-safety.mjs';
import { simpleSteps } from './smoke-simple.mjs';
import { startSteps } from './smoke-start.mjs';
import { touchSteps } from './smoke-touch.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const k = argv.indexOf(name);
  return k >= 0 ? argv[k + 1] : def;
};
const chromePath = flag('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const keep = argv.includes('--keep');
const show = argv.includes('--show');
const only = flag('--only', null);
// 只走一段时走完就停（不算没过）
const DONE = Symbol('走完了');
const shots = flag('--shots', null);
if (shots) mkdirSync(shots, { recursive: true });

if (!existsSync(join(dist, 'index.html'))) {
  console.error('没有 dist/：先 npm run build');
  process.exit(2);
}
if (!existsSync(chromePath)) {
  console.error(`找不到 Chrome：${chromePath}（用 --chrome 指定）`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 静态服务器（只绑 127.0.0.1，端口让系统挑） ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = normalize(join(dist, path === '/' ? 'index.html' : path));
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- Chrome 与调试端口 ----------

const profile = mkdtempSync(join(tmpdir(), 'map2-smoke-'));
const chrome = spawn(
  chromePath,
  [
    ...(show ? [] : ['--headless=new']),
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    ...(process.env.MAP2_SMOKE_CHROME_ARGS ?? '').split(' ').filter(Boolean),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function debugUrl() {
  const file = join(profile, 'DevToolsActivePort');
  for (let k = 0; k < 200; k++) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(50);
  }
  throw new Error('Chrome 没有开起来');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`));
        else w?.resolve(m.result);
        return;
      }
      for (const h of this.handlers) h(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(h) {
    this.handlers.push(h);
  }
}

// 一个页面
class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    // 浏览器问“要离开吗”（有没存的改动时）的次数；都点“离开”
    this.leaveAsked = 0;
    this.errors = [];
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Page.javascriptDialogOpening') {
        if (m.params.type === 'beforeunload') this.leaveAsked++;
        void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '出错');
    });
  }
  // context：另一个浏览器环境（存储是空的、和别的页面不相干；第九十八轮的第十三段用）
  static async open(cdp, url, context) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', ...(context ? { browserContextId: context } : {}) });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(cdp, targetId, sessionId);
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    // 第一次建好世界会弹出帮助：这里不要它挡着
    await p.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('map2.seenHelp', '1'); } catch {}" });
    await p.send('Page.navigate', { url });
    return p;
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  // 等到 expression 的值是真的；等不到抛错
  async until(what, expression, ms = 60000) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (e) {
        // 页面正在换（刷新中）：再等
        last = String(e.message ?? e);
      }
      await sleep(50);
    }
    throw new Error(`等不到：${what}（最后是 ${JSON.stringify(last)}）`);
  }
  // 截一张图（给了 --shots 才截）
  async shot(name) {
    if (!shots) return;
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  }
  mouse(type, x, y, buttons = 1) {
    return this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  }
}

// ---------- 页面里用的几句 ----------

// 有世界了，而且不在算
const READY = `(() => { const w = window.__map2 && window.__map2.world(); return !!w && !document.querySelector('.notice .spinner'); })()`;
// 陆地那个数组的摘要（那一笔画没画上、刷新后是不是同一个世界，看它）
const LAND = `(() => { const w = window.__map2 && window.__map2.world(); if (!w) return null; const a = new Uint8Array(w.causes.land.buffer, w.causes.land.byteOffset, w.causes.land.byteLength); let h = 2166136261; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + ':' + a.length; })()`;
// 浏览器里存着的自动保存的头（几步、谁写的、第几代）；还没有时 null。库还没建时不去开它（开了会建一个空的）
const HEAD = `(async () => {
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === 'map2')) return null;
  return await new Promise((resolve) => {
    const open = indexedDB.open('map2');
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(null); return; }
      const req = db.transaction('kv', 'readonly').objectStore('kv').get('autosave');
      req.onsuccess = () => { const m = req.result; db.close(); resolve(m ? { count: m.count, writer: m.writer || null, gen: m.gen || 0 } : null); };
      req.onerror = () => { db.close(); resolve(null); };
    };
  });
})()`;
const BANNER = `(() => [...document.querySelectorAll('.notices .notice.banner .notice-text')].map((e) => e.textContent).find((t) => t.includes('另一个页面')) || null)()`;
// 第九十五轮：以前的版本（versions 表）：每一份是哪个世界的、为什么留的、几步；最近留的在前
const VERSIONS = `(async () => await new Promise((resolve) => {
  const open = indexedDB.open('map2');
  open.onerror = () => resolve([]);
  open.onsuccess = () => {
    const db = open.result;
    db.onversionchange = () => db.close();
    if (!db.objectStoreNames.contains('versions')) { db.close(); resolve([]); return; }
    const req = db.transaction('versions', 'readonly').objectStore('versions').getAll();
    req.onsuccess = () => { db.close(); resolve(req.result.sort((a, b) => b.at - a.at).map((v) => ({ id: v.id, series: v.series, why: v.why, steps: v.steps, thumb: !!v.thumb }))); };
    req.onerror = () => { db.close(); resolve([]); };
  };
}))()`;
// 点“世界”菜单里的一行（按名字找）；菜单没开就先开
const menuItem = (name) => `(async () => {
  const find = () => [...document.querySelectorAll('.menu .item')].find((x) => (x.querySelector('b')?.textContent ?? '') === ${JSON.stringify(name)});
  if (!find()) { const b = document.querySelector('.topbar button[data-panel="world"]'); if (!b) throw new Error('找不到“世界”按钮'); b.click(); await new Promise((r) => setTimeout(r, 200)); }
  const it = find();
  if (!it) throw new Error('“世界”菜单里找不到：' + ${JSON.stringify(name)});
  return { disabled: !!it.disabled, hint: it.querySelector('.hint')?.textContent ?? '' };
})()`;
const clickMenuItem = (name) => `(async () => { const info = await ${menuItem(name)}; [...document.querySelectorAll('.menu .item')].find((x) => (x.querySelector('b')?.textContent ?? '') === ${JSON.stringify(name)}).click(); return info; })()`;
const closeMenu = `(() => { if (document.querySelector('.menu')) document.querySelector('.topbar button[data-panel="world"]').click(); })()`;
// “以前的版本”弹窗里的各行
const VERSION_ROWS = `(() => { const m = [...document.querySelectorAll('.modal.maps')].find((x) => (x.querySelector('h2, h3')?.textContent ?? '').includes('以前的版本')); return m ? [...m.querySelectorAll('.file-row')].map((r) => ({ when: r.querySelector('.file-name b')?.textContent ?? '', note: r.querySelector('.hint')?.textContent ?? '', buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()) })) : null; })()`;
// 存到电脑上的文件：选择框换成给一个浏览器自己管的文件（真的句柄、真的写）；ASK_AGAIN：装成“这次打开页面要重新给权限”
const FAKE_PICKER = `window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('smoke-world.json', { create: true });`;
const ASK_AGAIN = `(() => { let ok = false; FileSystemFileHandle.prototype.queryPermission = async () => (ok ? 'granted' : 'prompt'); FileSystemFileHandle.prototype.requestPermission = async () => { ok = true; return 'granted'; }; })();`;
// 那个文件里现在的内容（几步、多少字）；还没有时 null
const FILE = `(async () => { try { const h = await (await navigator.storage.getDirectory()).getFileHandle('smoke-world.json'); const t = await (await h.getFile()).text(); if (!t) return { steps: -1, chars: 0 }; const d = JSON.parse(t); return { steps: d.commands.length, chars: t.length, format: d.format }; } catch (e) { return null; } })()`;
const FILE_BANNER = `(() => [...document.querySelectorAll('.notices .notice.banner')].find((e) => e.textContent.includes('没在写')) ? [...document.querySelectorAll('.notices .notice.banner')].find((e) => e.textContent.includes('没在写')).querySelector('.notice-text').textContent : null)()`;
const FILE_LINE = `(async () => { if (!document.querySelector('.menu')) { document.querySelector('.topbar button[data-panel="world"]').click(); await new Promise((r) => setTimeout(r, 200)); } const l = document.querySelector('.menu .file-line'); return l ? { text: l.querySelector('.hint').textContent, buttons: [...l.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`;
const BADGE = `(() => { const b = document.querySelector('.topbar .tb-badge.warn'); return b ? b.getAttribute('title') : null; })()`;
// 留着的旧世界（backups 表）：每一份为什么留着、几步、原因
const BACKUPS = `(async () => await new Promise((resolve) => {
  const open = indexedDB.open('map2');
  open.onerror = () => resolve([]);
  open.onsuccess = () => {
    const db = open.result;
    db.onversionchange = () => db.close();
    const req = db.transaction('backups', 'readonly').objectStore('backups').getAll();
    req.onsuccess = () => { db.close(); resolve(req.result.map((b) => ({ why: b.why || b.age, steps: b.steps, error: b.error || null }))); };
    req.onerror = () => { db.close(); resolve([]); };
  };
}))()`;
// 改存着的自动保存的一条命令（value 为 null 时删掉这一条）
const tamper = (index, value) => `(async () => await new Promise((resolve, reject) => {
  const open = indexedDB.open('map2');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    db.onversionchange = () => db.close();
    const tx = db.transaction('autosave', 'readwrite');
    ${value === null ? `tx.objectStore('autosave').delete(${index});` : `tx.objectStore('autosave').put(${JSON.stringify(value)}, ${index});`}
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  };
}))()`;
const ASK = `(() => { const m = document.querySelector('.modal.ask'); return m ? { title: m.querySelector('h3')?.textContent ?? '', text: m.querySelector('p.muted')?.textContent ?? '', note: m.querySelector('.ask-note')?.textContent ?? '', buttons: [...m.querySelectorAll('.ask-actions button')].map((b) => b.textContent) } : null; })()`;
const KEPT_NOTE = `(() => [...document.querySelectorAll('.notices .notice.banner .notice-text, .backup-note')].map((e) => e.textContent).find((t) => t.includes('留着')) || null)()`;
const count = async (p) => (await p.eval(HEAD))?.count ?? 0;
// 等这个页面自己写过一次自动保存（刚打开时整份重写的那一次：头里“谁写的”换成它）。之后关页面的那一下它才同步写得了
const ownWrite = (p, prevWriter) => p.until('这个页面自己写过一次', `(${HEAD}).then((h) => (h && h.writer && h.writer !== ${JSON.stringify(prevWriter)} ? h : null))`, 30000);

// 在地图上画一笔陆地：选“地形”一类（默认的工具就是画陆地），从左到右拖过地图中间
async function stroke(p, row = 0.5) {
  await p.eval(`(() => { const b = [...document.querySelectorAll('.topbar button.tb-btn')].find((x) => x.title === '地形'); if (!b) throw new Error('找不到“地形”按钮'); b.click(); })()`);
  const box = await p.eval(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const y = box.y + box.h * row;
  const x0 = box.x + box.w * 0.3;
  const x1 = box.x + box.w * 0.7;
  await p.mouse('mouseMoved', x0, y, 0);
  await p.mouse('mousePressed', x0, y);
  for (let k = 1; k <= 16; k++) {
    await p.mouse('mouseMoved', x0 + ((x1 - x0) * k) / 16, y);
    await sleep(15);
  }
  await p.mouse('mouseReleased', x1, y, 0);
}

// ---------- 走一遍 ----------

let failed = 0;
const pass = (what) => console.log(`  通过  ${what}`);
const fail = (what, why) => {
  failed++;
  console.log(`  没过  ${what}${why ? `：${why}` : ''}`);
};
const check = (ok, what, why) => (ok ? pass(what) : fail(what, why));

let ws;
try {
  ws = new WebSocket(await debugUrl());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('连不上 Chrome 的调试端口')));
  });
  const cdp = new Cdp(ws);
  const t0 = Date.now();

  console.log(`冒烟：${origin}（dist/，无头 Chrome）`);
  console.log('1. 新建');
  let p = await Page.open(cdp, `${origin}/#demo`);
  await p.until('世界生成好', READY, 120000);
  const n0 = await p.until('第一次自动保存', `(${HEAD}).then((h) => (h && h.count > 0 ? h.count : 0))`, 30000);
  const land0 = await p.eval(LAND);
  check(n0 > 0 && !!land0, `新建了一个世界，自动保存了 ${n0} 步`);
  check((await p.eval(BADGE)) === null, '顶栏没有“没保存”的记号');
  if (only === '12') {
    await progressSteps({ cdp, q: p, origin, check, sleep, stroke, count, READY, LAND, HEAD, ASK, clickMenuItem });
    check(p.errors.length === 0, '页面里没有没接住的错', p.errors.slice(0, 3).join('；'));
    console.log(`${failed ? `没过 ${failed} 项` : '都通过'}（只走了第 1、12 段，${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    throw DONE;
  }
  if (only === '13') {
    await startSteps({ cdp, Page, origin, check, sleep, READY, HEAD, ASK, clickMenuItem });
    console.log(`${failed ? `没过 ${failed} 项` : '都通过'}（只走了第 1、13 段，${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    throw DONE;
  }
  if (only === '14') {
    await simpleSteps({ cdp, Page, origin, check, sleep, READY, HEAD, ASK, clickMenuItem, tmp: profile });
    console.log(`${failed ? `没过 ${failed} 项` : '都通过'}（只走了第 1、14 段，${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    throw DONE;
  }
  if (only === '15') {
    await touchSteps({ cdp, Page, origin, check, sleep, READY, HEAD });
    console.log(`${failed ? `没过 ${failed} 项` : '都通过'}（只走了第 1、15 段，${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    throw DONE;
  }
  if (only === '16') {
    await offlineSteps({ cdp, Page, dist, tmp: profile, check, sleep, stroke, READY, LAND, HEAD });
    console.log(`${failed ? `没过 ${failed} 项` : '都通过'}（只走了第 1、16 段，${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    throw DONE;
  }

  console.log('2. 画一笔 → 等自动保存 → 刷新');
  await stroke(p, 0.5);
  await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land0)}`, 60000);
  await p.until('自动保存多了一步', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 1})`, 30000);
  await p.until('算完', READY, 60000);
  const land1 = await p.eval(LAND);
  check(land1 !== land0, '画了一笔：陆地变了');
  let writer = (await p.eval(HEAD)).writer;
  const asked1 = p.leaveAsked;
  await p.send('Page.navigate', { url: `${origin}/` });
  await p.until('刷新后世界打开', READY, 120000);
  check(p.leaveAsked === asked1, '都存好了的时候刷新：浏览器没有问“要离开吗”');
  check((await p.eval(LAND)) === land1, '刷新后世界还在，那一笔还在（陆地逐字节相同）', `刷新前 ${land1}，刷新后 ${await p.eval(LAND)}`);
  check((await count(p)) === n0 + 1, `存着的还是 ${n0 + 1} 步`, `是 ${await count(p)} 步`);

  console.log('2b. 以前的版本');
  writer = (await ownWrite(p, writer)).writer;
  // 自动留的：新建后第一次自动保存留一份；刚才刷新打开时又留一份（同一个 5 分钟里平常留的只剩最新的，所以是 1 或 2 份）
  const vers0 = await p.until('留了以前的版本', `(${VERSIONS}).then((l) => (l.some((v) => v.steps === ${n0 + 1}) ? l : null))`, 20000).catch(() => []);
  check(vers0.length >= 1 && vers0.every((v) => v.series.startsWith('w:')), `不用点保存，自动留了 ${vers0.length} 份（没存进“我的地图”的世界也有）：${vers0.map((v) => `${v.why} ${v.steps} 步${v.thumb ? ' 带缩略图' : ''}`).join('；')}`, JSON.stringify(vers0));
  const target = vers0.find((v) => v.steps === n0 + 1);
  // 再画一笔（之后回到没有这一笔的那一份）
  await stroke(p, 0.35);
  await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land1)}`, 60000);
  await p.until('自动保存多了一步', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 2})`, 30000);
  await p.until('算完', READY, 60000);
  const landX = await p.eval(LAND);
  const item = await p.eval(clickMenuItem('以前的版本…'));
  check(!item.disabled && /\d+ 份/.test(item.hint), `“世界”菜单里“以前的版本…”能点（${item.hint}）`, JSON.stringify(item));
  const rows = await p.until('以前的版本的弹窗', VERSION_ROWS, 10000).catch(() => null);
  check(!!rows && rows.length === vers0.length && rows.every((r) => r.when.startsWith('今天') && /\d+ 步/.test(r.note) && r.buttons.includes('回到这一份')), `弹窗里 ${rows?.length} 行，写着时间、几步，有“回到这一份”（${rows?.map((r) => `${r.when} · ${r.note}`).join('；')}）`, JSON.stringify(rows));
  await p.shot('以前的版本');
  const clickRow = (text) => `(() => { const m = [...document.querySelectorAll('.modal.maps')].find((x) => (x.querySelector('h2, h3')?.textContent ?? '').includes('以前的版本')); const row = [...m.querySelectorAll('.file-row')].find((r) => r.querySelector('.hint').textContent.includes(${JSON.stringify(text)})); if (!row) throw new Error('找不到那一行：' + ${JSON.stringify(text)}); [...row.querySelectorAll('button')].find((b) => b.textContent.includes('回到这一份')).click(); })()`;
  await p.eval(clickRow(`${n0 + 1} 步`));
  await p.until('回到了少一笔的样子', `(${LAND}) === ${JSON.stringify(land1)}`, 120000).catch(() => null);
  await p.until('算完', READY, 60000);
  check(!!target && (await p.eval(LAND)) === land1, '“回到这一份”：世界回到那时的样子（陆地逐字节相同）', `现在 ${await p.eval(LAND)}，那时 ${land1}`);
  const vers1 = await p.until('回去之前的样子也留了一份', `(${VERSIONS}).then((l) => (l.some((v) => v.why === 'before-restore') ? l : null))`, 20000).catch(() => []);
  const before = vers1.find((v) => v.why === 'before-restore');
  check(!!before && before.steps === n0 + 2 && before.series === target?.series, `回去之前的样子（${before?.steps} 步）也留了一份，记在同一个世界上`, JSON.stringify(vers1));
  await p.until('回去以后自动保存', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 1})`, 30000);
  // 反悔：回到“回去之前留的”那一份
  await p.eval(clickMenuItem('以前的版本…'));
  await p.until('以前的版本的弹窗', VERSION_ROWS, 10000);
  await p.shot('以前的版本-回去之后');
  await p.eval(clickRow('回去之前留的'));
  await p.until('又回到多一笔的样子', `(${LAND}) === ${JSON.stringify(landX)}`, 120000).catch(() => null);
  await p.until('算完', READY, 60000);
  check((await p.eval(LAND)) === landX, '回去本身能反悔：再回到“回去之前留的”那一份，那一笔又在了');
  await p.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 2})`, 30000);
  // 撤销这一笔（后面几步照旧从 n0 + 1 步、land1 接着走）
  await p.eval(`document.querySelector('.topbar button[aria-label="撤销"]').click()`);
  await p.until('撤销了', `(${LAND}) === ${JSON.stringify(land1)}`, 60000);
  await p.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 1})`, 30000);
  await p.until('算完', READY, 60000);

  console.log('2c. 存到电脑上的文件（选择框换成浏览器自己管的文件，别的是真的）');
  await p.eval(FAKE_PICKER);
  const fileItem = await p.eval(menuItem('存到电脑上的文件…'));
  check(!fileItem.disabled, `“世界”菜单里“存到电脑上的文件…”能点（${fileItem.hint}）`, JSON.stringify(fileItem));
  await p.eval(clickMenuItem('存到电脑上的文件…'));
  const file1 = await p.until('文件写下了', `(${FILE}).then((f) => (f && f.steps > 0 ? f : null))`, 20000).catch(() => null);
  check(!!file1 && file1.steps === n0 + 1 && file1.format === 'map2-world', `选好就写了一次：文件里是世界文件（${file1?.steps} 步，${file1?.chars} 字）`, JSON.stringify(file1));
  const line1 = await p.eval(FILE_LINE);
  check(!!line1 && line1.text.startsWith('也存在电脑上：smoke-world.json') && line1.buttons.includes('不再存到这个文件'), `“世界”菜单里写着：“${line1?.text}”`, JSON.stringify(line1));
  await p.shot('世界菜单-也存在电脑上');
  await p.eval(closeMenu);
  // 再画一笔：自动保存之后文件跟着变（节流 10 秒）
  const tStroke = Date.now();
  await stroke(p, 0.35);
  await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land1)}`, 60000);
  const file2 = await p.until('文件跟着变', `(${FILE}).then((f) => (f && f.steps === ${n0 + 2} ? f : null))`, 40000).catch(() => null);
  check(!!file2, `再画一笔：${((Date.now() - tStroke) / 1000).toFixed(1)} 秒后文件里也是 ${n0 + 2} 步`, JSON.stringify(await p.eval(FILE)));
  await p.until('算完', READY, 60000);
  await p.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 2})`, 30000);
  // 撤销这一笔（后面几步照旧从 n0 + 1 步、land1 接着走）
  await p.eval(`document.querySelector('.topbar button[aria-label="撤销"]').click()`);
  await p.until('撤销了', `(${LAND}) === ${JSON.stringify(land1)}`, 60000);
  await p.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 1})`, 30000);
  await p.until('文件也跟上', `(${FILE}).then((f) => !!f && f.steps === ${n0 + 1})`, 40000).catch(() => null);
  check((await p.eval(FILE))?.steps === n0 + 1, '撤销以后文件也跟着回到少一步');
  // 刷新：浏览器自己管的文件不用重新给权限——接着写
  await p.send('Page.navigate', { url: `${origin}/` });
  await p.until('刷新后世界打开', READY, 120000);
  const line2 = await p.until('刷新后还连着那个文件', `(${FILE_LINE}).then((l) => (l && l.text.includes('smoke-world.json') ? l : null))`, 20000).catch(() => null);
  check(!!line2 && line2.text.startsWith('也存在电脑上'), `刷新后还记着那个文件，接着写（“${line2?.text}”）`, JSON.stringify(line2));
  await p.eval(closeMenu);
  check((await p.eval(FILE_BANNER)) === null, '能写的时候顶上没有“没在写”的那一条');
  // 装成“这次打开页面要重新给权限”：刷新后没在写、看得出来；点了才写
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: ASK_AGAIN }).then((r) => (p.askAgainScript = r.identifier));
  await p.send('Page.navigate', { url: `${origin}/` });
  await p.until('刷新后世界打开', READY, 120000);
  const paused = await p.until('顶上有“没在写”的一条', FILE_BANNER, 20000).catch(() => null);
  check(!!paused && paused.includes('smoke-world.json'), `要重新给权限时顶上一直有一条：“${paused}”`, '没有出现');
  const line3 = await p.eval(FILE_LINE);
  check(!!line3 && line3.text === '没在写文件：smoke-world.json' && line3.buttons.some((b) => b.startsWith('接着存到')), `“世界”菜单里写着“${line3?.text}”，有“接着存到…”`, JSON.stringify(line3));
  await p.shot('没在写文件');
  await p.eval(closeMenu);
  await stroke(p, 0.35);
  await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land1)}`, 60000);
  await p.until('自动保存多一步', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 2})`, 30000);
  await sleep(1500);
  check((await p.eval(FILE))?.steps === n0 + 1, '没点之前不写：文件里还是原来的');
  await p.eval(`(() => { const b = [...document.querySelectorAll('.notices .notice.banner button')].find((x) => x.textContent.includes('接着存到')); if (!b) throw new Error('找不到“接着存到”'); b.click(); })()`);
  const file3 = await p.until('点了以后写', `(${FILE}).then((f) => (f && f.steps === ${n0 + 2} ? f : null))`, 20000).catch(() => null);
  check(!!file3, '点“接着存到 smoke-world.json”：马上写了', JSON.stringify(await p.eval(FILE)));
  check((await p.until('那一条消失', `(${FILE_BANNER}) === null`, 10000).catch(() => false)) !== false, '那一条消失');
  // 不再存到这个文件
  await p.eval(FILE_LINE);
  await p.eval(`(() => { const b = [...document.querySelectorAll('.menu .file-line button')].find((x) => x.textContent.includes('不再存到这个文件')); if (!b) throw new Error('找不到“不再存到这个文件”'); b.click(); })()`);
  await p.until('状态一行没了', `!document.querySelector('.menu .file-line')`, 10000).catch(() => null);
  await p.eval(closeMenu);
  await p.eval(`document.querySelector('.topbar button[aria-label="撤销"]').click()`);
  await p.until('撤销了', `(${LAND}) === ${JSON.stringify(land1)}`, 60000);
  await p.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count === ${n0 + 1})`, 30000);
  await sleep(1500);
  check((await p.eval(FILE))?.steps === n0 + 2, '“不再存到这个文件”以后不再写（文件留在原处）', JSON.stringify(await p.eval(FILE)));
  if (p.askAgainScript) await p.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: p.askAgainScript });
  await p.send('Page.navigate', { url: `${origin}/` });
  await p.until('刷新后世界打开', READY, 120000);
  check((await p.eval(LAND)) === land1 && (await count(p)) === n0 + 1, `接着往下走：世界还是 ${n0 + 1} 步的那一个`);
  check((await p.eval(FILE_BANNER)) === null && (await p.eval(FILE_LINE)) === null, '刷新后不再提那个文件');
  await p.eval(closeMenu);

  console.log('3. 再画一笔，世界一变就马上刷新（不等 1.5 秒）');
  writer = (await ownWrite(p, writer)).writer;
  await stroke(p, 0.4);
  await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land1)}`, 60000);
  const changedAt = Date.now();
  const land2 = await p.eval(LAND);
  const before2 = await count(p);
  const asked2 = p.leaveAsked;
  await p.send('Page.navigate', { url: `${origin}/` });
  const waited = Date.now() - changedAt;
  await p.until('刷新后世界打开', READY, 120000);
  console.log(`     （世界变了以后 ${waited} 毫秒发出刷新；那时存着 ${before2} 步）`);
  check(before2 === n0 + 1 ? true : before2 === n0 + 2, `刷新之前平常的自动保存还没轮到（存着 ${before2} 步）`);
  check((await p.eval(LAND)) === land2, '刷新后那一笔还在（关页面时写下的）', `刷新前 ${land2}，刷新后 ${await p.eval(LAND)}`);
  check((await count(p)) === n0 + 2, `存着 ${n0 + 2} 步`, `是 ${await count(p)} 步`);
  check(p.leaveAsked > asked2, '有没存的改动时刷新：浏览器先问了“要离开吗”', '没有问（无头 Chrome 里页面没有“用户操作过”时不问）');

  console.log('4. 再画一笔，马上关掉页面、另开一个');
  writer = (await ownWrite(p, writer)).writer;
  await stroke(p, 0.6);
  await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land2)}`, 60000);
  const land3 = await p.eval(LAND);
  // 关页面（照浏览器关标签页那样，会先走 beforeunload）
  await p.send('Page.close').catch(() => {});
  await sleep(500);
  p = await Page.open(cdp, `${origin}/`);
  await p.until('另开的页面里世界打开', READY, 120000);
  check((await p.eval(LAND)) === land3, '关掉再开，那一笔还在', `关之前 ${land3}，再开 ${await p.eval(LAND)}`);
  check((await count(p)) === n0 + 3, `存着 ${n0 + 3} 步`, `是 ${await count(p)} 步`);

  console.log('5. 同一个地址再开一个页面');
  const head1 = await ownWrite(p, writer);
  let q = await Page.open(cdp, `${origin}/`);
  await q.until('第二个页面里世界打开', READY, 120000);
  const banner = await q.until('第二个页面顶上的那一条', BANNER, 20000).catch(() => null);
  check(!!banner, `第二个页面说：“${banner}”`, '没有出现');
  check((await p.eval(BANNER)) === null, '第一个页面没有这一条');
  check(/另一个页面/.test((await q.eval(BADGE)) ?? ''), `第二个页面顶栏“世界”旁有记号（${await q.eval(BADGE)}）`);
  await q.shot('第二个页面-顶上的一条');
  if (shots) {
    // “世界”菜单的第一行
    await q.eval(`document.querySelector('.topbar .tb-badge.warn').click()`);
    await sleep(300);
    await q.shot('第二个页面-世界菜单');
    await q.eval(`document.querySelector('.topbar .tb-badge.warn').click()`);
    await q.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await q.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(200);
  }
  // 第二个页面画一笔：存不进去
  const landQ0 = await q.eval(LAND);
  await stroke(q, 0.45);
  await q.until('第二个页面这一笔画上了', `(${LAND}) !== ${JSON.stringify(landQ0)}`, 60000);
  await sleep(2500);
  const head2 = await p.eval(HEAD);
  check(head2.count === head1.count && head2.writer === head1.writer, '第二个页面画的没有写进自动保存（还是第一个页面的那一份）', JSON.stringify(head2));
  // “在这里接着做”
  await q.eval(`(() => { const b = [...document.querySelectorAll('.notices .notice.banner button')].find((x) => x.textContent.includes('在这里接着做')); if (!b) throw new Error('找不到“在这里接着做”'); b.click(); })()`);
  await q.until('第二个页面的那一条消失', `(${BANNER}) === null`, 20000);
  const bannerP = await p.until('第一个页面出现那一条', BANNER, 20000).catch(() => null);
  check(!!bannerP, '点“在这里接着做”：换成第一个页面说“已在另一个页面打开”', '第一个页面没有出现');
  const head3 = await q.until('第二个页面整份写下', `(${HEAD}).then((h) => (h && h.writer !== ${JSON.stringify(head1.writer)} ? h : null))`, 20000).catch(() => null);
  check(!!head3 && head3.count === n0 + 4, `自动保存换成了第二个页面的世界（${head3?.count} 步）`, JSON.stringify(head3));
  // 第一个页面再画：存不进去
  const landP0 = await p.eval(LAND);
  await stroke(p, 0.55);
  await p.until('第一个页面这一笔画上了', `(${LAND}) !== ${JSON.stringify(landP0)}`, 60000);
  await sleep(2500);
  const head4 = await q.eval(HEAD);
  check(head4.count === head3?.count && head4.writer === head3?.writer, '第一个页面画的不再写进自动保存');
  // 刷新第二个页面：打开的是它自己的世界
  const landQ1 = await q.eval(LAND);
  await q.send('Page.navigate', { url: `${origin}/` });
  await q.until('第二个页面刷新后世界打开', READY, 120000);
  check((await q.eval(LAND)) === landQ1, '第二个页面刷新后是它自己的世界');

  // 第一个页面的世界和存着的不一样：第二个页面刷新（锁空出来过一下）时它没有自己接过去。
  // 第九十五轮：这时它说的是“另一个页面里保存了更新的世界，这个页面里的是旧的”，主要的按钮是“重新载入”
  await sleep(1000);
  const stale = await p.until('第一个页面说它是旧的', `(() => { const t = ${BANNER}; return t && t.includes('旧的') ? t : null; })()`, 20000).catch(() => null);
  check(!!stale, `第一个页面（世界不一样）没有趁第二个页面刷新自己接过去；它说：“${stale}”`, `说的是：${await p.eval(BANNER)}`);
  const staleButtons = await p.eval(`[...document.querySelectorAll('.notices .notice.banner')].find((e) => e.textContent.includes('旧的')) ? [...[...document.querySelectorAll('.notices .notice.banner')].find((e) => e.textContent.includes('旧的')).querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), primary: b.classList.contains('primary') })) : []`);
  check(staleButtons.length === 3 && staleButtons[0].text === '重新载入' && staleButtons[0].primary && staleButtons[1].text === '在这里接着做' && !staleButtons[1].primary, `主要的按钮是“重新载入”，“在这里接着做”是次要的（${staleButtons.map((b) => b.text).join(' / ')}）`, JSON.stringify(staleButtons));
  check(/旧的/.test((await p.eval(BADGE)) ?? ''), `顶栏的记号也换了说法（${await p.eval(BADGE)}）`);
  await p.shot('这个页面里的是旧的');
  // 点“重新载入”：这个页面打开保存的那一份（第二个页面的世界）；原来的样子留在以前的版本里
  const landP1 = await p.eval(LAND);
  const askedP = p.leaveAsked;
  await p.eval(`(() => { const b = [...document.querySelectorAll('.notices .notice.banner button')].find((x) => x.textContent.trim() === '重新载入'); b.click(); })()`);
  await p.until('第一个页面重新载入成保存的那一份', `(${LAND}) === ${JSON.stringify(landQ1)}`, 120000).catch(() => null);
  await p.until('算完', READY, 60000);
  check((await p.eval(LAND)) === landQ1 && landP1 !== landQ1, '点“重新载入”：这个页面打开了保存的那一份（另一个页面的世界）');
  check(p.leaveAsked === askedP, '重新载入时浏览器没有再问“要离开吗”（这个页面里的样子已经留了）', `问了 ${p.leaveAsked - askedP} 次`);
  const versP = await p.eval(VERSIONS);
  check(versP.some((v) => v.why === 'before-reload' && v.steps === n0 + 4), `这个页面里原来的样子留在以前的版本里（${JSON.stringify(versP.filter((v) => v.why === 'before-reload'))}）`);
  const bannerP2 = await p.until('重新载入以后说“已在另一个页面打开”', `(() => { const t = ${BANNER}; return t && !t.includes('旧的') ? t : null; })()`, 20000).catch(() => null);
  check(!!bannerP2, `重新载入以后（第二个页面还开着、在写）：“${bannerP2}”`);
  await p.send('Page.close').catch(() => {});
  const head5 = await ownWrite(q, head4.writer);
  // 第三个页面：打开的就是存着的那一份。写的那个页面关了，它不用点就接着保存
  const r = await Page.open(cdp, `${origin}/`);
  await r.until('第三个页面里世界打开', READY, 120000);
  const bannerR = await r.until('第三个页面顶上的那一条', BANNER, 20000).catch(() => null);
  check(!!bannerR, '第三个页面也说“已在另一个页面打开”');
  await q.send('Page.close').catch(() => {});
  const gone = await r.until('第三个页面的那一条消失', `(${BANNER}) === null`, 20000).catch(() => null);
  check(!!gone, '写的那个页面关了：接着它存下的那一份做的页面不用点就接着保存（那一条消失）');
  const headR = await ownWrite(r, head5.writer).catch(() => null);
  check(!!headR && headR.count === head5.count, `第三个页面写下了自己的世界（${headR?.count} 步）`);
  q = r;

  console.log('6. 上次的世界打不开');
  let head6 = await ownWrite(q, head4.writer);
  // 等它写完这一次以后的那一下，再改：把最后一步换成引擎不认识的命令
  await sleep(500);
  head6 = await q.eval(HEAD);
  await q.eval(tamper(head6.count - 1, { op: 'no_such_command' }));
  await q.send('Page.navigate', { url: `${origin}/` });
  const asked = await q.until('“上次的世界没能打开”的问话', `(() => { const a = ${ASK}; return a && a.title.includes('没能打开') ? a : null; })()`, 120000).catch(() => null);
  check(!!asked, `不进向导，先问：“${asked?.title}”（${asked?.buttons.join(' / ')}）`, `没有出现；向导${(await q.eval(`!!document.querySelector('.modal.wizard')`)) ? '开了' : '没开'}`);
  check(!!asked && asked.note.length > 2 && asked.text.includes('没有丢'), `写着原因：${asked?.note}`);
  await q.shot('上次的世界没能打开');
  check((await count(q)) === head6.count, '那一份自动保存还在原处');
  await q.eval(`(() => { const b = [...document.querySelectorAll('.modal.ask .ask-actions button')].find((x) => x.textContent === '新建'); if (!b) throw new Error('找不到“新建”'); b.click(); })()`);
  await q.until('向导', `!!document.querySelector('.modal.wizard')`, 20000);
  await q.until('向导里的小图', `!!document.querySelector('.modal.wizard button.thumb:not([disabled])')`, 120000);
  check((await count(q)) === head6.count, '到了向导，还没新建：那一份还在原处');
  await q.eval(`document.querySelector('.modal.wizard button.thumb:not([disabled])').click()`);
  await q.until('新世界建好', READY, 180000);
  await ownWrite(q, head6.writer);
  const kept6 = await q.eval(BACKUPS);
  check(kept6.length === 1 && kept6[0].why === 'failed' && kept6[0].steps === head6.count && !!kept6[0].error, `新建以后原来那一份在“留着的旧世界”里（${JSON.stringify(kept6)}）`);
  const note6 = await q.until('顶上说它还留着', KEPT_NOTE, 20000).catch(() => null);
  check(!!note6 && note6.includes('没能打开'), `顶上一直有一条：“${note6}”`);
  await q.shot('新建以后-它还留着');

  console.log('7. 自动保存没存完整');
  const head7 = await q.eval(HEAD);
  await sleep(500);
  await q.eval(tamper(1, null));
  await q.send('Page.navigate', { url: `${origin}/` });
  await q.until('向导', `!!document.querySelector('.modal.wizard')`, 120000);
  const kept7 = await q.until('挪进留着的旧世界', `(${BACKUPS}).then((l) => (l.some((b) => b.why === 'damaged') ? l : null))`, 20000).catch(() => null);
  check(!!kept7 && kept7.length === 2 && kept7.some((b) => b.why === 'damaged' && b.steps === head7.count - 1), `没存完整的那一份不当没有：在“留着的旧世界”里（${JSON.stringify(kept7)}）`);
  check((await q.eval(HEAD)) === null, '自动保存的位置空出来了');
  const note7 = await q.until('向导上面说它还留着', KEPT_NOTE, 20000).catch(() => null);
  check(!!note7 && note7.includes('没存完整'), `向导上面写着：“${note7}”`);
  await q.shot('没存完整-向导上面');

  // ---------- 第九十六轮 ----------
  // 到这里为止（前七步）页面里不该有没接住的错；后面几步是故意弄出来的
  const errors = [...p.errors, ...q.errors];
  check(errors.length === 0, '前七步：页面里没有没接住的错', errors.slice(0, 3).join('；'));
  const { workers: tracked } = await safetySteps({ cdp, q, origin, errors, check, sleep, stroke, count, ownWrite, READY, LAND, HEAD, ASK, clickMenuItem, closeMenu });
  // ---------- 第九十七轮 ----------
  const before12 = q.errors.length;
  await progressSteps({ cdp, q, origin, check, sleep, stroke, count, READY, LAND, HEAD, ASK, clickMenuItem, tracked });
  check(q.errors.length === before12, '第十二段：页面里没有没接住的错', q.errors.slice(before12, before12 + 3).join('；'));
  // ---------- 第九十八轮 ----------
  await startSteps({ cdp, Page, origin, check, sleep, READY, HEAD, ASK, clickMenuItem });
  // ---------- 第九十九轮 ----------
  await simpleSteps({ cdp, Page, origin, check, sleep, READY, HEAD, ASK, clickMenuItem, tmp: profile });
  // ---------- 第一百轮 ----------
  await touchSteps({ cdp, Page, origin, check, sleep, READY, HEAD });
  // ---------- 第一百零一轮 ----------
  await offlineSteps({ cdp, Page, dist, tmp: profile, check, sleep, stroke, READY, LAND, HEAD });
  console.log(`${failed ? `没过 ${failed} 项` : '都通过'}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
} catch (e) {
  if (e !== DONE) {
    failed++;
    console.log(`  没过  ${e.message ?? e}`);
  }
} finally {
  try {
    ws?.close();
  } catch {
    // 已经断了
  }
  chrome.kill();
  server.close();
  // 等 Chrome 真的退出再删它的用户目录（它退出前还在往里写；第九十七轮：删的时候正好撞上过一次，报错把“都通过”变成了退出码 1）
  await Promise.race([new Promise((r) => chrome.once('exit', r)), sleep(5000)]);
  await sleep(300);
  if (keep) console.log(`临时目录：${profile}`);
  else {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      console.log(`（临时目录没删干净：${profile}）`);
    }
  }
}
process.exit(failed ? 1 : 0);
