import { describe, expect, it } from 'vitest';
import { linear } from './Slider';

// 第十九轮 B：全界面一种滑块，原生的 range 换成它之后，值照旧按步长取整、不超出范围

describe('等间距滑块的换算', () => {
  it('位置与值互换，按步长取整，没有 0.30000000000000004 这样的数', () => {
    const s = linear(0.5, 10, 0.1);
    expect(s.at(0)).toBe(0.5);
    expect(s.at(1)).toBe(10);
    expect(s.at(s.pos(3.3))).toBe(3.3);
    expect(String(s.at(0.0526))).toBe('1');
  });

  it('拖出滑轨也停在两头', () => {
    const s = linear(-180, 180, 1);
    expect(s.at(-0.2)).toBe(-180);
    expect(s.at(1.5)).toBe(180);
    expect(s.pos(400)).toBe(1);
  });

  it('步长 5：参考图的浓淡 10%–100%', () => {
    const s = linear(10, 100, 5);
    expect(s.at(0.5)).toBe(55);
    expect(s.at(0.51)).toBe(55);
    expect(s.pos(55)).toBeCloseTo(0.5);
  });
});
