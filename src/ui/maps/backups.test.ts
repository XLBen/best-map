import { describe, expect, it } from 'vitest';
import { DOC_VERSION } from '../../../core/doc-version';
import type { BackupInfo } from '../../state';
import { BACKUP_TEXT } from '../copy';
import { backupNotice, backupRow, backupWhen, canOpenBackup } from './backups';

// 第九十一轮：上次的世界这一版打不开时界面上写什么（一直在的那一条、“留着的旧世界”里的一行）

const info = (more: Partial<BackupInfo> = {}): BackupInfo => ({ id: 'b1', keptAt: 2, savedAt: new Date(2026, 10, 9, 8, 5).getTime(), version: DOC_VERSION - 1, age: 'older', steps: 132, ...more });

describe('一直在的那一条', () => {
  it('旧版本的、更新的版本做的各一句；说清它还留着；关过了就不再提示', () => {
    expect(backupNotice([info()])).toEqual({ text: '上次的世界是旧版本做的，这一版打不开。它还留着', id: 'b1', count: 1 });
    expect(backupNotice([info({ age: 'newer', version: DOC_VERSION + 1 })])!.text).toBe('上次的世界是更新的版本做的，这一版打不开。它还留着');
    expect(BACKUP_TEXT.older).not.toBe(BACKUP_TEXT.newer);
    expect(backupNotice([info({ seen: true })])).toBeNull();
    expect(backupNotice([])).toBeNull();
    expect(backupNotice(null)).toBeNull();
  });

  it('几份没看过的：说最近留下的那一份，写上一共几个；导出的也是它', () => {
    const n = backupNotice([info({ id: 'b3' }), info({ id: 'b2', seen: true }), info({ id: 'b1', age: 'newer' })])!;
    expect(n).toMatchObject({ id: 'b3', count: 2 });
    expect(n.text).toBe('上次的世界是旧版本做的，这一版打不开。它还留着（共 2 个）');
  });
});

describe('“留着的旧世界”里的一行', () => {
  it('名字是它最后一次自动保存的时间；灰字写第几版、几步、为什么打不开', () => {
    expect(backupWhen(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04');
    expect(backupRow(info())).toEqual({ name: '2026-11-09 08:05 的世界', note: `第 ${DOC_VERSION - 1} 版 · 132 步 · 旧版本做的` });
    expect(backupRow(info({ age: 'newer', version: DOC_VERSION + 3 })).note).toBe(`第 ${DOC_VERSION + 3} 版 · 132 步 · 更新的版本做的`);
    expect(backupRow(info({ version: null })).note).toBe('132 步 · 旧版本做的');
  });

  it('程序更新以后这一版能打开的那一份：多一个“打开”', () => {
    expect(canOpenBackup(info())).toBe(false);
    expect(canOpenBackup(info({ version: DOC_VERSION }))).toBe(true);
    expect(backupRow(info({ version: DOC_VERSION, age: 'newer' })).note).toBe(`第 ${DOC_VERSION} 版 · 132 步 · 这一版能打开`);
  });
});
