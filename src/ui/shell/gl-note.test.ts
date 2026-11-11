import { describe, expect, it } from 'vitest';
import { GL_TEXT as T } from '../copy';
import { glNote } from './gl-note';

// 第九十六轮：地图的画面不可用时盖着的那一块写什么

describe('地图的画面不可用', () => {
  it('正常时没有这一块', () => {
    expect(glNote('ok', false)).toBeNull();
    expect(glNote('ok', true)).toBeNull();
  });

  it('正在恢复：只说一句、转圈，没有按钮', () => {
    expect(glNote('lost', true)).toEqual({ text: '画面暂时不可用，正在恢复…', busy: true, actions: [] });
  });

  it('恢复不了、画不出来：说清世界存好了没有，现在点什么', () => {
    for (const s of ['stuck', 'broken'] as const) {
      const saved = glNote(s, false)!;
      expect(saved.text).toContain('已存在浏览器里');
      expect(saved.text).toContain('重新载入');
      expect(saved.actions).toEqual(['reload']);
      const dirty = glNote(s, true)!;
      // 没存好时不说“已存好”，先让导出
      expect(dirty.text).not.toContain('已存在浏览器里');
      expect(dirty.text).toContain('导出文件');
      expect(dirty.actions).toEqual(['export', 'reload']);
    }
    expect(glNote('stuck', false)!.text.startsWith(T.stuck)).toBe(true);
    expect(glNote('broken', false)!.text.startsWith(T.broken)).toBe(true);
  });
});
