import { signal } from '@preact/signals';
import { type MishapNote, crashHooks, mishapGone } from '../crash-host';
import { MISHAP_TEXT } from '../crash-text';
import { docText } from '../doc-text';
import { flushNow, skipLeaveWarning } from './autosave';
import { toast } from './notes';
import { unsaved } from './save-status';
import { currentHost } from './worker-host';

// 不致命的错（第九十六轮）：顶上的一条。规则在 ../mishap.ts、接线在 ../crash-host.ts；这里是界面读的信号。
// 不打断：一条提示，过一阵自己消失；点了“原因”展开以后不消失，等用户关。同一个错再来只把次数加一（crash-host 那边挡着）

export interface Mishap {
  id: number;
  // 给用户看的一句
  text: string;
  // 原话（能复制）
  detail: string;
  count: number;
  // “原因”展开着
  open: boolean;
}
export const mishap = signal<Mishap | null>(null);

// 没展开时多久自己消失
export const MISHAP_MS = 12000;
let timer: ReturnType<typeof setTimeout> | null = null;
function arm() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (mishap.value && !mishap.value.open) closeMishap();
  }, MISHAP_MS);
}

// 这个错该写成哪一句：某一块的写那一块的名字；别的只说“可能没做成”，原话翻成的人话放在“原因”的第一行
export function mishapText(n: Pick<MishapNote, 'part' | 'human'>): { text: string; lead: string } {
  return { text: n.part ? MISHAP_TEXT.part(n.part) : MISHAP_TEXT.generic, lead: n.human.text };
}

export function noteMishap(n: MishapNote) {
  const cur = mishap.value;
  if (cur && cur.id === n.id) {
    mishap.value = { ...cur, count: n.count };
    return;
  }
  const { text, lead } = mishapText(n);
  // 翻成的人话就是原话（本来就是中文的）时不重复写一遍
  mishap.value = { id: n.id, text, detail: lead && !n.detail.includes(lead) ? `${lead}\n\n${n.detail}` : n.detail, count: n.count, open: false };
  arm();
}

export function closeMishap() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!mishap.value) return;
  mishap.value = null;
  mishapGone();
}

export function toggleMishapReason() {
  const cur = mishap.value;
  if (!cur) return;
  mishap.value = { ...cur, open: !cur.open };
  if (cur.open) arm();
}

// 出错的提示条上的“原因”：换成这一条（展开着），原话能复制
let reasonId = -1;
export function showToastReason() {
  const t = toast.value;
  if (!t?.detail) return;
  if (mishap.value) mishapGone();
  mishap.value = { id: reasonId--, text: t.text, detail: t.detail, count: 1, open: true };
  if (timer) clearTimeout(timer);
  timer = null;
  toast.value = null;
}

// 程序的主体起来了（main.tsx 在第一次画界面之前调）：把全局兜底（../crash-host.ts，boot.ts 已经先接上了 window 的事件和
// 整页的自救页）要的几样接过去——不致命的错从界面顶上说；自救页的“导出文件”先用页面里现在的世界（主线程手上的命令记录，
// 不问计算程序）；出自救页之前把没写的尾巴写进浏览器；这个页面要自己重新载入时浏览器不用再问
export function startMishaps() {
  crashHooks.minor = noteMishap;
  crashHooks.liveDoc = () => {
    const doc = currentHost()?.mirror.doc();
    return doc ? docText(doc) : null;
  };
  crashHooks.flush = flushNow;
  crashHooks.unsaved = () => unsaved.peek();
  crashHooks.leaving = skipLeaveWarning;
}
