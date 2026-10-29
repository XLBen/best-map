import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { kindOf } from '../../core/content/registry';
import { cellArchive, classAt, peakCells, peakMarks, resourceAt } from '../../core/human';
import { brushCells } from '../../core/select';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { cellLayers, humanFlat } from '../render/colors';
import { PEAK_KEY, peakLabels } from '../render/overlay';
import { exec, mode, options, setOptions, world } from '../state';
import { autoNameCommand, cellClassCommand, cellResourceCommand, noteCommand, renameCommand, rerollCommand } from './archive';
import { TOOL_DEFS, setTool } from './defs/tools';
import { legendFor } from './legend';
import { addedValue, isSparse, sparseSplit } from './packs/fields';
import { editStart, repoRows, toggleCommand } from './packs/repo';
import { RULE_FIELDS } from '../../core/human/rules';
import { type Pointer, dryLand, resourceTool, terrainClassTool } from './tools';
import { BUILTIN_CLASSES, FANTASY_RESOURCES, GENERAL_RESOURCES } from '../../core/packs/base';

// 第二十一轮的界面：地形类别、资源的底图与图例，山峰图层，两支画笔，格的档案，仓库里总在的内置项

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true) }));

afterEach(() => {
  setTool('land');
  mode.value = 'terrain';
  vi.mocked(exec).mockClear();
});

const dry = (w: World) => Array.from({ length: w.mesh.n }, (_, i) => i).filter((i) => dryLand(w, i));

describe('底图与图例', () => {
  it('地形类别底图：干的陆地平涂类别的颜色，水面不着色；资源底图里没有资源的陆地是灰的', () => {
    const w = continents().world;
    const flat = humanFlat(w, 'terrainClass');
    const land = dry(w);
    const i = land[0];
    const c = classAt(w.small, w.derived.terrainClass[i])!;
    const hex = `#${[0, 1, 2].map((k) => flat[i * 4 + k].toString(16).padStart(2, '0')).join('')}`;
    expect(hex).toBe(c.color.toLowerCase());
    const sea = w.causes.land.indexOf(0);
    expect(flat[sea * 4 + 3]).toBe(0);
    const res = humanFlat(w, 'resource');
    const none = land.find((j) => !resourceAt(w.small, w.derived.resource[j]))!;
    expect(res[none * 4 + 3]).toBeGreaterThan(0);
    expect(res[sea * 4 + 3]).toBe(0);
    // 底图走 cellLayers：有平涂层、不画生态的花纹
    const layers = cellLayers(w, { mode: 'terrainClass', season: 'annual', focusSpecies: null, borders: false });
    expect(layers.flat).not.toBeNull();
    expect(layers.fx).toBeNull();
  });

  it('图例：只列世界里有的，按格数从多到少；资源的“无”排在最后；别的底图没有图例', () => {
    const eng = continents();
    const w = eng.world;
    const land = dry(w).length;
    const tc = legendFor(w, 'terrainClass')!;
    expect(tc.title).toBe('地形类别');
    expect(tc.items.length).toBeGreaterThan(3);
    expect(tc.items.length).toBeLessThanOrEqual(BUILTIN_CLASSES.length);
    expect(tc.items.reduce((a, it) => a + (it.count ?? 0), 0)).toBe(land);
    for (let k = 1; k < tc.items.length; k++) expect(tc.items[k].count!).toBeLessThanOrEqual(tc.items[k - 1].count!);
    const res = legendFor(w, 'resource')!;
    expect(res.items.at(-1)!.label).toBe('无');
    expect(res.items.reduce((a, it) => a + (it.count ?? 0), 0)).toBe(land);
    expect(res.items.some((it) => FANTASY_RESOURCES.some((r) => r.name === it.label))).toBe(false);
    expect(legendFor(w, 'dominant')!.items.length).toBeGreaterThan(1);
    expect(legendFor(w, 'terrain')).toBeNull();
    expect(legendFor(w, 'provinces')).toBeNull();
    // 同一份数组：同一个结果；画了一片山峰，图例跟着变
    expect(legendFor(w, 'terrainClass')).toBe(tc);
    const cells = dry(w).slice(0, 40);
    eng.exec({ op: 'set_cell_class', cells, class: 'peaks' });
    const after = legendFor(eng.world, 'terrainClass')!;
    expect(after.items.find((it) => it.label === '山峰')!.count).toBeGreaterThanOrEqual(40);
    // 第二十七轮：只有起伏的 5 种
    expect(after.items.map((it) => it.label).sort()).toEqual(['丘陵', '山地', '山峰', '平原', '高原'].sort());
  });

  it('山峰图层：全部山峰当作地名排（键带前缀、不是地物），同一个世界给同一份', () => {
    const w = continents().world;
    const list = peakLabels(w);
    expect(list.length).toBe(peakMarks(w).length);
    expect(list.length).toBeGreaterThanOrEqual(peakCells(w).length);
    expect(list.every((f) => f.key.startsWith(PEAK_KEY) && f.type === 'peak' && f.name)).toBe(true);
    expect(peakLabels(w)).toBe(list);
  });
});

describe('画地形类别、资源', () => {
  const pointer = (w: World, c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift: false, alt: false });

  it('工具表：地形类、自然类里各一支画笔；开着时底图换成它那一层，离开时换回原来的', () => {
    expect(TOOL_DEFS.terrainClass).toMatchObject({ category: 'terrain', view: 'terrainClass' });
    expect(TOOL_DEFS.resource).toMatchObject({ category: 'nature', view: 'resource' });
    mode.value = 'elevation';
    setTool('terrainClass');
    expect(mode.value).toBe('terrainClass');
    setTool('resource');
    expect(mode.value).toBe('resource');
    setTool('biome');
    expect(mode.value).toBe('elevation');
    // 开着时在图层里换了底图：离开时不动
    setTool('terrainClass');
    mode.value = 'precip';
    setTool('land');
    expect(mode.value).toBe('precip');
  });

  it('按住涂：只涂干的陆地，命令是 set_cell_class / set_cell_resource；“恢复自动”是 null，“无”是 none', async () => {
    const eng = continents();
    const w = eng.world;
    world.value = w;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    const c = dry(w).find((i) => brushCells(w, w.mesh.x[i], w.mesh.y[i], 2 * cellKm).cells.some((j) => !w.causes.land[j]))!;
    setOptions({ brushKm: 2 * cellKm, terrainClass: 'highlands', resource: 'none' });
    const paint = async (t: ReturnType<typeof terrainClassTool>) => {
      const p = pointer(w, c);
      t.move?.(p, false);
      t.down?.(p);
      await t.up?.(p);
      return vi.mocked(exec).mock.calls.at(-1)![0] as Command & { cells: number[] };
    };
    const a = await paint(terrainClassTool());
    expect(a).toMatchObject({ op: 'set_cell_class', class: 'highlands' });
    expect(a.cells.length).toBeGreaterThan(0);
    expect(a.cells.every((i) => dryLand(w, i))).toBe(true);
    expect((await paint(resourceTool())) as Command).toMatchObject({ op: 'set_cell_resource', resource: 'none' });
    setOptions({ terrainClass: '', resource: '' });
    expect((await paint(terrainClassTool())) as Command).toMatchObject({ op: 'set_cell_class', class: null });
    expect((await paint(resourceTool())) as Command).toMatchObject({ op: 'set_cell_resource', resource: null });
  });

  it('Alt+点吸取：类别、资源（没有资源吸取“无”），水面吸取不到', () => {
    const w = continents().world;
    const land = dry(w);
    const i = land[0];
    expect(TOOL_DEFS.terrainClass.pick!(w, i)).toBe(classAt(w.small, w.derived.terrainClass[i])!.name);
    expect(options.value.terrainClass).toBe(classAt(w.small, w.derived.terrainClass[i])!.id);
    const none = land.find((j) => !resourceAt(w.small, w.derived.resource[j]))!;
    expect(TOOL_DEFS.resource.pick!(w, none)).toBe('无');
    expect(options.value.resource).toBe('none');
    const has = land.find((j) => resourceAt(w.small, w.derived.resource[j]))!;
    expect(TOOL_DEFS.resource.pick!(w, has)).toBe(resourceAt(w.small, w.derived.resource[has])!.name);
    expect(TOOL_DEFS.resource.pick!(w, w.causes.land.indexOf(0))).toBeNull();
  });
});

describe('格的档案', () => {
  it('普通的格：改名（带原文）、换一个、恢复自动、备注都是 set_cell；没变时不发', () => {
    const eng = continents();
    const w = eng.world;
    const cell = dry(w).find((i) => !w.derived.peak[i])!;
    let a = cellArchive(w, cell);
    expect(renameCommand(a, a.name)).toEqual({ op: 'set_cell', cell, name: a.name });
    expect(renameCommand(a, '  ')).toBeNull();
    expect(autoNameCommand(a)).toBeNull();
    const cmd = renameCommand(a, '石门', 'Shimen')!;
    expect(cmd).toEqual({ op: 'set_cell', cell, name: '石门', orig: 'Shimen' });
    eng.exec(cmd);
    a = cellArchive(eng.world, cell);
    expect(a).toMatchObject({ name: '石门', orig: 'Shimen', custom: true });
    expect(renameCommand(a, '石门', 'Shimen')).toBeNull();
    eng.exec(autoNameCommand(a)!);
    a = cellArchive(eng.world, cell);
    expect(a.custom).toBe(false);
    expect(rerollCommand(a)).toEqual({ op: 'set_cell', cell, reroll: true });
    eng.exec(rerollCommand(a));
    const salt = eng.world.small.cells?.[cell]?.salt ?? 0;
    expect(salt).toBe(1);
    // 换过名字也能恢复自动（盐回到 0，档案里一项都不剩）
    eng.exec(autoNameCommand(cellArchive(eng.world, cell), salt)!);
    expect(eng.world.small.cells?.[cell]).toBeUndefined();
    expect(noteCommand(cell, '  ', undefined)).toBeNull();
    eng.exec(noteCommand(cell, '古驿道', undefined)!);
    expect(cellArchive(eng.world, cell).note).toBe('古驿道');
    expect(noteCommand(cell, '古驿道', '古驿道')).toBeNull();
    expect(noteCommand(cell, '', '古驿道')).toEqual({ op: 'set_cell', cell, note: null });
  });

  it('山脉的主峰：改名、换一个、恢复自动走地物的命令', () => {
    const eng = continents();
    const f = eng.world.derived.features.find((x) => x.type === 'peak')!;
    const a = cellArchive(eng.world, f.anchor);
    expect(a.feature).toBeTruthy();
    expect(renameCommand(a, '天柱峰')).toEqual({ op: 'rename_feature', key: a.feature, name: '天柱峰' });
    expect(rerollCommand(a)).toEqual({ op: 'reroll_feature', key: a.feature });
    eng.exec(renameCommand(a, '天柱峰')!);
    const b = cellArchive(eng.world, f.anchor);
    expect(b.peak?.name).toBe('天柱峰');
    expect(autoNameCommand(b)).toEqual({ op: 'rename_feature', key: a.feature, name: '' });
  });

  it('地形类别、资源：一格的命令；画过的显示画的，自动的那一种照样算得出', () => {
    const eng = continents();
    const cell = dry(eng.world)[5];
    expect(cellClassCommand(cell, 'hills')).toEqual({ op: 'set_cell_class', cells: [cell], class: 'hills' });
    expect(cellResourceCommand(cell, null)).toEqual({ op: 'set_cell_resource', cells: [cell], resource: null });
    const auto = cellArchive(eng.world, cell).terrainClass!.id;
    eng.exec(cellClassCommand(cell, auto === 'hills' ? 'highlands' : 'hills'));
    const a = cellArchive(eng.world, cell);
    expect(a.terrainClass).toMatchObject({ auto: false, autoId: auto });
    // 地形一行写“起伏 · 生态”
    expect(a.terrainLabel).toBe(`${a.terrainClass!.name} · ${a.biome!.name}`);
    eng.exec(cellResourceCommand(cell, 'gold'));
    expect(cellArchive(eng.world, cell)).toMatchObject({ resource: { id: 'gold' }, resourceAuto: false });
  });
});

describe('仓库：基础的内容（第三十轮起是普通内容）', () => {
  const classKind = kindOf('terrainClass')!;
  const resKind = kindOf('resource')!;

  it('内置的地形类别：新世界从“通用 ▸ 基础”加进来，开着、能移出；编辑的是世界里那一份', () => {
    const eng = continents();
    const row = () => repoRows(classKind, eng.world, []).find((r) => r.id === 'mountains')!;
    expect(row().status).toMatchObject({ on: true, worldId: 'mountains' });
    expect(row().status.always).toBeUndefined();
    expect(editStart(row(), eng.world)).toEqual(row().item);
    const changed = { ...BUILTIN_CLASSES.find((c) => c.id === 'mountains')!, color: '#123456' };
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'mountains', item: changed });
    // 改过的那一份另列一行（这个世界里的）
    expect(repoRows(classKind, eng.world, []).some((r) => r.source === 'world' && r.id === 'mountains' && (r.item as { color: string }).color === '#123456')).toBe(true);
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: 'mountains', item: null });
    expect(row().status.on).toBe(false);
    eng.exec(toggleCommand(row(), eng.world)!);
    expect(row().status.on).toBe(true);
  });

  it('资源：通用的新世界里开着；奇幻的可以启用、停用', () => {
    const eng = continents();
    const rows = repoRows(resKind, eng.world, []);
    for (const r of GENERAL_RESOURCES) expect(rows.find((x) => x.id === r.id)!.status.on).toBe(true);
    const row = () => repoRows(resKind, eng.world, []).find((r) => r.id === 'mithril')!;
    expect(row().status).toMatchObject({ on: false });
    eng.exec(toggleCommand(row(), eng.world)!);
    expect(row().status.on).toBe(true);
    eng.exec(toggleCommand(row(), eng.world)!);
    expect(row().status.on).toBe(false);
  });
});

describe('通用编辑器：规则的条件', () => {
  it('全是可以不写的一组：只列写了的，其余从“添加”里选；加上的开关是打开的', () => {
    expect(isSparse(RULE_FIELDS)).toBe(true);
    expect(isSparse(kindOf('terrainClass')!.fields)).toBe(false);
    const { present, missing } = sparseSplit(RULE_FIELDS, { elevMin: 1100, slopeMin: 7 });
    expect(present.map((f) => f.key)).toEqual(['elevMin', 'slopeMin']);
    expect(missing.length).toBe(RULE_FIELDS.length - 2);
    expect(addedValue(RULE_FIELDS.find((f) => f.key === 'coast')!)).toBe(true);
  });
});
