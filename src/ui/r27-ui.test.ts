import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import type { Engine } from '../../core/engine';
import { brushCells } from '../../core/select';
import { continents, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { worldResources, worldTerrainClasses } from '../../core/human';
import { erasing, exec, options, picking, provinceSet, selectedCountry, selectedProvince, setOptions, world } from '../state';
import { COUNTRY_TABS, countryTab, flagPartName } from './CountryArchive';
import { TOOL_DEFS, createTool, eraserModes, setTool } from './defs/tools';
import type { ToolId } from './defs/tools';
import { provinceAreaText, provinceMultiCommands } from './provincePanel';
import { onKeyDown } from './shell/keys';
import { type Pointer, type ToolHandler, brushNew, factorOf, percentText, popCommand, provinceBrushTool, provinceSelectTool, toggleProvince } from './tools';
import { countryAt, territoryCommand } from './countries';

// 第二十七轮的界面：所有笔刷的吸管与橡皮擦、人口减少、档案里设首都、国家档案的页签、省份的多选与新省份、省份大小

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true), askUser: vi.fn(async () => 'ok') }));

afterEach(() => {
  setTool('land');
  picking.value = false;
  erasing.value = null;
  selectedProvince.value = null;
  selectedCountry.value = null;
  provinceSet.value = [];
  brushNew.value = false;
  setOptions({ popMode: 'share', popAmount: 0.4, popPercent: 0.5, territory: -1 });
  vi.mocked(exec).mockClear();
});

const GEN: Command = { op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }], countries: { fragmentation: 1 }, settlements: {} };

// 有人文、国家、省份、城市的世界：中间一块地方各种都手改过（冷暖、生态、类别、资源、自定义场、人口、领土、地势），橡皮擦都有东西可擦
const edited = (): { eng: Engine; c: number; ring: number[] } => {
  const eng = snapshot('r27:edited', () => {
    const e = continents({ provinces: true });
    e.exec(GEN);
    return e;
  });
  const w = eng.world;
  const cellKm = w.mesh.spacing * w.kmPerUnit;
  const inner = (i: number) => w.mesh.x[i] > 0.2 * w.mesh.width && w.mesh.x[i] < 0.8 * w.mesh.width && w.mesh.y[i] > 0.2 * w.mesh.height && w.mesh.y[i] < 0.8 * w.mesh.height;
  const near = (i: number) => brushCells(w, w.mesh.x[i], w.mesh.y[i], 3 * cellKm).cells;
  let c = -1;
  for (let i = 0; i < w.mesh.n && c < 0; i += 3) {
    if (!inner(i)) continue;
    const r = near(i);
    if (r.every((j) => w.causes.land[j] && w.derived.lake[j] !== 1 && (w.causes.popTotal?.[j] ?? 0) > 0 && (w.causes.country?.[j] ?? -1) >= 0)) c = i;
  }
  if (c < 0) throw new Error('找不到合适的格');
  const ring = near(c);
  return { eng, c, ring };
};

const env = { zoom: () => 1, hitLabel: () => null };
const pointer = (w: World, c: number, shift = false): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift, alt: false });
const lastCmd = () => vi.mocked(exec).mock.calls.at(-1)?.[0] as (Command & Record<string, unknown>) | undefined;
async function drag(t: ToolHandler, w: World, c: number, shift = false) {
  const p = pointer(w, c, shift);
  t.move?.(p, false);
  t.down?.(p);
  t.move?.(p, true);
  await t.up?.(p);
}

describe('吸管', () => {
  it('每个笔刷都能吸（起伏、打碎没有能吸的值，不显示吸管）', () => {
    const { eng, c, ring } = edited();
    eng.exec({ op: 'paint', field: 'tempOffset', cells: ring, values: ring.map(() => -2), mode: 'add' });
    eng.exec({ op: 'paint', field: 'moistOffset', cells: ring, values: ring.map(() => 0.25), mode: 'add' });
    eng.exec({ op: 'add_field', name: 'mana' });
    eng.exec({ op: 'paint', field: 'field:mana', cells: ring, values: ring.map(() => 0.3), mode: 'add' });
    const w = eng.world;
    world.value = w;
    setOptions({ field: 'mana' });
    const brushes: ToolId[] = ['land', 'biome', 'grow', 'terrainClass', 'temp', 'moist', 'field', 'resource', 'pbrush', 'culture', 'pop', 'territory'];
    for (const id of brushes) expect([id, TOOL_DEFS[id].pick?.(w, c) ?? null]).not.toEqual([id, null]);
    expect(TOOL_DEFS.relief.pick).toBeUndefined();
    expect(TOOL_DEFS.fragment.pick).toBeUndefined();
    // 冷暖、干湿、自定义场：数量滑块取这一格改过多少
    TOOL_DEFS.temp.pick!(w, c);
    expect(options.value).toMatchObject({ tempMode: 'cold', tempAmount: 0.5 });
    TOOL_DEFS.moist.pick!(w, c);
    expect(options.value).toMatchObject({ moistMode: 'wet', moistAmount: 0.5 });
    TOOL_DEFS.field.pick!(w, c);
    expect(options.value).toMatchObject({ fieldMode: 'add', fieldAmount: 0.3 });
    // 陆海：这里是陆地就画陆地
    setOptions({ landMode: 'sea' });
    expect(TOOL_DEFS.land.pick!(w, c)).toBe('画陆地');
    expect(options.value.landMode).toBe('land');
    // 没改过冷暖的地方没有可吸的
    const plain = w.causes.tempOffset.findIndex((v, i) => v === 0 && w.causes.land[i] === 1);
    expect(TOOL_DEFS.temp.pick!(w, plain)).toBeNull();
  });

  it('I 打开吸管（下一次点击吸取），Esc 关上；打开吸管时橡皮擦关上；换工具时都关上', () => {
    world.value = edited().eng.world;
    setTool('temp');
    const key = (k: string) => onKeyDown({ key: k, code: '', target: null, repeat: false, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent);
    key('e');
    expect(erasing.value).toBe('auto');
    key('i');
    expect(picking.value).toBe(true);
    expect(erasing.value).toBeNull();
    key('Escape');
    expect(picking.value).toBe(false);
    key('e');
    key('e');
    expect(erasing.value).toBeNull();
    key('e');
    setTool('moist');
    expect(erasing.value).toBeNull();
    // 起伏没有吸管：I 不起作用
    setTool('relief');
    key('i');
    expect(picking.value).toBe(false);
  });
});

describe('橡皮擦', () => {
  // 每个笔刷：开着橡皮擦时的工具发出什么命令
  const ERASE: [ToolId, 'auto' | 'clear', string][] = [
    ['land', 'auto', 'restore_terrain'],
    ['relief', 'auto', 'restore_terrain'],
    ['fragment', 'auto', 'restore_terrain'],
    ['island', 'auto', 'restore_terrain'],
    ['chain', 'auto', 'restore_terrain'],
    ['temp', 'auto', 'restore_climate'],
    ['moist', 'auto', 'restore_climate'],
    ['field', 'auto', 'paint'],
    ['biome', 'auto', 'erase_constraints'],
    ['grow', 'auto', 'erase_constraints'],
    ['terrainClass', 'auto', 'set_cell_class'],
    ['resource', 'auto', 'set_cell_resource'],
    ['resource', 'clear', 'set_cell_resource'],
    ['culture', 'auto', 'restore_pop'],
    ['culture', 'clear', 'paint_pop'],
    ['pop', 'auto', 'restore_pop'],
    ['pop', 'clear', 'paint_pop'],
    ['territory', 'auto', 'restore_country'],
    ['territory', 'clear', 'paint_country'],
    ['pbrush', 'auto', 'regenerate_provinces'],
  ];

  it('每个笔刷都有橡皮擦；清空只在领土、人口、文化、资源上有', () => {
    for (const [id] of ERASE) expect(eraserModes(id)).toContain('auto');
    const withClear = (Object.keys(TOOL_DEFS) as ToolId[]).filter((id) => eraserModes(id).includes('clear')).sort();
    expect(withClear).toEqual(['culture', 'pop', 'resource', 'territory']);
    // 原来的三个橡皮擦工具并进了橡皮擦
    for (const id of ['restore', 'unclimate', 'erase', 'capital', 'pmerge']) expect(id in TOOL_DEFS).toBe(false);
  });

  it('两种模式都擦得到：改过的格擦回自动，清空清成无主、0 人、没有资源', async () => {
    const { eng, c, ring } = edited();
    const w0 = eng.world;
    const ids = Object.keys(w0.small.countries!).map(Number);
    const other = ids.find((x) => x !== w0.causes.country![c])!;
    const cls = worldTerrainClasses(w0.small).find((x) => x.id !== 'plains')!.id;
    const res = worldResources(w0.small)[0].id;
    eng.exec({ op: 'paint_relief', cells: ring, t: ring.map(() => 0), strength: 0.7 });
    eng.exec({ op: 'paint', field: 'tempOffset', cells: ring, values: ring.map(() => 2), mode: 'add' });
    eng.exec({ op: 'paint', field: 'moistOffset', cells: ring, values: ring.map(() => 0.3), mode: 'add' });
    eng.exec({ op: 'add_field', name: 'mana' });
    eng.exec({ op: 'paint', field: 'field:mana', cells: ring, values: ring.map(() => 0.5), mode: 'add' });
    const sp = w0.small.species.find((x) => x.id !== w0.small.species[w0.derived.dominant[c]]?.id)!;
    eng.exec({ op: 'add_constraint', constraint: { cells: ring, species: sp.id, mode: 'override', ratio: 1, radius: 100, label: '' } });
    eng.exec({ op: 'set_cell_class', cells: ring, class: cls });
    eng.exec({ op: 'set_cell_resource', cells: ring, resource: res });
    eng.exec({ op: 'paint_pop', cells: ring, mode: 'count', factor: 2 });
    eng.exec({ op: 'paint_country', cells: ring, country: other });
    const w = eng.world;
    world.value = w;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    for (const [id, mode, op] of ERASE) {
      setTool(id);
      setOptions({ field: 'mana', brushKm: (id === 'pbrush' ? 12 : 2) * cellKm });
      erasing.value = mode;
      vi.mocked(exec).mockClear();
      await drag(createTool(id, env), w, c);
      const cmd = lastCmd();
      expect([id, mode, cmd?.op]).toEqual([id, mode, op]);
      // 发出去的命令 core 照样认
      const copy = eng.clone();
      copy.exec(cmd!);
    }
    // 几个要看清楚的
    setTool('territory');
    setOptions({ brushKm: 2 * cellKm });
    erasing.value = 'clear';
    await drag(createTool('territory', env), w, c);
    expect(lastCmd()).toMatchObject({ op: 'paint_country', country: null });
    erasing.value = 'auto';
    await drag(createTool('territory', env), w, c);
    const restore = lastCmd()!;
    const after = eng.clone();
    after.exec(restore);
    expect((restore.cells as number[]).every((i) => after.world.causes.country![i] === w0.causes.countryAuto![i])).toBe(true);
    setTool('pop');
    setOptions({ brushKm: 2 * cellKm });
    erasing.value = 'clear';
    await drag(createTool('pop', env), w, c);
    expect(lastCmd()).toMatchObject({ op: 'paint_pop', mode: 'clear' });
    setTool('resource');
    erasing.value = 'clear';
    await drag(createTool('resource', env), w, c);
    expect(lastCmd()).toMatchObject({ op: 'set_cell_resource', resource: 'none' });
    erasing.value = 'auto';
    await drag(createTool('resource', env), w, c);
    expect(lastCmd()).toMatchObject({ op: 'set_cell_resource', resource: null });
  });

  it('恢复自动只涂得到改过的格，没改过的地方说一声、不发命令；能擦的格用斜线标出', async () => {
    const { eng, c } = edited();
    const w = eng.world;
    world.value = w;
    setTool('territory');
    erasing.value = 'auto';
    const t = createTool('territory', env);
    expect(t.backdrop?.()).toBeNull();
    vi.mocked(exec).mockClear();
    await drag(t, w, c);
    expect(exec).not.toHaveBeenCalled();
    // 没开橡皮擦时还是笔刷
    erasing.value = null;
    setOptions({ territory: Object.keys(w.small.countries!).map(Number).find((x) => x !== w.causes.country![c])! });
    await drag(createTool('territory', env), w, c);
    expect(lastCmd()?.op).toBe('paint_country');
  });
});

describe('人口减少', () => {
  it('改人数：−90% 到 +300%，倍数 = 1 + 比例，Shift 反过来', () => {
    const w = edited().eng.world;
    world.value = w;
    setOptions({ popMode: 'count', popPercent: -0.5 });
    expect(factorOf(false)).toBe(0.5);
    expect(factorOf(true)).toBe(2);
    expect(popCommand(w, [1], [1], false)).toMatchObject({ mode: 'count', factor: 0.5 });
    setOptions({ popPercent: 3 });
    expect(popCommand(w, [1], [1], false)).toMatchObject({ factor: 4 });
    expect([percentText(-0.5), percentText(0.5), percentText(0)]).toEqual(['−50%', '+50%', '0%']);
  });

  it('改成分、改一个维度：力度为负（或 Shift）是往外推，core 让人数或占比减少', () => {
    const { eng, c, ring } = edited();
    const w = eng.world;
    world.value = w;
    setOptions({ popMode: 'share', popAmount: -0.5 });
    const share = popCommand(w, ring, ring.map(() => 1), false)!;
    expect(share).toMatchObject({ mode: 'share', amount: -0.5 });
    setOptions({ popAmount: 0.5 });
    expect(popCommand(w, ring, ring.map(() => 1), true)).toMatchObject({ amount: -0.5 });
    setOptions({ popMode: 'count', popPercent: -0.6 });
    const before = w.causes.popTotal![c];
    eng.exec(popCommand(w, [c], [1], false)!);
    expect(eng.world.causes.popTotal![c]).toBeCloseTo(before * 0.4, -1);
    eng.exec(share);
  });
});

describe('首都', () => {
  it('城市档案“设为首都”、格的档案“在这里建首都”都是 move_capital；没有城市的格补上一座', () => {
    const { eng } = edited();
    const w = eng.world;
    const id = Number(Object.keys(w.small.countries!)[0]);
    const m = w.small.countries![id];
    const city = Object.values(w.small.cities ?? {}).find((x) => x.cell !== m.capitalCell && w.causes.country![x.cell] === id);
    expect(city).toBeTruthy();
    eng.exec({ op: 'move_capital', id, cell: city!.cell });
    expect(eng.world.small.countries![id]).toMatchObject({ capitalCell: city!.cell, capitalLocked: true });
    const cities = new Set(Object.values(eng.world.small.cities!).map((x) => x.cell));
    const bare = w.causes.country!.findIndex((v, i) => v === id && w.causes.land[i] === 1 && w.derived.lake[i] !== 1 && !cities.has(i));
    eng.exec({ op: 'move_capital', id, cell: bare });
    expect(Object.values(eng.world.small.cities!).some((x) => x.cell === bare)).toBe(true);
    eng.exec({ op: 'move_capital', id, cell: null });
    expect(eng.world.small.countries![id].capitalLocked).toBeUndefined();
  });
});

describe('国家档案', () => {
  it('分成五页；换了国家停在同一页；旗的颜色写是哪一块', () => {
    expect(COUNTRY_TABS.map(([, label]) => label)).toEqual(['概览', '政治', '人口与城市', '关系', '历史']);
    expect(countryTab.value).toBe('overview');
    expect([flagPartName('tricolor-v', 0), flagPartName('tricolor-v', 2), flagPartName('bicolor-h', 1), flagPartName('cross', 1), flagPartName('plain', 0)]).toEqual(['左', '右', '下', '十字', '底色']);
  });

  it('分成两半、并入别国：已有的 split_country、merge_countries', () => {
    const { eng } = edited();
    const w = eng.world;
    const [a, b] = Object.keys(w.small.countries!).map(Number);
    const n = Object.keys(w.small.countries!).length;
    eng.exec({ op: 'split_country', id: a });
    expect(Object.keys(eng.world.small.countries!).length).toBe(n + 1);
    eng.exec({ op: 'merge_countries', a: b, b: a });
    expect(eng.world.small.countries![a]).toBeUndefined();
  });
});

describe('省份', () => {
  const land = (w: World) => Object.entries(w.small.provinces).filter(([, m]) => m.kind === 'land' && !m.locked).map(([k]) => Number(k));
  const cellOf = (w: World, id: number) => w.causes.province.findIndex((p) => p === id);

  it('⇧+点多选：加进、去掉；单击换回单选', () => {
    const w = edited().eng.world;
    world.value = w;
    const [a, b, c] = land(w);
    const t = provinceSelectTool();
    // 测试里没有画出来的格：按格心所在的格
    const at = (id: number, shift = false) => ({ ...pointer(w, cellOf(w, id), shift), shown: { here: cellOf(w, id), province: cellOf(w, id) } as never });
    t.click!(at(a));
    expect(selectedProvince.value).toBe(a);
    t.click!(at(b, true));
    t.click!(at(c, true));
    expect(provinceSet.value).toEqual([a, b, c]);
    t.click!(at(b, true));
    expect(provinceSet.value).toEqual([a, c]);
    t.click!(at(b));
    expect(provinceSet.value).toEqual([]);
    expect(selectedProvince.value).toBe(b);
    toggleProvince(a);
    toggleProvince(a);
    expect(provinceSet.value).toEqual([]);
  });

  it('多选后合并（并进第一个）、划给某国、重新划分，core 照样认', () => {
    const { eng } = edited();
    const w = eng.world;
    const ids = land(w).slice(0, 3);
    const { merge, cells, land: dry, why } = provinceMultiCommands(w, ids);
    expect(why).toBeNull();
    expect(merge).toMatchObject({ op: 'batch', commands: [{ op: 'merge_province', from: ids[1], into: ids[0] }, { op: 'merge_province', from: ids[2], into: ids[0] }] });
    const merged = eng.clone();
    merged.exec(merge!);
    expect(ids.slice(1).every((id) => !merged.world.small.provinces[id])).toBe(true);
    expect(cells.every((i) => merged.world.causes.province[i] === ids[0])).toBe(true);
    const to = Object.keys(w.small.countries!).map(Number)[0];
    const given = eng.clone();
    given.exec(territoryCommand(dry, to));
    expect(dry.every((i) => countryAt(given.world, i) === to)).toBe(true);
    const regen = eng.clone();
    regen.exec({ op: 'regenerate_provinces', cells });
    expect(ids.every((id) => !regen.world.small.provinces[id])).toBe(true);
    // 海省与陆地省不能合并
    const sea = Number(Object.entries(w.small.provinces).find(([, m]) => m.kind === 'sea')![0]);
    expect(provinceMultiCommands(w, [ids[0], sea])).toMatchObject({ merge: null, why: '陆地省份、海省、湖省不能合并' });
  });

  it('省份笔刷：条上选“新省份”涂出一个新的（assign_province new），只涂陆地', async () => {
    const { eng, c } = edited();
    const w = eng.world;
    world.value = w;
    setOptions({ brushKm: 2 * w.mesh.spacing * w.kmPerUnit });
    brushNew.value = true;
    const t = provinceBrushTool();
    await drag(t, w, c);
    const cmd = lastCmd()!;
    expect(cmd).toMatchObject({ op: 'assign_province', province: 'new' });
    expect((cmd.cells as number[]).every((i) => w.causes.land[i] === 1)).toBe(true);
    const next = w.small.nextProvince;
    eng.exec(cmd);
    expect(eng.world.small.provinces[next]).toBeTruthy();
    // 吸取一个省：不再涂新省份
    brushNew.value = true;
    TOOL_DEFS.pbrush.pick!(w, c);
    expect(brushNew.value).toBe(false);
  });

  it('省份大小：滑块定目标大小，重新划分一国时用它（不改规则）', () => {
    const { eng } = edited();
    const w = eng.world;
    const id = Object.keys(w.small.countries!).map(Number).sort((a, b) => cellCount(w, b) - cellCount(w, a))[0];
    const cells = w.causes.country!.reduce<number[]>((a, v, i) => (v === id && w.causes.land[i] ? [...a, i] : a), []);
    const count = (size: number) => {
      const e = eng.clone();
      e.exec({ op: 'regenerate_provinces', cells, size });
      const set = new Set<number>();
      for (const i of cells) set.add(e.world.causes.province[i]);
      expect(e.world.small.provinceRules).toEqual(w.small.provinceRules);
      return set.size;
    };
    expect(count(10)).toBeGreaterThan(count(120));
    const rules = w.small.provinceRules;
    expect(provinceAreaText(w, rules, 10)).not.toBe(provinceAreaText(w, rules, 120));
    // 整个世界：写进规则
    const all = eng.clone();
    all.exec({ op: 'generate_provinces', rules: { sizeCells: 20 } });
    expect(all.world.small.provinceRules.sizeCells).toBe(20);
  });
});

function cellCount(w: World, id: number) {
  let k = 0;
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.country![i] === id) k++;
  return k;
}
