import type { PlanetForm } from '../planet-form';

// 内置示例包里的三个星球形态（以后并进 core/packs/fantasy.ts 的内置资源包）。
// 一个只用脚本布局（双子大陆）、一个完全不写代码（环形内海）、一个布局加地形两段脚本（极地大陆），
// 写形态的人可以照着改。seedKey 固定：改了 id，噪声与随机数也不变

export const TWIN_CONTINENTS: PlanetForm = {
  id: 'twin_continents',
  name: '双子大陆',
  hint: '两块大陆隔着大洋遥遥相对，四周是岛',
  api: 1,
  base: 'continents',
  seedKey: 'fantasy/twin_continents',
  // 不要配方里的大陆块，只要脚本加的两块。两块的面积约占星球的 18%（再小，陆地就凑不够设定的比例）
  profile: { blocks: [0, 0], landFraction: 0.18 },
  scripts: {
    setup: {
      api: 1,
      src: [
        '// 两块大陆：一块偏北、一块偏南，经度正好相差 180°',
        'const lon = rand() * 360 - 180;',
        'const lat = rand() * 30 - 15;',
        'addBlock({ lat: lat + 8, lon: lon, size: 36, stretch: 1.5, angle: rand() * 180 });',
        'addBlock({ lat: -lat - 8, lon: lon + 180, size: 34, stretch: 1.4, angle: rand() * 180 });',
      ].join('\n'),
    },
  },
};

export const RING_SEA: PlanetForm = {
  id: 'ring_sea',
  name: '环形内海',
  hint: '一圈陆地环抱着一片内海',
  api: 1,
  // 向导里不提供的“内海”这一种星球：陆地排成一圈
  base: 'inland_sea',
  seedKey: 'fantasy/ring_sea',
  // 块多一些、大一些，环才连成一整圈；陆地比例与这一圈块能凑出的面积相当（设得更大也凑不出来）
  profile: { blocks: [10, 12], radius: [0.22, 0.28], landFraction: 0.3 },
};

export const POLAR_CONTINENTS: PlanetForm = {
  id: 'polar_continents',
  name: '极地大陆',
  hint: '南北两极各有一块高耸的冰原大陆',
  api: 1,
  base: 'continents',
  seedKey: 'fantasy/polar_continents',
  profile: { blocks: [2, 3], landFraction: 0.32 },
  scripts: {
    setup: {
      api: 1,
      src: [
        '// 北极、南极各加一块大陆',
        'addBlock({ lat: 82, lon: rand() * 360 - 180, size: 26, stretch: 1.3, angle: rand() * 180 });',
        'addBlock({ lat: -80, lon: rand() * 360 - 180, size: 24, stretch: 1.2, angle: rand() * 180 });',
      ].join('\n'),
    },
    crust: {
      api: 1,
      src: [
        '// 纬度越高，大陆抬得越高（离大陆边缘越远抬得越多）',
        'const polar = smoothstep(55, 80, Math.abs(lat));',
        'return { height: height + 900 * polar * Math.max(0, continent) };',
      ].join('\n'),
    },
  },
};

export const FANTASY_FORMS: readonly PlanetForm[] = [TWIN_CONTINENTS, RING_SEA, POLAR_CONTINENTS];
