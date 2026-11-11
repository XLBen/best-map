import { type RescueKind, crashHooks } from './crash-host';
import { RESCUE_TEXT as T, type RescueWorld, rescueWorldLine } from './crash-text';
import { type RescueIo, type SavedWorld, readSavedWorld, rescueExport } from './rescue-doc';

// 整页的自救页（第九十六轮）：整个界面画不出来、浏览器画不了地图时盖在最上面。写明发生了什么、世界还在不在，
// 按钮：导出文件、重新载入，原因折叠着、能复制。
// 不用 Preact、不用信号、不用 src/ui/components/ 的控件（“控件只用 components/”的规矩在这里有意不守）：出问题的可能正是它们。
// 只用 DOM；样式写在元素上（styles.css 没读到时也看得清），颜色取 token、带后备的值。
// 规则（从哪里拿世界、文件名、说哪句话）在 rescue-doc.ts、crash-text.ts，有测试；这个文件只有在浏览器里才跑得到（冒烟里看）

let shown = false;
// 自救页开着：键盘不再到下面的程序（boot.ts 在捕获阶段先收到）
export const rescueShown = () => shown;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

const BTN =
  'font:inherit;font-size:13px;height:32px;padding:0 14px;border:0;border-radius:var(--r-md,10px);color:var(--text,#dfe3e8);background:var(--fill,rgba(255,255,255,0.08));cursor:pointer;';
const BTN_PRIMARY = `${BTN}background:var(--accent-bg,#2a5f8a);`;

function browserIo(): RescueIo & { savedOnce(): Promise<SavedWorld | null> } {
  let saved: Promise<SavedWorld | null> | null = null;
  const savedOnce = () => (saved ??= readSavedWorld(typeof indexedDB !== 'undefined' ? indexedDB : undefined, safeLocal()));
  return {
    live: () => crashHooks.liveDoc?.() ?? null,
    saved: savedOnce,
    savedOnce,
    download: (name, text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    now: () => Date.now(),
  };
}

function safeLocal(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function showRescue(kind: RescueKind, reason: string) {
  if (shown) return;
  shown = true;
  const io = browserIo();

  // 页面里的世界：先把没写的尾巴写进浏览器（写得成的话），再看要怎么说
  let live = false;
  let flushed: 'sent' | 'nothing' | 'cannot' = 'cannot';
  try {
    live = !!crashHooks.liveDoc?.();
    if (live) flushed = crashHooks.flush?.() ?? 'cannot';
  } catch {
    // 拿不到就当没有
  }
  let unsaved = true;
  try {
    unsaved = crashHooks.unsaved?.() ?? true;
  } catch {
    unsaved = true;
  }
  let world: RescueWorld = live ? (flushed !== 'cannot' || !unsaved ? 'live' : 'live-unsaved') : 'checking';

  // index.html 里“页面还没打开”的那一句：这一页已经说清楚了
  document.querySelector('.boot-wait')?.remove();
  const app = document.getElementById('app');
  if (app) {
    // 下面的界面不再收鼠标、键盘
    app.setAttribute('inert', '');
    app.setAttribute('aria-hidden', 'true');
  }

  const root = el(
    'div',
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;' +
      "background:var(--bg,#15181d);color:var(--text,#dfe3e8);font:13px/1.6 var(--font,system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);overflow:auto;",
  );
  root.className = 'rescue';
  root.dataset.kind = kind;
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  const card = el('div', 'width:min(520px,100%);background:var(--surface,#1d2128);border:1px solid var(--line,#333a45);border-radius:var(--r-lg,14px);padding:20px 22px;box-sizing:border-box;');
  const text = kind === 'no-webgl' ? T.noWebgl : T.crash;
  const title = el('h2', 'margin:0 0 8px;font-size:15px;font-weight:600;', text.title);
  title.className = 'rescue-title';
  const lead = el('p', 'margin:0 0 8px;color:var(--muted,#8b95a3);', text.lead);
  const line = el('p', 'margin:0 0 4px;');
  line.className = 'rescue-world';
  const note = el('p', 'margin:0;min-height:1.6em;color:var(--muted,#8b95a3);');
  note.className = 'rescue-note';
  note.setAttribute('aria-live', 'polite');

  const actions = el('div', 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px;');
  const exportBtn = el('button', BTN, T.export);
  exportBtn.className = 'rescue-export';
  exportBtn.title = T.exportTip;
  const reloadBtn = el('button', BTN_PRIMARY, T.reload);
  reloadBtn.className = 'rescue-reload';
  actions.append(exportBtn, reloadBtn);

  const details = el('details', 'margin-top:14px;font-size:12px;color:var(--muted,#8b95a3);');
  details.className = 'rescue-reason';
  const summary = el('summary', 'cursor:pointer;user-select:none;', T.reason);
  const pre = el('pre', 'margin:8px 0;padding:8px 10px;max-height:200px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;background:var(--field,#12151a);border-radius:var(--r-sm,6px);font:11px/1.5 var(--mono,ui-monospace,Menlo,Consolas,monospace);color:var(--text,#dfe3e8);', reason);
  const copyBtn = el('button', `${BTN}height:28px;font-size:12px;`, T.copy);
  copyBtn.className = 'rescue-copy';
  details.append(summary, pre, copyBtn);

  card.append(title, lead, line, note, actions, details);
  root.append(card);

  let savedAt = 0;
  const paint = () => {
    line.textContent = rescueWorldLine(world, savedAt, Date.now());
    root.dataset.world = world;
    exportBtn.disabled = world === 'none' || world === 'checking';
    exportBtn.style.opacity = exportBtn.disabled ? '0.45' : '1';
    exportBtn.style.cursor = exportBtn.disabled ? 'default' : 'pointer';
  };
  paint();
  // 页面里的拿不到：看浏览器里存着的
  if (!live) {
    void io.savedOnce().then(
      (s) => {
        world = s ? (s.whole ? 'saved' : 'partial') : 'none';
        savedAt = s?.savedAt ?? 0;
        paint();
      },
      () => {
        world = 'none';
        paint();
      },
    );
  }

  exportBtn.onclick = () => {
    if (exportBtn.disabled) return;
    void rescueExport(io).then((r) => {
      note.textContent = !r.ok ? T.exportFailed : r.whole ? T.exported(r.name) : T.exportedPartial(r.name);
      root.dataset.exported = r.ok ? r.from : 'failed';
    });
  };
  reloadBtn.onclick = () => {
    try {
      crashHooks.leaving?.();
    } catch {
      // 浏览器要问就让它问
    }
    location.reload();
  };
  copyBtn.onclick = () => {
    const done = () => {
      copyBtn.textContent = T.copied;
      setTimeout(() => (copyBtn.textContent = T.copy), 1500);
    };
    const fallback = () => {
      // 没有剪贴板的权限：选中那一段，用户自己按复制
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(pre);
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    try {
      void navigator.clipboard.writeText(reason).then(done, fallback);
    } catch {
      fallback();
    }
  };

  document.body.appendChild(root);
  try {
    reloadBtn.focus();
  } catch {
    // 聚不了焦也无妨
  }
}
