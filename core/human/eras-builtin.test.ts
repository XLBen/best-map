import { describe, expect, it } from 'vitest';
import { digest } from '../../tools/hash';
import { Engine } from '../engine';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES, ERA_PACKS, VALUE_ERAS } from '../packs/eras';
import { eraValues } from '../packs/builtin-tree';
import { BUILTIN_STYLES } from '../packs/names';

import { continents, engineFor, humanExec } from '../testing/fixtures';
import type { World } from '../world';
import { type Culture, type CultureGroup, type Era, cultureGroupSchema, cultureSchema, eraSchema, popValueSchema, weightedList } from './era';
import { dryLandKm2 } from './generate';
import { readComp } from './groups';
import { humanLegend } from './layers';

import { classAt } from './terrain-class';
import { worldCultures, worldDimensions } from './era';
import { DEFAULT_SPECIES } from '../packs/nature';
import { BUILTIN_CLASSES, FANTASY_RESOURCES, GENERAL_RESOURCES } from '../packs/base';

// 第二十二轮 内容：内置的 6 个时代、维度的取值、文化组、文化——格式、引用、倾向写全、颜色分得开；
// 每个时代按默认生成人文：不出错、总人口按默认密度、各组住在喜欢的地方、各维成片、确定性、地名跟着文化

// 一个文化组能用在哪些时代（第三十轮：时代包里默认带的组）：只在奇幻、科幻的包里的（精灵、异星种族……）只用在那个时代，
// 地球上的组（历史上的时代带的、“通用 ▸ 文化”里的）哪个时代都能用
const HISTORY = ['antiquity', 'medieval', 'industrial', 'modern'];
const inPack = (era: Era, g: CultureGroup) => ERA_PACKS.get(era.id)!.cultures.some(([id]) => id === g.id);
const earthly = (g: CultureGroup) => BUILTIN_ERAS.every((e) => !inPack(e, g)) || BUILTIN_ERAS.some((e) => HISTORY.includes(e.id) && inPack(e, g));
const allowed = (era: Era, g: CultureGroup) => earthly(g) || inPack(era, g);
const groupOf = (c: Culture) => BUILTIN_CULTURE_GROUPS.find((g) => g.id === c.group)!;
const erasOf = (g: CultureGroup) => BUILTIN_ERAS.filter((e) => allowed(e, g));
const valuesOf = (era: Era, dim: string) => eraValues(era, dim);
const defaults = (era: Era) => weightedList(ERA_PACKS.get(era.id)!.cultures).map(([id, weight]) => ({ id, weight }));

const CLASS_IDS = new Set(BUILTIN_CLASSES.map((c) => c.id));
const BIOME_IDS = new Set(DEFAULT_SPECIES.map((s) => s.id));
const TERRAIN_TAGS = new Set(DEFAULT_SPECIES.map((s) => s.terrain));
const STYLE_IDS = new Set(BUILTIN_STYLES.map((s) => s.id));
const RESOURCE_IDS = new Set([...GENERAL_RESOURCES, ...FANTASY_RESOURCES].map((r) => r.id));

// CIE76 色差（Lab）
function lab(hex: string): [number, number, number] {
  const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((c[0] * 0.4124 + c[1] * 0.3576 + c[2] * 0.1805) / 0.95047);
  const y = f(c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722);
  const z = f((c[0] * 0.0193 + c[1] * 0.1192 + c[2] * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function closest(items: readonly { id: string; color: string }[]): { d: number; pair: string } {
  let best = { d: Infinity, pair: '' };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = lab(items[i].color);
      const b = lab(items[j].color);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < best.d) best = { d, pair: `${items[i].id}~${items[j].id}` };
    }
  return best;
}

describe('内置的时代与文化：格式与引用', () => {
  it('6 个时代；每一项都合格，id、名字不重复', () => {
    expect(BUILTIN_ERAS.map((e) => e.id)).toEqual(['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi']);
    const check = <T extends { id: string; name: string }>(list: readonly T[], parse: (x: unknown) => T) => {
      for (const x of list) expect(parse(JSON.parse(JSON.stringify(x))), x.id).toEqual(x);
      expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    };
    check(BUILTIN_ERAS, (x) => eraSchema.parse(x));
    check(BUILTIN_POP_VALUES, (x) => popValueSchema.parse(x));
    check(BUILTIN_CULTURE_GROUPS, (x) => cultureGroupSchema.parse(x));
    check(BUILTIN_CULTURES, (x) => cultureSchema.parse(x));
    for (const list of [BUILTIN_ERAS, BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES]) expect(new Set(list.map((x) => x.name)).size).toBe(list.length);
    // 同一维、同一个时代里取值的名字不重复
    for (const era of BUILTIN_ERAS)
      for (const dim of era.dimensions) {
        const names = valuesOf(era, dim.id).map((v) => v.name);
        expect(new Set(names).size, `${era.id}/${dim.id}`).toBe(names.length);
      }
    for (const x of [...BUILTIN_ERAS, ...BUILTIN_POP_VALUES, ...BUILTIN_CULTURE_GROUPS, ...BUILTIN_CULTURES]) expect(x.description?.length ?? 0, x.id).toBeGreaterThan(5);
  });

  it('时代：每一维至少两种取值，维度的名字不重复；默认的文化组都能用；资源都有', () => {
    for (const era of BUILTIN_ERAS) {
      expect(era.dimensions.length, era.id).toBeGreaterThan(0);
      expect(new Set(era.dimensions.map((d) => d.label)).size).toBe(era.dimensions.length);
      for (const dim of era.dimensions) {
        expect(dim.required, `${era.id}/${dim.id}`).toBe(true);
        expect(valuesOf(era, dim.id).length, `${era.id}/${dim.id}`).toBeGreaterThanOrEqual(2);
        expect(valuesOf(era, dim.id).length, `${era.id}/${dim.id}`).toBeLessThanOrEqual(16);
      }
      const def = defaults(era);
      expect(def.length, era.id).toBeGreaterThanOrEqual(3);
      for (const { id } of def) expect(BUILTIN_CULTURE_GROUPS.some((g) => g.id === id && allowed(era, g)), `${era.id}: ${id}`).toBe(true);
      for (const r of ERA_PACKS.get(era.id)!.resources ?? []) expect(RESOURCE_IDS, `${era.id}: ${r}`).toContain(r);
    }
  });

  it('所有内置的内容（时代、取值、文化组、文化、资源）里的条件只引用有的地形类别、生态与生态的地形（第二十七轮）', () => {
    const found: string[] = [];
    const walk = (owner: string, v: unknown) => {
      if (Array.isArray(v)) v.forEach((x) => walk(owner, x));
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (Array.isArray(o.classes)) for (const c of o.classes) (CLASS_IDS.has(c) ? null : found.push(`${owner}: 类别 ${c}`));
        if (Array.isArray(o.biomes)) for (const b of o.biomes) (BIOME_IDS.has(b) ? null : found.push(`${owner}: 生态 ${b}`));
        if (Array.isArray(o.terrain)) for (const t of o.terrain) (TERRAIN_TAGS.has(t) ? null : found.push(`${owner}: 地形 ${t}`));
        for (const [k, x] of Object.entries(o)) if (typeof x === 'object') walk(`${owner}.${k}`, x);
      }
    };
    for (const e of BUILTIN_ERAS) walk(`时代 ${e.id}`, e);
    for (const v of BUILTIN_POP_VALUES) walk(`取值 ${v.id}`, v);
    for (const g of BUILTIN_CULTURE_GROUPS) walk(`文化组 ${g.id}`, g);
    for (const c of BUILTIN_CULTURES) walk(`文化 ${c.id}`, c);
    for (const r of [...GENERAL_RESOURCES, ...FANTASY_RESOURCES]) walk(`资源 ${r.id}`, r);
    expect(found).toEqual([]);
    // 内置的地形类别只有起伏的 5 种，规则里不按类别
    expect([...CLASS_IDS]).toEqual(['plains', 'hills', 'highlands', 'mountains', 'peaks']);
    for (const c of BUILTIN_CLASSES) for (const r of c.rules) expect(r.classes ?? r.terrain ?? r.biomes, c.id).toBeUndefined();
  });

  it('取值的时代、文化组的时代、文化的组与地名风格、偏好里的地形类别与生态都认得', () => {
    const eraIds = new Set(BUILTIN_ERAS.map((e) => e.id));
    const dims = new Set(BUILTIN_ERAS.flatMap((e) => e.dimensions.map((d) => d.id)));
    const prefsOk = (owner: string, prefs: readonly { classes?: string[]; biomes?: string[]; terrain?: string[] }[] | undefined) => {
      for (const p of prefs ?? []) {
        for (const c of p.classes ?? []) expect(CLASS_IDS, `${owner}: ${c}`).toContain(c);
        for (const b of p.biomes ?? []) expect(BIOME_IDS, `${owner}: ${b}`).toContain(b);
        for (const t of p.terrain ?? []) expect(TERRAIN_TAGS, `${owner}: ${t}`).toContain(t);
      }
    };
    for (const v of BUILTIN_POP_VALUES) {
      expect(dims, v.id).toContain(v.dimension);
      const eras = VALUE_ERAS.get(v.id) ?? [];
      expect(eras.length, `${v.id} 写明放进哪几个时代的包`).toBeGreaterThan(0);
      for (const e of eras) expect(eraIds, v.id).toContain(e);
      // 取值属于的那一维在它的每个时代里都有
      for (const e of eras) expect(BUILTIN_ERAS.find((x) => x.id === e)!.dimensions.map((d) => d.id), v.id).toContain(v.dimension);
      prefsOk(v.id, v.prefs);
    }
    for (const g of BUILTIN_CULTURE_GROUPS) {
      expect(erasOf(g).length, `${g.id} 至少能用在一个时代`).toBeGreaterThan(0);
      expect(BUILTIN_CULTURES.filter((c) => c.group === g.id).length, g.id).toBeGreaterThanOrEqual(1);
      expect(g.prefs?.length, g.id).toBeGreaterThan(0);
      prefsOk(g.id, g.prefs);
    }
    for (const c of BUILTIN_CULTURES) {
      expect(BUILTIN_CULTURE_GROUPS.map((g) => g.id), c.id).toContain(c.group);
      expect(STYLE_IDS, c.id).toContain(c.nameStyle);
      prefsOk(c.id, c.prefs);
      // 倾向的键是维度，取值属于这一维（政体的倾向 government 在 governments-builtin.test.ts 里查）
      for (const [dim, list] of Object.entries(c.tendencies ?? {}))
        for (const [id] of dim === 'government' ? [] : weightedList(list)) {
          const v = BUILTIN_POP_VALUES.find((x) => x.id === id);
          expect(v, `${c.id}: ${id}`).toBeDefined();
          expect(v!.dimension, `${c.id}: ${id}`).toBe(dim);
          // 写了的取值至少在这个文化能用的一个时代里有
          expect(erasOf(groupOf(c)).some((e) => VALUE_ERAS.get(v!.id)?.includes(e.id)), `${c.id}: ${id}`).toBe(true);
        }
    }
  });

  it('每个文化在它能用的每个时代的每一维都写了倾向（不靠平分）', () => {
    let pairs = 0;
    for (const c of BUILTIN_CULTURES)
      for (const era of erasOf(groupOf(c)))
        for (const dim of era.dimensions) {
          const known = new Set(valuesOf(era, dim.id).map((v) => v.id));
          const list = weightedList(c.tendencies?.[dim.id]).filter(([id, w]) => known.has(id) && w > 0);
          expect(list.length, `${c.id} 在“${era.name}”的${dim.label}`).toBeGreaterThan(0);
          pairs++;
        }
    expect(pairs).toBeGreaterThan(300);
  });

  it('27 种内置地名风格都有文化在用', () => {
    expect(new Set(BUILTIN_CULTURES.map((c) => c.nameStyle))).toEqual(STYLE_IDS);
  });

  it('颜色分得开：同一个时代能用的文化组、文化，同一维的取值，同一组里的文化', () => {
    for (const era of BUILTIN_ERAS) {
      const groups = BUILTIN_CULTURE_GROUPS.filter((g) => allowed(era, g));
      const g = closest(groups);
      expect(g.d, `${era.id} 文化组 ${g.pair}`).toBeGreaterThan(18);
      const c = closest(BUILTIN_CULTURES.filter((x) => groups.includes(groupOf(x))));
      expect(c.d, `${era.id} 文化 ${c.pair}`).toBeGreaterThan(14);
      for (const dim of era.dimensions) {
        const v = closest(valuesOf(era, dim.id));
        expect(v.d, `${era.id}/${dim.id} ${v.pair}`).toBeGreaterThan(18);
      }
    }
    for (const g of BUILTIN_CULTURE_GROUPS) {
      const c = closest(BUILTIN_CULTURES.filter((x) => x.group === g.id));
      expect(c.d, `${g.id} ${c.pair}`).toBeGreaterThan(18);
    }
    const e = closest(BUILTIN_ERAS.map((x) => ({ id: x.id, color: x.color! })));
    expect(e.d, e.pair).toBeGreaterThan(18);
    // 文化组、文化在地图上看得清：不太暗、不太亮、不是灰的
    for (const x of [...BUILTIN_CULTURE_GROUPS, ...BUILTIN_CULTURES]) {
      const [l, a, b] = lab(x.color);
      expect(l, x.id).toBeGreaterThan(28);
      expect(l, x.id).toBeLessThan(86);
      expect(Math.hypot(a, b), x.id).toBeGreaterThan(18);
    }
  });
});

// ---------- 按默认生成 ----------

const generated = new Map<string, Engine>();
function peopled(era: Era): Engine {
  let e = generated.get(era.id);
  if (!e) {
    e = continents();
    humanExec(e, { op: 'generate_human', era: era.id, groups: defaults(era) });
    generated.set(era.id, e);
  }
  return e;
}

// 每个文化组的人口里，满足 test 的格占多少（按人数）
function shareWhere(w: World, groups: readonly string[] | null, test: (i: number) => boolean): number {
  const cultures = worldCultures(w.small);
  let all = 0;
  let hit = 0;
  for (let i = 0; i < w.mesh.n; i++) {
    const p = w.causes.popTotal![i];
    if (!(p > 0)) continue;
    if (groups && !groups.includes(cultures[w.derived.popCulture![i] - 1]?.group)) continue;
    all += p;
    if (test(i)) hit += p;
  }
  return hit / all;
}
const isClass = (w: World, ids: string[]) => (i: number) => ids.includes(classAt(w.small, w.derived.terrainClass[i])?.id ?? '');
// 生态的地形（第二十七轮：森林、荒漠、草原是生态的事）
const isTerrain = (w: World, ts: string[]) => (i: number) => ts.includes(w.small.species[w.derived.dominant[i]]?.terrain ?? '');
const isCoast = (w: World) => (i: number) => {
  for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return true;
  return false;
};

// 相邻的有人的两格这一维的主流取值相同的比例
function coherence(w: World, k: number): number {
  const n = w.mesh.n;
  const v = w.derived.popValue!.subarray(k * n, (k + 1) * n);
  let same = 0;
  let all = 0;
  for (let i = 0; i < n; i++) {
    if (!(w.causes.popTotal![i] > 0)) continue;
    for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) {
      const j = w.mesh.adj[e];
      if (!(w.causes.popTotal![j] > 0)) continue;
      all++;
      if (v[i] === v[j]) same++;
    }
  }
  return same / all;
}

describe('每个时代按默认生成人文', () => {
  for (const era of BUILTIN_ERAS) {
    it(`${era.name}：不出错；总人口按默认密度；默认的组都有人；各维有好几种、成片；地名跟着文化`, () => {
      const w = peopled(era).world;
      const target = era.popDensity * dryLandKm2(w, w.derived);
      let total = 0;
      for (let i = 0; i < w.mesh.n; i++) total += w.causes.popTotal![i];
      expect(Math.abs(total - target) / target).toBeLessThan(0.3);
      const legend = humanLegend(w, 'cultureGroup');
      for (const { id } of defaults(era)) expect(legend.map((x) => x.id), id).toContain(id);
      // 组里的文化大多有人
      const cultures = humanLegend(w, 'culture');
      expect(cultures.length / worldCultures(w.small).length).toBeGreaterThan(0.8);
      // 每一维：有好几种取值，成片
      worldDimensions(w.small).forEach((dim, k) => {
        expect(humanLegend(w, dim.id).length, dim.id).toBeGreaterThanOrEqual(3);
        expect(coherence(w, k), dim.id).toBeGreaterThan(0.7);
      });
      // 每个群体的每一维都有取值（都是“每人都有”的维度）
      for (const t of Object.values(w.small.popGroups!)) for (const dim of era.dimensions) expect(t.values[dim.id], dim.id).toBeDefined();
      // 地名的风格都是世界里的文化用的
      const styles = new Set(worldCultures(w.small).map((c) => c.nameStyle));
      const used = new Set<string>();
      for (const f of w.derived.features) {
        if (f.style) {
          expect(styles, f.key).toContain(f.style);
          used.add(f.style);
        }
      }
      expect(used.size).toBeGreaterThanOrEqual(3);
    });
  }

  it('青铜时代比中世纪稀、更挤在好地方；现代最满', () => {
    const empty = (id: string) => {
      const w = peopled(BUILTIN_ERAS.find((e) => e.id === id)!).world;
      let dry = 0;
      let sparse = 0;
      let total = 0;
      for (let i = 0; i < w.mesh.n; i++) total += w.causes.popTotal![i];
      const mean = total / dryLandKm2(w, w.derived);
      for (let i = 0; i < w.mesh.n; i++) {
        if (!w.causes.land[i] || w.derived.lake[i] === 1) continue;
        dry++;
        if (w.derived.popDensity![i] < mean * 0.1) sparse++;
      }
      return sparse / dry;
    };
    const ancient = empty('antiquity');
    const medieval = empty('medieval');
    const modern = empty('modern');
    expect(ancient).toBeGreaterThan(medieval);
    expect(medieval).toBeGreaterThan(modern);
    expect(ancient).toBeGreaterThan(0.3);
  });

  it('各组住在喜欢的地方', () => {
    const fantasy = peopled(BUILTIN_ERAS.find((e) => e.id === 'fantasy')!).world;
    const medieval = peopled(BUILTIN_ERAS.find((e) => e.id === 'medieval')!).world;
    const rel = (w: World, groups: string[], test: (i: number) => boolean) => shareWhere(w, groups, test) / shareWhere(w, null, test);
    expect(rel(fantasy, ['dwarves'], isClass(fantasy, ['hills', 'mountains', 'highlands', 'peaks']))).toBeGreaterThan(1.5);
    expect(rel(fantasy, ['elves'], isTerrain(fantasy, ['forest', 'jungle']))).toBeGreaterThan(1.2);
    // 兽人：第三十二轮的地形上约 1.47（以前 1.5 以上）：高地多了，“高地”这一类分得更散
    expect(rel(fantasy, ['orcs'], (i) => isTerrain(fantasy, ['steppe', 'savanna', 'desert'])(i) || isClass(fantasy, ['highlands'])(i))).toBeGreaterThan(1.4);
    expect(rel(fantasy, ['seafolk'], isCoast(fantasy))).toBeGreaterThan(2);
    expect(rel(medieval, ['steppe'], isTerrain(medieval, ['steppe', 'savanna', 'desert']))).toBeGreaterThan(1.3);
    // 种族按偏好：矮人在山地的比例高于在别处
    const dwarfShare = (test: (i: number) => boolean) => {
      let all = 0;
      let dwarf = 0;
      for (let i = 0; i < fantasy.mesh.n; i++) {
        const p = fantasy.causes.popTotal![i];
        if (!(p > 0) || !test(i)) continue;
        for (const x of readComp(fantasy.causes, i)) {
          all += p * x.s;
          if (fantasy.small.popGroups![x.code]?.values.race === 'dwarf') dwarf += p * x.s;
        }
      }
      return dwarf / all;
    };
    const hills = isClass(fantasy, ['hills', 'mountains', 'highlands', 'peaks']);
    expect(dwarfShare(hills)).toBeGreaterThan(2 * dwarfShare((i) => !hills(i)));
  });

  it('同样的世界、同样的参数逐值相同；整个星球上每个时代都生成得出来', () => {
    for (const era of BUILTIN_ERAS) {
      const a = peopled(era).world;
      const b = continents();
      humanExec(b, { op: 'generate_human', era: era.id, groups: defaults(era) });
      expect(digest(b.world.causes.popGroup!), era.id).toBe(digest(a.causes.popGroup!));
      expect(digest(b.world.causes.popTotal!), era.id).toBe(digest(a.causes.popTotal!));
      expect(b.world.small.popGroups, era.id).toEqual(a.small.popGroups);
    }
    const globe = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    globe.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    for (const era of BUILTIN_ERAS) {
      const g = globe.clone();
      humanExec(g, { op: 'generate_human', era: era.id, groups: defaults(era) });
      const w = g.world;
      let total = 0;
      for (let i = 0; i < w.mesh.n; i++) total += w.causes.popTotal![i];
      expect(Math.abs(total / (era.popDensity * dryLandKm2(w, w.derived)) - 1), era.id).toBeLessThan(0.3);
      expect(humanLegend(w, 'cultureGroup').length, era.id).toBe(defaults(era).length);
    }
  });
});
