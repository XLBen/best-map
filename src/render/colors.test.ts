import { describe, expect, it } from 'vitest';
import { brushCells } from '../../core/select';
import { islandStamp, landStroke, previewTerrain } from '../../core/terrain';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { type ColorOptions, GhostBuffer, cellLayers, editGhost, ghostLayers, highlightColors, provinceScale, terrainGhost } from './colors';

// 高亮的编码（着色器按 alpha 字节解码）、省界淡出用的省份大小、幽灵海岸的图层

describe('highlightColors 的 alpha 字节', () => {
  const w = continents().world;

  it('平涂 1–127、只描边 128、斜线 129–255；后面的层盖住前面的层', () => {
    const out = highlightColors(w, [
      { cells: [0, 1, 2], color: [10, 20, 30], alpha: 0.5 },
      { cells: [1], color: [40, 50, 60], pattern: 'outline' },
      { cells: [2], color: [70, 80, 90], alpha: 0.85, pattern: 'hatch' },
      // 只描边不看 alpha、values：淡到 0 也照样描
      { cells: [3], color: [255, 255, 255], alpha: 0, pattern: 'outline' },
    ])!;
    expect(Array.from(out.subarray(0, 4))).toEqual([10, 20, 30, Math.round(127 * 0.5)]);
    expect(Array.from(out.subarray(4, 8))).toEqual([40, 50, 60, 128]);
    expect(Array.from(out.subarray(8, 12))).toEqual([70, 80, 90, 128 + Math.round(127 * 0.85)]);
    expect(out[15]).toBe(128);
    // 没有高亮的格是 0
    expect(out[19]).toBe(0);
  });

  it('淡到一个字节以下的平涂、斜线不写（不会被当成只描边）', () => {
    const out = highlightColors(w, [
      { cells: [0], color: [255, 255, 255], alpha: 0.003 },
      { cells: [1], color: [255, 255, 255], alpha: 0.003, pattern: 'hatch' },
    ])!;
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(0);
  });

  it('闪烁淡出时每一步的不透明度都编成平涂（轮廓跟着它淡）', () => {
    for (let step = 1; step <= 7; step++) {
      const out = highlightColors(w, [{ cells: [5], color: [255, 236, 120], alpha: step / 40 }])!;
      const A = out[5 * 4 + 3];
      expect(A).toBeGreaterThan(0);
      expect(A).toBeLessThan(128);
    }
  });
});

describe('provinceScale', () => {
  it('省份格数中位数的平方根；没划分的格不算', () => {
    const p = Int32Array.from([-1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, -1]);
    // 省 0：4 格，省 1：9 格，省 2：1 格 → 中位数 4
    expect(provinceScale(p)).toBe(2);
  });

  it('没有省份时为 1', () => {
    expect(provinceScale(new Int32Array(10).fill(-1))).toBe(1);
  });

  it('划好省份的世界：每个省大约几格宽', () => {
    const w = continents({ provinces: true }).world;
    const s = provinceScale(w.causes.province);
    expect(s).toBeGreaterThan(2);
    expect(s).toBeLessThan(40);
  });
});

describe('幽灵海岸的图层', () => {
  const opts = (mode: ColorOptions['mode']): ColorOptions => ({ mode, season: 'annual', focusSpecies: null, borders: true });
  const cellKm = (w: World) => w.mesh.spacing * w.kmPerUnit;
  // 一格海，周围 5 格以内都是海
  const seaCell = (w: World) =>
    [...Array(w.mesh.n).keys()].find((i) => i > w.mesh.n * 0.3 && !w.causes.land[i] && brushCells(w, w.mesh.x[i], w.mesh.y[i], cellKm(w) * 5).cells.every((c) => !w.causes.land[c] && !w.mesh.boundary[c]))!;
  const coastCell = (w: World) =>
    [...Array(w.mesh.n).keys()].find((i) => i > w.mesh.n * 0.4 && w.causes.land[i] && !w.derived.lake[i] && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].some((j) => !w.causes.land[j]))!;
  // 与底子不同的格
  const differs = (w: World, base: ReturnType<typeof cellLayers>, g: ReturnType<typeof ghostLayers>) => {
    const out: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) {
      let d = !Object.is(base.coast[i], g.coast[i]) || !Object.is(base.elevation[i], g.elevation[i]);
      for (let c = 0; c < 4; c++) d ||= base.smooth[i * 4 + c] !== g.smooth[i * 4 + c] || base.other[i * 4 + c] !== g.other[i * 4 + c];
      if (base.flat) for (let c = 0; c < 4; c++) d ||= base.flat[i * 4 + c] !== g.flat![i * 4 + c];
      if (base.group) d ||= base.group[2 * i] !== g.group![2 * i] || base.group[2 * i + 1] !== g.group![2 * i + 1];
      if (d) out.push(i);
    }
    return out;
  };

  it('ghostLayers：新陆地用陆色、只改补丁格与邻格', () => {
    const w = continents({ provinces: true }).world;
    const base = cellLayers(w, opts('provinces'));
    const c = seaCell(w);
    const st = islandStamp(w, { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'volcanic', size: 2.5 * cellKm(w), variant: 0 });
    const patch = editGhost(w, base, { cells: st.cells, delta: st.landDelta });
    const g = ghostLayers(w, base, patch, 'provinces');
    const newLand = [...patch.cells].filter((i, k) => patch.land[k] && !w.causes.land[i]);
    expect(newLand.length).toBeGreaterThan(3);
    const allowed = new Set(patch.cells);
    for (const i of newLand) for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) allowed.add(w.mesh.adj[e]);
    const changed = differs(w, base, g);
    expect(changed.every((i) => allowed.has(i))).toBe(true);
    // 报给渲染器的格就是变了的格
    expect(changed.every((i) => g.cells.includes(i))).toBe(true);
    for (const i of newLand) {
      expect(g.coast[i]).toBeGreaterThan(0);
      expect(g.elevation[i]).toBeGreaterThanOrEqual(40);
      // 不再是海的颜色；平涂不画，省界不画在海域省上
      expect(Array.from(g.smooth.subarray(i * 4, i * 4 + 3))).not.toEqual(Array.from(base.smooth.subarray(i * 4, i * 4 + 3)));
      expect(g.flat![i * 4 + 3]).toBe(0);
      expect(g.group![2 * i]).toBeGreaterThanOrEqual(0);
      // 对岸的颜色：相邻水面格的平均
      const wet = [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].filter((j) => g.coast[j] <= 0);
      if (wet.length) expect(g.other[i * 4 + 2]).toBe(Math.round(wet.reduce((a, j) => a + g.smooth[j * 4 + 2], 0) / wet.length));
    }
  });

  it('画海、放湖：新海够深、新湖是水面', () => {
    const w = continents().world;
    const base = cellLayers(w, opts('terrain'));
    const c = coastCell(w);
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], 3 * cellKm(w));
    const st = landStroke(w, b.cells, b.t, 'sea');
    const sea = editGhost(w, base, { cells: st.cells, delta: st.delta });
    const g = ghostLayers(w, base, sea, 'terrain');
    const lost = [...sea.cells].filter((i, k) => !sea.land[k] && w.causes.land[i]);
    expect(lost.length).toBeGreaterThan(3);
    for (const i of lost) {
      expect(g.coast[i]).toBeLessThanOrEqual(0);
      expect(g.elevation[i]).toBeLessThanOrEqual(-40);
    }
    // 一个内陆的小湖：湖面的海岸值取负（至少 60 m）、30 m 深
    const inland = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && !w.derived.lake[i] && base.coast[i] > 200)!;
    const lake = [inland, ...w.mesh.adj.subarray(w.mesh.off[inland], w.mesh.off[inland + 1])];
    const lg = ghostLayers(w, base, editGhost(w, base, { cells: [], delta: [], lake }), 'terrain');
    for (const i of lake) {
      expect(lg.coast[i]).toBeLessThanOrEqual(-60);
      expect(lg.elevation[i]).toBe(-30);
    }
  });

  it('持久的缓冲：换补丁时先还原上一次的，回到 null 时与底子逐字节相同', () => {
    const w = continents().world;
    const base = cellLayers(w, opts('terrain'));
    const buf = new GhostBuffer(base, 'terrain');
    const at = (c: number) => {
      const st = islandStamp(w, { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'volcanic', size: 2 * cellKm(w), variant: 0 });
      return editGhost(w, base, { cells: st.cells, delta: st.landDelta });
    };
    const c = seaCell(w);
    const first = buf.apply(w, at(c));
    const firstCells = Array.from(first.cells);
    // 挪开几格再放：上一次的格都还原了，结果与一次性算的相同
    const c2 = w.mesh.adj[w.mesh.off[w.mesh.adj[w.mesh.off[c]]]];
    const second = buf.apply(w, at(c2));
    const fresh = ghostLayers(w, base, at(c2), 'terrain');
    expect(Array.from(second.smooth)).toEqual(Array.from(fresh.smooth));
    expect(Array.from(second.other)).toEqual(Array.from(fresh.other));
    expect(Array.from(second.coast)).toEqual(Array.from(fresh.coast));
    expect(Array.from(second.elevation)).toEqual(Array.from(fresh.elevation));
    expect(firstCells.length).toBeGreaterThan(0);
    const none = buf.apply(w, null);
    expect(none.cells.length).toBe(0);
    expect(Array.from(none.smooth)).toEqual(Array.from(base.smooth));
    expect(Array.from(none.other)).toEqual(Array.from(base.other));
    expect(Array.from(none.coast)).toEqual(Array.from(base.coast));
    expect(Array.from(none.elevation)).toEqual(Array.from(base.elevation));
  });

  it('整份的预览（调整滑块）：只换海岸值变了的格，原来的湖照旧画成湖面', () => {
    const w = continents().world;
    const base = cellLayers(w, opts('terrain'));
    const t = previewTerrain(w, { landFraction: 0.45 });
    const patch = terrainGhost(w, base, t);
    // 什么都不变时补丁是空的
    expect(terrainGhost(w, base, previewTerrain(w, {})).cells.length).toBe(0);
    const g = ghostLayers(w, base, patch, 'terrain');
    expect(t.gained.length).toBeGreaterThan(0);
    for (const i of t.gained) expect(g.coast[i]).toBeGreaterThan(0);
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && w.derived.lake[i] === 1 && !t.lost.includes(i)) expect(g.coast[i]).toBeLessThanOrEqual(-60);
  });
});
