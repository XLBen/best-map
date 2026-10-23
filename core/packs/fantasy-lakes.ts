import type { LakeType } from '../lake-types';

// 内置示例包“奇幻生态示例”的四种湖（第九轮）：直接是数据，资源包、测试、湖泊类型的示例按钮都用它。
// 种子用固定的 seedKey：改了 id 匹配的湖也不变。
//
// match 脚本每个湖算一次（变量是整个湖的汇总：海拔、气温取平均，流量取最大，另有湖的面积、流进来的水、是不是干湖……），
// 条件都定得很窄：大多数湖照旧是普通的湖（见 core/packs.test.ts）。冥湖没有脚本，只能自己选

const script = (src: string) => ({ api: 1 as const, src });

export const FANTASY_LAKE_TYPES: LakeType[] = [
  {
    id: 'blood_pool',
    name: '血池',
    color: '#9b1b1b',
    atlasColor: '#a3302a',
    style: 'solid',
    bank: { radiusKm: 150 },
    names: [{ p: '{color}血池' }, { p: '{place}血潭' }],
    scripts: {
      match: script(['// 又低又热的地方，碰上一片片“血色”的湖', 'return !dryLake && elevation < 600 && tMean > 16 && fbmAt(1.5, 2, 7) > 0.3;'].join('\n')),
    },
    seedKey: 'fantasy/blood_pool',
    natural: true,
  },
  {
    id: 'crystal_lake',
    name: '晶湖',
    color: '#8fe9ff',
    atlasColor: '#5fb8d4',
    style: 'glow',
    bank: { radiusKm: 150 },
    names: [{ p: '{myth}晶湖' }, { p: '{color}镜湖' }],
    scripts: {
      match: script(['// 高山上的冷湖', 'return !dryLake && elevation > 2500 && tMean < 3;'].join('\n')),
    },
    seedKey: 'fantasy/crystal_lake',
    natural: true,
  },
  {
    id: 'styx_lake',
    name: '冥湖',
    color: '#2c2742',
    style: 'solid',
    bank: { radiusKm: 250, dT: -1, dP: -0.2 },
    names: [{ p: '{deep}冥湖' }, { p: '{myth}幽潭' }],
    seedKey: 'fantasy/styx_lake',
    natural: false,
  },
  {
    id: 'lava_lake',
    name: '熔岩湖',
    color: '#ff5a14',
    atlasColor: '#c4501a',
    style: 'glow',
    bank: { radiusKm: 150, dT: 3, dP: -0.2 },
    names: [{ p: '{volcanic}火湖' }, { p: '{color}熔池' }],
    scripts: {
      match: script(['// 火山带里又高又热的湖', 'return uplift > 0.8 && elevation > 1500 && tMean >= 5;'].join('\n')),
    },
    seedKey: 'fantasy/lava_lake',
    natural: true,
  },
];
