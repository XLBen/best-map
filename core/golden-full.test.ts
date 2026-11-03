import { describe, expect, it } from 'vitest';
import { extendedHashes } from '../tools/hash';
import golden from './golden-full.json';

// 更长的一组操作后，整个世界（网格、原因、推导的每一个数组、地物、省份等）按字节的哈希。
// 提速的改动必须逐值不变：这里的值一旦记下就不再改（除非有意改变结果，并在提交说明里写明原因）。
// 第三十八轮：新世界默认多加画风包，只有 small 一项重录（核对过默认的包里去掉画风时与原来的值逐值相同）
// 第四十二轮：新世界默认多加国家等级包、城市等级多了浓淡与大小，只有 small 一项重录（核对过去掉国家等级包、城市等级照旧时与原来的值逐值相同）
// 第四十六轮：一块地区有了洋流（进气候），region 里气候与往后的几项（温度、降水、湿润、径流、生态、修正场、海流、海温偏离、地物、省份、small）重录；
// 网格、原因、高程、风、大陆度、水面、湖、流向、汇水都不变。planet 一项没变
// 第五十一轮：通用拆进了各库，新世界的内容来自“中世纪与近世”，来源的路径（small.origin）变了，只有 small 一项重录（核对过 from 写回 common 时与原来的值逐值相同）
describe('整个世界逐值不变（加长的操作序列）', () => {
  it('一块地区', () => {
    expect(extendedHashes('region')).toEqual(golden.region);
  });
  it('整个星球（含接缝上的岛、重画一片、洋流强弱、撤销与重做）', () => {
    expect(extendedHashes('planet')).toEqual(golden.planet);
  });
});
