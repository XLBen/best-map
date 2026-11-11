import { effect } from '@preact/signals';
import { type SaveProblem, saveFail, showToast, storageTight, takeOverSaving } from '../../state';
import { SAVE_TEXT as T } from '../copy';

// 自动保存没存成时界面上写什么（第九十四轮）：顶栏“世界”旁的小标记、“世界”菜单的第一行、顶上一直在的一条。
// 组件（TopBar、WorldMenu、SaveBanner）只调这里；规则是纯函数

export interface SaveNote {
  // 顶栏的小标记和它的悬停
  badge: string;
  tip: string;
  // “世界”菜单第一行：发生了什么、现在能做什么
  line: string;
  // 带不带“在这里接着做”（这个世界开在另一个页面里时）
  take: boolean;
}

// 现在的保存状态 → 写什么；存得好好的时 null（标记不出现）
export function saveNote(problem: SaveProblem | null): SaveNote | null {
  if (!problem) return null;
  return { badge: T.badge, tip: T.tip[problem], line: T.problem[problem], take: problem === 'other-page' };
}

// “在这里接着做”
export async function takeOverHere(): Promise<void> {
  await takeOverSaving();
  showToast(T.tookOver);
}

// 没存成：顶上说一次（原因换了再说一次）；之后记号一直在，存成了才消失。存储快满了：这一次打开页面说一次
let said: string | null = null;
let tightSaid = false;
export function startSaveNotes(): void {
  effect(() => {
    const fail = saveFail.value;
    if (fail && fail !== said) showToast(T.problem[fail], true);
    said = fail;
  });
  effect(() => {
    if (!storageTight.value || tightSaid) return;
    tightSaid = true;
    showToast(T.tight, true);
  });
}
