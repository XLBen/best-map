import type { PlanetForm } from '../planet-form';

// “通用 ▸ 星球形态”（第三十轮）：以前向导里写死的六种星球（presets.ts 的 PLANET_TYPES）改成普通的星球形态，
// 和奇幻的形态一样从资源包里选、可以改、可以照着做自己的。形态的 base 指向生成器的算法种类（generate.ts 的 WORLD_TYPES，
// 那是算法，不是内容）；这几种都不改配方、不带脚本（海洋星球只把“岛多少”调到 0.7），用它新建的世界与以前选那种星球
// 新建的逐值相同（测试逐种对）。只在主线程用

export const BUILTIN_PLANET_FORMS: readonly PlanetForm[] = [
  { id: 'continents', name: '像地球', hint: '几块大小不一的大陆，许多岛', api: 1, base: 'continents' },
  { id: 'continent', name: '一块超大陆', hint: '一块巨大的大陆，周围是大洋', api: 1, base: 'continent' },
  { id: 'fragmented', name: '破碎大陆', hint: '许多中小块陆地和浅海', api: 1, base: 'fragmented' },
  { id: 'archipelago', name: '群岛星球', hint: '几乎全是海，散布着群岛', api: 1, base: 'archipelago' },
  { id: 'ocean_islands', name: '海洋星球', hint: '一片大洋，只有火山岛露出海面', api: 1, base: 'ocean', profile: { islands: 0.7 } },
  { id: 'blank', name: '空白星球', hint: '全是海，自己来画', api: 1, base: 'ocean' },
];
