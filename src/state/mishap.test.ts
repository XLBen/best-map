import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MISHAP_TEXT } from '../crash-text';
import { MISHAP_MS, closeMishap, mishap, noteMishap, showToastReason, toggleMishapReason } from './mishap';
import { showToast, toast } from './notes';

// 第九十六轮：顶上的一条（不致命的错）——不打断、过一阵自己消失、展开“原因”以后等用户关；出错的提示条上的“原因”

const note = (id: number, more: Partial<Parameters<typeof noteMishap>[0]> = {}) => ({ id, sig: `s${id}`, human: { text: '程序内部出错', detail: 'TypeError: x' }, detail: 'TypeError: x\n    at f (a.js:1:1)', count: 1, ...more });

beforeEach(() => {
  vi.useFakeTimers();
  closeMishap();
  toast.value = null;
});
afterEach(() => vi.useRealTimers());

describe('顶上的一条', () => {
  it('说“刚才那一步可能没做成”；原因里先是人话、再是原话；过一阵自己消失', () => {
    noteMishap(note(1));
    expect(mishap.value).toMatchObject({ id: 1, text: MISHAP_TEXT.generic, open: false, count: 1 });
    expect(mishap.value!.detail).toBe('程序内部出错\n\nTypeError: x\n    at f (a.js:1:1)');
    vi.advanceTimersByTime(MISHAP_MS - 1);
    expect(mishap.value).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(mishap.value).toBeNull();
  });

  it('原话本来就是人话：原因里不重复写一遍', () => {
    noteMishap(note(9, { human: { text: '读不出“赤原”', detail: null }, detail: 'Error: 读不出“赤原”\n    at f (a.js:1:1)' }));
    expect(mishap.value!.detail).toBe('Error: 读不出“赤原”\n    at f (a.js:1:1)');
  });

  it('一块画不出来：写那一块的名字', () => {
    noteMishap(note(2, { part: '资源库' }));
    expect(mishap.value!.text).toBe('“资源库”出了问题，已经关闭。世界还在，可以接着用');
  });

  it('同一个错再来：只改次数，不重新弹', () => {
    noteMishap(note(3));
    toggleMishapReason();
    noteMishap(note(3, { count: 4 }));
    expect(mishap.value).toMatchObject({ id: 3, count: 4, open: true });
  });

  it('展开“原因”以后不自己消失；收起以后重新计时；× 关闭', () => {
    noteMishap(note(4));
    toggleMishapReason();
    vi.advanceTimersByTime(MISHAP_MS * 3);
    expect(mishap.value?.open).toBe(true);
    toggleMishapReason();
    vi.advanceTimersByTime(MISHAP_MS + 1);
    expect(mishap.value).toBeNull();
    noteMishap(note(5));
    closeMishap();
    expect(mishap.value).toBeNull();
  });
});

describe('出错的提示条', () => {
  it('引擎的原话翻成人话；原话不一样时带着“原因”，点了换成展开的那一条', () => {
    showToast('命令参数无效：(根)：Invalid input', true);
    expect(toast.value).toEqual({ text: '这一步的内容格式不对', error: true, detail: '命令参数无效：(根)：Invalid input' });
    showToastReason();
    expect(toast.value).toBeNull();
    expect(mishap.value).toMatchObject({ text: '这一步的内容格式不对', detail: '命令参数无效：(根)：Invalid input', open: true });
    // 展开着：不自己消失
    vi.advanceTimersByTime(MISHAP_MS * 2);
    expect(mishap.value).not.toBeNull();
  });

  it('本来就是人话的出错提示、不是出错的提示：原样，没有“原因”', () => {
    showToast('读不出“赤原”', true);
    expect(toast.value).toEqual({ text: '读不出“赤原”', error: true });
    showToastReason();
    expect(mishap.value).toBeNull();
    showToast('Invalid input 之类的字不会出现在普通提示里，这里只是原样', false);
    expect(toast.value?.detail).toBeUndefined();
  });
});
