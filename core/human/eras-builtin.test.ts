import { describe, expect, it } from 'vitest';
import { digest } from '../../tools/hash';
import { Engine } from '../engine';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES, BUILTIN_VALUE_GROUPS, CULTURE_REGIONS, ERA_PACKS, VALUE_ERAS } from '../packs/eras';
import { eraValues } from '../packs/builtin-tree';
import { BUILTIN_STYLES } from '../packs/names';

import { continents, engineFor, humanExec } from '../testing/fixtures';
import type { World } from '../world';
import { type Culture, type CultureGroup, type Era, cultureGroupSchema, cultureSchema, cultureTendency, eraSchema, popValueSchema, valueGroupSchema, weightedList } from './era';
import { dryLandKm2 } from './generate';
import { readComp } from './groups';
import { humanLegend } from './layers';

import { classAt } from './terrain-class';
import { worldCultures, worldDimensions } from './era';
import { DEFAULT_SPECIES } from '../packs/nature';
import { BUILTIN_CLASSES, FANTASY_RESOURCES, GENERAL_RESOURCES } from '../packs/base';

// 第二十二轮 内容：内置的 6 个时代、维度的取值、文化组、文化——格式、引用、倾向写全、颜色分得开；
// 每个时代按默认生成人文：不出错、总人口按默认密度、各组住在喜欢的地方、各维成片、确定性、地名跟着文化。
// 第四十三轮：地球上的是 EU4 1.37 的 71 个文化组、410 个文化（按地区），宗教是 EU4 的 28 种（7 组）加古代的 8 种与现代的无宗教

// 一个文化组能用在哪些时代（第三十轮：时代包里默认带的组）：只在奇幻、科幻的包里的（精灵、异星种族……）只用在那个时代，
// 地球上的组（历史上的时代默认带的、历史库里比重是 0 的）哪个时代都能用
const HISTORY = ['antiquity', 'medieval', 'industrial', 'modern'];
const inPack = (era: Era, g: CultureGroup) => ERA_PACKS.get(era.id)!.cultures.some(([id]) => id === g.id);
const earthly = (g: CultureGroup) => BUILTIN_ERAS.every((e) => !inPack(e, g)) || BUILTIN_ERAS.some((e) => HISTORY.includes(e.id) && inPack(e, g));
const allowed = (era: Era, g: CultureGroup) => earthly(g) || inPack(era, g);
const groupOf = (c: Culture) => BUILTIN_CULTURE_GROUPS.find((g) => g.id === c.group)!;
const erasOf = (g: CultureGroup) => BUILTIN_ERAS.filter((e) => allowed(e, g));
const valuesOf = (era: Era, dim: string) => eraValues(era, dim);
const defaults = (era: Era) => ERA_PACKS.get(era.id)!.cultures.map(([id, weight]) => ({ id, weight }));
const EU4_GROUPS = new Set(CULTURE_REGIONS.flatMap((r) => r.groups));
// 内置的内容拼成的一个“世界”（只有内容）：按组查倾向、风格
const SMALL = { content: { cultureGroup: Object.fromEntries(BUILTIN_CULTURE_GROUPS.map((g) => [g.id, g])) } } as never;
const styleOf = (c: Culture) => c.nameStyle ?? groupOf(c).nameStyle;
// 一个文化在某个时代某一维的倾向（文化的、组的，按时代的先）
const tendencyOf = (c: Culture, dim: string, era: string) => weightedList(cultureTendency(SMALL, c, dim, era));
// HSL 的色相（度）与饱和度
const hueOf = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d + 6) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h, c: s * 100 };
};
const hueGap = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);

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
    check(BUILTIN_VALUE_GROUPS, (x) => valueGroupSchema.parse(x));
    check(BUILTIN_CULTURE_GROUPS, (x) => cultureGroupSchema.parse(x));
    check(BUILTIN_CULTURES, (x) => cultureSchema.parse(x));
    for (const list of [BUILTIN_ERAS, BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_VALUE_GROUPS]) {
      const dup = list.map((x) => x.name).filter((n, k, all) => all.indexOf(n) !== k);
      expect(dup).toEqual([]);
    }
    // 同一维、同一个时代里取值的名字不重复
    for (const era of BUILTIN_ERAS)
      for (const dim of era.dimensions) {
        const names = valuesOf(era, dim.id).map((v) => v.name);
        expect(new Set(names).size, `${era.id}/${dim.id}`).toBe(names.length);
      }
    // 说明：时代、取值、取值组、文化组都写了；EU4 的文化只有名字与原文（奇幻、科幻的照旧写了）
    for (const x of [...BUILTIN_ERAS, ...BUILTIN_POP_VALUES, ...BUILTIN_VALUE_GROUPS, ...BUILTIN_CULTURE_GROUPS, ...BUILTIN_CULTURES.filter((c) => !EU4_GROUPS.has(c.group))]) expect(x.description?.length ?? 0, x.id).toBeGreaterThan(5);
    // EU4 的文化组与文化都有原文（英文名）
    for (const x of [...BUILTIN_CULTURE_GROUPS.filter((g) => EU4_GROUPS.has(g.id)), ...BUILTIN_CULTURES.filter((c) => EU4_GROUPS.has(c.group))]) expect(x.orig, x.id).toMatch(/^[A-Z]/);
  });

  it('EU4 的文化组：71 组 410 个文化，7 个地区；没有以前虚构的地球文化', () => {
    expect(CULTURE_REGIONS.map((r) => [r.name, r.groups.length])).toEqual([
      ['欧洲', 15],
      ['中东', 3],
      ['非洲', 10],
      ['亚洲', 16],
      ['美洲', 24],
      ['大洋洲', 2],
      ['失落', 1],
    ]);
    expect(EU4_GROUPS.size).toBe(71);
    expect(BUILTIN_CULTURES.filter((c) => EU4_GROUPS.has(c.group)).length).toBe(410);
    // 每个组都在一个地区，地区里的组都有
    for (const g of BUILTIN_CULTURE_GROUPS) expect(EU4_GROUPS.has(g.id) || BUILTIN_ERAS.some((e) => ['fantasy', 'scifi'].includes(e.id) && ERA_PACKS.get(e.id)!.cultures.some(([id]) => id === g.id)), g.id).toBe(true);
    // 以前虚构的 13 个地球文化组、它们的文化与 15 种宗教一个都不在了
    const OLD = ['western', 'eastern', 'steppe', 'nordic', 'slavic', 'mediterranean', 'mideast', 'southasia', 'southeast', 'africa', 'mesoamerica', 'andes', 'oceania', 'anglic', 'frankish', 'teutonic', 'zeven', 'huaxia', 'yamato', 'cheonggu', 'nanming', 'chagan', 'skarn', 'hrafn', 'zorya', 'bereg', 'gorav', 'veturia', 'selos', 'montevi', 'estrella', 'arab', 'darian', 'badiya', 'sindhara', 'devapura', 'malanad', 'sumara', 'lansa', 'mwanga', 'kusini', 'bahari', 'xochitlan', 'itzcala', 'wayna', 'killa', 'waka', 'ranui', 'sun-faith', 'moon-faith', 'ancestor-rites', 'sky-way', 'dawn-church', 'fire-temple', 'awakening', 'many-gods', 'spirit-ways', 'sky-tengri', 'feathered-god', 'northern-gods', 'city-pantheon', 'river-gods', 'secular'];
    const ids = new Set([...BUILTIN_CULTURE_GROUPS, ...BUILTIN_CULTURES, ...BUILTIN_POP_VALUES].map((x) => x.id));
    expect(OLD.filter((id) => ids.has(id))).toEqual([]);
    // 时代包、倾向里也不再提到它们（steppe 还是生态的地形：草原）
    expect(OLD.filter((id) => id !== 'steppe' && JSON.stringify([...ERA_PACKS.values(), BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES]).includes(`"${id}"`))).toEqual([]);
  });

  it('宗教（第四十三轮）：EU4 的 28 种分 7 组，古代 8 种另成一组；每种都有组；各时代只有那时已有的', () => {
    const rel = (era: string) => valuesOf(BUILTIN_ERAS.find((e) => e.id === era)!, 'religion').map((v) => v.id);
    const groupOfValue = (id: string) => BUILTIN_POP_VALUES.find((v) => v.id === id)!.group;
    for (const era of HISTORY)
      for (const id of rel(era)) {
        if (id === 'irreligious') continue;
        const g = groupOfValue(id);
        expect(g, `${era}: ${id}`).toBeDefined();
        expect(BUILTIN_VALUE_GROUPS.find((x) => x.id === g)?.dimension, id).toBe('religion');
      }
    expect(rel('medieval').length).toBe(28);
    // 历史上的宗教组（奇幻的宗教组第四十四轮另查）
    const HISTORY_VG = BUILTIN_VALUE_GROUPS.filter((g) => BUILTIN_POP_VALUES.some((v) => v.group === g.id && HISTORY.some((e) => VALUE_ERAS.get(v.id)?.includes(e))));
    const byGroup = (era: string) => Object.fromEntries(HISTORY_VG.map((g) => [g.id, rel(era).filter((id) => groupOfValue(id) === g.id).length]));
    expect(byGroup('medieval')).toEqual({ christian: 7, muslim: 3, eastern: 5, dharmic: 2, pagan: 9, judaism: 1, 'zoroastrian-group': 1, ancient: 0 });
    // 古代：古代的诸神，没有基督教、伊斯兰教、锡克教、大乘、印度教（吠陀教）
    expect(byGroup('antiquity')).toMatchObject({ christian: 0, muslim: 0, dharmic: 0, ancient: 8 });
    expect(rel('antiquity')).not.toContain('mahayana');
    // 中世纪以后没有古代的；新教、归正宗、圣公会从中世纪与近世（EU4 的 1444–1821）开始；胡斯派只在中世纪
    for (const era of ['medieval', 'industrial', 'modern']) expect(byGroup(era).ancient, era).toBe(0);
    for (const id of ['protestant', 'reformed', 'anglican']) for (const era of ['medieval', 'industrial', 'modern']) expect(rel(era), `${era}: ${id}`).toContain(id);
    expect(rel('industrial')).not.toContain('hussite');
    // 阿兹特克、印加、北欧的旧神到近现代就没有了；无宗教只在现代
    for (const id of ['nahuatl-faith', 'inti', 'norse-pagan']) expect(rel('industrial'), id).not.toContain(id);
    expect(HISTORY.filter((e) => rel(e).includes('irreligious'))).toEqual(['modern']);
  });

  it('时代：每一维至少两种取值，维度的名字不重复；默认的文化组都能用；资源都有', () => {
    for (const era of BUILTIN_ERAS) {
      expect(era.dimensions.length, era.id).toBeGreaterThan(0);
      expect(new Set(era.dimensions.map((d) => d.label)).size).toBe(era.dimensions.length);
      for (const dim of era.dimensions) {
        expect(dim.required, `${era.id}/${dim.id}`).toBe(true);
        expect(valuesOf(era, dim.id).length, `${era.id}/${dim.id}`).toBeGreaterThanOrEqual(2);
        expect(valuesOf(era, dim.id).length, `${era.id}/${dim.id}`).toBeLessThanOrEqual(32);
      }
      const def = defaults(era);
      expect(def.length, era.id).toBeGreaterThanOrEqual(3);
      for (const { id } of def) expect(BUILTIN_CULTURE_GROUPS.some((g) => g.id === id && allowed(era, g)), `${era.id}: ${id}`).toBe(true);
      for (const [g, , opt] of ERA_PACKS.get(era.id)!.cultures) for (const c of opt?.except ?? []) expect(BUILTIN_CULTURES.find((x) => x.id === c)?.group, `${era.id}: ${c}`).toBe(g);
      for (const r of ERA_PACKS.get(era.id)!.resources ?? []) expect(RESOURCE_IDS, `${era.id}: ${r}`).toContain(r);
    }
    // 殖民地的文化（美利坚人、巴西人……）只在近现代、现代默认带上
    for (const era of ['antiquity', 'medieval']) for (const [g, , opt] of ERA_PACKS.get(era)!.cultures) if (['british', 'french', 'iberian'].includes(g)) expect(opt?.except.length, `${era}: ${g}`).toBeGreaterThan(0);
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

  it('取值的时代与组、文化组的时代、文化的组与地名风格、倾向、偏好里的地形类别与生态都认得', () => {
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
    const dimOk = (owner: string, dim: string, list: unknown, eras: readonly Era[]) => {
      for (const [id] of weightedList(list as never)) {
        const v = BUILTIN_POP_VALUES.find((x) => x.id === id);
        expect(v, `${owner}: ${id}`).toBeDefined();
        expect(v!.dimension, `${owner}: ${id}`).toBe(dim);
        // 写了的取值至少在能用的一个时代里有
        expect(eras.some((e) => VALUE_ERAS.get(v!.id)?.includes(e.id)), `${owner}: ${id}`).toBe(true);
      }
    };
    const tendOk = (owner: string, x: Pick<Culture, 'tendencies' | 'eraTendencies'>, eras: readonly Era[]) => {
      // 倾向的键是维度，取值属于这一维（政体的倾向 government 在 governments-builtin.test.ts 里查）
      for (const [dim, list] of Object.entries(x.tendencies ?? {})) if (dim !== 'government') dimOk(owner, dim, list, eras);
      for (const [era, byDim] of Object.entries(x.eraTendencies ?? {})) {
        expect(eraIds, `${owner}: ${era}`).toContain(era);
        for (const [dim, list] of Object.entries(byDim)) if (dim !== 'government') dimOk(`${owner}@${era}`, dim, list, BUILTIN_ERAS.filter((e) => e.id === era));
      }
    };
    for (const g of BUILTIN_CULTURE_GROUPS) {
      expect(erasOf(g).length, `${g.id} 至少能用在一个时代`).toBeGreaterThan(0);
      expect(BUILTIN_CULTURES.filter((c) => c.group === g.id).length, g.id).toBeGreaterThanOrEqual(1);
      expect(g.prefs?.length, g.id).toBeGreaterThan(0);
      prefsOk(g.id, g.prefs);
      tendOk(g.id, g, erasOf(g));
      // EU4 的文化组都有默认的地名风格
      if (EU4_GROUPS.has(g.id)) expect(STYLE_IDS, g.id).toContain(g.nameStyle);
    }
    for (const c of BUILTIN_CULTURES) {
      expect(BUILTIN_CULTURE_GROUPS.map((g) => g.id), c.id).toContain(c.group);
      expect(STYLE_IDS, c.id).toContain(styleOf(c));
      // 文化写的风格与组的不同才写
      if (c.nameStyle) expect(c.nameStyle, c.id).not.toBe(groupOf(c).nameStyle);
      prefsOk(c.id, c.prefs);
      tendOk(c.id, c, erasOf(groupOf(c)));
    }
  });

  it('每个文化在它能用的每个时代的每一维都有倾向（文化或文化组写的，不靠平分）', () => {
    let pairs = 0;
    for (const c of BUILTIN_CULTURES)
      for (const era of erasOf(groupOf(c))) {
        // 奇幻、科幻里的 EU4 文化不查（第四十四轮起奇幻、科幻的包不再默认带它们，不写这两个时代的种族、宗教……）
        if (!HISTORY.includes(era.id) && EU4_GROUPS.has(c.group) && !ERA_PACKS.get(era.id)!.cultures.some(([id]) => id === c.group)) continue;
        for (const dim of era.dimensions) {
          const known = new Set(valuesOf(era, dim.id).map((v) => v.id));
          const list = tendencyOf(c, dim.id, era.id).filter(([id, w]) => known.has(id) && w > 0);
          expect(list.length, `${c.id} 在“${era.name}”的${dim.label}`).toBeGreaterThan(0);
          pairs++;
        }
      }
    expect(pairs).toBeGreaterThan(3000);
  });

  it('倾向合 EU4：伊比利亚信天主教、东斯拉夫信东正教、伊朗多什叶派、汉信儒教、藏信金刚乘；不列颠中世纪天主教、近现代圣公会', () => {
    const top = (culture: string, era: string) => {
      const c = BUILTIN_CULTURES.find((x) => x.id === culture)!;
      const known = new Set(valuesOf(BUILTIN_ERAS.find((e) => e.id === era)!, 'religion').map((v) => v.id));
      const list = tendencyOf(c, 'religion', era).filter(([id]) => known.has(id));
      return list.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    };
    expect(top('castilian', 'medieval')).toBe('catholic');
    expect(top('muscovite', 'medieval')).toBe('orthodox');
    expect(top('persian', 'industrial')).toBe('shiite');
    expect(top('zhili', 'medieval')).toBe('confucian');
    expect(top('tibetan', 'medieval')).toBe('vajrayana');
    expect(top('siamese', 'medieval')).toBe('theravada');
    expect(top('hindavi', 'medieval')).toBe('hindu');
    expect(top('english', 'medieval')).toBe('catholic');
    expect(top('english', 'industrial')).toBe('anglican');
    expect(top('swedish', 'industrial')).toBe('protestant');
    expect(top('quechua', 'medieval')).toBe('inti');
    expect(top('aztec', 'medieval')).toBe('nahuatl-faith');
    expect(top('yucatec', 'medieval')).toBe('mayan-faith');
    expect(top('cree', 'medieval')).toBe('totemist');
    expect(top('yoruba', 'medieval')).toBe('fetishist');
    expect(top('kulin', 'medieval')).toBe('alcheringa');
    expect(top('khalkha', 'medieval')).toBe('tengri');
    expect(top('amhara', 'medieval')).toBe('coptic');
    expect(top('roman', 'antiquity')).toBe('roman-pagan');
    expect(top('athenian', 'antiquity')).toBe('hellenic');
    expect(top('old-egyptian', 'antiquity')).toBe('egyptian-pagan');
    expect(top('hebrew', 'medieval')).toBe('jewish');
    expect(top('togoku', 'modern')).toBe('shinto');
  });

  it(`${STYLE_IDS.size} 种内置地名风格都有文化（或文化组）在用；EU4 的文化组一组一种`, () => {
    expect(STYLE_IDS.size).toBe(92);
    expect(new Set([...BUILTIN_CULTURES.map(styleOf), ...BUILTIN_CULTURE_GROUPS.map((g) => g.nameStyle).filter(Boolean)])).toEqual(STYLE_IDS);
    const styles = BUILTIN_CULTURE_GROUPS.filter((g) => EU4_GROUPS.has(g.id) && g.id !== 'lost').map((g) => g.nameStyle);
    expect(new Set(styles).size).toBe(styles.length);
  });

  it('颜色分得开：同一个时代默认的文化组、同一地区的文化组、同一维的取值；同一组里的文化是一个色系、彼此分得开', () => {
    for (const era of BUILTIN_ERAS) {
      const groups = defaults(era).map(({ id }) => BUILTIN_CULTURE_GROUPS.find((g) => g.id === id)!);
      const g = closest(groups);
      expect(g.d, `${era.id} 默认的文化组 ${g.pair}`).toBeGreaterThan(10);
      for (const dim of era.dimensions) {
        const v = closest(valuesOf(era, dim.id));
        expect(v.d, `${era.id}/${dim.id} ${v.pair}`).toBeGreaterThan(10);
      }
    }
    for (const r of CULTURE_REGIONS) {
      const g = closest(r.groups.map((id) => BUILTIN_CULTURE_GROUPS.find((x) => x.id === id)!));
      expect(g.d, `${r.name} ${g.pair}`).toBeGreaterThan(8);
    }
    for (const g of BUILTIN_CULTURE_GROUPS) {
      const list = BUILTIN_CULTURES.filter((x) => x.group === g.id);
      const c = closest(list);
      expect(c.d, `${g.id} ${c.pair}`).toBeGreaterThan(EU4_GROUPS.has(g.id) ? 10 : 18);
      // EU4 的组：组里的文化与组的颜色是一个色系（HSL 的色相差不到 20°；很淡的不算）
      if (!EU4_GROUPS.has(g.id)) continue;
      const base = hueOf(g.color);
      for (const x of list) {
        const h = hueOf(x.color);
        if (h.c > 20 && base.c > 20) expect(hueGap(h.h, base.h), `${g.id}/${x.id}`).toBeLessThan(20);
      }
    }
    const e = closest(BUILTIN_ERAS.map((x) => ({ id: x.id, color: x.color! })));
    expect(e.d, e.pair).toBeGreaterThan(18);
    // 文化组、文化在地图上看得清：不太暗、不太亮、不是灰的
    for (const x of [...BUILTIN_CULTURE_GROUPS, ...BUILTIN_CULTURES]) {
      const [l, a, b] = lab(x.color);
      expect(l, x.id).toBeGreaterThan(20);
      expect(l, x.id).toBeLessThan(86);
      expect(Math.hypot(a, b), x.id).toBeGreaterThan(12);
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
      const styles = new Set(worldCultures(w.small).map((c) => c.nameStyle ?? (w.small.content!.cultureGroup![c.group] as CultureGroup).nameStyle));
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
    expect(rel(fantasy, ['dwarven'], isClass(fantasy, ['hills', 'mountains', 'highlands', 'peaks']))).toBeGreaterThan(1.5);
    expect(rel(fantasy, ['elven'], isTerrain(fantasy, ['forest', 'jungle']))).toBeGreaterThan(1.2);
    // 兽人：第三十二轮的地形上约 1.47（以前 1.5 以上）：高地多了，“高地”这一类分得更散；第三十五轮的地形上约 1.38；
    // 第四十四轮约 1.2（沙海、龙裔也住在荒漠与高地）
    expect(rel(fantasy, ['orcish'], (i) => isTerrain(fantasy, ['steppe', 'savanna', 'desert'])(i) || isClass(fantasy, ['highlands'])(i))).toBeGreaterThan(1.15);
    // 第四十四轮：沙海住在干的地方、北境住在冷的地方
    expect(rel(fantasy, ['sandsea'], isTerrain(fantasy, ['desert', 'steppe', 'savanna']))).toBeGreaterThan(1.2);
    expect(rel(fantasy, ['northmark'], (i) => fantasy.derived.tMean[i] < 6)).toBeGreaterThan(1.2);
    expect(rel(fantasy, ['seafolk'], isCoast(fantasy))).toBeGreaterThan(2);
    // 草原民族（第四十三轮：阿尔泰）
    expect(rel(medieval, ['altaic'], isTerrain(medieval, ['steppe', 'savanna', 'desert']))).toBeGreaterThan(1.1);
    // 北欧住在冷的地方、黎凡特住在干的地方（第四十三轮）
    const temp = (w: World, max: number) => (i: number) => w.derived.tMean[i] < max;
    expect(rel(medieval, ['scandinavian'], temp(medieval, 6))).toBeGreaterThan(1.2);
    expect(rel(medieval, ['levantine'], isTerrain(medieval, ['desert', 'steppe', 'savanna']))).toBeGreaterThan(1.1);
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
