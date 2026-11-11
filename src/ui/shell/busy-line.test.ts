import { describe, expect, it } from 'vitest';
import type { ProgressView } from '../../state';
import { PROGRESS_TEXT, STOP_TEXT } from '../copy';
import { busyLineText } from './busy-line';

// 第九十七轮：“正在计算…”那一行写什么

const view = (step: string | null, count: ProgressView['count'] = null): ProgressView => ({ step, fraction: 0.3, count, cancel: true });

describe('正在算的那一行', () => {
  it('短的（没有进度）、还没说过哪一步、不认识的步：这个请求自己的提示', () => {
    expect(busyLineText('正在计算…', null, false)).toBe('正在计算…');
    expect(busyLineText('正在生成世界…', view(null), false)).toBe('正在生成世界…');
    expect(busyLineText('撤销…', view('human.peek-74'), false)).toBe('撤销…');
    expect(busyLineText('正在打开世界…', view('restore'), false)).toBe('正在打开世界…');
  });

  it('说到了哪一步：那一步的人话', () => {
    expect(busyLineText('正在生成世界…', view('climate'), false)).toBe('正在算气候…');
    expect(busyLineText('正在生成世界…', view('water'), false)).toBe('正在画河…');
    expect(busyLineText('正在计算…', view('human.countries'), false)).toBe('正在划国家…');
  });

  it('重放命令：第几步、共几步；还没数出来时是请求自己的提示', () => {
    expect(busyLineText('正在打开世界…', view('replay', { k: 120, n: 800 }), false)).toBe('正在重做第 120 / 800 步…');
    expect(busyLineText('正在打开世界…', view('replay'), false)).toBe('正在打开世界…');
  });

  it('点了取消、还没停下：正在取消…', () => {
    expect(busyLineText('正在计算…', view('climate'), true)).toBe(STOP_TEXT.cancelling);
    expect(busyLineText('正在计算…', null, true)).toBe('正在取消…');
  });

  it('文字的规矩：进行中的都以“正在”开头、以“…”结尾，不出现英文和开发的词', () => {
    const all = [...Object.values(PROGRESS_TEXT.steps), PROGRESS_TEXT.replay(3, 9), STOP_TEXT.cancelling];
    for (const t of all) {
      expect(t, t).toMatch(/^正在.+…$/);
      expect(t, t).not.toMatch(/[A-Za-z]|网格|流水线|重放|推导|Worker|线程/);
      expect(t.length, t).toBeLessThanOrEqual(20);
    }
    expect(STOP_TEXT.stop).toBe('取消');
  });
});
