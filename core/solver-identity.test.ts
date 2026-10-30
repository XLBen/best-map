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
      world: '208cb04201174dc2', corrT: 'd3357954584596e4', corrP: '61c7464091c797a8', corrF: '85284cd307d8e6fb', dominant: 'f0fec132cfcfd068',
      share: '2005527b08887c87', tMean: '28169666575b5442', precip: '07d28cf849b2f8c1', conflicts: '53e1bd998cee1b84', plans: '2abf95d60b628ee6',
    },
    'tundra-warm': {
      world: '127c156402fb7351', corrT: 'b21c3f19c4ddfee1', corrP: '1d4d3ccccefa1dfd', corrF: '85284cd307d8e6fb', dominant: 'e91622af4874ee9d',
      share: '7fc72ab7a2e4b3ef', tMean: 'd68798e71e3da368', precip: 'b908b3df078eb449', conflicts: '3c24227cc64a5db3', plans: '4c57a74d62dd373f',
    },
    'tundra-cool': {
      world: 'd6560b6e87a7cac8', corrT: '95bc7b14b364dec5', corrP: 'cadc82a634396c19', corrF: '85284cd307d8e6fb', dominant: '881cf0bc42f45762',
      share: '4e6f472a0b85309e', tMean: '8388fdb2d84f2010', precip: '96c61ec672319c51', conflicts: '08c3db1e0c3acd6a', plans: '043ae0e7f6c934ce',
    },
    desert: {
      world: '5c4ada50954180ee', corrT: '6c87b329511be774', corrP: '5b33572d305c5115', corrF: '85284cd307d8e6fb', dominant: '74ed527b0435a0b1',
      share: '9c795e5a0c7efe2f', tMean: '20ee25ed6759c076', precip: '547d1b7cd9011b9e', conflicts: 'e2b7639a6a42c334', plans: 'fdbb904462e5d0d5',
    },
    override: {
      world: '2c997e75376fb010', corrT: '7ae46a3552dbed56', corrP: '7c5c8f450d33a179', corrF: '85284cd307d8e6fb', dominant: '518709e84f151eb8',
      share: 'd5d73f280fcd8be7', tMean: 'bffb8fcf3618b971', precip: 'f400a76502ae7c83', conflicts: '0d592cea38347ef5', plans: '7423e0f9f6c274bc',
    },
    species: {
      world: 'e90e75ac23d99361', corrT: '2ce90815d8cfb02a', corrP: '7c5c8f450d33a179', corrF: '85284cd307d8e6fb', dominant: '518709e84f151eb8',
      share: '709309271fca7e2f', tMean: '0bac2e2a6f00fcf7', precip: 'f400a76502ae7c83', conflicts: 'bcf238a7e32d4cac', plans: '8e8636c408385fd9',
    },
    glow: {
      world: '3583d79705b5c4bd', corrT: '931de7355c61eae5', corrP: '39c2cb6459a96626', corrF: 'ce07696c37a2ccea', dominant: '1a474d66d16264ee',
      share: '97ee7de3e0d0d0cf', tMean: '466f3cf2aa994461', precip: 'aaaafb50e4eea75e', conflicts: '47449fa8e8389667', plans: 'da3ec1c7eb2f33f8',
    },
    wetland: {
      world: '6c0a955d467f7fc6', corrT: '56e757d3562f2961', corrP: 'd220a487b4202abf', corrF: 'd08e4569c48add8f', dominant: '2b31dd65a4b3ba8c',
      share: '024b8b16fd69db0d', tMean: '7d9a8e9ccc93fa3e', precip: 'f734e768fada77b2', conflicts: '0ac6a50459babc86', plans: '8e12eea5420f9cb9',
    },
    rain: {
      world: '18b20da7e281bcba', corrT: 'a620b5493144a092', corrP: 'b930492b363dab68', corrF: '8e9cb664e3f4252c', dominant: '630485075e8e987d',
      share: 'a30e36fa97be6886', tMean: '9662f8591a658f2b', precip: '9726c8ef1d00bf78', conflicts: '6e7e1d48c8d44aea', plans: '09aaa9bc863709f6',
    },
    odd: {
      world: 'a253bc95308e0ad5', corrT: '8b48ff67190519bf', corrP: '27b1b0d6e2de1694', corrF: '208835b9c9939f6e', dominant: '1881aaf555352bc2',
      share: '38994f0771ec272b', tMean: 'f145d31c2319c2ef', precip: 'b8b1cc09cc07093e', conflicts: 'cc35a85025fa0a41', plans: 'f631f422c55fbc9e',
    },
    edit: {
      world: '912ae79000efdac5', corrT: '7e17f7e81ba6d2b9', corrP: '96d63bf7ff763a36', corrF: '208835b9c9939f6e', dominant: '6bc2a92d99b84f12',
      share: '9c5c87226b215ff1', tMean: '09f5d59b79055038', precip: 'f5a1751cf08b2a88', conflicts: 'a0679299ffe28c17', plans: '30d60c185bfcb193',
    },
    undo: {
      world: '81d3be476f236bd5', corrT: 'd552714e3eb26253', corrP: 'fddd83150ec409de', corrF: 'ff090978045007e0', dominant: '8e1d9aa4161ae279',
      share: '8fdd3122def4498e', tMean: '2a70b370a3a3154a', precip: 'd3c265c387ad60ae', conflicts: '37a4bec3204fcf73', plans: 'e7f1cc6bf846b85c',
    },
    replay: {
      world: '81d3be476f236bd5',
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
