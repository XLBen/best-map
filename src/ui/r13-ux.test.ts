import { describe, expect, it, vi } from 'vitest';
import { lakeArea } from '../../core/elevation';
import { brushRangeKm } from '../../core/terrain';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { exec, mode, options, setOptions, world } from '../state';
import { layerProvinceLabels } from './defs/layers';
import { setTool } from './defs/tools';
import { barPreview, showSplit } from './provincePreview';
import { LINE_CELL, type Pointer, biomeFailWhy, lakeTool, landTool } from './tools';

// 第十三轮修：换工具时清掉底部条按钮的悬停预览；省份着色开着时湖的预览看得见；导出按图层的省名；
// 自然融入涂不上时说为什么；一格的画笔拖出的线连续、不成锯齿

vi.mock('../state', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../state')>();
  return { ...mod, exec: vi.fn(async () => true) };
});

const at = (_w: World, x: number, y: number, cell: number): Pointer => ({ x, y, cell, sx: 0, sy: 0, shift: false, alt: false });
const coastal = (w: World, c: number) => {
  for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return true;
  return false;
};

describe('换工具', () => {
  it('底部条按钮的悬停预览（对半分开）换工具时清掉', () => {
    const w = continents({ provinces: true }).world;
    world.value = w;
    const sizes = new Map<number, number>();
    w.causes.province.forEach((p) => p >= 0 && w.small.provinces[p]?.land && sizes.set(p, (sizes.get(p) ?? 0) + 1));
    const id = [...sizes].sort((x, y) => y[1] - x[1])[0][0];
    setTool('land');
    showSplit(w, id);
    expect(barPreview.value).not.toBeNull();
    setTool('island');
    expect(barPreview.value).toBeNull();
  });
});

describe('省份着色开着时放湖', () => {
  it('湖面另涂一层湖蓝、描一圈白边（省的颜色盖不住）；不开时照旧只有湖面', () => {
    const w = continents().world;
    world.value = w;
    const inland = [...Array(w.mesh.n).keys()].find((i) => i % 7 === 0 && w.causes.land[i] && !lakeArea(w, i, options.value.lakeKm).some((c) => coastal(w, c)))!;
    const cells = lakeArea(w, inland, options.value.lakeKm);
    const t = lakeTool();
    t.move?.(at(w, w.mesh.x[inland], w.mesh.y[inland], inland), false);
    expect(t.preview().layers).toEqual([]);
    const was = mode.value;
    mode.value = 'provinces';
    try {
      const pv = t.preview();
      expect(pv.ghost!.lake).toEqual(cells);
      expect(pv.layers.map((l) => l.pattern ?? 'fill')).toEqual(['fill', 'outline']);
      for (const l of pv.layers) expect(l.cells).toEqual(cells);
    } finally {
      mode.value = was;
    }
  });
});

describe('省名按图层的设定', () => {
  const labels = [
    { x: 0, y: 0, text: '甲', kind: 'land' },
    { x: 0, y: 0, text: '乙海', kind: 'sea' },
    { x: 0, y: 0, text: '丙湖', kind: 'lake' },
  ];
  it('地名关着或没开“省名”：不标；开了只标陆上的；另开“海域的省名”才有海省', () => {
    expect(layerProvinceLabels(labels, false, new Set(['provinces', 'seaProvinces'] as const))).toEqual([]);
    expect(layerProvinceLabels(labels, true, new Set(['land'] as const))).toEqual([]);
    expect(layerProvinceLabels(labels, true, new Set(['provinces'] as const)).map((l) => l.text)).toEqual(['甲', '丙湖']);
    expect(layerProvinceLabels(labels, true, new Set(['provinces', 'seaProvinces'] as const)).map((l) => l.text)).toEqual(['甲', '乙海', '丙湖']);
  });
});

describe('自然融入涂不上时', () => {
  it('一句话说为什么、怎么办；“强制”时不说', () => {
    const w = continents().world;
    world.value = w;
    const c = w.causes.land.findIndex((v) => v === 1);
    setOptions({ biomeMode: 'natural' });
    const off = biomeFailWhy(w, { id: 'x', name: '幻光林', natural: false }, [c])!;
    expect(off).toContain('“幻光林”');
    expect(off).toContain('“强制”');
    expect(off).toContain('“自然生成”');
    expect(biomeFailWhy(w, { id: 'x', name: '幻光林' }, [c])).toContain('放宽');
    setOptions({ biomeMode: 'force' });
    expect(biomeFailWhy(w, { id: 'x', name: '幻光林' }, [c])).toBeNull();
    setOptions({ biomeMode: 'natural' });
  });
});

describe('一格的画笔拖一条线', () => {
  it('涂到的格连成一片，格心离笔画不到半格的格都涂上', async () => {
    const w = continents().world;
    world.value = w;
    const { mesh } = w;
    setOptions({ brushKm: brushRangeKm(w)[0] });
    vi.mocked(exec).mockClear();
    const t = landTool();
    const a: [number, number] = [mesh.width * 0.3, mesh.height * 0.4];
    const b: [number, number] = [mesh.width * 0.3 + mesh.spacing * 12, mesh.height * 0.4 + mesh.spacing * 7];
    const cellAt = (x: number, y: number) => {
      let best = 0;
      for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - x, mesh.y[i] - y) < Math.hypot(mesh.x[best] - x, mesh.y[best] - y)) best = i;
      return best;
    };
    t.down?.(at(w, a[0], a[1], cellAt(...a)));
    for (let k = 1; k <= 20; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / 20;
      const y = a[1] + ((b[1] - a[1]) * k) / 20;
      t.move?.(at(w, x, y, cellAt(x, y)), true);
    }
    await t.up?.(at(w, b[0], b[1], cellAt(...b)));
    const cmd = vi.mocked(exec).mock.calls.at(-1)?.[0] as { op: string; cells: number[] } | undefined;
    expect(cmd?.op).toBe('paint_land');
    const set = new Set(cmd!.cells);
    // 连成一片
    const seen = new Set([cmd!.cells[0]]);
    const queue = [cmd!.cells[0]];
    for (let h = 0; h < queue.length; h++) {
      for (let e = mesh.off[queue[h]]; e < mesh.off[queue[h] + 1]; e++) {
        const j = mesh.adj[e];
        if (set.has(j) && !seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    expect(seen.size).toBe(set.size);
    // 离线段不到 LINE_CELL·格距 的格心都在里面（两端以内）
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy;
    for (let i = 0; i < mesh.n; i++) {
      const u = ((mesh.x[i] - a[0]) * dx + (mesh.y[i] - a[1]) * dy) / len2;
      if (u < 0.05 || u > 0.95) continue;
      const d = Math.hypot(mesh.x[i] - (a[0] + u * dx), mesh.y[i] - (a[1] + u * dy));
      if (d < LINE_CELL * mesh.spacing * 0.9) expect(set.has(i), `#${i}`).toBe(true);
    }
  });
});
