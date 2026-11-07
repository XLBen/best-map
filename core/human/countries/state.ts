import { hashString } from '../../names';
import { mixSeed, mulberry32 } from '../../rng';
import type { Bloc, CountryMeta, World } from '../../world';
import type { GenContext } from '../context';
import type { Government } from '../government';
import type { CountryTierDef } from '../tiers';
import type { CountryPlan } from './base';
import type { PatternUse } from './patterns';

// 一次生成国家（第七十三轮）各步共用的东西：国家一步（count → seeds → grow → cleanup → records）一路往里放，
// 领土补齐之后的集团一步（relate）接着用（放在 ctx.countryRun）。格局的钩子（patterns.ts）拿到的就是它。
// 随机都从国家的种子派生、按名字取（stream），名字和取数的先后与第七十二轮以前一模一样，所以结果逐值不变

export interface Seed {
  cell: number;
  // ctx.cultures 的下标
  culture: number;
  gov: Government;
  tier: CountryTierDef;
  // 面积预算（km² 能住人的干陆地）：长到这么大就先停下
  budget: number;
  // 预留的一片地方（regions 的下标；不在里面为 −1）。第七十二轮以前叫 confed（邦联的下标）
  region: number;
  // 隔海的地方照样要（第七十四轮的殖民地用）：长完以后不按“隔海的一块能住人的分量不到本国几成就放掉”放掉
  overseas?: boolean;
}

// 预留的一片地方（reserve 钩子圈的，神圣帝国的诸侯……）：长的时候只有它的成员进，成员也不出这一片去占能住人的地方
export interface Region {
  // 圈它的格局模块
  pattern: string;
  // 文化组（ctx.groups 的下标）
  group: number;
  seeds: Seed[];
}

// 走一条边的代价再乘点什么（grow 钩子加的，第七十四轮的民族主义、大河）：o 是第几国（seeds 的下标），j 是要进的格（干的陆地，不是湖），
// c 是按文化、海岸算到这里的代价；返回新的代价
export type StepCost = (o: number, j: number, c: number) => number;

// 集团一步的东西（relate 钩子共用）
export interface BlocRun {
  // 共用的随机流 'blocs'：联邦、同盟按先后取数
  rand: () => number;
  // 国家的编号 → 陆地面积（km²，领土补齐之后）
  area: Map<number, number>;
  // 这一次的集团（锁定的国家留下的在前）
  blocs: Bloc[];
  nid: number;
  // 已经在帝国或联邦里的、已经在同盟里的
  inUnion: Set<number>;
  inAlliance: Set<number>;
  // 切过联邦（首都一带的人口倍数要重算）
  split: boolean;
  // 按这一次的时代起名（世界的时代还没换上）
  name(b: Bloc): void;
}

export interface CountryRun {
  ctx: GenContext;
  world: World;
  plan: CountryPlan;
  // 国家的种子（plan.rules.seed >>> 0）
  seed: number;
  n: number;
  // 每个格局模块这一次的用法（时代列的；没列的是模块的 fallback）
  uses: ReadonlyMap<string, PatternUse>;
  // 模块自己的东西（按模块的 id）
  state: Map<string, unknown>;
  // mixSeed(seed, hashString(name), ...k)
  mix(name: string, ...k: number[]): number;
  // 按名字的随机流（每次新开一个）
  stream(name: string, ...k: number[]): () => number;
  // 按名字共用的随机流（同一个名字是同一个，几个模块按先后取数）
  shared(name: string): () => number;

  // ---- 国家一步 ----
  country: Int32Array;
  // 锁定、留下的国家
  kept: CountryMeta[];
  // 下一个编号
  next: number;
  minH: number;
  govs: readonly Government[];
  // count.ts：文化的个数、各文化能住人的面积与分量、总面积、平均的国家、几个国家、还剩几个没分（reserve 用掉一些）
  K: number;
  areaC: Float64Array;
  massC: Float64Array;
  massSum: number;
  area: number;
  T: number;
  total: number;
  rest: number;
  // 世界里的等级（按 order）、生效的比例、等级 → 下标
  tierList: readonly CountryTierDef[];
  tierW: number[];
  tierIndex: Map<CountryTierDef, number>;
  // 起点
  isSeed: Uint8Array;
  seeds: Seed[];
  // 预留的地方：每格是第几片（−1 不在）
  region: Int32Array;
  regions: Region[];
  // 陆块：每格是第几块
  compOf: Int32Array;
  // grow 钩子加的代价
  stepCost: StepCost[];
  // grow.ts 的结果：每格归第几国（seeds 的下标；−1 无主，−2 锁定的国家）、走到这里的代价、走边的代价、各国的宜居度下限、起点的陆块、主流文化组
  owner: Int32Array;
  dist: Float64Array;
  edge: Float32Array;
  thr: Float64Array;
  home: Int32Array;
  primGroup: Int32Array;
  // records.ts 的结果：各国的编号、档案、干陆地的面积
  ids?: number[];
  metas?: CountryMeta[];
  areaOf?: Float64Array;
  // diplomacy.ts：邻国（seeds 的下标）、宗主（−1 没有）
  neighbors?: number[][];
  overlord?: Int32Array;

  // ---- 集团一步 ----
  bloc?: BlocRun;
}

const EMPTY_I = new Int32Array(0);
const EMPTY_F = new Float64Array(0);

// 新的一次（不改世界）：国家的种子、各模块的用法
export function newRun(ctx: GenContext, plan: CountryPlan, uses: ReadonlyMap<string, PatternUse>): CountryRun {
  const seed = plan.rules.seed >>> 0;
  const pool = new Map<string, () => number>();
  const mix = (name: string, ...k: number[]) => mixSeed(seed, hashString(name), ...k);
  return {
    ctx,
    world: ctx.world,
    plan,
    seed,
    n: ctx.world.mesh.n,
    uses,
    state: new Map(),
    mix,
    stream: (name, ...k) => mulberry32(mix(name, ...k)),
    shared: (name) => {
      let r = pool.get(name);
      if (!r) pool.set(name, (r = mulberry32(mix(name))));
      return r;
    },
    country: EMPTY_I,
    kept: [],
    next: 1,
    minH: ctx.era.unclaimed.minHabitability,
    govs: [],
    K: 0,
    areaC: EMPTY_F,
    massC: EMPTY_F,
    massSum: 0,
    area: 0,
    T: 0,
    total: 0,
    rest: 0,
    tierList: [],
    tierW: [],
    tierIndex: new Map(),
    isSeed: new Uint8Array(0),
    seeds: [],
    region: EMPTY_I,
    regions: [],
    compOf: EMPTY_I,
    stepCost: [],
    owner: EMPTY_I,
    dist: EMPTY_F,
    edge: new Float32Array(0),
    thr: EMPTY_F,
    home: EMPTY_I,
    primGroup: EMPTY_I,
  };
}
