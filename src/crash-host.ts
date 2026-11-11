import { type HumanError, humanError, rawText } from './error-text';
import { MishapLog, type MishapInput, type MishapSource, type Severity, classify, signatureOf } from './mishap';

// 没接住的错的接线（第九十六轮）：规则在 mishap.ts（纯函数）；这里把 window 的 error、unhandledrejection 和界面的错误边界
// 接到两处——不致命的交给界面顶上的一条（main.tsx 登记 minor），致命的交给整页的自救页（boot.ts 登记 fatal）。
// 这个文件不引用界面、不引用状态：boot.ts 在程序别的部分之前载入它，别的部分坏了它也还在

// 自救页的两种：整个界面画不出来；浏览器画不了地图
export type RescueKind = 'crash' | 'no-webgl';

// 顶上的一条要的东西
export interface MishapNote {
  id: number;
  // 记号（同一个错再来只加一）
  sig: string;
  // 哪一块（面板、弹窗的名字）；没接住的错没有
  part?: string;
  human: HumanError;
  // 原话连同调用栈（“原因”里写、能复制）
  detail: string;
  count: number;
}

export const crashHooks: {
  // 不致命的：界面顶上说一句（界面起来以后登记；之前的只进控制台）
  minor: ((n: MishapNote) => void) | null;
  // 致命的：整页的自救页
  fatal: ((kind: RescueKind, reason: string) => void) | null;
  // 页面里现在的世界文件的字（主线程手上的命令记录；没有世界、拿不到时 null）
  liveDoc: (() => string | null) | null;
  // 把没写的尾巴马上写进自动保存（state/autosave.ts 的 flushNow）
  flush: (() => 'sent' | 'nothing' | 'cannot') | null;
  // 有没有没存进自动保存的改动
  unsaved: (() => boolean) | null;
  // 这个页面要自己重新载入：浏览器不用再问“要离开吗”
  leaving: (() => void) | null;
} = { minor: null, fatal: null, liveDoc: null, flush: null, unsaved: null, leaving: null };

export const crashState = {
  // 界面画出来过没有（main.tsx 第一次画完之后设）
  rendered: false,
  // 已经是自救页了（之后的错不再处理）
  fatal: false,
};

const log = new MishapLog(() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
let nextId = 1;
// 每个错显示时的编号（同一个错再来，还是那一条）
const ids = new Map<string, number>();

function detailOf(e: unknown, message: string): string {
  const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : '';
  // 调用栈的第一行多半就是原话：不重复写
  return stack && !stack.startsWith(message) && !stack.includes(message) ? `${message}\n${stack}` : stack || message;
}

// 一个错进来：分一分，该说的说。part：哪一块（错误边界给）。返回怎么处理的（测试、调用方看）
export function report(source: MishapSource, error: unknown, extra: { filename?: string; part?: string; hasError?: boolean; message?: string } = {}): Severity {
  if (crashState.fatal) return 'ignore';
  const message = extra.message ?? rawText(error);
  const input: MishapInput = {
    source,
    message,
    ...(error instanceof Error ? { name: error.name, ...(typeof error.stack === 'string' ? { stack: error.stack } : {}) } : nameOf(error)),
    ...(extra.filename ? { filename: extra.filename } : {}),
    hasError: extra.hasError ?? (error !== undefined && error !== null),
    rendered: crashState.rendered,
  };
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const severity = classify(input, origin);
  if (severity === 'ignore') return severity;
  const detail = detailOf(error, message);
  if (severity === 'fatal') {
    crashState.fatal = true;
    console.error('[map2] 页面出了问题：', error ?? message);
    crashHooks.fatal?.('crash', detail);
    return severity;
  }
  console.error('[map2] 没接住的错：', error ?? message);
  const sig = `${extra.part ?? ''}|${signatureOf(input)}`;
  const seen = log.note(sig);
  if (seen === 'quiet') return severity;
  if (seen === 'show') ids.set(sig, nextId++);
  crashHooks.minor?.({ id: ids.get(sig) ?? 0, sig, ...(extra.part ? { part: extra.part } : {}), human: humanError(message), detail, count: log.count(sig) });
  return severity;
}

// 不是 Error 的东西（DOMException 在有的环境里不是 Error 的子类）也带着名字
function nameOf(e: unknown): { name?: string } {
  const n = e && typeof e === 'object' ? (e as { name?: unknown }).name : undefined;
  return typeof n === 'string' && n ? { name: n } : {};
}

// 顶上的那一条不显示了（关掉、自己消失）
export function mishapGone() {
  log.gone();
}

// 浏览器画不了地图（MapView 建渲染器时）：整页的说明
export function reportNoWebgl(error: unknown) {
  if (crashState.fatal) return;
  crashState.fatal = true;
  console.error('[map2] 画不了地图：', error);
  crashHooks.fatal?.('no-webgl', detailOf(error, rawText(error)));
}

// 接上 window 的两个事件；程序自己的脚本、样式没读到（捕获阶段才收得到）也算。只接一次
let installed = false;
export function installCrashHandlers(win: Window = window) {
  if (installed) return;
  installed = true;
  win.addEventListener('error', (ev) => {
    const e = ev as ErrorEvent;
    // 资源没读到的 error 事件不冒泡，到不了这里（下面捕获阶段的那一个管）
    if (ev.target && ev.target !== win && !(e.error || e.message)) return;
    report('error', e.error ?? e.message, { filename: e.filename, hasError: e.error !== undefined && e.error !== null, message: e.error ? undefined : String(e.message ?? '') });
  });
  win.addEventListener('unhandledrejection', (ev) => {
    report('rejection', (ev as PromiseRejectionEvent).reason);
  });
  win.addEventListener(
    'error',
    (ev) => {
      const t = ev.target as (Element & { src?: string; href?: string }) | null;
      if (!t || (t as unknown) === win || typeof t.tagName !== 'string') return;
      // 只管程序自己的脚本和样式（图片、字体没读到不算：界面照样能用）
      const tag = t.tagName.toUpperCase();
      if (tag !== 'SCRIPT' && !(tag === 'LINK' && (t as HTMLLinkElement).rel === 'stylesheet')) return;
      const url = t.src || t.href || '';
      report('resource', new Error(`Failed to load module script: ${url}`));
    },
    true,
  );
}
