import { describe, expect, it, vi } from 'vitest';
import { landmassCells } from '../../core/vegetation';
import { brushCells } from '../../core/select';
import { continents, engineFor } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { paintNote, setOptions, world } from '../state';
import { climateHere, climateMask, editLayers, natureHere, natureMask, terrainHere, terrainMask, waterMask } from './edits';
import { type Pointer, climateEraseTool, eraseTool, rangePick, rangeTool, restoreTool } from './tools';

// 我改过的地方：橡皮擦先标出能擦的格、悬停说这里改过什么；选生态的范围：点岛、圈一片

vi.mock('../state', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../state')>();
  return { ...mod, exec: vi.fn(async () => true) };
});

const at = (w: World, c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 10, sy: 20, shift: false, alt: false });
const inland = (w: World) => [...Array(w.mesh.n).keys()].find((i) => i % 5 === 0 && w.causes.land[i] && w.derived.elevation[i] > 300)!;

describe('能擦的格', () => {
  it('没改过的世界：三种都是空的，橡皮擦悬停说没改过、不画斜线', () => {
    const w = continents().world;
    world.value = w;
    expect(terrainMask(w).cells).toEqual([]);
    expect(climateMask(w).cells).toEqual([]);
    expect(natureMask(w).cells).toEqual([]);
    expect(waterMask(w).cells).toEqual([]);
    expect(editLayers(w)).toEqual([]);
    const t = restoreTool();
    t.move?.(at(w, inland(w)), false);
    expect(t.preview().hint).toBe('这里没改过');
    expect(t.backdrop?.()?.layers ?? []).toEqual([]);
  });

  it('堆山：标出看得出的改动，笔边上很淡的零头不标；悬停写出约升高多少', () => {
    const eng = continents();
    const w0 = eng.world;
    const c = inland(w0);
    const b = brushCells(w0, w0.mesh.x[c], w0.mesh.y[c], 6 * w0.mesh.spacing * w0.kmPerUnit);
    eng.exec({ op: 'paint_relief', cells: b.cells, t: b.t, strength: 1 });
    const w = eng.world;
    world.value = w;
    const m = terrainMask(w);
    // 同一份数组：同一个结果（不重算）
    expect(terrainMask(w)).toBe(m);
    const touched = b.cells.filter((i) => w.causes.upliftDelta[i] !== 0);
    expect(m.cells.length).toBeGreaterThan(0);
    expect(m.cells.length).toBeLessThan(touched.length);
    for (const i of m.cells) expect(Math.abs(w.causes.upliftDelta[i])).toBeGreaterThanOrEqual(0.02);
    expect(terrainHere(w, [c])).toMatch(/^这里：堆过山（约 \+[\d,]+ m）$/);
    setOptions({ brushKm: 2 * w.mesh.spacing * w.kmPerUnit });
    const t = restoreTool();
    t.move?.(at(w, c), false);
    expect(t.preview().hint).toMatch(/^这里：堆过山/);
    const back = t.backdrop?.();
    expect(back?.layers[0]).toMatchObject({ pattern: 'hatch', cells: m.cells });
    // 鼠标不在地图上也一直画着；同一个对象，不必重新上传
    t.leave?.();
    expect(t.backdrop?.()).toBe(back);
  });

  it('画陆地写“画过陆地”，重画过的范围画成虚线圈', () => {
    const eng = continents();
    const w0 = eng.world;
    const c = [...Array(w0.mesh.n).keys()].find((i) => i % 7 === 0 && !w0.causes.land[i] && !w0.mesh.boundary[i])!;
    const b = brushCells(w0, w0.mesh.x[c], w0.mesh.y[c], 4 * w0.mesh.spacing * w0.kmPerUnit);
    eng.exec({ op: 'paint_land', cells: b.cells, t: b.t, mode: 'land' });
    eng.exec({ op: 'reroll_region', x: 0.3, y: 0.4, radius: 0.05, variant: 1 });
    const w = eng.world;
    world.value = w;
    expect(terrainHere(w, [c])).toBe('这里：画过陆地');
    const back = restoreTool().backdrop?.();
    expect(back?.shapes).toEqual([expect.objectContaining({ kind: 'circle', x: 0.3, y: 0.4, r: 0.05, dashed: true })]);
  });

  it('冷暖干湿：写出更冷多少度、更湿多少', () => {
    const eng = continents();
    const w0 = eng.world;
    const c = inland(w0);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: [c], values: [-3], mode: 'add' });
    eng.exec({ op: 'paint', field: 'moistOffset', cells: [c], values: [Math.log(1.4)], mode: 'add' });
    const w = eng.world;
    world.value = w;
    expect(climateMask(w).cells).toEqual([c]);
    expect(climateHere(w, [c])).toBe('这里：更冷 −3 °C、更湿（雨水 +40%）');
    const t = climateEraseTool();
    expect(t.backdrop?.()?.layers[0]).toMatchObject({ pattern: 'hatch', cells: [c] });
  });

  it('涂过的生态：写出涂成了什么；图层里四种分色', () => {
    const eng = continents();
    const w0 = eng.world;
    const c = inland(w0);
    eng.exec({ op: 'add_constraint', constraint: { cells: [c, c + 1], species: 'desert', mode: 'constraint' } });
    const w = eng.world;
    world.value = w;
    expect(natureMask(w).cells).toEqual([c, c + 1].sort((a, b) => a - b));
    expect(natureHere(w, [c])).toBe('这里：涂成了荒漠');
    expect(natureHere(w, [c + 5000])).toBe('这里没涂过');
    const t = eraseTool();
    setOptions({ brushKm: 0.2 * w.mesh.spacing * w.kmPerUnit });
    t.move?.(at(w, c), false);
    expect(t.preview().hint).toBe('这里：涂成了荒漠');
    expect(editLayers(w).map((l) => l.color)).toHaveLength(1);
  });

  it('自然融入涂了却没长出来：悬停说“涂过……（没长成）”，结果说几格变了、几格没涂成', () => {
    const eng = continents();
    const w0 = eng.world;
    const c = inland(w0);
    const near = [...Array(w0.mesh.n).keys()].filter((i) => w0.causes.land[i] && Math.hypot(w0.mesh.x[i] - w0.mesh.x[c], w0.mesh.y[i] - w0.mesh.y[c]) < 0.03);
    eng.exec({ op: 'add_constraint', constraint: { cells: near, species: 'rainforest', mode: 'constraint' } });
    const w = eng.world;
    const name = w.small.species.find((s) => s.id === 'rainforest')!.name;
    const k = w.small.species.findIndex((s) => s.id === 'rainforest');
    // 这里长不了热带雨林（这个世界在北纬 20°–72°）
    expect(near.some((i) => w.derived.dominant[i] === k)).toBe(false);
    expect(natureHere(w, [c])).toBe(`这里：涂过${name}（没长成）`);
    const note = paintNote(w0, w)!;
    expect(note).toMatch(new RegExp(`^${name}：(生态没变|\\d+ 格变了) · ${near.length} 格没涂成（这里长不了）$`));
    // 长出来了的照旧说“涂成了”，结果不说没涂成
    const e2 = continents();
    e2.exec({ op: 'add_constraint', constraint: { cells: near, species: 'desert', mode: 'constraint' } });
    const desert = e2.world.small.species.find((s) => s.id === 'desert')!.name;
    expect(natureHere(e2.world, [c])).toBe(`这里：涂成了${desert}`);
    expect(paintNote(w0, e2.world)).toMatch(new RegExp(`^${desert}：\\d+ 格变了（自然融入）$`));
  });
});

describe('选生态的范围（第十二轮，替代岛上特有）', () => {
  const archipelago = () => {
    const eng = engineFor({ cells: 12000, seed: 1, latNorth: 30, latSouth: 0 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'archipelago' }, reset: true });
    return eng;
  };

  it('点岛：悬停涂白那块陆地、写成“岛名（群岛名）”；点了是 update_species 的 range（岛），然后回到原来的工具', async () => {
    const eng = archipelago();
    const w = eng.world;
    world.value = w;
    const arch = w.derived.features.find((f) => f.type === 'archipelago' && f.name)!;
    const inArch = new Set(Array.from(arch.cells));
    const island = w.derived.features.find((f) => f.type === 'island' && inArch.has(f.anchor) && f.name !== arch.name)!;
    expect(island).toBeTruthy();
    rangePick.value = { species: 'desert', kind: 'island', back: 'biome' };
    const t = rangeTool();
    t.move?.(at(w, island.anchor), false);
    const pv = t.preview();
    expect(pv.hint).toContain(`「${island.name}（${arch.name}）」`);
    const mass = landmassCells(w, island.anchor);
    expect(pv.layers[0].cells.length).toBe(mass.reduce((a, b) => a + b, 0));
    const { exec } = await import('../state');
    vi.mocked(exec).mockClear();
    await t.click?.(at(w, island.anchor));
    expect(vi.mocked(exec).mock.calls[0][0]).toEqual({ op: 'update_species', id: 'desert', patch: { range: { kind: 'island', cell: island.anchor } } });
    expect(rangePick.value).toBeNull();
  });

  it('圈一片：松手后是圈里的陆地格', async () => {
    const eng = archipelago();
    const w = eng.world;
    world.value = w;
    const c = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && w.mesh.x[i] > 0.3 && w.mesh.y[i] > 0.3)!;
    const s = w.mesh.spacing * 6;
    const [x, y] = [w.mesh.x[c], w.mesh.y[c]];
    rangePick.value = { species: 'desert', kind: 'cells', back: 'biome' };
    const t = rangeTool();
    const pts: [number, number][] = [[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]];
    t.down?.({ ...at(w, c), x: pts[0][0], y: pts[0][1] });
    for (const [px, py] of pts.slice(1)) t.move?.({ ...at(w, c), x: px, y: py }, true);
    const { exec } = await import('../state');
    vi.mocked(exec).mockClear();
    await t.up?.({ ...at(w, c), x: pts[3][0], y: pts[3][1] });
    const cmd = vi.mocked(exec).mock.calls[0][0] as { op: string; patch: { range: { kind: string; cells: number[] } } };
    expect(cmd.op).toBe('update_species');
    expect(cmd.patch.range.kind).toBe('cells');
    expect(cmd.patch.range.cells).toContain(c);
    expect(cmd.patch.range.cells.every((i) => w.causes.land[i] === 1)).toBe(true);
  });
});
