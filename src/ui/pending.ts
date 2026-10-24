import { signal } from '@preact/signals';
import type { World } from '../../core/world';
import type { GhostEdit } from '../render/colors';
import { redrawTick } from '../state';
import type { Preview } from './tools';

// 排队中的编辑：画笔、放岛、岛链、圈一片、放湖在前面的编辑还在算时照样能用。松手就把命令发给 Worker
// （按松手的先后执行，命令与一步一步等着做时相同），松手时的预览（高亮、图形、省界、幽灵海岸、确切预览的将来的世界）
// 一直留在地图上，直到这一步的结果换上：不先跳回原样，也不变成“等待”的样子。地图把它们画在当前工具的预览下面。
// 河、剪刀、合并要按最新的世界算，不排队（还是“还在计算上一步，稍等一下”）

export interface PendingEdit {
  id: number;
  // 松手时的预览（提示那一句不显示：鼠标旁只说当前工具的）
  preview: Preview;
  // 现在画成什么样（地图每帧按当前世界问一次）：排在前面的编辑算完、世界换了，幽灵海岸按新世界重算
  // （排在最前的那一步因此与执行时相同）；画笔松手后才算好的确切预览到了，带上将来的世界。
  // 同一个世界、没有新东西时给同一个对象（地图不必重新上传）；省略时一直是 preview
  live?: (w: World) => Preview;
}

export const pendingEdits = signal<PendingEdit[]>([]);
let nextId = 1;

// 一步编辑排上队：done 是它的执行（成功、失败、没有变化都算完），完了就从地图上去掉
export async function trackEdit(preview: Preview, done: Promise<unknown>, live?: (w: World) => Preview): Promise<void> {
  const e: PendingEdit = { id: nextId++, preview, live };
  pendingEdits.value = [...pendingEdits.value, e];
  try {
    await done;
  } finally {
    pendingEdits.value = pendingEdits.value.filter((x) => x !== e);
    redrawTick.value++;
  }
}

// 排队中的这一步现在画成什么样
export const pendingPreview = (e: PendingEdit, w: World): Preview => e.live?.(w) ?? e.preview;

// 幽灵海岸跟着世界走：松手时按 w0 算的；世界换了就用 ghostAt 按新世界重算一次（同一个世界不重算）
export function ghostFollows(preview: Preview, w0: World, ghostAt: (w: World) => GhostEdit | null): (w: World) => Preview {
  let memo = { w: w0, out: preview };
  return (w) => {
    if (memo.w !== w) memo = { w, out: preview.ghost ? { ...preview, ghost: ghostAt(w) } : preview };
    return memo.out;
  };
}

// 前面还有几步没算完
export const queuedCount = () => pendingEdits.value.length;

// 排队时鼠标旁的一句（没有排队的为 null）
export function queueHint(): string | null {
  const n = queuedCount();
  return n ? `已排队 · 前面 ${n} 步` : null;
}
