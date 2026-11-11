import { describe, expect, it } from 'vitest';
import { failWhy, hasUnsaved, saveProblemOf } from './save-status';

// 第九十四轮：现在有没有没存的改动（关页面前要不要提醒）、没存成是哪一种原因、要告诉用户哪一种

const quota = Object.assign(new Error('满了'), { name: 'QuotaExceededError' });

describe('现在有没有没存的改动', () => {
  it('刚存完没有；改了一步有；写完又没有', () => {
    // 刚存完：世界就是写下的那个状态
    expect(hasUnsaved({ world: true, state: 7, saved: 7, pending: false })).toBe(false);
    // 改了一步（还没到写的时候、正在写、没写成都一样：世界不是写下的那个状态）
    expect(hasUnsaved({ world: true, state: 8, saved: 7, pending: false })).toBe(true);
    // 写完
    expect(hasUnsaved({ world: true, state: 8, saved: 8, pending: false })).toBe(false);
  });

  it('计算程序里还有没应答的编辑：有；还没写过：有；没有世界：没有', () => {
    expect(hasUnsaved({ world: true, state: 8, saved: 8, pending: true })).toBe(true);
    expect(hasUnsaved({ world: true, state: 1, saved: -2, pending: false })).toBe(true);
    expect(hasUnsaved({ world: false, state: 1, saved: -2, pending: true })).toBe(false);
  });
});

describe('没存成是哪一种', () => {
  it('存储满了；存储不可用（隐私模式）；存储不可用、退回的小地方放不下是世界太大', () => {
    expect(failWhy(quota, quota)).toBe('quota');
    expect(failWhy(quota, new Error('别的'))).toBe('quota');
    expect(failWhy(new Error('打不开'), quota)).toBe('too-big');
    expect(failWhy(new Error('打不开'), Object.assign(new Error('x'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' }))).toBe('too-big');
    expect(failWhy(new Error('打不开'), Object.assign(new Error('不让用'), { name: 'SecurityError' }))).toBe('unavailable');
    expect(failWhy(new Error('打不开'), new ReferenceError('localStorage is not defined'))).toBe('unavailable');
    // 退回的位置上压着没能挪走的旧世界（挪不走就是因为满了）
    expect(failWhy(new Error('打不开'), 'blocked')).toBe('quota');
  });
});

describe('要告诉用户哪一种', () => {
  it('存得好好的、还没有世界：不说；不是写的那一方先说；别的照原因', () => {
    expect(saveProblemOf({ world: true, role: 'writer', fail: null })).toBeNull();
    expect(saveProblemOf({ world: true, role: 'unknown', fail: null })).toBeNull();
    expect(saveProblemOf({ world: false, role: 'other', fail: 'quota' })).toBeNull();
    expect(saveProblemOf({ world: true, role: 'other', fail: null })).toBe('other-page');
    expect(saveProblemOf({ world: true, role: 'other', fail: 'quota' })).toBe('other-page');
    expect(saveProblemOf({ world: true, role: 'writer', fail: 'quota' })).toBe('quota');
    expect(saveProblemOf({ world: true, role: 'writer', fail: 'unavailable' })).toBe('unavailable');
    expect(saveProblemOf({ world: true, role: 'writer', fail: 'too-big' })).toBe('too-big');
  });
});
