import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import type { Engine } from '../../core/engine';
import { countryFactions, countryMapColors, countryStats } from '../../core/human';
import { continents, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { cellLayers, countryBorderGroups, humanFlat } from '../render/colors';
import { countryLineText, layoutAlong, smoothPath } from '../render/overlay';
import { askUser, exec, mode, options, parsePrefs, prefs, selectedCountry, setOptions, sheet, world } from '../state';
import { EMBLEM_NAMES, LAYOUT_NAMES, withEmblem, withLayout } from './CountryArchive';
import {
  countryAt,
  countryLabelLines,
  countryRows,
  estimateCountries,
  factionPatch,
  flagColorPatch,
  foundedPatch,
  fragAt,
  fragPos,
  fragText,
  generateCountriesCommand,
  hasCountries,
  historyPatch,
  namePatch,
  patchCommand,
  regenerateCountriesCommand,
  rulerPatch,
  titlePreview,
  yearText,
} from './countries';
import { humanViews, viewAvailable } from './defs/layers';
import { CATEGORY_DEFS, TOOL_DEFS, setTool, toolsOf } from './defs/tools';
import { newWorldCommands } from './forms';
import { defaultChoice, generateCommand, regenerateWith } from './human';
import { hereLine } from './Inspector';
import { LEGEND_TOP, legendFor } from './legend';
import { countryDraws } from './map/political';
import { mapKind, modeFeatures, modeOf, setMapKind } from './map/modes';
import { isTitleField, titleRows, titleValue } from './packs/fields';
import { GOV_KINDS, repoKinds } from './packs/repo';
import { type Pointer, capitalTool, chosenTerritory, countryLand, countryMergeTool, countrySelectTool, newCountryTool, pickTerritory, territoryTool } from './tools';

// 第二十三轮的界面：向导里的“国家”、“国家”一类的五个工具、国家的档案（set_country 的 patch）、地理图 / 人文图、国名、图例、仓库里的政体

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true), askUser: vi.fn(async () => 'ok') }));

afterEach(() => {
  setTool('land');
  mode.value = 'terrain';
  selectedCountry.value = null;
  sheet.value = null;
  setOptions({ territory: -1, newCountryShape: 'province' });
  vi.mocked(exec).mockClear();
  vi.mocked(askUser).mockClear();
});

const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
  { id: 'steppe', weight: 1.5 },
];
// 分裂一些：小地图上也有好几个国家
const GEN: Command = { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: { fragmentation: 1 } };
const nations = (): Engine =>
  snapshot('ui:nations', () => {
    const eng = continents();
    eng.exec(GEN);
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    return eng;
  });

const pointer = (w: World, c: number, shift = false): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift, alt: false });
const cellsOf = (w: World, id: number) => Array.from({ length: w.mesh.n }, (_, i) => i).filter((i) => w.causes.land[i] && w.causes.country![i] === id);
const lastCmd = () => vi.mocked(exec).mock.calls.at(-1)![0] as Command & Record<string, unknown>;
const ids = (w: World) => countryRows(w).map((r) => r.meta.id);

describe('新建向导的“国家”', () => {
  it('默认同时生成国家；分裂 ↔ 统一在正中时不写；关掉时没有 countries', () => {
    const c = defaultChoice(null);
    expect(c.countries).toEqual({ on: true, fragmentation: 0.5 });
    expect(generateCommand(c)).toMatchObject({ op: 'generate_human', countries: {} });
    expect(generateCommand({ ...c, countries: { on: true, fragmentation: 0.8 } })).toMatchObject({ countries: { fragmentation: 0.8 } });
    expect('countries' in generateCommand({ ...c, countries: { on: false, fragmentation: 0.8 } })!).toBe(false);
    const cmds = newWorldCommands({ seed: 3, type: 'continents' }, '像地球', 3, [], generateCommand(c));
    expect(cmds.map((x) => x.op)).toEqual(['batch', 'generate_human', 'generate_provinces']);
    expect(cmds[1]).toMatchObject({ countries: {} });
  });

  it('滑块：左边分裂、右边统一，每格 0.05；有世界时估出大约几个国家（越分裂越多）', () => {
    expect(fragPos(1)).toBe(0);
    expect(fragPos(0)).toBe(1);
    expect(fragAt(0.26)).toBe(0.75);
    expect([fragText(1), fragText(0.5), fragText(0)]).toEqual(['很分裂', '适中', '很统一']);
    const w = nations().world;
    const many = estimateCountries(w, 1)!;
    const few = estimateCountries(w, 0)!;
    expect(many).toBeGreaterThan(few);
    expect(few).toBeGreaterThanOrEqual(1);
    // 生成的个数与估的同一个算法（按文化分、整理时并掉小块，差一点）
    const n = Object.keys(w.small.countries!).length;
    expect(Math.abs(n - many) / many).toBeLessThan(0.25);
  });

  it('换时代重新生成人文时国家也重新长；没换时代时不写 countries', () => {
    const w = nations().world;
    const same = regenerateWith({ ...defaultChoice(w.small), pop: 1e8 }, w.small)!;
    expect('countries' in same).toBe(false);
    const other = regenerateWith({ ...defaultChoice(w.small), era: 'antiquity' }, w.small)!;
    expect(other).toMatchObject({ op: 'regenerate_human', era: 'antiquity', countries: {} });
  });
});

describe('“国家”一类', () => {
  it('五个工具，都换上国家的底图；没有国家时也在', () => {
    expect(CATEGORY_DEFS.countries).toMatchObject({ label: '国家', tools: ['cselect', 'territory', 'newCountry', 'cmerge', 'capital'] });
    expect(CATEGORY_DEFS.countries.extras).toBeTruthy();
    expect(toolsOf('countries', continents().world)).toHaveLength(5);
    for (const id of CATEGORY_DEFS.countries.tools) expect(TOOL_DEFS[id].view).toBe('country');
    expect(TOOL_DEFS.territory.pick).toBeTypeOf('function');
    // 有国家时换成国家底图；没有时不换
    world.value = nations().world;
    mode.value = 'elevation';
    setTool('cselect');
    expect(mode.value).toBe('country');
    setTool('land');
    expect(mode.value).toBe('elevation');
    world.value = continents().world;
    setTool('territory');
    expect(mode.value).toBe('elevation');
  });

  it('选国家：悬停时那一国亮、写国名；点一下选中并打开档案；无主地取消选择', async () => {
    const w = nations().world;
    world.value = w;
    const id = ids(w)[0];
    const c = cellsOf(w, id)[0];
    const t = countrySelectTool(() => 1 / w.mesh.spacing);
    t.move!(pointer(w, c), false);
    const pv = t.preview();
    expect(pv.hint).toBe(w.small.countries![id].name);
    expect(pv.layers[0].cells.length).toBe(cellsOf(w, id).length);
    await t.click!(pointer(w, c));
    expect(selectedCountry.value).toBe(id);
    expect(sheet.value).toBe('country');
    // 首都：每国一颗星（圆、星、圈三样）
    const caps = Object.values(w.small.countries!).filter((m) => m.capitalCell !== undefined).length;
    expect(t.backdrop!()!.shapes.length).toBe(caps * 3);
    const free = Array.from({ length: w.mesh.n }, (_, i) => i).find((i) => w.causes.land[i] && w.causes.country![i] < 0);
    if (free !== undefined) {
      await t.click!(pointer(w, free));
      expect(selectedCountry.value).toBeNull();
      expect(sheet.value).toBeNull();
    }
  });

  it('领土笔刷：paint_country（只画陆地）；没选时涂给选中的国家，0 是无主地；Alt+点击吸取', async () => {
    const w = nations().world;
    world.value = w;
    const [a, b] = ids(w);
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    setOptions({ brushKm: 2 * cellKm });
    selectedCountry.value = a;
    expect(chosenTerritory(w)!.id).toBe(a);
    const c = cellsOf(w, b)[0];
    const paint = async () => {
      const t = territoryTool(() => 1 / w.mesh.spacing);
      const p = pointer(w, c);
      t.move?.(p, false);
      t.down?.(p);
      await t.up?.(p);
      return lastCmd();
    };
    const cmd = await paint();
    expect(cmd).toMatchObject({ op: 'paint_country', country: a });
    expect((cmd.cells as number[]).every((i) => countryLand(w, i))).toBe(true);
    setOptions({ territory: 0 });
    expect(await paint()).toMatchObject({ op: 'paint_country', country: null });
    expect(pickTerritory(w, c)).toBe(w.small.countries![b].name);
    expect(options.value.territory).toBe(b);
    // 没有国家：说一声，不发命令
    vi.mocked(exec).mockClear();
    world.value = continents().world;
    const t = territoryTool(() => 1);
    t.move?.(pointer(world.value, c), false);
    expect(t.preview().hint).toBe('先生成国家');
  });

  it('新建国家：点一个陆地省份（它的陆地格）或圈一片（圈里的陆地）', async () => {
    const w = nations().world;
    world.value = w;
    const c = Array.from({ length: w.mesh.n }, (_, i) => i).find((i) => w.causes.land[i] && w.causes.province[i] >= 0)!;
    const t = newCountryTool(() => 1 / w.mesh.spacing);
    t.move!(pointer(w, c), false);
    expect(t.preview().hint).toContain('成为新国家');
    await t.click!(pointer(w, c));
    const cmd = lastCmd();
    const p = w.causes.province[c];
    expect(cmd.op).toBe('new_country');
    expect([...(cmd.cells as number[])].sort((x, y) => x - y)).toEqual(Array.from({ length: w.mesh.n }, (_, i) => i).filter((i) => w.causes.province[i] === p && w.causes.land[i]));
    // 圈一片
    setOptions({ newCountryShape: 'lasso' });
    const t2 = newCountryTool(() => 1 / w.mesh.spacing);
    expect(t2.drags).toBe(true);
    const s = w.mesh.spacing * 4;
    const [x, y] = [w.mesh.x[c], w.mesh.y[c]];
    const ring: [number, number][] = [
      [x - s, y - s],
      [x + s, y - s],
      [x + s, y + s],
      [x - s, y + s],
    ];
    const at = (q: [number, number]): Pointer => ({ x: q[0], y: q[1], cell: c, sx: 0, sy: 0, shift: false, alt: false });
    t2.down!(at(ring[0]));
    for (const q of [...ring.slice(1), ring[0]]) t2.move!(at(q), true);
    await t2.up!(at(ring[0]));
    const cmd2 = lastCmd();
    expect(cmd2.op).toBe('new_country');
    expect((cmd2.cells as number[]).length).toBeGreaterThan(4);
    expect((cmd2.cells as number[]).every((i) => w.causes.land[i])).toBe(true);
  });

  it('合并：先点一国（选中），再点另一国，问一句再 merge_countries；取消时不发', async () => {
    const w = nations().world;
    world.value = w;
    const [a, b] = ids(w);
    const t = countryMergeTool(() => 1);
    await t.click!(pointer(w, cellsOf(w, a)[0]));
    expect(selectedCountry.value).toBe(a);
    expect(exec).not.toHaveBeenCalled();
    t.move!(pointer(w, cellsOf(w, b)[0]), false);
    expect(t.preview().hint).toBe(`并进“${w.small.countries![a].name}”`);
    await t.click!(pointer(w, cellsOf(w, b)[0]));
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(lastCmd()).toEqual({ op: 'merge_countries', a, b });
    vi.mocked(exec).mockClear();
    vi.mocked(askUser).mockResolvedValueOnce('cancel');
    await t.click!(pointer(w, cellsOf(w, b)[0]));
    expect(exec).not.toHaveBeenCalled();
  });

  it('首都：点选中国家的一格 move_capital；点别国是选中它；Shift+点击挪过的恢复自动', async () => {
    const eng = nations();
    const w = eng.world;
    world.value = w;
    const [a, b] = ids(w);
    selectedCountry.value = a;
    const m = w.small.countries![a];
    const cell = cellsOf(w, a).find((i) => i !== m.capitalCell)!;
    const t = capitalTool(() => 1);
    t.move!(pointer(w, cell), false);
    expect(t.preview().hint).toBe('首都挪到这里');
    await t.click!(pointer(w, cell));
    expect(lastCmd()).toEqual({ op: 'move_capital', id: a, cell });
    await t.click!(pointer(w, cellsOf(w, b)[0]));
    expect(selectedCountry.value).toBe(b);
    eng.exec({ op: 'move_capital', id: b, cell: cellsOf(w, b).at(-1)! });
    world.value = eng.world;
    vi.mocked(exec).mockClear();
    await t.click!(pointer(eng.world, cellsOf(eng.world, b)[0], true));
    expect(lastCmd()).toEqual({ op: 'move_capital', id: b, cell: null });
  });
});

describe('国家的档案', () => {
  it('名字：改了写 name（原文跟着），空着恢复自动（只在改过名字时），没变时不发；core 照样认', () => {
    const eng = nations();
    const w = eng.world;
    const m = w.small.countries![ids(w)[0]];
    expect(namePatch(m, m.name, m.orig ?? '')).toBeNull();
    expect(namePatch(m, '  新国 ', 'Neuland')).toEqual({ name: '新国', orig: 'Neuland' });
    expect(namePatch(m, '', '')).toBeNull();
    eng.exec(patchCommand(m.id, namePatch(m, '新国', '')!));
    const n = eng.world.small.countries![m.id];
    expect(n).toMatchObject({ name: '新国', nameLocked: true });
    expect(namePatch(n, '', '')).toEqual({ name: '' });
    // 换政体后的国名（改过名字的不变）
    const gov = Object.keys(w.small.content!.government!).find((g) => g !== m.government)!;
    expect(titlePreview(w, m, gov)).not.toBe('');
    expect(titlePreview(eng.world, n, gov)).toBe('新国');
  });

  it('统治者、建国年份、历史：没变时 null；年份认“公元前 500 年”', () => {
    const m = nations().world.small.countries![ids(nations().world)[0]];
    expect(rulerPatch(m, m.ruler.name, m.ruler.orig ?? '', m.ruler.title ?? '')).toBeNull();
    expect(rulerPatch(m, '', '', '')).toBeNull();
    expect(rulerPatch(m, '阿德', '', '国王')).toEqual({ ruler: { name: '阿德', title: '国王' } });
    expect(foundedPatch(m, String(m.founded))).toBeNull();
    expect(foundedPatch(m, '公元前 500 年')).toEqual({ founded: -500 });
    expect(foundedPatch(m, '1066')).toEqual({ founded: 1066 });
    expect(foundedPatch(m, '一千年')).toBeNull();
    expect(yearText(-500)).toBe('公元前 500 年');
    expect(historyPatch(m, m.history)).toBeNull();
    expect(historyPatch(m, '新的')).toEqual({ history: '新的' });
  });

  it('旗帜：改一种颜色、样式（颜色的种数跟着）、纹章；都是 core 认的旗帜', () => {
    const eng = nations();
    const m = eng.world.small.countries![ids(eng.world)[0]];
    let f = flagColorPatch(m.flag, 0, '#123456');
    expect(f.colors[0]).toBe('#123456');
    f = withLayout(f, 'tricolor-v');
    expect(f.colors.length).toBe(3);
    f = withEmblem(f, 'lion');
    expect(f).toMatchObject({ emblem: 'lion' });
    expect(f.emblemColor).toMatch(/^#/);
    f = flagColorPatch(f, -1, '#abcdef');
    expect(f.emblemColor).toBe('#abcdef');
    eng.exec(patchCommand(m.id, { flag: f }));
    expect(eng.world.small.countries![m.id].flag).toEqual(f);
    expect('emblem' in withEmblem(f, '')).toBe(false);
    expect(Object.keys(LAYOUT_NAMES).length).toBe(14);
    expect(Object.keys(EMBLEM_NAMES).length).toBe(14);
  });

  it('派系：改一个，别的按比例让出，加起来是 1；core 照用定的，null 恢复自动', () => {
    const eng = nations();
    const w = eng.world;
    const id = ids(w)[0];
    const list = countryFactions(w, id, countryStats(w, id));
    expect(list.length).toBeGreaterThan(1);
    const p = factionPatch(list, list[0].id, 0.7);
    expect(p[list[0].id]).toBe(0.7);
    expect(Object.values(p).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    eng.exec(patchCommand(id, { factions: p }));
    expect(countryFactions(eng.world, id)[0].influence).toBe(0.7);
    eng.exec(patchCommand(id, { factions: null }));
    expect(eng.world.small.countries![id].factions).toBeUndefined();
  });

  it('外交：宗主、同盟、敌对都是整份换掉；附庸在地图上用宗主的浅色', () => {
    const eng = nations();
    const [a, b, c] = ids(eng.world);
    eng.exec(patchCommand(b, { overlord: a }));
    eng.exec(patchCommand(a, { allies: [c] }));
    const s = eng.world.small.countries!;
    expect(s[b].overlord).toBe(a);
    expect(s[c].allies).toContain(a);
    const colors = countryMapColors(eng.world);
    const codes = Object.values(s).sort((x, y) => x.id - y.id);
    const kb = codes.findIndex((m) => m.id === b) + 1;
    const own = s[b].color;
    expect(`#${colors[kb]!.map((v) => v.toString(16).padStart(2, '0')).join('')}`).not.toBe(own);
  });
});

describe('地图模式里的国家（第二十三轮的地理图 / 人文图）', () => {
  it('存在偏好里（旧的 political 读作国家）；国家模式把底图换成国家，地理换回地貌；没有国家时国家模式不起作用', () => {
    expect(parsePrefs(null).map).toBe('geo');
    expect(parsePrefs(JSON.stringify({ map: 'political' })).map).toBe('country');
    expect(parsePrefs(JSON.stringify({ map: 'xx' })).map).toBe('geo');
    const w = nations().world;
    world.value = w;
    mode.value = 'terrain';
    setMapKind('country');
    expect(mapKind.value).toBe('country');
    expect(prefs.value.map).toBe('country');
    expect(mode.value).toBe('country');
    expect(modeOf(w)).toBe('country');
    expect(modeOf(continents().world)).toBe('geo');
    // 别的底图不动
    mode.value = 'temperature';
    setMapKind('geo');
    expect(mode.value).toBe('temperature');
    mode.value = 'country';
    setMapKind('geo');
    expect(mode.value).toBe('terrain');
    expect(modeOf(w)).toBe('geo');
  });

  it('国家模式的地名：自然的只留海、湾、海峡、湖、山脉（自己的照旧）', () => {
    const w = nations().world;
    const kept = modeFeatures(w.derived.features, 'political');
    expect(kept.every((f) => ['ocean', 'sea', 'bay', 'strait', 'lake', 'range', 'region', 'spot'].includes(f.type) || f.custom)).toBe(true);
    expect(kept.length).toBeLessThan(w.derived.features.length);
    expect(modeFeatures(w.derived.features, 'political')).toBe(kept);
  });

  it('国名：每国一个，按中文 / 原文 / 两者（两者时两行，原文大写）；同样的输入同一个数组', () => {
    const w = nations().world;
    const zh = countryDraws(w, 'zh');
    expect(zh.length).toBe(Object.keys(w.small.countries!).length);
    expect(countryDraws(w, 'zh')).toBe(zh);
    const m = Object.values(w.small.countries!).find((x) => x.orig)!;
    const key = `country:${m.id}`;
    expect(zh.find((d) => d.key === key)!.lines).toEqual([m.name]);
    expect(countryDraws(w, 'orig').find((d) => d.key === key)!.lines).toEqual([m.orig]);
    expect(countryDraws(w, 'both').find((d) => d.key === key)!.lines).toEqual([m.name, m.orig]);
    expect(countryLabelLines({ name: 'A', orig: undefined }, 'orig')).toEqual(['A']);
    expect(countryLineText(['Kingdom of Téjoile'])).toEqual(['KINGDOM OF TÉJOILE']);
    expect(countryLineText(['泰茹瓦勒王国', 'Kingdom of Téjoile'])).toEqual(['泰茹瓦勒王国', 'KINGDOM OF TÉJOILE']);
    for (const d of zh) {
      expect(d.path).toHaveLength(5);
      expect(d.area).toBeGreaterThan(0);
    }
  });

  it('沿中线排字：字距拉开铺满八成，放不下时 null', () => {
    const pts = smoothPath([
      [0, 0],
      [50, 10],
      [100, 15],
      [150, 10],
      [200, 0],
    ]);
    expect(pts.length).toBe(17);
    const r = layoutAlong(['一', '二', '三'], [1, 1, 1], pts, 20, 100)!;
    expect(r.glyphs).toHaveLength(3);
    expect(r.gap).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThan(100);
    expect(r.glyphs[0].x).toBeLessThan(r.glyphs[2].x);
    expect(layoutAlong(['一', '二'], [1, 1], pts, 200, 10)).toBeNull();
  });

  it('底图与国界：国家平涂（领海淡、海不涂），国界的分组分陆海', () => {
    const w = nations().world;
    const flat = humanFlat(w, 'country');
    const owned = Array.from({ length: w.mesh.n }, (_, i) => i).find((i) => w.causes.land[i] && w.derived.lake[i] !== 1 && w.derived.country![i])!;
    expect(flat[owned * 4 + 3]).toBeGreaterThan(200);
    const sea = Array.from({ length: w.mesh.n }, (_, i) => i).find((i) => !w.causes.land[i] && !w.derived.country![i])!;
    expect(flat[sea * 4 + 3]).toBe(0);
    const g = countryBorderGroups(w);
    expect(g[owned * 2]).toBe(w.derived.country![owned]);
    expect(g[sea * 2]).toBe(-1);
    expect(cellLayers(w, { mode: 'country', season: 'annual', focusSpecies: null, borders: false, countryBorders: true }).countryGroup).toBeTruthy();
    expect(cellLayers(w, { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false }).countryGroup).toBeNull();
    expect(humanViews(w)[0].id).toBe('country');
    expect(viewAvailable(w, 'country')).toBe(true);
    expect(viewAvailable(continents().world, 'country')).toBe(false);
  });

  it('图例：按人口前几个国家（颜色是地图上的），其余合成“其他”', () => {
    const w = nations().world;
    const lg = legendFor(w, 'country')!;
    expect(lg.title).toBe('国家');
    const rows = countryRows(w);
    expect(lg.items[0].label).toBe(rows[0].meta.name);
    expect(lg.items[0].count).toBe(rows[0].stats!.population);
    if (rows.length > LEGEND_TOP) {
      expect(lg.items).toHaveLength(LEGEND_TOP + 1);
      expect(lg.items.at(-1)!.label).toBe(`其他 ${rows.length - LEGEND_TOP} 国`);
    }
    expect(legendFor(continents().world, 'country')).toBeNull();
  });

  it('“这里”的一行写国名或无主地；一格是哪国', () => {
    const w = nations().world;
    expect(hasCountries(w)).toBe(true);
    const id = ids(w)[0];
    const c = cellsOf(w, id)[0];
    expect(countryAt(w, c)).toBe(id);
    expect(hereLine(w, c).startsWith(`${w.small.countries![id].name} · `)).toBe(true);
    expect(hereLine(continents().world, c)).not.toContain(w.small.countries![id].name);
  });
});

describe('“国家 ⋯”与仓库', () => {
  it('生成、重新生成：正中、没变时不写；不留锁定的写 keepLocked: false', () => {
    const w = nations().world;
    expect(generateCountriesCommand(0.5)).toEqual({ op: 'generate_countries' });
    expect(generateCountriesCommand(0.2)).toEqual({ op: 'generate_countries', fragmentation: 0.2 });
    expect(regenerateCountriesCommand(w, 1, true)).toEqual({ op: 'regenerate_countries' });
    expect(regenerateCountriesCommand(w, 0.3, false)).toEqual({ op: 'regenerate_countries', fragmentation: 0.3, keepLocked: false });
  });

  it('国家列表按人口从多到少', () => {
    const rows = countryRows(nations().world);
    for (let k = 1; k < rows.length; k++) expect(rows[k].stats!.population).toBeLessThanOrEqual(rows[k - 1].stats!.population);
  });

  it('仓库里有政体、派系；称号一行一种，只有 default 时存回最简单的写法', () => {
    const kinds = repoKinds().map((k) => k.id);
    expect(kinds).toContain('government');
    expect(kinds).toContain('faction');
    expect([...GOV_KINDS]).toEqual(['government', 'faction']);
    const gov = repoKinds().find((k) => k.id === 'government')!;
    expect(gov.fields!.filter(isTitleField).map((f) => f.key)).toEqual(['title', 'rulerTitle']);
    expect(titleRows('王国')).toEqual([{ key: 'default', zh: '王国', orig: '' }]);
    expect(titleRows({ zh: '王国', orig: 'Kingdom of {name}' })).toEqual([{ key: 'default', zh: '王国', orig: 'Kingdom of {name}' }]);
    const rows = titleRows({ default: { zh: '王国', orig: 'Kingdom of {name}' }, steppe: '汗国' });
    expect(rows).toHaveLength(2);
    expect(titleValue(rows)).toEqual({ default: { zh: '王国', orig: 'Kingdom of {name}' }, steppe: '汗国' });
    expect(titleValue([{ key: 'default', zh: '王国', orig: '' }])).toBe('王国');
    expect(titleValue([{ key: 'default', zh: '', orig: '' }])).toBeUndefined();
  });
});
