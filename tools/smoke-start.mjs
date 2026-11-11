// 冒烟的第九十八轮那一段（第一次打开一键开始、重新生成前的确认；由 tools/smoke.mjs 调，见那里开头的说明）。
// 都从外面做：开一个存储是空的浏览器环境（Target.createBrowserContext），看向导的第一屏、点缩略图、点“帮助”、按 ?、
// 在地图上拖人口笔刷、点“文化 ⋯”里的按钮、读问话里的字。程序里没有为冒烟留任何东西。

// 世界里所有的类型数组（原因、自定义场、推导）连同小数据合起来的摘要：两个世界是不是逐字节相同，看它
const WORLD = `(() => { const w = window.__map2 && window.__map2.world(); if (!w) return null; let h = 2166136261; let n = 0; const eat = (b) => { for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); } n += b.length; }; for (const o of [w.causes, w.causes.fields, w.derived]) for (const k of Object.keys(o).sort()) if (ArrayBuffer.isView(o[k])) eat(new Uint8Array(o[k].buffer, o[k].byteOffset, o[k].byteLength)); eat(new TextEncoder().encode(JSON.stringify(w.small))); return (h >>> 0).toString(16) + ':' + n; })()`;
// 向导的第一屏：缩略图、“自定义…”、“帮助”在不在窗口里（不用滚动）
const FIRST = `(() => {
  const wz = document.querySelector('.modal.wizard');
  if (!wz) return null;
  const vh = window.innerHeight, vw = window.innerWidth;
  const inView = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw; };
  const thumbs = [...wz.querySelectorAll('button.thumb')];
  const custom = wz.querySelector('.wizard-custom-btn');
  const help = wz.querySelector('.wizard-help');
  return {
    size: vw + '×' + vh,
    scroll: document.querySelector('.modal-backdrop').scrollTop,
    thumbs: thumbs.length,
    ready: thumbs.filter((t) => !t.disabled).length,
    thumbsIn: thumbs.filter(inView).length,
    lowest: Math.round(Math.max(...thumbs.map((t) => t.getBoundingClientRect().bottom))),
    lead: wz.querySelector('.wizard-lead h5')?.textContent ?? '',
    buttons: [...wz.querySelectorAll('.wizard-lead button')].map((b) => b.textContent.trim()),
    custom: custom ? { text: custom.textContent.trim(), inView: inView(custom), open: custom.classList.contains('open') } : null,
    help: help ? { text: help.textContent.trim(), inView: inView(help) } : null,
    summary: wz.querySelector('.wizard-summary')?.textContent ?? null,
    body: !!wz.querySelector('.wizard-custom'),
    sections: [...wz.querySelectorAll('.wizard-custom h5')].map((h) => h.textContent),
    changed: wz.querySelectorAll('.slider-value.changed').length,
  };
})()`;
// 第一张缩略图画的是什么（两次打开向导是不是同一张）
const THUMB0 = `(() => { const c = document.querySelector('.modal.wizard button.thumb canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 2166136261; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); })()`;
const HELP = `(() => { const m = document.querySelector('.modal.help'); return m ? { title: m.querySelector('h2')?.textContent ?? '', first: m.querySelector('h5')?.textContent ?? '', start: [...m.querySelectorAll('.help-start li')].map((x) => x.textContent), keys: [...m.querySelectorAll('table.kv tr')].map((r) => r.textContent).filter((t) => t.includes('?')) } : null; })()`;
// 手改过人口的格数
const MANUAL = `(() => { const w = window.__map2.world(); const m = w.causes.popManual; if (!m) return 0; let k = 0; for (let i = 0; i < m.length; i++) if (m[i] === 1 && w.causes.land[i] === 1) k++; return k; })()`;
const COUNTS = `(() => { const s = window.__map2.world().small; const n = (o) => (o ? Object.keys(o).length : 0); return { countries: n(s.countries), cities: n(s.cities), roads: n(s.roads), landmarks: n(s.landmarks), human: !!s.human }; })()`;
// 弹出面板里按字找按钮点一下
const clickIn = (root, text) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(root)} + ' button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('找不到按钮“' + ${JSON.stringify(text)} + '”'); if (b.disabled) throw new Error('按钮“' + ${JSON.stringify(text)} + '”按不了'); b.click(); return true; })()`;

export async function startSteps({ cdp, Page, origin, check, sleep, READY, HEAD, ASK, clickMenuItem }) {
  const key = async (p, k, code, vk, text, modifiers = 0) => {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(150);
  };
  const question = (p) => key(p, '?', 'Slash', 191, '?', 8);
  const size = async (p, width, height) => {
    await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
  };
  const askGone = (p) => p.until('问话关上', `!(${ASK})`, 10000);

  console.log('13. 第一次打开一键开始、重新生成前的确认');
  // 存储是空的：另开一个浏览器环境（和前面几段的页面互不相干）
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const p = await Page.open(cdp, `${origin}/`, browserContextId);
  try {
    // ---- 第一屏 ----
    await size(p, 1280, 800);
    await p.until('向导', `!!document.querySelector('.modal.wizard')`, 60000);
    await p.until('六张缩略图都画好', `document.querySelectorAll('.modal.wizard button.thumb:not([disabled])').length === 6`, 180000);
    const a = await p.eval(FIRST);
    check(!!a && a.thumbs === 6 && a.thumbsIn === 6 && a.scroll === 0, `存储是空的第一次打开（${a?.size}）：六张缩略图都在窗口里，不用滚动（最下面一张的底边在 ${a?.lowest} 像素）`, JSON.stringify(a));
    check(a?.lead === '挑一张开始' && JSON.stringify(a.buttons) === JSON.stringify(['换一批', '自定义…']), `缩略图上面一句“${a?.lead}”，旁边是“${a?.buttons.join('”“')}”`, JSON.stringify(a));
    check(!!a?.custom?.inView && !a.custom.open && !a.body && !!a.help?.inView && a.help.text === '帮助', '“自定义…”看得见、收着；“帮助”看得见', JSON.stringify(a));
    check((a?.summary ?? '').startsWith('现在用的：群岛之海 · 一片海域 · ') && a.summary.includes('带国家和城市'), `收着时一行小字写着现在用的：“${a?.summary}”`, JSON.stringify(a?.summary));
    await p.shot('98-第一屏-1280x800');
    await size(p, 1024, 700);
    const b = await p.eval(FIRST);
    check(!!b && b.thumbsIn === 6 && b.scroll === 0 && !!b.custom?.inView && !!b.help?.inView, `窗口 ${b?.size}：六张缩略图、“自定义…”、“帮助”也都在窗口里（最下面一张的底边在 ${b?.lowest} 像素）`, JSON.stringify(b));
    await p.shot('98-第一屏-1024x700');
    await size(p, 1280, 800);

    // ---- 没有世界时的帮助 ----
    check((await p.eval(`!window.__map2 || !window.__map2.world()`)) === true, '这时还没有世界');
    await p.eval(`document.querySelector('.modal.wizard .wizard-help').click()`);
    const h1 = await p.until('帮助打开', HELP, 10000).catch(() => null);
    check(!!h1 && h1.title === '帮助' && h1.first === '怎么开始' && h1.start.length === 4, `没有世界时点向导上的“帮助”：打开了，最上面是“${h1?.first}”的 ${h1?.start.length} 句`, JSON.stringify(h1));
    check(!!h1 && h1.keys.length === 1, `帮助的按键表里写着这个键（${h1?.keys.join('')}）`, JSON.stringify(h1?.keys));
    await p.shot('98-帮助-没有世界时');
    await question(p);
    check((await p.eval(HELP)) === null, '按 ?：关上了');
    await question(p);
    check(!!(await p.eval(HELP)), '再按 ?：又开了（没有世界、只有向导时也行）');
    await question(p);
    check((await p.eval(HELP)) === null && (await p.eval(`!!document.querySelector('.modal.wizard')`)), '再按：关上，向导还在');

    // ---- 点一张就开始 ----
    const thumbA = await p.eval(THUMB0);
    await p.eval(`document.querySelector('.modal.wizard button.thumb:not([disabled])').click()`);
    await p.until('世界生成好', `!document.querySelector('.modal.wizard') && (${READY})`, 240000);
    await sleep(500);
    await p.until('算完', READY, 60000);
    const w1 = await p.eval(WORLD);
    const c1 = await p.eval(COUNTS);
    check(!!w1 && c1.human && c1.countries > 0 && c1.cities > 0, `点第一张：世界生成出来了（带人文，${c1.countries} 个国家、${c1.cities} 座城市）`, JSON.stringify(c1));
    await p.until('自动保存', `(${HEAD}).then((h) => !!h && h.count > 0)`, 30000).catch(() => null);

    // ---- 展开“自定义…”、什么都不改、点同一张：逐字节相同 ----
    await p.eval(clickMenuItem('新世界…'));
    await sleep(400);
    if (await p.eval(ASK)) await p.eval(clickIn('.modal.ask .ask-actions', '不保存'));
    await p.until('向导', `!!document.querySelector('.modal.wizard')`, 20000);
    await p.until('六张缩略图都画好', `document.querySelectorAll('.modal.wizard button.thumb:not([disabled])').length === 6`, 180000);
    check((await p.eval(THUMB0)) === thumbA, '再打开向导：还是刚才那一批缩略图（第一张逐像素相同）');
    await p.eval(`document.querySelector('.modal.wizard .wizard-custom-btn').click()`);
    await sleep(500);
    const open = await p.eval(FIRST);
    check(!!open?.body && open.custom.open && open.summary === null && open.sections.includes('地形') && open.sections.includes('库') && open.sections.includes('人文') && open.sections.includes('世界的种类'), `点“自定义…”：在原地展开（${open?.sections.join('、')}），那一行小字收起`, JSON.stringify(open));
    check((await p.eval(`localStorage.getItem('map2.wizard.custom')`)) === '1', '展开过：记在这台机器上');
    await p.eval(`document.querySelector('.modal.wizard .wizard-custom').scrollIntoView({ block: 'start' })`);
    await p.shot('98-自定义-展开');
    // 在输入框里打 ?：是打字，不开帮助
    await p.eval(`(() => { const v = document.querySelector('.modal.wizard .wizard-terrain .slider-value.can-type'); if (!v) throw new Error('地形的滑块右边没有能点的数'); v.click(); })()`);
    await p.until('数的输入框', `document.activeElement && document.activeElement.classList.contains('slider-entry')`, 5000);
    await question(p);
    const typed = await p.eval(`document.activeElement.classList.contains('slider-entry') ? document.activeElement.value : null`);
    check((await p.eval(HELP)) === null && typeof typed === 'string' && typed.includes('?'), `在输入框里打 ?：帮助没有开，框里多了一个 ?（“${typed}”）`, `帮助${(await p.eval(HELP)) ? '开了' : '没开'}，框里是 ${JSON.stringify(typed)}`);
    await key(p, 'Escape', 'Escape', 27);
    const still = await p.eval(FIRST);
    check(!!still?.body && still.changed === 0 && (await p.eval(THUMB0)) === thumbA, 'Esc 取消那个框：什么都没改（滑块没有动过的，缩略图还是那一批），向导还开着', JSON.stringify(still));
    await p.eval(`document.querySelector('.modal.wizard button.thumb:not([disabled])').click()`);
    await p.until('世界生成好', `!document.querySelector('.modal.wizard') && (${READY})`, 240000);
    await sleep(500);
    await p.until('算完', READY, 60000);
    const w2 = await p.eval(WORLD);
    check(!!w2 && w2 === w1, '展开“自定义…”、什么都不改、点同一张：和刚才那个世界逐字节相同（每一个数组和小数据）', `刚才 ${w1}，这次 ${w2}`);

    // ---- 重新生成：有手改会被换掉时才问 ----
    const openCulture = async () => {
      await p.eval(`(() => { if (document.querySelector('.popover')) return; const b = [...document.querySelectorAll('.topbar button.tb-btn')].find((x) => x.title === '文化'); if (!b) throw new Error('找不到“文化”按钮'); b.click(); })()`);
      await sleep(200);
      await p.eval(`(() => { if (document.querySelector('.popover')) return; const m = document.querySelector('.bottombar .bb-tool.more'); if (!m) throw new Error('底部条上没有“⋯”'); m.click(); })()`);
      await p.until('“文化 ⋯”', `!!document.querySelector('.popover') && [...document.querySelectorAll('.popover button')].some((x) => x.textContent.trim() === '删除人文')`, 10000);
    };
    const n0 = (await p.eval(HEAD))?.count ?? 0;
    await p.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count > 0)`, 30000).catch(() => null);
    const n1 = (await p.eval(HEAD))?.count ?? n0;
    await openCulture();
    const keeps = await p.eval(`[...document.querySelectorAll('.popover .hint')].map((x) => x.textContent).find((t) => t.includes('手改过的格')) || null`);
    check(!!keeps, `“文化 ⋯”里按钮下面写着留着什么：“${keeps}”`, '没有这一行');
    await p.eval(`[...document.querySelectorAll('.popover button')].find((x) => x.textContent.trim() === '删除人文').scrollIntoView({ block: 'center' })`);
    await p.shot('98-文化设置-重新生成那一段');
    await p.eval(clickIn('.popover', '重新生成'));
    await sleep(1200);
    check((await p.eval(ASK)) === null, '没有手改时点“重新生成”：不问');
    await p.until('算完', READY, 120000);
    const n2 = await p.until('多了一步', `(${HEAD}).then((h) => (h && h.count === ${n1 + 1} ? h.count : 0))`, 30000).catch(() => 0);
    check(n2 === n1 + 1, `做了：存着的多了一步（${n1} → ${n2}）`, `存着 ${(await p.eval(HEAD))?.count} 步`);

    // 手改几格人口：人口笔刷、改人数，在地图上拖几道
    await p.eval(`(() => { if (document.querySelector('.popover')) document.querySelector('.popover .icon-btn').click(); })()`);
    await p.eval(`(() => { const t = [...document.querySelectorAll('.bottombar .bb-tool')].find((x) => x.textContent.trim() === '人口'); if (!t) throw new Error('底部条上没有“人口”'); t.click(); })()`);
    await sleep(200);
    await p.eval(clickIn('.bottombar', '改人数'));
    const box = await p.eval(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    for (const row of [0.35, 0.45, 0.55, 0.65]) {
      const y = box.y + box.h * row;
      const x0 = box.x + box.w * 0.25;
      const x1 = box.x + box.w * 0.75;
      await p.mouse('mouseMoved', x0, y, 0);
      await p.mouse('mousePressed', x0, y);
      for (let k = 1; k <= 16; k++) {
        await p.mouse('mouseMoved', x0 + ((x1 - x0) * k) / 16, y);
        await sleep(15);
      }
      await p.mouse('mouseReleased', x1, y, 0);
      await sleep(400);
      await p.until('算完', READY, 60000);
      if ((await p.eval(MANUAL)) > 0) break;
    }
    const manual = await p.eval(MANUAL);
    check(manual > 0, `用人口笔刷在地图上拖：手改了 ${manual} 格人口`, '一格都没改到（拖过的地方没有陆地）');
    if (manual > 0) {
      // 只重新生成人文：手改过的格留着——不算会被换掉，不问
      await openCulture();
      await p.eval(clickIn('.popover', '重新生成'));
      await sleep(1200);
      check((await p.eval(ASK)) === null, '手改过人口以后点“重新生成”：这一种留着手改的格，不问');
      await p.until('算完', READY, 120000);
      await sleep(300);
      check((await p.eval(MANUAL)) === manual, `做完以后那 ${manual} 格还是手改过的（留着）`, `现在 ${await p.eval(MANUAL)} 格`);
      // 换一个库重新生成：手改过的格不留——问，数对
      await p.until('算完', READY, 60000);
      await sleep(1800);
      const before = await p.eval(WORLD);
      const nBefore = (await p.eval(HEAD))?.count ?? 0;
      await openCulture();
      await p.eval(clickIn('.popover', '换库、文化组…'));
      await p.until('选库的下拉', `!!document.querySelector('.popover select')`, 10000);
      const other = await p.eval(`(() => { const s = document.querySelector('.popover select'); const o = [...s.options].find((x) => x.value && x.value !== s.value); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.textContent; })()`);
      await sleep(500);
      await p.eval(clickIn('.popover', '重新生成'));
      const ask = await p.until('问话', ASK, 10000).catch(() => null);
      check(!!ask && ask.title === '重新生成' && ask.text === `会换掉你手改过的 ${manual} 格人口。可以撤销。`, `换成“${other}”重新生成（手改过的格不留）：问了，“${ask?.text}”——数对`, JSON.stringify(ask));
      check(!!ask && JSON.stringify(ask.buttons) === JSON.stringify(['先不', '重新生成']), `按钮写动作：${ask?.buttons.join(' / ')}`, JSON.stringify(ask?.buttons));
      await p.shot('98-问话-重新生成');
      await p.eval(clickIn('.modal.ask .ask-actions', '先不'));
      await askGone(p);
      await sleep(1500);
      check((await p.eval(WORLD)) === before && (await p.eval(MANUAL)) === manual && ((await p.eval(HEAD))?.count ?? 0) === nBefore, '点“先不”：世界不变（每一个数组和小数据逐字节相同，存着的步数也没变）', `之前 ${before}，现在 ${await p.eval(WORLD)}`);
      await p.eval(`(() => { const b = [...document.querySelectorAll('.popover button')].find((x) => x.textContent.trim() === '取消'); if (b) b.click(); })()`);
      await sleep(200);
    }

    // ---- 删除人文的问话 ----
    const c2 = await p.eval(COUNTS);
    const before2 = await p.eval(WORLD);
    await openCulture();
    await p.eval(clickIn('.popover', '删除人文'));
    const del = await p.until('问话', ASK, 10000).catch(() => null);
    check(!!del && del.title === '删除人文' && del.text.includes(`${c2.countries} 个国家`) && del.text.includes(`${c2.cities} 座城市`) && del.text.includes(`${c2.roads} 条道路`), `“删除人文”的问话里写着一起没了的：“${del?.text}”`, `${JSON.stringify(del)}；世界里 ${JSON.stringify(c2)}`);
    check(!!del && JSON.stringify(del.buttons) === JSON.stringify(['先不', '删除']), `按钮：${del?.buttons.join(' / ')}`);
    await p.shot('98-问话-删除人文');
    await p.eval(clickIn('.modal.ask .ask-actions', '先不'));
    await askGone(p);
    check((await p.eval(WORLD)) === before2, '点“先不”：没有删');

    // ---- 有世界时 ? 也行；展开过的“自定义…”刷新后还是展开的 ----
    await p.eval(`(() => { if (document.querySelector('.popover')) document.querySelector('.popover .icon-btn').click(); })()`);
    await question(p);
    const h2 = await p.eval(HELP);
    check(!!h2 && h2.first === '怎么开始', '有世界时按 ?：帮助打开，最上面还是“怎么开始”');
    await p.shot('98-帮助-有世界时');
    await question(p);
    check((await p.eval(HELP)) === null, '再按：关上');
    await p.eval(clickMenuItem('新世界…'));
    await sleep(400);
    if (await p.eval(ASK)) await p.eval(clickIn('.modal.ask .ask-actions', '不保存'));
    await p.until('向导', `!!document.querySelector('.modal.wizard')`, 20000);
    const again = await p.eval(FIRST);
    check(!!again?.body && again.custom.open, '下次打开向导：“自定义…”还是展开的');
    // 换一批、第一张一画好就点（后面几张还排着，被丢掉）：向导里、顶上都不出现和新建无关的“这一步没做”
    await p.eval(clickIn('.modal.wizard .wizard-lead', '换一批'));
    await sleep(300);
    await p.until('第一张缩略图', `!!document.querySelector('.modal.wizard button.thumb:not([disabled])')`, 120000);
    await p.eval(`(() => { const seen = (window.__said = { notes: [], on: true }); const f = () => { if (!seen.on) return; for (const e of document.querySelectorAll('.wizard-note, .notices .notice.error')) { const t = e.textContent.trim(); if (t && !seen.notes.includes(t)) seen.notes.push(t); } setTimeout(f, 30); }; f(); return true; })()`);
    const pending = await p.eval(`document.querySelectorAll('.modal.wizard button.thumb[disabled]').length`);
    await p.eval(`document.querySelector('.modal.wizard button.thumb:not([disabled])').click()`);
    await p.until('世界生成好', `!document.querySelector('.modal.wizard') && (${READY})`, 240000);
    await sleep(1500);
    const said = await p.eval(`(() => { window.__said.on = false; return window.__said.notes; })()`);
    if (pending > 0) check(true, `点的时候还有 ${pending} 张缩略图没画好（它们被丢掉）`);
    else check(true, '（点的时候六张都画好了：没有被丢掉的缩略图，下面这一项这次没验证到）');
    check(!said.some((t) => t.includes('这一步没做') || t.includes('世界已换')), `生成的这一阵向导里、顶上都没有出现“这一步没做：世界已换”（出现过的话：${said.length ? said.join('｜') : '没有'}）`, said.join('｜'));
    check(p.errors.length === 0, '第十三段：页面里没有没接住的错', p.errors.slice(0, 3).join('；'));
  } finally {
    await p.send('Page.close').catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}
