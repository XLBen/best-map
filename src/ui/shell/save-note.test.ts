import { describe, expect, it } from 'vitest';
import { FILE_OFF, type FileStatus } from '../../file-save';
import { FILE_TEXT, SAVE_TEXT, UNDO_LIMIT_TEXT } from '../copy';
import { undoLimited } from '../packs/panel-store';
import { agoText, fileLine, saveNote } from './save-note';

// 第九十四轮：现在的保存状态 → 界面上写什么（顶栏“世界”旁的记号、“世界”菜单的第一行）

describe('保存状态写什么', () => {
  it('存得好好的：什么都不写（记号不出现）', () => {
    expect(saveNote(null)).toBeNull();
  });

  it('四种原因各一句；记号都是“没保存”；只有开在另一个页面里时带“在这里接着做”', () => {
    const kinds = ['quota', 'unavailable', 'too-big', 'other-page'] as const;
    const notes = kinds.map((k) => saveNote(k)!);
    expect(notes.map((n) => n.badge)).toEqual(['没保存', '没保存', '没保存', '没保存']);
    expect(notes.map((n) => n.tip)).toEqual(['没保存：浏览器存储满了', '没保存：浏览器存储不可用', '没保存：这张地图太大', '没保存：已在另一个页面打开']);
    expect(notes.map((n) => n.take)).toEqual([false, false, false, true]);
    expect(new Set(notes.map((n) => n.line)).size).toBe(4);
    expect(saveNote('quota')!.line).toBe('浏览器存储满了，这张地图没能自动保存。请导出世界文件，或删除几张旧地图');
    expect(saveNote('other-page')!.line).toBe('这个世界已在另一个页面打开，这个页面里的改动不会自动保存');
  });

  it('第九十五轮：这个页面里的是旧的——说清楚、主要的是“重新载入”，“在这里接着做”也在', () => {
    const n = saveNote('stale-page')!;
    expect(n).toEqual({ badge: '没保存', tip: '没保存：这个页面里的是旧的', line: '另一个页面里保存了更新的世界，这个页面里的是旧的，改动不会自动保存。请重新载入', take: true, reload: true, file: null });
    expect(saveNote('other-page')!.reload).toBe(false);
    expect(SAVE_TEXT.stalePage).toBe('另一个页面里保存了更新的世界，这个页面里的是旧的，改动不会自动保存');
    expect(SAVE_TEXT.stalePage).not.toBe(SAVE_TEXT.otherPage);
    expect(SAVE_TEXT.reload).toBe('重新载入');
  });

  it('每一句都说了现在能做什么；不说实现上的词', () => {
    for (const k of ['quota', 'unavailable', 'too-big'] as const) expect(SAVE_TEXT.problem[k]).toContain('导出世界文件');
    const all = [...Object.values(SAVE_TEXT.problem), ...Object.values(SAVE_TEXT.tip), SAVE_TEXT.otherPage, SAVE_TEXT.takeOverTip, SAVE_TEXT.tight, SAVE_TEXT.exportTip];
    for (const t of all) expect(t).not.toMatch(/IndexedDB|localStorage|标签页|自动保存表|事务|锁/);
    for (const t of [SAVE_TEXT.stalePage, SAVE_TEXT.reloadTip, SAVE_TEXT.reloadKept, ...Object.values(SAVE_TEXT.reloadNotKept)]) expect(t).not.toMatch(/IndexedDB|localStorage|标签页|事务|锁/);
  });
});

// 第九十五轮：存到电脑上的文件——状态一行、没写成时的记号
describe('电脑上的文件写什么', () => {
  const on = (more: Partial<FileStatus> = {}): FileStatus => ({ mode: 'on', name: '赤原.json', savedAt: 1_000_000, fail: null, ...more });

  it('状态一行：在写时写名字和多久以前；还没写过；没在写（要点一下）；没有文件时不写', () => {
    expect(fileLine(FILE_OFF, 0)).toBeNull();
    expect(fileLine(on(), 1_000_000 + 5_000)).toEqual({ text: '也存在电脑上：赤原.json · 刚刚', paused: false });
    expect(fileLine(on(), 1_000_000 + 3 * 60_000 + 5)).toEqual({ text: '也存在电脑上：赤原.json · 3 分钟前', paused: false });
    expect(fileLine(on({ savedAt: null }), 0)).toEqual({ text: '也存在电脑上：赤原.json · 还没写', paused: false });
    expect(fileLine(on({ mode: 'paused', savedAt: null }), 0)).toEqual({ text: '没在写文件：赤原.json', paused: true });
  });

  it('多久以前：刚刚、几分钟前，一小时以上写几点', () => {
    const t = new Date(2026, 10, 11, 14, 5).getTime();
    expect(agoText(t, t + 59_000)).toBe('刚刚');
    expect(agoText(t, t + 60_000)).toBe('1 分钟前');
    expect(agoText(t, t + 59 * 60_000)).toBe('59 分钟前');
    expect(agoText(t, t + 2 * 3_600_000)).toBe('今天 14:05');
    expect(agoText(t, t + 24 * 3_600_000)).toBe('昨天 14:05');
  });

  it('没写成：记号是“文件没写”，说清发生了什么、浏览器里的还在、现在能做什么；浏览器里没存成的先说', () => {
    const gone = saveNote(null, on({ fail: 'gone' }))!;
    expect(gone).toEqual({ badge: '文件没写', tip: '文件没写：找不到那个文件', line: '电脑上的“赤原.json”找不到了，没能写进去。浏览器里的这一份还在。请换一个文件', take: false, reload: false, file: 'pick' });
    const denied = saveNote(null, on({ mode: 'paused', fail: 'denied' }))!;
    expect(denied.file).toBe('resume');
    expect(denied.line).toContain('接着存到 赤原.json');
    expect(saveNote(null, on({ fail: 'full' }))!.line).toContain('磁盘满了');
    expect(saveNote(null, on({ fail: 'failed' }))!.file).toBe('pick');
    for (const k of ['gone', 'denied', 'full', 'failed'] as const) {
      expect(FILE_TEXT.fail[k]('a.json')).toContain('浏览器里的这一份还在');
      expect(FILE_TEXT.fail[k]('a.json')).toMatch(/请/);
    }
    // 写得好好的、只是没在写（还没点“接着存到”）：不出记号
    expect(saveNote(null, on())).toBeNull();
    expect(saveNote(null, on({ mode: 'paused', savedAt: null }))).toBeNull();
    expect(saveNote(null, FILE_OFF)).toBeNull();
    // 浏览器里没存成的更要紧：先说它
    expect(saveNote('quota', on({ fail: 'gone' }))!.badge).toBe('没保存');
  });

  it('不说实现上的词；浏览器不支持时说怎么办', () => {
    const all = JSON.stringify(FILE_TEXT, (_k, v) => (typeof v === 'function' ? v('X', 'Y') : v));
    expect(all).not.toMatch(/IndexedDB|localStorage|标签页|句柄|事务|File System|API|权限/);
    expect(FILE_TEXT.unsupported).toContain('世界文件');
  });
});

// 第九十五轮：撤销到头了（更早的步骤的撤销记录为了省内存丢掉了）
describe('撤销到头', () => {
  it('还有做了的步、但都不能撤销了：到头了；能撤、没做过、只是还没丢到这里：不算', () => {
    expect(undoLimited(false, 300, 300)).toBe(true);
    expect(undoLimited(true, 300, 292)).toBe(false);
    expect(undoLimited(false, 0, 0)).toBe(false);
    expect(undoLimited(false, 5, 0)).toBe(false);
    expect(UNDO_LIMIT_TEXT.tip).toBe('更早的步骤不能撤销了（为了省内存）');
    expect(UNDO_LIMIT_TEXT.history(12)).toBe('前 12 步不能撤销了（为了省内存），世界文件里都还在');
  });
});
