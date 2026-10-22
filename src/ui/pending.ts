import { signal } from '@preact/signals';
import { redrawTick } from '../state';
import type { Preview } from './tools';

// 排队中的编辑：画笔、放岛、岛链、圈一片、放湖在前面的编辑还在算时照样能用。松手就把命令发给 Worker
// （按松手的先后执行，命令与一步一步等着做时相同），松手时的预览（高亮、图形、省界）一直留在地图上，
// 直到这一步的结果换上：不先跳回原样，也不变成“等待”的样子。地图把它们画在当前工具的预览下面。
// 河、剪刀、合并要按最新的世界算，不排队（还是“还在计算上一步，稍等一下”）

export interface PendingEdit {
  id: number;
  // 松手时的预览（提示那一句不显示：鼠标旁只说当前工具的）
  preview: Preview;
}

export const pendingEdits = signal<PendingEdit[]>([]);
let nextId = 1;

// 一步编辑排上队：done 是它的执行（成功、失败、没有变化都算完），完了就从地图上去掉
export async function trackEdit(preview: Preview, done: Promise<unknown>): Promise<void> {
  const e: PendingEdit = { id: nextId++, preview };
  pendingEdits.value = [...pendingEdits.value, e];
  try {
    await done;
  } finally {
    pendingEdits.value = pendingEdits.value.filter((x) => x !== e);
    redrawTick.value++;
  }
}

// 前面还有几步没算完
export const queuedCount = () => pendingEdits.value.length;

// 排队时鼠标旁的一句（没有排队的为 null）
export function queueHint(): string | null {
  const n = queuedCount();
  return n ? `排队中：前面还有 ${n} 步` : null;
}
