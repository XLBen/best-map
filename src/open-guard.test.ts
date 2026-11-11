import { describe, expect, it } from 'vitest';
import { OPEN_GUARD_ASK, OPEN_GUARD_KEY, askBeforeOpen, beginOpen, endOpen, readOpenMark } from './open-guard';

// 第九十六轮：启动时打开上次的世界，连着两次没打开成（页面出了问题、被停下），下次先问

function store() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('连着几次没打开成', () => {
  it('打开成了就擦掉：下次照常直接打开', () => {
    const s = store();
    expect(askBeforeOpen(readOpenMark(s, 100))).toBe(false);
    beginOpen(s, 100, 1);
    endOpen(s);
    expect(readOpenMark(s, 100)).toBeNull();
    expect(askBeforeOpen(readOpenMark(s, 100))).toBe(false);
  });

  it('一次没打开成（关了页面）：下次照常再试；连着两次：先问', () => {
    const s = store();
    // 第一次启动：动手了，页面就没了
    beginOpen(s, 100, 1);
    // 第二次启动
    expect(readOpenMark(s, 100)).toEqual({ n: 1, saved: 100, at: 1 });
    expect(askBeforeOpen(readOpenMark(s, 100))).toBe(false);
    beginOpen(s, 100, 2);
    // 第三次启动
    expect(readOpenMark(s, 100)!.n).toBe(OPEN_GUARD_ASK);
    expect(askBeforeOpen(readOpenMark(s, 100))).toBe(true);
    // 问了以后“再试一次”又没成：下次还问
    beginOpen(s, 100, 3);
    expect(askBeforeOpen(readOpenMark(s, 100))).toBe(true);
    // 这次成了
    endOpen(s);
    expect(askBeforeOpen(readOpenMark(s, 100))).toBe(false);
  });

  it('认的是哪一份自动保存：换了一份就从头数', () => {
    const s = store();
    beginOpen(s, 100, 1);
    beginOpen(s, 100, 2);
    expect(askBeforeOpen(readOpenMark(s, 200))).toBe(false);
    beginOpen(s, 200, 3);
    expect(readOpenMark(s, 200)).toEqual({ n: 1, saved: 200, at: 3 });
    expect(readOpenMark(s, 100)).toBeNull();
  });

  it('没有 localStorage、存着的是坏的、写不进去：当没有，不抛', () => {
    expect(readOpenMark(null, 1)).toBeNull();
    beginOpen(null, 1, 1);
    endOpen(null);
    const s = store();
    s.m.set(OPEN_GUARD_KEY, '{不是 JSON');
    expect(readOpenMark(s, 1)).toBeNull();
    s.m.set(OPEN_GUARD_KEY, JSON.stringify({ n: 'x', saved: 1 }));
    expect(readOpenMark(s, 1)).toBeNull();
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(() => beginOpen(full, 1, 1)).not.toThrow();
    expect(() => endOpen(full)).not.toThrow();
  });
});
