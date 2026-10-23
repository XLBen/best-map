import type { RiverType } from '../river-types';

// 内置示例包“奇幻生态示例”的四种河（第三批）：直接是数据，资源包、测试、河流类型的“新建”都用它。
// 种子用固定的 seedKey：改了 id 匹配的河也不变。
//
// match 脚本每条河算一次（变量是整条河的汇总：海拔、坡度、抬升、气温取平均，流量取最大，位置取源头），
// 阈值调过：在测试用的 1.2 万格大陆、8 千格的星球上三种会自己出现的河都有，但加起来只占一小部分的河（见 core/packs.test.ts）。
// 冥河没有脚本，只能自己画（画河时选它，或者给一条河选它）

const script = (src: string) => ({ api: 1 as const, src });

export const FANTASY_RIVER_TYPES: RiverType[] = [
  {
    id: 'blood_river',
    name: '血河',
    color: '#8f1414',
    style: 'solid',
    width: 1.1,
    bank: { radiusKm: 250 },
    names: [{ p: '{color}血河' }, { p: '{place}血川' }],
    scripts: {
      match: script(
        [
          '// 低地上的大河，碰上一片片“血色”的地方',
          'return discharge >= 4 * riverThreshold && elevation < 900 && fbmAt(1.5, 2, 3) > 0.05;',
        ].join('\n'),
      ),
    },
    seedKey: 'fantasy/blood_river',
    natural: true,
  },
  {
    id: 'crystal_river',
    name: '晶川',
    color: '#79e6ff',
    style: 'glow',
    width: 0.9,
    bank: { radiusKm: 200 },
    names: [{ p: '{color}晶川' }, { p: '{myth}晶河' }],
    scripts: {
      match: script(['// 从高山上冲下来的冷河', 'return sourceElevation > 3800 && tMean < 2 && fbmAt(2, 2, 5) > -0.05;'].join('\n')),
    },
    seedKey: 'fantasy/crystal_river',
    natural: true,
  },
  {
    id: 'styx',
    name: '冥河',
    color: '#2c2742',
    style: 'dashed',
    bank: { radiusKm: 300, dT: -1.5, dP: -0.3 },
    names: [{ p: '{deep}冥河' }, { p: '{myth}幽川' }],
    seedKey: 'fantasy/styx',
    natural: false,
  },
  {
    id: 'lava_river',
    name: '熔岩河',
    color: '#ff6a1c',
    atlasColor: '#c4501a',
    style: 'glow',
    width: 0.8,
    bank: { radiusKm: 180, dT: 4, dP: -0.2 },
    names: [{ p: '{volcanic}火河' }, { p: '{color}熔川' }],
    scripts: {
      match: script(
        [
          '// 抬升很强的山里（火山带）、又陡或者源头很高的河。',
          '// 坡度随格子大小变（格子越大越平缓），所以粗的世界上也看源头的海拔',
          'return (slope > 12 || sourceElevation > 2500) && uplift > 0.7 && tMean >= 2;',
        ].join('\n'),
      ),
    },
    seedKey: 'fantasy/lava_river',
    natural: true,
  },
];
