import { signal } from '@preact/signals';
import { DOC_VERSION } from '../../../core/doc-version';
import type { WorldDoc } from '../../../core/engine';
import { backupFileName, backupFileText } from '../../backups';
import { type BackupInfo, askUser, backupOf, backups, deleteBackup, download, loadDoc, refreshBackups, showToast } from '../../state';
import { BACKUP_TEXT as T } from '../copy';
import { ESC_RANK, pushEscape } from '../shell/escape';
import { beforeLeave } from './store';

// 留着的旧世界的界面这边（第九十一轮，规则在 src/backups.ts）：提示条写什么、列表的一行写什么、导出、删除（先问）、打开。
// 组件（shell/BackupBanner.tsx、BackupsDialog.tsx、向导上面的一块、“世界”菜单的一行）只调这里

export const backupsDialog = signal(false);
pushEscape(ESC_RANK.backupsDialog, () => {
  if (!backupsDialog.value) return false;
  backupsDialog.value = false;
  return true;
});

export function openBackups() {
  backupsDialog.value = true;
  void refreshBackups();
}

// 一直在的那一条：还没关过提示的。几份时说最近的那一份，后面写“等 N 个”
export interface BackupNotice {
  text: string;
  // 导出哪一份（最近留下的）
  id: string;
  count: number;
}
export function backupNotice(list: readonly BackupInfo[] | null): BackupNotice | null {
  const fresh = (list ?? []).filter((b) => !b.seen);
  if (!fresh.length) return null;
  const first = fresh[0];
  return { text: `${backupWhyText(first)}${fresh.length > 1 ? `（共 ${fresh.length} 个）` : ''}`, id: first.id, count: fresh.length };
}
// 为什么留着（一句话，说清它还在）。第九十四轮：这一版的世界也会留着（没存完整、没能打开、被换掉之前……）
export function backupWhyText(b: Pick<BackupInfo, 'age' | 'why'>): string {
  if (b.age === 'newer') return T.newer;
  if (b.age === 'older') return T.older;
  return T.why[b.why ?? 'replaced'];
}

// 这一版能打开了（比如程序更新以后，原来“更新的版本做的”那一份）
export const canOpenBackup = (b: Pick<BackupInfo, 'version'>): boolean => b.version === DOC_VERSION;

const two = (n: number) => String(n).padStart(2, '0');
export function backupWhen(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
// 列表的一行：名字（它最后一次自动保存的时间）和灰字（第几版、几步、为什么打不开）
export function backupRow(b: BackupInfo): { name: string; note: string } {
  const why = b.why ? T.whyRow[b.why] : canOpenBackup(b) ? '这一版能打开' : b.age === 'newer' ? '更新的版本做的' : '旧版本做的';
  return { name: `${backupWhen(b.savedAt)} 的世界`, note: `${b.version !== null ? `第 ${b.version} 版 · ` : ''}${b.steps} 步 · ${why}` };
}

// 导出：把那一份原样存成世界文件下载
export async function exportBackup(id: string): Promise<boolean> {
  const b = await backupOf(id);
  if (!b) {
    showToast('这一份已经不在了', true);
    void refreshBackups();
    return false;
  }
  download(backupFileName(b), backupFileText(b), 'application/json');
  return true;
}

// 删除：先问（删了找不回来）
export async function removeBackupAsk(id: string): Promise<boolean> {
  const v = await askUser({
    title: T.deleteTitle,
    text: T.deleteText,
    choices: [
      { value: 'delete', label: '删除', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'delete') return false;
  try {
    await deleteBackup(id);
  } catch {
    showToast('删除失败：浏览器存储不可用', true);
    return false;
  }
  return true;
}

// 打开（这一版能打开的那一份）：和打开世界文件一样，先问现在的世界要不要保存；打开了它还留着，要用户自己删除
export async function openBackup(id: string): Promise<boolean> {
  const b = await backupOf(id);
  if (!b || !canOpenBackup(b)) return false;
  if (!(await beforeLeave())) return false;
  const ok = await loadDoc(b.doc as WorldDoc);
  if (ok) backupsDialog.value = false;
  return ok;
}

export { backups };
