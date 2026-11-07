import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digest } from '../../digest';
import { Engine } from '../../engine';
import { BUILTIN_ERAS, ERA_PACKS } from '../../packs/eras';
import { continents, humanExec, snapshot } from '../../testing/fixtures';
import type { CountryMeta, World } from '../../world';
import { blocList, blocMapColors } from '../blocs';
import type { Era } from '../era';
import { registerHumanStage, unregisterHumanStage } from '../generate';
import { cellKm2 } from '../space';
import { countryList } from './base';
import { patternModules, roleText } from './patterns';
import { OUTPOSTS } from './patterns/outposts';
import { FOREST, RACE_REALMS, ROLE_FOREST, ROLE_HOLD, ROLE_HORDE, type RaceRealmState, UPLAND, WASTE } from './patterns/race-realms';
import { subjectText } from './records';
import type { CountryRun } from './state';

// 第七十五轮：奇幻的种族王国（race-realms）、科幻的殖民据点（outposts）。几块大陆的地区（continents：1.2 万格，种子 1、地形种子 5），
// 各时代用默认的文化组生成；生成时记下这一次的 CountryRun（加一步 peek）

let last: CountryRun | undefined;
beforeAll(() => registerHumanStage({ id: 'peek-75', run: (ctx) => void (last = ctx.countryRun) }, { after: 'blocs' }));
afterAll(() => unregisterHumanStage('peek-75'));

const groupsOf = (era: string) => ERA_PACKS.get(era)!.cultures.map(([id, weight]) => ({ id, weight }));
const runs = new Map<string, CountryRun>();
function peopled(era: string): { eng: Engine; run: CountryRun } {
  const eng = snapshot(`fiction-patterns:${era}`, () => {
    const e = continents();
    humanExec(e, { op: 'generate_human', era, groups: groupsOf(era), countries: {} });
    runs.set(era, last!);
    return e;
  });
  return { eng, run: runs.get(era)! };
}
const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
// 一些国家的国土（干的陆地）里有几成是这一类地方；pick 省略时是整个世界的陆地
function shareOf(w: World, land: Uint8Array, bit: number, pick?: (m: CountryMeta | undefined) => boolean): number {
  const metas = w.small.countries!;
  let all = 0;
  let hit = 0;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!dry(w, i) || (pick && !pick(metas[w.causes.country![i]]))) continue;
    const a = cellKm2(w, i);
    all += a;
    if (land[i] & bit) hit += a;
  }
  return hit / all;
}
const role = (r: string) => (m: CountryMeta | undefined) => m?.role === r;
// 时代里这一种格局的多少换掉，重新生成国家
const regenAmount = (eng: Engine, era: string, pattern: string, amount: number) => {
  const e = eng.clone();
  const item = e.world.small.content!.era![era] as Era;
  e.exec({ op: 'set_content', kind: 'era', id: era, item: { ...item, patterns: item.patterns!.map((p) => (p.pattern === pattern ? { ...p, amount } : p)) } as unknown as Record<string, unknown> });
  humanExec(e, { op: 'regenerate_countries' });
  return e;
};
const regenWith = (eng: Engine, id: string, patch: Record<string, unknown>) => {
  const e = eng.clone();
  const item = e.world.small.content!.countryPattern![id] as Record<string, unknown>;
  e.exec({ op: 'set_content', kind: 'countryPattern', id, item: { ...item, ...patch } });
  humanExec(e, { op: 'regenerate_countries' });
  return e;
};

describe('模块与时代', () => {
  it('种族王国在汗国之后、联邦之前；殖民据点在殖民地之后；时代没列时都不做', () => {
    const ids = patternModules().map((m) => m.id);
    expect(ids.indexOf(RACE_REALMS)).toBe(ids.indexOf('khanate') + 1);
    expect(ids.indexOf(RACE_REALMS)).toBeLessThan(ids.indexOf('alliance'));
    expect(ids.indexOf(OUTPOSTS)).toBe(ids.indexOf('colonies') + 1);
    for (const id of [RACE_REALMS, OUTPOSTS]) expect(patternModules().find((m) => m.id === id)!.fallback ?? 0).toBe(0);
  });

  it('奇幻：种族王国、军事同盟、封臣与朝贡（不再有神圣帝国）；科幻多了殖民据点；民族主义照旧', () => {
    const era = (id: string) => BUILTIN_ERAS.find((e) => e.id === id)!;
    expect((era('fantasy').patterns ?? []).map((p) => p.pattern)).toEqual(['race-realms', 'alliances', 'realm-vassals']);
    expect((era('scifi').patterns ?? []).map((p) => p.pattern)).toEqual(['federation', 'alliances', 'stellar-subjects', 'outposts']);
    expect([era('fantasy').nationalism, era('scifi').nationalism]).toEqual([0.2, 0.5]);
    // 两个模块只在奇幻、科幻
    const using = (p: string) => BUILTIN_ERAS.filter((e) => (e.patterns ?? []).some((x) => x.pattern === p)).map((e) => e.id);
    expect(using('race-realms')).toEqual(['fantasy']);
    expect(using('outposts')).toEqual(['scifi']);
  });

  it('角色的文字：档案里的一句', () => {
    expect(roleText(ROLE_FOREST)).toBe('古林王国');
    expect(roleText(ROLE_HOLD)).toBe('山中要塞同盟的成员');
    expect(roleText(ROLE_HORDE)).toBe('荒原部落联盟的成员');
    expect(roleText('holy-empire')).toBe('神圣帝国的成员');
    expect(roleText('city-league')).toBe('城邦同盟的成员');
    expect(roleText('nation-state')).toBe('民族国家');
    expect(roleText('nope')).toBeUndefined();
    expect(subjectText('company', '某国')).toBe('公司领地 · 宗主 某国');
  });
});

describe('奇幻：种族王国', () => {
  it('种族跟着“喜欢的地方”：精灵住古林、矮人住山地、兽人住荒原，人类和偏爱弱的种族住平原（不写死种族的 id）', () => {
    const { run } = peopled('fantasy');
    const st = run.state.get(RACE_REALMS) as RaceRealmState;
    expect(st.dim).toBe('race');
    const kinds = Object.fromEntries(st.races);
    expect([kinds.elf, kinds.dwarf, kinds.orc, kinds.human, kinds.halfling, kinds.gnome]).toEqual(['forest', 'upland', 'waste', 'open', 'open', 'open']);
  });

  it('精灵的王国大半在森林里（比整个世界的比例高得多）', () => {
    const { eng, run } = peopled('fantasy');
    const w = eng.world;
    const st = run.state.get(RACE_REALMS) as RaceRealmState;
    expect(countryList(w.small).filter((m) => m.role === ROLE_FOREST).length).toBeGreaterThan(0);
    const elf = shareOf(w, st.land, FOREST, role(ROLE_FOREST));
    expect(elf).toBeGreaterThan(0.5);
    expect(elf).toBeGreaterThan(1.5 * shareOf(w, st.land, FOREST));
    // 守着古林是 0 时和别的国家一样，森林少得多
    const off = regenWith(eng, 'race-realms', { forest: 0 });
    expect(shareOf(off.world, st.land, FOREST, role(ROLE_FOREST))).toBeLessThan(elf - 0.1);
  });

  it('矮人：山里几个要塞小国，在一个同盟里；国土多半是山地', () => {
    const { eng, run } = peopled('fantasy');
    const w = eng.world;
    const st = run.state.get(RACE_REALMS) as RaceRealmState;
    const holds = countryList(w.small).filter((m) => m.role === ROLE_HOLD);
    expect(holds.length).toBeGreaterThanOrEqual(3);
    const bloc = blocList(w.small).filter((b) => holds.some((m) => b.members.includes(m.id)));
    expect(bloc.length).toBe(1);
    expect(bloc[0].kind).toBe('alliance');
    expect(holds.every((m) => bloc[0].members.includes(m.id))).toBe(true);
    const share = shareOf(w, st.land, UPLAND, role(ROLE_HOLD));
    expect(share).toBeGreaterThan(0.6);
    expect(share).toBeGreaterThan(1.5 * shareOf(w, st.land, UPLAND));
    // 都是矮人的文化
    const races = new Map(run.ctx.cultures.map((c, k) => [c.id, st.raceOf[k]]));
    expect(holds.every((m) => races.get(m.primaryCulture) === 'dwarf')).toBe(true);
  });

  it('兽人：荒原上几个部落结成部落联盟（帝国一类，名字锁定）；国土里荒原比整个世界多', () => {
    const { eng, run } = peopled('fantasy');
    const w = eng.world;
    const st = run.state.get(RACE_REALMS) as RaceRealmState;
    const horde = countryList(w.small).filter((m) => m.role === ROLE_HORDE);
    expect(horde.length).toBeGreaterThanOrEqual(3);
    const bloc = blocList(w.small).filter((b) => b.kind === 'empire' && horde.some((m) => b.members.includes(m.id)));
    expect(bloc.length).toBe(1);
    expect(bloc[0].name.endsWith('部落联盟')).toBe(true);
    expect(bloc[0].nameLocked).toBe(true);
    expect(shareOf(w, st.land, WASTE, role(ROLE_HORDE))).toBeGreaterThan(1.3 * shareOf(w, st.land, WASTE));
    const races = new Map(run.ctx.cultures.map((c, k) => [c.id, st.raceOf[k]]));
    expect(horde.every((m) => races.get(m.primaryCulture) === 'orc')).toBe(true);
  });

  it('精灵、要塞、部落让出来的能住人的地方归别的王国：按宜居度算的有主的陆地至少七成八（第七十四轮约八成一）', () => {
    const { eng } = peopled('fantasy');
    const w = eng.world;
    let all = 0;
    let owned = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!dry(w, i)) continue;
      const h = w.derived.habitability![i];
      all += h;
      if (w.causes.country![i] >= 0) owned += h;
    }
    expect(owned / all).toBeGreaterThanOrEqual(0.78);
  });

  it('多少是 0：没有要塞、部落，也不按种族长（角色都没有）', () => {
    const { eng } = peopled('fantasy');
    const off = regenAmount(eng, 'fantasy', 'race-realms', 0);
    expect(countryList(off.world.small).filter((m) => m.role?.startsWith(RACE_REALMS))).toEqual([]);
  });
});

describe('科幻：殖民据点', () => {
  it('有几个，很小，散在本地种族的地方；宗主是本族最大的几国之一', () => {
    const { eng, run } = peopled('scifi');
    const w = eng.world;
    const metas = w.small.countries!;
    const posts = countryList(w.small).filter((m) => m.role === OUTPOSTS);
    expect(posts.length).toBeGreaterThanOrEqual(4);
    const area = new Map<number, number>();
    for (let i = 0; i < w.mesh.n; i++) if (dry(w, i) && w.causes.country![i] >= 0) area.set(w.causes.country![i], (area.get(w.causes.country![i]) ?? 0) + cellKm2(w, i));
    const all = [...area.values()];
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const home = (run.state.get(OUTPOSTS) as { home: number }).home;
    const homeGroup = run.ctx.groups[home].group.id;
    const groupOf = (c: string) => (w.small.content!.culture![c] as { group: string }).group;
    // 很小：每个不到平均的国家的六成，中间的那个不到三成五（算上整理时补进来的地方）；每个都比宗主小
    const sizes = posts.map((m) => area.get(m.id)!).sort((a, b) => a - b);
    expect(sizes.at(-1)!).toBeLessThanOrEqual(0.6 * mean);
    expect(sizes[Math.floor(sizes.length / 2)]).toBeLessThanOrEqual(0.35 * mean);
    for (const m of posts) {
      expect(area.get(m.id)!).toBeLessThan(area.get(m.overlord!)!);
      expect(m.overlord).toBeDefined();
      expect(['company', 'colony']).toContain(m.subject);
      const lord = metas[m.overlord!];
      expect(groupOf(lord.primaryCulture)).toBe(homeGroup);
      // 据点那一格的文化不是本族的
      expect(run.ctx.groups[run.ctx.cultureGroup[run.ctx.cultureOf![m.capitalCell!]]].group.id).not.toBe(homeGroup);
      expect(m.name.startsWith(lord.base.zh)).toBe(true);
      if (m.subject === 'company') expect(m.name.endsWith('公司领地')).toBe(true);
      expect(m.history).toContain(m.subject === 'company' ? '公司领地' : '殖民地');
    }
    expect(posts.some((m) => m.subject === 'company')).toBe(true);
  });

  it('颜色是宗主的浅色；同盟模式里跟着宗主', () => {
    const { eng } = peopled('scifi');
    const w = eng.world;
    const metas = w.small.countries!;
    const list = countryList(w.small);
    const code = (id: number) => list.findIndex((m) => m.id === id) + 1;
    const bc = blocMapColors(w);
    const lum = (hex: string) => [1, 3, 5].reduce((s, k) => s + parseInt(hex.slice(k, k + 2), 16), 0);
    for (const m of list.filter((x) => x.role === OUTPOSTS)) {
      expect(lum(m.color)).toBeGreaterThan(lum(metas[m.overlord!].color));
      expect(bc[code(m.id)]).toEqual(bc[code(m.overlord!)]);
    }
  });

  it('多少是 0：没有据点；重放出来逐值相同', () => {
    const { eng } = peopled('scifi');
    const off = regenAmount(eng, 'scifi', 'outposts', 0);
    expect(countryList(off.world.small).filter((m) => m.role === OUTPOSTS || m.subject === 'company')).toEqual([]);
    const b = continents();
    humanExec(b, { op: 'generate_human', era: 'scifi', groups: groupsOf('scifi'), countries: {} });
    expect(digest(b.world.small.countries)).toBe(digest(eng.world.small.countries));
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(digest(again.world.small.countries)).toBe(digest(eng.world.small.countries));
  });
});
