import { describe, expect, it } from 'vitest';
import { DOC_VERSION } from '../../../core/doc-version';
import type { BackupInfo } from '../../state';
import { BACKUP_TEXT } from '../copy';
import { backupNotice, backupRow, backupWhen, backupWhyText, canOpenBackup } from './backups';

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

// 第九十四轮：这一版的世界也会留着（没存完整、没能打开、没打开就新建了、别的页面里保存的、被换掉的）
describe('这一版的世界为什么留着', () => {
  const cur = (why: BackupInfo['why']) => info({ version: DOC_VERSION, age: 'current', why });
  it('一直在的那一条：各一句，都说清它还留着', () => {
    const texts = (['damaged', 'failed', 'cancelled', 'other-page', 'replaced'] as const).map((why) => backupNotice([cur(why)])!.text);
    expect(texts).toEqual([
      '上次的世界没存完整，打不开。存下的部分还留着',
      '上次的世界没能打开。它还留着',
      '上次的世界没有打开。它还留着',
      '另一个页面里保存的世界和这里的不一样。它还留着',
      '原来自动保存的世界被换掉了。它还留着',
    ]);
    expect(new Set(texts).size).toBe(5);
    for (const t of texts) expect(t).toContain('还留着');
    expect(backupWhyText({ age: 'current' })).toBe(BACKUP_TEXT.why.replaced);
    // 别的版本做的照旧按版本说
    expect(backupWhyText({ age: 'older', why: 'other-page' })).toBe(BACKUP_TEXT.older);
  });

  it('列表里的一行写为什么；能打开的照样有“打开”', () => {
    expect(backupRow(cur('damaged')).note).toBe(`第 ${DOC_VERSION} 版 · 132 步 · 没存完整`);
    expect(backupRow(cur('failed')).note).toBe(`第 ${DOC_VERSION} 版 · 132 步 · 没能打开`);
    expect(backupRow(cur('other-page')).note).toBe(`第 ${DOC_VERSION} 版 · 132 步 · 另一个页面里保存的`);
    expect(canOpenBackup(cur('cancelled'))).toBe(true);
  });
});
