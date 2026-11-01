import { describe, expect, it } from 'vitest';
import { digest } from '../../tools/hash';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES, BUILTIN_VALUE_GROUPS, CULTURE_REGIONS } from '../packs/eras';
import { BUILTIN_COUNTRY_TIERS } from '../packs/countries';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from '../packs/governments';
import { continents, humanExec } from '../testing/fixtures';
import { defaultsOf, eraOf, erasOfCulture, factionsOf, govEras, govsOf } from '../testing/eras';
import { ERA_PACKS, VALUE_ERAS } from '../packs/eras';

const govIds = (era: { id: string }) => ERA_PACKS.get(era.id)!.governments;
const facIds = (era: { id: string }) => ERA_PACKS.get(era.id)!.factions;
import type { World } from '../world';
import { countryFactions, countryList, titleContext } from './index';
import { type Culture, cultureTendency, weightedList } from './era';
import { FLAG_EMBLEMS, FLAG_LAYOUTS } from './flags';
import { CATEGORY_NAMES, type Government, type TitleContext, type Title, factionSchema, govTitles, governmentById, governmentSchema, titled } from './government';

// 第二十三轮 内容：内置的政体与派系（六个时代各一个文件）——格式、引用、称号的说法、文化的政体倾向；
// 每个时代按默认生成国家：用的是这个时代自己的政体与派系、称号按文化换说法、无主地与国家多少合时代、确定性

const defaults = defaultsOf;
const CULTURE_IDS = new Set(BUILTIN_CULTURES.map((c) => c.id));
const GROUP_IDS = new Set(BUILTIN_CULTURE_GROUPS.map((g) => g.id));
const VALUE_IDS = new Set(BUILTIN_POP_VALUES.map((v) => v.id));
const VALUE_GROUP_IDS = new Set(BUILTIN_VALUE_GROUPS.map((g) => g.id));
const TIER_IDS = new Set(BUILTIN_COUNTRY_TIERS.map((t) => t.id));
const HISTORY = ['antiquity', 'medieval', 'industrial', 'modern'];
// 内置的内容拼成的一个“世界”（只有内容）：按组查倾向
const SMALL = { content: { cultureGroup: Object.fromEntries(BUILTIN_CULTURE_GROUPS.map((g) => [g.id, g])), popValue: Object.fromEntries(BUILTIN_POP_VALUES.map((v) => [v.id, v])) } } as never;
// 一个文化在一个时代挑称号时看的（不生成：取倾向里这个时代有的权重最大的宗教）
function ctxOf(c: Culture, era: string, tier?: string): TitleContext {
  const known = new Set(BUILTIN_POP_VALUES.filter((v) => v.dimension === 'religion' && VALUE_ERAS.get(v.id)?.includes(era)).map((v) => v.id));
  let best: [string, number] | undefined;
  for (const [id, w] of weightedList(cultureTendency(SMALL, c, 'religion', era))) if (known.has(id) && (!best || w > best[1])) best = [id, w];
  const value = best && BUILTIN_POP_VALUES.find((v) => v.id === best![0]);
  return { ...(tier ? { tier } : {}), tiers: BUILTIN_COUNTRY_TIERS, culture: c.id, group: c.group, values: value ? [value.id] : [], valueGroups: value?.group ? [value.group] : [] };
}
const firstOf = (group: string) => BUILTIN_CULTURES.find((c) => c.group === group)!;
const cultureIn = (id: string) => BUILTIN_CULTURES.find((c) => c.id === id)!;

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
      expect(govEras(g.id)?.length, `${g.id} 写明在哪几个时代里有`).toBeGreaterThan(0);
      expect(g.weight, g.id).toBeGreaterThan(0);
      for (const e of g.emblems ?? []) expect(FLAG_EMBLEMS, g.id).toContain(e);
      for (const l of g.layouts ?? []) expect(FLAG_LAYOUTS, g.id).toContain(l);
    }
    for (const f of BUILTIN_FACTIONS) {
      descOk(f);
      expect(govEras(f.id)?.length, `${f.id} 写明在哪几个时代里有`).toBeGreaterThan(0);
      for (const k of Object.keys(f.base)) if (k !== 'default') expect(CATEGORY_NAMES, `${f.id}: ${k}`).toHaveProperty(k);
    }
  });

  it('称号（第四十三轮，按国家等级）：键是等级或 default；中文最多一个 {name}，原文都有一个 {name}；统治者只写中文；换说法引用的都认得', () => {
    const forms = (owner: string, t: Title, ruler: boolean) => {
      for (const [k, v] of titleForms(t)) {
        expect(k === 'default' || TIER_IDS.has(k), `${owner}: ${k}`).toBe(true);
        expect(v.zh.split('{name}').length, `${owner}/${k}`).toBeLessThanOrEqual(2);
        if (v.orig !== undefined) expect(v.orig.split('{name}').length, `${owner}/${k}: ${v.orig}`).toBe(2);
        if (ruler) expect(v.orig, `${owner}/${k}`).toBeUndefined();
      }
    };
    for (const g of BUILTIN_GOVERNMENTS) {
      forms(g.id, g.titles, false);
      if (g.rulers) forms(g.id, g.rulers, true);
      for (const r of g.names ?? []) {
        expect(r.titles ?? r.rulers, `${g.id} 的一条换说法什么都没写`).toBeDefined();
        for (const id of r.cultures ?? []) expect(CULTURE_IDS, g.id).toContain(id);
        for (const id of r.cultureGroups ?? []) expect(GROUP_IDS, g.id).toContain(id);
        for (const id of r.values ?? []) expect(VALUE_IDS, g.id).toContain(id);
        for (const id of r.valueGroups ?? []) expect(VALUE_GROUP_IDS, g.id).toContain(id);
        if (r.titles) forms(g.id, r.titles, false);
        if (r.rulers) forms(g.id, r.rulers, true);
      }
    }
  });

  it('历史上的四个时代：每种政体给每个 EU4 文化组、每个默认的等级都有国家称号与统治者称号', () => {
    let n = 0;
    for (const era of HISTORY)
      for (const g of govsOf(eraOf(era)))
        for (const r of CULTURE_REGIONS)
          for (const group of r.groups)
            for (const tier of BUILTIN_COUNTRY_TIERS) {
              const t = govTitles(g, ctxOf(firstOf(group), era, tier.id));
              expect(t.title?.zh, `${era}/${g.id}/${group}/${tier.id}`).toBeTruthy();
              expect(t.ruler?.zh, `${era}/${g.id}/${group}/${tier.id}`).toBeTruthy();
              n++;
            }
    expect(n).toBeGreaterThan(10000);
  });

  it('仿 EU4 的说法：按等级、文化组、宗教换称号（第一条满足的起作用，没写这一级时用政体默认的）', () => {
    const gov = (id: string) => BUILTIN_GOVERNMENTS.find((g) => g.id === id)!;
    const at = (gid: string, culture: string, era: string, tier: string) => govTitles(gov(gid), ctxOf(cultureIn(culture), era, tier));
    // 君主制：公国 → 王国 → 帝国
    expect(['medium', 'large', 'empire'].map((t) => at('feudal-monarchy', 'english', 'medieval', t).title!.zh)).toEqual(['公国', '王国', '帝国']);
    expect(['medium', 'large', 'empire'].map((t) => at('feudal-monarchy', 'english', 'medieval', t).ruler!.zh)).toEqual(['公爵', '国王', '皇帝']);
    expect(at('feudal-monarchy', 'castilian', 'medieval', 'large').title).toEqual({ zh: '王国', orig: 'Kingdom of {name}' });
    // 罗斯：公国 → 大公国 → 沙皇国
    expect(['medium', 'large', 'empire'].map((t) => at('despotic-monarchy', 'muscovite', 'medieval', t).title!.zh)).toEqual(['公国', '大公国', '沙皇国']);
    expect(at('despotic-monarchy', 'muscovite', 'medieval', 'empire').ruler!.zh).toBe('沙皇');
    // 穆斯林：埃米尔国 → 苏丹国 → 帝国；伊朗：汗国 → 沙阿国；印度教：罗阇国 → 王国（摩诃罗阇）
    expect(['medium', 'large', 'empire'].map((t) => at('iqta', 'syrian', 'medieval', t).title!.zh)).toEqual(['埃米尔国', '苏丹国', '帝国']);
    expect(at('feudal-monarchy', 'egyptian', 'medieval', 'large').ruler!.zh).toBe('苏丹');
    expect(['medium', 'large'].map((t) => at('despotic-monarchy', 'persian', 'medieval', t).title!.zh)).toEqual(['汗国', '沙阿国']);
    expect(['medium', 'large'].map((t) => at('despotic-monarchy', 'tamil', 'medieval', t).title!.zh)).toEqual(['罗阇国', '王国']);
    expect(['medium', 'large'].map((t) => at('despotic-monarchy', 'tamil', 'medieval', t).ruler!.zh)).toEqual(['罗阇', '摩诃罗阇']);
    // 印度的穆斯林王朝：苏丹国
    expect(at('despotic-monarchy', 'kashmiri', 'medieval', 'large').title!.zh).toBe('苏丹国');
    // 草原：部落 → 汗国 → 大汗国
    expect(['medium', 'large', 'empire'].map((t) => at('steppe-horde', 'khalkha', 'medieval', t).title!.zh)).toEqual(['部落', '汗国', '大汗国']);
    // 神权：主教领 → 大主教领 → 神权国；伊斯兰的是伊玛目国、哈里发国
    expect(['medium', 'large', 'empire'].map((t) => at('theocratic-government', 'tuscan', 'medieval', t).title!.zh)).toEqual(['主教领', '大主教领', '神权国']);
    expect(at('theocratic-government', 'hejazi', 'medieval', 'empire').title!.zh).toBe('哈里发国');
    // 汉：大某（{name} 写在中间）；日本的幕府
    expect(titled({ zh: '明', orig: 'Ming' }, at('celestial-empire', 'zhili', 'medieval', 'empire').title)).toEqual({ zh: '大明', orig: 'Great Ming' });
    expect(at('shogunate', 'togoku', 'medieval', 'large').title!.zh).toBe('幕府');
    // 城邦级：君主制是“领”，共和制是“城邦”
    expect(at('feudal-monarchy', 'english', 'medieval', 'city').title!.zh).toBe('领');
    expect(at('merchant-republic', 'venetian', 'medieval', 'city').title!.zh).toBe('城邦');
    // 现代：按意识形态的政体，称号也按等级
    expect(at('socialist-republic', 'zhili', 'modern', 'medium').title!.zh).toBe('人民共和国');
    expect(at('theocratic-republic', 'persian', 'modern', 'medium').title!.zh).toBe('伊斯兰共和国');
    // 世界里的等级少了：没写的一级按最近的一级
    const two = [{ id: 'big', order: 40 }, { id: 'large', order: 41 }];
    expect(govTitles(gov('feudal-monarchy'), { ...ctxOf(cultureIn('english'), 'medieval'), tier: 'big', tiers: two }).title!.zh).toBe('王国');
    // 奇幻、科幻（第四十四轮）：各族自己的政体按等级起称号，换说法按文化组、文化、宗教组
    expect(['city', 'small', 'medium', 'large', 'empire'].map((t) => govTitles(gov('orc-horde'), ctxOf(firstOf('orcish'), 'fantasy', t)).title!.zh)).toEqual(['战帮', '部落', '大部落', '部众', '大部众']);
    expect(govTitles(gov('orc-horde'), ctxOf(firstOf('goblinoid'), 'fantasy', 'city')).ruler!.zh).toBe('老大');
    expect(['medium', 'large', 'empire'].map((t) => govTitles(gov('dwarven-hold'), ctxOf(firstOf('dwarven'), 'fantasy', t)).title!.zh)).toEqual(['氏族王国', '山下王国', '万山帝国']);
    expect(govTitles(gov('feudal-realm'), ctxOf(firstOf('northmark'), 'fantasy', 'medium')).title!.zh).toBe('海王国');
    expect(govTitles(gov('feudal-realm'), ctxOf(firstOf('sandsea'), 'fantasy', 'large')).ruler!.zh).toBe('大君');
    expect(govTitles(gov('feudal-realm'), ctxOf(firstOf('westmark'), 'fantasy', 'large')).title!.zh).toBe('王国');
    expect(titled({ zh: '薇亚诺尔', orig: 'Vianor' }, govTitles(gov('elven-council'), ctxOf(cultureIn('wood-elf'), 'fantasy', 'medium')).title)).toEqual({ zh: '薇亚诺尔议会国', orig: 'Council of Vianor' });
    expect(govTitles(gov('elven-council'), ctxOf(cultureIn('dark-elf'), 'fantasy', 'medium')).title!.zh).toBe('影庭');
    // 神殿国按宗教组：光明诸神是主教领，自然是圣林，龙是龙殿
    expect(govTitles(gov('temple-state'), ctxOf(firstOf('westmark'), 'fantasy', 'small')).title!.zh).toBe('主教领');
    expect(govTitles(gov('temple-state'), ctxOf(cultureIn('wood-elf'), 'fantasy', 'city')).title!.zh).toBe('圣林');
    expect(govTitles(gov('temple-state'), ctxOf(firstOf('draconic'), 'fantasy', 'city')).title!.zh).toBe('龙殿');
    // 科幻：星区 → 星团 → 联邦 → 星际联邦；星际帝国的爵位按星区、星团、星域
    expect(['small', 'medium', 'large', 'empire'].map((t) => govTitles(gov('galactic-federation'), ctxOf(firstOf('terran'), 'scifi', t)).title!.zh)).toEqual(['星区', '星团联合', '联邦', '星际联邦']);
    expect(['small', 'medium', 'large', 'empire'].map((t) => govTitles(gov('stellar-empire'), ctxOf(firstOf('terran'), 'scifi', t)).ruler!.zh)).toEqual(['星区侯', '星团公', '星王', '星帝']);
    expect(govTitles(gov('hive-collective'), ctxOf(firstOf('chitin'), 'scifi', 'medium')).title!.zh).toBe('巢群');
    expect(govTitles(gov('hive-collective'), ctxOf(firstOf('sporal'), 'scifi', 'medium')).title!.zh).toBe('菌网');
  });

  it('每个时代列着 5 种以上政体、3 个以上派系（都是写了这个时代的内置项），还有 countryKm2 与 years；每个内置项都有时代在用', () => {
    for (const era of BUILTIN_ERAS) {
      expect(govIds(era).length, era.id).toBeGreaterThanOrEqual(5);
      expect(facIds(era).length, era.id).toBeGreaterThanOrEqual(3);
      expect(new Set(govIds(era)).size, era.id).toBe(govIds(era).length);
      expect(new Set(facIds(era)).size, era.id).toBe(facIds(era).length);
      for (const g of govsOf(era)) expect(govEras(g.id), `${era.id}`).toContain(era.id);
      for (const f of factionsOf(era)) expect(govEras(f.id), `${era.id}`).toContain(era.id);
      expect(era.countryKm2, era.id).toBeGreaterThan(0);
      expect(era.years![0], era.id).toBeLessThan(era.years![1]);
      // 同一个时代的政体、派系：名字不重复，颜色分得开
      expect(new Set(govsOf(era).map((g) => g.name)).size, era.id).toBe(govIds(era).length);
      expect(new Set(factionsOf(era).map((f) => f.name)).size, era.id).toBe(facIds(era).length);
      const cg = closest(govsOf(era));
      expect(cg.d, `${era.id} 政体 ${cg.pair}`).toBeGreaterThan(12);
      const cf = closest(factionsOf(era));
      expect(cf.d, `${era.id} 派系 ${cf.pair}`).toBeGreaterThan(18);
    }
    for (const g of BUILTIN_GOVERNMENTS) for (const e of govEras(g.id)!) expect(govIds(eraOf(e)), `${g.id}: ${e}`).toContain(g.id);
    for (const f of BUILTIN_FACTIONS) for (const e of govEras(f.id)!) expect(facIds(eraOf(e)), `${f.id}: ${e}`).toContain(f.id);
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
          expect(govEras(f.id)!.some((e) => (VALUE_ERAS.get(v!.id) ?? []).includes(e) && eraOf(e).dimensions.some((x) => x.id === d.dimension)), `${f.id}: ${d.value}`).toBe(true);
        }
        if (d.culture) expect(CULTURE_IDS, f.id).toContain(d.culture);
        if (d.cultureGroup) expect(GROUP_IDS, f.id).toContain(d.cultureGroup);
      }
  });

  it('政体倾向（第四十三轮写在文化组上，文化只写不同的）：都是内置的政体；每个文化在它能用的每个时代至少两种', () => {
    for (const g of BUILTIN_CULTURE_GROUPS) expect(weightedList(g.tendencies?.government).length, `${g.id} 有政体倾向`).toBeGreaterThan(0);
    for (const c of BUILTIN_CULTURES) {
      for (const era of erasOfCulture(c)) {
        const list = weightedList(cultureTendency(SMALL, c, 'government', era.id));
        for (const [id, w] of list) {
          expect(BUILTIN_GOVERNMENTS.find((x) => x.id === id), `${c.id}: ${id}`).toBeDefined();
          expect(w, `${c.id}: ${id}`).toBeGreaterThan(0);
        }
        expect(new Set(list.map(([id]) => id)).size, c.id).toBe(list.length);
        // 写了某个时代的政体时至少写两种（不然这个时代的国家全是同一种）；历史上的时代都写了
        // 奇幻、科幻里的 EU4 文化（第四十四轮起奇幻、科幻的包不再默认带它们，不写这两个时代的倾向）只查历史上的四个时代
        const own = list.filter(([id]) => govIds(era).includes(id));
        if (HISTORY.includes(era.id) || (own.length && !CULTURE_REGIONS.some((r) => r.groups.includes(c.group)))) expect(own.length, `${c.id} / ${era.id}`).toBeGreaterThanOrEqual(2);
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
    humanExec(eng, { op: 'generate_human', era: eraId, groups: defaults(eraOf(eraId)), countries: {} });
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
    it(`${era.name}：只用这个时代的政体与派系，称号按等级、文化、宗教换说法，建国年份在时代里`, () => {
      const w = generate(era.id);
      const list = countryList(w.small);
      expect(list.length, era.id).toBeGreaterThan(5);
      // 世界里复制进来的政体、派系是时代列着的；第二十九轮起没有国家用的政体生成后收掉（派系各国都按时代的自动算，全留着）
      const govs = Object.keys(w.small.content!.government!);
      expect(govs.every((g) => govIds(era).includes(g))).toBe(true);
      expect(govs.sort()).toEqual([...new Set(list.map((m) => m.government))].sort());
      expect(Object.keys(w.small.content!.faction!).sort()).toEqual([...facIds(era)].sort());
      const used = new Set<string>();
      for (const m of list) {
        expect(govIds(era), m.name).toContain(m.government);
        used.add(m.government);
        const g = governmentById(w.small, m.government) as Government;
        const t = govTitles(g, titleContext(w, m));
        // 联邦的成员邦（第二十六轮）是地名 + 成员的称号，名字锁定
        if (!m.nameLocked) expect(m.name).toBe(titled(m.base, t.title).zh);
        expect(m.ruler.title).toBe(t.ruler?.zh);
        expect(m.founded).toBeGreaterThanOrEqual(era.years![0]);
        expect(m.founded).toBeLessThanOrEqual(era.years![1]);
        const fs = countryFactions(w, m.id);
        expect(fs.map((f) => f.id)).toEqual(facIds(era));
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

  it('文化的倾向起作用：草原多游牧的政体，汉多天朝，奇幻的种族多用自己的政体，科幻的异星种族多是蜂巢意志', () => {
    // 一个地区只有几国：按三个种子合起来数
    // only：只生成这几组（第四十三轮：中世纪默认带 18 组，一块 1.2 万格的地区只有十几国，草原的组常常一国都没有）
    const share = (eraId: string, groups: string[], govs: string[], only?: { id: string; weight: number }[]) => {
      let all = 0;
      let hit = 0;
      for (const seed of [0, 11, 23]) {
        let w = only ? undefined : generate(eraId);
        if (seed || only) {
          const eng = continents();
          humanExec(eng, { op: 'generate_human', era: eraId, groups: only ?? defaults(eraOf(eraId)), countries: { seed } });
          w = eng.world;
        }
        if (!w) continue;
        const mine = countryList(w.small).filter((m) => groups.includes(cultureOf(w, m.primaryCulture).group));
        all += mine.length;
        hit += mine.filter((m) => govs.includes(m.government)).length;
      }
      expect(all, `${eraId}: ${groups}`).toBeGreaterThan(2);
      return hit / all;
    };
    // 第四十三轮：草原（阿尔泰）多是部落、游牧；汉多是天朝、行政与专制君主制
    expect(share('antiquity', ['altaic'], ['steppe-horde', 'tribal-federation', 'tribal-despotism'])).toBeGreaterThan(0.5);
    const steppe = [
      { id: 'altaic', weight: 3 },
      { id: 'chinese', weight: 2 },
      { id: 'iranian', weight: 1 },
    ];
    expect(share('medieval', ['altaic'], ['steppe-horde', 'tribal-federation', 'tribal-despotism', 'tribal-kingdom'], steppe)).toBeGreaterThan(0.5);
    expect(share('medieval', ['chinese'], ['celestial-empire', 'administrative-monarchy', 'despotic-monarchy'])).toBeGreaterThan(0.6);
    // 第四十四轮：奇幻、科幻的各族多用自己的政体
    expect(share('fantasy', ['elven', 'dwarven', 'orcish', 'draconic'], ['elven-council', 'dwarven-hold', 'orc-horde', 'dragon-lordship'])).toBeGreaterThan(0.5);
    expect(share('scifi', ['lithic', 'sporal', 'chitin'], ['hive-collective', 'lattice-consensus'])).toBeGreaterThan(0.4);
  });

  it('同样的参数同样的结果', () => {
    for (const id of ['antiquity', 'scifi']) {
      const eng = continents();
      humanExec(eng, { op: 'generate_human', era: id, groups: defaults(eraOf(id)), countries: {} });
      const a = generate(id);
      expect(digest(eng.world.causes.country)).toBe(digest(a.causes.country));
      expect(digest(eng.world.small.countries)).toBe(digest(a.small.countries));
    }
  });
});
