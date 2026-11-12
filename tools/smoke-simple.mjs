// 冒烟的第九十九轮那一段（简单界面与帮助；由 tools/smoke.mjs 调，见那里开头的说明）。
// 都从外面做：另开一个存储是空的浏览器环境，点顶栏、底部条、“更多”里的开关，按数字键，在地图上拖，读帮助里的字，
// 把一份没生成过地形的世界文件交给“打开世界文件…”的文件框（调试协议的 DOM.setFileInputFiles；文件写在冒烟的临时目录里）。
// 程序里没有为冒烟留任何东西（认东西靠界面上本来就有的 class 和 data-tool、data-rest、data-view）。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 底部条上那一排：露着的工具（data-tool）、哪个选着、末尾“还有 N 个”的数（没有时 0）、有没有“只留常用的”
const BAR = `(() => {
  const bar = document.querySelector('.bottombar .bb-tools');
  if (!bar) return null;
  const tools = [...bar.querySelectorAll('.bb-tool[data-tool]')];
  const rest = bar.querySelector('.bb-rest[data-rest]');
  const fold = bar.querySelector('.bb-rest.open');
  return { tools: tools.map((b) => b.dataset.tool), on: tools.find((b) => b.classList.contains('on'))?.dataset.tool ?? null, titles: tools.map((b) => b.title), rest: rest ? Number(rest.dataset.rest) : 0, restText: rest ? rest.textContent.trim() : null, restTip: rest ? rest.title : null, fold: fold ? fold.textContent.trim() : null, dots: !!bar.querySelector('.bb-tool.more') };
})()`;
const category = (label) => `(() => { const b = [...document.querySelectorAll('.topbar button.tb-btn')].find((x) => x.title === ${JSON.stringify(label)}); if (!b) throw new Error('找不到“' + ${JSON.stringify(label)} + '”按钮'); b.click(); return true; })()`;
const CATS = ['地形', '气候', '自然', '水系', '省份', '地名', '文化', '国家', '城市'];
const LAND = `(() => { const w = window.__map2.world(); const a = w.causes.land; let n = 0; for (let i = 0; i < a.length; i++) n += a[i]; return n; })()`;
const PROVINCES = `Object.keys(window.__map2.world().small.provinces).length`;
// “图层”面板里：底图的按钮、“显示”里的开关、两处“还有 N …”
const LAYERS = `(() => {
  const p = document.querySelector('.popover');
  if (!p) return null;
  return { views: [...p.querySelectorAll('button[data-view]')].map((b) => b.dataset.view), toggles: [...p.querySelectorAll('.toggle .toggle-text')].map((t) => t.textContent.trim()), rest: [...p.querySelectorAll('.rest-line[data-rest]')].map((b) => b.textContent.trim()), fold: [...p.querySelectorAll('p.rest-line.open')].map((b) => b.textContent.trim()) };
})()`;
const ADJUST = `(() => { const p = document.querySelector('.popover'); if (!p) return null; return { rows: [...p.querySelectorAll('.slider-label, .slider .label, .slider-head')].map((x) => x.textContent.trim()), sliders: p.querySelectorAll('.slider').length, toggles: [...p.querySelectorAll('.toggle .toggle-text')].map((t) => t.textContent.trim()), fields: [...p.querySelectorAll('h5')].some((h) => h.textContent === '自定义场'), rest: [...p.querySelectorAll('.rest-line[data-rest]')].map((b) => b.textContent.trim()) }; })()`;
// 资源库首页：露着的卡片、最下面的“还有 N 类”/“只留常用的”
const HOME = `(() => { const l = document.querySelector('.lib-panel'); if (!l) return null; return { cards: [...l.querySelectorAll('.lp-card[data-card]')].map((c) => c.dataset.card), rest: l.querySelector('.lp-rest .rest-line[data-rest]')?.textContent.trim() ?? null, fold: l.querySelector('.lp-rest p.rest-line.open')?.textContent.trim() ?? null }; })()`;
const HELP = `(() => {
  const m = document.querySelector('.modal.help');
  if (!m) return null;
  const now = m.querySelector('.help-now');
  return { firstH5: m.querySelector('h5')?.textContent ?? '', now: now ? { title: now.querySelector('.help-now-title')?.textContent ?? '', tool: now.querySelector('.help-tool')?.textContent ?? '', items: [...now.querySelectorAll('li')].map((x) => x.textContent) } : null, search: !!m.querySelector('.help-search input'), focused: document.activeElement === m.querySelector('.help-search input'), q: m.querySelector('.help-search input')?.value ?? null, hits: [...m.querySelectorAll('.help-hits li, .help-hits tr')].map((x) => x.textContent), groups: [...m.querySelectorAll('.help-hits h5')].map((x) => x.textContent), none: m.querySelector('.help-none')?.textContent ?? null, steps: m.querySelectorAll('ol.steps > li').length };
})()`;
// 往帮助的搜索框里写字（和打字一样：改值、发 input 事件）
const helpType = (text) => `(() => { const i = document.querySelector('.modal.help .help-search input'); if (!i) throw new Error('帮助里没有搜索框'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const WIZARD_AT = `(() => { const wz = document.querySelector('.modal.wizard'); const back = document.querySelector('.modal-backdrop'); if (!wz || !back) return null; const r = wz.getBoundingClientRect(); const app = document.querySelector('.app')?.getBoundingClientRect(); return { top: Math.round(r.top * 10) / 10, scroll: back.scrollTop, page: (document.scrollingElement?.scrollTop ?? 0) + window.scrollY, appTop: app ? Math.round(app.top * 10) / 10 : null, max: back.scrollHeight - back.clientHeight }; })()`;
const CATCH_DOWNLOADS = `(() => { if (window.__dl) return; window.__dl = []; const mk = URL.createObjectURL.bind(URL); const blobs = new Map(); URL.createObjectURL = (b) => { const u = mk(b); blobs.set(u, b); return u; }; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push({ name: this.download, blob: blobs.get(this.href) || null }); return; } return click.call(this); }; })();`;
const clickIn = (root, text) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(root)} + ' button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('找不到按钮“' + ${JSON.stringify(text)} + '”'); if (b.disabled) throw new Error('按钮“' + ${JSON.stringify(text)} + '”按不了'); b.click(); return true; })()`;
const closePopover = `(() => { const p = document.querySelector('.popover .icon-btn'); if (p) p.click(); })()`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function simpleSteps({ cdp, Page, origin, check, sleep, READY, HEAD, ASK, clickMenuItem, tmp }) {
  const key = async (p, k, code, vk, text, modifiers = 0) => {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(200);
  };
  const digit = (p, n) => key(p, String(n), `Digit${n}`, 48 + n, String(n));
  const question = (p) => key(p, '?', 'Slash', 191, '?', 8);
  const panel = async (p, id) => {
    await p.eval(`(() => { if (document.querySelector('.popover')) return; const b = document.querySelector('.topbar button[data-panel="${id}"]'); if (!b) throw new Error('顶栏上没有 ${id}'); b.click(); })()`);
    await p.until('弹出面板', `!!document.querySelector('.popover')`, 10000);
    await sleep(200);
  };
  const bars = async (p) => {
    const out = {};
    for (const c of CATS) {
      await p.eval(category(c));
      await sleep(150);
      out[c] = await p.eval(BAR);
    }
    return out;
  };

  console.log('14. 简单界面与帮助');
  // 存储是空的：另开一个浏览器环境
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const p = await Page.open(cdp, `${origin}/#demo`, browserContextId);
  try {
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await p.until('世界生成好', READY, 180000);
    await p.until('自动保存', `(${HEAD}).then((h) => !!h && h.count > 0)`, 30000).catch(() => null);
    await p.eval(CATCH_DOWNLOADS);

    // ---- 空的浏览器里是简单界面 ----
    check((await p.eval(`localStorage.getItem('map2.lib.allSources')`)) === null, '存储是空的：没有记过“完整界面”');
    const simple = await bars(p);
    const shownN = Object.values(simple).reduce((n, b) => n + (b?.tools.length ?? 0), 0);
    const restN = Object.values(simple).reduce((n, b) => n + (b?.rest ?? 0), 0);
    check(same(simple['地形']?.tools, ['land', 'island', 'relief']) && simple['地形'].rest === 4 && simple['地形'].restText === '还有 4 个', `地形那一排只露 ${simple['地形']?.tools.length} 个工具（${simple['地形']?.tools.join('、')}），末尾“${simple['地形']?.restText}”`, JSON.stringify(simple['地形']));
    check((simple['地形']?.restTip ?? '').includes('画岛链') && simple['地形'].restTip.includes('完整界面') && simple['地形'].dots, `那个按钮的悬停写着藏着的是哪几个、怎么一直露着（“${simple['地形']?.restTip}”），“⋯”还在`, JSON.stringify(simple['地形']));
    check(
      same(simple['气候']?.tools, ['temp', 'moist']) && simple['气候'].rest === 0 && same(simple['自然']?.tools, ['biome']) && simple['自然'].rest === 2 && same(simple['水系']?.tools, ['river', 'lake']) && simple['水系'].rest === 1 && same(simple['地名']?.tools, ['rename', 'area', 'spot']) && simple['地名'].rest === 0,
      `气候 ${simple['气候']?.tools.length} 个、自然 ${simple['自然']?.tools.length} 个（还有 ${simple['自然']?.rest}）、水系 ${simple['水系']?.tools.length} 个（还有 ${simple['水系']?.rest}）、地名 ${simple['地名']?.tools.length} 个：没有藏着的那一排没有“还有”`,
      JSON.stringify(simple),
    );
    check(shownN === 22 && restN === 11, `九类一共露着 ${shownN} 个工具，“还有”里一共 ${restN} 个`, JSON.stringify(Object.fromEntries(Object.entries(simple).map(([k, v]) => [k, [v?.tools.length, v?.rest]]))));
    // 有省份的世界：省份的画笔、剪刀自己露出来
    check((await p.eval(PROVINCES)) > 0 && same(simple['省份']?.tools, ['pselect', 'pbrush', 'pcut']) && simple['省份'].rest === 1, `这个世界划分过省份（${await p.eval(PROVINCES)} 个）：省份那一排露着选择、画笔、剪刀，还有 ${simple['省份']?.rest} 个`, JSON.stringify(simple['省份']));
    await p.eval(category('地形'));
    await sleep(200);
    await p.shot('99-简单界面-地形');

    // ---- 数字键：藏着的工具按它的键能用，并且露出来 ----
    const titles = (await p.eval(BAR)).titles;
    check(titles[0].endsWith('（1）') && titles[1].endsWith('（2）') && titles[2].endsWith('（4）'), `露着的三个工具悬停里写的键是 1、2、4（3 是藏着的岛链）：${titles.map((t) => t.slice(-3)).join(' ')}`, JSON.stringify(titles));
    await digit(p, 3);
    const k3 = await p.eval(BAR);
    check(k3.on === 'chain' && same(k3.tools, ['land', 'island', 'chain', 'relief']) && k3.rest === 3, `按 3：换到了岛链，它露在那一排上自己的位置（${k3.tools.join('、')}），还有 ${k3.rest} 个`, JSON.stringify(k3));
    await p.shot('99-按键-藏着的工具露出来');
    // 用它：在地图上拖一条线，长出一串岛
    const land0 = await p.eval(LAND);
    const n0 = (await p.eval(HEAD))?.count ?? 0;
    const box = await p.eval(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    let land1 = land0;
    for (const row of [0.3, 0.5, 0.7, 0.4, 0.6]) {
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
      await sleep(600);
      await p.until('算完', READY, 60000);
      land1 = await p.eval(LAND);
      if (land1 !== land0) break;
    }
    const n1 = await p.until('多了一步', `(${HEAD}).then((h) => (h && h.count > ${n0} ? h.count : 0))`, 30000).catch(() => 0);
    check(land1 > land0 && n1 > n0, `用它在地图上拖一条线：长出了岛（陆地 ${land0} → ${land1} 格），存着的多了一步`, `陆地 ${land0} → ${land1}，步数 ${n0} → ${n1}`);
    await digit(p, 1);
    const k1 = await p.eval(BAR);
    check(k1.on === 'land' && same(k1.tools, ['land', 'island', 'chain', 'relief']), `按 1 回到画陆地：这个世界画过岛链了，岛链自己留在那一排上（${k1.tools.join('、')}）`, JSON.stringify(k1));
    await digit(p, 6);
    const k6 = await p.eval(BAR);
    check(k6.on === 'reroll' && k6.tools.includes('reroll'), `按 6：换到了重画（也是藏着的），它露出来了`, JSON.stringify(k6));
    await digit(p, 4);
    const k4 = await p.eval(BAR);
    check(k4.on === 'relief' && !k4.tools.includes('reroll'), '按 4 换到堆山：重画又收回去了（世界里没有它的东西）', JSON.stringify(k4));

    // ---- “还有 N 个”：只在这一排展开 ----
    await p.eval(`document.querySelector('.bottombar .bb-rest[data-rest]').click()`);
    await sleep(200);
    const open = await p.eval(BAR);
    check(same(open.tools, ['land', 'island', 'chain', 'relief', 'fragment', 'reroll', 'terrainClass']) && open.rest === 0 && open.fold === '只留常用的', `点“还有 3 个”：七个工具都露出来，按钮换成“${open.fold}”`, JSON.stringify(open));
    await p.shot('99-还有N个-展开');
    await p.eval(category('自然'));
    await sleep(200);
    const other = await p.eval(BAR);
    check(same(other.tools, ['biome']) && other.rest === 2, '只展开了地形这一排：自然还是只露一个', JSON.stringify(other));
    check((await p.eval(`localStorage.getItem('map2.lib.allSources')`)) === null, '没有动“完整界面”的偏好');
    await p.eval(category('地形'));
    await sleep(200);
    await p.eval(`document.querySelector('.bottombar .bb-rest.open').click()`);
    await sleep(200);
    const folded = await p.eval(BAR);
    check(same(folded.tools, ['land', 'island', 'chain', 'relief']) && folded.rest === 3, `点“只留常用的”：收回去了（${folded.tools.join('、')}，还有 ${folded.rest} 个）`, JSON.stringify(folded));

    // ---- 图层、调整 ----
    await panel(p, 'layers');
    const ly = await p.eval(LAYERS);
    check(!!ly && same(ly.views, ['terrain', 'dominant', 'temperature', 'precip', 'elevation', 'seaTemp']) && ly.rest.includes('还有 5 种底图'), `“图层”里露着 ${ly?.views.length} 种底图，下面“${ly?.rest[0]}”`, JSON.stringify(ly));
    check(!!ly && !ly.toggles.includes('风向') && ly.toggles.includes('地名') && ly.rest.some((t) => /^还有 \d+ 项$/.test(t)), `“显示”里露着：${ly?.toggles.join('、')}；下面“${ly?.rest[1]}”`, JSON.stringify(ly));
    await p.shot('99-图层-简单');
    await p.eval(`document.querySelector('.popover .rest-line[data-rest]').click()`);
    await sleep(200);
    const ly2 = await p.eval(LAYERS);
    check(!!ly2 && ly2.views.length === 11 && ly2.views.includes('uplift') && ly2.views.includes('habitability') && ly2.fold.some((t) => t.includes('只留常用的') && t.includes('完整界面')), `点“还有 5 种底图”：${ly2?.views.length} 种都在，下面“${ly2?.fold[0]}”`, JSON.stringify(ly2));
    // 正看着不常用的那一种时收回去：它照常露着
    await p.eval(`document.querySelector('.popover button[data-view="uplift"]').click()`);
    await sleep(300);
    await p.eval(`document.querySelector('.popover p.rest-line.open button').click()`);
    await sleep(200);
    const ly3 = await p.eval(LAYERS);
    check(!!ly3 && ly3.views.includes('uplift') && ly3.views.length === 7, `看着“抬升”时点“只留常用的”：它还在（${ly3?.views.join('、')}）`, JSON.stringify(ly3));
    await p.eval(`document.querySelector('.popover button[data-view="terrain"]').click()`);
    await p.eval(closePopover);
    await sleep(200);
    await panel(p, 'adjust');
    const adj = await p.eval(ADJUST);
    check(!!adj && adj.sliders === 4 && !adj.fields && adj.toggles.length === 0 && adj.rest.length === 1, `“调整”里露着 ${adj?.sliders} 个滑块，没有开关、没有“自定义场”，下面“${adj?.rest[0]}”`, JSON.stringify(adj));
    await p.shot('99-调整-简单');
    await p.eval(closePopover);
    await sleep(200);

    // ---- 资源库的首页 ----
    const libButton = `(() => { const b = [...document.querySelectorAll('.topbar button.tb-btn')].find((x) => x.textContent.trim() === '资源库'); if (!b) throw new Error('找不到“资源库”按钮'); b.click(); return true; })()`;
    await p.eval(libButton);
    await p.until('资源库面板', `!!document.querySelector('.lib-panel .lp-card[data-card]')`, 20000);
    await sleep(300);
    const MORE_CARDS = ['valueGroup', 'variables', 'faction', 'countryTier', 'countryPattern', 'cityRank', 'pointType', 'planetForm', 'terrainClass', 'resource', 'provinceRules'];
    const home1 = await p.eval(HOME);
    check(!!home1 && home1.cards.length > 0 && !home1.cards.some((c) => MORE_CARDS.includes(c)) && /^还有 \d+ 类$/.test(home1.rest ?? ''), `资源库首页露着 ${home1?.cards.length} 张卡片（${home1?.cards.join('、')}），最下面“${home1?.rest}”`, JSON.stringify(home1));
    await p.shot('99-资源库首页-简单');
    await p.eval(`document.querySelector('.lib-panel .lp-rest .rest-line[data-rest]').click()`);
    await sleep(300);
    const home2 = await p.eval(HOME);
    check(!!home2 && home2.cards.includes('resource') && home2.cards.includes('provinceRules') && home2.cards.length > home1.cards.length && (home2.fold ?? '').includes('只留常用的'), `点它：${home2?.cards.length} 张都在（多了 ${home2?.cards.filter((c) => !home1.cards.includes(c)).join('、')}），下面“${home2?.fold}”`, JSON.stringify(home2));
    await p.shot('99-资源库首页-展开');
    await p.eval(`document.querySelector('.lib-panel .lp-rest p.rest-line.open button').click()`);
    await sleep(300);
    const home3 = await p.eval(HOME);
    check(!!home3 && home3.cards.length === home1.cards.length, '点“只留常用的”：收回去了', JSON.stringify(home3));
    await p.eval(libButton);
    await p.until('资源库面板关上', `!document.querySelector('.lib-panel')`, 10000).catch(() => null);

    // ---- 没划分过省份的世界：省份只露“选择”；划分了，画笔、剪刀自己露出来 ----
    await p.eval(clickMenuItem('世界文件（.json）'));
    const doc = await p.until('导出的世界文件', `(async () => { const d = (window.__dl || []).at(-1); if (!d || !d.blob) return null; return JSON.parse(await d.blob.text()); })()`, 20000).catch(() => null);
    const cut = doc ? doc.commands.findIndex((c) => c.op === 'set_worldgen' || (c.op === 'batch' && c.commands.some((x) => x.op === 'set_worldgen'))) : -1;
    if (!doc || cut < 0) check(false, '拿到世界文件、找到生成地形的那一步', JSON.stringify(doc ? doc.commands.map((c) => c.op) : null));
    else {
      // 只留生成地形之前的（新世界默认加的内容）：一个还没生成地形、没划分过省份的世界
      const blank = { ...doc, commands: doc.commands.slice(0, cut) };
      const file = join(tmp, 'smoke-blank-world.json');
      writeFileSync(file, JSON.stringify(blank));
      await p.eval(`(() => { if (!document.querySelector('.menu')) document.querySelector('.topbar button[data-panel="world"]').click(); })()`);
      await p.until('“世界”菜单', `!!document.querySelector('.menu input[type=file]')`, 10000);
      const { root } = await p.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await p.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.menu input[type=file]' });
      await p.send('DOM.setFileInputFiles', { files: [file], nodeId });
      await sleep(600);
      if (await p.eval(ASK)) await p.eval(clickIn('.modal.ask .ask-actions', '不保存'));
      const opened = await p.until('空白的世界打开', `(${READY}) && Object.keys(window.__map2.world().small.provinces).length === 0`, 120000).catch(() => false);
      check(!!opened, '打开一份还没生成地形的世界文件：世界里没有省份');
      if (opened) {
        await sleep(500);
        if (await p.eval(ASK)) await p.eval(clickIn('.modal.ask .ask-actions', '不保存'));
        await p.eval(category('省份'));
        await sleep(300);
        const noProv = await p.eval(BAR);
        check(same(noProv?.tools, ['pselect']) && noProv.rest === 3, `省份那一排只露“选择”，还有 ${noProv?.rest} 个`, JSON.stringify(noProv));
        await p.shot('99-省份-没划分过');
        await p.eval(`document.querySelector('.bottombar .bb-tool.more').click()`);
        await p.until('“省份 ⋯”', `[...document.querySelectorAll('.popover button')].some((x) => x.textContent.trim() === '划分省份')`, 10000);
        await p.eval(clickIn('.popover', '划分省份'));
        await sleep(500);
        if (await p.eval(ASK)) await p.eval(clickIn('.modal.ask .ask-actions', '重新划分'));
        await p.until('划分好', `(${READY}) && Object.keys(window.__map2.world().small.provinces).length > 0`, 120000).catch(() => false);
        await p.eval(closePopover);
        await sleep(300);
        const prov = await p.eval(BAR);
        check((await p.eval(PROVINCES)) > 0 && same(prov?.tools, ['pselect', 'pbrush', 'pcut']) && prov.rest === 1, `点“划分省份”（${await p.eval(PROVINCES)} 个）：画笔、剪刀自己露出来了（${prov?.tools.join('、')}），没有碰任何开关`, JSON.stringify(prov));
        await p.shot('99-省份-划分以后');
      }
    }

    // ---- 完整界面：全都在，刷新后还记着 ----
    await panel(p, 'more');
    const tg = await p.eval(`(() => { const t = document.querySelector('.popover .full-ui'); return t ? { label: t.querySelector('.toggle-text').textContent.trim(), on: t.querySelector('.toggle').classList.contains('on'), hint: t.querySelector('.hint').textContent } : null; })()`);
    check(!!tg && tg.label === '完整界面' && !tg.on && tg.hint.includes('还有 N 个'), `“更多 → 偏好”里有“${tg?.label}”，关着，下面写着“${tg?.hint}”`, JSON.stringify(tg));
    await p.shot('99-更多-偏好');
    await p.eval(`document.querySelector('.popover .full-ui .toggle').click()`);
    await sleep(300);
    check((await p.eval(`localStorage.getItem('map2.lib.allSources')`)) === '1', '打开它：记在这台机器上（和资源库里“都摊开”是同一个键）');
    await p.eval(closePopover);
    const full = await bars(p);
    const fullN = Object.values(full).reduce((n, b) => n + (b?.tools.length ?? 0), 0);
    check(Object.values(full).every((b) => b && b.rest === 0 && b.fold === null) && same(full['地形'].tools, ['land', 'island', 'chain', 'relief', 'fragment', 'reroll', 'terrainClass']) && same(full['省份'].tools, ['pselect', 'pbrush', 'pcut', 'pregen']) && fullN === 33, `完整界面：九类 ${fullN} 个工具全都在，没有“还有”也没有“只留常用的”`, JSON.stringify(Object.fromEntries(Object.entries(full).map(([k, v]) => [k, [v?.tools.length, v?.rest]]))));
    await p.eval(category('地形'));
    await sleep(200);
    await p.shot('99-完整界面-地形');
    await panel(p, 'layers');
    const lf = await p.eval(LAYERS);
    check(!!lf && lf.views.includes('uplift') && lf.toggles.includes('风向') && lf.toggles.includes('洋流') && lf.rest.length === 0 && lf.fold.length === 0, `“图层”里底图 ${lf?.views.length} 种、开关 ${lf?.toggles.length} 个都在，没有“还有”`, JSON.stringify(lf));
    await p.eval(closePopover);
    await panel(p, 'adjust');
    const af = await p.eval(ADJUST);
    check(!!af && af.sliders >= 8 && af.fields && af.rest.length === 0, `“调整”里 ${af?.sliders} 个滑块、${af?.toggles.length} 个开关、“自定义场”都在`, JSON.stringify(af));
    await p.eval(closePopover);
    await p.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count > 0)`, 30000).catch(() => null);
    await sleep(2500);
    await p.send('Page.reload');
    await p.until('刷新后世界回来', READY, 180000);
    await sleep(500);
    await p.eval(category('地形'));
    await sleep(300);
    const after = await p.eval(BAR);
    check(same(after?.tools, ['land', 'island', 'chain', 'relief', 'fragment', 'reroll', 'terrainClass']) && after.rest === 0, `刷新后还是完整界面（地形 ${after?.tools.length} 个工具）`, JSON.stringify(after));
    // 关回去：又是简单界面
    await panel(p, 'more');
    await p.eval(`document.querySelector('.popover .full-ui .toggle').click()`);
    await sleep(300);
    await p.eval(closePopover);
    const back = await p.eval(BAR);
    check((await p.eval(`localStorage.getItem('map2.lib.allSources')`)) === null && !!back && back.rest > 0 && back.tools.length < 7, `关掉：回到简单界面（地形露 ${back?.tools.length} 个，还有 ${back?.rest} 个），那个键没了`, JSON.stringify(back));

    // ---- 帮助：现在这个工具、搜索 ----
    await digit(p, 2);
    await question(p);
    const h1 = await p.until('帮助', HELP, 10000).catch(() => null);
    check(!!h1 && !!h1.now && h1.now.tool.startsWith('放岛：') && h1.now.tool.includes('数字键 2') && h1.now.items.length > 0 && h1.firstH5 === '怎么开始', `按 ?：最上面一块“${h1?.now?.title}”，写着“${h1?.now?.tool}”和 ${h1?.now?.items.length} 条有关的；下面照旧是“${h1?.firstH5}”`, JSON.stringify(h1));
    check(!!h1 && h1.search && !h1.focused, '有搜索框，没有自己抢走焦点（再按 ? 还能关上）');
    await p.shot('99-帮助-现在这个工具');
    await p.eval(helpType('岛链'));
    await sleep(300);
    const h2 = await p.eval(HELP);
    check(!!h2 && h2.groups.includes('底部的工具') && h2.hits.some((t) => t.includes('画岛链：') && t.includes('数字键 3')) && h2.now === null && h2.steps === 0, `搜“岛链”：只剩搜到的 ${h2?.hits.length} 条（${h2?.groups.join('、')}），有“${h2?.hits.find((t) => t.includes('画岛链'))}”`, JSON.stringify(h2));
    await p.shot('99-帮助-搜到');
    await p.eval(helpType('撤销'));
    await sleep(300);
    const h3 = await p.eval(HELP);
    check(!!h3 && h3.groups.includes('按键') && h3.hits.some((t) => t.includes('⌘Z')), `搜“撤销”：按键里有“${h3?.hits.find((t) => t.includes('⌘Z'))}”，步骤里也有（${h3?.groups.join('、')}）`, JSON.stringify(h3));
    await p.eval(helpType('量子纠缠'));
    await sleep(300);
    const h4 = await p.eval(HELP);
    check(!!h4 && h4.hits.length === 0 && (h4.none ?? '').includes('没有找到“量子纠缠”') && h4.none.includes('换个'), `没搜到：说“${h4?.none}”`, JSON.stringify(h4));
    await p.shot('99-帮助-没搜到');
    // 在搜索框里打 ?：是打字，不关帮助
    await p.eval(`document.querySelector('.modal.help .help-search input').focus()`);
    await question(p);
    const h5 = await p.eval(HELP);
    check(!!h5 && (h5.q ?? '').includes('?'), `在搜索框里打 ?：帮助没关，框里多了一个 ?（“${h5?.q}”）`, JSON.stringify(h5));
    await p.eval(helpType(''));
    await sleep(200);
    const h6 = await p.eval(HELP);
    check(!!h6 && h6.steps >= 8 && !!h6.now, '清空搜索：整页回来了');
    await p.eval(`document.activeElement && document.activeElement.blur()`);
    await question(p);
    check((await p.eval(HELP)) === null, '离开搜索框再按 ?：关上了');

    // ---- 新建向导：“回到缩略图”不挪动向导 ----
    await p.eval(clickMenuItem('新建世界…'));
    await sleep(500);
    if (await p.eval(ASK)) await p.eval(clickIn('.modal.ask .ask-actions', '不保存'));
    await p.until('向导', `!!document.querySelector('.modal.wizard')`, 20000);
    await sleep(300);
    const w0 = await p.eval(WIZARD_AT);
    if (!(await p.eval(`!!document.querySelector('.modal.wizard .wizard-custom')`))) await p.eval(`document.querySelector('.modal.wizard .wizard-custom-btn').click()`);
    await p.until('“自定义…”展开', `!!document.querySelector('.modal.wizard .wizard-to-top')`, 10000);
    await p.eval(`document.querySelector('.modal-backdrop').scrollTo(0, 1e6)`);
    await sleep(300);
    const w1 = await p.eval(WIZARD_AT);
    await p.eval(`document.querySelector('.modal.wizard .wizard-to-top').click()`);
    await p.until('滚回顶上', `document.querySelector('.modal-backdrop').scrollTop === 0`, 10000).catch(() => null);
    await sleep(400);
    const w2 = await p.eval(WIZARD_AT);
    check(!!w0 && !!w1 && w1.scroll > 100 && !!w2 && w2.scroll === 0 && w2.top === w0.top && w2.page === 0 && w2.appTop === w0.appTop, `展开“自定义…”、滚到底（${w1?.scroll} 像素）、点“回到缩略图”：向导回到一打开时的位置（顶边 ${w0?.top} → ${w2?.top} 像素），外面那一层没有滚`, JSON.stringify({ w0, w1, w2 }));
    await p.shot('99-向导-回到缩略图以后');
    check(p.errors.length === 0, '第十四段：页面里没有没接住的错', p.errors.slice(0, 3).join('；'));
  } finally {
    await p.send('Page.close').catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}
