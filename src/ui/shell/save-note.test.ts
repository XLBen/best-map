import { describe, expect, it } from 'vitest';
import { SAVE_TEXT } from '../copy';
import { saveNote } from './save-note';

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

  it('每一句都说了现在能做什么；不说实现上的词', () => {
    for (const k of ['quota', 'unavailable', 'too-big'] as const) expect(SAVE_TEXT.problem[k]).toContain('导出世界文件');
    const all = [...Object.values(SAVE_TEXT.problem), ...Object.values(SAVE_TEXT.tip), SAVE_TEXT.otherPage, SAVE_TEXT.takeOverTip, SAVE_TEXT.tight, SAVE_TEXT.exportTip];
    for (const t of all) expect(t).not.toMatch(/IndexedDB|localStorage|标签页|自动保存表|事务|锁/);
  });
});
