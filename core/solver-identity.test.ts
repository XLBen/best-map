import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../tools/hash';
import type { SolveResult } from './constraints';
import { Engine } from './engine';
import { graphDistance } from './mesh';
import { seededEngine } from './testing/fixtures';

// 约束求解（自然融入）提速后必须逐值不变：可行、不可行、几块设定的修正区重叠、硬覆盖与自然融入混用、
// 自定义场、扩散不到的类型，地区与小星球。每一步之后记下修正场、主导类型、份额等推导数组与求解计划的哈希。
// RECORDED 里的值来自提速之前的代码（c6f1444 的 constraints.ts），不要为了让测试通过而改它们。
// world 一项在第八轮更新过一次：它把地物（derived.features）也算在内，涂出来的生态区有了自己的名字、标注放进地物自己的格里；
// 核对过每一步的 digestWorld 只有 derived.features 一项不同，其余各项一个没变。
// 第九轮去掉旧存档兼容时 world 又更新过一次：星球参数里的洋流强弱、山挡风成了总有的项（小数据的摘要变了）；
// 这里先把山挡风设成 0，所以修正场、份额等各项与提速之前的代码仍然逐值相同
// 第九轮“名字不乱跳”时 world 又更新过一次：编辑之后原有的地物留着原来的名字（小数据里多了 keptNames）。
// 核对过每一步的 digestWorld 只有 derived.features 与 small 两项不同，地物除了名字一个没变；关掉留名字时与原来的值逐值相同
// 第十九轮 C 改了没涂成的建议的文字（conflicts 里的 suggestions），conflicts 与 world 两项重录；
// 核对过：把 suggestions 清空后，每一步的每一项与改字之前逐值相同
// 第三十轮新世界从资源包加生态、基础内容（小数据里多了这些内容与来源，生态多了宜居度等字段），world 与 replay 重录；
// 核对过：每一步的 digestWorld 除了 small 以外与第二十九轮的代码逐值相同，别的各项（修正场、份额、计划……）没有变

function run(kind: 'region' | 'planet'): Record<string, Record<string, string>> {
  const eng =
    kind === 'planet'
      ? seededEngine({ seed: 2, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 })
      : seededEngine({ seed: 4, cells: 8000, latNorth: 62, latSouth: 18 });
  const w = eng.world;
  const n = w.mesh.n;
  // 山挡风关掉：与记下 RECORDED 时的世界相同（第九轮起新世界默认打开山挡风）
  eng.exec({ op: 'set_planet', patch: { terrainWind: 0 } });
  eng.exec({ op: 'set_worldgen', params: { seed: kind === 'planet' ? 2 : 4, type: 'continents' }, reset: true });
  const veg = (i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
  // 年均温在 [lo, hi) 的第一个植被格附近最近的 count 个植被格（跳过前 skip 个）
  const patch = (lo: number, hi: number, count: number, skip = 0) => {
    const d = w.derived;
    const seed = [...Array(n).keys()].find((i) => veg(i) && d.tMean[i] >= lo && d.tMean[i] < hi)!;
    const dist = graphDistance(w.mesh, [seed]);
    return [...Array(n).keys()].filter(veg).sort((a, b) => dist[a] - dist[b] || a - b).slice(skip, skip + count);
  };
  const out: Record<string, Record<string, string>> = {};
  const snap = (label: string) => {
    const d = eng.world.derived;
    const { plans } = (eng as unknown as { solve: SolveResult }).solve;
    out[label] = {
      world: digest(digestWorld(eng.world)),
      corrT: digest(d.corrT),
      corrP: digest(d.corrP),
      corrF: digest(Object.entries(d.corrF).map(([k, v]) => [k, digest(v)])),
      dominant: digest(d.dominant),
      share: digest(d.share),
      tMean: digest(d.tMean),
      precip: digest(d.precip),
      conflicts: digest(d.conflicts),
      plans: digest(
        plans.map((p) => ({
          id: p.constraint.id,
          target: p.target,
          cells: digest(Int32Array.from(p.cells)),
          cost: digest(p.cost),
          dT: digest(p.dT),
          dl: digest(p.dl),
          dF: Object.entries(p.dF).map(([k, v]) => [k, digest(v)]),
          anchors: digest(Int32Array.from(p.anchors)),
          nearest: digest(p.nearest),
        })),
      ),
    };
  };
  const add = (id: string, cells: number[], species: string, ratio: number, radius: number, mode: 'constraint' | 'override' = 'constraint') =>
    eng.exec({ op: 'add_constraint', constraint: { id, cells, species, mode, ratio, radius } });

  if (kind === 'planet') {
    add('forest', patch(8, 12, 150), 'temperate_forest', 1, 600);
    snap('forest');
    add('tundra', patch(0, 4, 150), 'tundra', 0.6, 500);
    snap('tundra');
    eng.exec({ op: 'paint', field: 'moistOffset', cells: patch(14, 20, 200), value: -0.4, mode: 'add' });
    snap('edit');
    eng.undo();
    snap('undo');
    return out;
  }
  // 可行
  add('forest', patch(8, 12, 150), 'temperate_forest', 1, 600);
  snap('forest');
  // 暖处的苔原：降温到上限也不够（不可行）；凉处的苔原：部分可行
  add('tundra-warm', patch(14, 18, 120), 'tundra', 1, 500);
  snap('tundra-warm');
  add('tundra-cool', patch(2, 6, 120), 'tundra', 0.8, 500);
  snap('tundra-cool');
  // 紧挨着森林的荒漠，修正区与森林的重叠；只要求一半
  add('desert', patch(8, 12, 100, 150), 'desert', 0.5, 700);
  snap('desert');
  // 硬覆盖与自然融入混用
  add('override', patch(8, 12, 40, 250), 'savanna', 1, 400, 'override');
  snap('override');
  // 自定义场：目标类型要求它在最适区间
  eng.exec({ op: 'add_field', name: 'magic' });
  eng.exec({ op: 'paint', field: 'field:magic', cells: patch(4, 9, 300), value: 0.3 });
  eng.exec({
    op: 'add_species',
    species: {
      id: 'glow',
      name: '辉光林',
      competition: 5,
      tolerances: [
        { field: 'tMean', min: 0, optLow: 3, optHigh: 12, max: 15 },
        { field: 'moisture', min: 0.4, optLow: 0.6, optHigh: 3, max: 4 },
        { field: 'field:magic', min: 0.2, optLow: 0.5, optHigh: 1, max: 1.3 },
      ],
    },
  });
  snap('species');
  add('glow', patch(4, 9, 80), 'glow', 0.9, 500);
  snap('glow');
  // 地形条件（湿地、平地）大多不满足：多数格不可行
  add('wetland', patch(10, 16, 100), 'wetland', 1, 400);
  snap('wetland');
  // 扩散不到的类型
  eng.exec({ op: 'update_species', id: 'rainforest', patch: { dispersal: { origins: [0], range: 200 } } });
  add('rain', patch(16, 30, 60), 'rainforest', 1, 400);
  snap('rain');
  // 耐受曲线的端点极大（求解器不对它走捷径）
  eng.exec({
    op: 'add_species',
    species: {
      id: 'odd',
      competition: 3.5,
      tolerances: [
        { field: 'precip', min: -1e20, optLow: 900, optHigh: 2500, max: 1e20 },
        { field: 'tMean', min: 5, optLow: 9, optHigh: 16, max: 19 },
      ],
    },
  });
  add('odd', patch(9, 15, 90, 40), 'odd', 1, 500);
  snap('odd');
  // 之后的编辑：从气候起重算，求解重跑
  eng.exec({ op: 'paint', field: 'tempOffset', cells: patch(6, 14, 200, 20), value: -2, mode: 'add' });
  snap('edit');
  eng.undo();
  eng.undo();
  snap('undo');
  // 重放存档：逐条命令重算
  const re = Engine.fromDoc(eng.toDoc(), w.mesh);
  out.replay = { world: digest(digestWorld(re.world)) };
  return out;
}

// 第十三轮：默认生态换了新配色，小数据（world 一项）跟着变，别的逐值不变，重录 world
// 第十三轮修：陆地围住的小块海（6 格以内）并回陆地、三格以上挖成湖，放的火山岛按大小定高度并有火山口，陆海、高程往后都变了，重录变了的项
// 第三十二轮：地形有了大格局（高程、湖、河、气候往后都变了），用第三十二轮的代码重录全部
// 第三十三轮：平原与河口（冲积平原、冲积扇、三角洲平原）改了高程，往后都变了，再重录一次
const RECORDED: Record<string, Record<string, Record<string, string>>> = {
  region: {
    forest: {
      world: '1d5e92ac94fa3770', corrT: '3da0e19ae817b168', corrP: 'c3ddf45ea9410cc2', corrF: '85284cd307d8e6fb', dominant: '46a8d52b312d814e',
      share: '79a91e01092c703a', tMean: '040e1f78c5e224fc', precip: '4abffb5f9c51d51d', conflicts: '845a425c7b5b1dea', plans: 'd315b9e5b38709d8',
    },
    'tundra-warm': {
      world: '37e7ad42463a8f4f', corrT: '8309a48da39c1121', corrP: 'e792005220513b58', corrF: '85284cd307d8e6fb', dominant: '546468ca2b00d9ae',
      share: '0f77aab23a6631db', tMean: '6d936c0a470951f6', precip: '5c9d14ba7d0d5a01', conflicts: '0fd6721bc960364d', plans: '4cb4dd86037d3629',
    },
    'tundra-cool': {
      world: 'bfe25e240527951f', corrT: 'f51046e9ad678e41', corrP: '2c8f49a34bd8a72c', corrF: '85284cd307d8e6fb', dominant: '5cf95bf2dc256a65',
      share: '3d6d4eba96a4d79e', tMean: '8674e60372494327', precip: 'fdf2a84f7a7ca3f8', conflicts: 'f48c82bab083db58', plans: 'f22e8878d4e099d2',
    },
    desert: {
      world: '7064043eac2114c7', corrT: '8082e52b46ac9528', corrP: 'cd49d5d71587c6ad', corrF: '85284cd307d8e6fb', dominant: '8e556e92a83d28dc',
      share: '6e58d3de48e102f6', tMean: '102afbe5c114b443', precip: 'c63e30f82ef1d57a', conflicts: 'b0bea91bc0a0ccae', plans: 'f8c070ed08358ee3',
    },
    override: {
      world: 'f054aabfb48dd1c1', corrT: '22635673f9066b69', corrP: 'ac7c731ee302bcca', corrF: '85284cd307d8e6fb', dominant: 'd332c741c20ab5ee',
      share: '4254f9491c9adb07', tMean: '477ca2cbe7306d6d', precip: 'ff147ebb37956960', conflicts: '89ae6888797a4296', plans: '72f764c37dbd7ea4',
    },
    species: {
      world: '4ac6bd960100d7b6', corrT: '949317a164d6c59a', corrP: 'b6c433d5ee39bf32', corrF: '85284cd307d8e6fb', dominant: 'd332c741c20ab5ee',
      share: '9e8c897e3f103dc8', tMean: '56a3bc58677201ce', precip: '4dba1127bcb7f276', conflicts: '89ae6888797a4296', plans: '511e1d8fb91a4479',
    },
    glow: {
      world: '190345c9b291ddd0', corrT: '0acbc486423f3164', corrP: 'bed23d7ad24ebf3f', corrF: '25e503c966a83770', dominant: '5609080e3ca58ab7',
      share: '12b67ad8d53a4763', tMean: 'b504a65eb80bb397', precip: 'a7b634f79ab300a1', conflicts: '83660887a7c84ebb', plans: 'ecc82bc7ab3e05c6',
    },
    wetland: {
      world: 'd160477740d33822', corrT: 'f5829f8c4f90df32', corrP: 'c40bca833873cb0c', corrF: '66027f15f69faf6e', dominant: '6d3bc3b2dfc2a420',
      share: 'c8ec0e3310facea4', tMean: 'edb1b4535b9cd31c', precip: '73e2b0d8995bd28a', conflicts: 'b4f3131da7b9dfbb', plans: '0987108db28edbe3',
    },
    rain: {
      world: 'a4cf2dcda8a88859', corrT: '785c4f01a119bb50', corrP: 'd681fd3e645f957f', corrF: '0507e9179dd3229c', dominant: 'ec4b028a564123e7',
      share: 'd2401468184cff35', tMean: 'c2774229455085a2', precip: '1ddd02f40d8dcb32', conflicts: 'fba9fdbe403a2ac9', plans: '2e277b91684e12ae',
    },
    odd: {
      world: '3b549ad8719cf5b9', corrT: '7c1d166c1bef3368', corrP: '094f570f0b128b93', corrF: 'b19f2a5b36120a75', dominant: '71782b3b7868e375',
      share: '5dd053b99424a2f0', tMean: '983cc66e63ea34b0', precip: 'bbe19b9fbfa60840', conflicts: '2b0321459b96f929', plans: 'f8edfd77fcb48748',
    },
    edit: {
      world: '696159d38b1f0f45', corrT: '7e1584e20d997592', corrP: 'c67c421b2104ce40', corrF: 'b19f2a5b36120a75', dominant: 'be00b84d036fb773',
      share: '0c979b9049aab364', tMean: '09103ac7b86781a9', precip: '6eb40564360c0961', conflicts: '297cf08ae23b8474', plans: '3b2af578d2cec40f',
    },
    undo: {
      world: '94ba3d8b2b02e554', corrT: 'ee915e3f0e2b89d9', corrP: '84a8406b81b69629', corrF: 'b19f2a5b36120a75', dominant: '576c2be0426888ec',
      share: '62c8d95d9b49f6c3', tMean: '6163f661e439678b', precip: '09d6f6ae5e54115a', conflicts: 'cb32e4129a4a9a34', plans: '2704e4b7d052ad9c',
    },
    replay: {
      world: '94ba3d8b2b02e554',
    },
  },
  planet: {
    forest: {
      world: 'a7b76b1605176ed0', corrT: '0cf0db79ec385454', corrP: 'b7fb778aaab57217', corrF: '85284cd307d8e6fb', dominant: '129d1e976d2fc1cb',
      share: '9e0f6191f3d6f6f4', tMean: '74464b2daba27f3e', precip: '0e9173096c2948bb', conflicts: '93b46778fff1f807', plans: 'c9f7083b1d5c00a5',
    },
    tundra: {
      world: 'dbb7915171bf0beb', corrT: 'ac2c61460e97f603', corrP: 'e7cda5f251f73544', corrF: '85284cd307d8e6fb', dominant: '676547ffdd5c46a3',
      share: 'da2547510367b721', tMean: '720dc812c26d3e7e', precip: '94ac239d8a540f9b', conflicts: 'f586c2e3e14c0049', plans: '968999bd8099e807',
    },
    edit: {
      world: '5a2c9879519329f1', corrT: '00cb2d327d70e8c3', corrP: 'e7cda5f251f73544', corrF: '85284cd307d8e6fb', dominant: '4c48260277d0c234',
      share: '30bef2ebebf2b054', tMean: 'c1198c7c79941447', precip: '9d4494636bd92b79', conflicts: 'f586c2e3e14c0049', plans: '2abaf3bf5aa6f532',
    },
    undo: {
      world: 'dbb7915171bf0beb', corrT: 'ac2c61460e97f603', corrP: 'e7cda5f251f73544', corrF: '85284cd307d8e6fb', dominant: '676547ffdd5c46a3',
      share: 'da2547510367b721', tMean: '720dc812c26d3e7e', precip: '94ac239d8a540f9b', conflicts: 'f586c2e3e14c0049', plans: '968999bd8099e807',
    },
  },
};

describe('约束求解提速后逐值不变', () => {
  it('一块地区：可行、不可行、重叠、硬覆盖、自定义场、扩散不到、编辑与撤销、重放', () => {
    expect(run('region')).toEqual(RECORDED.region);
  });
  it('小星球：可行与不可行、编辑与撤销', () => {
    expect(run('planet')).toEqual(RECORDED.planet);
  });
});
