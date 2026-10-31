import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Engine } from '../../core/engine';
import { cityList, worldCultures } from '../../core/human';
import { continents, snapshot, humanExec, type HumanCommand } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { QUIET_ROAD_WIDTH, ROAD_WIDTH, roadStyle } from '../render/settle-draw';
import { exec, hereOpen, mode, nameMode, parsePrefs, pinnedCell, prefs, selectedCountry, selectedSettle, setPrefs, sheet, tool, world } from '../state';
import { countryAt } from './countries';
import { humanViews } from './defs/layers';
import { CATEGORY_DEFS, TOOL_DEFS, category, setTool } from './defs/tools';
import { highlightLayers } from './map/highlights';
import { kindOfView, mapKind, mapModes, modeDef, modeFeatures, modeOf, setMapKind } from './map/modes';
import { REGION_KEY, countryDraws, regionDraws } from './map/political';
import { settleOverlay, shownMarks } from './map/settle';
import { showView } from './panels/LayersPanel';
import { CAPITAL_NAME_PX, MINOR_ROAD_EDIT_PX, MINOR_ROAD_PX, markKey, roadSet, settleHoverText, settleMarks, settleShow } from './settlements';
import { onKeyDown } from './shell/keys';
import { type Pointer, pointerText, pointerTool } from './tools';

// 第二十五轮的界面：地图模式（表、偏好、按钮、与底图同步）、片区名、城市名只写首都、指针、道路减淡

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true) }));

afterEach(() => {
  setTool('land');
  mode.value = 'terrain';
  selectedCountry.value = null;
  selectedSettle.value = null;
  sheet.value = null;
  pinnedCell.value = -1;
  hereOpen.value = false;
  nameMode.value = 'zh';
  setPrefs({ map: 'geo' });
  vi.mocked(exec).mockClear();
});

const GEN: HumanCommand = {
  op: 'generate_human',
  era: 'medieval',
  groups: [
    { id: 'western', weight: 3 },
    { id: 'eastern', weight: 3 },
    { id: 'steppe', weight: 1.5 },
  ],
  countries: { fragmentation: 1 },
  settlements: {},
};
const towns = (): Engine =>
  snapshot('r25:towns', () => {
    const eng = continents();
    humanExec(eng, GEN);
    return eng;
  });
// 有人文、没有国家
const peoples = (): Engine =>
  snapshot('r25:peoples', () => {
    const eng = continents();
    humanExec(eng, { op: 'generate_human', era: 'medieval', groups: GEN.op === 'generate_human' ? GEN.groups : [] });
    return eng;
  });

const zoomOf = (w: World) => () => 20 / w.mesh.spacing;
const pointer = (w: World, c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift: false, alt: false });
const key = (k: string) => onKeyDown({ key: k, code: `Key${k.toUpperCase()}`, target: null, repeat: false, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: () => {} } as unknown as KeyboardEvent);

// 离城市、地标都远的干陆地格（findOwner：要不要有国家）
function emptyLand(w: World, owned: boolean): number {
  const taken = [...Object.values(w.small.cities ?? {}).map((c) => c.cell), ...Object.values(w.small.landmarks ?? {}).map((l) => l.cell)];
  const far = (i: number) => taken.every((t) => Math.hypot(w.mesh.x[i] - w.mesh.x[t], w.mesh.y[i] - w.mesh.y[t]) > w.mesh.spacing * 4);
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && w.derived.lake[i] !== 1 && far(i) && (countryAt(w, i) !== null) === owned) return i;
  throw new Error('没有空地');
}

describe('地图模式的表', () => {
  it('每种模式画什么：地理、国家、文化（文化组、每一维同样）、人口', () => {
    expect(modeDef('geo')).toEqual({ provinces: 0, countryBorders: 'none', cities: 'geo', cityNames: 'capitals', landmarks: 'natural', features: 'all', regions: null });
    expect(modeDef('country')).toMatchObject({ countryBorders: 'full', cities: 'all', cityNames: 'capitals', landmarks: 'all', features: 'political', regions: 'country' });
    for (const k of ['culture', 'cultureGroup', 'dim:religion'] as const) {
      expect(modeDef(k)).toEqual({ provinces: modeDef(k).provinces, countryBorders: 'faint', cities: 'capitals', cityNames: 'none', landmarks: 'none', features: 'ocean', regions: k });
      expect(modeDef(k).provinces).toBeLessThan(modeDef('country').provinces);
    }
    expect(modeDef('popDensity')).toMatchObject({ countryBorders: 'faint', cities: 'capitals', cityNames: 'none', regions: null });
  });

  it('模式就是人文的底图：底图各对应一种，别的底图是地理', () => {
    for (const v of ['country', 'culture', 'cultureGroup', 'popDensity', 'dim:religion'] as const) expect(kindOfView(v)).toBe(v);
    for (const v of ['terrain', 'elevation', 'habitability', 'provinces', 'terrainClass'] as const) expect(kindOfView(v)).toBe('geo');
    mode.value = 'culture';
    expect(mapKind.value).toBe('culture');
    mode.value = 'temperature';
    expect(mapKind.value).toBe('geo');
  });

  it('按钮：没有人文时没有；没有国家时没有“国家”；有时代的每一维', () => {
    expect(mapModes(continents().world)).toEqual([]);
    expect(mapModes(peoples().world).map((m) => m.id)).toEqual(['geo', 'culture', 'cultureGroup', 'dim:religion', 'popDensity']);
    const b = mapModes(towns().world);
    // 第二十六轮：这个世界里有帝国（中世纪的邦联），多一个“同盟”
    expect(b.map((m) => m.label)).toEqual(['地理', '国家', '同盟', '文化', '文化组', '宗教', '人口']);
    for (const m of b) expect(m.title.length).toBeGreaterThan(0);
    // 世界里没有那一层时是地理
    expect(modeOf(peoples().world, 'country')).toBe('geo');
    expect(modeOf(continents().world, 'culture')).toBe('geo');
    expect(modeOf(towns().world, 'dim:nation')).toBe('geo');
    expect(modeOf(towns().world, 'dim:religion')).toBe('dim:religion');
  });

  it('偏好：旧的 political 读作国家；维度的模式、不认识的', () => {
    expect(parsePrefs(JSON.stringify({ map: 'political' })).map).toBe('country');
    expect(parsePrefs(JSON.stringify({ map: 'dim:religion' })).map).toBe('dim:religion');
    expect(parsePrefs(JSON.stringify({ map: 'culture' })).map).toBe('culture');
    expect(parsePrefs(JSON.stringify({ map: 'dim:' })).map).toBe('geo');
    expect(parsePrefs(JSON.stringify({ map: 3 })).map).toBe('geo');
  });

  it('换模式换底图、存进偏好；图层里选人文的底图也换模式；地理把人文的底图换回地貌', () => {
    world.value = towns().world;
    setMapKind('dim:religion');
    expect(mode.value).toBe('dim:religion');
    expect(prefs.value.map).toBe('dim:religion');
    showView('cultureGroup');
    expect(mapKind.value).toBe('cultureGroup');
    expect(prefs.value.map).toBe('cultureGroup');
    showView('elevation');
    expect(mapKind.value).toBe('geo');
    setMapKind('popDensity');
    setMapKind('geo');
    expect(mode.value).toBe('terrain');
    // 人文的底图都有对应的按钮（宜居度除外）
    const ids = new Set(mapModes(towns().world).map((m) => m.id));
    for (const v of humanViews(towns().world)) if (v.id !== 'habitability') expect(ids.has(kindOfView(v.id))).toBe(true);
  });

  it('工具换上它那一层就是换模式，离开时换回原来的模式', () => {
    world.value = towns().world;
    setMapKind('culture');
    setTool('cselect');
    expect(mapKind.value).toBe('country');
    setTool('land');
    expect(mapKind.value).toBe('culture');
    setTool('terrainClass');
    expect(mapKind.value).toBe('geo');
    setTool('land');
    expect(mapKind.value).toBe('culture');
  });

  it('自然的地名：国家模式留海、湖、山脉；文化等模式只留大洋、海（自己的照旧）', () => {
    const w = towns().world;
    const ocean = modeFeatures(w.derived.features, 'ocean');
    expect(ocean.every((f) => ['ocean', 'sea', 'region', 'spot'].includes(f.type) || f.custom)).toBe(true);
    expect(ocean.length).toBeLessThan(modeFeatures(w.derived.features, 'political').length);
    expect(modeFeatures(w.derived.features, 'ocean')).toBe(ocean);
    expect(modeFeatures(w.derived.features, 'all')).toBe(w.derived.features);
  });
});

describe('片区名', () => {
  it('国家模式是国名；文化、文化组、宗教是这一种的名字，键按模式分开；同样的输入同一个数组', () => {
    const w = towns().world;
    expect(regionDraws(w, 'country', 'zh')).toBe(countryDraws(w, 'zh'));
    for (const src of ['culture', 'cultureGroup', 'dim:religion'] as const) {
      const d = regionDraws(w, src, 'zh');
      expect(d.length).toBeGreaterThan(0);
      for (const x of d) {
        expect(x.key.startsWith(`${REGION_KEY}${src}:`)).toBe(true);
        expect(x.path).toHaveLength(5);
        expect(x.area).toBeGreaterThan(0);
      }
      expect(regionDraws(w, src, 'zh')).toBe(d);
    }
    // 文化名是世界里的文化
    const names = new Set(worldCultures(w.small).map((c) => c.name));
    for (const d of regionDraws(w, 'culture', 'zh')) expect(names.has(d.lines[0])).toBe(true);
  });

  it('有原文时随中文 / 原文 / 两者变', () => {
    const w = towns().world;
    const first = regionDraws(w, 'culture', 'zh')[0];
    const id = first.key.slice(`${REGION_KEY}culture:`.length).replace(/:2$/, '');
    const content = structuredClone(w.small.content!);
    (content.culture as Record<string, { orig?: string }>)[id].orig = 'Valmont';
    const w2 = { ...w, small: { ...w.small, content } } as World;
    const line = (nm: 'zh' | 'orig' | 'both') => regionDraws(w2, 'culture', nm).find((d) => d.key === first.key)!.lines;
    expect(line('zh')).toEqual(first.lines);
    expect(line('orig')).toEqual(['Valmont']);
    expect(line('both')).toEqual([first.lines[0], 'Valmont']);
  });
});

describe('城市的名字', () => {
  it('不是首都的城市不写名字（大城市也一样）；首都、陪都写；文化等模式里首都也不写；“城市”工具选中的写', () => {
    const w = towns().world;
    const ov = { countries: true, cities: true, landmarks: true };
    const country = settleMarks(w, 'zh', settleShow({ mode: modeDef('country'), editing: false, ...ov }));
    const cities = cityList(w);
    const capital = (k: string) => cities.find((c) => markKey(c.point ? 'point' : 'city', c.id) === k)!;
    const cityMarks = country.filter((m) => m.kind === 'city');
    expect(cityMarks.length).toBe(cities.length);
    for (const m of cityMarks) {
      const c = capital(m.key);
      expect(m.namePx).toBe(c.capital || c.secondCapital ? CAPITAL_NAME_PX : Infinity);
    }
    expect(cityMarks.some((m) => m.namePx === Infinity)).toBe(true);
    // 文化模式：只有首都的图标，没有名字，没有地标
    const culture = settleMarks(w, 'zh', settleShow({ mode: modeDef('culture'), editing: false, ...ov }));
    expect(culture.filter((m) => m.kind === 'city').every((m) => capital(m.key).capital || capital(m.key).secondCapital || capital(m.key).point)).toBe(true);
    expect(culture.filter((m) => m.kind === 'city' && !capital(m.key).point).every((m) => m.namePx === Infinity)).toBe(true);
    expect(culture.some((m) => m.kind === 'landmark')).toBe(false);
    // 选中的写名字
    const small = cities.find((c) => !c.capital && !c.secondCapital && !c.point)!;
    const sel = markKey('city', small.id);
    const edit = settleMarks(w, 'zh', settleShow({ mode: modeDef('country'), editing: true, selected: sel, ...ov }));
    expect(edit.find((m) => m.key === sel)!.namePx).toBeLessThan(Infinity);
    // 不在编辑时选中也不写
    expect(settleShow({ mode: modeDef('country'), editing: false, selected: sel, ...ov }).selected).toBeUndefined();
    // 导出与屏幕同一份
    expect(settleOverlay(w, { mode: modeDef('country'), editing: false }).settlements).toBe(country);
  });

  it('鼠标停在城市上：名字、等级、人口', () => {
    const w = towns().world;
    const c = cityList(w).find((x) => x.capital && !x.point)!;
    expect(settleHoverText(w, { kind: 'city', id: c.id })).toMatch(new RegExp(`^${c.name} · 首都 · ${c.rank.name} · .+ 人$`));
  });
});

describe('指针', () => {
  it('单独一类，顶栏最左边；没有底部条的选项、没有“⋯”；箭头光标；V 选中，Esc 不离开', () => {
    expect(CATEGORY_DEFS.inspect).toMatchObject({ tools: ['pointer'] });
    expect(CATEGORY_DEFS.inspect.extras).toBeUndefined();
    expect(TOOL_DEFS.pointer).toMatchObject({ category: 'inspect', cursor: 'default' });
    expect(TOOL_DEFS.pointer.bar).toBeUndefined();
    world.value = towns().world;
    key('v');
    expect(tool.value).toBe('pointer');
    expect(category.value).toBe('inspect');
    key('Escape');
    expect(tool.value).toBe('pointer');
  });

  it('点城市打开城市档案；点空地钉住这一格；国家模式里点国家打开国家档案并钉住', async () => {
    const w = towns().world;
    world.value = w;
    setMapKind('country');
    const t = pointerTool(zoomOf(w));
    // 城市
    const c = cityList(w).find((x) => x.capital && !x.point)!;
    t.move!(pointer(w, c.cell), false);
    expect(t.preview().hint).toBe(settleHoverText(w, { kind: 'city', id: c.id }));
    await t.click!(pointer(w, c.cell));
    expect(selectedSettle.value).toEqual({ kind: 'city', id: c.id });
    expect(sheet.value).toBe('settle');
    expect(pinnedCell.value).toBe(-1);
    // 国家模式：点国家
    sheet.value = null;
    const own = emptyLand(w, true);
    await t.click!(pointer(w, own));
    expect(selectedCountry.value).toBe(countryAt(w, own));
    expect(sheet.value).toBe('country');
    expect(pinnedCell.value).toBe(own);
    expect(hereOpen.value).toBe(true);
    // 地理模式：只钉住这一格
    selectedCountry.value = null;
    sheet.value = null;
    setMapKind('geo');
    await t.click!(pointer(w, own));
    expect(selectedCountry.value).toBeNull();
    expect(pinnedCell.value).toBe(own);
    // 不发命令
    expect(exec).not.toHaveBeenCalled();
  });

  it('鼠标下的格、钉住的格描出边（同一格沿用同一个图层）；停在城市上不描格', () => {
    const w = towns().world;
    world.value = w;
    setMapKind('country');
    const t = pointerTool(zoomOf(w));
    const own = emptyLand(w, true);
    t.move!(pointer(w, own), false);
    const a = t.preview().layers;
    expect(a).toEqual([{ cells: [own], color: [255, 255, 255], pattern: 'outline' }]);
    t.move!(pointer(w, own), false);
    expect(t.preview().layers).toBe(a);
    // 画出来的格（扭曲后的格、格以下的海岸）与 cell 不同时描画出来的那一格
    const other = own === 0 ? 1 : 0;
    t.move!({ ...pointer(w, own), shown: { here: other } as Pointer['shown'] }, false);
    expect(t.preview().layers[0].cells).toEqual([other]);
    const c = cityList(w).find((x) => x.capital && !x.point)!;
    t.move!(pointer(w, c.cell), false);
    expect(t.preview().layers).toEqual([]);
    // 钉住的格：任何工具下都描边，压在最下面
    const empty = { layers: [], shapes: [], hint: null };
    expect(highlightLayers(w, w, empty, [], 'inspect').layers).toEqual([]);
    pinnedCell.value = own;
    const pinned = highlightLayers(w, w, empty, [], 'inspect');
    expect(pinned.layers).toEqual([{ cells: [own], color: [255, 255, 255], pattern: 'outline' }]);
    expect(highlightLayers(w, w, empty, [], 'inspect').key).toEqual(pinned.key);
  });

  it('悬停的一句话跟着模式：国家、文化、宗教、人口、地名', () => {
    const w = towns().world;
    const own = emptyLand(w, true);
    expect(pointerText(w, own, 'country')).toBe(w.small.countries![countryAt(w, own)!].name);
    const code = w.derived.popCulture![own];
    expect(pointerText(w, own, 'culture')).toBe(code ? worldCultures(w.small)[code - 1].name : '无人');
    expect(pointerText(w, own, 'dim:religion')).toBeTruthy();
    expect(pointerText(w, own, 'popDensity')).toMatch(/人/);
    const sea = Array.from({ length: w.mesh.n }, (_, i) => i).find((i) => !w.causes.land[i])!;
    expect(pointerText(w, sea, 'culture')).toBeNull();
    // 地理：所在的地方的名字
    const f = w.derived.features.find((x) => x.type === 'island' || x.type === 'continent')!;
    expect(pointerText(w, f.anchor, 'geo')).toBeTruthy();
  });

  it('只画地图上画着的：文化模式里点不到不是首都的城市', () => {
    const w = towns().world;
    world.value = w;
    setMapKind('culture');
    const marks = shownMarks(w, { mode: modeDef(modeOf(w)), editing: false });
    const small = cityList(w).find((c) => !c.capital && !c.secondCapital && !c.point)!;
    expect(marks.some((m) => m.key === markKey('city', small.id))).toBe(false);
  });
});

describe('道路', () => {
  it('平时细、半透明、没有衬边，小路一格 9 像素才画；“道路”工具里照旧清楚、6 像素', () => {
    const quiet = roadStyle({}, 'realistic');
    expect(quiet.major).toMatchObject({ width: QUIET_ROAD_WIDTH.major, casing: null });
    expect(quiet.major.width).toBeCloseTo(0.9);
    expect(quiet.minor.width).toBeCloseTo(0.6);
    expect(quiet.major.color).toMatch(/0\.45\)$/);
    expect(quiet.minor.color).toMatch(/0\.3\)$/);
    const clear = roadStyle({ clear: true }, 'atlas');
    expect(clear.major.width).toBe(ROAD_WIDTH.major);
    expect(clear.major.casing).not.toBeNull();
    expect(MINOR_ROAD_PX).toBe(9);
    expect(MINOR_ROAD_EDIT_PX).toBe(6);
    const w = towns().world;
    const set = roadSet(w)!;
    expect(set.draw.minorPx).toBe(MINOR_ROAD_PX);
    expect(set.clear).toMatchObject({ minorPx: MINOR_ROAD_EDIT_PX, clear: true, major: set.draw.major });
    expect(settleOverlay(w, { mode: modeDef('country'), editing: false }).roads).toBe(set.draw);
    expect(settleOverlay(w, { mode: modeDef('country'), editing: true, roadEdit: true }).roads).toBe(set.clear);
  });
});
