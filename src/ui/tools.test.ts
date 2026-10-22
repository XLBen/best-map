import { describe, expect, it, vi } from 'vitest';
import { lakeArea } from '../../core/elevation';
import { brushCells } from '../../core/select';
import { chainIslands, reliefStroke } from '../../core/terrain';
import { continents } from '../../core/testing/fixtures';
import { describeChange, exec, options, setOptions, sliderActive, toast, world } from '../state';
import { TOOL_DEFS } from './defs/tools';
import { type Pointer, fmtMeters, lakeTool, landTool, reliefEstimateM, reliefTool, restoreTool, strengthValues } from './tools';

// 工具的手感：预览深浅跟着力度、堆山的高度估计、改完后哪些格会闪、放湖贴着海时拦下

// 命令不真的发给引擎（这里没有 worker）：只看工具发了什么
vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true) }));

describe('预览深浅跟着力度', () => {
  it('最淡 0.35（力度很小时也看得见涂到了哪里），到滑块最大值时为 1，升降一样', () => {
    expect(strengthValues([0, 0.8, 1.6, -1.6, 3], 1.6)).toEqual([0.35, 0.675, 1, 1, 1]);
  });

  it('力度越大越深', () => {
    const [a] = strengthValues([0.15], 1.6);
    const [b] = strengthValues([0.7], 1.6);
    expect(b).toBeGreaterThan(a + 0.2);
  });
});

describe('高度变化的写法', () => {
  it('取整成好读的数，带正负号', () => {
    expect(fmtMeters(612)).toBe('约 +600 m');
    expect(fmtMeters(-87)).toBe('约 −90 m');
    expect(fmtMeters(1234)).toBe(`约 +${(1200).toLocaleString()} m`);
    expect(fmtMeters(2)).toBe('几乎不变');
  });
});

// 笔下升得最多、降得最多的那一格，与估计比：几个位置的中位数相差不到一倍，压低时也不会估成反方向
describe('堆山 / 压低的高度估计与实际同一量级', () => {
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const cases: [number, number][] = [
    [1, 0.7],
    [4, 0.7],
    [1, -0.7],
    [4, -0.7],
    [8, -1.4],
  ];
  for (const [rCells, strength] of cases) {
    it(`半径 ${rCells} 格、力度 ${strength}`, () => {
      const base = continents();
      const w0 = base.world;
      const cellKm = w0.mesh.spacing * w0.kmPerUnit;
      setOptions({ brushKm: rCells * cellKm });
      const ratios: number[] = [];
      for (let i = 0; i < w0.mesh.n && ratios.length < 5; i += 331) {
        if (!w0.causes.land[i] || w0.derived.elevation[i] < 300 || w0.causes.uplift[i] < 0.03) continue;
        const eng = base.clone();
        const w = eng.world;
        // 与工具一样只涂陆地
        const b = brushCells(w, w.mesh.x[i], w.mesh.y[i], rCells * cellKm);
        const keep = b.cells.map((c) => w.causes.land[c] === 1);
        const cells = b.cells.filter((_, k) => keep[k]);
        const t = b.t.filter((_, k) => keep[k]);
        const estimate = reliefEstimateM(w, cells, reliefStroke(cells, t, strength).delta, strength);
        const before = Float32Array.from(w.derived.elevation);
        eng.exec({ op: 'paint_relief', cells, t, strength });
        const after = eng.world.derived.elevation;
        let actual = 0;
        for (const c of cells) actual = strength > 0 ? Math.max(actual, after[c] - before[c]) : Math.min(actual, after[c] - before[c]);
        // 选的地方都有几百米高、有抬升：估计不会是“几乎不变”
        expect(Math.abs(estimate)).toBeGreaterThan(5);
        ratios.push(actual / estimate);
      }
      expect(ratios.length).toBe(5);
      const m = median(ratios);
      expect(m).toBeGreaterThan(0.5);
      expect(m).toBeLessThan(2);
      // 方向总是对的（压低不会估成升高），也不会差出好几倍
      for (const r of ratios) {
        expect(r).toBeGreaterThan(0.25);
        expect(r).toBeLessThan(4);
      }
    });
  }
});

describe('岛链的“疏密”写出间距', () => {
  it('写的间距与真放出来的岛链相同（取整前差不到一成）', () => {
    const w = continents().world;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    setOptions({ islandKm: 3 * cellKm });
    const def = TOOL_DEFS.chain.amount!;
    for (const v of [0.4, 1, 2.5]) {
      const text = def.format(v, w);
      expect(text).toMatch(/^(稀疏|正常|密集) \d+% · 间距约 \d+ km$/);
      const said = Number(text.match(/间距约 (\d+) km/)![1]);
      // 一条横贯地图的直线：沿线的岛距 = 全长 ÷ 岛数
      const isl = chainIslands(w, { points: [[0.1 * w.mesh.width, 0.5 * w.mesh.height], [0.9 * w.mesh.width, 0.5 * w.mesh.height]], kind: 'volcanic', size: options.value.islandKm, density: v, variant: 0 });
      const real = (0.8 * w.mesh.width * w.kmPerUnit) / isl.length;
      expect(Math.abs(said - real) / real).toBeLessThan(0.1);
    }
  });
});

describe('改完后哪些格会闪', () => {
  // 两个相邻的陆地省
  const neighbours = (w: ReturnType<typeof continents>['world']) => {
    const { mesh, causes } = w;
    for (let i = 0; i < mesh.n; i++) {
      if (!causes.land[i] || causes.province[i] < 0) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (causes.land[j] && causes.province[j] >= 0 && causes.province[j] !== causes.province[i]) return [causes.province[i], causes.province[j]];
      }
    }
    throw new Error('没有相邻的省');
  };

  it('合并省份：并进来的那个省的格都闪', () => {
    const before = continents({ provinces: true });
    const [into, from] = neighbours(before.world);
    const moved: number[] = [];
    before.world.causes.province.forEach((p, i) => p === from && moved.push(i));
    const after = before.clone();
    after.exec({ op: 'merge_province', from, into });
    const { cells, detail } = describeChange(before.world, after.world);
    expect(new Set(cells)).toEqual(new Set(moved));
    expect(detail).toBe(`${moved.length} 格换了省份`);
  });

  it('整张图重新划分（三成以上的格换了省）：不闪', () => {
    const before = continents({ provinces: true });
    const after = before.clone();
    after.exec({ op: 'generate_provinces', rules: { seed: 99 } });
    let changed = 0;
    before.world.causes.province.forEach((p, i) => p !== after.world.causes.province[i] && changed++);
    expect(changed).toBeGreaterThan(before.world.mesh.n * 0.3);
    expect(describeChange(before.world, after.world).cells).toEqual([]);
  });
});

describe('放湖：贴着海时松手就拦下', () => {
  const at = (w: ReturnType<typeof continents>['world'], c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift: false, alt: false });
  const coastal = (w: ReturnType<typeof continents>['world'], cells: number[]) =>
    cells.some((c) => {
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return true;
      return false;
    });

  it('碰到海岸：提示往内陆挪，不发命令（历史里不多一步）', async () => {
    const w = continents().world;
    world.value = w;
    vi.mocked(exec).mockClear();
    const c = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && coastal(w, [i]))!;
    const t = lakeTool();
    t.down?.(at(w, c));
    expect(t.preview().warn).toBe(true);
    await t.up?.(at(w, c));
    expect(toast.value?.text).toBe('离海太近，留不住水：往内陆挪一点');
    expect(exec).not.toHaveBeenCalled();
    // 拦下后不再拖着：预览回到悬停的样子
    expect(t.preview().hint).toBe('离海太近，留不住水');
  });

  it('在内陆：照常放湖', async () => {
    const w = continents().world;
    world.value = w;
    vi.mocked(exec).mockClear();
    const c = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && i % 7 === 0 && !coastal(w, lakeArea(w, i, options.value.lakeKm)))!;
    const t = lakeTool();
    t.down?.(at(w, c));
    await t.up?.(at(w, c));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exec).mock.calls[0][0]).toMatchObject({ op: 'add_lake', lake: { cell: c } });
  });
});

describe('画笔的圈、拖滑块时的预览、排队中的笔画', () => {
  const at = (w: ReturnType<typeof continents>['world'], c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 10, sy: 20, shift: false, alt: false });
  const setup = () => {
    const w = continents().world;
    world.value = w;
    sliderActive.value = false;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    setOptions({ brushKm: 4 * cellKm, reliefMode: 'up', reliefAmount: 0.7, landMode: 'land' });
    // 离海岸远一点的陆地格
    const c = [...Array(w.mesh.n).keys()].find((i) => i % 5 === 0 && w.causes.land[i] && w.derived.elevation[i] > 200)!;
    return { w, c, r: (4 * cellKm) / w.kmPerUnit };
  };

  it('空闲悬停只有圈：画陆地 0.7 倍细实线 + 0.85 倍虚线，恢复原样 0.7 倍 + 半径处，其余画笔半径处一圈', () => {
    const { w, c, r } = setup();
    const radii = (t: ReturnType<typeof landTool>) => {
      t.move?.(at(w, c), false);
      const pv = t.preview();
      expect(pv.layers).toEqual([]);
      return pv.shapes.map((s) => [+(s.r! / r).toFixed(3), !!s.dashed]);
    };
    expect(radii(landTool())).toEqual([
      [0.7, false],
      [0.85, true],
    ]);
    expect(radii(restoreTool())).toEqual([
      [0.7, false],
      [1, true],
    ]);
    expect(radii(reliefTool())).toEqual([[1, true]]);
  });

  it('拖“力度”滑块：在最后停的地方预览涂一下，深浅跟着力度，旁边写出升多少', () => {
    const { w, c } = setup();
    const t = reliefTool();
    t.move?.(at(w, c), false);
    t.leave?.();
    sliderActive.value = true;
    const a = t.preview();
    expect(a.sliderHint).toBe(true);
    expect(a.hint).toMatch(/^堆山 约 \+[\d,]+ m$/);
    setOptions({ reliefAmount: 1.4 });
    const b = t.preview();
    const peak = (pv: typeof a) => Math.max(...pv.layers[0].values!);
    expect(peak(b)).toBeGreaterThan(peak(a));
    sliderActive.value = false;
    // 松开滑块、鼠标不在地图上：什么都不画
    expect(t.preview().layers).toEqual([]);
  });

  it('排队中的笔画一直显示松手时的预览（不变成白色的等待），鼠标离开地图也留着，结果换上后才去掉', async () => {
    const { w, c } = setup();
    let finish: (ok: boolean) => void = () => {};
    vi.mocked(exec).mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
    const t = reliefTool();
    t.down?.(at(w, c));
    t.move?.(at(w, c), true);
    const drawn = t.preview().layers;
    const done = t.up?.(at(w, c));
    const pv = t.preview();
    expect(pv.layers).toEqual(drawn);
    expect(pv.layers.every((l) => l.color.join() !== '255,255,255')).toBe(true);
    expect(pv.hint).toBe('正在计算…（1 笔）');
    t.leave?.();
    expect(t.keep?.()).toBe(true);
    expect(t.preview()).toMatchObject({ layers: drawn, shapes: [] });
    finish(true);
    await done;
    expect(t.keep?.()).toBe(false);
    expect(t.preview().layers).toEqual([]);
  });
});
