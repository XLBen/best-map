import { describe, expect, it } from 'vitest';
import { defaultValue } from '../packs/fields';
import { moveRange, rangeText } from './RangeSliders';

// 第五十五轮：一段范围的两个滑块（生态的高度范围）

describe('范围的两个滑块', () => {
  it('到两头写“不限”，中间写数和单位', () => {
    expect(rangeText(0, 0, 9000, 'm')).toBe('不限');
    expect(rangeText(9000, 0, 9000, 'm')).toBe('不限');
    expect(rangeText(1500, 0, 9000, 'm')).toBe('1500 m');
  });

  it('不交叉：拖过另一个时它跟着走', () => {
    expect(moveRange({ low: 1000, high: 2000 }, 'low', 1500)).toEqual({ low: 1500, high: 2000 });
    expect(moveRange({ low: 1000, high: 2000 }, 'low', 3000)).toEqual({ low: 3000, high: 3000 });
    expect(moveRange({ low: 1000, high: 2000 }, 'high', 500)).toEqual({ low: 500, high: 500 });
  });

  it('新加这个字段时两头都不限', () => {
    expect(defaultValue({ key: 'height', label: '高度范围', type: 'range', min: 0, max: 9000 })).toEqual({ low: 0, high: 9000 });
  });
});
