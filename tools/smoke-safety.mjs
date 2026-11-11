// 冒烟的第九十六轮那几段（不白屏、不卡死；从 tools/smoke.mjs 里分出来的，由它调：见那里开头的说明）。
// 做法都是从外面做，不用程序配合：让计算 Worker 忙等、吞掉发给它的“打开”、丢掉 WebGL 的上下文、装成没有 WebGL2、拦住下载
// 都经调试协议注入；只有“画界面时抛一个错”用了程序里留的钩子（src/smoke-hooks.ts，只在网址带 #map2-smoke-96 时才有）

// 下载都拦住：页面里要下载的时候记下文件名和内容，不真的下载
const CATCH_DOWNLOADS = `(() => { if (window.__dl) return; window.__dl = []; const mk = URL.createObjectURL.bind(URL); const blobs = new Map(); URL.createObjectURL = (b) => { const u = mk(b); blobs.set(u, b); return u; }; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push({ name: this.download, blob: blobs.get(this.href) || null }); return; } return click.call(this); }; })();`;
// 最近拦下的一个：文件名、是不是世界文件、几步；n 是一共拦下几个
const LAST_DL = `(async () => { const all = window.__dl || []; const d = all.at(-1); if (!d || !d.blob) return { n: all.length }; const t = await d.blob.text(); let doc = null; try { doc = JSON.parse(t); } catch {} return { n: all.length, name: d.name, chars: t.length, steps: doc && Array.isArray(doc.commands) ? doc.commands.length : -1, format: doc ? doc.format : null }; })()`;
// 顶上中间的提示条（“正在计算…”、一句话的提示；同时有两条时用“｜”隔开）
const NOTICE = `(() => { const all = [...document.querySelectorAll('.notices .notice')].filter((e) => !e.classList.contains('banner')).map((e) => e.textContent.trim()); return all.length ? all.join('｜') : null; })()`;
// 地图那块 WebGL 画布现在的样子（逐字节的摘要）
const GL_HASH = `(() => { const c = document.querySelector('canvas.map-gl'); const s = c.toDataURL('image/png'); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + ':' + s.length; })()`;
const GL_NOTE = `(() => { const n = document.querySelector('.gl-note'); return n ? { text: n.querySelector('.gl-note-text').textContent, buttons: [...n.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`;
// 顶上“没接住的错”的那一条
const MISHAP = `(() => { const all = [...document.querySelectorAll('.notices .notice.mishap')]; const m = all[0]; return m ? { n: all.length, text: m.querySelector('.notice-text').textContent, reason: m.querySelector('.mishap-reason pre')?.textContent ?? null, times: m.querySelector('.mishap-foot .hint')?.textContent ?? null } : null; })()`;
// 整页的自救页
const RESCUE = `(() => { const r = document.querySelector('.rescue'); return r ? { kind: r.dataset.kind, world: r.dataset.world, exported: r.dataset.exported ?? null, title: r.querySelector('.rescue-title').textContent, line: r.querySelector('.rescue-world').textContent, note: r.querySelector('.rescue-note').textContent, reason: r.querySelector('.rescue-reason pre').textContent, canExport: !r.querySelector('.rescue-export').disabled, buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()), inert: document.getElementById('app').hasAttribute('inert') } : null; })()`;
// 存着的自动保存是什么时候存的
const SAVED_AT = `(async () => await new Promise((resolve) => { const open = indexedDB.open('map2'); open.onerror = () => resolve(null); open.onsuccess = () => { const db = open.result; db.onversionchange = () => db.close(); const req = db.transaction('kv', 'readonly').objectStore('kv').get('autosave'); req.onsuccess = () => { db.close(); resolve(req.result ? req.result.savedAt : null); }; req.onerror = () => { db.close(); resolve(null); }; }; }))()`;
// 把发给计算 Worker 的“打开世界”吞掉（装成它卡住了、一直不回）；别的 Worker、别的消息照常
const SWALLOW_LOAD = `(() => { const W = window.Worker; window.Worker = new Proxy(W, { construct(T, args) { const w = new T(...args); const post = w.postMessage.bind(w); w.postMessage = (m, t) => (m && m.req && m.req.kind === 'load' ? undefined : post(m, t)); return w; } }); })();`;
// 装成这个浏览器没有 WebGL2
const NO_WEBGL2 = `(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return t === 'webgl2' ? null : g.call(this, t, ...a); }; })();`;
// 程序的主体一运行就出错（界面还没画出来）：第一次找 #app 时说没有
const NO_APP_ONCE = `(() => { const g = document.getElementById.bind(document); let once = false; document.getElementById = (id) => { if (id === 'app' && !once) { once = true; return null; } return g(id); }; })();`;
const SMOKE_HASH = '#map2-smoke-96';
const clickText = (scope, text) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('找不到按钮：' + ${JSON.stringify(text)}); b.click(); })()`;

// q：第七步之后的那个页面（停在向导上，没有世界）；errors：前七步里页面上没接住的错
export async function safetySteps({ cdp, q, origin, errors, check, sleep, stroke, count, ownWrite, READY, LAND, HEAD, ASK, clickMenuItem, closeMenu }) {
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  await q.send('Page.addScriptToEvaluateOnNewDocument', { source: CATCH_DOWNLOADS });
  await q.eval(CATCH_DOWNLOADS);
  // 这个页面开着的 Worker（调试协议自动挂上，之后新开的也挂）
  const workers = [];
  cdp.on((m) => {
    if (m.sessionId === q.sessionId && m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'worker') workers.push({ sessionId: m.params.sessionId, url: m.params.targetInfo.url });
    if (m.method === 'Target.detachedFromTarget') {
      const k = workers.findIndex((w) => w.sessionId === m.params.sessionId);
      if (k >= 0) workers.splice(k, 1);
    }
  });
  const isEngine = (w) => w.url.startsWith('data:text/javascript') || /\/assets\/worker-/.test(w.url);

  console.log('8. 计算程序卡住：导得出、停得下');
  // 第七步停在向导上（没有世界）：建一个
  await q.until('向导里的小图', `!!document.querySelector('.modal.wizard button.thumb:not([disabled])')`, 120000);
  await q.eval(`document.querySelector('.modal.wizard button.thumb:not([disabled])').click()`);
  await q.until('新世界建好', READY, 180000);
  const n8 = await q.until('自动保存', `(${HEAD}).then((h) => (h && h.count > 0 ? h.count : 0))`, 30000);
  await stroke(q, 0.5);
  await q.until('算完', READY, 60000);
  await q.until('自动保存多了一步', `(${HEAD}).then((h) => !!h && h.count === ${n8 + 1})`, 30000);
  await q.until('算完', READY, 60000);
  const land8 = await q.eval(LAND);
  await q.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(800);
  const engines = workers.filter(isEngine);
  check(engines.length >= 1, `找到了计算 Worker（${engines.length} 个；一共挂上 ${workers.length} 个 Worker）`, workers.map((w) => w.url.slice(0, 40)).join('；'));
  // 让它忙等十分钟（真的死循环一样：什么消息都不处理）
  for (const w of engines) void cdp.send('Runtime.evaluate', { expression: 'const t = Date.now(); while (Date.now() - t < 600000) {}' }, w.sessionId).catch(() => {});
  await sleep(300);
  await stroke(q, 0.4);
  // 从“正在计算…”出来起算
  await q.until('正在计算', `!!document.querySelector('.notices .notice .spinner')`, 20000).catch(() => null);
  const tHang = Date.now();
  // 第九十七轮：“停止”并进了进度条旁的“取消”，一步做了 1 秒就出现（不用等 5 秒没动静）
  const stop8 = await q.until('出现“取消”', `(() => { const b = document.querySelector('.notices .notice .busy-stop'); return b ? b.textContent.trim() : null; })()`, 20000).catch(() => null);
  const stopMs = Date.now() - tHang;
  check(stop8 === '取消', `画了一笔，“正在计算…”出来 ${(stopMs / 1000).toFixed(1)} 秒后旁边出现进度条和“取消”（提示条：“${await q.eval(NOTICE)}”）`, `没有出现；提示条是：${await q.eval(NOTICE)}`);
  check(stopMs > 500 && stopMs < 4000, '是 1 秒上下出现的（不是一开始就有，也不用等几秒）', `${stopMs} 毫秒`);
  check((await q.eval(`document.querySelectorAll('.busy-stop').length`)) === 1, '页面上只有一个“取消”');
  await q.shot('正在计算-取消');
  // 卡着的时候导出世界文件
  const dl0 = (await q.eval(LAST_DL)).n;
  const tExport = Date.now();
  await q.eval(clickMenuItem('世界文件（.json）'));
  const dl8 = await q.until('拿到文件', `(${LAST_DL}).then((d) => (d.n > ${dl0} ? d : null))`, 15000).catch(() => null);
  const exportMs = Date.now() - tExport;
  check(!!dl8 && dl8.format === 'map2-world' && dl8.steps === n8 + 1, `计算程序卡着时点“世界文件（.json）”：${(exportMs / 1000).toFixed(1)} 秒拿到文件（${dl8?.name}，${dl8?.steps} 步：到最后一条应答过的命令为止）`, JSON.stringify(dl8));
  check(exportMs < 8000, '几秒之内（不是一直等着）', `${exportMs} 毫秒`);
  const said8 = await q.until('说了那一步不在里面', `(() => { const t = ${NOTICE}; return t && t.includes('不在里面') ? t : null; })()`, 5000).catch(() => null);
  check(!!said8, `顶上说：“${said8}”`, `说的是：${await q.eval(NOTICE)}`);
  await q.eval(closeMenu);
  // 卡着的时候自动保存没有丢东西（应答过的都在）
  check((await count(q)) === n8 + 1, `存着的还是 ${n8 + 1} 步（没算完的那一步没有写进去）`, `是 ${await count(q)} 步`);
  // 取消：计算程序卡着（听不到“请停下”），没动静满 5 秒就结束它、用命令记录恢复
  await q.until('“取消”还在', `!!document.querySelector('.notices .notice .busy-stop')`, 20000);
  await q.eval(`document.querySelector('.notices .notice .busy-stop').click()`);
  const said8b = await q.until('说已取消', `(() => { const t = ${NOTICE}; return t && t.includes('已取消') ? t : null; })()`, 15000).catch(() => null);
  check(!!said8b && said8b.split('｜').some((x) => x.startsWith('已取消，世界回到了这一步之前')), `点“取消”：“${said8b}”`, `说的是：${await q.eval(NOTICE)}`);
  await q.until('世界恢复好', READY, 120000);
  check((await q.eval(LAND)) === land8, '世界还在，回到了这一步之前（陆地逐字节相同）', `之前 ${land8}，现在 ${await q.eval(LAND)}`);
  check(!(await q.eval(`!!document.querySelector('.notices .notice .busy-stop')`)), '“取消”消失');
  await stroke(q, 0.6);
  await q.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land8)}`, 60000).catch(() => null);
  await q.until('算完', READY, 60000);
  const head8 = await q.until('自动保存跟上', `(${HEAD}).then((h) => (h && h.count === ${n8 + 2} ? h : null))`, 30000).catch(() => null);
  check((await q.eval(LAND)) !== land8 && !!head8, `之后照常能画、能存（另开的计算程序；存着 ${head8?.count} 步）`, `存着 ${await count(q)} 步`);

  console.log('9. WebGL 的上下文丢了');
  // 鼠标挪到顶栏上（地图上不留预览），等画面停稳
  await q.mouse('mouseMoved', 640, 12, 0);
  await sleep(2500);
  await q.until('画面停稳', `(async () => { const a = ${GL_HASH}; await new Promise((r) => setTimeout(r, 400)); return a === ${GL_HASH}; })()`, 20000);
  const gl0 = await q.eval(GL_HASH);
  const lost = await q.eval(`(() => { const gl = document.querySelector('canvas.map-gl').getContext('webgl2'); window.__lose = gl.getExtension('WEBGL_lose_context'); if (!window.__lose) return false; window.__lose.loseContext(); return true; })()`);
  check(lost, '用 WEBGL_lose_context 丢掉上下文');
  const note9 = await q.until('地图上盖一层', GL_NOTE, 10000).catch(() => null);
  check(!!note9 && note9.text === '画面暂时不可用，正在恢复…' && note9.buttons.length === 0, `地图上盖着：“${note9?.text}”`, JSON.stringify(note9));
  await q.shot('画面暂时不可用');
  await q.eval(`window.__lose.restoreContext()`);
  const back9 = await q.until('那一层消失', `(${GL_NOTE}) === null`, 20000).catch(() => false);
  check(back9 !== false, '恢复以后那一层消失');
  await q.until('画面停稳', `(async () => { const a = ${GL_HASH}; await new Promise((r) => setTimeout(r, 400)); return a === ${GL_HASH}; })()`, 20000);
  await sleep(1500);
  const gl1 = await q.eval(GL_HASH);
  check(gl1 === gl0, '恢复后的画面和丢之前逐字节相同', `之前 ${gl0}，之后 ${gl1}`);
  // 丢了不还：等一阵提示重新载入，说清世界存好了没有；之后还了照样恢复
  await q.eval(`window.__lose.loseContext()`);
  const stuck9 = await q.until('说恢复不了', `(() => { const n = ${GL_NOTE}; return n && n.text.includes('没能恢复') ? n : null; })()`, 20000).catch(() => null);
  check(!!stuck9 && stuck9.buttons.includes('重新载入') && (stuck9.text.includes('已存在浏览器里') || stuck9.text.includes('导出文件')), `一阵没恢复：“${stuck9?.text}”（${stuck9?.buttons.join(' / ')}）`, JSON.stringify(await q.eval(GL_NOTE)));
  await q.shot('画面没能恢复');
  await q.eval(`window.__lose.restoreContext()`);
  await q.until('那一层消失', `(${GL_NOTE}) === null`, 20000).catch(() => null);
  await q.until('画面停稳', `(async () => { const a = ${GL_HASH}; await new Promise((r) => setTimeout(r, 400)); return a === ${GL_HASH}; })()`, 20000);
  await sleep(1500);
  const gl2 = await q.eval(GL_HASH);
  check(gl2 === gl0, '之后浏览器还了上下文：照样恢复，画面还是逐字节相同', `之前 ${gl0}，之后 ${gl2}`);
  // 恢复以后照常能画
  const land9 = await q.eval(LAND);
  await stroke(q, 0.3);
  await q.until('这一笔画上了', `(${LAND}) !== ${JSON.stringify(land9)}`, 60000).catch(() => null);
  await q.until('算完', READY, 60000);
  await q.mouse('mouseMoved', 640, 12, 0);
  await sleep(2500);
  check((await q.eval(LAND)) !== land9 && (await q.eval(GL_HASH)) !== gl0, '恢复以后照常能画（画面跟着变）');
  const n9 = await q.until('自动保存跟上', `(${HEAD}).then((h) => (h && h.count === ${n8 + 3} ? h.count : 0))`, 30000).catch(() => 0);

  console.log('10. 没接住的错、自救页');
  // 带着冒烟的记号重新打开（多一个 ? 让浏览器真的重新载入；只换 # 后面是不重新载入的）
  await q.send('Page.navigate', { url: `${origin}/?smoke${SMOKE_HASH}` });
  await q.until('钩子装上了', `!!window.__map2Smoke`, 60000);
  await q.until('世界打开', READY, 120000);
  const land10 = await q.eval(LAND);
  // 定时器里抛的错（和点击里抛的一样到 window 的 error）：连着五次
  await q.eval(`(() => { for (let k = 0; k < 5; k++) setTimeout(() => { throw new Error('冒烟：点击里抛的错'); }, k * 30); })()`);
  const m10 = await q.until('顶上的一条', MISHAP, 10000).catch(() => null);
  await sleep(400);
  const m10b = await q.eval(MISHAP);
  check(!!m10 && m10.text.includes('可能没做成') && m10.text.includes('世界还在') && m10b?.n === 1, `没接住的错：顶上一条“${m10?.text}”，同一个错来了五次还是一条`, JSON.stringify(m10b));
  await q.eval(clickText('.notices .notice.mishap button', '原因'));
  const m10c = await q.until('原因展开', `(() => { const m = ${MISHAP}; return m && m.reason ? m : null; })()`, 5000).catch(() => null);
  check(!!m10c && m10c.reason.includes('冒烟：点击里抛的错') && /5 次/.test(m10c.times ?? ''), `“原因”里是原话，写着${m10c?.times}`, JSON.stringify(m10c));
  await q.shot('没接住的错-原因');
  check((await q.eval(`!!document.querySelector('.topbar') && !document.querySelector('.rescue')`)) && (await q.eval(LAND)) === land10, '界面照常，世界没动');
  await q.eval(`document.querySelector('.notices .notice.mishap button[aria-label="关闭"]').click()`);
  // 一块画不出来：只关那一块
  await q.eval(`window.__map2Smoke.crashRender('part')`);
  const part10 = await q.until('顶上说那一块关闭了', `(() => { const m = ${MISHAP}; return m && m.text.includes('已经关闭') ? m : null; })()`, 10000).catch(() => null);
  check(!!part10 && !(await q.eval(`!!document.querySelector('.rescue')`)) && (await q.eval(`!!document.querySelector('.topbar')`)), `一块画不出来：“${part10?.text}”，别的照常`, JSON.stringify(await q.eval(MISHAP)));
  await q.shot('一块画不出来');
  // 整个界面画不出来：自救页
  await q.eval(`window.__map2Smoke.crashRender('root')`);
  const r10 = await q.until('自救页', RESCUE, 10000).catch(() => null);
  check(!!r10 && r10.kind === 'crash' && r10.title === '页面出了问题', `整个界面画不出来：整页的“${r10?.title}”（${r10?.buttons.join(' / ')}）`, JSON.stringify(r10));
  check(!!r10 && r10.line.includes('你的世界还在') && r10.canExport && r10.inert, `写着：“${r10?.line}”；下面的界面不再收鼠标键盘`, JSON.stringify(r10));
  check(!!r10 && r10.reason.includes('冒烟：画整个界面时抛的错'), '原因折叠着，里面是原话');
  await q.shot('自救页');
  const dl10 = (await q.eval(LAST_DL)).n;
  await q.eval(`document.querySelector('.rescue .rescue-export').click()`);
  const got10 = await q.until('拿到文件', `(${LAST_DL}).then((d) => (d.n > ${dl10} ? d : null))`, 10000).catch(() => null);
  const r10b = await q.eval(RESCUE);
  check(!!got10 && got10.format === 'map2-world' && got10.steps === n9 && /^世界 \d{4}-\d\d-\d\d \d{4}\.json$/.test(got10.name), `自救页上点“导出文件”：拿到世界文件（${got10?.name}，${got10?.steps} 步）；页面上写“${r10b?.note}”`, JSON.stringify(got10));
  await q.shot('自救页-导出以后');
  const asked10 = q.leaveAsked;
  await q.eval(`document.querySelector('.rescue .rescue-reload').click()`);
  await q.until('重新载入后世界打开', `!document.querySelector('.rescue') && (${READY})`, 120000);
  check((await q.eval(LAND)) === land10 && q.leaveAsked === asked10, '“重新载入”：世界还在（陆地逐字节相同），浏览器没有问“要离开吗”', `之前 ${land10}，之后 ${await q.eval(LAND)}；问了 ${q.leaveAsked - asked10} 次`);

  console.log('11. 启动时：连着两次没打开成、打开卡住、画不了地图');
  const head11 = await ownWrite(q, head8?.writer ?? '');
  await sleep(6500);
  check((await q.eval(`localStorage.getItem('map2.opening')`)) === null, '打开成了、过了几秒：没有留下“没打开成”的记号');
  // 记着连着两次没打开成（页面出了问题、被停下留下的就是这样）：先问
  const savedAt = await q.eval(SAVED_AT);
  await q.eval(`localStorage.setItem('map2.opening', JSON.stringify({ n: 2, saved: ${savedAt}, at: Date.now() }))`);
  await q.send('Page.navigate', { url: `${origin}/` });
  const ask11 = await q.until('先问', `(() => { const a = ${ASK}; return a && a.title.includes('没打开成') ? a : null; })()`, 60000).catch(() => null);
  check(!!ask11 && ask11.text.includes('没有丢') && ask11.buttons.includes('再试一次') && ask11.buttons.includes('导出文件') && ask11.buttons.includes('新建'), `连着两次没打开成：这一次先问“${ask11?.title}”（${ask11?.buttons.join(' / ')}）`, JSON.stringify(await q.eval(ASK)));
  check(!(await q.eval(`!!(window.__map2 && window.__map2.world())`)), '还没去打开');
  await q.shot('前两次都没打开成');
  await q.eval(clickText('.modal.ask .ask-actions button', '再试一次'));
  await q.until('打开了', READY, 120000);
  check((await q.eval(LAND)) === land10, '“再试一次”：打开了，就是那个世界');
  await q.until('记号擦掉', `localStorage.getItem('map2.opening') === null`, 15000).catch(() => null);
  check((await q.eval(`localStorage.getItem('map2.opening')`)) === null, '打开成了：之后不再问');
  // 打开卡住：能停
  const swallow = (await q.send('Page.addScriptToEvaluateOnNewDocument', { source: SWALLOW_LOAD })).identifier;
  await q.send('Page.navigate', { url: `${origin}/` });
  const tOpen = Date.now();
  const stop11 = await q.until('中间那一块上出现“取消”', `(() => { const l = document.querySelector('.loading'); const b = l && l.querySelector('.busy-stop'); return b ? l.textContent.trim() : null; })()`, 30000).catch(() => null);
  check(!!stop11 && stop11.includes('正在打开世界') && stop11.includes('取消'), `打开卡住了：${((Date.now() - tOpen) / 1000).toFixed(1)} 秒后“${stop11}”`, `没有出现；页面上是：${await q.eval(`document.querySelector('.loading')?.textContent ?? null`)}`);
  await q.shot('正在打开-取消');
  await q.eval(`document.querySelector('.loading .busy-stop').click()`);
  await q.until('向导', `!!document.querySelector('.modal.wizard')`, 20000).catch(() => null);
  const said11 = await q.eval(NOTICE);
  check((await q.eval(`!!document.querySelector('.modal.wizard')`)) && !(await q.eval(ASK)) && (said11 ?? '').includes('已取消'), `点“取消”：进向导，不问“没能打开”（顶上：“${said11}”）`);
  check((await count(q)) === head11.count && (await q.eval(`!!document.querySelector('.modal.wizard .box.resume')`)), `上次的世界还在原处（${head11.count} 步），向导上面有“继续上次的世界”`, `存着 ${await count(q)} 步`);
  check(JSON.parse((await q.eval(`localStorage.getItem('map2.opening')`)) ?? '{}').n === 1, '记下了一次没打开成（连着两次，下次先问）');
  await q.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: swallow });
  // 画不了地图：整页的说明，已有的世界还能导出
  const nogl = (await q.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_WEBGL2 })).identifier;
  await q.send('Page.navigate', { url: `${origin}/` });
  const r11 = await q.until('整页的说明', `(() => { const r = ${RESCUE}; return r && r.world !== 'checking' ? r : null; })()`, 60000).catch(() => null);
  check(!!r11 && r11.kind === 'no-webgl' && r11.title === '这个浏览器画不了地图' && r11.buttons.includes('重新载入'), `没有 WebGL2：整页的“${r11?.title}”`, JSON.stringify(await q.eval(RESCUE)));
  check(!!r11 && r11.line.includes('你的世界还在') && r11.canExport, `写着：“${r11?.line}”`, JSON.stringify(r11));
  await q.shot('画不了地图');
  const dl11 = (await q.eval(LAST_DL)).n;
  await q.eval(`document.querySelector('.rescue .rescue-export').click()`);
  const got11 = await q.until('拿到文件', `(${LAST_DL}).then((d) => (d.n > ${dl11} ? d : null))`, 10000).catch(() => null);
  check(!!got11 && got11.format === 'map2-world' && got11.steps === head11.count, `这一页上“导出文件”：拿到世界文件（${got11?.steps} 步）`, JSON.stringify(got11));
  await q.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: nogl });
  // 程序的主体一运行就出错（界面一次都没画出来）：页面不是白的，是自救页；这时页面里没有世界，导出的是浏览器里存着的那一份
  const noapp = (await q.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_APP_ONCE })).identifier;
  await q.send('Page.navigate', { url: `${origin}/?early` });
  const r11b = await q.until('自救页', `(() => { const r = ${RESCUE}; return r && r.world !== 'checking' ? r : null; })()`, 60000).catch(() => null);
  check(!!r11b && r11b.kind === 'crash' && r11b.world === 'saved' && r11b.canExport, `界面还没画出来就出错：不是白的，是“${r11b?.title}”，写着“${r11b?.line}”`, JSON.stringify(await q.eval(RESCUE).catch(() => null)));
  const dl11b = (await q.eval(LAST_DL)).n;
  await q.eval(`document.querySelector('.rescue .rescue-export').click()`);
  const got11b = await q.until('拿到文件', `(${LAST_DL}).then((d) => (d.n > ${dl11b} ? d : null))`, 10000).catch(() => null);
  check(!!got11b && got11b.format === 'map2-world' && got11b.steps === head11.count && (await q.eval(RESCUE)).exported === 'saved', `这时“导出文件”拿到的是浏览器里存着的那一份（${got11b?.steps} 步）`, JSON.stringify(got11b));
  await q.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: noapp });
  // 最后一段里“第一次找 #app 说没有”引出来的那一个错也是故意的
  const planted = q.errors.filter((e) => !/冒烟/.test(e) && !errors.includes(e)).slice(0, -1);
  const early = q.errors.at(-1) ?? '';
  check(!/冒烟/.test(early) && early.length > 0, `（故意引出来的那一个：${early.split('\n')[0].slice(0, 80)}）`);
  check(planted.length === 0, '后面几步：除了故意抛的，页面里没有别的没接住的错', planted.slice(0, 3).join('；'));
  // 这个页面开着的 Worker 的名单（一直跟着变）：第十二段接着用，不再挂一遍
  return { workers };
}
