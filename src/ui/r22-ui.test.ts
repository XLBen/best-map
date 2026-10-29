import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { kindOf } from '../../core/content/registry';
import type { Engine } from '../../core/engine';
import { BUILTIN_CULTURES, BUILTIN_ERAS } from '../../core/packs/eras';
import { cellArchive, dimensionValues, humanLegend, readComp, worldCultures, worldDimensions } from '../../core/human';
import { continents, snapshot, type HumanCommand, humanExec, lastOf } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { cellLayers, colorSignature, humanFlat } from '../render/colors';
import { exec, mode, options, setOptions, world } from '../state';
import { addGroupCommand, cellTotalCommand, groupShareCommand, parsePeople, popRows, removeGroupCommand } from './archive';
import { humanViews, viewAvailable } from './defs/layers';
import { CATEGORIES, CATEGORY_DEFS, TOOL_DEFS, setTool, toolsOf } from './defs/tools';
import { newWorldCommands } from './forms';
import {
  chooseEra,
  defaultChoice,
  densityText,
  eraChoices,
  eraGroups,
  estimateLandKm2,
  generateCommand,
  groupChoices,
  popAt,
  popPos,
  regenerateWith,
  toggleGroup,
} from './human';
import { hereLine } from './Inspector';
import { legendFor } from './legend';
import { repoKinds, repoRows, repoSections } from './packs/repo';
import { type Pointer, chosenTuple, cultureTool, dryLand, hearthCommand, hearthMarks, hearthTool, popTool } from './tools';

// 第二十二轮的界面：新建向导的“人文”、“文化”一类的三个工具、人文的底图与图例、格的档案里的人口、仓库里的四种内容

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true) }));

afterEach(() => {
  setTool('land');
  mode.value = 'terrain';
  setOptions({ popMode: 'share', popTuple: null, culture: '', popDim: '', popValue: '' });
  vi.mocked(exec).mockClear();
});

// 与 core 的测试同一套：内置中世纪的三个组（加了别的文化组也不变）
const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
  { id: 'steppe', weight: 1.5 },
];
const GEN: HumanCommand = { op: 'generate_human', era: 'medieval', groups: GROUPS };
const peopled = (): Engine =>
  snapshot('ui:peopled', () => {
    const eng = continents();
    humanExec(eng, GEN);
    return eng;
  });

const dry = (w: World) => Array.from({ length: w.mesh.n }, (_, i) => i).filter((i) => dryLand(w, i));
const inhabited = (w: World) => dry(w).filter((i) => (w.causes.popTotal?.[i] ?? 0) > 0);
const pointer = (w: World, c: number, shift = false): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift, alt: false });

describe('新建向导的“人文”', () => {
  it('默认生成：第一个时代、它默认的文化组；总人口不动时不写（按真的陆地面积）', () => {
    const c = defaultChoice(null);
    const era = eraChoices(null)[0];
    expect(c).toMatchObject({ on: true, era: era.id, pop: null });
    expect(c.groups).toEqual(eraGroups(era));
    expect(c.groups.length).toBeGreaterThan(0);
    // 第三十轮：先把时代包的内容加进世界，再生成（一整步）；生成的命令带上时代所在的大包
    const cmd = lastOf(generateCommand(c)!);
    // 第二十三轮：默认同时生成国家（分裂 ↔ 统一在正中时不写，按时代）；第二十四轮：默认同时生成城市、道路、地标
    expect(cmd).toEqual({ op: 'generate_human', packs: [[era.id]], groups: c.groups, countries: {}, settlements: {} });
    expect('totalPop' in cmd).toBe(false);
    // 关掉、一个组都没勾：没有命令
    expect(generateCommand({ ...c, on: false })).toBeNull();
    expect(generateCommand(c.groups.reduce((x, g) => toggleGroup(x, g.id, false), c))).toBeNull();
    // 动了总人口：写进命令（取整）
    expect(lastOf(generateCommand({ ...c, pop: 123456789.4 })!)).toMatchObject({ totalPop: 123456789 });
  });

  it('内置的时代、文化组都列出来（加了新的自动出现）；换时代时文化组换成那个时代的默认、总人口回到自动', () => {
    expect(eraChoices(null).map((e) => e.id)).toEqual(BUILTIN_ERAS.map((e) => e.id));
    expect(groupChoices(null).length).toBeGreaterThanOrEqual(3);
    const c = { ...defaultChoice(null), pop: 5e8 };
    for (const e of eraChoices(null)) {
      const d = chooseEra(c, e.id);
      if (e.id === c.era) continue;
      expect(d).toMatchObject({ era: e.id, pop: null, groups: eraGroups(e) });
    }
  });

  it('总人口的滑块：默认的 1/10 到 10 倍，按对数，两位有效数字；估的陆地面积按地图（星球）大小 × 陆地多少', () => {
    const def = 4e8;
    expect(popAt(popPos(def, def), def)).toBe(def);
    expect(popAt(0, def)).toBe(4e7);
    expect(popAt(1, def)).toBe(4e9);
    expect(popPos(4e7, def)).toBeCloseTo(0);
    expect(String(popAt(0.37, def)).replace(/0+$/, '').length).toBeLessThanOrEqual(2);
    const earth = estimateLandKm2({ globe: true, radiusKm: 6371, landFraction: 0.3 });
    expect(earth / 1e6).toBeGreaterThan(140);
    expect(earth / 1e6).toBeLessThan(160);
    expect(estimateLandKm2({ globe: false, mapKm: 5000, landFraction: 0.5 })).toBe(5000 * 2500 * 0.5);
    expect(densityText(2.7)).toBe('2.7 人/km²');
    expect(densityText(0)).toBe('无人');
  });

  it('新建的命令：新世界 → 生成人文 → 划分省份；关着时没有人文这一步', () => {
    const gen = { seed: 3, type: 'continents' as const };
    const cmds = newWorldCommands(gen, '像地球', 3, [], GEN as Command);
    expect(cmds.map((c) => c.op)).toEqual(['batch', 'generate_human', 'generate_provinces']);
    expect(newWorldCommands(gen, '像地球', 3).map((c) => c.op)).toEqual(['batch', 'generate_provinces']);
  });

  it('人文排在划分省份之前：省名按当地文化的风格起（有原文）；倒过来时省名还是中文', () => {
    const a = continents();
    humanExec(a, GEN);
    a.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    const named = Object.values(a.world.small.provinces).filter((p) => p.land);
    expect(named.filter((p) => p.orig).length).toBeGreaterThan(named.length / 2);
    const b = continents();
    b.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    humanExec(b, GEN);
    expect(Object.values(b.world.small.provinces).filter((p) => p.orig).length).toBe(0);
  });
});

describe('“文化”一类', () => {
  it('顶栏多了“文化”：文化、人口、发源地三个工具，没有人文时也在（底部条上是“生成人文…”）', () => {
    expect(CATEGORIES.map((c) => c.id)).toContain('culture');
    expect(CATEGORY_DEFS.culture).toMatchObject({ label: '文化', tools: ['culture', 'pop', 'hearth'] });
    expect(CATEGORY_DEFS.culture.extras).toBeTruthy();
    const plain = continents().world;
    expect(toolsOf('culture', plain)).toEqual(['culture', 'pop', 'hearth']);
    expect(TOOL_DEFS.culture).toMatchObject({ category: 'culture', view: 'culture' });
    expect(TOOL_DEFS.hearth).toMatchObject({ category: 'culture', view: 'cultureGroup' });
    expect(TOOL_DEFS.culture.pick).toBeTypeOf('function');
    expect(TOOL_DEFS.pop.pick).toBeTypeOf('function');
  });

  it('底图跟着工具：有人文时换成文化圈；人口笔刷按模式（改成分看文化、改人数看人口密度、改一个维度看那一维）；没有人文时不换', () => {
    world.value = peopled().world;
    mode.value = 'elevation';
    setTool('culture');
    expect(mode.value).toBe('culture');
    setTool('pop');
    expect(mode.value).toBe('culture');
    setOptions({ popMode: 'count' });
    expect(mode.value).toBe('popDensity');
    setOptions({ popMode: 'value' });
    expect(mode.value).toBe(`dim:${worldDimensions(world.value.small)[0].id}`);
    setTool('hearth');
    expect(mode.value).toBe('cultureGroup');
    setTool('land');
    expect(mode.value).toBe('elevation');
    world.value = continents().world;
    setTool('culture');
    expect(mode.value).toBe('elevation');
  });

  it('删除人文：底图回到工具换上之前的那一层；又生成了人文时换上工具的那一层', () => {
    const eng = peopled();
    world.value = eng.clone().world;
    mode.value = 'elevation';
    setTool('hearth');
    expect(mode.value).toBe('cultureGroup');
    eng.exec({ op: 'remove_human' });
    world.value = eng.clone().world;
    expect(mode.value).toBe('elevation');
    humanExec(eng, GEN);
    world.value = eng.clone().world;
    expect(mode.value).toBe('cultureGroup');
    setTool('land');
    expect(mode.value).toBe('elevation');
  });

  it('文化笔刷：paint_culture，带权重；“连同倾向”写 typical；只涂干的陆地', async () => {
    const w = peopled().world;
    world.value = w;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    const c = inhabited(w)[0];
    const target = worldCultures(w.small).find((x) => x.id !== worldCultures(w.small)[w.derived.popCulture![c] - 1]?.id)!;
    setOptions({ brushKm: 2 * cellKm, culture: target.id, cultureAmount: 0.6, cultureMode: 'keep' });
    const paint = async (t: ReturnType<typeof cultureTool>, shift = false) => {
      const p = pointer(w, c, shift);
      t.move?.(p, false);
      t.down?.(p);
      await t.up?.(p);
      return vi.mocked(exec).mock.calls.at(-1)![0] as Command & { cells: number[]; t: number[] };
    };
    const a = await paint(cultureTool());
    expect(a).toMatchObject({ op: 'paint_culture', culture: target.id, amount: 0.6 });
    expect('typical' in a).toBe(false);
    expect(a.t.length).toBe(a.cells.length);
    expect(a.cells.every((i) => dryLand(w, i))).toBe(true);
    expect(Math.max(...a.t)).toBeLessThanOrEqual(1);
    setOptions({ cultureMode: 'typical' });
    expect(await paint(cultureTool())).toMatchObject({ op: 'paint_culture', typical: true });
  });

  it('人口笔刷三种：改成分（群体、力度）、改人数（倍数，Shift 是倒数）、改一个维度（维度、取值、力度）', async () => {
    const w = peopled().world;
    world.value = w;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    const c = inhabited(w)[0];
    setOptions({ brushKm: 2 * cellKm, popAmount: 0.4, popPercent: 1 });
    const paint = async (shift = false) => {
      const t = popTool();
      const p = pointer(w, c, shift);
      t.move?.(p, false);
      t.down?.(p);
      await t.up?.(p);
      return vi.mocked(exec).mock.calls.at(-1)![0] as Command;
    };
    const tuple = chosenTuple(w)!;
    expect(await paint()).toMatchObject({ op: 'paint_pop', mode: 'share', group: tuple, amount: 0.4 });
    setOptions({ popMode: 'count' });
    expect(await paint()).toMatchObject({ op: 'paint_pop', mode: 'count', factor: 2 });
    expect(await paint(true)).toMatchObject({ op: 'paint_pop', mode: 'count', factor: 0.5 });
    setOptions({ popMode: 'value' });
    const dim = worldDimensions(w.small)[0];
    const val = dimensionValues(w.small, dim.id)[1];
    setOptions({ popDim: dim.id, popValue: val.id });
    expect(await paint()).toMatchObject({ op: 'paint_pop', mode: 'value', dimension: dim.id, value: val.id, amount: 0.4 });
    // 发出去的命令 core 照样认
    const eng = peopled();
    for (const call of vi.mocked(exec).mock.calls) eng.exec(call[0] as Command);
  });

  it('没有人文：画笔说“先生成人文”，松手不发命令', async () => {
    const w = continents().world;
    world.value = w;
    const c = dry(w)[0];
    const t = popTool();
    const p = pointer(w, c);
    t.move?.(p, false);
    t.down?.(p);
    expect(t.preview().hint).toBe('先生成人文');
    await t.up?.(p);
    expect(exec).not.toHaveBeenCalled();
  });

  it('Alt+点：文化笔刷吸取占多数的文化，人口笔刷吸取最多的群体（改一个维度时吸取那一维）', () => {
    const w = peopled().world;
    const c = inhabited(w)[0];
    const culture = worldCultures(w.small)[w.derived.popCulture![c] - 1];
    expect(TOOL_DEFS.culture.pick!(w, c)).toBe(culture.name);
    expect(options.value.culture).toBe(culture.id);
    const top = readComp(w.causes, c).find((x) => x.code)!;
    expect(TOOL_DEFS.pop.pick!(w, c)).toContain(w.small.popGroups![top.code].culture === culture.id ? culture.name : '');
    expect(options.value.popTuple).toEqual(w.small.popGroups![top.code]);
    setOptions({ popMode: 'value' });
    expect(TOOL_DEFS.pop.pick!(w, c)).toBeTruthy();
    expect(options.value.popValue).toBeTruthy();
    expect(TOOL_DEFS.pop.pick!(w, w.causes.land.indexOf(0))).toBeNull();
  });

  it('发源地：每个文化组、组里的文化各一个，圈在地图上；拖到别的陆地发 move_hearth（锁定的另画一圈）', async () => {
    const w = peopled().world;
    world.value = w;
    const marks = hearthMarks(w);
    expect(marks.filter((m) => !m.culture).length).toBeGreaterThanOrEqual(GROUPS.length);
    expect(marks.filter((m) => m.culture).length).toBe(BUILTIN_CULTURES.filter((c) => GROUPS.some((g) => g.id === c.group)).length);
    expect(hearthCommand(marks[0], 7)).toEqual({ op: 'move_hearth', group: marks[0].group, cell: 7 });
    const cm = marks.find((m) => m.culture)!;
    expect(hearthCommand(cm, null)).toEqual({ op: 'move_hearth', culture: cm.culture, cell: null });
    const zoom = () => 1 / w.mesh.spacing;
    const t = hearthTool(zoom);
    expect(t.backdrop!()!.shapes.length).toBe(marks.length * 2);
    const m = marks[0];
    const to = dry(w).find((i) => i !== m.cell && Math.abs(w.mesh.x[i] - w.mesh.x[m.cell]) > 5 * w.mesh.spacing)!;
    t.move!(pointer(w, m.cell), false);
    expect(t.drags).toBe(true);
    expect(t.preview().hint).toContain(m.name);
    t.down!(pointer(w, m.cell));
    t.move!(pointer(w, to), true);
    expect(t.preview().hint).toBe(`挪动发源地“${m.name}”`);
    await t.up!(pointer(w, to));
    const cmd = vi.mocked(exec).mock.calls.at(-1)![0] as Command;
    expect(cmd).toEqual(hearthCommand(m, to));
    // 执行之后锁定：多画一道圈
    const eng = peopled();
    eng.exec(cmd);
    const t2 = hearthTool(zoom);
    world.value = eng.world;
    expect(hearthMarks(eng.world).find((x) => x.key === m.key)!.locked).toBe(true);
    expect(t2.backdrop!()!.shapes.length).toBe(marks.length * 2 + 1);
    // 离开发源地：不拖（按住拖动是平移地图）
    t2.move!(pointer(eng.world, dry(eng.world).find((i) => hearthMarks(eng.world).every((x) => Math.hypot(w.mesh.x[i] - w.mesh.x[x.cell], w.mesh.y[i] - w.mesh.y[x.cell]) > 30 * w.mesh.spacing)) ?? 0), false);
    expect(t2.drags).toBe(false);
  });
});

describe('人文的底图与图例', () => {
  it('图层：没有人文时只有宜居度；有时是文化圈、时代的每一维、人口密度、宜居度', () => {
    const plain = continents().world;
    expect(humanViews(plain).map((v) => v.id)).toEqual(['habitability']);
    expect(viewAvailable(plain, 'culture')).toBe(false);
    expect(viewAvailable(plain, 'habitability')).toBe(true);
    const w = peopled().world;
    const dims = worldDimensions(w.small);
    expect(humanViews(w).map((v) => v.id)).toEqual(['culture', ...dims.map((d) => `dim:${d.id}`), 'popDensity', 'habitability']);
    expect(humanViews(w).find((v) => v.id === `dim:${dims[0].id}`)!.label).toBe(dims[0].label);
    expect(viewAvailable(w, 'dim:nothing')).toBe(false);
    expect(viewAvailable(w, 'cultureGroup')).toBe(true);
  });

  it('文化圈、每一维平涂在地貌上（没有人的格不着色）；宜居度、人口密度是色带；文化的颜色进着色的键', () => {
    const w = peopled().world;
    const c = inhabited(w)[0];
    const flat = humanFlat(w, 'culture');
    const culture = worldCultures(w.small)[w.derived.popCulture![c] - 1];
    const hex = `#${[0, 1, 2].map((k) => flat[c * 4 + k].toString(16).padStart(2, '0')).join('')}`;
    expect(hex).toBe(culture.color.toLowerCase());
    const sea = w.causes.land.indexOf(0);
    expect(flat[sea * 4 + 3]).toBe(0);
    const dim = worldDimensions(w.small)[0];
    expect(humanFlat(w, `dim:${dim.id}`)[c * 4 + 3]).toBeGreaterThan(0);
    for (const m of ['culture', 'cultureGroup', `dim:${dim.id}`] as const) expect(cellLayers(w, { mode: m, season: 'annual', focusSpecies: null, borders: false }).flat).not.toBeNull();
    for (const m of ['habitability', 'popDensity'] as const) {
      const l = cellLayers(w, { mode: m, season: 'annual', focusSpecies: null, borders: false });
      expect(l.flat).toBeNull();
      expect(l.shade).toBeLessThan(1);
    }
    expect(colorSignature(w.small)).not.toBe(colorSignature(continents().world.small));
  });

  it('图例：文化、文化组、每一维按人数（占总人口的比例）；宜居度、人口密度是几档；没有人文时没有', () => {
    const eng = peopled();
    const w = eng.world;
    const cul = legendFor(w, 'culture')!;
    expect(cul.title).toBe('文化');
    expect(cul.items.map((x) => x.label)).toEqual(humanLegend(w, 'culture').map((x) => x.name));
    for (let k = 1; k < cul.items.length; k++) expect(cul.items[k].count!).toBeLessThanOrEqual(cul.items[k - 1].count!);
    expect(legendFor(w, 'cultureGroup')!.items.length).toBe(GROUPS.length);
    const dim = worldDimensions(w.small)[0];
    expect(legendFor(w, `dim:${dim.id}`)!.title).toBe(dim.label);
    expect(legendFor(w, 'habitability')!.items.length).toBe(5);
    expect(legendFor(w, 'popDensity')!.items.every((x) => x.count === undefined)).toBe(true);
    const plain = continents().world;
    expect(legendFor(plain, 'culture')).toBeNull();
    expect(legendFor(plain, 'popDensity')).toBeNull();
    expect(legendFor(plain, 'habitability')).not.toBeNull();
    // 同一个世界同一份；画了人数，图例跟着变
    expect(legendFor(w, 'culture')).toBe(cul);
    eng.exec({ op: 'paint_pop', cells: inhabited(w).slice(0, 200), mode: 'count', factor: 10 });
    expect(legendFor(eng.world, 'culture')).not.toBe(cul);
  });

  it('“这里”的一行：有人文时写占多数的文化与人数', () => {
    const w = peopled().world;
    const c = inhabited(w)[0];
    const culture = worldCultures(w.small)[w.derived.popCulture![c] - 1];
    expect(hereLine(w, c)).toContain(`${culture.name} `);
    expect(hereLine(w, c)).toMatch(/ 人 · 年均/);
    expect(hereLine(continents().world, c)).not.toContain(' 人 · ');
  });
});

describe('格的档案里的人口', () => {
  it('人数：认得 5000、12,000、3.2万、1.5 亿；没变、认不出时不发', () => {
    expect(parsePeople('5000')).toBe(5000);
    expect(parsePeople('12,000')).toBe(12000);
    expect(parsePeople('3.2万')).toBe(32000);
    expect(parsePeople('1.5 亿')).toBe(150000000);
    expect(parsePeople('abc')).toBeNull();
    expect(cellTotalCommand(3, '2万', 1000)).toEqual({ op: 'set_cell_pop', cell: 3, total: 20000 });
    expect(cellTotalCommand(3, '1000', 1000)).toBeNull();
    expect(cellTotalCommand(3, '很多', 1000)).toBeNull();
  });

  it('去掉、加上一群，改占比：都是 set_cell_pop 的 groups，core 照样认；“其他”不变或按比例', () => {
    const eng = peopled();
    const w = eng.world;
    const cell = inhabited(w).find((i) => readComp(w.causes, i).filter((x) => x.code).length >= 2)!;
    const a = cellArchive(w, cell);
    const rows = popRows(a.population!);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const rm = removeGroupCommand(cell, rows, 0) as Extract<Command, { op: 'set_cell_pop' }>;
    expect(rm.groups!.length).toBe(rows.length - 1);
    const before = rows.reduce((s, r) => s + r.share, 0);
    expect(rm.groups!.reduce((s, g) => s + g.share, 0)).toBeCloseTo(before, 2);
    eng.exec(rm);
    expect(cellArchive(eng.world, cell).population!.manual).toBe(true);
    const other = worldCultures(w.small).find((c) => !rows.some((r) => r.culture === c.id))!;
    const add = addGroupCommand(cell, popRows(cellArchive(eng.world, cell).population!), { culture: other.id, values: {} }) as Extract<Command, { op: 'set_cell_pop' }>;
    expect(add.groups!.some((g) => g.culture === other.id && g.share === 0.25)).toBe(true);
    eng.exec(add);
    expect(cellArchive(eng.world, cell).population!.groups.some((g) => g.culture?.id === other.id)).toBe(true);
    const rows2 = popRows(cellArchive(eng.world, cell).population!);
    const sh = groupShareCommand(cell, rows2, 0, 0.9) as Extract<Command, { op: 'set_cell_pop' }>;
    expect(sh.groups![0].share).toBe(0.9);
    expect(groupShareCommand(cell, rows2, 0, rows2[0].share)).toBeNull();
    eng.exec(sh);
    expect(cellArchive(eng.world, cell).population!.groups[0].share).toBeGreaterThan(0.85);
  });
});

describe('仓库与“文化 ⋯”', () => {
  it('仓库里有时代、人口维度的取值、文化组、文化；取值按维度分段，文化按文化组分段', () => {
    const ids = repoKinds().map((k) => k.id);
    for (const k of ['era', 'popValue', 'cultureGroup', 'culture']) expect(ids).toContain(k);
    const w = peopled().world;
    const values = repoRows(kindOf('popValue')!, w, []);
    const dims = new Map([[worldDimensions(w.small)[0].id, worldDimensions(w.small)[0].label]]);
    const secs = repoSections(kindOf('popValue')!, values, { dims, groups: new Map() });
    expect(secs.find((s) => s.label === worldDimensions(w.small)[0].label)!.rows.length).toBeGreaterThan(0);
    const cultures = repoRows(kindOf('culture')!, w, []);
    const groups = new Map(groupChoices(w.small).map((g) => [g.id, g.name]));
    const cs = repoSections(kindOf('culture')!, cultures, { dims, groups });
    expect(cs.map((s) => s.label)).toEqual(expect.arrayContaining(['西欧']));
    expect(cs.reduce((n, s) => n + s.rows.length, 0)).toBe(cultures.length);
    expect(repoSections(kindOf('era')!, repoRows(kindOf('era')!, w, []), { dims, groups })).toHaveLength(1);
  });

  it('换时代、文化组重新生成：regenerate_human（同一个时代保留手改的）；没变时没有命令', () => {
    const w = peopled().world;
    const c = defaultChoice(w.small);
    expect(c).toMatchObject({ era: 'medieval', pop: null });
    expect(c.groups).toEqual(GROUPS);
    expect(regenerateWith(c, w.small)).toBeNull();
    const less = toggleGroup(c, 'steppe', false);
    expect(lastOf(regenerateWith(less, w.small)!)).toEqual({ op: 'regenerate_human', packs: [['medieval']], groups: GROUPS.slice(0, 2), keepManual: true });
    const eng = peopled();
    eng.exec(regenerateWith(less, w.small)!);
    expect(eng.world.small.human!.groups.map((g) => g.id)).toEqual(['western', 'eastern']);
  });
});
