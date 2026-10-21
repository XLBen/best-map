import { describe, expect, it } from 'vitest';
import { extendedHashes } from '../tools/hash';
import golden from './golden-full.json';

// 更长的一组操作后，整个世界（网格、原因、推导的每一个数组、地物、省份等）按字节的哈希。
// 提速的改动必须逐值不变：这里的值一旦记下就不再改（除非有意改变结果，并在提交说明里写明原因）
describe('整个世界逐值不变（加长的操作序列）', () => {
  it('一块地区', () => {
    expect(extendedHashes('region')).toEqual(golden.region);
  });
  it('整个星球（含接缝上的岛、重画一片、洋流强弱、撤销与重做）', () => {
    expect(extendedHashes('planet')).toEqual(golden.planet);
  });
});
