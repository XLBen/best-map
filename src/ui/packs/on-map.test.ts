import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { enableCommand, itemId, kindOf } from '../../../core/content/registry';
import type { Engine } from '../../../core/engine';
import { packItems } from '../../../core/packs';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../../../core/packs/import';
import type { Species } from '../../../core/species';
import { NO_CURRENTS, engineFor, setGroupWeights } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { RegenTrack } from '../../regen-track';
import { blankItem } from './fields';
import { AFTER_REGEN, NO_CITIES_YET, NO_COUNTRIES_YET, NO_HUMAN_YET, type OnMap, onMapOf } from './on-map';
import type { PageCtx } from './pages';
import { regenNeed } from './regen';

// 第九十轮：一项顶上的“在地图上”一行——用在多少格、多少国家、多少城市；没用上时的每一种原因和它的一键解法。
// 给了命令的解法都真的执行一遍：做完以后这一行不再是那个原因

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ROOTS = BUILTIN.map((e) => ({ key: e.key, pack: e.pack }));
const ctxOf = (e: Engine): PageCtx => ({ world: { ...e.world }, lib: BUILTIN });

let bare: Engine;
let full: Engine;
beforeAll(() => {
  bare = engineFor({ cells: 3000, seed: 2 }, { bare: true });
  bare.exec(NO_CURRENTS);
  bare.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  bare.exec({ op: 'generate_provinces', seed: 1 });
  library.value = BUILTIN;
  full = worldOf();
});

// more：生成人文时一起生成什么（国家、城市）；null：不生成人文
function worldOf(more: Record<string, unknown> | null = { countries: {}, settlements: {} }, lib = 'medieval'): Engine {
  const e = bare.clone();
  const root = builtinPacks().find((p) => p.id === lib)!;
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf(lib))) e.exec(c);
  const groups = packItems<{ id: string; weight?: number }>(root, 'cultureGroups')
    .filter((g) => g.weight !== 0)
    .slice(0, 3)
    .map((g) => ({ id: g.id, weight: 1 }));
  for (const c of packImportCommands(ROOTS, { packs: [[lib]], groups: groups.map((g) => g.id) }, e.world)) e.exec(c);
  setGroupWeights(e, groups);
  if (more) e.exec({ op: 'generate_human', packs: [[lib]], groups: groups.map((g) => g.id), ...more } as Command);
  e.update();
  return e;
}

const items = (e: Engine, kind: string) => kindOf(kind)!.inWorld(e.world) as Record<string, unknown>[];
const item = (e: Engine, kind: string, id: string) => items(e, kind).find((x) => itemId(kindOf(kind)!, x) === id)!;
const put = (e: Engine, kind: string, next: Record<string, unknown>) => {
  e.exec(enableCommand(kindOf(kind)!, next, e.world));
  e.update();
};
// 新建一项（界面的“新建”：登记的空样子，id 不撞），再改几项
function add(e: Engine, kind: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const k = kindOf(kind)!;
  const blank = { ...blankItem(k, new Set(items(e, kind).map((x) => itemId(k, x))))!, ...patch };
  put(e, kind, blank);
  return item(e, kind, String(blank.id));
}
const at = (e: Engine, kind: string, id: string, need: ReturnType<typeof regenNeed> = null): OnMap => onMapOf(kindOf(kind)!, id, item(e, kind, id), ctxOf(e), need)!;
// 执行解法的命令
function fix(e: Engine, m: OnMap) {
  expect(m.fix?.t).toBe('command');
  e.exec((m.fix as Extract<NonNullable<OnMap['fix']>, { t: 'command' }>).cmd);
  e.update();
}
// 生成之后改了内容：现在要重新生成什么
function needAfter(e: Engine, edit: () => void) {
  const t = new RegenTrack();
  t.reset(0, e.world.small.content);
  edit();
  t.step(1, e.world.small.content);
  return regenNeed(e.world.small, t.base(), BUILTIN);
}

describe('在地图上：自然', () => {
  it('生态：长在几格、能定位；自然生成关着 · 打开', () => {
    const e = full.clone();
    const sp = e.world.small.species.map((s, k) => ({ s, n: e.world.derived.dominant.filter((d) => d === k).length })).sort((a, b) => b.n - a.n)[0];
    const m = at(e, 'biome', sp.s.id);
    expect(m).toMatchObject({ used: true, text: `长在 ${sp.n.toLocaleString('en-US')} 格` });
    expect(m.cells!.length).toBe(Math.min(sp.n, 20000));
    // 新建的生态自然生成开着：建好就写长在几格；能撤销
    const made = add(e, 'biome') as unknown as Species;
    expect(made.natural).toBe(true);
    const fresh = at(e, 'biome', made.id);
    expect(fresh.used).toBe(true);
    expect(fresh.text).toMatch(/^长在 [\d,]+ 格$/);
    // 关掉自然生成：没用上，写原因，一键打开
    put(e, 'biome', { ...made, natural: false });
    const off = at(e, 'biome', made.id);
    expect(off).toMatchObject({ used: false, text: '自然生成关着，也没涂它', fix: { t: 'command', label: '打开' } });
    fix(e, off);
    expect(at(e, 'biome', made.id).text).toBe(fresh.text);
    e.undo();
    e.undo();
    e.undo();
    expect(e.world.small.species.some((s) => s.id === made.id)).toBe(false);
  });

  it('生态：开着也没长（没有适合的地方）写原因', () => {
    const e = full.clone();
    const made = add(e, 'biome', { competition: 0.01, tolerances: [{ field: 'tMean', min: 80, optLow: 85, optHigh: 90, max: 95 }] });
    expect(at(e, 'biome', String(made.id))).toEqual({ used: false, text: '没有适合它、又争得过别的生态的地方' });
  });

  it('河、湖：新建的自然生成开着但还没条件 · 去选；关着 · 打开；选了生态就有河道', () => {
    const e = full.clone();
    const river = add(e, 'riverType');
    expect(river.natural).toBe(true);
    expect(at(e, 'riverType', String(river.id))).toEqual({ used: false, text: '还没选生态、写条件', fix: { t: 'segment', label: '去选', seg: 'where' } });
    put(e, 'riverType', { ...river, natural: false });
    const off = at(e, 'riverType', String(river.id));
    expect(off).toMatchObject({ used: false, text: '自然生成关着，也没有画的河选它', fix: { t: 'command', label: '打开' } });
    fix(e, off);
    expect(item(e, 'riverType', String(river.id)).natural).toBe(true);
    // 所有生态里的河都是它
    put(e, 'riverType', { ...item(e, 'riverType', String(river.id)), biomes: e.world.small.species.map((s) => s.id) });
    const on = at(e, 'riverType', String(river.id));
    expect(on.used).toBe(true);
    expect(on.text).toMatch(/^河道 [\d,]+ 格$/);
    expect(on.cells!.length).toBeGreaterThan(0);
    // 条件谁都不满足
    put(e, 'riverType', { ...item(e, 'riverType', String(river.id)), biomes: [] });
    expect(at(e, 'riverType', String(river.id))).toEqual({ used: false, text: '没有符合条件的河', fix: { t: 'segment', label: '看条件', seg: 'where' } });
    const lake = add(e, 'lakeType');
    expect(lake.natural).toBe(true);
    expect(at(e, 'lakeType', String(lake.id)).text).toBe('还没选生态、写条件');
    put(e, 'lakeType', { ...lake, natural: false });
    expect(at(e, 'lakeType', String(lake.id)).text).toBe('自然生成关着，也没有放的湖选它');
  });

  it('地形类别、资源：占几格；规则谁都不满足时写原因', () => {
    const e = full.clone();
    const cls = items(e, 'terrainClass')
      .map((c) => at(e, 'terrainClass', String(c.id)))
      .find((m) => m.used)!;
    expect(cls.text).toMatch(/^占 [\d,]+ 格$/);
    const none = add(e, 'terrainClass', { rules: [{ elevMin: 99999 }] });
    expect(at(e, 'terrainClass', String(none.id))).toEqual({ used: false, text: '没有符合自动规则的地方', fix: { t: 'segment', label: '看规则', seg: 'rules' } });
    const res = items(e, 'resource')
      .map((r) => at(e, 'resource', String(r.id)))
      .find((m) => m.used)!;
    expect(res.text).toMatch(/^占 [\d,]+ 格$/);
    const rare = add(e, 'resource', { rules: [{ elevMin: 99999 }] });
    expect(at(e, 'resource', String(rare.id)).text).toBe('没有符合条件的地方');
  });

  it('岛、地名风格、画风、省份划分', () => {
    const e = full.clone();
    const isle = items(e, 'islandType')[0];
    expect(at(e, 'islandType', String(isle.id))).toEqual({ used: false, text: '还没放这种岛' });
    // 地名风格：世界默认的在用；新建的没人用 · 设为默认
    const styles = items(e, 'nameStyle');
    const used = styles.map((s) => at(e, 'nameStyle', String(s.id))).filter((m) => m.used);
    expect(used.some((m) => m.text.startsWith('世界默认的地名风格'))).toBe(true);
    const style = add(e, 'nameStyle');
    const off = at(e, 'nameStyle', String(style.id));
    expect(off).toMatchObject({ used: false, text: '没有地名、文化用它', fix: { t: 'command', label: '设为默认' } });
    fix(e, off);
    expect(at(e, 'nameStyle', String(style.id)).text).toMatch(/^世界默认的地名风格/);
    // 画风：在用的一种；别的 · 用它
    const looks = items(e, 'mapStyle').map((s) => ({ id: String(s.id), m: at(e, 'mapStyle', String(s.id)) }));
    expect(looks.filter((x) => x.m.used).map((x) => x.m.text)).toEqual(['地图正用这种画风']);
    const other = looks.find((x) => !x.m.used);
    if (other) {
      expect(other.m).toMatchObject({ text: '没在用', fix: { t: 'command', label: '用它' } });
      fix(e, other.m);
      expect(at(e, 'mapStyle', other.id).used).toBe(true);
    }
    // 省份划分
    const rules = items(e, 'provinceRules')[0];
    expect(at(e, 'provinceRules', String(rules.id)).text).toMatch(/^[\d,]+ 个省份按它划分$/);
    const blank = engineFor({ cells: 3000, seed: 2 }, { bare: true });
    for (const c of newWorldContentCommands(ROOTS, worldPartsOf('medieval'))) blank.exec(c);
    blank.update();
    const r0 = items(blank, 'provinceRules')[0];
    const no = at(blank, 'provinceRules', String(r0.id));
    expect(no).toMatchObject({ used: false, text: '还没有划分省份', fix: { t: 'command', label: '划分省份' } });
  });
});

describe('在地图上：人文', () => {
  it('还没有生成人文：时代、文化、政体、城市等级都写这一句，按钮去生成', () => {
    const e = worldOf(null);
    const fixTo = { t: 'panel', label: '去生成', panel: 'cat:culture' };
    for (const kind of ['era', 'cultureGroup', 'culture', 'government', 'countryTier', 'cityRank']) {
      const x = items(e, kind)[0];
      expect(at(e, kind, itemId(kindOf(kind)!, x)), kind).toEqual({ used: false, text: NO_HUMAN_YET, fix: fixTo });
    }
  });

  it('时代：这张地图的时代，几个国家、几座城市', () => {
    const e = full.clone();
    const id = e.world.small.human!.era;
    const n = Object.keys(e.world.small.countries!).length;
    const c = Object.keys(e.world.small.cities!).length;
    expect(at(e, 'era', id)).toEqual({ used: true, text: `这张地图的时代：${n} 个国家、${c} 座城市` });
    const other = add(e, 'era');
    expect(at(e, 'era', String(other.id)).text).toBe(`这张地图用的是“${item(e, 'era', id).name}”`);
  });

  it('文化组：有这一组的人的格；没参与生成 · 加进来（做完就参与了）', () => {
    const e = full.clone();
    const joined = e.world.small.human!.groups[0];
    const m = at(e, 'cultureGroup', joined);
    expect(m.used).toBe(true);
    expect(m.text).toMatch(/^[\d,]+ 格有这一组的人/);
    expect(m.cells!.length).toBeGreaterThan(0);
    const g = add(e, 'cultureGroup');
    add(e, 'culture', { group: g.id });
    const off = at(e, 'cultureGroup', String(g.id));
    expect(off).toMatchObject({ used: false, text: '没参与生成', fix: { t: 'command', label: '加进来' } });
    fix(e, off);
    expect(e.world.small.human!.groups).toContain(g.id);
    expect(at(e, 'cultureGroup', String(g.id)).text).not.toBe('没参与生成');
    // 多少是 0 的组
    const zero = add(e, 'cultureGroup', { weight: 0 });
    expect(at(e, 'cultureGroup', String(zero.id)).text).toBe('多少是 0，没参与生成');
    // 本世界自己新建的组下次重新生成就会参与：底下有“改了 N 项”时，这一行的按钮就是那一步
    const e2 = full.clone();
    let made = '';
    let inside = '';
    const need = needAfter(e2, () => {
      made = String(add(e2, 'cultureGroup').id);
      inside = String(add(e2, 'culture', { group: made }).id);
    });
    expect(need?.scopes).toContain('human');
    expect(at(e2, 'cultureGroup', made, need)).toEqual({ used: false, text: AFTER_REGEN, fix: { t: 'regen', label: '重新生成' } });
    expect(at(e2, 'culture', inside, need)).toEqual({ used: false, text: AFTER_REGEN, fix: { t: 'regen', label: '重新生成' } });
  });

  it('文化：所在的文化组没参与生成 · 加进来；参与的组里新建的要重新生成才出现', () => {
    const e = full.clone();
    const h = e.world.small.human!;
    const peopled = items(e, 'culture')
      .filter((c) => h.groups.includes(String(c.group)))
      .map((c) => at(e, 'culture', String(c.id)))
      .find((m) => m.used)!;
    expect(peopled.text).toMatch(/^[\d,]+ 格有这种文化的人/);
    // 没参与的组里的文化
    const g = add(e, 'cultureGroup', { name: '海外' });
    const c = add(e, 'culture', { group: g.id });
    const off = at(e, 'culture', String(c.id));
    expect(off).toMatchObject({ used: false, text: '所在的文化组“海外”没参与生成', fix: { t: 'command', label: '加进来' } });
    fix(e, off);
    expect(e.world.small.human!.groups).toContain(g.id);
    expect(at(e, 'culture', String(c.id)).text).not.toMatch(/没参与生成/);
    // 参与的组里新建一个：重新生成后才出现（按钮就是底下的重新生成）
    const e2 = full.clone();
    let made = '';
    const need = needAfter(e2, () => (made = String(add(e2, 'culture', { group: h.groups[0] }).id)));
    expect(need?.scopes).toContain('human');
    expect(at(e2, 'culture', made, need)).toEqual({ used: false, text: AFTER_REGEN, fix: { t: 'regen', label: '重新生成' } });
    // 没有待用上的改动（比如生成时就在、只是没分到地方）
    expect(at(e2, 'culture', made, null)).toEqual({ used: false, text: '这次生成没分到地方' });
  });

  it('取值：有这样的人的格；时代没有这个变量 · 去加', () => {
    const e = full.clone();
    const m = items(e, 'popValue')
      .map((v) => at(e, 'popValue', String(v.id)))
      .find((x) => x.used)!;
    expect(m.text).toMatch(/^[\d,]+ 格有这样的人$/);
    const v = add(e, 'popValue', { dimension: 'no-such-dim' });
    expect(at(e, 'popValue', String(v.id))).toEqual({
      used: false,
      text: '这张地图的时代没有“no-such-dim”这个变量',
      fix: { t: 'route', label: '去加', route: { p: 'item', kind: 'era', id: e.world.small.human!.era, seg: 'dims' } },
    });
  });

  it('政体：几个国家；还没有国家 · 生成国家；新建的要重新生成；多少是 0、限谁用', () => {
    const e = full.clone();
    const gov = Object.values(e.world.small.countries!)[0].government;
    const n = Object.values(e.world.small.countries!).filter((c) => c.government === gov).length;
    expect(at(e, 'government', gov)).toMatchObject({ used: true, text: `${n} 个国家` });
    // 只有人文、没有国家
    const none = worldOf({});
    const g0 = String(items(none, 'government')[0].id);
    const no = at(none, 'government', g0);
    expect(no).toMatchObject({ used: false, text: NO_COUNTRIES_YET, fix: { t: 'command', label: '生成国家' } });
    fix(none, no);
    expect(Object.keys(none.world.small.countries ?? {}).length).toBeGreaterThan(0);
    expect(items(none, 'government').some((g) => at(none, 'government', String(g.id)).used)).toBe(true);
    // 新建的
    let made = '';
    const need = needAfter(e, () => (made = String(add(e, 'government').id)));
    expect(need?.scopes).toContain('countries');
    expect(at(e, 'government', made, need)).toEqual({ used: false, text: AFTER_REGEN, fix: { t: 'regen', label: '重新生成' } });
    expect(at(e, 'government', made).text).toBe('这次生成没有国家选它');
    put(e, 'government', { ...item(e, 'government', made), weight: 0 });
    expect(at(e, 'government', made)).toEqual({ used: false, text: '多少是 0，没有国家选它', fix: { t: 'segment', label: '去改', seg: 'basic' } });
    put(e, 'government', { ...item(e, 'government', made), weight: 1, only: [{ cultures: ['nobody'] }] });
    expect(at(e, 'government', made)).toEqual({ used: false, text: '没有国家满足“限谁用”', fix: { t: 'segment', label: '看条件', seg: 'only' } });
  });

  it('派系：几个国家有它；没有政体列着它 · 去政体里加', () => {
    const e = full.clone();
    const used = items(e, 'faction')
      .map((f) => at(e, 'faction', String(f.id)))
      .find((m) => m.used)!;
    expect(used.text).toMatch(/^\d+ 个国家有它$/);
    const f = add(e, 'faction');
    expect(at(e, 'faction', String(f.id))).toEqual({ used: false, text: '没有政体列着它', fix: { t: 'route', label: '去政体里加', route: { p: 'list', kind: 'government' } } });
  });

  it('国家等级：几个国家；时代里比例是 0 · 去调；国家格局：时代没列 · 加进时代', () => {
    const e = full.clone();
    const tiers = items(e, 'countryTier').map((t) => ({ id: String(t.id), m: at(e, 'countryTier', String(t.id)) }));
    expect(tiers.filter((t) => t.m.used).every((t) => /^\d+ 个国家$/.test(t.m.text))).toBe(true);
    expect(tiers.some((t) => t.m.used)).toBe(true);
    const made = add(e, 'countryTier');
    expect(at(e, 'countryTier', String(made.id))).toEqual({ used: false, text: '时代里这一级的比例是 0', fix: { t: 'route', label: '去调', route: { p: 'gen' } } });
    // 国家格局
    const eraId = e.world.small.human!.era;
    const listed = (item(e, 'era', eraId).patterns as { pattern: string }[] | undefined) ?? [];
    if (listed.length) expect(at(e, 'countryPattern', listed[0].pattern)).toEqual({ used: true, text: '这张地图的时代列着它' });
    const p = add(e, 'countryPattern');
    const off = at(e, 'countryPattern', String(p.id));
    expect(off).toMatchObject({ used: false, text: '时代没列这种格局', fix: { t: 'command', label: '加进时代' } });
    fix(e, off);
    expect((item(e, 'era', eraId).patterns as { pattern: string }[]).some((x) => x.pattern === p.id)).toBe(true);
    expect(at(e, 'countryPattern', String(p.id)).used).toBe(true);
  });

  it('城市等级：几座城市（按现算的等级）；还没有城市 · 生成城市；够不上的写原因', () => {
    const e = full.clone();
    const ranks = items(e, 'cityRank').map((r) => at(e, 'cityRank', String(r.id)));
    const total = ranks.filter((m) => m.used).reduce((n, m) => n + Number(/^([\d,]+) 座城市$/.exec(m.text)![1].replace(/,/g, '')), 0);
    expect(total).toBe(Object.keys(e.world.small.cities!).length);
    const hard = add(e, 'cityRank', { minShare: 1, level: 9 });
    expect(at(e, 'cityRank', String(hard.id))).toEqual({ used: false, text: '没有城市够得上这一级', fix: { t: 'segment', label: '看条件', seg: 'rule' } });
    // 有国家、没有城市
    const none = worldOf({ countries: {} });
    const r0 = String(items(none, 'cityRank')[0].id);
    const no = at(none, 'cityRank', r0);
    expect(no).toMatchObject({ used: false, text: NO_CITIES_YET, fix: { t: 'command', label: '生成城市' } });
    fix(none, no);
    expect(Object.keys(none.world.small.cities ?? {}).length).toBeGreaterThan(0);
    // 只有人文：先要国家
    expect(at(worldOf({}), 'cityRank', r0).text).toBe(NO_COUNTRIES_YET);
  });

  it('地标、点：几个；不自动放、没放地标、要重新生成、还没放', () => {
    const e = full.clone();
    const marks = items(e, 'landmarkType').map((t) => at(e, 'landmarkType', String(t.id)));
    expect(marks.some((m) => m.used && /^\d+ 个地标$/.test(m.text))).toBe(true);
    const manual = add(e, 'landmarkType', { manual: true });
    expect(at(e, 'landmarkType', String(manual.id))).toEqual({ used: false, text: '不自动放，用地标工具放' });
    let made = '';
    const need = needAfter(e, () => (made = String(add(e, 'landmarkType').id)));
    expect(need?.scopes).toEqual(['settlements']);
    expect(at(e, 'landmarkType', made, need)).toEqual({ used: false, text: AFTER_REGEN, fix: { t: 'regen', label: '重新生成' } });
    // 限定的文化组没有国家
    put(e, 'landmarkType', { ...item(e, 'landmarkType', made), cultureGroups: ['nobody-here'] });
    expect(at(e, 'landmarkType', made)).toEqual({ used: false, text: '没有国家是限定的文化组', fix: { t: 'segment', label: '看条件', seg: 'who' } });
    // 生成城市时没放地标
    const none = worldOf({ countries: {}, settlements: { landmarks: false } });
    const t0 = items(none, 'landmarkType').find((t) => !t.manual)!;
    const no = at(none, 'landmarkType', String(t0.id));
    expect(no).toMatchObject({ used: false, text: '生成城市时没放地标', fix: { t: 'command', label: '放地标' } });
    fix(none, no);
    expect(Object.keys(none.world.small.landmarks ?? {}).length).toBeGreaterThan(0);
    // 点是自己放的
    const pt = items(e, 'pointType')[0];
    expect(at(e, 'pointType', String(pt.id))).toEqual({ used: false, text: '还没放这种点' });
  });

  it('没有世界、自定义场：没有这一行', () => {
    expect(onMapOf(kindOf('biome')!, 'x', {}, { world: null, lib: BUILTIN })).toBeNull();
    expect(onMapOf(kindOf('field')!, 'x', 'x', ctxOf(full))).toBeNull();
  });
});
