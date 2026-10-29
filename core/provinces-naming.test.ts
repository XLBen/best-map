import { beforeAll, describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { fillUnassigned, nameNewProvince, provinceSizes, provinceTargets, repairProvinces } from './provinces';
import { mulberry32 } from './rng';
import { resolveTerrain } from './terrain';
import type { World } from './world';
import { seededEngine } from './testing/fixtures';

// 补省与起名走的是只看变化处的写法，结果必须与最直白的写法逐值相同：
// 并入时一遍遍按编号整体重扫，每个新省份扫全图收集它的格、重新收集已用的名字

function fillUnassignedPlain(world: World) {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const province = causes.province;
  const sizes = provinceSizes(world);
  const targets = provinceTargets(world, small.provinceRules);
  const target = (land: boolean) => (land ? targets.land : targets.sea);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (province[i] >= 0) continue;
      const land = causes.land[i] === 1;
      let best = -1;
      let bestSize = Infinity;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const p = province[mesh.adj[e]];
        if (p < 0) continue;
        const meta = small.provinces[p];
        if (!meta || meta.locked || meta.land !== land) continue;
        const sz = sizes.get(p) ?? 0;
        if (sz < target(land) * 1.5 && sz < bestSize) {
          best = p;
          bestSize = sz;
        }
      }
      if (best >= 0) {
        province[i] = best;
        sizes.set(best, bestSize + 1);
        changed = true;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (province[i] >= 0) continue;
    const land = causes.land[i] === 1;
    const id = small.nextProvince++;
    small.provinces[id] = { name: '', locked: false, land, kind: land ? 'land' : 'sea' };
    const queue = [i];
    province[i] = id;
    let count = 1;
    for (let h = 0; h < queue.length && count < target(land); h++) {
      const c = queue[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1] && count < target(land); e++) {
        const j = mesh.adj[e];
        if (province[j] < 0 && (causes.land[j] === 1) === land) {
          province[j] = id;
          queue.push(j);
          count++;
        }
      }
    }
    nameNewProvince(world, id);
  }
}

function repairPlain(world: World) {
  const { causes, small } = world;
  for (let i = 0; i < causes.province.length; i++) {
    const p = causes.province[i];
    if (p < 0) continue;
    const meta = small.provinces[p];
    if (!meta || meta.land !== (causes.land[i] === 1)) causes.province[i] = -1;
  }
  fillUnassignedPlain(world);
  const sizes = provinceSizes(world);
  for (const id of Object.keys(small.provinces).map(Number)) if (!sizes.has(id)) delete small.provinces[id];
}

// 同一个起点（prepare 之后）分别跑两种写法，比较省份格与省份表（名字、类型、锁定……）
function compare(w: World, prepare: () => void, fast: (w: World) => void, plain: (w: World) => void) {
  const province = w.causes.province.slice();
  const land = w.causes.land.slice();
  const small = JSON.stringify(w.small);
  const restore = () => {
    w.causes.province.set(province);
    w.causes.land.set(land);
    w.small = JSON.parse(small);
  };
  const run = (f: (w: World) => void) => {
    prepare();
    const unassigned = w.causes.province.filter((p) => p < 0).length;
    const next = w.small.nextProvince;
    f(w);
    const out = { province: w.causes.province.slice(), provinces: JSON.stringify(w.small.provinces), next: w.small.nextProvince, unassigned, fresh: w.small.nextProvince - next };
    restore();
    return out;
  };
  const a = run(fast);
  const b = run(plain);
  expect(a.next).toBe(b.next);
  expect(a.provinces).toBe(b.provinces);
  expect(a.province).toEqual(b.province);
  expect(a.province.every((p) => p >= 0)).toBe(true);
  return a;
}

// 以随机格为中心的若干片（走 r 步）
function blobs(w: World, seed: number, count: number, r: number): number[] {
  const { mesh } = w;
  const rand = mulberry32(seed);
  const seen = new Uint8Array(mesh.n);
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    let frontier = [Math.floor(rand() * mesh.n)];
    for (let step = 0; step <= r && frontier.length; step++) {
      const next: number[] = [];
      for (const c of frontier) {
        if (seen[c]) continue;
        seen[c] = 1;
        out.push(c);
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) next.push(mesh.adj[e]);
      }
      frontier = next;
    }
  }
  return out;
}

// 换掉世界默认的地名风格（直接改小状态，与以前直接换 small.wordPack 一样）
function useStyle(w: World, pack: { id: string; name: string; lists: Record<string, string[]>; types: Record<string, unknown> }) {
  w.small.content = { ...w.small.content, nameStyle: { ...(w.small.content?.nameStyle ?? {}), [pack.id]: { ...pack, kind: 'template' } as never } };
  w.small.nameStyle = pack.id;
}

// 只有几种组合的文字包：名字经常撞，检验“已用的名字”逐个加入与重新收集一致
const tinyPack = {
  id: 'tiny',
  name: 'tiny',
  lists: { a: ['甲', '乙'], b: ['山', '河', '海'] },
  types: { province: { patterns: [{ p: '{a}{b}' }], byTag: { sea: [{ p: '{a}洋' }], coastal: [{ p: '{b}{a}' }] } } },
};

const worlds: [string, () => Engine][] = [
  [
    '一块地区',
    () => {
      const eng = seededEngine({ seed: 2, cells: 5000 });
      eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
      eng.exec({ op: 'generate_provinces', rules: { seed: 4, size: 'small' } });
      return eng;
    },
  ],
  [
    '整个星球',
    () => {
      const eng = seededEngine({ seed: 6, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
      eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'archipelago' }, reset: true });
      eng.exec({ op: 'generate_provinces', rules: { seed: 6 } });
      return eng;
    },
  ],
];

describe.each(worlds)('补省与起名与直白写法逐值相同：%s', (_, make) => {
  let w: World;
  beforeAll(() => {
    w = make().world;
  });

  it('全部清空后补省（新世界）', () => {
    const r = compare(
      w,
      () => {
        w.causes.province.fill(-1);
        w.small.provinces = {};
      },
      fillUnassigned,
      fillUnassignedPlain,
    );
    expect(r.fresh).toBeGreaterThan(30);
  });

  it('挖掉几片后补省（并入相邻省份，剩下的成新省份）', () => {
    for (const [seed, count, r] of [
      [1, 6, 4],
      [2, 3, 9],
      [3, 25, 2],
    ]) {
      const res = compare(
        w,
        () => {
          for (const c of blobs(w, seed, count, r)) w.causes.province[c] = -1;
        },
        fillUnassigned,
        fillUnassignedPlain,
      );
      expect(res.unassigned).toBeGreaterThan(0);
    }
  });

  it('有锁定的省份、名字经常撞的文字包', () => {
    const res = compare(
      w,
      () => {
        const rand = mulberry32(9);
        for (const meta of Object.values(w.small.provinces)) if (rand() < 0.3) meta.locked = true;
        useStyle(w, tinyPack);
        for (const c of blobs(w, 7, 8, 6)) w.causes.province[c] = -1;
      },
      fillUnassigned,
      fillUnassignedPlain,
    );
    expect(res.fresh).toBeGreaterThan(0);
  });

  it('没有模板的文字包（名字为空）', () => {
    compare(
      w,
      () => {
        useStyle(w, { id: 'empty', name: 'empty', lists: {}, types: {} });
        for (const c of blobs(w, 11, 10, 5)) w.causes.province[c] = -1;
      },
      fillUnassigned,
      fillUnassignedPlain,
    );
  });

  it('陆海改变后修补（成片翻转、陆地多少变化）', () => {
    compare(
      w,
      () => {
        const cells = blobs(w, 5, 12, 5);
        cells.forEach((c, k) => (w.causes.land[c] = k % 3 ? 1 : 0));
      },
      repairProvinces,
      repairPlain,
    );
    // 陆地多少滑块（不重置）：一边多出成片陆地，一边大片陆地沉入海里
    for (const landFraction of [0.45, 0.2]) {
      compare(
        w,
        () => {
          w.small.terrain.gen = { ...w.small.terrain.gen!, landFraction };
          resolveTerrain(w);
        },
        repairProvinces,
        repairPlain,
      );
    }
    resolveTerrain(w);
  });
});
