import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../tools/hash';
import type { SolveResult } from './constraints';
import { Engine } from './engine';
import { graphDistance } from './mesh';

// 约束求解（自然融入）提速后必须逐值不变：可行、不可行、几块设定的修正区重叠、硬覆盖与自然融入混用、
// 自定义场、扩散不到的类型，地区与小星球。每一步之后记下修正场、主导类型、份额等推导数组与求解计划的哈希。
// RECORDED 里的值来自提速之前的代码（c6f1444 的 constraints.ts），不要为了让测试通过而改它们。
// world 一项在第八轮更新过一次：它把地物（derived.features）也算在内，涂出来的生态区有了自己的名字、标注放进地物自己的格里；
// 核对过每一步的 digestWorld 只有 derived.features 一项不同，其余各项一个没变。
// 第九轮去掉旧存档兼容时 world 又更新过一次：星球参数里的洋流强弱、山挡风成了总有的项（小数据的摘要变了）；
// 这里先把山挡风设成 0，所以修正场、份额等各项与提速之前的代码仍然逐值相同
// 第九轮“名字不乱跳”时 world 又更新过一次：编辑之后原有的地物留着原来的名字（小数据里多了 keptNames）。
// 核对过每一步的 digestWorld 只有 derived.features 与 small 两项不同，地物除了名字一个没变；关掉留名字时与原来的值逐值相同

function run(kind: 'region' | 'planet'): Record<string, Record<string, string>> {
  const eng =
    kind === 'planet'
      ? new Engine({ seed: 2, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 })
      : new Engine({ seed: 4, cells: 8000, latNorth: 62, latSouth: 18 });
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
const RECORDED: Record<string, Record<string, Record<string, string>>> = {
  region: {
    forest: {
      world: 'e4f36fbcba51c9b7', corrT: '0086261afeeb3884', corrP: '4502ae844b23767b', corrF: '85284cd307d8e6fb', dominant: '539c1cd6948a2da7',
      share: '12868fad58fe7c84', tMean: '26d297a0a7ba96ce', precip: '45e885e0e3839c46', conflicts: '94acfa42da6cf2eb', plans: '80cfa879f3e25b0a',
    },
    'tundra-warm': {
      world: '560c8f10806b8747', corrT: '0086261afeeb3884', corrP: '4502ae844b23767b', corrF: '85284cd307d8e6fb', dominant: '539c1cd6948a2da7',
      share: '12868fad58fe7c84', tMean: '26d297a0a7ba96ce', precip: '45e885e0e3839c46', conflicts: '7db4b43e3921d3cf', plans: '05a04891519c5752',
    },
    'tundra-cool': {
      world: '407980f93fe41c96', corrT: '1bd8c519693a1685', corrP: '392a4cdb7496d086', corrF: '85284cd307d8e6fb', dominant: '46e54b79b47bce51',
      share: 'c15a751935d90a90', tMean: '85657f1e53e0ba4a', precip: '3ea03dd07ffe613f', conflicts: 'a0d6d56965a9b618', plans: '08dfc6c1c7185937',
    },
    desert: {
      world: 'd9d747080ed048a8', corrT: '7dc3bf8b579e5eaa', corrP: '6e229eeffa545152', corrF: '85284cd307d8e6fb', dominant: '131c0ed9ccfd11c1',
      share: '0d1d195ed72c86f3', tMean: '20ef2c22f94ec7cd', precip: 'c91ec6c181f8f982', conflicts: '70936e46c95b935d', plans: '8e2c251fb5f771e7',
    },
    override: {
      world: '7d4e44d8737aacfd', corrT: 'fa863fdbc9f48518', corrP: '921907d42544e86c', corrF: '85284cd307d8e6fb', dominant: '59bfb2e0a9f1e6af',
      share: 'c0d6792c89c5bdba', tMean: 'cd6746c691df71f1', precip: 'fec0bd15cc0e3550', conflicts: '2564de895d8ba8eb', plans: '146b0c1b9b1fa920',
    },
    species: {
      world: 'b66d54fbf432f5e4', corrT: 'fa863fdbc9f48518', corrP: '921907d42544e86c', corrF: '85284cd307d8e6fb', dominant: '59bfb2e0a9f1e6af',
      share: '3afbc4858eb5afa8', tMean: 'cd6746c691df71f1', precip: 'fec0bd15cc0e3550', conflicts: '2564de895d8ba8eb', plans: '146b0c1b9b1fa920',
    },
    glow: {
      world: 'a03afb68c9171747', corrT: '7b245d73e83a37ce', corrP: 'da7d39b61731d9b2', corrF: 'ac034596dc013f10', dominant: '3bcbec5e74e0aac9',
      share: '264ea5d22e2a3c18', tMean: '0a373a411d8ced30', precip: '98cdfc40e605dd8b', conflicts: '42b9f9f958f368c5', plans: '7ad2257c80f611a2',
    },
    wetland: {
      world: 'fed18482a8102f0e', corrT: 'b8a5ef3784451707', corrP: '8bfce3f4f3e17486', corrF: '4bae77c8c3f5e99c', dominant: '211d56d245f2aa48',
      share: '908d7db1d97d3961', tMean: '9c23a08f1dbf7157', precip: '7fc735678f156424', conflicts: '3abdba45db58d89a', plans: 'dcdaa02ebc3ba834',
    },
    rain: {
      world: '14af583596ef1875', corrT: 'd4d752795828accc', corrP: '83492b93ebf6eb86', corrF: 'cb760725ee677c6e', dominant: 'ca58704f87f4d04b',
      share: '11bea4dc6ce74526', tMean: '7c31e5b99a9ac39e', precip: '4553e598c9ac29f7', conflicts: 'e17c8bc852db7462', plans: '5bda7b79d5d32841',
    },
    odd: {
      world: '011140258637e39c', corrT: '36d999153f863275', corrP: '2c7fb7e6147b9a8b', corrF: 'f4068e0f0077ca15', dominant: '7d38c6ea37160634',
      share: 'ffcf0663a5d0db8d', tMean: '8f9973c2fca61f58', precip: '5a3cf1b70c3f7a11', conflicts: '98b23434caa9f91c', plans: '0a0cd2ebdf000efd',
    },
    edit: {
      world: '624636f9858835c8', corrT: '3c2ed87aa30cf511', corrP: '92b83effaf4e01e4', corrF: 'f4068e0f0077ca15', dominant: '7d29f1f26a0499ae',
      share: '7abc428d226e5ac1', tMean: '7cbd5b816b7207a0', precip: '249b36b8b80962d1', conflicts: 'f97393e2e4d2b7b9', plans: 'ae49af583851baa9',
    },
    undo: {
      world: 'd64641510b6ca9ac', corrT: '1a34dcdba0189845', corrP: '84818e37f27eac52', corrF: 'ee9a947014ac5a9a', dominant: 'b95a854b02895b86',
      share: '6e72dc14247d61a7', tMean: '1c20824fd5e92f37', precip: 'd0ee368b7d073db8', conflicts: '841f87b572541a7f', plans: '636ecd489d185d1f',
    },
    replay: { world: 'd64641510b6ca9ac' },
  },
  planet: {
    forest: {
      world: 'f5da8eb28d5ae859', corrT: '3c1b8f10322aa19d', corrP: 'dea1ffa116f7e973', corrF: '85284cd307d8e6fb', dominant: '825674fe213b6128',
      share: 'd6b36847f680ed7c', tMean: '86dbc46d1370d9bd', precip: '5b291974b5c5aac0', conflicts: 'e5fc81d757c50eac', plans: 'af24491f2527f84f',
    },
    tundra: {
      world: 'e2cac9ea07e45e26', corrT: '7f79337cb113b1eb', corrP: '7907161661752584', corrF: '85284cd307d8e6fb', dominant: '84e601ee755c8484',
      share: 'e4ec5e234f389bcf', tMean: '8c90128a480d374b', precip: 'fc0f99b6415fdc1e', conflicts: '7d24fe321aea85dd', plans: '0d932eaa7efbb040',
    },
    edit: {
      world: '24009af24030278a', corrT: '7f79337cb113b1eb', corrP: '7907161661752584', corrF: '85284cd307d8e6fb', dominant: 'd7fcf1af64209f14',
      share: '2749c8f8d823df07', tMean: '8c90128a480d374b', precip: '211d08601c7dfbad', conflicts: '7d24fe321aea85dd', plans: '0d932eaa7efbb040',
    },
    undo: {
      world: 'e2cac9ea07e45e26', corrT: '7f79337cb113b1eb', corrP: '7907161661752584', corrF: '85284cd307d8e6fb', dominant: '84e601ee755c8484',
      share: 'e4ec5e234f389bcf', tMean: '8c90128a480d374b', precip: 'fc0f99b6415fdc1e', conflicts: '7d24fe321aea85dd', plans: '0d932eaa7efbb040',
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
