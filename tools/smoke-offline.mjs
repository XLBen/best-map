// 冒烟的第一百零一轮那一段（离线能用；由 tools/smoke.mjs 调，见那里开头的说明）。
// 都从外面做：这一段自己另起一个静态服务器（只绑 127.0.0.1、随机空闲端口），把 dist/ 放在一个**子路径**下
// （/sub/map/：顺带验打包出来的地址都是相对的），另开一个存储是空的浏览器环境。“断网”就是把这个服务器真的停掉；
// “新版本”是把 dist/ 另拷一份、换一个名字不同的主脚本、照 sw.js 第一行的格式写一份新的清单，再在原来的端口上起服务器。
// 程序里没有为冒烟留任何东西。真的“装到桌面”、别的浏览器这里走不到。
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const SUB = '/sub/map/';
// sw.js 第一行的清单（同 src/offline/sw-core.ts 的 PRECACHE_HEAD）
const HEAD_LINE = 'self.__MAP2_PRECACHE=';
function readSw(text) {
  const nl = text.indexOf('\n');
  if (!text.startsWith(HEAD_LINE) || nl < 0) throw new Error('sw.js 的第一行不是清单');
  return { pre: JSON.parse(text.slice(HEAD_LINE.length, nl - 1)), code: text.slice(nl + 1) };
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// 一个能停、能在原来的端口上再起、能换目录的静态服务器。记着每个请求（看哪些真的到了服务器）
class Static {
  constructor(dir) {
    this.dir = dir;
    this.port = 0;
    this.server = null;
    this.seen = [];
  }
  start() {
    this.server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
      this.seen.push(`${req.method} ${req.url}`);
      if (!path.startsWith(SUB)) {
        res.writeHead(404).end('not found');
        return;
      }
      const rel = path.slice(SUB.length);
      const file = normalize(join(this.dir, rel === '' ? 'index.html' : rel));
      if (!file.startsWith(this.dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      createReadStream(file).pipe(res);
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }
  // 真的停掉：连着的也都断开
  stop() {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }
}

// service worker 现在的样子：谁管着这个页面、有没有等着的、各份缓存里存了几个
const SW_STATE = `(async () => {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const caches_ = {};
  for (const name of await caches.keys()) caches_[name] = (await (await caches.open(name)).keys()).length;
  return { scope: reg ? reg.scope : null, active: reg && reg.active ? reg.active.state : null, waiting: !!(reg && reg.waiting), installing: !!(reg && reg.installing), controlled: !!navigator.serviceWorker.controller, caches: caches_ };
})()`;
const UPDATE_NOTE = `(() => { const n = document.querySelector('.notices .notice.banner.update-note'); return n ? { text: n.querySelector('.notice-text').textContent, buttons: [...n.querySelectorAll('button')].map((b) => b.textContent.trim() || b.getAttribute('aria-label')) } : null; })()`;
const MARK = `(() => { const m = document.querySelector('meta[name="map2-smoke"]'); return m ? m.content : null; })()`;
const MAIN_SCRIPT = `(() => { const s = document.querySelector('script[type="module"][src]'); return s ? s.src : null; })()`;
// “更多”最下面的那一行
const MORE = `document.querySelector('.topbar button[data-panel="more"]').click()`;
const MORE_LINE = `(() => { const l = document.querySelector('.popover .offline-line'); return l ? l.textContent.trim() : null; })()`;

export async function offlineSteps({ cdp, Page, dist, tmp, check, sleep, stroke, READY, LAND, HEAD }) {
  console.log('16. 离线能用');
  const { pre } = readSw(readFileSync(join(dist, 'sw.js'), 'utf8'));
  const site = new Static(dist);
  await site.start();
  const url = `http://127.0.0.1:${site.port}${SUB}`;
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const p = await Page.open(cdp, `${url}#demo`, browserContextId);
  const count = async (page = p) => (await page.eval(HEAD))?.count ?? 0;
  const saved = (n, page = p) => page.until(`自动保存到 ${n} 步`, `(${HEAD}).then((h) => !!h && h.count === ${n})`, 30000);
  const own = `map2-sw-${pre.version}`;
  let q = null;
  try {
    // ---- 打开一次：service worker 装好，壳都存下了 ----
    await p.until('世界生成好', READY, 180000);
    const n0 = await p.until('第一次自动保存', `(${HEAD}).then((h) => (h && h.count > 0 ? h.count : 0))`, 30000);
    const st0 = await p.until('service worker 装好、接管了页面', `(${SW_STATE}).then((s) => (s && s.active === 'activated' && s.controlled && s.caches[${JSON.stringify(own)}] >= ${pre.shell.length} ? s : null))`, 60000).catch(() => null);
    check(!!st0 && st0.scope === url, `放在子路径 ${SUB} 下打开：service worker 装好了，管的是这一段地址（${st0?.scope}）`, JSON.stringify(await p.eval(SW_STATE).catch((e) => String(e))));
    check(!!st0 && st0.caches[own] >= pre.shell.length && !st0.waiting, `程序的壳 ${pre.shell.length} 个文件都存下了（这一版的缓存里 ${st0?.caches[own]} 个）`, JSON.stringify(st0));
    await p.eval(MORE);
    const line0 = await p.until('“更多”最下面的一行', MORE_LINE, 10000).catch(() => null);
    check(line0 === '断网时也能打开这个页面', `“更多”最下面写着：“${line0}”`, String(line0));
    check((await p.eval(UPDATE_NOTE)) === null, '没有新版本时顶上没有“有新版本”的那一条');
    await p.shot('101-更多-能离线');
    await p.eval(MORE);
    // 字体：用到时存，这里叫它现在就在后台补齐（程序自己是过二十秒才开始补）
    await p.eval(`navigator.serviceWorker.controller.postMessage({ type: 'fill' })`);
    const filled = await p.until('字体补齐', `(${SW_STATE}).then((s) => (s.caches[${JSON.stringify(own)}] >= ${pre.shell.length + pre.lazy.length} ? s.caches[${JSON.stringify(own)}] : 0))`, 90000).catch(() => 0);
    check(filled >= pre.shell.length + pre.lazy.length, `字体的 ${pre.lazy.length} 个小文件在后台补齐了（缓存里一共 ${filled} 个）`, JSON.stringify((await p.eval(SW_STATE)).caches));

    // ---- 画一笔、等自动保存；然后把服务器停掉 ----
    const land0 = await p.eval(LAND);
    await stroke(p, 0.5);
    await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land0)}`, 60000);
    await saved(n0 + 1);
    await p.until('算完', READY, 60000);
    const land1 = await p.eval(LAND);
    await site.stop();
    const down = await p.eval(`fetch('./index.html?smoke-offline=' + Date.now(), { cache: 'no-store' }).then((r) => 'answered ' + r.status, () => 'failed')`);
    check(down === 'failed', '服务器停了：带着 ? 的请求（service worker 不管的）连不上', down);
    const post = await p.eval(`fetch('./index.html', { method: 'POST' }).then((r) => 'answered ' + r.status, () => 'failed')`);
    check(post === 'failed', 'POST 不拦：照样连不上，没有拿存下的页面去答', post);

    // ---- 断着网刷新 ----
    await p.eval(`window.__before = 1`);
    await p.send('Page.navigate', { url });
    await p.until('页面真的重新载入了', `window.__before !== 1`, 30000).catch(() => null);
    const opened = await p.until('断网刷新后世界打开', READY, 120000).catch(() => null);
    check(!!opened && !(await p.eval(`!!document.querySelector('.rescue') || !!document.querySelector('.boot-wait')`)), '断网刷新：页面打开了（不是自救页，不是“页面还没打开”）', `页面上：${await p.eval(`document.body.innerText.slice(0, 80)`).catch((e) => String(e))}`);
    check((await p.eval(LAND)) === land1 && (await count()) === n0 + 1, `世界还在，那一笔还在（陆地逐字节相同，存着 ${n0 + 1} 步）`, `之前 ${land1}，现在 ${await p.eval(LAND)}，存着 ${await count()} 步`);
    await stroke(p, 0.4);
    await p.until('断网时这一笔画上了', `(${LAND}) !== ${JSON.stringify(land1)}`, 60000).catch(() => null);
    await saved(n0 + 2).catch(() => null);
    await p.until('算完', READY, 60000);
    const land2 = await p.eval(LAND);
    check(land2 !== land1 && (await count()) === n0 + 2, `断着网还能画一笔（计算 Worker 照常），自动保存多了一步`, `存着 ${await count()} 步`);
    check((await p.eval(UPDATE_NOTE)) === null && p.errors.length === 0, '断网时界面上没有多说什么，页面里没有没接住的错', p.errors.slice(0, 3).join('；'));
    await p.shot('101-断网刷新后');
    // 再刷新一次（带着 #demo 以外的写法：index.html）
    await p.send('Page.navigate', { url: `${url}index.html` });
    await p.until('断网再刷新后世界打开', READY, 120000).catch(() => null);
    check((await p.eval(LAND)) === land2, '断着网再刷新一次（地址写成 …/index.html）：还是打得开，这一笔也在');

    // ---- 一份对不上的“新版本”：不装 ----
    // 清单说有新的一版，但服务器上有一个文件的内容和清单里记的不一样（正好撞上重新打包、服务器拿 index.html 顶替没有的文件时就是这样）
    const bad = join(tmp, 'offline-bad');
    rmSync(bad, { recursive: true, force: true });
    mkdirSync(bad, { recursive: true });
    cpSync(dist, bad, { recursive: true });
    const css = pre.shell.find((f) => /^assets\/index-[^/]+\.css$/.test(f));
    writeFileSync(join(bad, css), readFileSync(join(bad, 'index.html')));
    const swBad = readSw(readFileSync(join(bad, 'sw.js'), 'utf8'));
    const preBad = { ...swBad.pre, version: `smokebad${Date.now().toString(36)}` };
    writeFileSync(join(bad, 'sw.js'), `${HEAD_LINE}${JSON.stringify(preBad)};\n${swBad.code}`);
    site.dir = bad;
    await site.start();
    const seen0 = site.seen.length;
    await p.eval(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true, () => false)`);
    for (let k = 0; k < 100 && !site.seen.slice(seen0).some((r) => r.includes(css)); k++) await sleep(100);
    await sleep(1500);
    const stBad = await p.until('那一版没装上', `(${SW_STATE}).then((s) => (!s.installing ? s : null))`, 30000).catch(() => null);
    check(!!stBad && !stBad.waiting && !Object.keys(stBad.caches).some((n) => n.includes('smokebad')) && stBad.caches[own] > 0, '服务器上的文件和清单对不上的一版：不装（没有等着的，没有留下它的缓存），正在用的这一版原样', JSON.stringify(stBad));
    check(site.seen.slice(seen0).some((r) => r.includes(css)) && (await p.eval(UPDATE_NOTE)) === null && (await p.eval(LAND)) === land2, '浏览器确实来取过它的文件；页面上没有多说什么，世界没动');
    await site.stop();

    // ---- 新版本：旧页面不被换掉 ----
    const v2 = join(tmp, 'offline-v2');
    rmSync(v2, { recursive: true, force: true });
    mkdirSync(v2, { recursive: true });
    cpSync(dist, v2, { recursive: true });
    const html1 = readFileSync(join(v2, 'index.html'), 'utf8');
    const main1 = pre.shell.find((f) => /^assets\/index-[^/]+\.js$/.test(f));
    if (!main1 || !html1.includes(main1)) throw new Error('认不出主脚本');
    const main2 = 'assets/index-SmokeV2x.js';
    // 新版本的主脚本换了名字（内容多一行注释）；旧名字的那个从服务器上拿掉——旧页面再要它只能靠留着的缓存
    renameSync(join(v2, main1), join(v2, main2));
    writeFileSync(join(v2, main2), `${readFileSync(join(v2, main2), 'utf8')}\n// smoke v2\n`);
    const html2 = html1.replace(main1, main2).replace('<title>', '<meta name="map2-smoke" content="v2" /><title>');
    writeFileSync(join(v2, 'index.html'), html2);
    const sw1 = readSw(readFileSync(join(v2, 'sw.js'), 'utf8'));
    const { [main1]: _old, ...sums } = sw1.pre.sums;
    const pre2 = { ...sw1.pre, version: `smoke2${Date.now().toString(36)}`, shell: sw1.pre.shell.map((f) => (f === main1 ? main2 : f)), sums: { ...sums, 'index.html': sha256(html2), [main2]: sha256(readFileSync(join(v2, main2))) } };
    writeFileSync(join(v2, 'sw.js'), `${HEAD_LINE}${JSON.stringify(pre2)};\n${sw1.code}`);
    const own2 = `map2-sw-${pre2.version}`;
    site.dir = v2;
    await site.start();
    await p.eval(`window.__stay = 1`);
    // 浏览器平常是打开页面时自己查有没有新的；这里叫它现在查
    await p.eval(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`);
    const note = await p.until('顶上说有新版本', UPDATE_NOTE, 60000).catch(() => null);
    check(!!note && note.text === '有新版本，重新载入后用上' && note.buttons[0] === '重新载入', `服务器上换成新版本以后：顶上一条“${note?.text}”（${note?.buttons.join(' / ')}）`, JSON.stringify(await p.eval(SW_STATE)));
    const st1 = await p.eval(SW_STATE);
    check(st1.waiting && st1.caches[own] > 0 && st1.caches[own2] >= pre2.shell.length, '新版本在后台装好了、等着；正在用的那一版的缓存原样在', JSON.stringify(st1));
    check((await p.eval(`window.__stay`)) === 1 && (await p.eval(MARK)) === null && (await p.eval(MAIN_SCRIPT)).endsWith(main1) && (await p.eval(LAND)) === land2, '这个页面没有被换掉：没有重新载入，还是旧的脚本，世界没动');
    await p.shot('101-有新版本');
    await p.eval(MORE);
    const line1 = await p.until('“更多”最下面的一行', MORE_LINE, 10000).catch(() => null);
    check(!!line1 && line1.startsWith('有新版本，重新载入后用上') && line1.endsWith('重新载入'), `“更多”最下面也有这一句和“重新载入”（顶上那一条关了以后从这里点）`, String(line1));
    await p.shot('101-更多-有新版本');
    await p.eval(MORE);
    await stroke(p, 0.6);
    await p.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land2)}`, 60000).catch(() => null);
    await saved(n0 + 3).catch(() => null);
    await p.until('算完', READY, 60000);
    const land3 = await p.eval(LAND);
    check(land3 !== land2 && (await count()) === n0 + 3, '等着的时候照常能画、能保存');

    // 另开一个页面：联网时打开拿到的就是新的；它本来就是新的一版，新版本马上启用。旧页面照样不被换掉
    q = await Page.open(cdp, url, browserContextId);
    await q.until('第二个页面打开', READY, 120000);
    check((await q.eval(MARK)) === 'v2' && (await q.eval(MAIN_SCRIPT)).endsWith(main2), '联网时另开一个页面：打开的是新版本');
    // 平常页面还没打开完新版本就启用了（0 秒）。量到过一次 30 秒还没启用（十六段连着走的那一遍里；单走这一段、加着负载走都没再碰到，
    // 原因没有查清——启用要等正在用的那一版手上没有事，推测是它正好在忙 / 浏览器要等它闲下来）。所以等得宽一些，等了多久写在这一项里
    const tQ = Date.now();
    const st2 = await q.until('新版本启用', `(${SW_STATE}).then((s) => (!s.waiting && !s.installing && s.caches[${JSON.stringify(own2)}] > 0 ? s : null))`, 120000).catch(() => null);
    const tookQ = ((Date.now() - tQ) / 1000).toFixed(1);
    check(!!st2 && st2.caches[own] > 0, `新的页面不用点：新版本启用了（页面打开后 ${tookQ} 秒）；上一版的缓存留着（旧页面还要用）`, `${JSON.stringify(await q.eval(SW_STATE))}；页面 ${await q.eval(`document.readyState + ' load=' + Math.round(performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? -1)`)}；出的错：${q.errors.slice(0, 2).join('；') || '没有'}`);
    check((await q.eval(UPDATE_NOTE)) === null, '新的页面上没有“有新版本”的那一条');
    const oldFile = await p.eval(`fetch(${JSON.stringify(`${url}${main1}`)}).then((r) => r.ok && r.text().then((t) => t.length), () => 'failed')`);
    check(typeof oldFile === 'number' && oldFile > 100000 && !existsSync(join(v2, main1)), `旧页面要它自己那一版的文件（服务器上已经没有了）：拿得到（${oldFile} 字，来自留着的缓存）`, String(oldFile));
    check((await p.eval(`window.__stay`)) === 1 && (await p.eval(MARK)) === null && !!(await p.eval(UPDATE_NOTE)), '旧页面还是没有被换掉，那一条还在');
    await q.send('Page.close').catch(() => {});
    q = null;
    await sleep(500);

    // 点“重新载入”：用上新版本，世界还在
    await p.until('算完', READY, 60000);
    await p.eval(`(() => { const b = [...document.querySelectorAll('.notices .notice.banner.update-note button')].find((x) => x.textContent.trim() === '重新载入'); if (!b) throw new Error('找不到“重新载入”'); b.click(); })()`);
    await p.until('重新载入成新版本', `(${MARK}) === 'v2' && (${READY})`, 120000).catch(() => null);
    check((await p.eval(MARK)) === 'v2' && (await p.eval(`window.__stay`)) !== 1, '点“重新载入”：这个页面用上了新版本');
    check((await p.eval(LAND)) === land3 && (await count()) === n0 + 3, `世界还在（陆地逐字节相同，${n0 + 3} 步）`, `现在 ${await p.eval(LAND)}，存着 ${await count()} 步`);
    check((await p.eval(UPDATE_NOTE)) === null, '那一条没了');

    // 新版本下断网也打得开
    await site.stop();
    await p.send('Page.navigate', { url });
    await p.until('断网刷新后世界打开', READY, 120000).catch(() => null);
    check((await p.eval(MARK)) === 'v2' && (await p.eval(LAND)) === land3, '再把服务器停掉、刷新：打开的是新版本，世界还在');
    const st3 = await p.eval(SW_STATE);
    check(Object.keys(st3.caches).filter((n) => n.startsWith('map2-sw-')).length === 2, `存着的缓存是两版：现在的和上一版（${Object.keys(st3.caches).join('、')}）`);
    check(p.errors.length === 0, '第十六段：页面里没有没接住的错', p.errors.slice(0, 3).join('；'));
  } finally {
    await site.stop();
    await q?.send('Page.close').catch(() => {});
    await p.send('Page.close').catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}
