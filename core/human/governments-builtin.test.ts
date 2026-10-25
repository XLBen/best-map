import { describe, expect, it } from 'vitest';
import { digest } from '../../tools/hash';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from '../packs/eras';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from '../packs/governments';
import { continents } from '../testing/fixtures';
import type { World } from '../world';
import { countryFactions, countryList } from './index';
import { type Culture, type CultureGroup, type Era, weightedList } from './era';
import { FLAG_EMBLEMS, FLAG_LAYOUTS } from './flags';
import { CATEGORY_NAMES, type Government, type Title, factionSchema, governmentById, governmentSchema, pickTitle, titled } from './government';

// 第二十三轮 内容：内置的政体与派系（六个时代各一个文件）——格式、引用、称号的说法、文化的政体倾向；
// 每个时代按默认生成国家：用的是这个时代自己的政体与派系、称号按文化换说法、无主地与国家多少合时代、确定性

const eraOf = (id: string) => BUILTIN_ERAS.find((e) => e.id === id)!;
const govsOf = (era: Era) => era.governments!.map((id) => BUILTIN_GOVERNMENTS.find((g) => g.id === id)!);
const factionsOf = (era: Era) => era.factions!.map((id) => BUILTIN_FACTIONS.find((f) => f.id === id)!);
const allowed = (era: Era, g: CultureGroup) => (!era.cultureGroups || era.cultureGroups.includes(g.id)) && (!g.eras || g.eras.includes(era.id));
const groupOf = (c: Culture) => BUILTIN_CULTURE_GROUPS.find((g) => g.id === c.group)!;
const erasOfCulture = (c: Culture) => BUILTIN_ERAS.filter((e) => allowed(e, groupOf(c)));
const defaults = (era: Era) => weightedList(era.defaultGroups).map(([id, weight]) => ({ id, weight }));
const CULTURE_IDS = new Set(BUILTIN_CULTURES.map((c) => c.id));
const GROUP_IDS = new Set(BUILTIN_CULTURE_GROUPS.map((g) => g.id));

// 称号的每一种写法
function titleForms(t: Title): [string, { zh: string; orig?: string }][] {
  const one = (x: string | { zh: string; orig?: string }) => (typeof x === 'string' ? { zh: x } : x);
  if (typeof t === 'string' || 'zh' in t) return [['default', one(t as string)]];
  return Object.entries(t as Record<string, string | { zh: string; orig?: string }>).map(([k, v]) => [k, one(v)]);
}

// CIE76 色差
function lab(hex: string): [number, number, number] {
  const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((c[0] * 0.4124 + c[1] * 0.3576 + c[2] * 0.1805) / 0.95047);
  const y = f(c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722);
  const z = f((c[0] * 0.0193 + c[1] * 0.1192 + c[2] * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function closest(items: readonly { id: string; color?: string }[]): { d: number; pair: string } {
  let best = { d: Infinity, pair: '' };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = lab(items[i].color!);
      const b = lab(items[j].color!);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < best.d) best = { d, pair: `${items[i].id}~${items[j].id}` };
    }
  return best;
}

// 说明的写法：一两句，不用“真的、直接、其实、系统、一下、真正”
const BANNED = ['真的', '直接', '其实', '系统', '一下', '真正'];
function descOk(x: { id: string; description?: string }) {
  const d = x.description ?? '';
  expect(d.length, x.id).toBeGreaterThan(5);
  expect(d.length, x.id).toBeLessThanOrEqual(50);
  expect(d.endsWith('。'), x.id).toBe(true);
  for (const w of BANNED) expect(d.includes(w), `${x.id}: ${w}`).toBe(false);
}

describe('内置的政体与派系：格式与引用', () => {
  it('每一项都合格，id 不重复；类别都有中文名；说明克制；旗帜的偏好认得', () => {
    const check = <T extends { id: string }>(list: readonly T[], parse: (x: unknown) => T) => {
      for (const x of list) expect(parse(JSON.parse(JSON.stringify(x))), x.id).toEqual(x);
      expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    };
    check(BUILTIN_GOVERNMENTS, (x) => governmentSchema.parse(x));
    check(BUILTIN_FACTIONS, (x) => factionSchema.parse(x));
    expect(new Set(BUILTIN_GOVERNMENTS.map((g) => g.name)).size).toBe(BUILTIN_GOVERNMENTS.length);
    for (const g of BUILTIN_GOVERNMENTS) {
      for (const c of g.category) expect(CATEGORY_NAMES, `${g.id}: ${c}`).toHaveProperty(c);
      descOk(g);
      expect(g.color, g.id).toBeDefined();
      expect(g.eras?.length, `${g.id} 写明在哪几个时代里有`).toBeGreaterThan(0);
      expect(g.weight, g.id).toBeGreaterThan(0);
      for (const e of g.emblems ?? []) expect(FLAG_EMBLEMS, g.id).toContain(e);
      for (const l of g.layouts ?? []) expect(FLAG_LAYOUTS, g.id).toContain(l);
    }
    for (const f of BUILTIN_FACTIONS) {
      descOk(f);
      expect(f.eras?.length, `${f.id} 写明在哪几个时代里有`).toBeGreaterThan(0);
      for (const k of Object.keys(f.base)) if (k !== 'default') expect(CATEGORY_NAMES, `${f.id}: ${k}`).toHaveProperty(k);
    }
  });

  it('称号：键是文化、文化组或 default，都有 default；中文最多一个 {name}，原文都有 {name}；统治者的称号也一样', () => {
    for (const g of BUILTIN_GOVERNMENTS) {
      for (const t of [g.title, g.rulerTitle].filter((x): x is Title => !!x)) {
        const forms = titleForms(t);
        expect(forms.some(([k]) => k === 'default'), g.id).toBe(true);
        for (const [k, v] of forms) {
          if (k !== 'default') expect(CULTURE_IDS.has(k) || GROUP_IDS.has(k), `${g.id}: ${k}`).toBe(true);
          expect(v.zh.split('{name}').length, `${g.id}/${k}`).toBeLessThanOrEqual(2);
          if (v.orig !== undefined) expect(v.orig.split('{name}').length, `${g.id}/${k}: ${v.orig}`).toBe(2);
        }
      }
      // 统治者的称号只写中文
      if (g.rulerTitle) for (const [k, v] of titleForms(g.rulerTitle)) expect(v.orig, `${g.id}/${k}`).toBeUndefined();
    }
    // 几个按文化换说法的例子
    const gov = (id: string) => BUILTIN_GOVERNMENTS.find((g) => g.id === id)!;
    expect(pickTitle(gov('shogunate').title, { id: 'yamato', group: 'eastern' })!.zh).toBe('幕府');
    expect(pickTitle(gov('shogunate').title, { id: 'huaxia', group: 'eastern' })!.zh).toBe('国');
    expect(pickTitle(gov('nomad-khanate').title, { id: 'turkic', group: 'steppe' })!.zh).toBe('汗国');
    expect(pickTitle(gov('sultanate').title, { id: 'arab', group: 'mideast' })!.zh).toBe('苏丹国');
    expect(pickTitle(gov('sultanate').title, { id: 'anglic', group: 'western' })!.zh).toBe('王国');
    expect(pickTitle(gov('theocracy').title, { id: 'arab', group: 'mideast' })!.zh).toBe('哈里发国');
    expect(pickTitle(gov('orc-horde').title, { id: 'greymane', group: 'orcs' })!.zh).toBe('大部落');
    expect(pickTitle(gov('dwarven-hold').title, { id: 'anvil', group: 'dwarves' })!.zh).toBe('氏族王国');
    expect(pickTitle(gov('hive-collective').title, { id: 'kar-hive', group: 'chitin' })!.zh).toBe('巢群');
    expect(pickTitle(gov('empire').rulerTitle, { id: 'chagan', group: 'steppe' })!.zh).toBe('大汗');
    expect(titled({ zh: '薇亚诺尔', orig: 'Vianor' }, pickTitle(gov('elven-council').title, { id: 'sylvan', group: 'elves' }))).toEqual({ zh: '薇亚诺尔之境', orig: 'Realm of Vianor' });
  });

  it('每个时代列着 5 种以上政体、3 个以上派系（都是写了这个时代的内置项），还有 countryKm2 与 years；每个内置项都有时代在用', () => {
    for (const era of BUILTIN_ERAS) {
      expect(era.governments?.length, era.id).toBeGreaterThanOrEqual(5);
      expect(era.factions?.length, era.id).toBeGreaterThanOrEqual(3);
      expect(new Set(era.governments).size, era.id).toBe(era.governments!.length);
      expect(new Set(era.factions).size, era.id).toBe(era.factions!.length);
      for (const g of govsOf(era)) expect(g?.eras, `${era.id}`).toContain(era.id);
      for (const f of factionsOf(era)) expect(f?.eras, `${era.id}`).toContain(era.id);
      expect(era.countryKm2, era.id).toBeGreaterThan(0);
      expect(era.years![0], era.id).toBeLessThan(era.years![1]);
      // 同一个时代的政体、派系：名字不重复，颜色分得开
      expect(new Set(govsOf(era).map((g) => g.name)).size, era.id).toBe(era.governments!.length);
      expect(new Set(factionsOf(era).map((f) => f.name)).size, era.id).toBe(era.factions!.length);
      const cg = closest(govsOf(era));
      expect(cg.d, `${era.id} 政体 ${cg.pair}`).toBeGreaterThan(12);
      const cf = closest(factionsOf(era));
      expect(cf.d, `${era.id} 派系 ${cf.pair}`).toBeGreaterThan(18);
    }
    for (const g of BUILTIN_GOVERNMENTS) for (const e of g.eras!) expect(eraOf(e)?.governments, `${g.id}: ${e}`).toContain(g.id);
    for (const f of BUILTIN_FACTIONS) for (const e of f.eras!) expect(eraOf(e)?.factions, `${f.id}: ${e}`).toContain(f.id);
    // 国家的平均大小：青铜与古典小国林立，现代比中世纪小
    expect(eraOf('antiquity').countryKm2!).toBeLessThan(eraOf('medieval').countryKm2!);
    expect(eraOf('modern').countryKm2!).toBeLessThan(eraOf('medieval').countryKm2!);
  });

  it('派系的来源：维度、取值、文化、文化组都认得，取值在派系的某个时代里有', () => {
    for (const f of BUILTIN_FACTIONS)
      for (const d of f.drivers ?? []) {
        if (d.dimension || d.value) {
          const v = BUILTIN_POP_VALUES.find((x) => x.id === d.value);
          expect(v, `${f.id}: ${d.value}`).toBeDefined();
          expect(v!.dimension, `${f.id}: ${d.value}`).toBe(d.dimension);
          expect(f.eras!.some((e) => (!v!.eras || v!.eras.includes(e)) && eraOf(e).dimensions.some((x) => x.id === d.dimension)), `${f.id}: ${d.value}`).toBe(true);
        }
        if (d.culture) expect(CULTURE_IDS, f.id).toContain(d.culture);
        if (d.cultureGroup) expect(GROUP_IDS, f.id).toContain(d.cultureGroup);
      }
  });

  it('文化的政体倾向：都是内置的政体，且在这个文化能用的某个时代里有；每个文化组都写了', () => {
    for (const c of BUILTIN_CULTURES) {
      const list = weightedList(c.tendencies?.government);
      expect(list.length, `${c.id} 有政体倾向`).toBeGreaterThan(0);
      const eras = erasOfCulture(c);
      for (const [id, w] of list) {
        const g = BUILTIN_GOVERNMENTS.find((x) => x.id === id);
        expect(g, `${c.id}: ${id}`).toBeDefined();
        expect(w, `${c.id}: ${id}`).toBeGreaterThan(0);
        expect(eras.some((e) => e.governments!.includes(id)), `${c.id}: ${id}`).toBe(true);
      }
      expect(new Set(list.map(([id]) => id)).size, c.id).toBe(list.length);
      // 写了某个时代的政体时至少写两种（不然这个时代的国家全是同一种）
      for (const e of eras) {
        const own = list.filter(([id]) => e.governments!.includes(id));
        if (own.length) expect(own.length, `${c.id} / ${e.id}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

// ---------- 生成 ----------

const generated = new Map<string, World>();
function generate(eraId: string): World {
  let w = generated.get(eraId);
  if (!w) {
    const eng = continents();
    eng.exec({ op: 'generate_human', era: eraId, groups: defaults(eraOf(eraId)), countries: {} });
    generated.set(eraId, (w = eng.world));
  }
  return w;
}
// 干陆地里有国家的比例
function ownedShare(w: World): number {
  let land = 0;
  let owned = 0;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!w.causes.land[i] || w.derived.lake[i] === 1) continue;
    land++;
    if (w.causes.country![i] >= 0) owned++;
  }
  return owned / land;
}
const cultureOf = (w: World, id: string) => w.small.content!.culture![id] as Culture;

describe('内置的政体与派系：每个时代生成国家', () => {
  for (const era of BUILTIN_ERAS)
    it(`${era.name}：只用这个时代的政体与派系，称号按文化换说法，建国年份在时代里`, () => {
      const w = generate(era.id);
      const list = countryList(w.small);
      expect(list.length, era.id).toBeGreaterThan(5);
      // 世界里复制进来的政体、派系就是时代列着的
      expect(Object.keys(w.small.content!.government!).sort()).toEqual([...era.governments!].sort());
      expect(Object.keys(w.small.content!.faction!).sort()).toEqual([...era.factions!].sort());
      const used = new Set<string>();
      for (const m of list) {
        expect(era.governments, m.name).toContain(m.government);
        used.add(m.government);
        const g = governmentById(w.small, m.government) as Government;
        const c = cultureOf(w, m.primaryCulture);
        const t = pickTitle(g.title, c)!;
        expect(m.name).toBe(titled(m.base, t).zh);
        if (g.rulerTitle) expect(m.ruler.title).toBe(pickTitle(g.rulerTitle, c)!.zh);
        expect(m.founded).toBeGreaterThanOrEqual(era.years![0]);
        expect(m.founded).toBeLessThanOrEqual(era.years![1]);
        const fs = countryFactions(w, m.id);
        expect(fs.map((f) => f.id)).toEqual(era.factions);
        expect(fs.reduce((a, f) => a + f.influence, 0)).toBeCloseTo(1, 2);
      }
      // 不止一两种政体
      expect(used.size, era.id).toBeGreaterThanOrEqual(4);
    });

  it('无主地与国家多少合时代：青铜与古典国家多、无主地多；现代几乎占满', () => {
    const share = Object.fromEntries(BUILTIN_ERAS.map((e) => [e.id, ownedShare(generate(e.id))]));
    const count = (id: string) => countryList(generate(id).small).length;
    expect(share.antiquity).toBeLessThan(share.medieval);
    expect(share.modern).toBeGreaterThan(share.medieval);
    expect(share.modern).toBeGreaterThan(0.85);
    expect(count('antiquity')).toBeGreaterThan(count('medieval'));
    expect(count('modern')).toBeGreaterThan(count('medieval'));
  });

  it('文化的倾向起作用：草原多游牧的政体，奇幻的种族多用自己的政体，科幻的异星种族多是蜂巢意志', () => {
    // 一个地区只有几国：按三个种子合起来数
    const share = (eraId: string, groups: string[], govs: string[]) => {
      let all = 0;
      let hit = 0;
      for (const seed of [0, 11, 23]) {
        let w = generate(eraId);
        if (seed) {
          const eng = continents();
          eng.exec({ op: 'generate_human', era: eraId, groups: defaults(eraOf(eraId)), countries: { seed } });
          w = eng.world;
        }
        const mine = countryList(w.small).filter((m) => groups.includes(cultureOf(w, m.primaryCulture).group));
        all += mine.length;
        hit += mine.filter((m) => govs.includes(m.government)).length;
      }
      expect(all, `${eraId}: ${groups}`).toBeGreaterThan(2);
      return hit / all;
    };
    expect(share('antiquity', ['steppe'], ['nomad-confederation', 'tribal-confederation'])).toBeGreaterThan(0.5);
    expect(share('medieval', ['steppe'], ['nomad-khanate', 'tribal-confederation', 'empire'])).toBeGreaterThan(0.5);
    expect(share('fantasy', ['elves', 'dwarves', 'orcs', 'emberkin'], ['elven-council', 'dwarven-hold', 'orc-horde', 'dragon-lordship'])).toBeGreaterThan(0.5);
    // 甲巢诸族也常是军事政府
    expect(share('scifi', ['lithic', 'sporal', 'chitin'], ['hive-collective'])).toBeGreaterThan(0.35);
    expect(share('scifi', ['lithic', 'sporal', 'chitin'], ['hive-collective', 'military-government'])).toBeGreaterThan(0.5);
  });

  it('同样的参数同样的结果', () => {
    for (const id of ['antiquity', 'scifi']) {
      const eng = continents();
      eng.exec({ op: 'generate_human', era: id, groups: defaults(eraOf(id)), countries: {} });
      const a = generate(id);
      expect(digest(eng.world.causes.country)).toBe(digest(a.causes.country));
      expect(digest(eng.world.small.countries)).toBe(digest(a.small.countries));
    }
  });
});
