import { signal } from '@preact/signals';
import { type BackupInfo, type BackupIo, type WorldBackup, browserBackupIo, infoOf, keepStaleAutosaves, listBackups, markSeen, removeBackup } from '../backups';

// 留着的旧世界（第九十一轮，规则在 ../backups.ts）：启动时挪一次、列出来；界面读这里的信号。
// 不引用界面；导出、删除前的确认在 ui/maps/backups.ts

// 留着的（不带世界文件本身，最近留下的在前）；还没读过时 null
export const backups = signal<BackupInfo[] | null>(null);

const io: { now: BackupIo } = { now: browserBackupIo };
// 测试换成内存里的
export function useBackupIo(next: BackupIo) {
  io.now = next;
  kept = null;
  backups.value = null;
}

export async function refreshBackups(): Promise<BackupInfo[]> {
  const list = (await listBackups(io.now)).map(infoOf);
  backups.value = list;
  return list;
}

// 第九十四轮：只有写自动保存的那一方才挪（这个世界开在另一个页面里时，这个页面不动它的自动保存）。
// autosave.ts 接上；没接时（测试）都能挪
export const keepGate: { ready: () => Promise<boolean> } = { ready: async () => true };

// 这一次打开页面只挪一次：读自动保存、写自动保存之前都先等它（哪个先到都行）
let kept: Promise<void> | null = null;
export function keepStaleOnce(): Promise<void> {
  kept ??= (async () => {
    try {
      if (await keepGate.ready()) await keepStaleAutosaves(io.now);
      await refreshBackups();
    } catch {
      // 存储用不了：没有什么可挪的，也没有什么会被盖掉
      backups.value ??= [];
    }
  })();
  return kept;
}

// 那一份的世界文件（已经不在了时 null）
export async function backupOf(id: string): Promise<WorldBackup | null> {
  return (await listBackups(io.now)).find((b) => b.id === id) ?? null;
}

export async function deleteBackup(id: string): Promise<void> {
  await removeBackup(io.now, id);
  await refreshBackups();
}

// 提示条关掉：没看过的都记成看过了
export async function dismissBackups(): Promise<void> {
  const fresh = (backups.value ?? []).filter((b) => !b.seen).map((b) => b.id);
  // 先在界面上关掉，再记进存储
  backups.value = (backups.value ?? []).map((b) => (b.seen ? b : { ...b, seen: true as const }));
  await markSeen(io.now, fresh);
}
