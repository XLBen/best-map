import { describe, expect, it, vi } from 'vitest';
import { digestWorld } from '../../tools/hash';
import type { Command } from '../../core/commands';
import { lakeArea } from '../../core/elevation';
import { brushCells } from '../../core/select';
import { chainIslands, reliefStroke } from '../../core/terrain';
import { continents } from '../../core/testing/fixtures';
import { scissors, seamLayers } from '../../core/seams';
import { groupPreview, provinceFlat, provinceGroups } from '../render/colors';
import { busy, describeChange, exec, options, previewProvinces, selectedProvince, setOptions, sliderActive, toast, world } from '../state';
import { TOOL_DEFS } from './defs/tools';
import { pendingEdits } from './pending';
import { barPreview, clearBarPreview, showProvinceCommand, showSplit } from './provincePreview';
import {
  type Pointer,
  chainTool,
  fmtMeters,
  islandTool,
  lakeTool,
  landTool,
  provinceBrushTool,
  provinceCutTool,
  provinceMergeTool,
  provinceRegenTool,
  reliefEstimateM,
  reliefTool,
  restoreTool,
  strengthValues,
} from './tools';

// 工具的手感：预览深浅跟着力度、堆山的高度估计、改完后哪些格会闪、放湖贴着海时拦下

// 命令不真的发给引擎（这里没有 worker）：只看工具发了什么。省份预览由测试接到引擎上
vi.mock('../state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state')>()),
  exec: vi.fn(async () => true),
  previewProvinces: vi.fn(async () => null),
}));

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
    // 排队中的笔画交给地图画（换了工具、鼠标离开地图也留着）
    expect(pendingEdits.value).toHaveLength(1);
    const queued = pendingEdits.value[0].preview;
    expect(queued.layers).toEqual(drawn);
    expect(queued.layers.every((l) => l.color.join() !== '255,255,255')).toBe(true);
    expect(t.preview().hint).toBe('正在计算…（1 步）');
    t.leave?.();
    expect(t.preview().layers).toEqual([]);
    expect(pendingEdits.value).toHaveLength(1);
    finish(true);
    await done;
    expect(pendingEdits.value).toEqual([]);
  });
});

// 第八轮第四批：放岛、岛链、圈一片、放湖也像画笔一样排队。命令只看位置、形状和底部条上的选项，
// 不看前面那几步算完没有，所以排着队发出去的命令与一步一步等着做发出的相同，结果也相同
describe('放岛、岛链、圈一片、放湖也能排队', () => {
  // 一组手势：放岛、岛链、圈一片、放湖。返回每一步发出的命令（exec 被换成了 send）
  type Gesture = () => Promise<void>;
  const near = (w: ReturnType<typeof continents>['world'], keep: (i: number) => boolean, from = 0) => {
    for (let i = from; i < w.mesh.n; i += 7) if (keep(i)) return i;
    throw new Error('找不到合适的格');
  };
  const pt = (x: number, y: number, sx: number, cell: number): Pointer => ({ x, y, cell, sx, sy: 100, shift: false, alt: false });
  const said = () => toast.value?.text ?? null;
  const setupQueue = () => {
    const eng = continents();
    const w = eng.world;
    const s = w.mesh.spacing;
    const cellKm = s * w.kmPerUnit;
    const inMiddle = (i: number) => w.mesh.x[i] > 0.25 * w.mesh.width && w.mesh.x[i] < 0.75 * w.mesh.width && w.mesh.y[i] > 0.25 * w.mesh.height && w.mesh.y[i] < 0.75 * w.mesh.height;
    // 四周 3 格都是海的格（放岛、岛链）；海边的海格（圈一片）；离海远的陆地（放湖）
    const open = (i: number) => !w.causes.land[i] && brushCells(w, w.mesh.x[i], w.mesh.y[i], 3 * cellKm).cells.every((c) => !w.causes.land[c]);
    const isle = near(w, (i) => inMiddle(i) && open(i));
    const chainAt = near(w, (i) => inMiddle(i) && open(i) && Math.hypot(w.mesh.x[i] - w.mesh.x[isle], w.mesh.y[i] - w.mesh.y[isle]) > 15 * s);
    const coast = near(w, (i) => inMiddle(i) && !w.causes.land[i] && brushCells(w, w.mesh.x[i], w.mesh.y[i], 2 * cellKm).cells.some((c) => w.causes.land[c]) && Math.hypot(w.mesh.x[i] - w.mesh.x[isle], w.mesh.y[i] - w.mesh.y[isle]) > 15 * s && Math.hypot(w.mesh.x[i] - w.mesh.x[chainAt], w.mesh.y[i] - w.mesh.y[chainAt]) > 15 * s);
    const lake = near(w, (i) => w.causes.land[i] === 1 && brushCells(w, w.mesh.x[i], w.mesh.y[i], 6 * cellKm).cells.every((c) => w.causes.land[c]));
    const start = { islandKind: 'volcanic' as const, islandKm: 2 * cellKm, islandVariant: 3, chainKind: 'volcanic' as const, chainKm: 2 * cellKm, chainVariant: 1, chainDensity: 1, lakeKm: 1.5 * cellKm, landShape: 'lasso' as const, landMode: 'land' as const };
    const gestures = (): Gesture[] => {
      const island = islandTool();
      const chain = chainTool();
      const lasso = landTool();
      const lk = lakeTool();
      const at = (c: number, sx: number) => pt(w.mesh.x[c], w.mesh.y[c], sx, c);
      return [
        async () => {
          island.move?.(at(isle, 10), false);
          island.down?.(at(isle, 10));
          await island.up?.(at(isle, 10));
        },
        async () => {
          const [x, y] = [w.mesh.x[chainAt], w.mesh.y[chainAt]];
          chain.down?.(pt(x, y, 200, chainAt));
          chain.move?.(pt(x + 4 * s, y + s, 230, chainAt), true);
          await chain.up?.(pt(x + 8 * s, y + 2 * s, 260, chainAt));
        },
        async () => {
          const [x, y] = [w.mesh.x[coast], w.mesh.y[coast]];
          lasso.down?.(pt(x + 3 * s, y, 400, coast));
          for (let k = 1; k <= 24; k++) lasso.move?.(pt(x + 3 * s * Math.cos((k * Math.PI) / 12), y + 3 * s * Math.sin((k * Math.PI) / 12), 400 + k, coast), true);
          await lasso.up?.(pt(x + 3 * s, y, 430, coast));
        },
        async () => {
          lk.move?.(at(lake, 600), false);
          lk.down?.(at(lake, 600));
          await lk.up?.(at(lake, 600));
        },
      ];
    };
    return { eng, start, gestures, isle };
  };

  it('前面的还在算时照样能用：不说“还在计算上一步”，松手时的预览一直留着，算完才去掉', async () => {
    const { eng, start, gestures, isle } = setupQueue();
    world.value = eng.world;
    setOptions(start);
    toast.value = null;
    vi.mocked(exec).mockClear();
    const finish: ((ok: boolean) => void)[] = [];
    vi.mocked(exec).mockImplementation(() => new Promise<boolean>((r) => finish.push(r)));
    // 在算前面的编辑时 busy 有字（这里没有 Worker，自己设上）
    busy.value = '正在造岛…';
    const island = islandTool();
    const steps = gestures();
    const done = steps.map((g) => g());
    expect(vi.mocked(exec).mock.calls.map((c) => (c[0] as Command).op)).toEqual(['add_island', 'add_island_chain', 'paint_land', 'add_lake']);
    expect(said()).toBeNull();
    expect(pendingEdits.value).toHaveLength(4);
    expect(pendingEdits.value.every((e) => e.preview.layers.length > 0 && e.preview.layers[0].cells.length > 0)).toBe(true);
    // 再放一个岛：鼠标旁说前面还有几步
    const w = eng.world;
    island.move?.(pt(w.mesh.x[isle], w.mesh.y[isle], 900, isle), false);
    expect(island.preview().hint).toBe('排队中：前面还有 4 步');
    expect(island.preview().layers[0].cells.length).toBeGreaterThan(0);
    // 河、剪刀、合并要按最新的世界算：照旧等前面算完（只说一声，不开始画）
    const cut = provinceCutTool(() => 1000);
    cut.down?.(pt(w.mesh.x[isle], w.mesh.y[isle], 10, isle));
    cut.move?.(pt(w.mesh.x[isle] + 5 * w.mesh.spacing, w.mesh.y[isle], 60, isle), true);
    expect(said()).toBe('还在计算上一步，稍等一下');
    expect(cut.preview().shapes).toEqual([]);
    finish.forEach((f) => f(true));
    await Promise.all(done);
    expect(pendingEdits.value).toEqual([]);
    busy.value = null;
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockImplementation(async () => true);
  });

  it('两步排队的结果 = 依次执行', async () => {
    const { eng, start, gestures } = setupQueue();
    // 排队：四步都在原来的世界上松手，命令一起发出去
    world.value = eng.world;
    setOptions(start);
    const queued: Command[] = [];
    vi.mocked(exec).mockImplementation(async (cmd) => (queued.push(cmd), true));
    for (const g of gestures()) await g();
    // 依次：每一步算完、世界换上以后再做下一步
    const seq = eng.clone();
    world.value = seq.world;
    setOptions(start);
    const sequential: Command[] = [];
    vi.mocked(exec).mockImplementation(async (cmd) => {
      sequential.push(cmd);
      seq.exec(cmd);
      world.value = seq.world;
      return true;
    });
    for (const g of gestures()) await g();
    expect(sequential).toEqual(queued);
    expect(queued).toHaveLength(4);
    // 排队的命令按顺序执行，结果与依次执行相同
    const inLine = eng.clone();
    for (const cmd of queued) inLine.exec(cmd);
    expect(digestWorld(inLine.world)).toEqual(digestWorld(seq.world));
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockImplementation(async () => true);
  });
});

// 第八轮第四批：省份的预览就是结果；合并锁定的省拦下、不相邻的照样合并（黄色提醒）；涂省会把别的省分成几块时提醒
describe('省份：对半分开的悬停、合并与涂省的提醒', () => {
  type W = ReturnType<typeof continents>['world'];
  const cellsOf = (w: W, p: number) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.province[i] === p);
  // 格与周围一圈都在同一个省里（屏幕上这一点画的一定是这个省）
  const interior = (w: W, p: number) =>
    cellsOf(w, p).find((c) => {
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (w.causes.province[w.mesh.adj[e]] !== p) return false;
      return true;
    });
  const at = (w: W, c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift: false, alt: false });
  const pieces = (w: W, cells: number[]) => {
    const left = new Set(cells);
    let k = 0;
    for (const c of cells) {
      if (!left.delete(c)) continue;
      k++;
      const q = [c];
      for (let h = 0; h < q.length; h++) for (let e = w.mesh.off[q[h]]; e < w.mesh.off[q[h] + 1]; e++) if (left.delete(w.mesh.adj[e])) q.push(w.mesh.adj[e]);
    }
    return k;
  };
  const groupsOf = (w: W) => Array.from(provinceGroups(w, w.causes.province, seamLayers(w, w.causes.province, w.small.provinceSeams)));
  // 大的陆地省，按格数从大到小
  const bigLand = (w: W) => {
    const sizes = new Map<number, number>();
    w.causes.province.forEach((p) => p >= 0 && sizes.set(p, (sizes.get(p) ?? 0) + 1));
    return [...sizes].filter(([p]) => w.small.provinces[p]?.land).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  };

  it('对半分开：悬停按钮时画出的省界、省份着色与点下去的结果相同（切过的省，切线也接着管分出来的一半）', () => {
    const eng = continents({ provinces: true });
    const [id] = bigLand(eng.world);
    const s = eng.world.mesh.spacing;
    const c = interior(eng.world, id)!;
    const { line, cut } = scissors(eng.world, [
      [eng.world.mesh.x[c] - 2 * s, eng.world.mesh.y[c]],
      [eng.world.mesh.x[c] + 2 * s, eng.world.mesh.y[c] + 0.1 * s],
    ]);
    expect(cut.plans.length).toBeGreaterThan(0);
    eng.exec({ op: 'cut_province', line });
    const w = eng.world;
    world.value = w;
    showSplit(w, id);
    const pv = barPreview.value!;
    expect(pv.layers[0].cells.length).toBeGreaterThan(0);
    const shown = groupPreview(w, pv.provinces, 'provinces');
    eng.exec({ op: 'split_province', id });
    const after = eng.world;
    expect(Array.from(shown.group)).toEqual(groupsOf(after));
    expect(Array.from(shown.flat!)).toEqual(Array.from(provinceFlat(after, after.causes.province)));
    // 鼠标移开：不再预览
    clearBarPreview();
    expect(barPreview.value).toBeNull();
  });

  it('按新规则重新划分：鼠标停在按钮上先画出新的省界和省名（与点下去的结果相同）；只是划过去的不算', async () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    world.value = w;
    vi.mocked(previewProvinces).mockImplementation(async (cmd) => eng.previewProvinces(cmd));
    vi.mocked(previewProvinces).mockClear();
    const cmd: Command = { op: 'generate_provinces', rules: { ...w.small.provinceRules, size: 'small', seed: w.small.provinceRules.seed + 1 } };
    // 从按钮上划过去
    showProvinceCommand(cmd);
    clearBarPreview();
    await new Promise((r) => setTimeout(r, 300));
    expect(previewProvinces).not.toHaveBeenCalled();
    expect(barPreview.value).toBeNull();
    // 停在按钮上
    showProvinceCommand(cmd);
    await new Promise((r) => setTimeout(r, 300));
    expect(previewProvinces).toHaveBeenCalledTimes(1);
    const pv = barPreview.value!;
    expect(pv.base).toBe(w);
    const shown = groupPreview(w, pv.provinces, 'provinces');
    eng.exec(cmd);
    const after = eng.world;
    expect(Array.from(shown.group)).toEqual(groupsOf(after));
    expect(Array.from(shown.flat!)).toEqual(Array.from(provinceFlat(after, after.causes.province)));
    expect(pv.provinces.metas).toEqual(after.small.provinces);
    clearBarPreview();
    vi.mocked(previewProvinces).mockReset();
    vi.mocked(previewProvinces).mockImplementation(async () => null);
  });

  it('合并：锁定的省标红、点了不合并；不相邻的两省黄色提醒，照样能合并', async () => {
    const eng = continents({ provinces: true });
    const [a, b] = bigLand(eng.world);
    eng.exec({ op: 'set_province', id: b, locked: true });
    // 与 a 不相邻、没锁定的陆地省
    const w = eng.world;
    const touching = new Set<number>();
    for (const c of cellsOf(w, a)) for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) touching.add(w.causes.province[w.mesh.adj[e]]);
    const far = bigLand(w).find((p) => p !== a && p !== b && !touching.has(p) && interior(w, p) !== undefined)!;
    world.value = w;
    vi.mocked(exec).mockClear();
    toast.value = null;
    const t = provinceMergeTool();
    selectedProvince.value = a;
    t.move?.(at(w, interior(w, b)!), false);
    const locked = t.preview();
    expect(locked).toMatchObject({ warn: true, hint: `「${w.small.provinces[b].name}」已锁定，不能合并` });
    expect(locked.provinces).toBeUndefined();
    expect(locked.layers[0].color).toEqual([230, 90, 70]);
    await t.click?.(at(w, interior(w, b)!));
    expect(exec).not.toHaveBeenCalled();
    expect((toast.value as { text: string } | null)?.text).toBe(locked.hint);
    t.move?.(at(w, interior(w, far)!), false);
    expect(t.preview()).toMatchObject({ caution: true, hint: '不相邻：合并后是一省两块' });
    await t.click?.(at(w, interior(w, far)!));
    expect(vi.mocked(exec).mock.calls[0][0]).toEqual({ op: 'merge_province', from: far, into: a });
    selectedProvince.value = null;
  });

  it('重划：涂着停一下，地图上画出确切的新省界与省名（与执行的结果相同）', async () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    world.value = w;
    vi.mocked(previewProvinces).mockImplementation(async (cmd) => eng.previewProvinces(cmd));
    vi.mocked(previewProvinces).mockClear();
    vi.mocked(exec).mockClear();
    const [p] = bigLand(w);
    const cells = cellsOf(w, p);
    setOptions({ brushKm: 0.6 * w.mesh.spacing * w.kmPerUnit });
    const t = provinceRegenTool();
    t.move?.(at(w, cells[0]), false);
    t.down?.(at(w, cells[0]));
    for (const c of cells) t.move?.(at(w, c), true);
    // 算好之前：先把会重划的省涂黄
    const rough = t.preview();
    expect(rough.hint).toMatch(/^重划 \d+ 个省$/);
    expect(rough.provinces).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    const exact = t.preview();
    expect(exact.hint).toMatch(/^重划 \d+ 个省 → \d+ 个$/);
    // 接着涂到邻省的一格（邻省远没涂到一半，重划的还是这个省）：新省界一直留着，不跳回涂黄，也不再算一遍
    const sizes = new Map<number, number>();
    w.causes.province.forEach((q) => q >= 0 && sizes.set(q, (sizes.get(q) ?? 0) + 1));
    let nb = -1;
    for (const c of cells) {
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1] && nb < 0; e++) {
        const q = w.causes.province[w.mesh.adj[e]];
        if (q >= 0 && q !== p && (sizes.get(q) ?? 0) >= 10) nb = w.mesh.adj[e];
      }
    }
    expect(nb).toBeGreaterThanOrEqual(0);
    t.move?.(at(w, nb), true);
    const more = t.preview();
    expect(more.provinces).toBe(exact.provinces);
    expect(more.hint).toBe(exact.hint);
    await new Promise((r) => setTimeout(r, 300));
    expect(previewProvinces).toHaveBeenCalledTimes(1);
    // 松手：发出的命令（多涂了邻省那一格）执行后的省份与省名，就是停下时画出来的
    await t.up?.(at(w, cells[cells.length - 1]));
    const cmd = vi.mocked(exec).mock.calls[0][0] as Command;
    expect(cmd.op).toBe('regenerate_provinces');
    expect((cmd as { cells: number[] }).cells).toContain(nb);
    const old = new Set(Object.keys(w.small.provinces));
    eng.exec(cmd);
    expect(Array.from(exact.provinces!.province!)).toEqual(Array.from(eng.world.causes.province));
    expect(exact.provinces!.metas).toEqual(eng.world.small.provinces);
    const fresh = Object.keys(eng.world.small.provinces).filter((id) => !old.has(id)).length;
    expect(exact.hint!.endsWith(`→ ${fresh} 个`)).toBe(true);
    vi.mocked(previewProvinces).mockReset();
    vi.mocked(previewProvinces).mockImplementation(async () => null);
  });

  it('涂省：把别的省涂断时提醒会分成几块（与涂完以后数的相同）', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    world.value = w;
    const s = w.mesh.spacing;
    setOptions({ brushKm: 0.9 * s * w.kmPerUnit });
    let found = false;
    for (const p of bigLand(w).slice(0, 12)) {
      const c = interior(w, p);
      if (c === undefined) continue;
      // 目标：p 的一个邻省；一笔从 p 的一边横穿到另一边
      let target = -1;
      for (const i of cellsOf(w, p)) for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) {
        const q = w.causes.province[w.mesh.adj[e]];
        if (q >= 0 && q !== p && w.small.provinces[q]?.land && target < 0) target = q;
      }
      if (target < 0) continue;
      selectedProvince.value = target;
      const t = provinceBrushTool();
      const y = w.mesh.y[c];
      const xs = cellsOf(w, p).map((i) => w.mesh.x[i]);
      const x0 = Math.min(...xs) - 2 * s;
      const x1 = Math.max(...xs) + 2 * s;
      const pts: Pointer[] = [];
      for (let x = x0; x <= x1; x += 0.3 * s) pts.push({ x, y, cell: c, sx: 0, sy: 0, shift: false, alt: false });
      t.move?.(pts[0], false);
      t.down?.(pts[0]);
      for (const q of pts) t.move?.(q, true);
      const pv = t.preview();
      const m = pv.hint?.match(/^会把「(.+)」分成 (\d+) 块$/);
      if (!m) {
        t.cancel?.();
        continue;
      }
      expect(pv.caution).toBe(true);
      // 涂完以后数一数：那个省真的成了这么多块
      const after = eng.clone();
      after.exec({ op: 'assign_province', cells: pv.provinces!.cells, province: target });
      const loser = Number(Object.entries(w.small.provinces).find(([, meta]) => meta.name === m[1])![0]);
      expect(pieces(after.world, cellsOf(after.world, loser))).toBe(Number(m[2]));
      t.cancel?.();
      found = true;
      break;
    }
    expect(found).toBe(true);
    selectedProvince.value = null;
  });
});
