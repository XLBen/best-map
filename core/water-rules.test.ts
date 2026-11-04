import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { Engine } from './engine';
import { lakeParts, lakeShores, typeLakes } from './lake-types';
import { FANTASY_BIOMES, fantasyBiomeCommands } from './packs/fantasy-biomes';
import { ruleTypeOf } from './river-edit';
import { RIVER_SEGMENT_MIN, mergeShortRuns } from './river-segments';
import { PLAIN_RIVER, riverNet, stopCells, typeRivers } from './river-types';
import { smoothCourse, traceRivers } from './rivers';
import { HEIGHT_MAX, type Species } from './species';
import { dryContinents as continents } from './testing/fixtures';
import { baseBiomes, vegetationStats } from './vegetation';
import { PLAIN_TYPE, WHEN_RANGE, type WaterType, hasWhen, matchesNaturally, waterPlan, waterPlanDebug, waterRules } from './water-types';
import { setWaterAllowed, setWaterBlock, waterAllowed } from './water-table';
import type { World } from './world';

// 水系规则（第五十六轮）：河按段定类型、声明式条件、允许表、换类型 / 断流、湖的规则、不多算一遍植被

const replayDigest = (eng: Engine) => digestWorld(Engine.fromDoc(eng.toDoc(), eng.world.mesh).world);

// 一条假的河：cells 从源头往下，每格的生态、高度、坡度、气温、流量可以指定。perm：格的编号怎么打乱（查和编号无关）
interface Spot {
  biome?: number;
  h?: number;
  s?: number;
  t?: number;
  q?: number;
}
const SPECIES = ['a', 'b', 'c', 'd'].map((id) => ({ id, tolerances: [] })) as unknown as Species[];

function chain(spots: readonly Spot[], types: readonly WaterType[], opts: { perm?: number[]; species?: Species[]; guides?: unknown[] } = {}) {
  const n = spots.length;
  const id = opts.perm ?? spots.map((_, k) => k);
  const fill = (f: (s: Spot, k: number) => number, Arr: Float32ArrayConstructor = Float32Array) => {
    const out = new Arr(n);
    spots.forEach((s, k) => (out[id[k]] = f(s, k)));
    return out;
  };
  const receiver = new Int32Array(n).fill(-1);
  spots.forEach((_, k) => (receiver[id[k]] = k + 1 < n ? id[k + 1] : -1));
  const d = {
    lake: new Uint8Array(n),
    discharge: fill((s, k) => s.q ?? 200 + k),
    receiver,
    elevation: fill((s) => s.h ?? 100),
    slope: fill((s) => s.s ?? 1),
    tMean: fill((s) => s.t ?? 10),
  };
  const biomes = new Int16Array(n);
  spots.forEach((s, k) => (biomes[id[k]] = s.biome ?? 0));
  const world = {
    mesh: { n },
    causes: { land: new Uint8Array(n).fill(1) },
    small: { species: opts.species ?? SPECIES, riverTypes: types, guides: opts.guides ?? [], planet: { riverThreshold: 150 }, lakes: [] },
    derived: d,
  } as unknown as World;
  return { world, d: d as unknown as World['derived'], biomes, id };
}

// 跑一遍，按河上的先后取回类型
function runChain(c: ReturnType<typeof chain>): number[] {
  typeRivers(c.world, c.d, 1, c.biomes);
  return c.id.map((i) => c.d.riverType![i]);
}

const inBiome = (runs: [number, number][]): Spot[] => runs.flatMap(([biome, len]) => Array.from({ length: len }, () => ({ biome })));
const T = (id: string, more: Partial<WaterType> = {}): WaterType => ({ id, name: id, color: '#336699', natural: true, ...more });

describe('分段：短段并进相邻的段', () => {
  const merged = (seq: number[], fixed?: number[]) => {
    const labels = Uint8Array.from(seq);
    const cells = seq.map((_, k) => k);
    mergeShortRuns(labels, cells, fixed ? Uint8Array.from(seq, (_, k) => (fixed.includes(k) ? 1 : 0)) : null);
    return Array.from(labels);
  };

  it('短于一定长度的段并进较长的邻居；够长的不动；整条河太短时并成一段', () => {
    expect(RIVER_SEGMENT_MIN).toBe(4);
    expect(merged([1, 1, 1, 1, 2, 3, 3, 3, 3, 3])).toEqual([1, 1, 1, 1, 3, 3, 3, 3, 3, 3]);
    expect(merged([1, 1, 1, 1, 2, 2, 2, 2])).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(new Set(merged([1, 2, 1, 2])).size).toBe(1);
    expect(new Set(merged([1, 2, 3])).size).toBe(1);
    // 一样长取上游的
    expect(merged([1, 1, 1, 1, 2, 2, 3, 3, 3, 3])).toEqual([1, 1, 1, 1, 1, 1, 3, 3, 3, 3]);
    // 并完两边相同的连起来
    expect(merged([1, 1, 1, 2, 1, 1, 1])).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('选了类型的河道不会被并走，别的段可以并进它', () => {
    expect(merged([1, 1, 1, 1, 2, 3, 3, 3, 3], [4])).toEqual([1, 1, 1, 1, 2, 3, 3, 3, 3]);
    expect(merged([1, 2, 3, 3, 3, 3], [0])).toEqual([1, 3, 3, 3, 3, 3]);
    expect(merged([1, 2, 3], [0, 2])).toEqual([1, 1, 3]);
  });

  it('一条河穿过几种生态得到几段：短的并进去，流量、河道不动；和格的编号无关', () => {
    const types = [T('ra', { biomes: ['a'] }), T('rb', { biomes: ['b'] }), T('rc', { biomes: ['c'] }), T('rd', { biomes: ['d'] })];
    // a 6 格、b 2 格（太短）、c 8 格、d 4 格
    const spots = inBiome([
      [0, 6],
      [1, 2],
      [2, 8],
      [3, 4],
    ]);
    const plain = chain(spots, types);
    const got = runChain(plain);
    expect(got).toEqual([...Array(6).fill(1), ...Array(10).fill(3), ...Array(4).fill(4)]);
    // 打乱格的编号十次
    const n = spots.length;
    for (let t = 0; t < 10; t++) {
      const perm = Array.from({ length: n }, (_, k) => k);
      for (let k = n - 1; k > 0; k--) {
        const j = (k * 7919 + t * 104729 + 13) % (k + 1);
        [perm[k], perm[j]] = [perm[j], perm[k]];
      }
      expect(runChain(chain(spots, types, { perm }))).toEqual(got);
    }
  });

  it('结果确定：跑两遍逐值相同，世界上的类型只在河格上有', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: T('high', { when: { height: { low: 1000, high: HEIGHT_MAX } } }) as never });
    const first = w.derived.riverType!.slice();
    typeRivers(w, w.derived, 1, baseBiomes(w, w.derived));
    expect(Array.from(w.derived.riverType!)).toEqual(Array.from(first));
    const { isRiver } = riverNet(w, w.derived);
    for (let i = 0; i < w.mesh.n; i++) if (!isRiver[i]) expect(first[i]).toBe(0);
    expect(first.some((v) => v === 1)).toBe(true);
    // 每条河上除了整条河都很短的，段都不短于一定长度（头尾的段也是）
    for (const cells of riverNet(w, w.derived).stems) {
      let run = 1;
      for (let q = 1; q <= cells.length; q++) {
        if (q < cells.length && first[cells[q]] === first[cells[q - 1]]) run++;
        else {
          if (run < cells.length) expect(run).toBeGreaterThanOrEqual(RIVER_SEGMENT_MIN);
          run = 1;
        }
      }
    }
  });
});

describe('声明式条件', () => {
  const stretch = (key: 'h' | 's' | 't' | 'q', lo: number, hi: number): Spot[] => [...Array.from({ length: 6 }, () => ({ [key]: lo })), ...Array.from({ length: 6 }, () => ({ [key]: hi }))];

  it('高度、坡度、气温、流量每一项；只写一头、到两头是不限', () => {
    const cases: [keyof NonNullable<WaterType['when']>, 'h' | 's' | 't' | 'q', number, number, { low: number; high: number }][] = [
      ['height', 'h', 200, 2000, { low: 1000, high: WHEN_RANGE.height.hi }],
      ['slope', 's', 1, 30, { low: 10, high: WHEN_RANGE.slope.hi }],
      ['temp', 't', -10, 20, { low: 0, high: WHEN_RANGE.temp.hi }],
      ['flow', 'q', 200, 3000, { low: 1000, high: WHEN_RANGE.flow.hi }],
    ];
    for (const [key, field, lo, hi, range] of cases) {
      const types = [T('x', { when: { [key]: range } })];
      expect(runChain(chain(stretch(field, lo, hi), types)), key).toEqual([...Array(6).fill(0), ...Array(6).fill(1)]);
      // 上限：反过来
      const below = [T('x', { when: { [key]: { low: WHEN_RANGE[key].lo, high: (lo + hi) / 2 } } })];
      expect(runChain(chain(stretch(field, lo, hi), below)), key).toEqual([...Array(6).fill(1), ...Array(6).fill(0)]);
    }
  });

  it('几项同时要满足；全是“不限”的不算条件；只改条件的类型自然生成才算', () => {
    const spots: Spot[] = [...Array.from({ length: 6 }, () => ({ h: 2000, t: 20 })), ...Array.from({ length: 6 }, () => ({ h: 2000, t: -5 }))];
    expect(runChain(chain(spots, [T('x', { when: { height: { low: 1000, high: 9000 }, temp: { low: -40, high: 0 } } })]))).toEqual([...Array(6).fill(0), ...Array(6).fill(1)]);
    const open = { height: { low: 0, high: 9000 } };
    expect(hasWhen({ when: open })).toBe(false);
    expect(matchesNaturally(T('x', { when: open }))).toBe(false);
    expect(runChain(chain(spots, [T('x', { when: open })]))).toEqual(Array(12).fill(0));
    expect(runChain(chain(spots, [T('x', { natural: false, when: { temp: { low: 0, high: 35 } } })]))).toEqual(Array(12).fill(0));
    expect(WHEN_RANGE.height.hi).toBe(HEIGHT_MAX);
  });

  it('真的世界：高的地方的河是这一种，同一条河下游不是（不往下传）；重放一致', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: T('high', { when: { height: { low: 800, high: 9000 } } }) as never });
    const rt = w.derived.riverType!;
    let mixed = 0;
    for (const cells of riverNet(w, w.derived).stems) if (rt[cells[0]] === 1 && rt[cells[cells.length - 1]] === 0) mixed++;
    expect(mixed).toBeGreaterThan(0);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
  });
});

describe('旧的 match 脚本和新条件同时存在时', () => {
  const src = (v: boolean) => ({ match: { api: 1 as const, src: `return ${v};` } });
  const hot = { temp: { low: 15, high: 35 } };
  const cold = { temp: { low: -40, high: 5 } };
  const spots: Spot[] = [...Array.from({ length: 6 }, () => ({ t: 20 })), ...Array.from({ length: 6 }, () => ({ t: 10 })), ...Array.from({ length: 6 }, () => ({ t: 0 }))];

  it('一种类型同时写了脚本和条件：脚本说是的河才看条件', () => {
    expect(runChain(chain(spots, [T('x', { scripts: src(true), when: hot })]))).toEqual([...Array(6).fill(1), ...Array(12).fill(0)]);
    expect(runChain(chain(spots, [T('x', { scripts: src(false), when: hot })]))).toEqual(Array(18).fill(0));
  });

  it('按类型的先后：前面的说了算，整条河的脚本和按格的条件一样', () => {
    // 按格的在前：它的格不变，别的格是脚本那一种
    expect(runChain(chain(spots, [T('x', { when: hot }), T('y', { scripts: src(true) })]))).toEqual([...Array(6).fill(1), ...Array(12).fill(2)]);
    // 整条河的脚本在前：整条河都是它
    expect(runChain(chain(spots, [T('y', { scripts: src(true) }), T('x', { when: hot })]))).toEqual(Array(18).fill(1));
    // 脚本说不是，后面的条件照看
    expect(runChain(chain(spots, [T('y', { scripts: src(false) }), T('x', { when: cold })]))).toEqual([...Array(12).fill(0), ...Array(6).fill(2)]);
  });

  it('选了类型的河道最优先：不按条件，也不并走；普通的河道一样', () => {
    const guides = [{ id: 'g', cells: [6, 7, 8, 9, 10, 11], end: 'sink', type: 'y' }];
    const got = runChain(chain(spots, [T('x', { when: { temp: { low: -40, high: 35 } , height: { low: 50, high: 9000 } } }), T('y', { natural: false })], { guides }));
    expect(got).toEqual([...Array(6).fill(1), ...Array(6).fill(2), ...Array(6).fill(1)]);
    const plain = [{ id: 'g', cells: [6, 7, 8, 9, 10, 11], end: 'sink', type: PLAIN_RIVER }];
    expect(runChain(chain(spots, [T('x', { when: { height: { low: 50, high: 9000 } } })], { guides: plain }))).toEqual([...Array(6).fill(1), ...Array(6).fill(0), ...Array(6).fill(1)]);
  });
});

describe('允许表', () => {
  const noPlain = (id: string, more: Partial<Species> = {}) => SPECIES.map((s) => (s.id === id ? { ...s, plainRiver: false, ...more } : s));

  it('普通的河也是一行：不允许时换成这一列第一种允许的；一种都没有时照旧', () => {
    const spots = inBiome([
      [0, 6],
      [1, 6],
      [2, 6],
    ]);
    const types = [T('off', { natural: false }), T('only-c', { biomes: ['c'], when: { height: { low: 5000, high: 9000 } } }), T('any', { when: { height: { low: 5000, high: 9000 } } })];
    // b 不允许普通的河。off 没有自然生成不算，only-c 不在 b；any 条件不满足也算（这里只有它允许）
    expect(runChain(chain(spots, types, { species: noPlain('b') }))).toEqual([...Array(6).fill(0), ...Array(6).fill(3), ...Array(6).fill(0)]);
    // c 不允许普通的河：only-c 排在 any 前面
    expect(runChain(chain(spots, types, { species: noPlain('c') }))).toEqual([...Array(6).fill(0), ...Array(6).fill(0), ...Array(6).fill(2)]);
    // 一种都没有：照旧是普通的河
    const none = [T('off', { natural: false }), T('only-c', { biomes: ['c'] })];
    expect(runChain(chain(spots, none, { species: noPlain('b') }))).toEqual([...Array(6).fill(0), ...Array(6).fill(0), ...Array(6).fill(2)]);
  });

  it('条件满足的优先于第一种允许的；列了生态的类型在别的生态里不算', () => {
    const spots: Spot[] = [...Array.from({ length: 6 }, () => ({ biome: 1, h: 2000 })), ...Array.from({ length: 6 }, () => ({ biome: 1, h: 100 }))];
    const types = [T('first', { natural: true, biomes: ['a', 'b'], when: { height: { low: 5000, high: 9000 } } }), T('tall', { when: { height: { low: 1000, high: 9000 } } })];
    expect(runChain(chain(spots, types, { species: noPlain('b') }))).toEqual([...Array(6).fill(2), ...Array(6).fill(1)]);
    const inA = inBiome([
      [0, 6],
      [1, 6],
    ]);
    expect(runChain(chain(inA, [T('bb', { biomes: ['b'] })]))).toEqual([...Array(6).fill(0), ...Array(6).fill(1)]);
    // 空的列表：哪里都不行
    expect(runChain(chain(inA, [T('bb', { biomes: [] })]))).toEqual(Array(12).fill(0));
    expect(matchesNaturally(T('bb', { biomes: [] }))).toBe(true);
  });

  it('带类型的河道传下来的，这里不允许这种：换回普通的河', () => {
    const spots = inBiome([
      [0, 6],
      [1, 6],
    ]);
    const guides = [{ id: 'g', cells: [0, 1, 2, 3, 4, 5], end: 'sink', type: 'x' }];
    expect(runChain(chain(spots, [T('x', { natural: false })], { guides }))).toEqual(Array(12).fill(1));
    expect(runChain(chain(spots, [T('x', { natural: false, biomes: ['a'] })], { guides }))).toEqual([...Array(6).fill(1), ...Array(6).fill(0)]);
  });

  it('两边读写的是同一份：生态页改的河湖页看得到，反过来也是；数据只存一处', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: T('r') as never });
    eng.exec({ op: 'set_lake_type', type: T('l') as never });
    const small = () => w.small;
    const sp = () => w.small.species.find((s) => s.id === 'desert')!;
    expect(waterAllowed(small(), sp(), 'river', 'r')).toBe(true);
    expect(waterAllowed(small(), sp(), 'river', PLAIN_TYPE)).toBe(true);
    // 没列生态的一行：取消一格后列出别的所有生态
    eng.exec(setWaterAllowed(small(), 'desert', 'river', 'r', false)!);
    expect(waterAllowed(small(), sp(), 'river', 'r')).toBe(false);
    expect(small().riverTypes![0].biomes).toEqual(small().species.map((s) => s.id).filter((id) => id !== 'desert'));
    expect(waterAllowed(small(), small().species.find((s) => s.id === 'tundra')!, 'river', 'r')).toBe(true);
    // 打回来：又是省略
    eng.exec(setWaterAllowed(small(), 'desert', 'river', 'r', true)!);
    expect(small().riverTypes![0].biomes).toBeUndefined();
    expect(setWaterAllowed(small(), 'desert', 'river', 'r', true)).toBeNull();
    // 普通的河、普通的湖在生态上
    eng.exec(setWaterAllowed(small(), 'desert', 'river', PLAIN_TYPE, false)!);
    eng.exec(setWaterAllowed(small(), 'desert', 'lake', PLAIN_TYPE, false)!);
    expect([sp().plainRiver, sp().plainLake]).toEqual([false, false]);
    expect(waterAllowed(small(), sp(), 'lake', PLAIN_TYPE)).toBe(false);
    eng.exec(setWaterAllowed(small(), 'desert', 'river', PLAIN_TYPE, true)!);
    expect('plainRiver' in sp()).toBe(false);
    // 一行全取消：空的列表
    for (const s of [...small().species]) {
      const c = setWaterAllowed(small(), s.id, 'lake', 'l', false);
      if (c) eng.exec(c);
    }
    expect(small().lakeTypes![0].biomes).toEqual([]);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    // 选“断流”同时取消普通河；换回去不动勾
    eng.exec(setWaterBlock(small(), 'desert', 'stop')!);
    expect([sp().waterBlock, sp().plainRiver]).toEqual(['stop', false]);
    eng.exec(setWaterBlock(small(), 'desert', 'swap')!);
    expect([sp().waterBlock, sp().plainRiver]).toEqual([undefined, false]);
  });
});

// 这几层在换类型、断流时都不变
const COURSE = ['elevation', 'receiver', 'drainArea', 'basin', 'slope', 'wetness', 'tMean', 'precip'] as const;
const arr = (w: World, k: string) => Array.from((w.derived as unknown as Record<string, Float32Array>)[k]);

describe('换类型：河道和水量不变', () => {
  it('高程、流向、汇水、径流逐值相同，只有河的类型变', () => {
    const eng = continents();
    const w = eng.world;
    const before = Object.fromEntries([...COURSE, 'discharge', 'lake', 'water', 'dominant'].map((k) => [k, arr(w, k)]));
    eng.exec({ op: 'set_river_type', type: T('mud', { biomes: ['steppe'] }) as never });
    eng.exec({ op: 'set_river_type', type: T('glacier', { when: { temp: { low: -40, high: -2 } } }) as never });
    eng.exec({ op: 'update_species', id: 'steppe', patch: { plainRiver: false } });
    eng.exec({ op: 'update_species', id: 'tundra', patch: { plainRiver: false } });
    eng.exec({ op: 'update_species', id: 'taiga', patch: { plainRiver: false, waterBlock: 'swap' } });
    for (const [k, v] of Object.entries(before)) expect(arr(w, k), k).toEqual(v);
    // 草原上没有普通的河（除了并进相邻段的短段）：一条河上有四格连着的草原，这几格就不是普通的
    const { stems } = riverNet(w, w.derived);
    const rt = w.derived.riverType!;
    const steppe = w.small.species.findIndex((s) => s.id === 'steppe');
    let longSteppe = 0;
    for (const cells of stems) {
      let run = 0;
      cells.forEach((c, q) => {
        run = w.derived.dominant[c] === steppe ? run + 1 : 0;
        if (run >= RIVER_SEGMENT_MIN && q + 1 < cells.length) {
          longSteppe++;
          expect(rt[c]).toBe(1);
        }
      });
    }
    expect(longSteppe).toBeGreaterThan(0);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    eng.undo();
    expect(w.small.species.find((s) => s.id === 'taiga')!.plainRiver).toBeUndefined();
    expect(digestWorld(w)).toEqual(replayDigest(eng));
  });
});

describe('断流', () => {
  // 河流经最多的一种生态，且有河从外面流进去
  function target(w: World): string {
    const d = w.derived;
    const count = new Map<number, number>();
    const { stems } = riverNet(w, d);
    for (const cells of stems) {
      for (let q = 1; q < cells.length; q++) {
        if (d.dominant[cells[q]] >= 0 && d.dominant[cells[q]] !== d.dominant[cells[q - 1]]) count.set(d.dominant[cells[q]], (count.get(d.dominant[cells[q]]) ?? 0) + cells.length);
      }
    }
    return w.small.species[[...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]].id;
  }

  it('河在那里消失、下游水量少了；高程、流向、汇水不变；撤销和重放一致', () => {
    const eng = continents();
    const w = eng.world;
    const id = target(w);
    const s = w.small.species.findIndex((x) => x.id === id);
    const course = Object.fromEntries(COURSE.map((k) => [k, arr(w, k)]));
    const q0 = w.derived.discharge.slice();
    const dom0 = w.derived.dominant.slice();
    const lake0 = w.derived.lake.slice();
    const before = digestWorld(w);
    const net0 = riverNet(w, w.derived);
    eng.exec({ op: 'update_species', id, patch: { plainRiver: false, waterBlock: 'stop' } });
    for (const [k, v] of Object.entries(course)) expect(arr(w, k), k).toEqual(v);
    expect(w.derived.riverType).toBeUndefined();
    const d = w.derived;
    const net = riverNet(w, d);
    // 这种生态里的河几乎都没了（只留下并进相邻段的短段、湖里的）
    let inside0 = 0;
    let inside = 0;
    for (const cells of net0.stems) for (const c of cells) if (dom0[c] === s) inside0++;
    for (const cells of net.stems) for (const c of cells) if (dom0[c] === s) inside++;
    expect(inside0).toBeGreaterThan(5);
    expect(inside).toBeLessThan(inside0 / 2);
    // 水只会少，不会多（内流湖的涨落也只少不多）；至少有一格下游的河还是河、水少了
    let less = 0;
    let lessStillRiver = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (lake0[i] === d.lake[i]) expect(d.discharge[i]).toBeLessThanOrEqual(q0[i]);
      if (d.discharge[i] < q0[i]) {
        less++;
        if (net.isRiver[i]) lessStillRiver++;
      }
    }
    expect(less).toBeGreaterThan(0);
    expect(lessStillRiver).toBeGreaterThan(0);
    expect(net.stems.reduce((a, c) => a + c.length, 0)).toBeLessThan(net0.stems.reduce((a, c) => a + c.length, 0));
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    eng.undo();
    expect(digestWorld(w)).toEqual(before);
    eng.redo();
    expect(digestWorld(w)).toEqual(replayDigest(eng));
  });

  it('断流的格是假的河上算得准：进入这种生态的格起没有了，再出去只有后来的水；短的一片不断', () => {
    const species = SPECIES.map((sp) => (sp.id === 'b' ? { ...sp, plainRiver: false, waterBlock: 'stop' as const } : sp));
    const c = chain(
      inBiome([
        [0, 6],
        [1, 6],
        [0, 6],
      ]),
      [],
      { species },
    );
    const cut = stopCells(c.world, c.d, 1, c.biomes)!;
    expect(Array.from(cut)).toEqual([...Array(6).fill(0), ...Array(6).fill(1), ...Array(6).fill(0)]);
    // 只有两格：短的段不断流
    const short = chain(
      inBiome([
        [0, 6],
        [1, 2],
        [0, 6],
      ]),
      [],
      { species },
    );
    expect(stopCells(short.world, short.d, 1, short.biomes)).toBeNull();
    // 这里允许的类型条件满足：不断流
    const ok = chain(
      inBiome([
        [0, 6],
        [1, 6],
      ]),
      [T('x', { biomes: ['b'] })],
      { species },
    );
    expect(stopCells(ok.world, ok.d, 1, ok.biomes)).toBeNull();
    // 普通的河在这里允许：设成断流也没有什么可断的
    const allowed = chain(
      inBiome([
        [0, 6],
        [1, 6],
      ]),
      [],
      { species: SPECIES.map((sp) => (sp.id === 'b' ? { ...sp, waterBlock: 'stop' as const } : sp)) },
    );
    expect(stopCells(allowed.world, allowed.d, 1, allowed.biomes)).toBeNull();
    // 画的河不断流
    const painted = chain(
      inBiome([
        [0, 6],
        [1, 6],
      ]),
      [],
      { species, guides: [{ id: 'g', cells: [6, 7, 8, 9], end: 'sink' }] },
    );
    expect(Array.from(stopCells(painted.world, painted.d, 1, painted.biomes)!)).toEqual([...Array(10).fill(0), 1, 1]);
  });

  it('内置的生态都是换类型，都允许普通河湖', () => {
    const eng = continents();
    for (const sp of eng.world.small.species) expect([sp.waterBlock, sp.plainRiver, sp.plainLake]).toEqual([undefined, undefined, undefined]);
    for (const sp of FANTASY_BIOMES) expect([sp.waterBlock, sp.plainRiver, sp.plainLake]).toEqual([undefined, undefined, undefined]);
    expect(waterPlan(eng.world.small)).toEqual({ biomes: false, baseFirst: false, stops: false, reuseFirstBase: false });
  });
});

describe('湖的规则', () => {
  function lakeWorld() {
    const eng = continents();
    const w = eng.world;
    const out: number[] = [];
    for (let i = 0; i < w.mesh.n && out.length < 3; i++) {
      if (!w.causes.land[i] || w.derived.lake[i] || w.derived.continentality[i] < 0.55 || w.derived.slope[i] > 6) continue;
      if (out.some((c) => Math.hypot(w.mesh.x[c] - w.mesh.x[i], w.mesh.y[c] - w.mesh.y[i]) < 0.12)) continue;
      out.push(i);
    }
    out.forEach((cell, k) => eng.exec({ op: 'add_lake', lake: { id: `L${k}`, cell, radius: 80 + 40 * k, depth: 150, perennial: true } }));
    return eng;
  }
  const measure = (w: World, cells: Int32Array) => cells.reduce((a, c) => a + w.derived.tMean[c], 0) / cells.length;

  it('声明式条件按整个湖看（平均），整个湖一种', () => {
    const eng = lakeWorld();
    const w = eng.world;
    const parts = lakeParts(w, w.derived);
    expect(parts.lakes.length).toBeGreaterThan(1);
    const temps = parts.lakes.map((c) => measure(w, c));
    const mid = [...temps].sort((a, b) => a - b)[Math.floor(temps.length / 2)];
    eng.exec({ op: 'set_lake_type', type: T('warm', { when: { temp: { low: mid, high: 35 } } }) as never });
    const d = w.derived;
    const lt0 = d.lakeType!.slice();
    let yes = 0;
    let no = 0;
    for (const cells of lakeParts(w, d).lakes) {
      const v = lt0[cells[0]];
      for (let q = 0; q < cells.length; q++) expect(lt0[cells[q]]).toBe(v);
      expect(v).toBe(measure(w, cells) >= mid ? 1 : 0);
      if (v) yes++;
      else no++;
    }
    expect(yes).toBeGreaterThan(0);
    expect(no).toBeGreaterThan(0);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    // 换一个条件
    eng.exec({ op: 'set_lake_type', type: T('warm', { when: { flow: { low: 19000, high: 19500 } } }) as never });
    expect(d.lakeType!.every((v) => v === 0)).toBe(true);
  });

  it('不允许普通的湖：换成允许的类型；没有可用类型时照旧是普通的湖；“断流”对湖也是换类型；选了类型的不受限制', () => {
    const eng = lakeWorld();
    const w = eng.world;
    const d0 = w.derived;
    const base = baseBiomes(w, d0);
    const parts0 = lakeParts(w, d0);
    const shores = lakeShores(w, parts0);
    const k = shores.findIndex((s) => s.some((c) => base[c] >= 0));
    const count = new Map<number, number>();
    for (const c of shores[k]) if (base[c] >= 0) count.set(base[c], (count.get(base[c]) ?? 0) + 1);
    const b = [...count].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
    const id = w.small.species[b].id;
    const lakeCell = parts0.lakes[k][0];
    const land0 = digestWorld(w)['derived.lake'];
    // 没有类型：什么都不会变
    eng.exec({ op: 'update_species', id, patch: { plainLake: false } });
    expect(w.derived.lakeType).toBeUndefined();
    // 有一种不自然生成的：不算
    eng.exec({ op: 'set_lake_type', type: T('off', { natural: false }) as never });
    expect(w.derived.lakeType![lakeCell]).toBe(0);
    // 自然生成、这里允许的（条件不满足也算）
    eng.exec({ op: 'set_lake_type', type: T('ok', { when: { height: { low: 8000, high: 8500 } } }) as never });
    expect(w.derived.lakeType![lakeCell]).toBe(2);
    expect(digestWorld(w)['derived.lake']).toBe(land0);
    // “断流”对湖按换类型：水面不变
    eng.exec({ op: 'update_species', id, patch: { waterBlock: 'stop' } });
    expect(w.derived.lakeType![lakeCell]).toBe(2);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    eng.undo();
    // 选了普通的湖：不受限制
    const place = w.small.lakes[0];
    expect(place).toBeDefined();
    eng.exec({ op: 'set_lake_type', type: T('ok', { biomes: [] }) as never });
    expect(w.derived.lakeType![lakeCell]).toBe(0);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    typeLakes(w, w.derived, 1, baseBiomes(w, w.derived));
    expect(w.derived.lakeType![lakeCell]).toBe(0);
  });
});

describe('提速：生态不读河岸、湖岸时不多算一遍植被', () => {
  // 同一串命令，新旧两种走法整个世界逐项相同
  function both(build: () => Engine, cmds: (w: World) => Parameters<Engine['exec']>[0][]): { digest: Record<string, string>; base: number; oldBase: number } {
    const run = (old: boolean) => {
      waterPlanDebug.baseFirst = old;
      try {
        const eng = build();
        const before = vegetationStats.base;
        for (const c of cmds(eng.world)) eng.exec(c);
        return { digest: digestWorld(eng.world), base: vegetationStats.base - before, issues: JSON.stringify(eng.world.derived.scriptIssues ?? null) };
      } finally {
        waterPlanDebug.baseFirst = false;
      }
    };
    const a = run(false);
    const b = run(true);
    expect(a.digest).toEqual(b.digest);
    expect(a.issues).toBe(b.issues);
    return { digest: a.digest, base: a.base, oldBase: b.base };
  }

  it('按生态的类型、声明式条件、允许表：新旧逐位相同，不再多算', () => {
    const r = both(
      () => continents(),
      () => [
        { op: 'set_river_type', type: T('mud', { biomes: ['steppe', 'taiga'] }) as never },
        { op: 'set_river_type', type: T('cold', { when: { temp: { low: -40, high: 0 } } }) as never },
        { op: 'set_lake_type', type: T('shore', { biomes: ['steppe'] }) as never },
        { op: 'update_species', id: 'tundra', patch: { plainRiver: false, plainLake: false } },
      ],
    );
    expect(r.oldBase).toBeGreaterThan(0);
    expect(r.base).toBe(0);
  });

  it('脚本里用了生态、脚本出错：问题的先后也相同', () => {
    const bad = { match: { api: 1 as const, src: "if (biome('steppe') >= 0) throw new Error('坏');\nreturn false;" } };
    const good = { match: { api: 1 as const, src: "return biome('steppe') >= 0.5;" } };
    const r = both(
      () => continents(),
      () => [
        { op: 'set_river_type', type: T('good', { scripts: good }) as never },
        { op: 'set_river_type', type: T('bad', { scripts: bad }) as never },
        { op: 'set_lake_type', type: T('lbad', { scripts: bad }) as never },
      ],
    );
    expect(r.base).toBe(0);
    expect(r.oldBase).toBeGreaterThan(0);
  });

  it('带长在哪里的脚本的奇幻生态、对周围的影响：新旧逐位相同（走不走都对）', () => {
    const r = both(
      () => {
        const eng = continents();
        eng.exec(fantasyBiomeCommands({ fields: Object.keys(eng.world.causes.fields), species: eng.world.small.species.map((s) => s.id) }));
        return eng;
      },
      () => [{ op: 'set_river_type', type: T('mud', { biomes: ['steppe'] }) as never }],
    );
    expect(r.digest).toBeDefined();
  });

  it('生态读河岸：照旧先算一遍（读 river:、脚本里的 river()）', () => {
    const lake = { id: 'x', tolerances: [{ field: 'lake:y', min: 0, optLow: 0, optHigh: 1, max: 1 }] };
    const script = { id: 'x', tolerances: [], scripts: { placement: { src: "return river('y') > 0.5 ? 1 : 0;" } } };
    const comment = { id: 'x', tolerances: [], scripts: { placement: { src: "// river('y')\nreturn 1;" } } };
    const types = [T('y', { biomes: ['x'] })];
    expect(waterPlan({ species: [lake], riverTypes: types }).baseFirst).toBe(true);
    expect(waterPlan({ species: [script], riverTypes: types }).baseFirst).toBe(true);
    expect(waterPlan({ species: [comment], riverTypes: types }).baseFirst).toBe(false);
    expect(waterPlan({ species: [comment] }).biomes).toBe(false);
    // 真的世界：生态按河岸长，先算一遍才有河的类型可读
    const eng = continents();
    const before = vegetationStats.base;
    eng.exec({ op: 'set_river_type', type: T('y', { biomes: ['steppe'] }) as never });
    eng.exec({ op: 'update_species', id: 'wetland', patch: { tolerances: [...eng.world.small.species.find((s) => s.id === 'wetland')!.tolerances, { field: 'river:y', min: -1, optLow: 0, optHigh: 1, max: 2 }] } });
    expect(vegetationStats.base - before).toBeGreaterThan(0);
    expect(digestWorld(eng.world)).toEqual(replayDigest(eng));
  });
});

describe('提速：河网、河线的类型，新旧逐位相同', () => {
  // 第五十五轮的 riverNet 原样拷贝（不要改它）
  function oldNet(w: World) {
    const d = w.derived;
    const n = w.mesh.n;
    const isRiver = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (w.causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= w.small.planet.riverThreshold) isRiver[i] = 1;
    const mainDonor = new Int32Array(n).fill(-1);
    for (let j = 0; j < n; j++) {
      if (!isRiver[j]) continue;
      const r = d.receiver[j];
      if (r < 0 || !isRiver[r]) continue;
      const m = mainDonor[r];
      if (m < 0 || d.discharge[j] > d.discharge[m] || (d.discharge[j] === d.discharge[m] && j < m)) mainDonor[r] = j;
    }
    const stems: Int32Array[] = [];
    const seen = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (!isRiver[s] || mainDonor[s] >= 0) continue;
      const cells: number[] = [];
      for (let c = s, guard = 0; guard < n && !seen[c]; guard++) {
        cells.push(c);
        seen[c] = 1;
        const r = d.receiver[c];
        if (r < 0 || !isRiver[r] || mainDonor[r] !== c) break;
        c = r;
      }
      stems.push(Int32Array.from(cells));
    }
    return { isRiver, mainDonor, stems };
  }
  const same = (w: World) => {
    const a = oldNet(w);
    const b = riverNet(w, w.derived);
    expect(Array.from(b.isRiver)).toEqual(Array.from(a.isRiver));
    expect(Array.from(b.mainDonor)).toEqual(Array.from(a.mainDonor));
    expect(b.stems.map((c) => Array.from(c))).toEqual(a.stems.map((c) => Array.from(c)));
  };

  it('河网：河变了、没变、换一个世界（同一个网格）都和旧的算法相同；河没变时不重新走', () => {
    const eng = continents();
    const w = eng.world;
    same(w);
    const first = riverNet(w, w.derived);
    expect(riverNet(w, w.derived)).toBe(first);
    const hot = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]).slice(0, 400);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: hot, value: -6, mode: 'add' });
    same(w);
    eng.exec({ op: 'set_planet', patch: { riverThreshold: 400 } });
    same(w);
    expect(riverNet(w, w.derived).stems.length).not.toBe(first.stems.length);
    eng.undo();
    same(w);
    const other = continents();
    same(other.world);
    same(w);
    // 留着的结果不会被下一次改掉
    const kept = riverNet(w, w.derived);
    const copy = kept.isRiver.slice();
    eng.exec({ op: 'set_planet', patch: { riverThreshold: 600 } });
    riverNet(w, w.derived);
    expect(Array.from(kept.isRiver)).toEqual(Array.from(copy));
  });

  it('河线上的类型：和 cells 一样按点展开（旧的走法每一遍跟着加），一种类型、几种类型、太短不平滑的都相同', () => {
    const pts = (m: number) => Array.from({ length: m }, (_, k) => [k * 0.01, k * 0.02] as [number, number]);
    for (const tags of [[0, 0, 0, 0, 0], [2, 2, 2, 2, 2, 2, 2, 2], [0, 1, 1, 2, 0, 3, 3], [1, 2], [3]]) {
      const line = smoothCourse(pts(tags.length), tags.map(() => 200), 0.01, [...tags], tags);
      expect(line.type).toEqual(line.cells);
      expect(line.type!.length).toBe(line.points.length);
    }
    const eng = continents();
    eng.exec({ op: 'set_river_type', type: T('high', { when: { height: { low: 800, high: 9000 } } }) as never });
    const lines = traceRivers(eng.world);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.type!.length).toBe(l.points.length);
  });
});

describe('改一条按段定类型的河', () => {
  it('这条河上不止一种时不把整条河定成一种；只有一种时照旧记下', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: T('high', { when: { height: { low: 800, high: 9000 } } }) as never });
    const rt = w.derived.riverType!;
    const stems = riverNet(w, w.derived).stems;
    const mixed = stems.find((cells) => new Set(cells).size > 0 && new Set(Array.from(cells, (c) => rt[c])).size > 1)!;
    const whole = stems.find((cells) => Array.from(cells).every((c) => rt[c] === 1))!;
    expect(ruleTypeOf(w, w.derived, Array.from(mixed))).toBeUndefined();
    expect(ruleTypeOf(w, w.derived, Array.from(whole))).toBe('high');
  });
});

describe('没有规则的世界', () => {
  it('没有规则时走老路；不写的字段不进世界', () => {
    const none = [T('a', { scripts: { match: { api: 1, src: 'return false;' } } })];
    expect(waterRules(SPECIES, none, 'plainRiver')).toBeNull();
    expect(waterRules(SPECIES, [], 'plainRiver')).toBeNull();
    expect(waterRules(SPECIES, [T('a', { natural: false, when: { temp: { low: 0, high: 1 } } })], 'plainRiver')).toBeNull();
    const eng = continents();
    expect(JSON.stringify(eng.world.small.species)).not.toMatch(/plainRiver|plainLake|waterBlock/);
    expect('riverType' in eng.world.derived).toBe(false);
  });
});
