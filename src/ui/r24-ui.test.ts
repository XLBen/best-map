import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Command, popText } from '../../core/commands';
import type { Engine } from '../../core/engine';
import { cityList, landmarkList, roadHandles, roadPoints, rankFor, worldCityRanks } from '../../core/human';
import { continents, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { type OverlayState, SETTLE_KEY, placeLabels } from '../render/overlay';
import { BoxIndex, CITY_ICONS, LANDMARK_ICONS, POINT_ICONS, iconPathData, iconScale, markRadius, nameSpots } from '../render/settle-draw';
import { askUser, exec, options, overlays, selectedSettle, setOptions, sheet, world } from '../state';
import { CATEGORY_DEFS, TOOL_DEFS, setTool, toolsOf } from './defs/tools';
import { OVERLAYS } from './defs/layers';
import { defaultChoice, generateCommand } from './human';
import { hereLine } from './Inspector';
import { SETTLE_KINDS, repoKinds } from './packs/repo';
import {
  BIG_CITY_PX,
  MEDIUM_CITY_PX,
  MINOR_ROAD_EDIT_PX,
  SMALL_CITY_PX,
  addPointCommand,
  attachFor,
  cityFoundedPatch,
  cityIconOf,
  cityIconPx,
  cityMark,
  cityNamePx,
  cityShown,
  countryCityRows,
  exportPartRows,
  generateSettleCommand,
  iconChoices,
  isImageUrl,
  landmarkMark,
  markKey,
  pickMark,
  pickRoad,
  refOfKey,
  regenerateSettleCommand,
  removeCommand,
  removeSettleCommand,
  roadSet,
  settleCounts,
  settleHere,
  settleLists,
  settleMarks,
  settleNamePatch,
  type SettleShow,
  settleShow,
  textPatch,
} from './settlements';
import { modeDef } from './map/modes';
import { type Pointer, cityTool, landmarkTool, pointTool, roadTool } from './tools';

// 第二十四轮的界面：向导的“城市与道路”“地标”、“城市”一类的四个工具发出的命令、缩放分级与图标、地图上的字、档案的 patch、
// 单独导出的列表、仓库里的三种内容

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true), askUser: vi.fn(async () => 'ok') }));

afterEach(() => {
  setTool('land');
  selectedSettle.value = null;
  sheet.value = null;
  setOptions({ roadKind: 'minor', landmarkType: 'castle', pointType: 'marker', pointAttach: true });
  vi.mocked(exec).mockClear();
  vi.mocked(askUser).mockClear();
});

const GEN: Command = {
  op: 'generate_human',
  era: 'medieval',
  groups: [
    { id: 'western', weight: 3 },
    { id: 'eastern', weight: 3 },
  ],
  countries: {},
  settlements: {},
};
const towns = (): Engine =>
  snapshot('ui:towns', () => {
    const eng = continents();
    eng.exec(GEN);
    return eng;
  });

// 画全部城市、地标、点
const ALL: SettleShow = { cities: 'all', cityNames: 'capitals', landmarks: 'all', points: true };

// 一格在屏幕上 20 像素：什么都画、都认
const zoomOf = (w: World) => () => 20 / w.mesh.spacing;
const pointer = (w: World, c: number, sx = 0, sy = 0): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx, sy, shift: false, alt: false });
const at = (_w: World, x: number, y: number, c: number, sx = 0, sy = 0): Pointer => ({ x, y, cell: c, sx, sy, shift: false, alt: false });
const lastCmd = () => vi.mocked(exec).mock.calls.at(-1)![0] as Command & Record<string, unknown>;
const adjacent = (w: World, a: number, b: number) => {
  for (let e = w.mesh.off[a]; e < w.mesh.off[a + 1]; e++) if (w.mesh.adj[e] === b) return true;
  return false;
};
// 离城市、地标都远的干陆地格
function emptyLand(w: World): number {
  const taken = [...Object.values(w.small.cities ?? {}).map((c) => c.cell), ...Object.values(w.small.landmarks ?? {}).map((l) => l.cell)];
  const far = (i: number) => taken.every((t) => Math.hypot(w.mesh.x[i] - w.mesh.x[t], w.mesh.y[i] - w.mesh.y[t]) > w.mesh.spacing * 3);
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && w.derived.lake[i] !== 1 && far(i)) return i;
  throw new Error('没有空地');
}

describe('新建向导的“城市与道路”“地标”', () => {
  it('默认都生成（settlements: {}）；关掉地标写 landmarks: false；关掉城市或国家时没有 settlements', () => {
    const c = defaultChoice(null);
    expect(c.settlements).toEqual({ on: true, landmarks: true });
    expect(generateCommand(c)).toMatchObject({ countries: {}, settlements: {} });
    expect(generateCommand({ ...c, settlements: { on: true, landmarks: false } })).toMatchObject({ settlements: { landmarks: false } });
    expect('settlements' in generateCommand({ ...c, settlements: { on: false, landmarks: true } })!).toBe(false);
    // 城市要有国家
    expect('settlements' in generateCommand({ ...c, countries: { on: false, fragmentation: 0.5 } })!).toBe(false);
  });
});

describe('“城市”一类', () => {
  it('四个工具：城市、道路、地标、自定义点；Delete 删除选中的；“⋯”是生成与删除；图层里有三个开关（有城市时才列）', () => {
    expect(CATEGORY_DEFS.settlements).toMatchObject({ label: '城市', tools: ['city', 'road', 'landmark', 'point'] });
    expect(CATEGORY_DEFS.settlements.extras).toBeTruthy();
    expect(toolsOf('settlements', continents().world)).toHaveLength(4);
    for (const id of CATEGORY_DEFS.settlements.tools) expect(TOOL_DEFS[id].del).toBeTypeOf('function');
    expect(TOOL_DEFS.road.cursor).toBeUndefined();
    expect(OVERLAYS.filter((o) => o.settle).map((o) => o.key)).toEqual(['roads', 'cities', 'landmarks']);
    expect(overlays.value).toMatchObject({ roads: true, cities: true, landmarks: true });
  });

  it('城市：点空地 add_city，点城市选中并打开档案，拖城市 move_city，Delete remove_city', async () => {
    const w = towns().world;
    world.value = w;
    const t = cityTool(zoomOf(w));
    const free = emptyLand(w);
    t.move!(pointer(w, free), false);
    expect(t.drags).toBe(false);
    expect(t.preview().hint).toBe('新建城市');
    await t.click!(pointer(w, free));
    expect(lastCmd()).toEqual({ op: 'add_city', cell: free });
    // 海上：不发
    const sea = Array.from({ length: w.mesh.n }, (_, i) => i).find((i) => !w.causes.land[i])!;
    vi.mocked(exec).mockClear();
    await t.click!(pointer(w, sea));
    expect(exec).not.toHaveBeenCalled();
    // 点城市：选中、打开档案
    const c = cityList(w).find((x) => !x.point && !x.capital)!;
    t.move!(pointer(w, c.cell), false);
    expect(t.drags).toBe(true);
    // 第二十五轮：名字、等级、人口
    expect(t.preview().hint).toBe(`${c.name} · ${c.rank.name} · ${popText(c.population)} 人`);
    t.down!(pointer(w, c.cell));
    await t.up!(pointer(w, c.cell));
    expect(selectedSettle.value).toEqual({ kind: 'city', id: c.id });
    expect(sheet.value).toBe('settle');
    // 拖到一格空地
    t.move!(pointer(w, c.cell), false);
    t.down!(pointer(w, c.cell, 0, 0));
    t.move!(pointer(w, free, 30, 0), true);
    expect(t.preview().hint).toBe('挪到这里');
    await t.up!(pointer(w, free, 30, 0));
    expect(lastCmd()).toEqual({ op: 'move_city', id: c.id, cell: free });
    // Delete
    expect(TOOL_DEFS.city.del!()).toBe(true);
    expect(lastCmd()).toEqual({ op: 'remove_city', id: c.id });
    // 地标工具不删城市
    expect(TOOL_DEFS.landmark.del!()).toBe(false);
  });

  it('道路：按住画一笔 add_road（一串相邻的陆地格，种类按底部条）；点道路选中；拖控制点 edit_road', async () => {
    const w = towns().world;
    world.value = w;
    const t = roadTool(zoomOf(w));
    const road = Object.values(w.small.roads!).sort((a, b) => b.cells.length - a.cells.length)[0];
    const pts = roadPoints(w, road.cells);
    // 沿着一条已有的路画（都在陆地上）
    setOptions({ roadKind: 'major' });
    t.move!(at(w, pts[0][0], pts[0][1], road.cells[0]), false);
    t.down!(at(w, pts[0][0], pts[0][1], road.cells[0], 0, 0));
    pts.forEach((p, k) => t.move!(at(w, p[0], p[1], road.cells[k], 10 + k * 10, 0), true));
    const last = road.cells.length - 1;
    await t.up!(at(w, pts[last][0], pts[last][1], road.cells[last], 500, 0));
    const add = lastCmd();
    expect(add.op).toBe('add_road');
    expect(add.kind).toBe('major');
    const cells = add.cells as number[];
    expect(cells.length).toBeGreaterThan(1);
    for (const c of cells) expect(w.causes.land[c]).toBe(1);
    for (let k = 1; k < cells.length; k++) expect(adjacent(w, cells[k - 1], cells[k])).toBe(true);
    // 点一下（不拖）：选中鼠标下的道路
    const mid = Math.floor(pts.length / 2);
    t.move!(at(w, pts[mid][0], pts[mid][1], road.cells[mid]), false);
    expect(t.preview().hint).toMatch(/大道|小路/);
    t.down!(at(w, pts[mid][0], pts[mid][1], road.cells[mid]));
    await t.up!(at(w, pts[mid][0], pts[mid][1], road.cells[mid]));
    expect(selectedSettle.value?.kind).toBe('road');
    // 选中的路：拖一个中间的控制点
    selectedSettle.value = { kind: 'road', id: road.id };
    const H = roadHandles(w, road);
    expect(H.length).toBeGreaterThanOrEqual(2);
    const j = H.length > 2 ? 1 : 0;
    const hp = pts[H[j]];
    t.move!(at(w, hp[0], hp[1], road.cells[H[j]]), false);
    expect(t.preview().hint).toBe('拖动改走向');
    t.down!(at(w, hp[0], hp[1], road.cells[H[j]], 0, 0));
    // 挪到旁边一格陆地
    const near = Array.from({ length: w.mesh.off[road.cells[H[j]] + 1] - w.mesh.off[road.cells[H[j]]] }, (_, e) => w.mesh.adj[w.mesh.off[road.cells[H[j]]] + e]).find(
      (c) => w.causes.land[c] && !road.cells.includes(c),
    );
    expect(near).toBeDefined();
    vi.mocked(exec).mockClear();
    t.move!(pointer(w, near!, 40, 0), true);
    expect(t.preview().hint).toBe('改走向');
    await t.up!(pointer(w, near!, 40, 0));
    const e = lastCmd();
    expect(e).toMatchObject({ op: 'edit_road', id: road.id });
    expect((e.cells as number[]).includes(near!)).toBe(true);
    // Delete
    selectedSettle.value = { kind: 'road', id: road.id };
    expect(TOOL_DEFS.road.del!()).toBe(true);
    expect(lastCmd()).toEqual({ op: 'remove_road', id: road.id });
  });

  it('地标：点空地 add_landmark（底部条选的种类），拖地标 move_landmark；点它选中', async () => {
    const w = towns().world;
    world.value = w;
    const t = landmarkTool(zoomOf(w));
    const free = emptyLand(w);
    setOptions({ landmarkType: 'temple' });
    t.move!(pointer(w, free), false);
    expect(t.preview().hint).toBe('新建神庙');
    await t.click!(pointer(w, free));
    expect(lastCmd()).toEqual({ op: 'add_landmark', type: 'temple', cell: free });
    // 种类不在了：用第一种
    setOptions({ landmarkType: 'nope' });
    await t.click!(pointer(w, free));
    expect(lastCmd().type).toBe('famous-peak');
    const l = landmarkList(w)[0];
    if (l) {
      t.move!(pointer(w, l.cell), false);
      t.down!(pointer(w, l.cell, 0, 0));
      t.move!(pointer(w, free, 50, 0), true);
      await t.up!(pointer(w, free, 50, 0));
      expect(lastCmd()).toEqual({ op: 'move_landmark', id: l.id, cell: free });
      t.move!(pointer(w, l.cell), false);
      t.down!(pointer(w, l.cell));
      await t.up!(pointer(w, l.cell));
      expect(selectedSettle.value).toEqual({ kind: 'landmark', id: l.id });
    }
  });

  it('自定义点：点击放 add_point（精确的位置）；当作城市的类型挂在附近的城市上，关掉时自己当一座城市', async () => {
    const w = towns().world;
    world.value = w;
    const t = pointTool(zoomOf(w));
    const free = emptyLand(w);
    await t.click!(pointer(w, free));
    expect(lastCmd()).toEqual({ op: 'add_point', type: 'marker', cell: free, x: w.mesh.x[free], y: w.mesh.y[free] });
    // 陪都：点在城市上挂上它
    const c = cityList(w).find((x) => !x.point && !x.capital)!;
    setOptions({ pointType: 'second-capital' });
    t.move!(at(w, c.x + w.mesh.spacing * 0.3, c.y, c.cell), false);
    expect(t.preview().hint).toBe(`新建陪都 · 挂在“${c.name}”上`);
    await t.click!(at(w, c.x + w.mesh.spacing * 0.3, c.y, c.cell));
    expect(lastCmd()).toMatchObject({ op: 'add_point', type: 'second-capital', attachedCity: c.id });
    setOptions({ pointAttach: false });
    await t.click!(pointer(w, free));
    expect(lastCmd()).toMatchObject({ op: 'add_point', type: 'second-capital', attachedCity: null });
    // 远处没有城市：自己当一座城市
    setOptions({ pointAttach: true });
    expect(attachFor(w, 'second-capital', w.mesh.x[free], w.mesh.y[free], true)).toBeNull();
    expect(attachFor(w, 'marker', c.x, c.y, true)).toBeUndefined();
    expect(addPointCommand('marker', 3, 0.1, 0.2)).toEqual({ op: 'add_point', type: 'marker', cell: 3, x: 0.1, y: 0.2 });
  });

  it('发出的命令 core 都认：加、挪、改、删城市，画、改、删道路，地标、点', () => {
    const eng = towns();
    const w = eng.world;
    const free = emptyLand(w);
    const c = cityList(w).find((x) => !x.point && !x.capital)!;
    const n0 = settleCounts(w).cities;
    eng.exec({ op: 'add_city', cell: free });
    expect(settleCounts(eng.world).cities).toBe(n0 + 1);
    eng.exec({ op: 'set_city', id: c.id, patch: { rank: 'big' } });
    expect(cityList(eng.world).find((x) => x.id === c.id)!.rank.id).toBe('big');
    eng.exec({ op: 'set_city', id: c.id, patch: { rank: null } });
    expect(cityList(eng.world).find((x) => x.id === c.id)!.rankAuto).toBe(true);
    eng.exec(removeCommand({ kind: 'city', id: c.id }));
    expect(eng.world.small.cities![c.id]).toBeUndefined();
    eng.exec(addPointCommand('marker', free, w.mesh.x[free], w.mesh.y[free]));
    expect(settleCounts(eng.world).points).toBe(1);
  });
});

describe('缩放分级与图标', () => {
  it('首都总画；大城市一格 2 像素、城市 5 像素、村镇 10 像素以上才画；名字更晚', () => {
    expect(cityIconPx(4, true)).toBe(0);
    expect(cityIconPx(3, false)).toBe(BIG_CITY_PX);
    expect(cityIconPx(2, false)).toBe(MEDIUM_CITY_PX);
    expect(cityIconPx(1, false)).toBe(SMALL_CITY_PX);
    // 第二十五轮：不是首都的城市不写名字（选中的写，图标画出来就写）
    for (const l of [1, 2, 3]) expect(cityNamePx(l, false)).toBe(Infinity);
    for (const l of [1, 2, 3]) expect(cityNamePx(l, false, true)).toBe(cityIconPx(l, false));
    const ranks = worldCityRanks({});
    const small = rankFor(ranks, 0, 0);
    expect(cityShown({ rank: small, capital: false, secondCapital: false }, 1)).toBe(false);
    expect(cityShown({ rank: small, capital: false, secondCapital: true }, 1)).toBe(true);
    expect(cityShown({ rank: small, capital: false, secondCapital: false }, SMALL_CITY_PX)).toBe(true);
  });

  it('图标：首都星、大城市双圈、城市大圆、村镇点；不认识的画大圆；缩得很小时图标小一些', () => {
    expect(worldCityRanks({}).map((r) => cityIconOf(r))).toEqual(['star', 'double-ring', 'circle', 'dot']);
    expect(cityIconOf({ icon: 'castle' })).toBe('circle');
    expect(markRadius({ kind: 'city', icon: 'star' })).toBeGreaterThan(markRadius({ kind: 'city', icon: 'double-ring' }));
    expect(markRadius({ kind: 'city', icon: 'circle' })).toBeGreaterThan(markRadius({ kind: 'city', icon: 'dot' }));
    expect(iconScale(1)).toBeLessThan(iconScale(10));
    // 内置的地标类型、点的类型都有图标
    const w = towns().world;
    for (const l of landmarkList(w)) expect(LANDMARK_ICONS[l.icon]).toBeTruthy();
    for (const t of ['pin', 'star-outline', 'fort', 'swords', 'anchor', 'pick', 'shrine', 'tent', 'chest']) expect(POINT_ICONS[t]).toBeTruthy();
    // lucide 的图形换成 SVG 的 path（圆、矩形也换）
    for (const C of [...Object.values(LANDMARK_ICONS), ...Object.values(POINT_ICONS)]) {
      const d = iconPathData(C);
      expect(d.length).toBeGreaterThan(0);
      for (const x of d) expect(x).toMatch(/^[Mm]/);
    }
  });

  it('地图上画哪些：国家模式城市与全部地标；地理模式只画自然的地标与自定义点；“城市”一类开着时都画；没有国家时城市照画', () => {
    const country = modeDef('country');
    const geo0 = modeDef('geo');
    expect(settleShow({ mode: country, countries: true, editing: false, cities: true, landmarks: true })).toEqual({ cities: 'all', cityNames: 'capitals', landmarks: 'all', points: true });
    expect(settleShow({ mode: geo0, countries: true, editing: false, cities: true, landmarks: true })).toEqual({ cities: 'none', cityNames: 'capitals', landmarks: 'natural', points: true });
    expect(settleShow({ mode: geo0, countries: true, editing: true, cities: true, landmarks: true })).toEqual({ cities: 'all', cityNames: 'capitals', landmarks: 'all', points: true });
    expect(settleShow({ mode: geo0, countries: false, editing: false, cities: true, landmarks: false })).toEqual({ cities: 'all', cityNames: 'capitals', landmarks: 'none', points: false });
    const w = towns().world;
    const all = settleMarks(w, 'zh', ALL);
    // 同样的输入同一个数组
    expect(settleMarks(w, 'zh', ALL)).toBe(all);
    const geo = settleMarks(w, 'zh', { cities: 'none', cityNames: 'capitals', landmarks: 'natural', points: true });
    expect(geo.every((m) => m.kind === 'landmark')).toBe(true);
    expect(geo.length).toBe(landmarkList(w).filter((l) => l.category === 'natural').length);
    // 重要的在前：首都与大城市在别的城市前面
    const firstSmall = all.findIndex((m) => m.kind === 'city' && m.iconPx > BIG_CITY_PX);
    const lastBig = all.map((m) => m.kind === 'city' && m.iconPx <= BIG_CITY_PX).lastIndexOf(true);
    expect(lastBig).toBeLessThan(firstSmall);
    // 键与选中的对得上
    expect(refOfKey(markKey('city', 7))).toEqual({ kind: 'city', id: 7 });
    expect(refOfKey('country:3')).toBeNull();
  });

  it('认鼠标下的：只认画着的（缩小时认不到村镇）；道路小路放大后才认', () => {
    const w = towns().world;
    const marks = settleMarks(w, 'zh', ALL);
    const dot = marks.find((m) => m.kind === 'city' && m.iconPx === SMALL_CITY_PX)!;
    expect(pickMark(w, marks, dot.x, dot.y, w.mesh.spacing * 0.2, SMALL_CITY_PX)?.key).toBe(dot.key);
    expect(pickMark(w, marks, dot.x, dot.y, w.mesh.spacing * 0.2, 1)?.key).not.toBe(dot.key);
    const set = roadSet(w)!;
    const minor = set.paths[set.minorIdx[0]];
    if (minor) {
      const p = minor.points[Math.floor(minor.points.length / 2)];
      expect(pickRoad(w, p[0], p[1], w.mesh.spacing * 0.3, MINOR_ROAD_EDIT_PX)?.kind).toBeDefined();
    }
    // 同样的道路同一份
    expect(roadSet(w)).toBe(set);
    expect(set.draw.major.length + set.draw.minor.length).toBe(Object.keys(w.small.roads!).length);
  });
});

describe('地图上的字', () => {
  it('城市的名字按中文 / 原文 / 两者；首都、大城市粗体、字大', () => {
    const w = towns().world;
    const c = cityList(w).find((x) => x.orig && x.capital) ?? cityList(w).find((x) => x.capital)!;
    expect(cityMark(c, 'zh').name).toBe(c.name);
    if (c.orig) {
      expect(cityMark(c, 'orig').name).toBe(c.orig);
      expect(cityMark(c, 'both').name).toBe(`${c.name} ${c.orig}`);
    }
    expect(cityMark(c, 'zh')).toMatchObject({ bold: true, always: true, icon: 'star' });
    const small = cityList(w).find((x) => x.rank.level === 1);
    if (small) expect(cityMark(small, 'zh').fontPx).toBeLessThan(cityMark(c, 'zh').fontPx);
    const l = landmarkList(w)[0];
    if (l) expect(landmarkMark(l, 'zh').name).toBe(l.name);
  });

  it('排版：国名之后排城市；图标挤在一起时只画重要的，名字找不重叠的地方；这些框不给点击命中', () => {
    const ctx = { canvas: { clientWidth: 800, clientHeight: 600 }, font: '', measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D;
    const cam = { x: 0.5, y: 0.5, zoom: 1000 };
    const mk = (id: number, x: number, always = false) => ({ key: `${SETTLE_KEY}city:${id}`, kind: 'city' as const, x, y: 0.5, icon: 'circle', name: `城${id}`, fontPx: 11, textColor: '#000', iconPx: 0, namePx: 0, ...(always ? { always } : {}) });
    // 两座挨得很近（2 像素）的城市：只画第一座；首都照画
    const st = { features: [], labelTypes: null, kmPerUnit: 1000, hoverLabel: null, cellSize: 0.01, settlements: [mk(1, 0.5), mk(2, 0.502), mk(3, 0.5025, true)] } as unknown as OverlayState;
    const r = placeLabels(ctx, cam, st, [0], 1000);
    const icons = r.placed.filter((l) => l.mark).map((l) => l.key);
    expect(icons).toEqual([`${SETTLE_KEY}city:1`, `${SETTLE_KEY}city:3`]);
    const names = r.placed.filter((l) => !l.mark && l.chars.length).map((l) => l.chars.join(''));
    expect(names).toContain('城1');
    expect(r.boxes.some((b) => b.key.startsWith(SETTLE_KEY))).toBe(false);
    // 一格太小时不画
    const st2 = { ...st, cellSize: 0.000001, settlements: [{ ...mk(1, 0.5), iconPx: 5 }] } as unknown as OverlayState;
    expect(placeLabels(ctx, cam, st2, [0], 1000).placed.filter((l) => l.mark)).toHaveLength(0);
    // 名字先放右边，再左、上、下
    const spots = nameSpots(100, 100, 5, 20, 10);
    expect(spots[0][0]).toBeGreaterThan(100);
    expect(spots[1][0]).toBeLessThan(100);
    const idx = new BoxIndex();
    idx.add({ key: 'a', x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(idx.hits({ key: 'b', x0: 5, y0: 5, x1: 20, y1: 20 })).toBe(true);
    expect(idx.hits({ key: 'b', x0: 50, y0: 50, x1: 60, y1: 60 })).toBe(false);
  });

  it('“这里”的一行写这一格的城市（首都）、地标', () => {
    const w = towns().world;
    const cap = cityList(w).find((c) => c.capital && !c.point)!;
    expect(settleHere(w, cap.cell)).toContain(`${cap.name}（首都）`);
    expect(hereLine(w, cap.cell)).toContain(`${cap.name}（首都）`);
    const l = landmarkList(w)[0];
    if (l) expect(settleHere(w, l.cell)).toContain(l.name);
  });
});

describe('档案与“城市 ⋯”', () => {
  it('名字：空着恢复自动（只在自己起过时），没变时 null，原文跟着名字', () => {
    expect(settleNamePatch({ name: 'A', customName: false }, '', '')).toBeNull();
    expect(settleNamePatch({ name: 'A', customName: true }, ' ', '')).toEqual({ name: '' });
    expect(settleNamePatch({ name: 'A', orig: 'a', customName: true }, 'A', 'a')).toBeNull();
    expect(settleNamePatch({ name: 'A', customName: false }, 'B', ' Bee ')).toEqual({ name: 'B', orig: 'Bee' });
  });

  it('建城年份认“公元前 500 年”“前 500”，空着恢复自动；简介、备注空着去掉', () => {
    expect(cityFoundedPatch({ founded: 800, foundedAuto: true }, '公元前 500 年')).toEqual({ founded: -500 });
    expect(cityFoundedPatch({ founded: 800, foundedAuto: true }, '前500')).toEqual({ founded: -500 });
    expect(cityFoundedPatch({ founded: 800, foundedAuto: true }, '800')).toBeNull();
    expect(cityFoundedPatch({ founded: 800, foundedAuto: false }, '')).toEqual({ founded: null });
    expect(cityFoundedPatch({ founded: 800, foundedAuto: true }, '')).toBeNull();
    expect(cityFoundedPatch({ founded: 800, foundedAuto: true }, 'abc')).toBeNull();
    expect(textPatch(undefined, '  ')).toBeUndefined();
    expect(textPatch('x', '')).toBeNull();
    expect(textPatch('x', 'x')).toBeUndefined();
    expect(textPatch(undefined, 'y')).toBe('y');
  });

  it('档案的改动交给 core：名字、等级、年份、简介、锁定；地标的类型；点挂在城市上', () => {
    const eng = towns();
    const c = cityList(eng.world).find((x) => !x.point && !x.capital)!;
    eng.exec({ op: 'set_city', id: c.id, patch: { ...settleNamePatch(c, '新城', 'Newton')!, ...cityFoundedPatch({ founded: 0, foundedAuto: true }, '公元前 300 年')!, description: textPatch(undefined, '一座城')!, locked: true } });
    const m = eng.world.small.cities![c.id];
    expect(m).toMatchObject({ name: '新城', orig: 'Newton', founded: -300, description: '一座城', locked: true });
    eng.exec({ op: 'set_city', id: c.id, patch: { name: '', description: null } });
    expect(eng.world.small.cities![c.id].name).toBeUndefined();
    const l = landmarkList(eng.world)[0];
    if (l) {
      eng.exec({ op: 'set_landmark', id: l.id, patch: { type: 'castle' } });
      expect(eng.world.small.landmarks![l.id].type).toBe('castle');
    }
  });

  it('生成、重新生成只写和记着的不一样的；删除几种', () => {
    expect(generateSettleCommand({ roads: true, landmarks: true })).toEqual({ op: 'generate_settlements' });
    expect(generateSettleCommand({ roads: false, landmarks: true })).toEqual({ op: 'generate_settlements', roads: false });
    const w = towns().world;
    expect(regenerateSettleCommand(w, { roads: true, landmarks: true })).toEqual({ op: 'regenerate_settlements' });
    expect(regenerateSettleCommand(w, { roads: true, landmarks: false })).toEqual({ op: 'regenerate_settlements', landmarks: false });
    expect(removeSettleCommand([])).toBeNull();
    expect(removeSettleCommand(['cities', 'points'])).toEqual({ op: 'remove_settlements', cities: true, points: true });
  });

  it('国家档案的城市：这一国的城市按人口从多到少，首都在里面', () => {
    const w = towns().world;
    const id = Number(Object.keys(w.small.countries!)[0]);
    const rows = countryCityRows(w, id);
    expect(rows.length).toBeGreaterThan(0);
    for (let k = 1; k < rows.length; k++) expect(rows[k - 1].population).toBeGreaterThanOrEqual(rows[k].population);
    expect(rows.some((c) => c.capital)).toBe(true);
    expect(settleLists(w)).toBe(settleLists(w));
  });
});

describe('导出与仓库', () => {
  it('单独导出：EXPORT_PARTS 的每一项，按世界里有没有；没有人文的世界只有地名表', () => {
    const w = towns().world;
    const rows = exportPartRows(w);
    expect(rows.map((r) => r.id)).toEqual(['cities', 'roads', 'roads-image', 'landmarks', 'points', 'countries', 'features', 'archive-md', 'archive-json']);
    expect(rows.filter((r) => r.available).map((r) => r.id)).toEqual(['cities', 'roads', 'roads-image', 'landmarks', 'countries', 'features', 'archive-md', 'archive-json']);
    expect(rows.find((r) => r.id === 'roads-image')!.image).toBe(true);
    expect(exportPartRows(continents().world).filter((r) => r.available).map((r) => r.id)).toEqual(['features']);
  });

  it('仓库：城市等级、地标类型、点的类型都在，图标从内置的里选，点的类型能上传小图', () => {
    const ids = repoKinds().map((k) => k.id);
    for (const k of ['cityRank', 'landmarkType', 'pointType']) {
      expect(ids).toContain(k);
      expect(SETTLE_KINDS.has(k)).toBe(true);
    }
    expect(iconChoices('cityRank')).toEqual([...CITY_ICONS]);
    expect(iconChoices('landmarkType')).toEqual(Object.keys(LANDMARK_ICONS));
    expect(iconChoices('pointType')).toEqual(Object.keys(POINT_ICONS));
    expect(iconChoices('biome')).toBeNull();
    expect(isImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isImageUrl('https://example.com/a.png')).toBe(false);
  });
});

void options;
