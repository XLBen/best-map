import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { Engine } from '../../core/engine';
import { continents, seededEngine } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { tool, world } from '../state';
import { ADJUSTMENTS, PLANET_TOGGLES } from './defs/adjustments';
import { OVERLAYS, VIEWS } from './defs/layers';
import { SIGN_TEXT, WORLD_SIGNS, type WorldSign, shownTools, signsOf, splitSimple } from './defs/simple-ui';
import { CATEGORIES, TOOL_DEFS, type ToolId, barTools, keyTools, setTool, toolKey, toolsOf, toolsPlace } from './defs/tools';
import './tools/bind';
import { simpleHome } from './packs/home-simple';
import { showAllSettings, showAllSources } from './packs/lib-prefs';
import { HOME_LAYOUT, HOME_MORE_CARDS } from './packs/page-layout';
import type { Card, HomeSection } from './packs/pages';
import { closeAllRest, fullUi, restOpen, setFullUi, setRestOpen } from './ui-prefs';

// 第九十九轮：简单界面 / 完整界面。
//   - 哪些算常用：整张表钉在这里（和 docs/dev/history/第99轮.md 的表是同一张）；
//   - 怎么露：纯函数 defs/simple-ui.ts（常用的、世界里已经有它的东西的、正在用的、这一处展开着的）；
//   - 数字键按完整的那一排数，不因为藏了几个而换位；
//   - 只有一个偏好、一个键（ui-prefs.ts；资源库的 showAllSources / showAllSettings 就是它）

afterEach(() => {
  setFullUi(false);
  closeAllRest();
  setTool('land');
  world.value = null;
});

// ---------- 整张表 ----------

// 工具：每一类平时露着的（工具表里的先后）；别的写了 more。when：世界里有这样东西时自己露出来
const COMMON_TOOLS: Record<string, ToolId[]> = {
  inspect: ['pointer'],
  terrain: ['land', 'island', 'relief'],
  climate: ['temp', 'moist'],
  nature: ['biome'],
  water: ['river', 'lake'],
  provinces: ['pselect'],
  names: ['rename', 'area', 'spot'],
  culture: ['culture', 'pop'],
  countries: ['cselect', 'territory', 'newCountry'],
  settlements: ['city', 'road', 'landmark'],
};
const MORE_TOOLS: Partial<Record<ToolId, WorldSign | null>> = {
  chain: 'chains',
  fragment: null,
  reroll: null,
  terrainClass: 'classPainted',
  field: 'fields',
  grow: null,
  resource: 'resourcePainted',
  unwater: 'drawnWater',
  pbrush: 'provinces',
  pcut: 'provinces',
  pregen: null,
  hearth: 'hearthMoved',
  cmerge: null,
  point: 'points',
};
// 只从生态编辑器进、从不在那一排上的
const NEVER_LISTED: ToolId[] = ['range'];

const COMMON_VIEWS = ['terrain', 'dominant', 'temperature', 'precip', 'elevation', 'seaTemp'];
const MORE_VIEWS = ['provinces', 'terrainClass', 'resource', 'uplift'];
const COMMON_OVERLAYS = ['labels', 'rivers', 'peaks', 'roads', 'cities', 'landmarks', 'scale', 'edits'];
const MORE_OVERLAYS = ['borders', 'wind', 'currents', 'latitude'];
const COMMON_ADJUST = ['latitude', 'solar', 'humidity', 'riverThreshold'];
const MORE_ADJUST = ['tilt', 'lapse', 'currents', 'terrainWind', 'vegSharpness'];
const MORE_TOGGLES = ['rotation', 'outsideOcean'];
// 资源库首页：平时露着的卡片（生成设置、时代那两张在最上面，总在）
const COMMON_CARDS = ['cultureGroup', 'culture', 'nameStyle', 'dims', 'government', 'landmarkType', 'ecology', 'islandType', 'mapStyle'];
const MORE_CARDS = ['valueGroup', 'variables', 'faction', 'countryTier', 'countryPattern', 'cityRank', 'pointType', 'planetForm', 'terrainClass', 'resource', 'provinceRules'];

describe('哪些算常用（整张表）', () => {
  it('工具：每一类平时露着的就是表里这几个，别的都写了 more；when 和表一样', () => {
    const ids = Object.keys(TOOL_DEFS) as ToolId[];
    const common = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.tools.filter((id) => !TOOL_DEFS[id].more && !NEVER_LISTED.includes(id))]));
    expect(common).toEqual(COMMON_TOOLS);
    expect(ids.filter((id) => TOOL_DEFS[id].more).sort()).toEqual(Object.keys(MORE_TOOLS).sort());
    for (const id of ids) expect(TOOL_DEFS[id].when ?? null, id).toBe(MORE_TOOLS[id] ?? null);
    // 每一类的第一个工具是常用的（点一类先换到它）；常用的不超过三个
    for (const c of CATEGORIES) {
      expect(TOOL_DEFS[c.tools[0]].more, c.id).toBeUndefined();
      expect(COMMON_TOOLS[c.id].length, c.id).toBeLessThanOrEqual(3);
    }
    // 从不在那一排上的：世界里总是用不上
    for (const id of NEVER_LISTED) expect(TOOL_DEFS[id].hidden?.({} as World)).toBe(true);
  });

  it('底图、图层里的开关、“调整”里的项', () => {
    expect(VIEWS.filter((v) => !v.more).map((v) => v.id)).toEqual(COMMON_VIEWS);
    expect(VIEWS.filter((v) => v.more).map((v) => v.id)).toEqual(MORE_VIEWS);
    expect(OVERLAYS.filter((o) => !o.more).map((o) => o.key)).toEqual(COMMON_OVERLAYS);
    expect(OVERLAYS.filter((o) => o.more).map((o) => o.key)).toEqual(MORE_OVERLAYS);
    expect(ADJUSTMENTS.filter((a) => !a.more).map((a) => a.id)).toEqual(COMMON_ADJUST);
    expect(ADJUSTMENTS.filter((a) => a.more).map((a) => a.id)).toEqual(MORE_ADJUST);
    expect(PLANET_TOGGLES.filter((t) => t.more).map((t) => t.key)).toEqual(MORE_TOGGLES);
    // 不常用的“调整”都说得出“这个世界里改过没有”
    for (const a of ADJUSTMENTS.filter((x) => x.more)) expect(a.touched, a.id).toBeTypeOf('function');
  });

  it('资源库首页的卡片', () => {
    const all = HOME_LAYOUT.flatMap((s) => s.cards);
    expect(all.filter((c) => !HOME_MORE_CARDS.includes(c))).toEqual(COMMON_CARDS);
    expect([...HOME_MORE_CARDS].sort()).toEqual([...MORE_CARDS].sort());
    for (const c of HOME_MORE_CARDS) expect(all, c).toContain(c);
  });

  it('世界里的每一种记号都有一句人话', () => {
    expect(Object.keys(SIGN_TEXT).sort()).toEqual(Object.keys(WORLD_SIGNS).sort());
    for (const t of Object.values(SIGN_TEXT)) expect(t.length).toBeLessThanOrEqual(10);
  });
});

// ---------- 怎么露 ----------

const SIMPLE = { full: false, open: false };
const none = () => false;
const mark = (id: ToolId) => TOOL_DEFS[id];
const terrain = () => CATEGORIES.find((c) => c.id === 'terrain')!.tools;

describe('简单界面里露哪些（纯函数）', () => {
  it('只露常用的，先后不变；藏着的数得出来', () => {
    const s = shownTools(terrain(), mark, SIMPLE, none, null);
    expect(s.shown).toEqual(['land', 'island', 'relief']);
    expect(s.hidden).toEqual(['chain', 'fragment', 'reroll', 'terrainClass']);
    expect(s.foldable).toBe(0);
  });

  it('正拿着的工具不常用也照常露着，在它原来的位置', () => {
    const s = shownTools(terrain(), mark, SIMPLE, none, 'fragment');
    expect(s.shown).toEqual(['land', 'island', 'relief', 'fragment']);
    expect(s.hidden).toEqual(['chain', 'reroll', 'terrainClass']);
  });

  it('这一处展开着：都露着，能收回几个数得出来；完整界面：都露着，没有可收的', () => {
    const open = shownTools(terrain(), mark, { full: false, open: true }, none, 'fragment');
    expect(open.shown).toEqual(terrain());
    expect(open.hidden).toEqual([]);
    expect(open.foldable).toBe(3);
    const full = shownTools(terrain(), mark, { full: true, open: false }, none, null);
    expect(full).toEqual({ shown: terrain(), hidden: [], foldable: 0 });
  });

  it('世界里已经有它的东西：自己露出来', () => {
    const has = (sign: WorldSign) => sign === 'chains';
    expect(shownTools(terrain(), mark, SIMPLE, has, null).shown).toEqual(['land', 'island', 'chain', 'relief']);
    const prov = CATEGORIES.find((c) => c.id === 'provinces')!.tools;
    expect(shownTools(prov, mark, SIMPLE, none, null).shown).toEqual(['pselect']);
    expect(shownTools(prov, mark, SIMPLE, (s) => s === 'provinces', null).shown).toEqual(['pselect', 'pbrush', 'pcut']);
  });

  it('splitSimple：常用的总在；kept 的照常露着；都常用时没有“还有”', () => {
    const items = ['a', 'b', 'c', 'd'];
    const more = (x: string) => x === 'b' || x === 'd';
    expect(splitSimple(items, SIMPLE, more)).toEqual({ shown: ['a', 'c'], hidden: ['b', 'd'], foldable: 0 });
    expect(splitSimple(items, SIMPLE, more, (x) => x === 'd')).toEqual({ shown: ['a', 'c', 'd'], hidden: ['b'], foldable: 0 });
    expect(splitSimple(items, { full: false, open: true }, more, (x) => x === 'd')).toEqual({ shown: items, hidden: [], foldable: 1 });
    expect(splitSimple(items, SIMPLE, () => false)).toEqual({ shown: items, hidden: [], foldable: 0 });
  });
});

describe('世界里已经有什么', () => {
  const plain = () => continents().world;
  // 还没生成地形的空白世界（应用里新建总是先生成地形，看不到它；打开一份没有命令的世界文件时是它）
  const blankWorld = () => new Engine({ cells: 2000, seed: 1 }).world;

  it('没有世界：什么都没有', () => {
    const has = signsOf(null);
    for (const k of Object.keys(WORLD_SIGNS) as WorldSign[]) expect(has(k)).toBe(false);
  });

  it('刚生成、没动过的世界：只有省份（生成地形时自动划分过），别的都没有；还没生成地形的空白世界连省份也没有', () => {
    const has = signsOf(plain(), () => []);
    for (const k of Object.keys(WORLD_SIGNS) as WorldSign[]) expect(has(k), k).toBe(k === 'provinces');
    const blank = signsOf(blankWorld(), () => []);
    for (const k of Object.keys(WORLD_SIGNS) as WorldSign[]) expect(blank(k), k).toBe(false);
  });

  it('划分了省份、加了场、放了湖：对应的记号有了', () => {
    const eng = seededEngine({ cells: 2000, seed: 1 });
    expect(signsOf(eng.world)('provinces')).toBe(false);
    eng.exec({ op: 'generate_provinces', seed: 1 });
    expect(signsOf(eng.world)('provinces')).toBe(true);
    const e2 = continents();
    e2.exec({ op: 'add_field', name: 'magic' });
    expect(signsOf(e2.world)('fields')).toBe(true);
    expect(signsOf(e2.world)('drawnWater')).toBe(false);
    const land = Array.from(e2.world.causes.land).findIndex((v) => v === 1);
    const w = { ...e2.world, small: { ...e2.world.small, lakes: [{ id: 'l1', cell: land } as never] } } as World;
    expect(signsOf(w)('drawnWater')).toBe(true);
  });

  it('岛链只在命令记录里：命令里有（batch 里的也算）才算', () => {
    const w = plain();
    const chain = { op: 'add_island_chain', chain: {} } as unknown as Command;
    expect(signsOf(w, () => [{ op: 'batch', commands: [chain] } as Command])('chains')).toBe(true);
    const w2 = { ...w } as World;
    expect(signsOf(w2, () => [{ op: 'add_field', name: 'x' } as Command])('chains')).toBe(false);
  });

  it('同一个世界对象问过的记着；拿不到命令记录时不记，下次再问', () => {
    const w = { ...plain() } as World;
    const chain = { op: 'add_island_chain', chain: {} } as unknown as Command;
    let asked = 0;
    expect(
      signsOf(w, () => {
        asked++;
        return null;
      })('chains'),
    ).toBe(false);
    expect(
      signsOf(w, () => {
        asked++;
        return [chain];
      })('chains'),
    ).toBe(true);
    expect(
      signsOf(w, () => {
        asked++;
        return [];
      })('chains'),
    ).toBe(true);
    expect(asked).toBe(2);
  });

  it('手画过的地形类别、资源：数组里有不是 0 的', () => {
    const w0 = plain();
    const n = w0.mesh.n;
    const painted = new Uint8Array(n);
    painted[5] = 2;
    const w = { ...w0, causes: { ...w0.causes, terrainClass: new Uint8Array(n), resource: painted } } as World;
    const has = signsOf(w);
    expect(has('classPainted')).toBe(false);
    expect(has('resourcePainted')).toBe(true);
  });
});

// ---------- 接在工具表上 ----------

describe('底部条上的那一排', () => {
  it('没有省份的空白世界：省份只露“选省份”；划分了省份：画笔、剪刀自己露出来（生成过地形的世界都划分过）', () => {
    const eng = seededEngine({ cells: 2000, seed: 1 });
    world.value = eng.world;
    expect(barTools('provinces', world.value).shown).toEqual(['pselect']);
    expect(barTools('provinces', world.value).hidden).toEqual(['pbrush', 'pcut', 'pregen']);
    eng.exec({ op: 'generate_provinces', seed: 1 });
    world.value = eng.world;
    expect(barTools('provinces', world.value).shown).toEqual(['pselect', 'pbrush', 'pcut']);
    expect(barTools('provinces', world.value).hidden).toEqual(['pregen']);
    world.value = continents().world;
    expect(barTools('provinces', world.value).shown).toEqual(['pselect', 'pbrush', 'pcut']);
  });

  it('点“还有 N 个”只展开这一类；完整界面全都露着，和 toolsOf 一样', () => {
    const w = (world.value = continents().world);
    setRestOpen(toolsPlace('terrain'), true);
    expect(barTools('terrain', w).shown).toEqual(toolsOf('terrain', w));
    expect(barTools('terrain', w).foldable).toBe(4);
    expect(barTools('nature', w).shown).toEqual(['biome']);
    setRestOpen(toolsPlace('terrain'), false);
    expect(barTools('terrain', w).shown).toEqual(['land', 'island', 'relief']);
    setFullUi(true);
    for (const c of CATEGORIES) {
      expect(barTools(c.id, w).shown, c.id).toEqual(toolsOf(c.id, w));
      expect(barTools(c.id, w).hidden, c.id).toEqual([]);
    }
  });

  it('从完整切回简单时正拿着不常用的工具：它还在那一排上', () => {
    const w = (world.value = continents().world);
    setFullUi(true);
    setTool('reroll');
    setFullUi(false);
    expect(barTools('terrain', w).shown).toEqual(['land', 'island', 'relief', 'reroll']);
    setTool('land');
    expect(barTools('terrain', w).shown).toEqual(['land', 'island', 'relief']);
  });

  it('数字键：按完整的那一排数，简单界面、完整界面、正拿着哪个都一样', () => {
    const w = (world.value = continents().world);
    const before = Object.fromEntries(CATEGORIES.map((c) => [c.id, keyTools(c.id, w)]));
    expect(before.terrain).toEqual(['land', 'island', 'chain', 'relief', 'fragment', 'reroll', 'terrainClass']);
    // 世界里用不上的不占键：没有自定义场时的“涂自定义场”、“选生态的范围”
    expect(before.climate).toEqual(['temp', 'moist']);
    expect(before.nature).toEqual(['biome', 'grow', 'resource']);
    setFullUi(true);
    expect(Object.fromEntries(CATEGORIES.map((c) => [c.id, keyTools(c.id, w)]))).toEqual(before);
    setFullUi(false);
    // 正拿着“选生态的范围”（它不占键）：资源还是 3
    tool.value = 'range';
    expect(keyTools('nature', w)).toEqual(before.nature);
    expect(toolKey('resource', w)).toBe(3);
    expect(toolKey('range', w)).toBe(0);
    tool.value = 'land';
    // 简单界面里露着的三个工具，键是 1、2、4（中间的 3 是藏着的岛链）
    expect(barTools('terrain', w).shown.map((id) => toolKey(id, w))).toEqual([1, 2, 4]);
  });
});

// ---------- 图层、调整、资源库首页 ----------

describe('面板里露哪些', () => {
  it('底图：简单界面露六种，正看着的不常用的那一种照常露着', () => {
    const more = (v: (typeof VIEWS)[number]) => !!v.more;
    expect(splitSimple(VIEWS, SIMPLE, more).shown.map((v) => v.id)).toEqual(COMMON_VIEWS);
    expect(splitSimple(VIEWS, SIMPLE, more, (v) => v.id === 'resource').shown.map((v) => v.id)).toEqual(['terrain', 'dominant', 'resource', 'temperature', 'precip', 'elevation', 'seaTemp']);
  });

  it('“调整”：默认的世界露四项；改过的不常用的那一项照常露着', () => {
    const eng = continents();
    const rows = (w: World) => splitSimple(ADJUSTMENTS.filter((a) => !a.hidden?.(w)), SIMPLE, (a) => !!a.more, (a) => !!a.touched?.(w));
    const base = rows(eng.world);
    // continents 这个世界模板关了洋流（NO_CURRENTS）：洋流强弱不在默认值上，照常露着
    expect(base.shown.map((a) => a.id)).toEqual(['latitude', 'solar', 'humidity', 'riverThreshold', ...(eng.world.small.planet.currents === 1 ? [] : ['currents'])]);
    eng.exec({ op: 'set_planet', patch: { tilt: 40 } });
    expect(rows(eng.world).shown.map((a) => a.id)).toContain('tilt');
    expect(rows(eng.world).hidden.map((a) => a.id)).not.toContain('tilt');
    expect(PLANET_TOGGLES.find((t) => t.key === 'rotation')!.touched(eng.world)).toBe(false);
  });

  it('资源库首页：不常用的卡片藏着，一段都藏着时这一段不画；勾了东西的那一类照常露着', () => {
    const card = (id: string): Card => ({ id, title: id, count: '1', empty: false, route: { p: 'list', kind: id } });
    const sections: HomeSection[] = [
      { id: 'human', title: '人文', cards: [card('cultureGroup'), card('dim:religion'), card('valueGroup')] },
      { id: 'politics', title: '政治', cards: [card('government'), card('faction')] },
      { id: 'x', title: '只有不常用的', cards: [card('resource'), card('planetForm')] },
    ];
    const s = simpleHome(sections, SIMPLE);
    expect(s.sections.map((x) => [x.id, x.cards.map((c) => c.id)])).toEqual([
      ['human', ['cultureGroup', 'dim:religion']],
      ['politics', ['government']],
    ]);
    expect(s.hidden.map((c) => c.id)).toEqual(['valueGroup', 'faction', 'resource', 'planetForm']);
    expect(simpleHome(sections, SIMPLE, (c) => c.id === 'resource').sections.map((x) => x.id)).toEqual(['human', 'politics', 'x']);
    const open = simpleHome(sections, { full: false, open: true });
    expect(open.sections).toEqual(sections);
    expect(open.foldable).toBe(4);
    expect(simpleHome(sections, { full: true, open: false })).toEqual({ sections, hidden: [], foldable: 0 });
  });
});

// ---------- 一个偏好 ----------

describe('完整界面：只有一个偏好、一个键', () => {
  it('默认是简单界面；打开它，资源库的两问跟着是 true（同一个信号）', () => {
    expect([fullUi(), showAllSources(), showAllSettings()]).toEqual([false, false, false]);
    setFullUi(true);
    expect([fullUi(), showAllSources(), showAllSettings()]).toEqual([true, true, true]);
    setFullUi(false);
    expect([fullUi(), showAllSources(), showAllSettings()]).toEqual([false, false, false]);
  });

  it('记在 map2.lib.allSources 这一个键上；第九十二轮起打开过它的浏览器，一打开就是完整界面', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    try {
      setFullUi(true);
      expect([...store]).toEqual([['map2.lib.allSources', '1']]);
      setFullUi(false);
      expect([...store]).toEqual([]);
      // 以前存下的 '1'：重新载入这个模块（像刷新页面）读出来就是完整界面
      store.set('map2.lib.allSources', '1');
      vi.resetModules();
      const again = await import('./ui-prefs');
      expect(again.fullUi()).toBe(true);
      const lib = await import('./packs/lib-prefs');
      expect([lib.showAllSources(), lib.showAllSettings()]).toEqual([true, true]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('“还有 N 个”展开过哪几处只记到关页面为止，不写进存储', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    try {
      setRestOpen('views', true);
      expect(restOpen('views')).toBe(true);
      expect(restOpen('adjust')).toBe(false);
      expect(store.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
