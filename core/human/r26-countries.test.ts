import { describe, expect, it } from 'vitest';
import { digest } from '../../tools/hash';
import type { Command } from '../commands';
import { Engine } from '../engine';
import { ISLET_FRAG } from '../features';
import { BUILTIN_ERAS } from '../packs/eras';
import { brushCells } from '../select';
import { continents, snapshot } from '../testing/fixtures';
import type { World } from '../world';
import { SMALL_GAP, claimsStage } from './claims';
import type { GenContext } from './context';
import { worldEra } from './era';
import {
  BUILTIN_RANKS,
  ISLET_STEPS,
  allCountryStats,
  blocBorderGroups,
  blocList,
  blocMapColors,
  blocOf,
  cityList,
  countryCells,
  countryColors,
  countryList,
  countryMapColors,
  estimateCountryCount,
  federationColorOf,
  nextBlocId,
} from './index';
import { cellInputs } from './rules';

// 第二十六轮：国家——领土补齐、等级与格局、帝国 / 联邦 / 同盟、从属的种类、大城市的上限

const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
  { id: 'steppe', weight: 1.5 },
];
const GEN: Command = { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} };

const nations = (): Engine =>
  snapshot('nations', () => {
    const eng = continents({ provinces: true });
    eng.exec(GEN);
    return eng;
  });
const moderns = (): Engine =>
  snapshot('r26-modern', () => {
    const eng = continents({ provinces: true });
    eng.exec({ op: 'generate_human', era: 'modern', groups: GROUPS, countries: {}, settlements: { roads: false, landmarks: false } });
    return eng;
  });

const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
const near = (w: World, a: number, r: number) => [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[a], w.mesh.y[i] - w.mesh.y[a]) < r * w.mesh.spacing);
const ownedShare = (w: World) => {
  let land = 0;
  let owned = 0;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!dry(w, i)) continue;
    land++;
    if (w.causes.country![i] >= 0) owned++;
  }
  return owned / land;
};

// 直接跑一遍领土补齐（bandKm 换成给的）
function runClaims(w: World, bandKm = 0) {
  const era0 = worldEra(w.small)!;
  const era = { ...era0, unclaimed: { ...era0.unclaimed, bandKm } };
  const ctx = { world: w, d: w.derived, x: cellInputs(w, w.derived), hab: w.derived.habitability, era, countries: { mode: 'generate', rules: w.small.human!.countryRules!, keepLocked: true } };
  claimsStage.run(ctx as unknown as GenContext);
}

describe('领土补齐', () => {
  it('被一国包围的无主之地归它；两国之间的大块不填，小块归边界长的邻国', () => {
    const w = nations().world;
    const c = w.causes.country!;
    // 一国里面的一圈（四周都是这一国的干陆地）
    const inner = [...Array(w.mesh.n).keys()].find((i) => c[i] >= 0 && near(w, i, 3.5).every((j) => dry(w, j) && c[j] === c[i]))!;
    expect(inner).toBeDefined();
    const owner = c[inner];
    const hole = near(w, inner, 2.2);
    for (const i of hole) c[i] = -1;
    runClaims(w);
    for (const i of hole) expect(c[i]).toBe(owner);
    // 两国交界处的一大块
    const edge = [...Array(w.mesh.n).keys()].find((i) => {
      if (c[i] < 0) return false;
      const disc = near(w, i, 3.2);
      const ids = new Set(disc.map((j) => c[j]));
      return disc.every((j) => dry(w, j)) && ids.size === 2 && !ids.has(-1) && disc.length > SMALL_GAP;
    })!;
    expect(edge).toBeDefined();
    const pair = new Set(near(w, edge, 3.2).map((j) => c[j]));
    const gap = near(w, edge, 2.2);
    for (const i of gap) c[i] = -1;
    // 无主的块挨着的国家：只有这两国
    runClaims(w);
    for (const i of gap) expect(c[i]).toBe(-1);
    // 小块（不超过 SMALL_GAP 格）：归两国里的一个
    const small = near(w, edge, 1.05).filter((i) => gap.includes(i)).slice(0, SMALL_GAP);
    for (const i of gap) if (!small.includes(i)) c[i] = [...pair][0];
    runClaims(w);
    const got = new Set(small.map((i) => c[i]));
    expect(got.size).toBe(1);
    expect(pair.has([...got][0])).toBe(true);
  });

  it('贴着国境的一圈按时代的 bandKm 变宽；深处仍然无主；手画的无主地之后不再补', () => {
    const share = (band: number) => {
      const eng = nations();
      const era = structuredClone(BUILTIN_ERAS.find((e) => e.id === 'antiquity')!);
      eng.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: { ...era, id: 'medieval', unclaimed: { ...era.unclaimed, bandKm: band } } });
      eng.exec({ op: 'regenerate_countries' });
      return ownedShare(eng.world);
    };
    const s0 = share(0);
    const s1 = share(30);
    const s2 = share(300);
    expect(s1).toBeGreaterThanOrEqual(s0);
    expect(s2).toBeGreaterThan(s0 + 0.02);
    expect(s2).toBeLessThan(1);
    // 内置的几个时代：古代窄，中世纪宽，近现代更宽
    const band = (id: string) => BUILTIN_ERAS.find((e) => e.id === id)!.unclaimed.bandKm ?? 0;
    expect(band('antiquity')).toBeLessThan(band('medieval'));
    expect(band('medieval')).toBeLessThan(band('industrial'));
    // 画成无主的地方，别的编辑、重新生成人文（领土不换）之后还是无主
    const eng = nations();
    const w = eng.world;
    const inner = [...Array(w.mesh.n).keys()].find((i) => w.causes.country![i] >= 0 && near(w, i, 3.5).every((j) => dry(w, j) && w.causes.country![j] === w.causes.country![i]))!;
    const hole = near(w, inner, 2.2);
    eng.exec({ op: 'paint_country', cells: hole, country: null });
    eng.exec({ op: 'set_country', id: countryList(w.small)[0].id, patch: { history: '改一句' } });
    eng.exec({ op: 'regenerate_human' });
    for (const i of hole) expect(w.causes.country![i]).toBe(-1);
  });

  it('碎岛归最近的国家（只在推导里，领土数组只记陆地）', () => {
    const eng = nations();
    const w = eng.world;
    const c0 = [...Array(w.mesh.n).keys()].find(
      (i) => w.causes.country![i] >= 0 && !w.mesh.boundary[i] && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].some((j) => !w.causes.land[j]) && near(w, i, 4).filter((j) => !w.causes.land[j]).length > 10,
    )!;
    const km = w.mesh.spacing * w.kmPerUnit;
    const b = brushCells(w, w.mesh.x[c0], w.mesh.y[c0], km * 5);
    eng.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.7, mode: 'coast', size: km * 5 });
    const frag = w.causes.fragment!;
    const islet = w.derived.countryIslet!;
    expect(islet).toBeDefined();
    const list = countryList(w.small);
    let owned = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!islet[i]) continue;
      owned++;
      expect(w.causes.land[i]).toBe(0);
      expect(frag[i]).toBeGreaterThanOrEqual(ISLET_FRAG);
      expect(w.causes.country![i]).toBe(-1);
      const id = list[w.derived.country![i] - 1].id;
      // ISLET_STEPS 格海路以内有这一国的陆地
      expect(near(w, i, ISLET_STEPS + 1.5).some((j) => w.causes.country![j] === id)).toBe(true);
    }
    expect(owned).toBeGreaterThan(0);
    // 撤销：碎岛的推导跟着去掉
    eng.undo();
    expect([...(w.derived.countryIslet ?? [])].some((v) => v)).toBe(false);
  });
});

describe('国家的等级与格局', () => {
  const cv = (w: World) => {
    const st = allCountryStats(w);
    const a = countryList(w.small).map((m) => st.get(m.id)!.areaKm2);
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
    return { cv: sd / mean, max: Math.max(...a) / mean, min: Math.min(...a) / mean };
  };

  it('每国有等级；面积相差大（变异系数够大）', () => {
    const w = nations().world;
    for (const m of countryList(w.small)) expect(['city', 'small', 'medium', 'large', 'empire']).toContain(m.tier);
    expect(cv(w).cv).toBeGreaterThan(0.7);
  });

  it('“混合”格局里有很大的国家也有很小的国家；格局记在 countryRules 里', () => {
    const eng = nations();
    eng.exec({ op: 'regenerate_countries', layout: 'mixed' });
    const w = eng.world;
    expect(w.small.human!.countryRules!.layout).toBe('mixed');
    const r = cv(w);
    expect(r.max).toBeGreaterThan(2.5);
    expect(r.min).toBeLessThan(0.25);
    // 'era' 不记
    eng.exec({ op: 'regenerate_countries', layout: 'era' });
    expect(w.small.human!.countryRules!.layout).toBeUndefined();
  });

  it('界面估计的个数就是生成的个数（中世纪没有联邦）', () => {
    const w = nations().world;
    const era = worldEra(w.small)!;
    expect(estimateCountryCount(w, w.derived, era, 0.5)).toBe(countryList(w.small).length);
    const eng = nations();
    eng.exec({ op: 'regenerate_countries', fragmentation: 0.8 });
    expect(estimateCountryCount(eng.world, eng.world.derived, era, 0.8)).toBe(countryList(eng.world.small).length);
  });
});

describe('帝国、联邦、同盟', () => {
  it('中世纪：一片诸侯林立的地方并成帝国，皇帝国是最大的成员；帝国的外沿', () => {
    const w = nations().world;
    const empire = blocList(w.small).find((b) => b.kind === 'empire')!;
    expect(empire).toBeDefined();
    expect(empire.members.length).toBeGreaterThanOrEqual(3);
    expect(empire.members[0]).toBe(empire.leader);
    const st = allCountryStats(w);
    for (const id of empire.members) expect(st.get(id)!.areaKm2).toBeLessThanOrEqual(st.get(empire.leader)!.areaKm2);
    expect(empire.name).toContain(w.small.countries![empire.leader].base.zh);
    expect(blocOf(w, empire.members[1], 'empire')?.id).toBe(empire.id);
    // 外沿：成员的格是帝国的编号
    const g = blocBorderGroups(w);
    for (const id of empire.members) for (const i of countryCells(w, id)) expect(g[2 * i]).toBe(empire.id);
    // 成员各自一色
    const colors = countryMapColors(w);
    const code = (id: number) => countryList(w.small).findIndex((m) => m.id === id) + 1;
    expect(new Set(empire.members.map((id) => colors[code(id)]!.join(','))).size).toBe(empire.members.length);
    // 附庸有从属的种类
    const vassals = countryList(w.small).filter((m) => m.overlord !== undefined);
    for (const m of vassals) expect(['vassal', 'tributary']).toContain(m.subject);
  });

  it('现代：有军事同盟；联邦的成员邦在国家模式里是一种颜色、名字是成员的称号', () => {
    const w = moderns().world;
    const alliances = blocList(w.small).filter((b) => b.kind === 'alliance');
    expect(alliances.length).toBeGreaterThan(0);
    for (const b of alliances) expect(b.members.length).toBeGreaterThanOrEqual(2);
    const fed = blocList(w.small).find((b) => b.kind === 'federation')!;
    expect(fed).toBeDefined();
    expect(fed.members.length).toBeGreaterThanOrEqual(4);
    const colors = countryMapColors(w);
    const own = countryColors(w);
    const code = (id: number) => countryList(w.small).findIndex((m) => m.id === id) + 1;
    expect(new Set(fed.members.map((id) => colors[code(id)]!.join(','))).size).toBe(1);
    expect(new Set(fed.members.map((id) => own[code(id)]!.join(','))).size).toBe(fed.members.length);
    expect(federationColorOf(w.small).get(fed.members[1])).toBe(fed.color);
    for (const id of fed.members) {
      expect(w.small.countries![id].name.endsWith('州')).toBe(true);
      expect(w.small.countries![id].nameLocked).toBe(true);
      expect(countryCells(w, id).length).toBeGreaterThan(0);
    }
    // 同盟模式的颜色：在集团里的有颜色，不在的为 null
    const bc = blocMapColors(w);
    for (const m of countryList(w.small)) expect(bc[code(m.id)] === null).toBe(!blocOf(w, m.id));
    // 重放一致
    const again = Engine.fromDoc(moderns().toDoc(), w.mesh);
    expect(digest(again.world.small.blocs)).toBe(digest(w.small.blocs));
    expect(digest(again.world.causes.country)).toBe(digest(w.causes.country));
  });

  it('set_bloc：新建、改、删，都能撤销、重做；一个国家只在一个同盟里', () => {
    const eng = nations();
    const w = eng.world;
    const before = digest(w.small);
    const [a, b, c] = countryList(w.small).filter((m) => !blocOf(w, m.id));
    const id = nextBlocId(w.small);
    expect(eng.exec({ op: 'set_bloc', patch: { kind: 'alliance', members: [a.id, b.id], leader: a.id } })).toBe(`新建同盟“${a.base.zh}同盟” · 2 国`);
    const bloc = () => blocList(w.small).find((x) => x.id === id)!;
    expect(bloc().leader).toBe(a.id);
    eng.exec({ op: 'set_bloc', id, patch: { leader: b.id } });
    expect(bloc().name).toBe(`${b.base.zh}同盟`);
    eng.exec({ op: 'set_bloc', id, patch: { name: '北方同盟', members: [a.id, b.id, c.id] } });
    expect(bloc().name).toBe('北方同盟');
    expect(bloc().nameLocked).toBe(true);
    // 加进另一个同盟：从这一个退出
    const id2 = nextBlocId(w.small);
    eng.exec({ op: 'set_bloc', patch: { kind: 'alliance', members: [c.id] } });
    expect(bloc().members).not.toContain(c.id);
    expect(blocList(w.small).find((x) => x.id === id2)!.members).toEqual([c.id]);
    eng.exec({ op: 'set_bloc', id: id2, patch: null });
    expect(blocList(w.small).find((x) => x.id === id2)).toBeUndefined();
    expect(() => eng.exec({ op: 'set_bloc', patch: { kind: 'alliance', members: [] } })).toThrow();
    expect(() => eng.exec({ op: 'set_bloc', id: 999, patch: { name: 'x' } })).toThrow('找不到集团 999');
    for (let k = 0; k < 5; k++) eng.undo();
    expect(digest(w.small)).toBe(before);
    for (let k = 0; k < 5; k++) eng.redo();
    expect(bloc().name).toBe('北方同盟');
    const doc = eng.toDoc();
    expect(digest(Engine.fromDoc(doc, w.mesh).world.small.blocs)).toBe(digest(w.small.blocs));
  });

  it('合并、删除国家时同盟跟着整理：成员换掉、盟主换一个、空的去掉', () => {
    const eng = nations();
    const w = eng.world;
    const [a, b, c] = countryList(w.small).filter((m) => !blocOf(w, m.id));
    const id = nextBlocId(w.small);
    eng.exec({ op: 'set_bloc', patch: { kind: 'alliance', members: [a.id, b.id], leader: a.id } });
    eng.exec({ op: 'merge_countries', a: c.id, b: a.id });
    const bloc = () => blocList(w.small).find((x) => x.id === id);
    expect(bloc()!.members.sort()).toEqual([b.id, c.id].sort());
    expect(bloc()!.leader).toBe(c.id);
    expect(bloc()!.name).toBe(`${c.base.zh}同盟`);
    eng.exec({ op: 'remove_country', id: c.id });
    expect(bloc()!.members).toEqual([b.id]);
    expect(bloc()!.leader).toBe(b.id);
    eng.exec({ op: 'remove_country', id: b.id });
    expect(bloc()).toBeUndefined();
    // 拆分：分出的国家跟着进帝国
    const empire = blocList(w.small).find((x) => x.kind === 'empire')!;
    const lead = empire.leader;
    eng.exec({ op: 'split_country', id: lead });
    const fresh = Math.max(...countryList(w.small).map((m) => m.id));
    expect(blocList(w.small).find((x) => x.id === empire.id)!.members).toContain(fresh);
    // 删除国家时集团也去掉
    eng.exec({ op: 'remove_countries' });
    expect(w.small.blocs).toBeUndefined();
  });

  it('从属的种类：要有宗主；不再是附庸时去掉', () => {
    const eng = nations();
    const w = eng.world;
    const [a, b] = countryList(w.small).filter((m) => m.overlord === undefined && !countryList(w.small).some((x) => x.overlord === m.id));
    expect(() => eng.exec({ op: 'set_country', id: a.id, patch: { subject: 'protectorate' } })).toThrow('先选宗主');
    eng.exec({ op: 'set_country', id: a.id, patch: { overlord: b.id, subject: 'protectorate' } });
    expect(w.small.countries![a.id].subject).toBe('protectorate');
    eng.exec({ op: 'set_country', id: a.id, patch: { subject: null } });
    expect(w.small.countries![a.id].subject).toBeUndefined();
    eng.exec({ op: 'set_country', id: a.id, patch: { subject: 'dominion' } });
    eng.exec({ op: 'set_country', id: a.id, patch: { overlord: null } });
    expect(w.small.countries![a.id].subject).toBeUndefined();
  });
});

describe('大城市', () => {
  it('门槛是占本国人口的 3%；每国最多城市数的六分之一（向下取整），按人口取前几座', () => {
    const big = BUILTIN_RANKS.find((r) => r.id === 'big')!;
    expect(big.minShare).toBe(0.03);
    const w = moderns().world;
    const list = cityList(w);
    const by = new Map<number | null, typeof list>();
    for (const c of list) by.set(c.country, [...(by.get(c.country) ?? []), c]);
    let any = 0;
    for (const [, cs] of by) {
      const bigs = cs.filter((c) => c.rank.id === 'big' && c.rankAuto);
      any += bigs.length;
      expect(bigs.length).toBeLessThanOrEqual(Math.floor(cs.length * big.perCountry! + 1e-9));
      // 降下来的都比留下来的人少
      const down = cs.filter((c) => !c.capital && !c.secondCapital && c.rank.id !== 'big' && c.share >= big.minShare);
      for (const d of down) for (const k of bigs) expect(d.population).toBeLessThanOrEqual(k.population);
    }
    expect(any).toBeGreaterThan(0);
  });
});
