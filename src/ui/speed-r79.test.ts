import { describe, expect, it } from 'vitest';
import type { Engine } from '../../core/engine';
import { isVegetated } from '../../core/vegetation';
import { blocList } from '../../core/human';
import { continents, humanExec, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import type { ViewMode } from '../state';
import { legendFor, legendNeedsCount, shownLegend } from './domain/legend';
import { H, W, biomeShares, densityPixels, xOf, yOf } from './ecology/chart';

// 第七十九轮的提速，新旧逐位相同：
//   图例（domain/legend.ts）：格数按 编号数组、陆地、湖 缓存，定长的表数 0–255；缓存的键按内容对象比（以前 JSON.stringify）；
//   生态编辑器（ecology/chart.ts）：biomeShares、densityPixels 按用到的数组缓存（以前按世界对象）。
// 下面的 old* 是第七十八轮（8facf5e）的原样拷贝（只去掉缓存），不要改它

function oldCountCodes(w: World, codes: ArrayLike<number>): Map<number, number> {
  const { causes, derived: d } = w;
  const out = new Map<number, number>();
  for (let i = 0; i < codes.length; i++) {
    if (!causes.land[i] || d.lake[i] === 1) continue;
    out.set(codes[i], (out.get(codes[i]) ?? 0) + 1);
  }
  return out;
}

function oldBiomeShares(w: World): Map<number, number> {
  const m = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!isVegetated(w, w.derived, i)) continue;
    total++;
    const s = w.derived.dominant[i];
    if (s >= 0) m.set(s, (m.get(s) ?? 0) + 1);
  }
  for (const [k, v] of m) m.set(k, v / Math.max(1, total));
  return m;
}

function oldDensityPixels(w: World): Uint8ClampedArray {
  const counts = new Float32Array(W * H);
  let max = 0;
  const d = w.derived;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!isVegetated(w, d, i)) continue;
    const px = Math.round(xOf(d.tMean[i]));
    const py = Math.round(yOf(d.moisture[i]));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = (py + dy) * W + px + dx;
        if (k < 0 || k >= counts.length) continue;
        counts[k] += dx === 0 && dy === 0 ? 1 : 0.4;
        max = Math.max(max, counts[k]);
      }
    }
  }
  const img = new Uint8ClampedArray(W * H * 4);
  for (let k = 0; k < counts.length; k++) {
    if (!counts[k]) continue;
    img[k * 4] = 230;
    img[k * 4 + 1] = 230;
    img[k * 4 + 2] = 230;
    img[k * 4 + 3] = Math.round(200 * Math.sqrt(counts[k] / max));
  }
  return img;
}

const sorted = (m: Map<number, number>) => [...m].sort((a, b) => a[0] - b[0]);

const peopled = (): Engine =>
  snapshot('r79:peopled', () => {
    const e = continents();
    humanExec(e, { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {}, settlements: {} });
    return e;
  });

// 主线程收到的下一份快照：这一个数组是新的一份（值不变），小数据是新的对象，内容还是同一个
function nextSnapshot(w: World, key: keyof World['derived']): World {
  const arr = w.derived[key] as unknown as { slice(): unknown } | undefined;
  return { ...w, small: { ...structuredClone({ ...w.small, content: undefined }), content: w.small.content }, derived: { ...w.derived, [key]: arr?.slice() } } as World;
}

describe('第七十九轮：图例', () => {
  it('格数与以前逐个相同（地形类别、资源、生态，-1 也数）', () => {
    const w = peopled().world;
    const L = legendFor(w, 'terrain')!;
    expect(L.items.length).toBeGreaterThan(3);
    // 图例里每一行的格数就是以前数的（生态、地形类别按名字认回编号；资源的“无”是 0 与 RESOURCE_NONE 的和）
    const old = oldCountCodes(w, w.derived.dominant);
    for (const it of L.items) expect(it.count).toBe(old.get(w.small.species.findIndex((s) => (s.name || s.id) === it.label)));
    const tc = legendFor(w, 'terrainClass')!;
    const oldTc = oldCountCodes(w, w.derived.terrainClass!);
    expect(tc.items.map((x) => x.count).sort()).toEqual(sorted(oldTc).filter(([k]) => k > 0).map(([, v]) => v).sort());
    const res = legendFor(w, 'resource')!;
    const oldRes = oldCountCodes(w, w.derived.resource!);
    expect(res.items.reduce((a, x) => a + (x.count ?? 0), 0)).toBe(sorted(oldRes).reduce((a, [, v]) => a + v, 0));
    expect(res.items.length).toBeGreaterThan(2);
    // 编号里有 −1 和超过 255 的也照旧数（进 Map 的那一路）
    const odd = Int16Array.from(w.derived.dominant, (v, i) => (i % 7 === 0 ? -1 : i % 11 === 0 ? 300 + (v & 3) : v));
    const wo = { ...w, derived: { ...w.derived, dominant: odd } } as World;
    const items = legendFor(wo, 'dominant')!.items;
    const want = oldCountCodes(wo, odd);
    for (const it of items) expect(it.count).toBe(want.get(wo.small.species.findIndex((s) => (s.name || s.id) === it.label)));
  });

  it('各底图的图例与第七十八轮的写法逐项相同；换了一份数组、小数据是新的对象时照旧', () => {
    const w = peopled().world;
    expect(blocList(w.small).length).toBeGreaterThanOrEqual(0);
    const modes: ViewMode[] = ['terrain', 'dominant', 'terrainClass', 'resource', 'culture', 'cultureGroup', 'country', 'habitability', 'popDensity', 'elevation'];
    if (blocList(w.small).length) modes.push('bloc');
    for (const m of modes) {
      const a = legendFor(w, m);
      // 数组换成新的一份（值一样）：重算出来一样
      const key = m === 'terrain' || m === 'dominant' ? 'dominant' : m === 'terrainClass' ? 'terrainClass' : m === 'resource' ? 'resource' : 'popDensity';
      const b = legendFor(nextSnapshot(w, key), m);
      expect(b).toEqual(a);
    }
  });

  it('缓存：同一份数组、同样的内容对象再取是同一个；内容对象换了（改了名字颜色）重算，格数不重数', () => {
    const w = peopled().world;
    const a = legendFor(w, 'terrainClass')!;
    // 小数据是新的对象、内容是同一个：命中
    const same = { ...w, small: { ...w.small } } as World;
    expect(legendFor(same, 'terrainClass')).toBe(a);
    // 地形类别换了颜色（内容里那一种是新的对象）：重算，颜色跟着变
    const tc = w.small.content!.terrainClass!;
    const first = Object.keys(tc)[0];
    const content = { ...w.small.content!, terrainClass: { ...tc, [first]: { ...(tc[first] as object), color: '#123456' } } };
    const changed = { ...w, small: { ...w.small, content } } as World;
    const b = legendFor(changed, 'terrainClass')!;
    expect(b).not.toBe(a);
    expect(b.items.map((x) => x.count)).toEqual(a.items.map((x) => x.count));
    // 生态的格数：数组没变时不必重数
    expect(legendNeedsCount(w, 'terrain')).toBe(legendNeedsCount(w, 'terrain'));
    legendFor(w, 'terrain');
    expect(legendNeedsCount(w, 'terrain')).toBe(false);
    expect(legendNeedsCount(nextSnapshot(w, 'dominant'), 'terrain')).toBe(true);
    // 没有按格数的底图不用数
    expect(legendNeedsCount(w, 'country')).toBe(false);
  });

  it('地图上的图例：没有 requestIdleCallback 时（测试里）当场算，和 legendFor 一样', () => {
    const w = peopled().world;
    const next = nextSnapshot(w, 'dominant');
    expect(shownLegend(w, 'terrain')).toBe(legendFor(w, 'terrain'));
    expect(shownLegend(next, 'terrain')).toEqual(legendFor(w, 'terrain'));
    expect(legendNeedsCount(next, 'terrain')).toBe(false);
  });
});

describe('第七十九轮：生态编辑器的两份缓存', () => {
  it('与以前逐值相同；数组不变时换了世界对象也是同一份，换了数组重算', () => {
    const w = peopled().world;
    const s = biomeShares(w);
    expect(sorted(s)).toEqual(sorted(oldBiomeShares(w)));
    const px = densityPixels(w);
    expect(px).toEqual(oldDensityPixels(w));
    const copy = { ...w, small: { ...w.small } } as World;
    expect(biomeShares(copy)).toBe(s);
    expect(densityPixels(copy)).toBe(px);
    const dom = nextSnapshot(w, 'dominant');
    expect(biomeShares(dom)).not.toBe(s);
    expect(sorted(biomeShares(dom))).toEqual(sorted(s));
    // 生态换了不影响分布图；年均温换了重画
    expect(densityPixels(dom)).toBe(px);
    const t = nextSnapshot(w, 'tMean');
    expect(densityPixels(t)).not.toBe(px);
    expect(densityPixels(t)).toEqual(px);
  });
});
