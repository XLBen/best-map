import { describe, expect, it } from 'vitest';
import { extendedHashes, referenceHashes } from '../tools/hash';
import saved from './biome-legacy-digests.json';
import type { Command } from './commands';
import type { Engine } from './engine';
import { DEFAULT_LIBRARY, builtinPacks, worldPartsOf } from './packs/builtin-tree';
import { ERA_PACKS } from './packs/eras';
import { newWorldContentCommands, packImportCommands } from './packs/import';
import { digest } from './digest';
import { mulberry32 } from './rng';
import { type Tolerance, trapezoid } from './species';
import { NO_CURRENTS, engineFor, humanDigest, importPacks, setGroupWeights, withoutHeights } from './testing/fixtures';
import { type InvadeTable, invadeBoost, suitability, vegShares } from './vegetation';

// 第五十五轮：内置生态写了高度范围，同一个种子的世界和以前不同，金标准重录了一次。
// 这里查另一半：没写高度范围的生态行为和以前一样。把内置生态的高度范围去掉（也去掉那两种高山生态）之后，
// 整个世界和 f2c6f77（第五十四轮）逐值相同。biome-legacy-digests.json 是那时的 golden-hashes、golden-full、
// r29-digests、libraries-digests 原样拷下来的：不要改它。
// 第七十三轮只改了 libraries.medieval 的 content、origin：时代换了样子（国家格局）、多了国家格局这种内容（核对过换回旧的样子时与原来的值相同）
// 第七十四轮：国家的生成有意改了（各时代的历史格局、民族主义），重录了 r29 的 medieval、modern、fantasy 与 libraries.medieval 里人文的几项
// （人口、群体、国家、集团、城市、道路、地标、省名）；libraries.medieval 的 content、origin 因为中世纪多了集权帝国、游牧汗国两种格局。地形、生态的几项没变
// 第七十五轮：奇幻的国家有意改了（种族王国），重录 r29.fantasy 人文的几项；r29.medieval、r29.modern、libraries.medieval 只重录 countries：
// 档案多了格局里的角色（role），核对过不写 role 时与原来的值逐个相同
// 第七十六轮：中文地名风格的模板“某某沙漠 / 冻原 / 冰原”改成“荒漠 / 苔原 / 冰盖”，重录变了的几项（地名、小数据里的地名风格、世界文件）；核对过两边的世界只差这三个字
// 第七十七轮：生成的命令不再写权重、“分裂 ↔ 统一”、格局，human 只记组的 id、countryRules 只有种子，组带着库里的比重，没有格局。重录 golden-full 的 small、r29 的 human、libraries 的 human、content、origin；核对过两边的世界只差这几样（见 docs/dev/history/第77轮.md）
describe('没写高度范围的生态和第五十四轮逐值相同', () => {
  const plain = () => withoutHeights(newWorldContentCommands());

  it('一块地区的各层（golden）', () => {
    expect(referenceHashes(plain())).toEqual(saved.golden);
  });

  it('整个世界，加长的操作（golden-full）：一块地区', () => {
    expect(extendedHashes('region', plain())).toEqual(saved.goldenFull.region);
  });

  it('整个世界，加长的操作（golden-full）：整个星球', () => {
    expect(extendedHashes('planet', plain())).toEqual(saved.goldenFull.planet);
  });

  // era-packs.test.ts 里同样的世界
  function world(): Engine {
    const eng = engineFor({ cells: 12000, seed: 1, latNorth: 72, latSouth: 20 }, { bare: true });
    for (const c of plain()) eng.exec(c);
    eng.exec(NO_CURRENTS);
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    return eng;
  }

  it('人文的摘要（r29）：没有人文的、中世纪、现代', () => {
    const base = world();
    const r29 = saved.r29 as Record<string, Record<string, string>>;
    expect(humanDigest(base.world)).toEqual(r29.nature);
    const SCENES = [
      { id: 'medieval', era: 'medieval', groups: [['germanic', 3], ['chinese', 3], ['levantine', 2], ['hindustani', 2], ['east-slavic', 1.5], ['altaic', 1.5]] },
      { id: 'modern', era: 'modern', groups: [['chinese', 4], ['hindustani', 4], ['kongo', 3], ['germanic', 2]] },
    ] as const;
    for (const sc of SCENES) {
      const e = base.clone();
      const groups = sc.groups.map(([id, weight]) => ({ id, weight }));
      importPacks(e, { packs: [[sc.era]], groups: groups.map((g) => g.id) });
      // 第七十七轮：权重写进世界里的组（命令只写 id）
      setGroupWeights(e, groups);
      e.exec({ op: 'generate_human', packs: [[sc.era]], groups: groups.map((g) => g.id), countries: {}, settlements: {} });
      expect(humanDigest(e.world), sc.id).toEqual(r29[sc.id]);
    }
  });

  // 第五十一轮的例外（era-packs.test.ts 搬来的）：奇幻库自带的 5 种资源移出世界再生成时，和文件里的 14 项相同
  it('人文的摘要（r29）：奇幻，移出它自带的 5 种资源', () => {
    const e = world().clone();
    const groups = [['germanic', 3], ['elven', 2], ['dwarven', 1.5], ['orcish', 1.5]].map(([id, weight]) => ({ id: id as string, weight: weight as number }));
    importPacks(e, { packs: [['fantasy']], groups: groups.map((g) => g.id) });
    const ids = ERA_PACKS.get('fantasy')!.resources!;
    expect(ids.length).toBe(5);
    e.exec({ op: 'batch', commands: ids.map((id): Command => ({ op: 'set_content', kind: 'resource', id, item: null })) });
    setGroupWeights(e, groups);
    e.exec({ op: 'generate_human', packs: [['fantasy']], groups: groups.map((g) => g.id), countries: {}, settlements: {} });
    expect(humanDigest(e.world)).toEqual((saved.r29 as Record<string, unknown>).fantasy);
  });

  it('默认的库新建的世界（libraries）', () => {
    const LIB = builtinPacks();
    const id = DEFAULT_LIBRARY;
    const groups = ERA_PACKS.get(id)!.cultures.map(([g, w]) => ({ id: g, weight: w }));
    const eng = engineFor({ cells: 6000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
    for (const c of withoutHeights(packImportCommands(LIB, { packs: worldPartsOf(id), groups: [] }, eng.world))) eng.exec(c);
    eng.exec(NO_CURRENTS);
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    for (const c of packImportCommands(LIB, { packs: [[id]], groups: groups.map((g) => g.id) }, eng.world)) eng.exec(c);
    eng.exec({ op: 'generate_human', packs: [[id]], groups: groups.map((g) => g.id), countries: {}, settlements: {} });
    const { small } = eng.world;
    expect({ ...humanDigest(eng.world), content: digest(small.content ?? null), origin: digest(small.origin ?? null) }).toEqual((saved.libraries as Record<string, unknown>)[id]);
  });
});

// 第五十五轮的提速（vegetation.ts 的 suitability、vegShares）：f2c6f77 的原样拷贝，不要改它
function oldSuitability(vegCells: Int32Array, count: number, tols: readonly Tolerance[], fields: Float64Array[], K: number, p: number, placeF: Float32Array | null, P: number, suit: Float32Array, S: number, s: number) {
  for (let q = 0; q < count; q++) {
    const i = vegCells[q];
    let v = 1;
    for (let k = 0; k < K && v > 0; k++) v *= trapezoid(tols[k], fields[k][i]);
    if (p >= 0 && v > 0) v *= placeF![i * P + p];
    suit[i * S + s] = v;
  }
}
function oldVegShares(n: number, S: number, veg: Uint8Array, suit: Float32Array, reach: Uint8Array, comp: ArrayLike<number>, k: number, invade: InvadeTable | null, share: Float32Array, dominant: Int16Array) {
  for (let i = 0; i < n; i++) {
    if (!veg[i]) {
      dominant[i] = -1;
      for (let s = 0; s < S; s++) share[i * S + s] = 0;
      continue;
    }
    let total = 0;
    let best = -2;
    let bestScore = 0;
    if (!invade) {
      for (let s = 0; s < S; s++) {
        const score = suit[i * S + s] * comp[s] * reach[i * S + s];
        const w = score > 0 ? Math.pow(score, k) : 0;
        share[i * S + s] = w;
        total += w;
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
    } else {
      for (let s = 0; s < S; s++) {
        const score = suit[i * S + s] * comp[s] * reach[i * S + s] * invadeBoost(invade, suit, S, i, s);
        const w = score > 0 ? Math.pow(score, k) : 0;
        share[i * S + s] = w;
        total += w;
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
    }
    if (total > 0) for (let s = 0; s < S; s++) share[i * S + s] /= total;
    dominant[i] = best;
  }
}

describe('提速前后逐位相同', () => {
  it('适宜度、份额、主导生态：随机的曲线、脚本的系数（负的、0）、可达、侵占、竞争力 0', () => {
    const rand = mulberry32(55);
    const n = 3000;
    const S = 12;
    const fieldsAll = Array.from({ length: 4 }, () => Float64Array.from({ length: n }, () => rand() * 120 - 60));
    for (let round = 0; round < 60; round++) {
      const veg = Uint8Array.from({ length: n }, () => (rand() < 0.8 ? 1 : 0));
      const cells = Int32Array.from([...Array(n).keys()].filter((i) => veg[i]));
      const P = 2;
      const placeF = Float32Array.from({ length: n * P }, () => (rand() < 0.2 ? 0 : rand() < 0.1 ? -rand() : rand()));
      const a = new Float32Array(n * S);
      const b = new Float32Array(n * S);
      const keep = new Int32Array(cells.length);
      const val = new Float64Array(cells.length);
      for (let s = 0; s < S; s++) {
        const K = Math.floor(rand() * 4);
        const fields = Array.from({ length: K }, () => fieldsAll[Math.floor(rand() * 4)]);
        const tols = Array.from({ length: K }, (): Tolerance => {
          const v = [0, 0, 0, 0].map(() => rand() * 140 - 70).sort((x, y) => x - y);
          // 有的边是硬的（min = optLow、optHigh = max）
          return { field: 'x', min: v[0], optLow: rand() < 0.3 ? v[0] : v[1], optHigh: rand() < 0.3 ? v[3] : v[2], max: v[3] };
        });
        const p = rand() < 0.3 ? Math.floor(rand() * P) : -1;
        oldSuitability(cells, cells.length, tols, fields, K, p, placeF, P, a, S, s);
        suitability(cells, cells.length, tols, fields, K, p, placeF, P, b, S, s, keep, val);
      }
      expect(digest(b)).toBe(digest(a));
      const reach = Uint8Array.from({ length: n * S }, () => (rand() < 0.9 ? 1 : 0));
      const comp = Float64Array.from({ length: S }, () => (rand() < 0.1 ? 0 : rand() * 10));
      const invade: InvadeTable | null = round % 2
        ? Array.from({ length: S }, (_, s) => (s % 3 ? null : { targets: Int32Array.from([(s + 1) % S, (s + 5) % S]), strength: rand() * 5 }))
        : null;
      const k = 0.5 + rand() * 4;
      const shareOld = new Float32Array(n * S).fill(0.5);
      const shareNew = new Float32Array(n * S).fill(0.5);
      const domOld = new Int16Array(n);
      const domNew = new Int16Array(n);
      oldVegShares(n, S, veg, a, reach, comp, k, invade, shareOld, domOld);
      vegShares(n, S, veg, b, reach, comp, k, invade, shareNew, domNew);
      expect(digest(shareNew)).toBe(digest(shareOld));
      expect(digest(domNew)).toBe(digest(domOld));
    }
  });
});
