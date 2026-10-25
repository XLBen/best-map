import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../../tools/hash';
import { type Command, CommandError } from '../commands';
import { Engine } from '../engine';
import { exportPackage } from '../export';
import { BUILTIN_ERAS } from '../packs/eras';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from '../packs/governments';
import { continents, engineFor, snapshot } from '../testing/fixtures';
import type { World } from '../world';
import {
  allCountryStats,
  countryCells,
  countryColors,
  countryFactions,
  countryGroups,
  countryLabels,
  countryList,
  countryMapColors,
  flagSchema,
  flagSvg,
  governmentById,
  pickTitle,
  sizeFactor,
} from './index';
import { claimsStage } from './claims';
import { humanStages, registerHumanStage, unregisterHumanStage } from './generate';
import { readComp } from './groups';

// 第二十三轮：国家与政体

const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
  { id: 'steppe', weight: 1.5 },
];
const GEN: Command = { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} };

// 有省份、生成过人文与国家的大陆世界（1.2 万格的地区）
const nations = (): Engine =>
  snapshot('nations', () => {
    const eng = continents({ provinces: true });
    eng.exec(GEN);
    return eng;
  });

const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
const ids = (w: World) => Object.keys(w.small.countries ?? {}).map(Number);

// 陆地省里有几个跨了国家
function spanning(w: World): number {
  const m = new Map<number, Set<number>>();
  for (let i = 0; i < w.mesh.n; i++) {
    const p = w.causes.province[i];
    if (p < 0 || !w.small.provinces[p]?.land) continue;
    if (!m.has(p)) m.set(p, new Set());
    m.get(p)!.add(w.causes.country![i]);
  }
  return [...m.values()].filter((s) => s.size > 1).length;
}

function countryDigest(w: World): Record<string, string> {
  return {
    country: digest(w.causes.country ?? new Int32Array()),
    countries: digest(w.small.countries ?? null),
    layer: digest(w.derived.country ?? new Uint16Array()),
    province: digest(w.causes.province),
    popTotal: digest(w.causes.popTotal ?? new Float32Array()),
    popGroup: digest(w.causes.popGroup ?? new Uint16Array()),
    rules: JSON.stringify(w.small.human?.countryRules ?? null),
  };
}

// 金标准（第二十三轮记下）：以后提速、重构，生成的国家必须逐值不变；有意改了生成的规则时重录
// （按内置的中世纪、文化、政体与派系算：改了那些数据就要重录，同 population.test.ts；
//   第二十二轮的内容换成 6 个时代、23 个文化组后重录过一次，第二十三轮 内容写全六个时代的政体、派系与文化的政体倾向后又重录一次；
//   第二十六轮重录：国家有了等级与面积预算（两遍扩张）、各文化正好分完、不在小岛上立国、邦联、领土补齐、联邦切分、两层附庸与从属的种类；
//   第二十六轮又重录一次：按文化 × 陆块分、预算的上限、第二遍有上限并拉平快慢、下海按政体、别的陆块上没人的地方不要、邦联的一片只归成员、
//   补齐的围住按海岸、贴着国境的一圈要冰川）
const RECORDED = {
  region: { country: 'e7bed7d233553c57', countries: 'c5ce37a55850ace4' },
  planet: { country: 'e1fa7fd20946f98c', countries: '28dd13a88fa568c5' },
};
const genDigest = (w: World) => ({ country: digest(w.causes.country!), countries: digest(w.small.countries) });
const MEDIEVAL = BUILTIN_ERAS.find((e) => e.id === 'medieval')!;
// 世界里复制进来的：内置的里中世纪列着的（按内置的先后）
const medievalGovs = () => BUILTIN_GOVERNMENTS.filter((g) => MEDIEVAL.governments!.includes(g.id)).map((g) => g.id);
const medievalFactions = () => BUILTIN_FACTIONS.filter((f) => MEDIEVAL.factions!.includes(f.id)).map((f) => f.id);

describe('政体与派系', () => {
  it('内置的政体、派系合格；称号按文化、文化组换说法', () => {
    // 中世纪示例原有的六种政体、三个派系留着 id
    expect(medievalGovs()).toEqual(expect.arrayContaining(['feudal-monarchy', 'merchant-republic', 'theocracy', 'tribal-confederation', 'empire', 'city-state']));
    expect(medievalFactions()).toEqual(expect.arrayContaining(['nobility', 'merchants', 'clergy']));
    const feudal = BUILTIN_GOVERNMENTS.find((g) => g.id === 'feudal-monarchy')!;
    expect(pickTitle(feudal.title, { id: 'turkic', group: 'steppe' })).toEqual({ zh: '汗国', orig: '{name} Khanate' });
    expect(pickTitle(feudal.title, { id: 'anglic', group: 'western' })).toEqual({ zh: '王国', orig: 'Kingdom of {name}' });
    // 文化 id 先于文化组
    expect(pickTitle(feudal.title, { id: 'frankish', group: 'western' })).toEqual({ zh: '王国', orig: 'Royaume de {name}' });
    expect(pickTitle('共和国', undefined)).toEqual({ zh: '共和国' });
    expect(pickTitle({ default: '王国', yamato: '幕府' }, { id: 'yamato', group: 'eastern' })).toEqual({ zh: '幕府' });
  });

  it('旗帜的规则画得出 SVG', () => {
    const f = flagSchema.parse({ layout: 'tricolor-v', colors: ['#112233', '#ffffff', '#aa0000'], emblem: 'star', emblemColor: '#ffcc00' });
    const svg = flagSvg(f);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('#aa0000');
    expect(svg).toContain('#ffcc00');
  });
});

describe('生成国家', () => {
  it('政体、派系复制进世界；每个国家有名字、颜色、旗帜、首都、政体、主流文化与兼容的文化组', () => {
    const w = nations().world;
    expect(Object.keys(w.small.content?.government ?? {})).toEqual(medievalGovs());
    expect(Object.keys(w.small.content?.faction ?? {})).toEqual(medievalFactions());
    expect(w.small.human?.countryRules).toEqual({ fragmentation: 0.5, seed: w.small.human!.seed });
    const list = countryList(w.small);
    expect(list.length).toBeGreaterThan(5);
    const names = new Set<string>();
    const colors = new Set<string>();
    for (const m of list) {
      expect(m.name.length, `${m.id}`).toBeGreaterThan(1);
      names.add(m.name);
      colors.add(m.color);
      expect(flagSchema.safeParse(m.flag).success).toBe(true);
      expect(w.causes.country![m.capitalCell!]).toBe(m.id);
      expect(dry(w, m.capitalCell!)).toBe(true);
      expect(governmentById(w.small, m.government)).toBeDefined();
      const c = w.small.content!.culture![m.primaryCulture] as { group: string };
      expect(m.acceptedGroups[0]).toBe(c.group);
      expect(m.ruler.name.length).toBeGreaterThan(0);
      expect(m.founded).toBeGreaterThanOrEqual(MEDIEVAL.years![0]);
      expect(m.founded).toBeLessThanOrEqual(MEDIEVAL.years![1]);
      expect(m.history).toContain(m.name);
    }
    expect(names.size).toBe(list.length);
    expect(colors.size).toBe(list.length);
  });

  it('国名 = 文化风格的地名 + 政体的称号（草原的王国是汗国）', () => {
    const w = nations().world;
    for (const m of countryList(w.small)) {
      const g = governmentById(w.small, m.government)!;
      const c = w.small.content!.culture![m.primaryCulture] as { id: string; group: string };
      const t = pickTitle(g.title, c)!;
      expect(m.name, m.government).toBe(t.zh.includes('{name}') ? t.zh.replace('{name}', m.base.zh) : m.base.zh + t.zh);
      if (m.base.orig && t.orig) expect(m.orig).toBe(t.orig.replace('{name}', m.base.orig));
      if (m.ruler.title) expect(m.ruler.title).toBe(pickTitle(g.rulerTitle, c)!.zh);
    }
  });

  it('只有陆地归国家（海是推导的领海）；宜居度低于下限的格只有游牧的政体能占', () => {
    // 第二十六轮：领土补齐（claims）会把被包围的、贴着国境的难住之地划进国家，这里只看扩张本身
    unregisterHumanStage('claims');
    let w: World;
    try {
      const eng = continents({ provinces: true });
      eng.exec(GEN);
      w = eng.world;
    } finally {
      registerHumanStage(claimsStage, { after: 'countries' });
    }
    const era = BUILTIN_ERAS.find((e) => e.id === 'medieval')!;
    const minH = era.unclaimed.minHabitability;
    let owned = 0;
    let land = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const c = w.causes.country![i];
      if (!w.causes.land[i]) {
        expect(c).toBe(-1);
        continue;
      }
      land++;
      if (c < 0) continue;
      owned++;
      if (dry(w, i) && w.derived.habitability[i] < minH) {
        const g = governmentById(w.small, w.small.countries![c].government)!;
        expect(w.derived.habitability[i], `格 ${i}`).toBeGreaterThanOrEqual(minH * (1 - g.nomadic) - 1e-6);
      }
    }
    // 中世纪：宜居与稍差的地方大多有了国家
    expect(owned / land).toBeGreaterThan(0.6);
    // seaClaimKm 为 0：海不归谁（碎岛除外，第二十六轮）
    for (let i = 0; i < w.mesh.n; i++) if (!w.causes.land[i] && !w.derived.countryIslet?.[i]) expect(w.derived.country![i]).toBe(0);
    expect(humanStages()).toContain('claims');
  });

  it('“统一 ↔ 分裂”：分裂时国家多、统一时少', () => {
    const counts = [0, 0.5, 1].map((f) => {
      const eng = nations();
      eng.exec({ op: 'regenerate_countries', fragmentation: f });
      return ids(eng.world).length;
    });
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
    expect(sizeFactor(0)).toBe(8);
    expect(sizeFactor(1)).toBeCloseTo(1 / 8);
  });

  it('时代的无主地多时国家占的地方少；领海按 seaClaimKm', () => {
    const base = nations();
    const owned = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.causes.country![i] >= 0).length;
    const era = structuredClone(BUILTIN_ERAS.find((e) => e.id === 'medieval')!);
    const eng = nations();
    eng.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: { ...era, unclaimed: { minHabitability: 0.45, nomads: 0.05 }, seaClaimKm: 300 } });
    eng.exec({ op: 'regenerate_countries' });
    const w = eng.world;
    expect(owned(w)).toBeLessThan(owned(base.world) * 0.8);
    // 领海：离自己海岸不远的海归这个国家
    const list = countryList(w.small);
    let sea = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.causes.land[i] || !w.derived.country![i]) continue;
      sea++;
      const id = list[w.derived.country![i] - 1].id;
      // 附近（三格以内）有这个国家的陆地
      let near = false;
      for (let j = 0; j < w.mesh.n && !near; j++) if (w.causes.country![j] === id && Math.hypot(w.mesh.x[i] - w.mesh.x[j], w.mesh.y[i] - w.mesh.y[j]) * w.kmPerUnit < 300 + 1.5 * w.mesh.spacing * w.kmPerUnit) near = true;
      expect(near).toBe(true);
    }
    expect(sea).toBeGreaterThan(10);
  });

  it('同样的参数同样的结果；重放、检查点一致；撤销后与没生成过一样', () => {
    const a = nations();
    const b = continents({ provinces: true });
    b.exec(GEN);
    expect(countryDigest(b.world)).toEqual(countryDigest(a.world));
    const doc = a.toDoc();
    expect(countryDigest(Engine.fromDoc(doc, a.world.mesh).world)).toEqual(countryDigest(a.world));
    const cp = structuredClone(a.toCheckpoint());
    expect(countryDigest(Engine.fromCheckpoint(cp, doc, a.world.mesh)!.world)).toEqual(countryDigest(a.world));
    const plain = continents({ provinces: true });
    const before = digestWorld(plain.world);
    plain.exec(GEN);
    plain.undo();
    expect(plain.world.causes.country).toBeUndefined();
    expect(plain.world.small.countries).toBeUndefined();
    expect(plain.world.derived.country).toBeUndefined();
    expect(digestWorld(plain.world)).toEqual(before);
    expect(genDigest(a.world)).toEqual(RECORDED.region);
  });

  it('没有国家的人文与以前一样（第二十二轮的金标准不变）；换种子换一个样子', () => {
    const a = continents();
    a.exec({ op: 'generate_human', era: 'medieval', groups: GROUPS });
    expect(a.world.causes.country).toBeUndefined();
    expect(a.world.small.countries).toBeUndefined();
    expect(a.world.small.human!.countryRules).toBeUndefined();
    const eng = nations();
    eng.exec({ op: 'regenerate_countries', seed: 99 });
    expect(digest(eng.world.small.countries)).not.toEqual(digest(nations().world.small.countries));
  });

  it('整个星球上也一样', () => {
    const eng = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    eng.exec(GEN);
    const w = eng.world;
    expect(ids(w).length).toBeGreaterThan(3);
    const again = Engine.fromDoc(eng.toDoc(), w.mesh);
    expect(countryDigest(again.world)).toEqual(countryDigest(w));
    expect(genDigest(w)).toEqual(RECORDED.planet);
    const labels = countryLabels(w);
    expect(labels.length).toBe(ids(w).length);
    for (const l of labels) for (const [x] of l.path) expect(x).toBeGreaterThanOrEqual(0);
  });

  it('首都一带人多；扩张性强的国家在异族的地方掺进主流文化的人', () => {
    const w = nations().world;
    const stats = allCountryStats(w);
    for (const m of countryList(w.small)) {
      const st = stats.get(m.id)!;
      if (st.cells < 20 || !(st.population > 0)) continue;
      const d = w.causes.popTotal![m.capitalCell!] / (w.mesh.area[m.capitalCell!] * w.kmPerUnit ** 2);
      expect(d, m.name).toBeGreaterThan(st.density);
    }
    // 不兼容的地方里掺着主流文化的人
    let mixed = 0;
    for (const m of countryList(w.small)) {
      const g = governmentById(w.small, m.government)!;
      if (g.expansion < 0.5) continue;
      for (const i of countryCells(w, m.id)) {
        const comp = readComp(w.causes, i);
        if (comp.some((x) => w.small.popGroups?.[x.code]?.culture === m.primaryCulture) && w.small.popGroups?.[comp[0]?.code]?.culture !== m.primaryCulture) mixed++;
      }
    }
    expect(mixed).toBeGreaterThan(0);
  });

  it('外交：附庸比宗主小、最多两层，同盟、敌对两边都记、不同时有', () => {
    const w = nations().world;
    const stats = allCountryStats(w);
    for (const m of countryList(w.small)) {
      if (m.overlord !== undefined) {
        expect(stats.get(m.overlord)!.areaKm2).toBeGreaterThan(stats.get(m.id)!.areaKm2);
        // 第二十六轮：附庸也可以有自己的附庸（两层），再往上没有
        const top = w.small.countries![m.overlord].overlord;
        if (top !== undefined) expect(w.small.countries![top].overlord).toBeUndefined();
      }
      for (const a of m.allies) expect(w.small.countries![a].allies).toContain(m.id);
      for (const r of m.rivals) expect(w.small.countries![r].rivals).toContain(m.id);
      expect(m.allies.filter((a) => m.rivals.includes(a))).toEqual([]);
    }
  });

  it('换人文的发源地、重新生成人文时国家不动；generate_human 不写 countries 时国家去掉', () => {
    const eng = nations();
    const w = eng.world;
    const before = digest(w.causes.country);
    const metas = digest(w.small.countries);
    eng.exec({ op: 'regenerate_human' });
    expect(digest(w.causes.country)).toBe(before);
    expect(digest(w.small.countries)).toBe(metas);
    eng.exec({ op: 'generate_human', era: 'medieval', groups: GROUPS });
    expect(w.small.countries).toBeUndefined();
    expect(w.causes.country!.every((v) => v === -1)).toBe(true);
    expect(w.derived.country).toBeUndefined();
  });

  it('重新生成国家时锁定的留着', () => {
    const eng = nations();
    const w = eng.world;
    const id = countryList(w.small)[1].id;
    eng.exec({ op: 'set_country', id, patch: { locked: true } });
    const cells = countryCells(w, id);
    // 外交里指向重新生成掉的国家的去掉，别的不动
    const strip = ({ allies: _a, rivals: _r, overlord: _o, ...rest }: Record<string, unknown>) => rest;
    const meta = strip({ ...w.small.countries![id] });
    eng.exec({ op: 'regenerate_countries', fragmentation: 0.9 });
    expect(countryCells(w, id)).toEqual(cells);
    expect(strip({ ...w.small.countries![id] })).toEqual(meta);
    for (const a of w.small.countries![id].allies) expect(w.small.countries![a]).toBeDefined();
    expect(spanning(w)).toBe(0);
    eng.exec({ op: 'regenerate_countries', keepLocked: false });
    expect(w.small.countries![id]?.locked).toBeUndefined();
  });

  it('每个内置的时代都生成得出国家（时代没列政体时借用别的时代的）', () => {
    for (const era of BUILTIN_ERAS) {
      const eng = continents();
      const groups = (era.defaultGroups ?? []).map((g) => (typeof g === 'string' ? { id: g, weight: 1 } : { id: g[0], weight: g[1] }));
      eng.exec({ op: 'generate_human', era: era.id, groups, countries: {} });
      const w = eng.world;
      expect(ids(w).length, era.id).toBeGreaterThan(0);
      for (const m of countryList(w.small)) expect(governmentById(w.small, m.government), era.id).toBeDefined();
      expect(countryFactions(w, ids(w)[0]).length, era.id).toBeGreaterThan(0);
    }
  });

  it('没有人文时不能生成国家', () => {
    const eng = continents();
    expect(() => eng.exec({ op: 'generate_countries' })).toThrow(CommandError);
    expect(() => eng.exec({ op: 'regenerate_countries' })).toThrow(CommandError);
  });
});

describe('省份跟着国界', () => {
  it('生成国家时跨国界的省份切开；之后划分的省份不跨国界', () => {
    const w = nations().world;
    expect(spanning(w)).toBe(0);
    // 先有国家、再划分省份（新建向导的先后）
    const eng = continents();
    eng.exec(GEN);
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    expect(spanning(eng.world)).toBe(0);
  });

  it('画领土、涂省份、并省、改地形之后都不跨国界；涂进别国的省时格跟着省换国家', () => {
    const eng = nations();
    const w = eng.world;
    const [a, b] = countryList(w.small);
    const cb = countryCells(w, b.id);
    eng.exec({ op: 'paint_country', cells: cb.slice(0, Math.floor(cb.length / 3)), country: a.id });
    expect(spanning(w)).toBe(0);
    // 把 a 的几格涂进 b 的一个省：这几格成了 b 的
    const pb = w.causes.province[countryCells(w, b.id)[0]];
    const fromA = countryCells(w, a.id).slice(0, 5);
    eng.exec({ op: 'assign_province', cells: fromA, province: pb });
    for (const i of fromA) expect(w.causes.country![i]).toBe(b.id);
    expect(spanning(w)).toBe(0);
    // 改地形：画一笔陆地
    const coast = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i] && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].some((j) => w.causes.country![j] >= 0))!;
    const disc = [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[coast], w.mesh.y[i] - w.mesh.y[coast]) < w.mesh.spacing * 3);
    eng.exec({ op: 'paint_land', cells: disc, t: disc.map(() => 0), mode: 'land' });
    expect(spanning(w)).toBe(0);
    const doc = eng.toDoc();
    expect(countryDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(countryDigest(w));
  });
});

describe('改国家', () => {
  it('领土笔刷：只画陆地，null 是无主；撤销退回', () => {
    const eng = nations();
    const w = eng.world;
    const [a, b] = countryList(w.small);
    const cb = countryCells(w, b.id).slice(0, 10);
    const sea = [...Array(w.mesh.n).keys()].filter((i) => !w.causes.land[i]).slice(0, 3);
    const before = countryDigest(w);
    expect(eng.exec({ op: 'paint_country', cells: [...cb, ...sea], country: a.id })).toBe(`领土“${a.name}” · 10 格`);
    for (const i of cb) expect(w.causes.country![i]).toBe(a.id);
    for (const i of sea) expect(w.causes.country![i]).toBe(-1);
    const code = countryList(w.small).findIndex((m) => m.id === a.id) + 1;
    for (const i of cb) expect(w.derived.country![i]).toBe(code);
    expect(eng.exec({ op: 'paint_country', cells: cb, country: null })).toBe('无主地 · 10 格');
    for (const i of cb) expect(w.derived.country![i]).toBe(0);
    eng.undo();
    eng.undo();
    expect(countryDigest(w)).toEqual(before);
  });

  it('新建、合并、拆分、删除；首都丢了换一个，挪过的锁定', () => {
    const eng = nations();
    const w = eng.world;
    const [a, b] = countryList(w.small);
    const cells = countryCells(w, a.id).slice(0, 12);
    eng.exec({ op: 'new_country', cells, name: '新国' });
    const nid = Math.max(...ids(w));
    const nm = w.small.countries![nid];
    expect(nm.name).toBe('新国');
    expect(nm.nameLocked).toBe(true);
    expect(countryCells(w, nid)).toEqual(cells);
    expect(w.causes.country![nm.capitalCell!]).toBe(nid);
    expect(spanning(w)).toBe(0);
    // 首都所在的格画给别国：首都换一个
    if (cells.includes(a.capitalCell!)) expect(w.small.countries![a.id].capitalCell).not.toBe(a.capitalCell);
    expect(w.causes.country![w.small.countries![a.id].capitalCell!]).toBe(a.id);
    // 挪首都
    const other = countryCells(w, b.id).find((i) => i !== b.capitalCell && dry(w, i))!;
    eng.exec({ op: 'move_capital', id: b.id, cell: other });
    expect(w.small.countries![b.id].capitalCell).toBe(other);
    expect(w.small.countries![b.id].capitalLocked).toBe(true);
    expect(() => eng.exec({ op: 'move_capital', id: b.id, cell: cells[0] })).toThrow('首都要在这个国家的领土上');
    // 合并：b 并进 a
    const bc = countryCells(w, b.id);
    eng.exec({ op: 'set_country', id: nid, patch: { allies: [b.id] } });
    eng.exec({ op: 'merge_countries', a: a.id, b: b.id });
    expect(w.small.countries![b.id]).toBeUndefined();
    for (const i of bc) expect(w.causes.country![i]).toBe(a.id);
    expect(w.small.countries![nid].allies).toEqual([a.id]);
    expect(spanning(w)).toBe(0);
    // 拆分成两半：没有首都的那一半成新国家
    const n0 = countryCells(w, a.id).length;
    eng.exec({ op: 'split_country', id: a.id });
    const sid = Math.max(...ids(w));
    expect(countryCells(w, sid).length + countryCells(w, a.id).length).toBe(n0);
    expect(countryCells(w, a.id)).toContain(w.small.countries![a.id].capitalCell);
    expect(w.small.countries![sid].primaryCulture).toBe(w.small.countries![a.id].primaryCulture);
    // 删除：成无主地，外交里去掉
    eng.exec({ op: 'remove_country', id: a.id });
    expect(w.small.countries![a.id]).toBeUndefined();
    expect(w.small.countries![nid].allies).toEqual([]);
    expect(countryCells(w, a.id)).toEqual([]);
    expect(spanning(w)).toBe(0);
    const doc = eng.toDoc();
    expect(countryDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(countryDigest(w));
    const cp = structuredClone(eng.toCheckpoint());
    expect(countryDigest(Engine.fromCheckpoint(cp, doc, w.mesh)!.world)).toEqual(countryDigest(w));
  });

  it('改档案：名字锁定、换政体换称号、换文化重起地名、外交两边都记、宗主不能绕圈、派系锁定', () => {
    const eng = nations();
    const w = eng.world;
    const list = countryList(w.small);
    const m = list.find((x) => (w.small.content!.culture![x.primaryCulture] as { group: string }).group === 'western')!;
    eng.exec({ op: 'set_country', id: m.id, patch: { government: 'merchant-republic' } });
    expect(w.small.countries![m.id].name).toBe(`${m.base.zh}共和国`);
    // 原文按文化的语言（西欧的几个文化各有写法）
    const rep = pickTitle(governmentById(w.small, 'merchant-republic')!.title, { id: m.primaryCulture, group: 'western' })!;
    if (m.base.orig) expect(w.small.countries![m.id].orig).toBe(rep.orig!.replace('{name}', m.base.orig));
    eng.exec({ op: 'set_country', id: m.id, patch: { name: '大公国', orig: 'Grand Duchy' } });
    eng.exec({ op: 'set_country', id: m.id, patch: { government: 'feudal-monarchy' } });
    expect(w.small.countries![m.id].name).toBe('大公国');
    expect(w.small.countries![m.id].orig).toBe('Grand Duchy');
    eng.exec({ op: 'set_country', id: m.id, patch: { name: '' } });
    expect(w.small.countries![m.id].name).toBe(`${m.base.zh}王国`);
    // 换成草原的文化：地名按突厥的风格，称号是汗国
    eng.exec({ op: 'set_country', id: m.id, patch: { primaryCulture: 'turkic' } });
    expect(w.small.countries![m.id].name.endsWith('汗国')).toBe(true);
    expect(w.small.countries![m.id].acceptedGroups[0]).toBe('steppe');
    const o = list.find((x) => x.id !== m.id)!;
    eng.exec({ op: 'set_country', id: m.id, patch: { allies: [o.id] } });
    expect(w.small.countries![o.id].allies).toContain(m.id);
    eng.exec({ op: 'set_country', id: m.id, patch: { rivals: [o.id] } });
    expect(w.small.countries![o.id].allies).not.toContain(m.id);
    expect(w.small.countries![o.id].rivals).toContain(m.id);
    expect(w.small.countries![m.id].allies).not.toContain(o.id);
    // m 自己不是附庸：o 成为 m 的附庸
    eng.exec({ op: 'set_country', id: m.id, patch: { overlord: null } });
    eng.exec({ op: 'set_country', id: o.id, patch: { overlord: m.id } });
    expect(() => eng.exec({ op: 'set_country', id: m.id, patch: { overlord: o.id } })).toThrow('宗主不能是自己或自己的附庸');
    // 附庸在地图上用宗主的浅色
    const colors = countryMapColors(w);
    const code = countryList(w.small).findIndex((x) => x.id === o.id) + 1;
    const top = countryList(w.small).findIndex((x) => x.id === m.id) + 1;
    const own = countryColors(w)[code]!;
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(colors[code]).not.toEqual(colors[top]);
    expect(colors[top]).toEqual(countryColors(w)[top]);
    expect(dist(colors[code]!, colors[top]!)).toBeGreaterThan(10);
    // 宗主的浅色：比起自己的颜色更像宗主的
    expect(dist(colors[code]!, own)).toBeGreaterThan(0);
    // 派系
    const auto = countryFactions(w, m.id);
    expect(auto.map((f) => f.id)).toEqual(MEDIEVAL.factions);
    expect(auto.reduce((a, f) => a + f.influence, 0)).toBeCloseTo(1, 2);
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: { nobility: 0.2, merchants: 0.7, clergy: 0.1 } } });
    expect(countryFactions(w, m.id).find((f) => f.id === 'merchants')!.influence).toBe(0.7);
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: null } });
    expect(countryFactions(w, m.id)).toEqual(auto);
    eng.exec({ op: 'set_country', id: m.id, patch: { flag: { layout: 'cross', colors: ['#ffffff', '#cc0000'] }, color: '#123456', history: '一段历史', founded: 1200, ruler: { name: '某某', title: '公爵' } } });
    const mm = w.small.countries![m.id];
    expect(mm.flag.layout).toBe('cross');
    expect(mm.color).toBe('#123456');
    expect(mm.history).toBe('一段历史');
    expect(mm.founded).toBe(1200);
    expect(mm.ruler).toEqual({ name: '某某', title: '公爵' });
    const doc = eng.toDoc();
    expect(countryDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(countryDigest(w));
  });

  it('派系：商业共和国的商人比封建王国的多', () => {
    const eng = nations();
    const w = eng.world;
    const m = countryList(w.small)[0];
    eng.exec({ op: 'set_country', id: m.id, patch: { government: 'feudal-monarchy' } });
    const feudal = countryFactions(w, m.id).find((f) => f.id === 'merchants')!.influence;
    eng.exec({ op: 'set_country', id: m.id, patch: { government: 'merchant-republic' } });
    const rep = countryFactions(w, m.id).find((f) => f.id === 'merchants')!.influence;
    expect(rep).toBeGreaterThan(feudal);
  });

  it('删除国家：国家都去掉，人口不动；删除人文时国家也去掉', () => {
    const eng = nations();
    const w = eng.world;
    const pop = digest(w.causes.popTotal);
    eng.exec({ op: 'remove_countries' });
    expect(w.small.countries).toBeUndefined();
    expect(w.small.human!.countryRules).toBeUndefined();
    expect(w.derived.country).toBeUndefined();
    expect(digest(w.causes.popTotal)).toBe(pop);
    eng.undo();
    expect(ids(w).length).toBeGreaterThan(0);
    eng.exec({ op: 'remove_human' });
    expect(w.small.countries).toBeUndefined();
  });
});

describe('改地形以后', () => {
  it('变成海的格不再归国家，新陆地归挨着的国家；别处不动；重放一致', () => {
    const eng = nations();
    const w = eng.world;
    const coastal = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.causes.country![i] >= 0 && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].some((j) => !w.causes.land[j]));
    const c0 = coastal[Math.floor(coastal.length / 2)];
    const owner = w.causes.country![c0];
    const disc = [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c0], w.mesh.y[i] - w.mesh.y[c0]) < w.mesh.spacing * 2.5);
    const before = w.causes.country!.slice();
    eng.exec({ op: 'paint_land', cells: disc, t: disc.map(() => 0), mode: 'sea' });
    const lost = disc.filter((i) => before[i] >= 0 && !w.causes.land[i]);
    expect(lost.length).toBeGreaterThan(2);
    for (const i of lost) expect(w.causes.country![i]).toBe(-1);
    for (let i = 0; i < w.mesh.n; i++) if (!disc.includes(i) && w.causes.land[i]) expect(w.causes.country![i]).toBe(before[i]);
    eng.exec({ op: 'paint_land', cells: disc, t: disc.map(() => 0), mode: 'land' });
    const regained = lost.filter((i) => w.causes.land[i]);
    expect(regained.length).toBeGreaterThan(2);
    expect(regained.filter((i) => w.causes.country![i] === owner).length).toBeGreaterThan(0);
    for (const i of regained) expect(w.causes.country![i]).toBeGreaterThanOrEqual(0);
    expect(spanning(w)).toBe(0);
    const doc = eng.toDoc();
    expect(countryDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(countryDigest(w));
  });
});

describe('给界面的', () => {
  it('国界的分组、统计、国名的位置', () => {
    const w = nations().world;
    const g = countryGroups(w);
    expect(g.length).toBe(w.mesh.n * 2);
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.causes.land[i]) expect(g[2 * i]).toBe(w.derived.country![i]);
      else if (!w.derived.countryIslet?.[i]) expect(g[2 * i]).toBe(-1);
    }
    const stats = allCountryStats(w);
    let sum = 0;
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.country![i] >= 0) sum += w.causes.popTotal![i];
    let total = 0;
    for (const s of stats.values()) {
      total += s.population;
      expect(s.cultures.reduce((a, c) => a + c.share, 0)).toBeLessThanOrEqual(1 + 1e-6);
      expect(s.areaKm2).toBeGreaterThan(0);
      expect(s.provinces).toBeGreaterThan(0);
    }
    expect(total).toBeCloseTo(sum, -2);
    const labels = countryLabels(w);
    expect(labels.length).toBe(stats.size);
    for (const l of labels) {
      expect(l.path.length).toBe(5);
      expect(l.path[0][0]).toBeLessThanOrEqual(l.path[4][0] + 1e-9);
    }
  });

  it('导出 countries.bmp、countries.csv，provinces_summary.csv 多一列 country；没有国家时没有', () => {
    const eng = nations();
    const opts = { width: 256, height: 128, seaLevelGray: 95, maxElevation: 6000 };
    const pkg = exportPackage(eng.world, eng.toDoc(), opts);
    expect(pkg.files).toEqual(expect.arrayContaining(['countries.bmp', 'countries.csv', 'blocs.csv']));
    const files = unzipSync(pkg.zip);
    const csv = strFromU8(files['countries.csv']).trim().split('\n');
    // 第二十六轮：等级、从属的种类、所在的集团
    expect(csv[0]).toBe('id,name,orig,red,green,blue,government,culture,capital,population,area_km2,overlord,tier,subject,blocs');
    expect(csv.length).toBe(1 + ids(eng.world).length);
    const summary = strFromU8(files['provinces_summary.csv']).split('\n');
    expect(summary[0].endsWith(',religion,country')).toBe(true);
    const peopled = continents({ provinces: true });
    peopled.exec({ op: 'generate_human', era: 'medieval', groups: GROUPS });
    const plain = exportPackage(peopled.world, peopled.toDoc(), opts);
    expect(plain.files).not.toContain('countries.bmp');
    expect(plain.files).not.toContain('blocs.csv');
    expect(strFromU8(unzipSync(plain.zip)['provinces_summary.csv']).split('\n')[0].endsWith(',religion')).toBe(true);
  });
});
