import { describe, expect, it, vi } from 'vitest';
import { shiftColor } from '../../core/endemic';
import { brushCells } from '../../core/select';
import { continents, engineFor } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { options, setOptions, world } from '../state';
import { climateHere, climateMask, editLayers, natureHere, natureMask, terrainHere, terrainMask, waterMask } from './edits';
import { type Pointer, climateEraseTool, endemicTool, eraseTool, restoreTool } from './tools';

// 我改过的地方：橡皮擦先标出能擦的格、悬停说这里改过什么；岛上特有只描岛、说清会怎样

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
});

describe('岛上特有', () => {
  const archipelago = () => {
    const eng = engineFor({ cells: 12000, seed: 1, latNorth: 30, latSouth: 0 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'archipelago' }, reset: true });
    return eng;
  };

  it('只描岛，大陆不描；悬停写出岛上哪种生态换成哪一种，涂上新的颜色', () => {
    const w = archipelago().world;
    world.value = w;
    const t = endemicTool();
    const back = t.backdrop?.();
    const outline = back!.layers[0];
    expect(outline.pattern).toBe('outline');
    const islands = new Set(w.derived.features.filter((f) => f.type === 'island').flatMap((f) => Array.from(f.cells)));
    expect(new Set(outline.cells)).toEqual(islands);
    const island = w.derived.features.filter((f) => f.type === 'island').sort((a, b) => b.cells.length - a.cells.length)[0];
    t.move?.(at(w, island.anchor), false);
    const pv = t.preview();
    expect(pv.hint).toMatch(new RegExp(`^「${island.name}」：.+ → ${island.name}.+（新的一种生态，只长在这个岛上）$`));
    expect(pv.layers[0].cells.length).toBeGreaterThan(0);
  });

  it('已有的岛：点一下选中（不换画笔），可以去掉；自然的擦除悬停时说在哪里去掉', async () => {
    const eng = archipelago();
    const w0 = eng.world;
    world.value = w0;
    const island = w0.derived.features.filter((f) => f.type === 'island').sort((a, b) => b.cells.length - a.cells.length)[0];
    const t0 = endemicTool();
    t0.move?.(at(w0, island.anchor), false);
    const { exec } = await import('../state');
    vi.mocked(exec).mockClear();
    await t0.click?.(at(w0, island.anchor));
    const cmd = vi.mocked(exec).mock.calls[0][0];
    expect(cmd.op).toBe('add_species');
    eng.exec(cmd);
    const w = eng.world;
    world.value = w;
    const sp = w.small.species.find((s) => s.id === `endemic_${island.anchor}`)!;
    const biome = options.value.biome;
    const t = endemicTool();
    t.move?.(at(w, island.anchor), false);
    expect(t.preview().hint).toBe(`已有：${sp.name}（点一下，在下面去掉它）`);
    await t.click?.(at(w, island.anchor));
    expect(options.value.biome).toBe(biome);
    const { endemicPicked, removePickedEndemic } = await import('./tools');
    expect(endemicPicked.value).toEqual({ anchor: island.anchor, id: sp.id });
    vi.mocked(exec).mockClear();
    await removePickedEndemic();
    expect(vi.mocked(exec).mock.calls[0][0]).toEqual({ op: 'remove_species', id: sp.id });
    const e = eraseTool();
    e.move?.(at(w, island.anchor), false);
    expect(e.preview().hint).toBe(`「${sp.name}」是岛上特有的：点“岛上特有”，再点这个岛去掉它`);
  });

  it('新的特有生态颜色明显偏开：色相转 40°，明暗差一截', () => {
    const hsl = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return [h * 60, (max + min) / 2];
    };
    for (const c of ['#4f7d5c', '#6a9e55', '#c2bd7c', '#2c7d3f', '#e3d3a0']) {
      for (const salt of [0, 1]) {
        const [h0, l0] = hsl(c);
        const [h1, l1] = hsl(shiftColor(c, salt));
        const dh = Math.min(Math.abs(h1 - h0), 360 - Math.abs(h1 - h0));
        expect(dh).toBeGreaterThan(30);
        expect(Math.abs(l1 - l0)).toBeGreaterThan(0.1);
      }
    }
  });
});
