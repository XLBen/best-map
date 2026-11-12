// 冒烟的第一百轮那一段（触摸与平板；由 tools/smoke.mjs 调，见那里开头的说明）。
// 都从外面做：另开一个存储是空的浏览器环境，平板大小的视口，调试协议的触摸
// （Emulation.setTouchEmulationEnabled、Input.dispatchTouchEvent）——点缩略图、点按钮、在地图上一指画、两指捏、长按、取消，
// 量按钮的大小、看页面有没有横向溢出。程序里没有为冒烟留任何东西（认东西靠界面上本来就有的 class 和 data-tool）。
// 真的平板、真的笔这里走不到：无头 Chrome 里的触摸是合成的（没有手掌、没有压力、没有系统手势）。

const TOUCH_MIN = 44;
// 镜头（放大了多少、看着哪里）
const CAM = `(() => { const c = window.__map2.renderer.camera; return { x: c.x, y: c.y, zoom: c.zoom }; })()`;
const LAND_N = `(() => { const a = window.__map2.world().causes.land; let n = 0; for (let i = 0; i < a.length; i++) n += a[i]; return n; })()`;
const VIEW = `({ w: window.innerWidth, h: window.innerHeight, coarse: matchMedia('(pointer: coarse)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches, touchPoints: navigator.maxTouchPoints })`;
// 页面有没有横向溢出、整页能不能被拖着滚
const OVERFLOW = `(() => { const d = document.scrollingElement; return { sw: d.scrollWidth, sh: d.scrollHeight, w: window.innerWidth, h: window.innerHeight }; })()`;
// 一样东西在视口里的位置
const rectOf = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })()`;
const inside = (r, v, pad = 0) => !!r && r.l >= -pad && r.t >= -pad && r.r <= v.w + pad && r.b <= v.h + pad;
// 页面上看得见、点得着的东西里，比 44×44 小的（root 里的；带上是什么、多大）。
// 算“点得着的大小”：按钮自己，或者包着它、点了也算它的那一圈（label）。行里的字、图标不算（它们不是单独的目标）
const SMALL = (root) => `(() => {
  const root = document.querySelector(${JSON.stringify(root)});
  if (!root) return null;
  const out = [];
  let n = 0;
  const seen = new Set();
  for (const e of root.querySelectorAll('button, [role="button"], [role="slider"], [role="switch"], a[href], select, input:not([type="hidden"]), textarea, label.check, .item, summary')) {
    if (seen.has(e)) continue;
    seen.add(e);
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
    // 包在 label 里的框（勾选框、颜色、文件）：点得着的是那一圈 label
    const host = e.matches('input') && e.closest('label') ? e.closest('label') : e;
    const r = host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 滚到看不见的地方的不算
    const vis = host.checkVisibility ? host.checkVisibility() : true;
    if (!vis) continue;
    n++;
    if (r.width < ${TOUCH_MIN} - 0.5 || r.height < ${TOUCH_MIN} - 0.5) out.push((e.className && typeof e.className === 'string' ? e.tagName.toLowerCase() + '.' + e.className.trim().split(/\\s+/).join('.') : e.tagName.toLowerCase()) + ' “' + (e.textContent || e.title || e.getAttribute('aria-label') || e.type || '').trim().slice(0, 12) + '” ' + Math.round(r.width) + '×' + Math.round(r.height));
  }
  return { n, small: out };
})()`;
const sizesOf = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })`;
const minSide = (list) => (list.length ? Math.min(...list.map(([w, h]) => Math.min(w, h))) : 0);
const centerOf = (sel, nth = 0) => `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})][${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const buttonByText = (root, text) => `(() => { const e = [...document.querySelectorAll(${JSON.stringify(root)} + ' button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.getBoundingClientRect().width > 0); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const byTitle = (title) => `(() => { const e = [...document.querySelectorAll('.topbar button.tb-btn')].find((b) => b.title === ${JSON.stringify(title)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const HERE = `(() => { const h = document.querySelector('.here'); return h ? { open: h.classList.contains('open'), title: h.querySelector('.here-head b')?.textContent ?? '' } : null; })()`;

export async function touchSteps({ cdp, Page, origin, check, sleep, READY, HEAD }) {
  console.log('15. 触摸与平板');
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  // 先开一个空页面，把视口、触摸都设好，再进程序（它一打开就问媒体查询）
  const p = await Page.open(cdp, 'about:blank', browserContextId);
  const viewport = async (width, height) => {
    await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
  };
  // 手指：按下、移动、抬起。points：[[id, x, y], …]——touchStart、touchMove 是这一下之后落着的全部手指；
  // touchEnd、touchCancel 是这一下抬起的那几根（空的：全部抬起）。量过：无头 Chrome 里 touchEnd 列的是抬起的，不是剩下的
  const touch = (type, points) => p.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x: Math.round(x), y: Math.round(y), radiusX: 8, radiusY: 8, force: 0.5 })) });
  // 点一下（手指）
  const tap = async (at, hold = 60) => {
    if (!at) throw new Error('要点的东西不在页面上');
    await touch('touchStart', [[1, at.x, at.y]]);
    await sleep(hold);
    await touch('touchEnd', []);
    await sleep(250);
  };
  // 一指从 a 拖到 b；end：抬起（否则留着手指）
  const drag = async (a, b, steps = 16, end = true) => {
    await touch('touchStart', [[1, a.x, a.y]]);
    await sleep(140);
    for (let k = 1; k <= steps; k++) {
      await touch('touchMove', [[1, a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps]]);
      await sleep(15);
    }
    if (end) await touch('touchEnd', []);
  };
  // 两指：从 (a0, b0) 到 (a1, b1)
  const two = async (a0, b0, a1, b1, steps = 12) => {
    await touch('touchStart', [[1, a0.x, a0.y]]);
    await sleep(20);
    await touch('touchStart', [[1, a0.x, a0.y], [2, b0.x, b0.y]]);
    await sleep(40);
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      await touch('touchMove', [[1, a0.x + (a1.x - a0.x) * f, a0.y + (a1.y - a0.y) * f], [2, b0.x + (b1.x - b0.x) * f, b0.y + (b1.y - b0.y) * f]]);
      await sleep(15);
    }
    await touch('touchEnd', [[1, a1.x, a1.y]]);
    await sleep(20);
    await touch('touchEnd', []);
    await sleep(300);
  };
  const count = async () => (await p.eval(HEAD))?.count ?? 0;
  // 这一下之后存着的步数稳定在多少（自动保存 1.5 秒后写）
  const settled = async () => {
    await p.until('算完', READY, 60000);
    await sleep(2600);
    await p.until('算完', READY, 60000);
    return count();
  };
  const map = () => p.eval(`(() => { const c = document.querySelector('canvas.map-overlay'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);

  try {
    await viewport(768, 1024);
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await p.send('Page.navigate', { url: `${origin}/` });

    // ---- 向导第一屏（竖着的平板） ----
    await p.until('向导里的缩略图', `document.querySelectorAll('.modal.wizard button.thumb:not([disabled])').length >= 6`, 180000);
    await sleep(500);
    const v0 = await p.eval(VIEW);
    // 粗指针的媒体查询在无头 Chrome 里生不生效：照实写。不生效时下面“≥ 44”的几项量的是细指针的样子，会没过
    check(v0.coarse && v0.touchPoints > 0, `触摸模拟开着：视口 ${v0.w}×${v0.h}，(pointer: coarse) ${v0.coarse ? '成立' : '不成立'}，(hover: hover) ${v0.hover ? '成立' : '不成立'}，最多 ${v0.touchPoints} 个触点`, JSON.stringify(v0));
    const of0 = await p.eval(OVERFLOW);
    const wz = await p.eval(rectOf('.modal.wizard'));
    check(of0.sw <= of0.w && !!wz && wz.l >= 0 && wz.r <= v0.w, `向导第一屏（${v0.w}×${v0.h}）没有横向溢出：向导左 ${wz?.l} 右 ${wz?.r}`, JSON.stringify({ of0, wz }));
    const thumbs = await p.eval(sizesOf('.modal.wizard button.thumb'));
    const thumbRects = await p.eval(`[...document.querySelectorAll('.modal.wizard button.thumb')].map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom }; })`);
    check(thumbs.length >= 6 && minSide(thumbs) >= TOUCH_MIN && thumbRects.every((r) => r.l >= 0 && r.r <= v0.w), `六张缩略图都在屏幕宽度里，最小的一边 ${minSide(thumbs)} 像素`, JSON.stringify(thumbs));
    const wzSmall = await p.eval(SMALL('.modal.wizard'));
    check(!!wzSmall && wzSmall.small.length === 0, `向导第一屏 ${wzSmall?.n} 样可点的都不小于 ${TOUCH_MIN}×${TOUCH_MIN}`, wzSmall?.small.join('；'));
    await p.shot('100-向导-768x1024');

    // ---- 手指点一张缩略图：建世界 ----
    await tap(await p.eval(centerOf('.modal.wizard button.thumb:not([disabled])')));
    await p.until('世界生成好', READY, 240000);
    await p.until('向导关上', `!document.querySelector('.modal.wizard')`, 20000);
    const n0 = await p.until('第一次自动保存', `(${HEAD}).then((h) => (h && h.count > 0 ? h.count : 0))`, 30000);
    check(n0 > 0, `手指点一张缩略图：世界建好了，自动保存了 ${n0} 步`);
    // 第一次建好会开帮助（另一个浏览器环境里没有记过）：关上
    await p.eval(`(() => { const b = document.querySelector('.modal.help .modal-head button'); if (b) b.click(); })()`);
    await sleep(300);
    await p.shot('100-主界面-768x1024');

    // ---- 粗指针下的大小 ----
    await tap(await p.eval(byTitle('地形')));
    await sleep(300);
    const tools = await p.eval(sizesOf('.bottombar .bb-tool'));
    const tops = await p.eval(sizesOf('.topbar button'));
    const tracks = await p.eval(sizesOf('.bottombar .slider-track'));
    const thumbsS = await p.eval(sizesOf('.bottombar .slider-thumb'));
    check(tools.length >= 4 && minSide(tools) >= TOUCH_MIN, `底部条上 ${tools.length} 个工具按钮（连“还有 N 个”“⋯”）最小的一边 ${minSide(tools)} 像素`, JSON.stringify(tools));
    check(tops.length >= 10 && minSide(tops) >= TOUCH_MIN, `顶栏 ${tops.length} 个按钮最小的一边 ${minSide(tops)} 像素`, JSON.stringify(tops));
    check(tracks.length >= 1 && Math.min(...tracks.map(([, h]) => h)) >= TOUCH_MIN && minSide(thumbsS) >= 24, `底部条的滑块：能按的那一条高 ${Math.min(...tracks.map(([, h]) => h))} 像素（把手画出来 ${minSide(thumbsS)} 像素，按在这一条上哪里都算）`, JSON.stringify({ tracks, thumbsS }));
    const barSmall = await p.eval(SMALL('.bottombar'));
    const topSmall = await p.eval(SMALL('.topbar'));
    check(!!barSmall && barSmall.small.length === 0 && !!topSmall && topSmall.small.length === 0, `底部条 ${barSmall?.n} 样、顶栏 ${topSmall?.n} 样可点的都不小于 ${TOUCH_MIN}×${TOUCH_MIN}`, [...(barSmall?.small ?? []), ...(topSmall?.small ?? [])].join('；'));
    // 滑块好拖：手指按在滑轨上拖，数跟着变
    const track = await p.eval(rectOf('.bottombar .slider-track'));
    const value0 = await p.eval(`document.querySelector('.bottombar .slider-value')?.textContent ?? ''`);
    await touch('touchStart', [[1, track.l + track.w * 0.3, track.t + track.h / 2]]);
    for (let k = 1; k <= 8; k++) {
      await touch('touchMove', [[1, track.l + track.w * (0.3 + 0.06 * k), track.t + track.h / 2 + k]]);
      await sleep(15);
    }
    const dragging = await p.eval(`!!document.querySelector('.bottombar .slider.drag')`);
    await touch('touchEnd', []);
    await sleep(300);
    const value1 = await p.eval(`document.querySelector('.bottombar .slider-value')?.textContent ?? ''`);
    check(dragging && !!value0 && value1 !== value0, `手指在底部条的滑块上拖：数跟着变（${value0} → ${value1}）`, JSON.stringify({ dragging, value0, value1 }));
    // 竖着的平板：顶栏只剩图标时字写在图标下面（手指没有悬停）
    const labels = await p.eval(`[...document.querySelectorAll('.topbar .tb-btn .tb-label')].map((e) => ({ t: e.textContent.trim(), shown: getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0 }))`);
    check(labels.length >= 14 && labels.every((l) => l.shown && l.t.length > 0), `竖着的平板：顶栏 ${labels.length} 个按钮的字都写着（${labels.slice(0, 5).map((l) => l.t).join('、')}……），不用悬停`, JSON.stringify(labels.filter((l) => !l.shown)));
    // 工具做什么：底部条最下面一行（不讲键盘）
    const how = await p.eval(`document.querySelector('.bottombar .bb-how')?.textContent ?? ''`);
    check(how.length > 3 && !/Shift|Alt/.test(how), `底部条最下面写着这个工具做什么：“${how}”`, how);
    const corner = await p.eval(sizesOf('.ruler-btn, button.here'));
    check(corner.length >= 3 && minSide(corner) >= TOUCH_MIN && !!(await p.eval(`!!document.querySelector('.ruler-btn.fit-btn')`)), `左下角的量距离、看全图，右下角的“这里”：最小的一边 ${minSide(corner)} 像素（看全图是给没有键盘的人补的）`, JSON.stringify(corner));

    // ---- 布局：竖着 768×1024 ----
    const layout = async (name) => {
      const v = await p.eval(VIEW);
      const of = await p.eval(OVERFLOW);
      const top = await p.eval(rectOf('.topbar'));
      const bar = await p.eval(rectOf('.bottombar'));
      const groups = await p.eval(`[...document.querySelectorAll('.topbar .tb-group')].map((e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; })`);
      check(of.sw <= of.w && of.sh <= of.h, `${name}：页面没有横向溢出，整页也拖不动（内容 ${of.sw}×${of.sh}，视口 ${of.w}×${of.h}）`, JSON.stringify(of));
      check(inside(bar, v) && groups.every((g) => inside(g, v)), `${name}：顶栏两组、底部条都在视口里（底部条 ${bar?.l}–${bar?.r} × ${bar?.t}–${bar?.b}）`, JSON.stringify({ groups, bar }));
      const apart = groups.length === 2 && (groups[0].r <= groups[1].l || groups[0].b <= groups[1].t);
      check(apart && !!top && !!bar && top.b <= bar.t, `${name}：顶栏的两组不互相盖着，顶栏在底部条上面（顶栏到 ${top?.b}，底部条从 ${bar?.t}）`, JSON.stringify({ groups, top, bar }));
      // 底部条的工具一排放不下时折行：每个工具按钮都在底部条里、在视口里
      const btns = await p.eval(`[...document.querySelectorAll('.bottombar button, .bottombar .slider-track')].map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }).filter((r) => r.r > r.l)`);
      check(btns.every((r) => r.l >= 0 && r.r <= v.w && r.t >= 0 && r.b <= v.h), `${name}：底部条上 ${btns.length} 样东西都点得着（一排放不下时折行，没有伸到屏幕外面的）`, JSON.stringify(btns.filter((r) => !(r.l >= 0 && r.r <= v.w && r.t >= 0 && r.b <= v.h))));
    };
    // 面板、弹窗：在视口里；里面比它高时自己能滚。modal：弹窗是整个放在能滚的一层里的（比屏幕高时滚那一层），只看左右和顶边
    const panelFits = async (name, sel, scrollSel, modal = false) => {
      const v = await p.eval(VIEW);
      const r = await p.eval(rectOf(sel));
      const sc = await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(scrollSel)}); if (!e) return null; const cs = getComputedStyle(e); return { sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, oy: cs.overflowY }; })()`);
      const fits = modal ? !!r && r.l >= 0 && r.r <= v.w && r.t >= 0 : inside(r, v, 1);
      const canScroll = !!sc && (sc.sh <= sc.ch + 1 || sc.oy === 'auto' || sc.oy === 'scroll');
      check(fits && canScroll && !!sc && sc.sw <= sc.cw + 1, `${name}：${modal ? '左右在视口里' : '在视口里'}（${r?.l}–${r?.r} × ${r?.t}–${r?.b}），${sc && sc.sh > sc.ch + 1 ? `里面比它高（${sc.sh} > ${sc.ch}）自己能滚` : '里面放得下'}，没有横向溢出`, JSON.stringify({ r, sc, v }));
      const small = await p.eval(SMALL(sel));
      check(!!small && small.small.length === 0, `${name}：${small?.n} 样可点的都不小于 ${TOUCH_MIN}×${TOUCH_MIN}`, small?.small.slice(0, 12).join('；'));
    };
    const openPanel = async (id) => {
      await tap(await p.eval(centerOf(`.topbar button[data-panel="${id}"]`)));
      await p.until('弹出面板', `!!document.querySelector('.popover')`, 10000);
      await sleep(300);
    };
    const closePanel = async () => {
      const x = await p.eval(centerOf('.popover .popover-head .icon-btn'));
      if (x) await tap(x);
      await p.until('面板关上', `!document.querySelector('.popover')`, 10000).catch(() => null);
    };
    const walk = async (name) => {
      await layout(name);
      await openPanel('layers');
      await panelFits(`${name} · 图层面板`, '.popover', '.popover-body');
      await p.shot(`100-图层-${name}`);
      await closePanel();
      await openPanel('more');
      await panelFits(`${name} · “更多”`, '.popover', '.popover-body');
      await closePanel();
      await openPanel('world');
      await panelFits(`${name} · “世界”菜单`, '.popover', '.popover-body');
      await closePanel();
      // 资源库
      await tap(await p.eval(`(() => { const e = [...document.querySelectorAll('.topbar button.tb-btn')].find((b) => b.title.startsWith('资源库')); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
      await p.until('资源库面板', `!!document.querySelector('.lib-panel .lp-card[data-card]')`, 20000);
      await sleep(400);
      await panelFits(`${name} · 资源库面板`, '.lib-panel', '.lib-panel .lp-body, .lib-panel .lp-main');
      await p.shot(`100-资源库-${name}`);
      await tap(await p.eval(`(() => { const e = [...document.querySelectorAll('.topbar button.tb-btn')].find((b) => b.title.startsWith('资源库')); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
      await p.until('资源库面板关上', `!document.querySelector('.lib-panel')`, 10000).catch(() => null);
      // 帮助（“更多”里的按钮）
      await openPanel('more');
      await tap(await p.eval(buttonByText('.popover', '帮助')));
      await p.until('帮助', `!!document.querySelector('.modal.help')`, 10000);
      await sleep(300);
      await panelFits(`${name} · 帮助`, '.modal.help', '.modal-backdrop', true);
      await p.shot(`100-帮助-${name}`);
      await tap(await p.eval(centerOf('.modal.help .modal-head button')));
      await p.until('帮助关上', `!document.querySelector('.modal.help')`, 10000).catch(() => null);
    };
    await walk('768×1024');

    // ---- 再往里走几处（只在竖着的时候量一遍）：“调整”、这一类的“⋯”、资源库的列表和一项的页面、国家的档案 ----
    await openPanel('adjust');
    await panelFits('“调整”', '.popover', '.popover-body');
    await closePanel();
    await tap(await p.eval(centerOf('.bottombar .bb-tool.more')));
    await p.until('“⋯”的面板', `!!document.querySelector('.popover')`, 10000);
    await sleep(300);
    await panelFits('地形的“⋯”', '.popover', '.popover-body');
    await closePanel();
    const libBtn = `(() => { const e = [...document.querySelectorAll('.topbar button.tb-btn')].find((b) => b.title.startsWith('资源库')); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
    await tap(await p.eval(libBtn));
    await p.until('资源库面板', `!!document.querySelector('.lib-panel .lp-card[data-card]')`, 20000);
    await sleep(300);
    await tap(await p.eval(centerOf('.lib-panel .lp-card[data-card="culture"]')));
    await p.until('文化的列表', `document.querySelectorAll('.lib-panel .lp-row .lp-row-main').length > 3`, 10000);
    await sleep(300);
    await panelFits('资源库 · 文化的列表', '.lib-panel', '.lib-panel .lp-body, .lib-panel .lp-main');
    await tap(await p.eval(centerOf('.lib-panel .lp-row .lp-row-main')));
    await p.until('一种文化的页面', `!!document.querySelector('.lib-panel .lp-seg')`, 10000);
    await sleep(400);
    await panelFits('资源库 · 一种文化的页面', '.lib-panel', '.lib-panel .lp-body, .lib-panel .lp-main');
    await p.shot('100-资源库一项-768×1024');
    // 回到首页再关（面板记着上次看到哪一页）
    for (let k = 0; k < 4 && !(await p.eval(`!!document.querySelector('.lib-panel .lp-card[data-card]')`)); k++) await tap(await p.eval(centerOf('.lib-panel .lp-back')));
    check(await p.eval(`!!document.querySelector('.lib-panel .lp-card[data-card]')`), '手指点“返回”回到了资源库的首页');
    await tap(await p.eval(libBtn));
    await p.until('资源库面板关上', `!document.querySelector('.lib-panel')`, 10000).catch(() => null);
    // 国家的档案（右边的抽屉）：用“选国家”点陆地上的几处，直到点到一国
    await tap(await p.eval(byTitle('国家')));
    await sleep(300);
    // 找一格有国家的陆地、周围也是这一国，并且在屏幕上没被界面挡着的地方（一块地区：屏幕 = (地图 − 镜头) × 缩放 + 画布的一半）
    const spot = await p.eval(`(() => {
      const w = window.__map2.world();
      const cam = window.__map2.renderer.camera;
      const c = document.querySelector('canvas.map-overlay').getBoundingClientRect();
      const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 20;
      const bottom = document.querySelector('.bottombar').getBoundingClientRect().top - 20;
      const owner = w.causes.country;
      if (!owner) return null;
      const { x, y, adj, off, n } = w.mesh;
      for (let i = 0; i < n; i++) {
        if (!w.causes.land[i] || owner[i] < 0) continue;
        let inner = true;
        for (let e = off[i]; e < off[i + 1]; e++) if (owner[adj[e]] !== owner[i]) inner = false;
        if (!inner) continue;
        const sx = c.left + (x[i] - cam.x) * cam.zoom + c.width / 2;
        const sy = c.top + (y[i] - cam.y) * cam.zoom + c.height / 2;
        if (sx > 230 && sx < c.right - 80 && sy > top && sy < bottom) return { x: sx, y: sy };
      }
      return null;
    })()`);
    let sheetOpen = false;
    if (spot) {
      await tap(spot);
      sheetOpen = await p.until('档案', `!!document.querySelector('.sheet')`, 10000).catch(() => false);
    }
    check(sheetOpen, '手指用“选国家”点地图上的一国：右边打开了它的档案');
    if (sheetOpen) {
      await sleep(400);
      await panelFits('国家的档案', '.sheet', '.sheet-body');
      const bar = await p.eval(rectOf('.bottombar'));
      const sheet = await p.eval(rectOf('.sheet'));
      check(!!bar && !!sheet && (bar.r <= sheet.l || bar.t >= sheet.b), `档案开着时底部条挪到了它左边（底部条到 ${bar?.r}，档案从 ${sheet?.l}）`, JSON.stringify({ bar, sheet }));
      await p.shot('100-国家档案-768×1024');
      await tap(await p.eval(centerOf('.sheet .popover-head .icon-btn, .sheet .sheet-head .icon-btn, .sheet button[title="关闭"]')));
      await p.until('档案关上', `!document.querySelector('.sheet')`, 10000).catch(() => null);
    }
    await tap(await p.eval(byTitle('地形')));
    await sleep(300);

    // ---- 帮助里有“触摸”一段（不靠悬停） ----
    await openPanel('more');
    await tap(await p.eval(buttonByText('.popover', '帮助')));
    await p.until('帮助', `!!document.querySelector('.modal.help')`, 10000);
    const helpTouch = await p.eval(`(() => { const m = document.querySelector('.modal.help'); const t = m.textContent; return { title: [...m.querySelectorAll('h5')].some((h) => h.textContent.includes('触摸')), finger: t.includes('两根手指'), long: t.includes('长按'), pen: t.includes('笔') }; })()`);
    check(helpTouch.title && helpTouch.finger && helpTouch.long && helpTouch.pen, '帮助里有“触摸”一段：写着一指、两根手指、长按、笔', JSON.stringify(helpTouch));
    await tap(await p.eval(centerOf('.modal.help .modal-head button')));
    await p.until('帮助关上', `!document.querySelector('.modal.help')`, 10000).catch(() => null);

    // ---- 一指画一笔陆地 ----
    const box = await map();
    const mid = (fx, fy) => ({ x: box.x + box.w * fx, y: box.y + box.h * fy });
    let land0 = await p.eval(LAND_N);
    let n = await settled();
    let land1 = land0;
    for (const row of [0.5, 0.42, 0.58, 0.36]) {
      await drag(mid(0.3, row), mid(0.7, row));
      await sleep(600);
      await p.until('算完', READY, 60000);
      land1 = await p.eval(LAND_N);
      if (land1 !== land0) break;
    }
    const n1 = await p.until('多了一步', `(${HEAD}).then((h) => (h && h.count > ${n} ? h.count : 0))`, 30000).catch(() => 0);
    check(land1 > land0 && n1 === n + 1, `一根手指在地图上拖：画上了陆地（${land0} → ${land1} 格），存着的多了一步（${n} → ${n1}）`, `陆地 ${land0} → ${land1}，步数 ${n} → ${n1}`);
    // 抬起以后不留预览圈：鼠标旁的那句话、画笔圈都没了（看得见的是那句话）
    check(!(await p.eval(`!!document.querySelector('.cursor-hint')`)), '手指抬起以后地图上不留鼠标旁的那句话');
    await p.shot('100-一指画了一笔');

    // ---- 两指捏合：镜头变了，没有多一步 ----
    n = await settled();
    land0 = await p.eval(LAND_N);
    const cam0 = await p.eval(CAM);
    await two(mid(0.45, 0.5), mid(0.55, 0.5), mid(0.3, 0.5), mid(0.7, 0.5));
    const cam1 = await p.eval(CAM);
    const nPinch = await settled();
    check(cam1.zoom > cam0.zoom * 2.5 && nPinch === n && (await p.eval(LAND_N)) === land0, `两指捏开：地图放大了（${cam0.zoom.toFixed(0)} → ${cam1.zoom.toFixed(0)}，手指拉开到 4 倍），没有多一步（还是 ${nPinch} 步），陆地没变`, JSON.stringify({ cam0, cam1, n, nPinch }));
    // ---- 两指平移：镜头挪了，大小不变，没有多一步 ----
    await two(mid(0.45, 0.4), mid(0.55, 0.4), mid(0.45, 0.6), mid(0.55, 0.6));
    const cam2 = await p.eval(CAM);
    const dy = (cam1.y - cam2.y) * cam2.zoom;
    const nPan = await settled();
    check(Math.abs(cam2.zoom - cam1.zoom) < cam1.zoom * 0.01 && Math.abs(dy - box.h * 0.2) < 3 && Math.abs(cam2.x - cam1.x) * cam2.zoom < 3 && nPan === n, `两指一起往下拖 ${Math.round(box.h * 0.2)} 像素：地图跟着下来 ${dy.toFixed(1)} 像素，大小没变，没有多一步`, JSON.stringify({ cam1, cam2, dy, n, nPan }));
    // 看全图（给没有键盘的人补的按钮）
    await tap(await p.eval(centerOf('.ruler-btn.fit-btn')));
    await sleep(400);
    const cam3 = await p.eval(CAM);
    check(Math.abs(cam3.zoom - cam0.zoom) < cam0.zoom * 0.01, `点左下角的“看全图”：回到整张地图（${cam3.zoom.toFixed(0)}）`, JSON.stringify({ cam0, cam3 }));

    // ---- 画到一半第二根手指落下：这一笔不算 ----
    await drag(mid(0.3, 0.3), mid(0.5, 0.3), 10, false);
    await touch('touchStart', [[1, mid(0.5, 0.3).x, mid(0.5, 0.3).y], [2, mid(0.7, 0.3).x, mid(0.7, 0.3).y]]);
    await sleep(60);
    for (let k = 1; k <= 8; k++) {
      await touch('touchMove', [[1, mid(0.5 - 0.01 * k, 0.3).x, mid(0.5, 0.3).y], [2, mid(0.7 + 0.01 * k, 0.3).x, mid(0.7, 0.3).y]]);
      await sleep(15);
    }
    // 第二根抬起；剩下的那根（起笔的那根）接着动：不画、镜头也不再动
    await touch('touchEnd', [[2, mid(0.78, 0.3).x, mid(0.5, 0.3).y]]);
    await sleep(60);
    const camLift = await p.eval(CAM);
    for (let k = 1; k <= 6; k++) {
      await touch('touchMove', [[1, mid(0.42 + 0.03 * k, 0.35).x, mid(0.5, 0.35).y]]);
      await sleep(15);
    }
    await touch('touchEnd', []);
    const cam4 = await p.eval(CAM);
    const nHalf = await settled();
    check((await p.eval(LAND_N)) === land0 && nHalf === n && cam4.zoom > cam3.zoom * 1.5, `画到一半第二根手指落下：这一笔不算（陆地还是 ${land0} 格，还是 ${nHalf} 步），改成了缩放（${cam3.zoom.toFixed(0)} → ${cam4.zoom.toFixed(0)}）`, JSON.stringify({ land: await p.eval(LAND_N), land0, n, nHalf, cam3, cam4 }));
    check(JSON.stringify(camLift) === JSON.stringify(cam4), '第二根抬起以后，剩下的那根接着动：不画，镜头也不动（全部抬起以后才回到工具）', JSON.stringify({ camLift, cam4 }));
    await tap(await p.eval(centerOf('.ruler-btn.fit-btn')));
    await sleep(300);

    // ---- pointercancel：不留半笔，之后还能接着画 ----
    await drag(mid(0.3, 0.7), mid(0.6, 0.7), 10, false);
    await p.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await sleep(300);
    const nCancel = await settled();
    check((await p.eval(LAND_N)) === land0 && nCancel === n, `画着被系统拿走（touchcancel）：这一笔不算（陆地、步数都没变）`, JSON.stringify({ land: await p.eval(LAND_N), land0, n, nCancel }));
    let land2 = land0;
    for (const row of [0.7, 0.64, 0.76, 0.3]) {
      await drag(mid(0.3, row), mid(0.7, row));
      await sleep(600);
      await p.until('算完', READY, 60000);
      land2 = await p.eval(LAND_N);
      if (land2 !== land0) break;
    }
    const n2 = await p.until('多了一步', `(${HEAD}).then((h) => (h && h.count > ${n} ? h.count : 0))`, 30000).catch(() => 0);
    check(land2 > land0 && n2 === n + 1, `之后还能接着画：再拖一笔，陆地 ${land0} → ${land2} 格，多了一步`, `陆地 ${land0} → ${land2}，步数 ${n} → ${n2}`);

    // ---- 长按：钉住“这里”（拿着点的工具时） ----
    await tap(await p.eval(byTitle('省份')));
    await sleep(300);
    const tool = await p.eval(`document.querySelector('.bottombar .bb-tool.on')?.dataset.tool ?? null`);
    const here0 = await p.eval(HERE);
    // 对照：点一下不钉住
    await tap(mid(0.5, 0.45));
    const here1 = await p.eval(HERE);
    await touch('touchStart', [[1, mid(0.5, 0.45).x, mid(0.5, 0.45).y]]);
    await sleep(800);
    const here2 = await p.eval(HERE);
    await touch('touchEnd', []);
    await sleep(300);
    check(tool === 'pselect' && !here0?.open && !here1?.open && !!here2?.open && here2.title.includes('钉住'), `拿着“选省份”：点一下不钉住，按住不动 0.8 秒钉住了“这里”（卡片的标题“${here2?.title}”）`, JSON.stringify({ tool, here0, here1, here2 }));
    await p.shot('100-长按钉住');
    // 画笔下按住不动不钉住（是预览）
    await tap(await p.eval(centerOf('.here.open .here-head .icon-btn', 1)));
    await sleep(200);
    await tap(await p.eval(byTitle('地形')));
    await sleep(300);
    const nHold0 = await settled();
    await touch('touchStart', [[1, mid(0.2, 0.2).x, mid(0.2, 0.2).y]]);
    await sleep(800);
    const hereBrush = await p.eval(HERE);
    await p.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await sleep(300);
    check(!hereBrush?.open && (await settled()) === nHold0, '拿着画笔按住不动：不钉住（按住是预览）', JSON.stringify(hereBrush));

    // ---- 屏幕上代替 Shift 的开关：多选 ----
    await tap(await p.eval(byTitle('省份')));
    await sleep(300);
    const multi = await p.eval(`(() => { const t = [...document.querySelectorAll('.bottombar button.toggle')].find((b) => b.textContent.trim() === '多选'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    check(!!multi && multi.h >= TOUCH_MIN, `“选省份”的底部条上有“多选”开关（没有键盘按不了 Shift），高 ${multi?.h} 像素`, JSON.stringify(multi));
    if (multi) {
      await tap(multi);
      // 点陆地上的几处，直到凑出两个省
      let picked = '';
      for (const [fx, fy] of [[0.5, 0.45], [0.42, 0.5], [0.58, 0.4], [0.35, 0.42], [0.62, 0.55], [0.48, 0.6]]) {
        await tap(mid(fx, fy));
        picked = await p.eval(`document.querySelector('.bottombar')?.textContent ?? ''`);
        if (/已选 [2-9] 个省份/.test(picked)) break;
      }
      check(/已选 [2-9] 个省份/.test(picked), `开着“多选”点几个省：底部条写着“${(picked.match(/已选 \d+ 个省份/) ?? [''])[0]}”`, picked.slice(0, 80));
      await p.shot('100-多选');
      // 换工具就关上
      await tap(await p.eval(byTitle('地形')));
      await tap(await p.eval(byTitle('省份')));
      await sleep(300);
      check((await p.eval(`[...document.querySelectorAll('.bottombar button.toggle')].find((b) => b.textContent.trim() === '多选')?.getAttribute('aria-checked')`)) === 'false', '换了工具再回来：“多选”关着');
    }

    // ---- 横着 1024×768 ----
    await tap(await p.eval(byTitle('地形')));
    await viewport(1024, 768);
    await p.shot('100-主界面-1024x768');
    await walk('1024×768');
    // 问话框、向导：“世界 → 新建世界…”——这个世界改过、没存进“我的地图”，先问一句“保存当前世界”
    await openPanel('world');
    await tap(await p.eval(`(() => { const e = [...document.querySelectorAll('.menu .item')].find((x) => (x.querySelector('b')?.textContent ?? '') === '新建世界…'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
    const asked = await p.until('问话框', `!!document.querySelector('.modal.ask')`, 10000).catch(() => false);
    check(!!asked, '手指点“新建世界…”：先问了一句（这个世界改过、没存）');
    if (asked) {
      await sleep(300);
      await panelFits('1024×768 · 问话框', '.modal.ask', '.modal-backdrop', true);
      await p.shot('100-问话框-1024x768');
      await tap(await p.eval(buttonByText('.modal.ask .ask-actions', '不保存')));
    }
    await p.until('向导', `!!document.querySelector('.modal.wizard')`, 20000);
    await p.until('向导里的缩略图', `document.querySelectorAll('.modal.wizard button.thumb:not([disabled])').length >= 6`, 180000);
    await sleep(400);
    await panelFits('1024×768 · 向导第一屏', '.modal.wizard', '.modal-backdrop', true);
    const wzView = await p.eval(VIEW);
    const lastThumb = await p.eval(`Math.max(...[...document.querySelectorAll('.modal.wizard button.thumb')].map((e) => e.getBoundingClientRect().bottom))`);
    check(true, `（向导第一屏在 1024×768 下六张缩略图的底边在 ${Math.round(lastThumb)} 像素，视口高 ${wzView.h}：${lastThumb <= wzView.h ? '不用滚' : '要往下滚一点'}）`);
    await p.shot('100-向导-1024x768');
    // 展开“自定义…”：更高了，能滚
    await tap(await p.eval(centerOf('.modal.wizard .wizard-custom-btn')));
    await sleep(500);
    await panelFits('1024×768 · 向导展开“自定义…”', '.modal.wizard', '.modal-backdrop', true);
    await p.shot('100-向导-自定义-1024x768');
    await p.eval(`(() => { const b = document.querySelector('.modal.wizard .modal-head button[title="关闭"]') ?? [...document.querySelectorAll('.modal.wizard .modal-head button')].pop(); if (b) b.click(); })()`);
    await p.until('向导关上', `!document.querySelector('.modal.wizard')`, 10000).catch(() => null);
    check(!(await p.eval(`!!document.querySelector('.modal.wizard')`)) && (await p.eval(READY)), '关上向导：原来的世界还在');

    // ---- 手机那么窄：说一句，不是坏的 ----
    await viewport(390, 844);
    await sleep(400);
    const narrow = await p.eval(`(() => { const e = document.querySelector('.narrow-note'); return e ? e.textContent.trim() : null; })()`);
    const of3 = await p.eval(OVERFLOW);
    check(!!narrow && narrow.includes('屏幕太窄') && narrow.includes('平板或电脑') && of3.sw <= of3.w, `宽 390 像素（手机）：最上面说“${narrow}”，页面没有横向溢出`, JSON.stringify({ narrow, of3 }));
    await p.shot('100-手机-390x844');
    await viewport(768, 1024);
    check(!(await p.eval(`!!document.querySelector('.narrow-note')`)), '回到平板的宽度：那一句没了');

    check(p.errors.length === 0, '第十五段：页面里没有没接住的错', p.errors.slice(0, 3).join('；'));
  } finally {
    await p.send('Page.close').catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}
