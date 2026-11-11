import { describe, expect, it } from 'vitest';
import { linear } from './Slider';
import { clampNote, entryText, firstNumber, parseEntry, posForNumber } from './slider-entry';

// 第九十三轮：滑块能打字。打的数在“每个位置写出来的数”里找最接近的那一个，所以任何写法的滑块都能用；
// 拖动的路上不调 textAt（Slider.tsx 只在回车、离开框时调 posForNumber）

describe('字里的数', () => {
  it('第一个数：带单位、负号、千位的逗号、前面有字', () => {
    expect(firstNumber('72 km')).toBe(72);
    expect(firstNumber('−4 °C')).toBe(-4);
    expect(firstNumber('-0.5')).toBe(-0.5);
    expect(firstNumber('35%')).toBe(35);
    expect(firstNumber('12,000 人/km²')).toBe(12000);
    expect(firstNumber('±0.30')).toBe(0.3);
    expect(firstNumber('大河 120 m³/s')).toBe(120);
    expect(firstNumber('稀疏 60% · 间距约 120 km')).toBe(60);
    expect(firstNumber('降水 +20%')).toBe(20);
    expect(firstNumber('降水 −15%')).toBe(-15);
  });

  it('没有数的字：null，框里先空着', () => {
    expect(firstNumber('不限')).toBeNull();
    expect(firstNumber('自动')).toBeNull();
    expect(entryText('不写')).toBe('');
    expect(entryText('1,200 km')).toBe('1200');
  });

  it('打的字：全角、带单位都认；不是数的不认', () => {
    expect(parseEntry(' 3.5 ')).toBe(3.5);
    expect(parseEntry('１２．５')).toBe(12.5);
    expect(parseEntry('35%')).toBe(35);
    expect(parseEntry('-4')).toBe(-4);
    expect(parseEntry('−4°C')).toBe(-4);
    expect(parseEntry('+20')).toBe(20);
    expect(parseEntry('.5')).toBe(0.5);
    expect(parseEntry('')).toBeNull();
    expect(parseEntry('abc')).toBeNull();
    expect(parseEntry('大约 3')).toBeNull();
  });
});

describe('打的数停在哪里', () => {
  it('等间距的滑块：停得到的数原样回来', () => {
    const s = linear(0.5, 10, 0.1);
    const textAt = (p: number) => s.at(p).toFixed(1);
    for (const x of [0.5, 0.6, 1, 3.3, 7.7, 9.9, 10]) {
      const hit = posForNumber(textAt, x)!;
      expect(s.at(hit.pos)).toBe(x);
      expect(hit.clamped).toBeNull();
    }
  });

  it('两千格的滑块也停得准（拖是停不准的）', () => {
    const s = linear(0, 20000, 10);
    const textAt = (p: number) => `${s.at(p)} m`;
    for (const x of [0, 10, 1230, 9990, 19990, 20000]) expect(s.at(posForNumber(textAt, x)!.pos)).toBe(x);
  });

  it('不在格上的数停在最近的一格', () => {
    const s = linear(0, 1, 0.05);
    const textAt = (p: number) => `${Math.round(s.at(p) * 100)}%`;
    expect(s.at(posForNumber(textAt, 33)!.pos)).toBe(0.35);
    expect(s.at(posForNumber(textAt, 32)!.pos)).toBe(0.3);
  });

  it('超出范围：停在那一头，说一句', () => {
    const s = linear(-10, 10, 0.5);
    const textAt = (p: number) => `${s.at(p)} °C`;
    const high = posForNumber(textAt, 99)!;
    expect(s.at(high.pos)).toBe(10);
    expect(high.clamped).toBe('high');
    expect(clampNote(high)).toBe('最大 10 °C');
    const low = posForNumber(textAt, -99)!;
    expect(s.at(low.pos)).toBe(-10);
    expect(clampNote(low)).toBe('最小 -10 °C');
    expect(clampNote(posForNumber(textAt, 3)!)).toBeNull();
  });

  it('按对数的滑块（画笔的直径）、取整成好读的数的', () => {
    const lo = 20;
    const hi = 4000;
    const at = (p: number) => Math.round((lo * Math.pow(hi / lo, Math.max(0, Math.min(1, p)))) / 10) * 10;
    const textAt = (p: number) => `${at(p)} km`;
    for (const x of [20, 150, 720, 1280, 4000]) expect(at(posForNumber(textAt, x)!.pos)).toBe(x);
  });

  it('最左边写的不是数（“自动”“不限”）：那一段不算，照样停得准', () => {
    const s = linear(0, 5000, 100);
    const textAt = (p: number) => (s.at(p) <= 0 ? '不限' : `${s.at(p)} m`);
    expect(s.at(posForNumber(textAt, 1200)!.pos)).toBe(1200);
    // 比能写的数都小：停在第一个有数的地方
    const low = posForNumber(textAt, 0)!;
    expect(s.at(low.pos)).toBe(100);
    expect(low.clamped).toBe('low');
  });

  it('从大到小的滑块也行；整条都没有数时不动', () => {
    const textAt = (p: number) => `${Math.round(100 - p * 100)}`;
    expect(posForNumber(textAt, 30)!.pos).toBeCloseTo(0.7, 2);
    expect(posForNumber(() => '自动', 3)).toBeNull();
  });

  it('只在要的时候算：一次不超过两百次', () => {
    let calls = 0;
    const s = linear(0, 1000, 1);
    posForNumber((p) => {
      calls++;
      return String(s.at(p));
    }, 421);
    expect(calls).toBeLessThanOrEqual(200);
  });
});
