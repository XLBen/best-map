// 冒烟的第九十七轮那一段（生成的进度与取消；由 tools/smoke.mjs 调，见那里开头的说明）。
// 都从外面做：点向导、读页面上的字和进度条、点“取消”。只有“让一笔编辑变久”借了调试协议：在计算 Worker 里把它发
// “走到哪一步了”的那一下拖慢（每条忙等 0.8 秒——无头 Chrome 不让调慢 Worker 的 CPU），程序里没有为冒烟留任何东西。

// 世界里所有的类型数组（原因、自定义场、推导）合起来的摘要：取消以后是不是原样，看它
const ARRAYS = `(() => { const w = window.__map2 && window.__map2.world(); if (!w) return null; let h = 2166136261; let n = 0; const eat = (a) => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); } n += b.length; }; for (const o of [w.causes, w.causes.fields, w.derived]) for (const k of Object.keys(o).sort()) if (ArrayBuffer.isView(o[k])) eat(o[k]); return (h >>> 0).toString(16) + ':' + n; })()`;
// 顶上中间的提示条（不算一直在的那几条）
const NOTICE = `(() => { const all = [...document.querySelectorAll('.notices .notice')].filter((e) => !e.classList.contains('banner')).map((e) => e.textContent.trim()); return all.length ? all.join('｜') : null; })()`;
// 页面上正在算的那一行（向导里的、顶上的、启动时中间的——哪个在就是哪个）：写的字、进度条画到百分之几、有没有“取消”、按不按得了
const BUSY = `(() => { const bars = [...document.querySelectorAll('.progress-bar')]; const bar = bars[0]; if (!bar) return null; const box = bar.parentElement; const stop = box.querySelector('.busy-stop'); return { text: box.querySelector('.busy-text')?.textContent ?? '', pct: Number(bar.getAttribute('aria-valuenow')), width: parseFloat(bar.firstElementChild.style.width), stop: stop ? stop.textContent.trim() : null, disabled: stop ? stop.disabled : null, where: box.className, bars: bars.length, stops: document.querySelectorAll('.busy-stop').length }; })()`;
const clickStop = `(() => { const b = document.querySelector('.busy-stop'); if (!b) throw new Error('没有“取消”'); b.click(); })()`;

// tracked：这个页面开着的 Worker 的名单（前面几段已经经调试协议挂上了的话）；没给时这里自己挂
export async function progressSteps({ cdp, q, origin, check, sleep, stroke, count, READY, LAND, HEAD, ASK, clickMenuItem, tracked = null }) {
  // 一边等一边记下正在算的那一行（每 40 毫秒看一次），直到 done() 为真
  async function watch(done, ms = 240000) {
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      let b = null;
      try {
        b = await q.eval(BUSY);
      } catch {
        // 页面正在换
      }
      if (b) seen.push({ ...b, at: Date.now() - t0 });
      if (await done(seen, b)) return seen;
      await sleep(40);
    }
    throw new Error('等不到这一步做完');
  }
  const names = (seen) => [...new Set(seen.map((s) => s.text))];
  const rising = (seen) => seen.every((s, k) => k === 0 || s.width >= seen[k - 1].width);
  const openWizard = async () => {
    await q.eval(clickMenuItem('新世界…'));
    // 有没存进“我的地图”的改动时先问一句：不保存
    await sleep(400);
    if (await q.eval(ASK)) await q.eval(`[...document.querySelectorAll('.modal.ask .ask-actions button')].find((x) => x.textContent === '不保存').click()`);
    await q.until('向导', `!!document.querySelector('.modal.wizard')`, 20000);
    await q.until('向导里的小图', `!!document.querySelector('.modal.wizard button.thumb:not([disabled])')`, 120000);
  };
  // 选“整个星球”（类地，6 万多格：比一块地区久一倍，来得及看、来得及点），等它的小图出来
  const pickPlanet = async () => {
    await q.eval(`(() => { const b = [...document.querySelectorAll('.modal.wizard button')].find((x) => x.textContent.trim() === '整个星球'); if (!b) throw new Error('向导里找不到“整个星球”'); b.click(); })()`);
    await sleep(600);
    await q.until('星球的小图', `!!document.querySelector('.modal.wizard button.thumb:not([disabled])')`, 120000);
  };

  console.log('12. 生成的进度与取消');
  // 上一段最后停在故意弄坏的页面上：照常打开
  await q.send('Page.navigate', { url: `${origin}/?progress` });
  // 上一段故意让它连着几次没打开成：这一次会先问——再试一次
  await q.until('世界打开，或者先问', `(${READY}) || !!(${ASK})`, 120000);
  if (await q.eval(ASK)) await q.eval(`[...document.querySelectorAll('.modal.ask .ask-actions button')].find((x) => x.textContent === '再试一次').click()`);
  await q.until('世界打开', READY, 120000);
  await sleep(1500);
  await q.until('算完', READY, 60000);
  const n00 = await count(q);
  // ---- 平常的一笔：不闪进度条 ----
  // 页面里记下“正在计算…”在了多久、中间出没出过进度条（每 16 毫秒看一次，比从外面问得勤；不用 requestAnimationFrame：
  // 冒烟的页面可能在后面的标签里，那里它不走）
  const WATCH_BUSY = `(() => { const m = (window.__busy = { ms: 0, bars: 0, t0: 0, on: true }); const f = () => { if (!m.on) return; const spin = !!document.querySelector('.notices .notice .spinner'); const now = performance.now(); if (spin && !m.t0) m.t0 = now; if (spin) m.ms = now - m.t0; if (document.querySelector('.progress-bar')) m.bars++; setTimeout(f, 16); }; f(); return true; })()`;
  const BUSY_SEEN = `(() => { const m = window.__busy; m.on = false; return { ms: Math.round(m.ms), bars: m.bars }; })()`;
  const landQ = await q.eval(LAND);
  await q.eval(WATCH_BUSY);
  await stroke(q, 0.52);
  await q.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(landQ)}`, 60000).catch(() => null);
  await q.until('算完', READY, 60000);
  await sleep(300);
  const seenQ = await q.eval(BUSY_SEEN);
  check((await q.eval(LAND)) !== landQ, '画了一笔');
  // 1.5 秒以内做完的一笔不该露出进度条（估着快好的一步最晚 1.5 秒才显示）；这台机器的无头 Chrome 里更久的，照规矩该有
  if (seenQ.ms < 1500) check(seenQ.bars === 0, `平常画一笔（“正在计算…”在了 ${seenQ.ms} 毫秒）：照旧只是“正在计算…”，没有闪出进度条`, `进度条出现了 ${seenQ.bars} 次（每 16 毫秒看一次）`);
  else check(true, `（这一笔在无头 Chrome 里算了 ${seenQ.ms} 毫秒，超过 1.5 秒：按规矩该有进度条（出现了 ${seenQ.bars} 次）——“平常一笔不闪”这一项这次没验证到）`);
  await q.until('自动保存跟上', `(${HEAD}).then((h) => !!h && h.count === ${'${n00 + 1}'})`, 30000).catch(() => null);
  await q.until('算完', READY, 60000);

  const land0 = await q.eval(LAND);
  const arrays0 = await q.eval(ARRAYS);
  const n0 = await count(q);
  check(!!arrays0 && !(await q.eval(BUSY)), `开着原来的世界（${n0} 步），没有在算的：没有进度条`);

  // ---- 新建一个世界（整个星球，带人文），做到一半取消 ----
  await openWizard();
  await pickPlanet();
  await q.eval(`document.querySelector('.modal.wizard button.thumb:not([disabled])').click()`);
  // 看到进度条、步名换过至少一次，就点“取消”
  let before;
  try {
    before = await watch((seen) => names(seen).length >= 2, 120000);
  } catch {
    before = [];
  }
  const first = before[0];
  check(!!first && first.at > 500 && first.at < 4000, `点了小图：${first ? (first.at / 1000).toFixed(1) : '?'} 秒后向导里出现进度条（“${first?.text}” ${first?.pct}%）——不是一点就有，也不用等几秒`, first ? `${first.at} 毫秒` : '没有出现进度条');
  check(names(before).length >= 2, `步名在变：${names(before).join(' → ')}`, `只看到 ${JSON.stringify(names(before))}`);
  check(rising(before), `进度只增不减（${before.map((s) => s.pct).filter((v, k, a) => k === 0 || v !== a[k - 1]).join('% → ')}%）`, before.map((s) => s.width).join(' '));
  check(!!first && first.stop === '取消' && first.stops === 1 && first.bars === 1 && first.where.includes('wizard-busy'), '向导里有“取消”，页面上只有这一个（顶上的提示条不再出一份）', JSON.stringify(first));
  // 截图之前把那一行挪进视野（点小图的人本来就在向导底下；冒烟是用脚本点的，没有滚过去）
  await q.eval(`document.querySelector('.wizard-busy')?.scrollIntoView({ block: 'center' })`);
  await q.shot('向导里-进度与取消');
  const still = await q.eval(BUSY);
  check(!!still && still.stop === '取消' && (await q.eval(LAND)) === land0, '点“取消”的时候还没生成完', JSON.stringify(still));
  // 给现在的世界做个记号：回到原来的世界是重新打开它，换上的是一个新的对象
  await q.eval(`(() => { window.__w0 = window.__map2.world(); return true; })()`);
  await q.eval(clickStop);
  const said = await q.until('说已取消', `(() => { const t = ${NOTICE}; return t && t.includes('已取消') ? t : null; })()`, 15000).catch(() => null);
  check(!!said && said.includes('已取消，回到了原来的世界'), `点“取消”：“${said}”`, `说的是：${await q.eval(NOTICE)}`);
  // 回到原来的世界要重新打开它（原来的计算程序在新建开始时已经换掉了）：这一阵也有进度，没有“取消”
  const back = await watch(async () => (await q.eval(`window.__map2.world() !== window.__w0`)) && (await q.eval(READY)) && !(await q.eval(BUSY)), 180000);
  const restoring = back.filter((s) => s.stop === null);
  check(back.every((s) => s.stop === null), `回到原来的世界的那一阵${restoring.length ? `有进度（${names(restoring).join(' → ')}）、` : ''}没有“取消”`, JSON.stringify(back.find((s) => s.stop !== null)));
  check((await q.eval(LAND)) === land0 && (await q.eval(ARRAYS)) === arrays0, '回到了原来的世界：每一个数组都逐字节不变', `之前 ${arrays0}，现在 ${await q.eval(ARRAYS)}`);
  check((await q.eval(`!!document.querySelector('.modal.wizard')`)) && !(await q.eval(BUSY)), '向导还开着（可以重新选），进度条没了');
  check((await count(q)) === n0, `存着的还是原来的世界（${n0} 步）`, `是 ${await count(q)} 步`);
  await q.shot('取消以后-回到原来的世界');

  // ---- 再完整生成一次 ----
  await q.until('向导里的小图', `!!document.querySelector('.modal.wizard button.thumb:not([disabled])')`, 120000);
  const gen0 = (await q.eval(HEAD))?.gen ?? 0;
  await q.eval(`document.querySelector('.modal.wizard button.thumb:not([disabled])').click()`);
  const tFull = Date.now();
  const full = await watch(async (seen) => seen.length > 0 && !(await q.eval(BUSY)) && !(await q.eval(`!!document.querySelector('.modal.wizard')`)) && (await q.eval(READY)), 240000);
  const fullMs = Date.now() - tFull;
  check(names(full).length >= 3, `完整生成一次（${(fullMs / 1000).toFixed(1)} 秒）：步名一步一步换（${names(full).join(' → ')}）`, JSON.stringify(names(full)));
  check(rising(full) && full.at(-1).pct <= 99, `进度只增不减，做完之前没有画到头（最后看到 ${full.at(-1).pct}%）`, full.map((s) => s.width).join(' '));
  check(names(full).every((t) => /^正在.+…$/.test(t) && !/[A-Za-z]/.test(t)), '写的都是人话（“正在……”），没有英文');
  check(!(await q.eval(BUSY)) && !(await q.eval(`!!document.querySelector('.notices .notice .spinner')`)) && (await q.eval(`document.querySelectorAll('.busy-stop').length`)) === 0, '做完以后进度条、“取消”、转圈都没了');
  check((await q.eval(LAND)) !== land0, '是新的世界');
  const nNew = await q.until('新世界自动保存', `(${HEAD}).then((h) => (h && h.count > 0 && h.gen !== ${gen0} ? h.count : 0))`, 30000).catch(() => 0);
  check(nNew > 0, `新世界照常自动保存（${nNew} 步，整份重新写的）`, `存着的头：${JSON.stringify(await q.eval(HEAD))}`);
  // 上一次真实的各步耗时记下来了
  const kept = await q.eval(`(() => { try { return JSON.parse(localStorage.getItem('map2.progress') || '[]').map((x) => x[0] + '：' + x[1].length + ' 步'); } catch { return null; } })()`);
  check(Array.isArray(kept) && kept.some((k) => k.startsWith('init:')), `这一次各步真实的耗时记在了浏览器里（下一次按它估）：${(kept ?? []).join('；').slice(0, 160)}`, JSON.stringify(kept));

  // ---- 一步编辑做到一半取消：计算程序自己停下，不用换 ----
  // 让一笔变成几秒：在计算 Worker 里把发“走到哪一步了”的那一下拖慢（每条忙等 0.8 秒；别的消息照常）
  const workers = tracked ?? [];
  if (!tracked) {
    cdp.on((m) => {
      if (m.sessionId === q.sessionId && m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'worker') workers.push({ sessionId: m.params.sessionId, url: m.params.targetInfo.url });
      if (m.method === 'Target.detachedFromTarget') {
        const k = workers.findIndex((w) => w.sessionId === m.params.sessionId);
        if (k >= 0) workers.splice(k, 1);
      }
    });
    await q.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(800);
  }
  // 在一个 Worker 里跑一句，最多等 5 秒（已经不在了的、卡着的不等）
  const inWorker = (w, expression) => Promise.race([cdp.send('Runtime.evaluate', { expression }, w.sessionId).then(() => true, () => false), sleep(5000).then(() => false)]);
  const engines = workers.filter((w) => w.url.startsWith('data:text/javascript') || /\/assets\/worker-/.test(w.url));
  const why0 = engines.length ? '' : `没找到计算 Worker（挂上 ${workers.length} 个：${workers.map((w) => w.url.slice(0, 30)).join('；')}）`;
  const SLOW = `(() => { if (self.__post) return true; self.__post = self.postMessage.bind(self); self.postMessage = (m, t) => { if (m && m.kind === 'stage') { const t0 = Date.now(); while (Date.now() - t0 < 800) {} } return self.__post(m, t); }; return true; })()`;
  const FAST = `(() => { if (self.__post) { self.postMessage = self.__post; delete self.__post; } return true; })()`;
  let slowed = 0;
  for (const w of engines) if (await inWorker(w, SLOW)) slowed++;
  if (!slowed) {
    check(false, '在计算 Worker 里把那一下拖慢', why0 || `${engines.length} 个计算 Worker 都没应答`);
    return;
  }
  await q.until('算完', READY, 60000);
  const land2 = await q.eval(LAND);
  const arrays2 = await q.eval(ARRAYS);
  const n2 = await count(q);
  const engineIds = engines.map((w) => w.sessionId).join(',');
  // 顶上的“取消”一出现就点（在页面里等、每 16 毫秒看一次：从外面一来一回要几百毫秒，会错过最后一个能停的地方）
  const CLICK_WHEN_SHOWN = `new Promise((resolve) => { const t0 = performance.now(); const f = () => { const b = document.querySelector('.notices .notice .busy-stop'); if (b) { const box = b.parentElement; const info = { text: box.querySelector('.busy-text').textContent, pct: Number(box.querySelector('.progress-bar')?.getAttribute('aria-valuenow')), stops: document.querySelectorAll('.busy-stop').length }; b.click(); resolve(info); return; } if (performance.now() - t0 > 60000) { resolve(null); return; } setTimeout(f, 16); }; f(); })`;
  const clicking = q.eval(CLICK_WHEN_SHOWN);
  await stroke(q, 0.6);
  const edit = await clicking;
  check(!!edit && edit.stops === 1, `把计算拖慢以后画一笔：顶上出现进度条和“取消”（“${edit?.text}” ${edit?.pct}%），一出现就点了它`, '没有出现（这一笔还是太快）');
  if (edit) {
    const mid = await q.eval(BUSY).catch(() => null);
    if (mid) check(mid.text === '正在取消…' && mid.disabled === true, '点了以后、它停下之前：写着“正在取消…”，按钮按不了', JSON.stringify(mid));
    // 那一句只在 6 秒：先读它，再截图（截图在后面的标签里要等好几秒）
    const said2 = await q.until('说已取消', `(() => { const t = ${NOTICE}; return t && t.includes('已取消') ? t : null; })()`, 30000).catch(() => null);
    await q.until('算完', READY, 120000);
    const tooLate = (await q.eval(LAND)) !== land2;
    if (tooLate) check(true, '（点的时候这一笔正好算完了：没有取消成，这一项这次没验证到）');
    else {
      check(!!said2 && said2.includes('已取消，世界回到了这一步之前') && !said2.includes('重做记录'), `点“取消”：“${said2}”`, `说的是：${await q.eval(NOTICE)}`);
      check((await q.eval(ARRAYS)) === arrays2, '世界回到了这一笔之前：每一个数组都逐字节不变', `之前 ${arrays2}，现在 ${await q.eval(ARRAYS)}`);
      const now = workers.filter((w) => w.url.startsWith('data:text/javascript') || /\/assets\/worker-/.test(w.url)).map((w) => w.sessionId).join(',');
      check(now === engineIds, '计算程序还是原来那一个（它自己停下的，没有结束它、没有重新打开世界）', `之前 ${engineIds}，现在 ${now}`);
      await sleep(2500);
      check((await count(q)) === n2, `存着的还是 ${n2} 步`, `是 ${await count(q)} 步`);
    }
    await q.shot('一笔-取消以后');
  }
  for (const w of engines) await inWorker(w, FAST);
  // 之后照常能画、能存
  const land3 = await q.eval(LAND);
  const n3 = await count(q);
  await stroke(q, 0.3);
  await q.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land3)}`, 60000).catch(() => null);
  await q.until('算完', READY, 60000);
  const head = await q.until('自动保存跟上', `(${HEAD}).then((h) => (h && h.count === ${n3 + 1} ? h : null))`, 30000).catch(() => null);
  check((await q.eval(LAND)) !== land3 && !!head, `之后照常能画、能存（${head?.count} 步）`, `存着 ${await count(q)} 步`);
}
