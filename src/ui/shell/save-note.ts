import { effect } from '@preact/signals';
import { FILE_OFF, type FileStatus } from '../../file-save';
import { type SaveProblem, askUser, fileStatus, keepVersion, resumeFile, saveFail, saveToFile, showToast, skipLeaveWarning, stopFile, storageTight, takeOverSaving } from '../../state';
import { FILE_TEXT as F, SAVE_TEXT as T } from '../copy';
import { exportCurrent } from '../maps/store';
import { versionWhen } from '../maps/versions';

// 自动保存没存成时界面上写什么（第九十四轮）：顶栏“世界”旁的小标记、“世界”菜单的第一行、顶上一直在的一条。
// 第九十五轮：加上“这个页面里的是旧的”（重新载入）和电脑上的文件没写成。
// 组件（TopBar、WorldMenu、SaveBanner、FileBanner）只调这里；规则是纯函数

export interface SaveNote {
  // 顶栏的小标记和它的悬停
  badge: string;
  tip: string;
  // “世界”菜单第一行：发生了什么、现在能做什么
  line: string;
  // 带不带“在这里接着做”（这个世界开在另一个页面里、这个页面里的是旧的）
  take: boolean;
  // 带不带“重新载入”（这个页面里的是旧的：它是主要的按钮，“在这里接着做”是次要的）
  reload: boolean;
  // 电脑上的文件没写成：能做的那一样（接着存到…、换一个文件）；不是文件的事时 null
  file: 'resume' | 'pick' | null;
}

// 现在的保存状态 → 写什么；存得好好的时 null（标记不出现）。浏览器里没存成的先说，文件没写成的后说
export function saveNote(problem: SaveProblem | null, file: FileStatus = FILE_OFF): SaveNote | null {
  if (problem) return { badge: T.badge, tip: T.tip[problem], line: T.problem[problem], take: problem === 'other-page' || problem === 'stale-page', reload: problem === 'stale-page', file: null };
  if (file.mode !== 'off' && file.fail && file.name) return { badge: F.badge, tip: F.tip[file.fail], line: F.fail[file.fail](file.name), take: false, reload: false, file: file.fail === 'denied' ? 'resume' : 'pick' };
  return null;
}

// “在这里接着做”
export async function takeOverHere(): Promise<void> {
  await takeOverSaving();
  showToast(T.tookOver);
}

// “重新载入”（这个页面里的是旧的）：打开别的页面里保存的那一份。这个页面里的样子先留成一个版本——留不下来先问
export async function reloadSaved(reload: () => void = () => location.reload()): Promise<boolean> {
  if (!(await keepVersion('before-reload'))) {
    for (;;) {
      const a = await askUser({
        title: T.reloadNotKept.title,
        text: T.reloadNotKept.text,
        choices: [
          { value: 'export', label: T.reloadNotKept.export, primary: true },
          { value: 'go', label: T.reloadNotKept.go },
          { value: 'cancel', label: T.reloadNotKept.cancel },
        ],
      });
      if (a === 'go') break;
      if (a !== 'export') return false;
      await exportCurrent();
    }
  }
  // 这个页面里的样子已经留了：浏览器不用再问“要离开吗”
  skipLeaveWarning();
  reload();
  return true;
}

// ---------- 存到电脑上的文件（第九十五轮） ----------

// “刚刚”“3 分钟前”“今天 14:05”
export function agoText(t: number, now: number): string {
  const d = now - t;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  return versionWhen(t, now);
}

export interface FileLine {
  // “世界”菜单里的状态一行
  text: string;
  // 没在写（要点一下“接着存到…”）：字用警告色
  paused: boolean;
}
// 这个世界有电脑上的文件时写什么；没有时 null
export function fileLine(s: FileStatus, now: number): FileLine | null {
  if (s.mode === 'off' || !s.name) return null;
  if (s.mode === 'paused') return { text: F.paused(s.name), paused: true };
  return { text: F.on(s.name, s.savedAt === null ? F.notYet : agoText(s.savedAt, now)), paused: false };
}

// “存到电脑上的文件…”“换一个文件…”
export async function pickFile(): Promise<void> {
  try {
    if (await saveToFile()) {
      const s = fileStatus.value;
      if (s.name && !s.fail) showToast(F.attached(s.name));
    }
  } catch {
    showToast(F.pickFailed, true);
  }
}
// “接着存到 xxx.json”
export async function resumeFileHere(): Promise<void> {
  const name = fileStatus.value.name;
  if ((await resumeFile()) && name) showToast(F.resumed(name));
}
// “不再存到这个文件”
export async function stopFileHere(): Promise<void> {
  const name = fileStatus.value.name;
  await stopFile();
  if (name) showToast(F.stopped(name));
}

// 没存成：顶上说一次（原因换了再说一次）；之后记号一直在，存成了才消失。存储快满了：这一次打开页面说一次
let said: string | null = null;
let fileSaid: string | null = null;
let tightSaid = false;
export function startSaveNotes(): void {
  effect(() => {
    const fail = saveFail.value;
    if (fail && fail !== said) showToast(T.problem[fail], true);
    said = fail;
  });
  // 电脑上的文件没写成：同样说一次，记号一直在
  effect(() => {
    const s = fileStatus.value;
    const key = s.fail && s.name ? `${s.fail}:${s.name}` : null;
    if (key && key !== fileSaid) showToast(F.fail[s.fail!](s.name!), true);
    fileSaid = key;
  });
  effect(() => {
    if (!storageTight.value || tightSaid) return;
    tightSaid = true;
    showToast(T.tight, true);
  });
}
