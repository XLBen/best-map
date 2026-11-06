import { signal } from '@preact/signals';
import type { FoundScript } from '../../core/script';

// 问一句（第七十轮从 state.ts 分出来）

// 要用户选一个的问题（信任脚本吗、用安全模式打开吗、查看脚本）：界面上是一个对话框（见 ui/shell/Ask.tsx）
export interface AskChoice {
  value: string;
  label: string;
  primary?: boolean;
}
export interface Ask {
  title: string;
  text?: string;
  // 列出的脚本（谁的、哪一种、源码）
  scripts?: FoundScript[];
  // 列出的几行（整理本世界：移出哪些、留着哪些）：名字和灰色的一句
  lines?: { label: string; hint?: string }[];
  choices: AskChoice[];
  // 带一个输入框（起名字）：框里一开始的字。回车等于点主要的按钮
  input?: string;
  resolve: (value: string, text?: string) => void;
}
export const ask = signal<Ask | null>(null);

// 问一个问题，等用户点一个按钮（关掉对话框是 'cancel'）。新的问题顶掉还没回答的（那个当作取消）
export function askUser(a: Omit<Ask, 'resolve'>): Promise<string> {
  return new Promise((resolve) => {
    ask.value?.resolve('cancel');
    const me: Ask = {
      ...a,
      resolve: (v) => {
        if (ask.value === me) ask.value = null;
        resolve(v);
      },
    };
    ask.value = me;
  });
}

// 问一个名字：带输入框的问话。点了哪个按钮、框里写的什么（关掉对话框是 'cancel'）
export function askText(a: Omit<Ask, 'resolve' | 'input'> & { input: string }): Promise<{ value: string; text: string }> {
  return new Promise((resolve) => {
    ask.value?.resolve('cancel');
    const me: Ask = {
      ...a,
      resolve: (v, text) => {
        if (ask.value === me) ask.value = null;
        resolve({ value: v, text: text ?? a.input });
      },
    };
    ask.value = me;
  });
}
