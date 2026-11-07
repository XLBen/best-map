import { describe, expect, it } from 'vitest';
import { referenceHashes } from '../tools/hash';
import golden from './golden-hashes.json';

// 一块地区的世界：固定的一组操作后各层数据的哈希。加“整个星球”时平面的代码不能有一点变化，
// 所以这里的值一旦记下就不再改（除非有意改变平面世界的结果，并在提交说明里写明原因）
// 第四十六轮：一块地区有了洋流（进气候），有意改变结果：tS、pS、discharge、dominant、corrT、province、features 重录（高程、陆海不变）
// 第五十五轮：生态跟高度走，有意改变结果：dominant、features 重录；这组操作里有“自然融入”，修正场跟着生态变，corrT、tS、pS、discharge 也重录
// （高程、陆海、网格不变；去掉内置生态的高度范围时全部回到以前的值，见 biome-legacy.test.ts）
// 第七十六轮：中文地名风格的模板“某某沙漠 / 冻原 / 冰原”改成“荒漠 / 苔原 / 冰盖”，重录变了的几项（地名、小数据里的地名风格、世界文件）；核对过两边的世界只差这三个字
describe('一块地区的世界逐值不变', () => {
  it('参考操作后的各层哈希与记录一致', () => {
    expect(referenceHashes()).toEqual(golden);
  });
});
