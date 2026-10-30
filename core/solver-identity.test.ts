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
      world: 'd0708762b7a159df', corrT: 'abda72c992434b3d', corrP: '04b31111672b799e', corrF: '85284cd307d8e6fb', dominant: '11cbc04ca4223aec',
      share: 'eb8d79f897791664', tMean: '2b1ab367c5be06c2', precip: '45f1b4ddcdef39e7', conflicts: '53e1bd998cee1b84', plans: '4110feab0b887d69',
    },
    'tundra-warm': {
      world: '99b01f4795368ad5', corrT: 'ea0452e1bbd12b75', corrP: '99740f530ff774ec', corrF: '85284cd307d8e6fb', dominant: 'a282e8a1d570d1c3',
      share: 'b5a770d918084e46', tMean: '4295166435883ad4', precip: 'debc88b75494e2e3', conflicts: '6ab5c31737fbefb8', plans: '09da45197cb62d51',
    },
    'tundra-cool': {
      world: '08fd84e0a8654991', corrT: '6e7ceb93e6858628', corrP: 'd2d76db95d6bdb4a', corrF: '85284cd307d8e6fb', dominant: '4ff93c435d75e734',
      share: '030feaa9c7e762fc', tMean: '47b6a8cbb9196830', precip: '6431ed0b9d1634ec', conflicts: 'e58d3f753310c34f', plans: '4c9e7f3a5bed6323',
    },
    desert: {
      world: 'c746aeacada5bc65', corrT: 'bde50008b394a320', corrP: '3ed770f8371c543d', corrF: '85284cd307d8e6fb', dominant: '50eb7c731bdd5d96',
      share: 'f8c4045c236a7cef', tMean: '278f23403d7040e0', precip: '2b6b4f561d3a4d65', conflicts: '776103fb6b5110e9', plans: '3db645b05a12056d',
    },
    override: {
      world: '53cbbef28c2febed', corrT: 'be2673359867c044', corrP: '191f2d6c082b922c', corrF: '85284cd307d8e6fb', dominant: 'cf8a367d7b36cfa5',
      share: '505df5018c709acf', tMean: '83a5c657b162c857', precip: '79048a7d6a27c575', conflicts: '7f84a04c5fa1a664', plans: 'f86adc87c58202fb',
    },
    species: {
      world: '9de640c72bd636a9', corrT: 'd8fabf523b7ca636', corrP: '191f2d6c082b922c', corrF: '85284cd307d8e6fb', dominant: 'cf8a367d7b36cfa5',
      share: 'd5572363ace42b38', tMean: '67d49a3fb4505d4b', precip: '79048a7d6a27c575', conflicts: 'b346238e201a60de', plans: 'ab668bbfe1a2e094',
    },
    glow: {
      world: '77d191661d4a6377', corrT: 'c165747b82e4beb9', corrP: 'fb8337abe0c9d1eb', corrF: '1970c90f878861bd', dominant: '440f58c7936d49d9',
      share: 'aa8e1c00c6b628a4', tMean: '1444d99c673d6da8', precip: 'ed3d2b192d0e4ad7', conflicts: '180326a4416939ff', plans: 'f95380f3beb9e175',
    },
    wetland: {
      world: '17efe87d122490fd', corrT: '02b2966f84166d6d', corrP: 'c43a808f37952a0d', corrF: 'aeb38f08200b8d35', dominant: 'bef365d343dd1ff3',
      share: '2ca199d3c6198fba', tMean: '116275ff021f3d80', precip: '07c315a978934815', conflicts: '2cad059d4b765029', plans: 'ca3c218906139067',
    },
    rain: {
      world: '1117e5217c77eb6b', corrT: '6f6ac8b84e3f2ee0', corrP: 'e8c9b891b111a5f6', corrF: 'd250c475f110a6b3', dominant: '27d68a4f7e1b77e1',
      share: 'f4900f89a8e56669', tMean: '045d169a9a9fe21d', precip: '61c86e059b2f205d', conflicts: 'fb8d83d8c76d84ad', plans: 'a7fe12ab94a29e35',
    },
    odd: {
      world: '6a338a0d3310f0b9', corrT: '87951fa5269452a0', corrP: '85d2179d44f47122', corrF: 'ecc7af9ffa4fc353', dominant: '42df92f5583b9f3a',
      share: '4c0549832eea295c', tMean: 'a3df6bc15c31513b', precip: '90065af96e652704', conflicts: '7408b352670ad434', plans: '964ebe09c92dde50',
    },
    edit: {
      world: '692607232ae74e54', corrT: '6ebbfd13cf44c429', corrP: '24b01cfcb53f49d5', corrF: 'ecc7af9ffa4fc353', dominant: '70bfb405e52d5149',
      share: '70fe68dc25c98489', tMean: '8984523dc7d35513', precip: '2805900b6386cd2b', conflicts: 'f52e266c4d9d2051', plans: 'c81fda02c48eca13',
    },
    undo: {
      world: 'b9e0377e9b57ed27', corrT: '09c55ba3e7c1a761', corrP: '9648d13f1c82949c', corrF: '67396fa4d66bb973', dominant: '5927fb26862dce38',
      share: '1a24b92f3abbf3cf', tMean: '61f49bc7578b28d1', precip: '54cec5bfe7250d52', conflicts: '81e940c3970ffe71', plans: 'c12e0cdeda1487b7',
    },
    replay: {
      world: 'b9e0377e9b57ed27',
    },
  },
  planet: {
    forest: {
      world: 'aa0d824c063c4fc8', corrT: '3895dd181e3f6062', corrP: 'dbbaaa0979262823', corrF: '85284cd307d8e6fb', dominant: '0642f5273cb8f178',
      share: '5dbcc8c6810206ef', tMean: 'e2c63ffebab5e098', precip: 'c9fdc1e7bca5afe8', conflicts: 'e141914ab8e60179', plans: '5bee5d8056770be8',
    },
    tundra: {
      world: 'fb643a54fa0a2d88', corrT: '388b96f51db69ef9', corrP: '666ab5e4ce20746c', corrF: '85284cd307d8e6fb', dominant: 'b8e5db964918af6d',
      share: '13aaa5f8a935539e', tMean: '8505ef2d37e2164f', precip: '5d50eeaa64138f45', conflicts: '71912374dab09249', plans: '23e1204df0e13209',
    },
    edit: {
      world: '06d4c2f2e5f63a89', corrT: 'd86bbc0d2dcf7594', corrP: 'f9349618bc03e000', corrF: '85284cd307d8e6fb', dominant: 'bbe2c94deab6fd12',
      share: '6f64ec758ca26ffa', tMean: '808daa66bca2ba21', precip: 'bc076742d81178bd', conflicts: '865bd8404447f2db', plans: '2020ec8845a59e00',
    },
    undo: {
      world: 'fb643a54fa0a2d88', corrT: '388b96f51db69ef9', corrP: '666ab5e4ce20746c', corrF: '85284cd307d8e6fb', dominant: 'b8e5db964918af6d',
      share: '13aaa5f8a935539e', tMean: '8505ef2d37e2164f', precip: '5d50eeaa64138f45', conflicts: '71912374dab09249', plans: '23e1204df0e13209',
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
