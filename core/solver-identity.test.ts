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
const RECORDED: Record<string, Record<string, Record<string, string>>> = {
  region: {
    forest: {
      world: '851f7a1b0259871f', corrT: '6f0a7f854d9a9180', corrP: 'ee06b1d4204512b6', corrF: '85284cd307d8e6fb', dominant: 'acf5892386d19c03',
      share: '3e8225dae5e06413', tMean: 'f63b4f360322e697', precip: 'c32127b92f6b78f8', conflicts: 'fd07a038b1d387aa', plans: '97771c0f354e492f',
    },
    'tundra-warm': {
      world: 'd4a251f983ad508a', corrT: '14125c24be4129c2', corrP: '701399b75dfda70e', corrF: '85284cd307d8e6fb', dominant: 'a25d145b1b1763be',
      share: '0cdd211d20dfbcca', tMean: '04d7c17f3d835e48', precip: '95fe931984c59e2e', conflicts: 'f0be2a2128e46940', plans: '5f1856145401f920',
    },
    'tundra-cool': {
      world: '380f5ca1b6b28b40', corrT: 'e411843107ec2ce5', corrP: '00c64da7a98869a4', corrF: '85284cd307d8e6fb', dominant: 'cc1fe5b71242db42',
      share: '154c3ef891188678', tMean: '064d0adf4bcf5d51', precip: '31b7d99213a02ae6', conflicts: 'e884af448dc73025', plans: 'a4fd270d48ae08e0',
    },
    desert: {
      world: '2dda7375df88ffb2', corrT: 'a8647252999c24a7', corrP: 'ade7db1352e4bd51', corrF: '85284cd307d8e6fb', dominant: 'c6ec6d0eef54cbf5',
      share: 'db01f60f84a00a18', tMean: '395a2726b5283aad', precip: '3b4e38b60f031569', conflicts: 'e884af448dc73025', plans: 'cb640f0d55a4c584',
    },
    override: {
      world: '602fd32d0e3bc939', corrT: '6dca259622da75bd', corrP: '1d3272a879fb9de9', corrF: '85284cd307d8e6fb', dominant: '6769b45aab9edcc0',
      share: '7fbcb0c01b7a7d2c', tMean: 'b625d3d522318d25', precip: '2f54392b65dabd48', conflicts: '5e161b9d447f5658', plans: '2fbe410a2e24eb82',
    },
    species: {
      world: '1720d06ded43c9bd', corrT: 'ce600e861debb8a0', corrP: 'ad4dc864145e8e60', corrF: '85284cd307d8e6fb', dominant: '6769b45aab9edcc0',
      share: '9e8f52f78cde5481', tMean: '6ac5b79eff4b74ba', precip: 'fb5e8e1c1ad26b35', conflicts: '5e161b9d447f5658', plans: 'c65a0f0ef59f455d',
    },
    glow: {
      world: '58103a30ca89b0e1', corrT: 'b16e12880bfbb211', corrP: '6c5b743343ba7c43', corrF: '520088a8dfba1bca', dominant: '3d71db1cf52fff59',
      share: '49c68d61cc61eee3', tMean: 'fa362367988538f0', precip: 'cd9215d624cf1c8a', conflicts: 'c6b58b3f518c2313', plans: 'a55b5c61dc168215',
    },
    wetland: {
      world: '3b5ed50152621df2', corrT: '4ae05b5c2b4f3c93', corrP: '88c8ae516f375a6e', corrF: 'f2ad74180a3d9b97', dominant: '732e8084e976b737',
      share: '7bd872bfafd09780', tMean: '5f4dd988bba2192c', precip: '91d106df8f8ad102', conflicts: 'c861917671589d65', plans: '251d89f23ef2bf0a',
    },
    rain: {
      world: '65ff993a0a11aa5f', corrT: 'fe7be874dc587a24', corrP: 'f6615aca2d058566', corrF: '7f570ed1e47e9eb0', dominant: '4c982f0bb5dbc3a1',
      share: 'a59d1633715f09bb', tMean: '2eba2378133e7010', precip: 'e9cec3f3a6899c36', conflicts: '6dedaf96cb2c9b77', plans: '249a97bab3e20985',
    },
    odd: {
      world: '9fd46a366e737644', corrT: '3a2b3b408a054624', corrP: '194ff36b4f7217e5', corrF: '2d6db7a750e68cd2', dominant: 'ff434cf28c944edc',
      share: '05ace23f52930a22', tMean: 'a42c913abcd85195', precip: '80cae6ec64044fda', conflicts: 'ec3469c20fa617ab', plans: '99090dec921952cb',
    },
    edit: {
      world: '2c9dbd5cc760a6df', corrT: '3447a6ba96ef8099', corrP: 'aaf97b510a64a3cb', corrF: 'd76c39067e461d3c', dominant: '633593584d7565d2',
      share: '1830d4c7ffe5a63b', tMean: '17db70838739d504', precip: '0c93d56dfddc40e2', conflicts: '53c7c8b931225a65', plans: 'a6a0fc203b865b86',
    },
    undo: {
      world: '18cebfaa4f23fef6', corrT: 'ba883aa8b78e5052', corrP: '0474a39536e87ad5', corrF: '0e8819fb17ffb541', dominant: '67d1e27b5b67d6dd',
      share: '9004ee4ab072ed53', tMean: '490b9e4b87a6228f', precip: 'e4a0b6b48c09da67', conflicts: '417235ad1055a494', plans: '2e754b207d849ccd',
    },
    replay: {
      world: '18cebfaa4f23fef6',
    },
  },
  planet: {
    forest: {
      world: 'f892b87c3d290045', corrT: '92eac1da9f93e901', corrP: '1c005872f9018b79', corrF: '85284cd307d8e6fb', dominant: 'a1edb17d86217e2a',
      share: 'fbc0c634e6477efa', tMean: '31c4a321b53008ed', precip: '52fb673c1f3271f0', conflicts: '7bad2dbb4eeb772d', plans: '19c4b8fac8582f06',
    },
    tundra: {
      world: 'dbaed0b391b5653f', corrT: '1fc6b422775a24a6', corrP: '363bd8e8afa60183', corrF: '85284cd307d8e6fb', dominant: '9a41c8cc618448f8',
      share: '912ece84c7a4d061', tMean: 'abe1c68c612d3dfb', precip: '4631d10a4ac68d22', conflicts: 'f7cd85a3f40c676d', plans: '299884056fac5d26',
    },
    edit: {
      world: 'cb663d9359ed7024', corrT: 'a29157edb70dfb90', corrP: '81d1a3191aa5951b', corrF: '85284cd307d8e6fb', dominant: '84208303adc0364b',
      share: '442255bf0841bdf9', tMean: 'd943f8b1330c7f78', precip: '95c4e763c6694738', conflicts: '6f68d03c5bcf7bf4', plans: '2b90535bf97b53f7',
    },
    undo: {
      world: 'dbaed0b391b5653f', corrT: '1fc6b422775a24a6', corrP: '363bd8e8afa60183', corrF: '85284cd307d8e6fb', dominant: '9a41c8cc618448f8',
      share: '912ece84c7a4d061', tMean: 'abe1c68c612d3dfb', precip: '4631d10a4ac68d22', conflicts: 'f7cd85a3f40c676d', plans: '299884056fac5d26',
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
