import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digest } from '../../digest';
import { Engine } from '../../engine';
import { BUILTIN_ERAS, ERA_PACKS } from '../../packs/eras';
import { continents, humanExec, snapshot } from '../../testing/fixtures';
import type { World } from '../../world';
import { blocList, blocMapColors } from '../blocs';
import { readComp } from '../groups';
import type { Era } from '../era';
import { registerHumanStage, unregisterHumanStage } from '../generate';
import { cellKm2 } from '../space';
import { countryList } from './base';
import { subjectText } from './records';
import { landComponents } from './count';
import { patternModules } from './patterns';
import { CENTRAL_EMPIRE } from './patterns/central-empire';
import { steppeSpecies } from './patterns/common';
import { KHANATE } from './patterns/khanate';
import { NATION_STATE, type NationStateLog } from './patterns/nation-state';
import { RIVER_EMPIRE } from './patterns/river-empire';
import { UNIFICATION } from './patterns/unification';
import type { CountryRun, Seed } from './state';

// 第七十四轮：各时代的历史格局（城邦群、大河帝国、集权帝国、汗国、殖民地、民族统一、多民族帝国、民族国家、前殖民地国家）与民族主义。
// 都在几块大陆的地区（continents：1.2 万格，种子 1、地形种子 5）上，各时代用默认的文化组生成；生成时记下这一次的 CountryRun（加一步 peek）

let last: CountryRun | undefined;
beforeAll(() => registerHumanStage({ id: 'peek-74', run: (ctx) => void (last = ctx.countryRun) }, { after: 'blocs' }));
afterAll(() => unregisterHumanStage('peek-74'));

const groupsOf = (era: string) => ERA_PACKS.get(era)!.cultures.map(([id, weight]) => ({ id, weight }));
// 一个时代生成一次（同一个文件里共用）
const runs = new Map<string, CountryRun>();
function peopled(era: string): { eng: Engine; run: CountryRun } {
  const eng = snapshot(`era-patterns:${era}`, () => {
    const e = continents();
    humanExec(e, { op: 'generate_human', era, groups: groupsOf(era), countries: {} });
    runs.set(era, last!);
    return e;
  });
  return { eng, run: runs.get(era)! };
}
const idOf = (g: CountryRun, s: Seed) => g.ids![g.seeds.indexOf(s)];
const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
function areas(w: World): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.country![i] >= 0 && dry(w, i)) out.set(w.causes.country![i], (out.get(w.causes.country![i]) ?? 0) + cellKm2(w, i));
  return out;
}
const eraOf = (eng: Engine, id: string) => eng.world.small.content!.era![id] as Era;
const setEra = (eng: Engine, era: Era) => eng.exec({ op: 'set_content', kind: 'era', id: era.id, item: era as unknown as Record<string, unknown> });

describe('模块', () => {
  it('按调的先后登记；时代没列时只有附庸、民族主义照旧（1）', () => {
    expect(patternModules().map((m) => m.id)).toEqual([
      'holy-empire',
      'city-league',
      'river-empire',
      'central-empire',
      'khanate',
      'federation',
      'alliance',
      'vassals',
      'colonies',
      'multiethnic',
      'nationalism',
      'unification',
      'nation-state',
      'post-colonial',
    ]);
    expect(patternModules().filter((m) => (m.fallback ?? 0) > 0).map((m) => m.id)).toEqual(['vassals', 'nationalism']);
  });

  it('内置的时代：古典有城邦群、大河帝国，中世纪有集权帝国、汗国，近现代有殖民地、统一、多民族帝国，现代有民族国家、前殖民地国家', () => {
    const listed = (id: string) => (BUILTIN_ERAS.find((e) => e.id === id)!.patterns ?? []).map((p) => p.pattern);
    expect(listed('antiquity')).toEqual(['city-league', 'river-empire', 'tributaries']);
    expect(listed('medieval')).toEqual(['holy-empire', 'central-empire', 'feudal-vassals', 'khanate']);
    expect(listed('industrial')).toEqual(expect.arrayContaining(['colonies', 'unification', 'multiethnic', 'federation', 'alliances', 'protectorates']));
    expect(listed('modern')).toEqual(expect.arrayContaining(['nation-state', 'post-colonial', 'federation', 'alliances', 'client-states']));
    // 殖民地只在近现代
    expect(BUILTIN_ERAS.filter((e) => (e.patterns ?? []).some((p) => p.pattern === 'colonies')).map((e) => e.id)).toEqual(['industrial']);
  });
});

describe('青铜与古典', () => {
  it('城邦群：一个同盟里至少 8 个城邦级的国家', () => {
    const { eng } = peopled('antiquity');
    const w = eng.world;
    const metas = w.small.countries!;
    const cities = blocList(w.small)
      .filter((b) => b.kind === 'alliance')
      .map((b) => b.members.filter((id) => metas[id]?.tier === 'city').length);
    expect(Math.max(0, ...cities)).toBeGreaterThanOrEqual(8);
  });

  it('大河帝国：国土六成以上在最大的河谷里，占了那条河的一半以上', () => {
    const { eng, run } = peopled('antiquity');
    const w = eng.world;
    const st = run.state.get(RIVER_EMPIRE) as { list: { seed: Seed; basin: number }[] };
    expect(st.list.length).toBe(1);
    const { seed, basin } = st.list[0];
    const id = idOf(run, seed);
    let mine = 0;
    let inBasin = 0;
    let river = 0;
    let ownRiver = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!dry(w, i)) continue;
      const own = w.causes.country![i] === id;
      const b = w.derived.basin[i] === basin;
      if (own) mine++;
      if (own && b) inBasin++;
      if (b && w.derived.discharge[i] >= w.small.planet.riverThreshold) {
        river++;
        if (own) ownRiver++;
      }
    }
    expect(inBasin / mine).toBeGreaterThan(0.6);
    expect(ownRiver / river).toBeGreaterThan(0.5);
  });
});

describe('中世纪', () => {
  it('集权帝国：最大的国家，不在帝国、联邦里（没有成员国）', () => {
    const { eng, run } = peopled('medieval');
    const w = eng.world;
    const [seed] = run.state.get(CENTRAL_EMPIRE) as Seed[];
    const id = idOf(run, seed);
    const a = areas(w);
    expect(Math.max(...a.values())).toBe(a.get(id));
    expect(blocList(w.small).filter((b) => b.kind !== 'alliance' && b.members.includes(id))).toEqual([]);
  });

  it('游牧汗国：国土大半是草原、荒漠（比整个世界的比例高得多）', () => {
    const { eng, run } = peopled('medieval');
    const w = eng.world;
    const { seeds } = run.state.get(KHANATE) as { seeds: Seed[] };
    const id = idOf(run, seeds[0]);
    const sp = steppeSpecies(w.small.species);
    const steppe = (i: number) => w.derived.dominant[i] >= 0 && sp[w.derived.dominant[i]] === 1;
    let all = 0;
    let allS = 0;
    let mine = 0;
    let mineS = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!dry(w, i)) continue;
      all++;
      if (steppe(i)) allS++;
      if (w.causes.country![i] !== id) continue;
      mine++;
      if (steppe(i)) mineS++;
    }
    expect(mineS / mine).toBeGreaterThan(0.5);
    expect(mineS / mine).toBeGreaterThan(1.5 * (allS / all));
  });

  it('国家少的世界（统一）：放不下的格局不放，照样生成', () => {
    const { eng } = peopled('medieval');
    const e = eng.clone();
    humanExec(e, { op: 'regenerate_countries', fragmentation: 0 });
    const n = countryList(e.world.small).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(6);
  });
});

describe('近现代', () => {
  it('殖民地：有，宗主的首都在另一块陆地上；颜色是宗主的浅色，名字是宗主的地名 + 殖民地的称号', () => {
    const { eng } = peopled('industrial');
    const w = eng.world;
    const metas = w.small.countries!;
    const col = countryList(w.small).filter((m) => m.subject === 'colony');
    expect(col.length).toBeGreaterThan(0);
    const { id: comp } = landComponents(w);
    for (const m of col) {
      const lord = metas[m.overlord!];
      expect(comp[lord.capitalCell!]).not.toBe(comp[m.capitalCell!]);
      expect(m.name.startsWith(lord.base.zh)).toBe(true);
      expect(m.history).toContain('殖民地');
      const lum = (hex: string) => [1, 3, 5].reduce((s, k) => s + parseInt(hex.slice(k, k + 2), 16), 0);
      expect(lum(m.color)).toBeGreaterThan(lum(lord.color));
    }
  });

  it('殖民地：同盟模式里跟着宗主；档案写“殖民地 · 宗主国”；人口里新土认同比别处多', () => {
    const { eng } = peopled('industrial');
    const w = eng.world;
    const list = countryList(w.small);
    const code = (id: number) => list.findIndex((m) => m.id === id) + 1;
    const bc = blocMapColors(w);
    const col = list.filter((m) => m.subject === 'colony');
    for (const m of col) expect(bc[code(m.id)]).toEqual(bc[code(m.overlord!)]);
    expect(subjectText('colony', '某国')).toBe('殖民地 · 宗主国 某国');
    // 新土认同的人占多少（殖民地里、别处）
    const ids = new Set(col.map((m) => m.id));
    const share = [0, 0, 0, 0];
    for (let i = 0; i < w.mesh.n; i++) {
      const c = w.causes.country![i];
      if (c < 0 || !(w.causes.popTotal![i] > 0)) continue;
      const k = ids.has(c) ? 0 : 2;
      for (const x of readComp(w.causes, i)) {
        share[k + 1] += x.s * w.causes.popTotal![i];
        if (w.small.popGroups![x.code]?.values.nation === 'settler') share[k] += x.s * w.causes.popTotal![i];
      }
    }
    expect(share[0] / share[1]).toBeGreaterThan(2 * (share[2] / share[3]));
  });

  it('民族统一：并掉了几国，国家比不统一时少', () => {
    const { eng, run } = peopled('industrial');
    expect(run.state.get(UNIFICATION)).toBeGreaterThan(0);
    const era = eraOf(eng, 'industrial');
    const off = eng.clone();
    setEra(off, { ...era, patterns: era.patterns!.filter((p) => p.pattern !== 'unification') });
    humanExec(off, { op: 'regenerate_countries' });
    expect(countryList(eng.world.small).length).toBeLessThan(countryList(off.world.small).length);
  });

  it('多民族帝国：境内有好几个文化组', () => {
    const { eng, run } = peopled('industrial');
    const me = run.seeds.flatMap((s, o) => (s.multiethnic ? [run.ids![o]] : []));
    expect(me.length).toBe(1);
    expect(eng.world.small.countries![me[0]].acceptedGroups.length).toBeGreaterThanOrEqual(2);
  });
});

describe('现代', () => {
  it('民族国家：至少一个文化组并成一国，至少一个按文化分成一族一国', () => {
    const { eng, run } = peopled('modern');
    const w = eng.world;
    const log = run.state.get(NATION_STATE) as NationStateLog;
    expect(log.unified.length).toBeGreaterThan(0);
    expect(log.split.length).toBeGreaterThan(0);
    const groupOf = (culture: string) => w.small.content!.culture![culture] as { group: string };
    const ctxGroups = run.ctx.groups.map((g) => g.group.id);
    const list = countryList(w.small);
    // 并成一国的组：这一组为主流的国家比照旧时少
    const era = eraOf(eng, 'modern');
    const off = eng.clone();
    setEra(off, { ...era, patterns: era.patterns!.filter((p) => p.pattern !== 'nation-state') });
    humanExec(off, { op: 'regenerate_countries' });
    const count = (ws: World, gid: string) => countryList(ws.small).filter((m) => groupOf(m.primaryCulture).group === gid).length;
    expect(log.unified.some((gr) => count(w, ctxGroups[gr]) < count(off.world, ctxGroups[gr]))).toBe(true);
    // 一族一国的组：这一组为主流的国家，主流文化各不相同
    for (const gr of log.split) {
      const cultures = list.filter((m) => groupOf(m.primaryCulture).group === ctxGroups[gr]).map((m) => m.primaryCulture);
      expect(new Set(cultures).size).toBe(cultures.length);
      expect(cultures.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('民族主义', () => {
  // 人住的格里，主流文化和所在国家的主流文化相同的比例
  function follows(w: World): number {
    const metas = w.small.countries!;
    let all = 0;
    let same = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const c = w.causes.country![i];
      const code = w.causes.popGroup?.[i * 4];
      if (c < 0 || !dry(w, i) || !code) continue;
      all++;
      if (w.small.popGroups![code]?.culture === metas[c]?.primaryCulture) same++;
    }
    return same / all;
  }

  it('国界跟着文化：民族主义 0.85 比 0 跟得紧', () => {
    const { eng } = peopled('industrial');
    const era = eraOf(eng, 'industrial');
    const at = (v: number) => {
      const e = eng.clone();
      setEra(e, { ...era, patterns: [], nationalism: v });
      humanExec(e, { op: 'regenerate_countries' });
      return follows(e.world);
    };
    expect(at(0.85)).toBeGreaterThan(at(0) + 0.02);
  });
});

describe('重放、锁定', () => {
  it('同样的命令重放出来逐值相同；从文件读回来也一样', () => {
    for (const era of ['antiquity', 'medieval', 'industrial', 'modern']) {
      const { eng } = peopled(era);
      const b = continents();
      humanExec(b, { op: 'generate_human', era, groups: groupsOf(era), countries: {} });
      expect(digest(b.world.causes.country!), era).toBe(digest(eng.world.causes.country!));
      expect(digest(b.world.small.countries), era).toBe(digest(eng.world.small.countries));
      expect(digest(b.world.small.blocs ?? null), era).toBe(digest(eng.world.small.blocs ?? null));
      const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
      expect(digest(again.world.small.countries), era).toBe(digest(eng.world.small.countries));
    }
  });

  it('锁定的国家（殖民地和它的宗主）重新生成时领土、档案都不动（殖民地照旧是殖民地）', () => {
    const { eng } = peopled('industrial');
    const w = eng.world;
    const col = countryList(w.small).find((m) => m.subject === 'colony')!;
    const big = col.overlord!;
    const e = eng.clone();
    for (const id of [col.id, big]) e.exec({ op: 'set_country', id, patch: { locked: true } });
    const cells = (ws: World, id: number) => [...ws.causes.country!.keys()].filter((i) => ws.causes.country![i] === id && ws.causes.land[i]);
    const before = [col.id, big].map((id) => [cells(e.world, id), JSON.stringify({ ...e.world.small.countries![id], allies: [], rivals: [], history: '' })]);
    humanExec(e, { op: 'regenerate_countries', seed: 77 });
    const after = [col.id, big].map((id) => [cells(e.world, id), JSON.stringify({ ...e.world.small.countries![id], allies: [], rivals: [], history: '' })]);
    expect(after).toEqual(before);
    expect(digest(e.world.small.countries)).not.toBe(digest(w.small.countries));
  });
});
