import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { brushCells } from '../../core/select';
import { continents } from '../../core/testing/fixtures';
import { exec, options, selectedLake, selectedProvince, selectedRiver, setOptions, sliderActive, toast, world } from '../state';
import { riverTool, unwaterTool } from './riverCourse';
import {
  type Pointer,
  type Preview,
  type ToolHandler,
  biomeTool,
  chainTool,
  climateEraseTool,
  climateTool,
  eraseTool,
  fieldTool,
  fragmentTool,
  growTool,
  islandTool,
  lakeTool,
  landTool,
  provinceBrushTool,
  provinceCutTool,
  provinceRegenTool,
  rangePick,
  rangeTool,
  regionTool,
  reliefTool,
  rerollTool,
  restoreTool,
  spotTool,
} from './tools';

// 第十九轮 A（工具解耦）之前录下的：一串脚本化的手势依次交给各个工具，记下发出的命令、提示条与按住时的预览。
// 拆文件、合并重复之后再跑，逐条相同（录下的文件不重录：变了就是行为变了）

vi.mock('../state', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../state')>();
  const { previewTerrain: run } = await import('../../core/terrain');
  return { ...mod, exec: vi.fn(async () => true), previewTerrainOnce: vi.fn(async (patch) => run(mod.world.value!, patch)), previewProvinces: vi.fn(async () => null) };
});

const ZOOM = 1000;

// 预览的摘要：每个图层的格数与格号之和、图形的种类、幽灵海岸、省份预览
function summary(pv: Preview) {
  const sum = (a: ArrayLike<number> | undefined) => (a ? Array.from(a).reduce((s, x) => s + x, 0) : 0);
  return {
    hint: pv.hint,
    warn: !!pv.warn,
    caution: !!pv.caution,
    layers: pv.layers.map((l) => [l.cells.length, sum(l.cells), l.color.join(','), l.alpha ?? null, l.pattern ?? null, l.values ? +sum(l.values).toFixed(6) : null]),
    shapes: pv.shapes.map((s) => s.kind),
    ghost: pv.ghost ? [pv.ghost.cells.length, sum(pv.ghost.cells), +sum(pv.ghost.delta).toFixed(6), pv.ghost.lake?.length ?? 0, pv.ghost.frag?.cells.length ?? 0] : null,
    provinces: pv.provinces ? [pv.provinces.cells.length, sum(pv.provinces.cells), sum(pv.provinces.ids)] : null,
  };
}

describe('工具的命令流（拆分前后逐条相同）', () => {
  it('一串手势发出的命令、提示与预览与录下的相同', async () => {
    const eng = continents({ provinces: true });
    // 先改几处：恢复原样、擦掉冷暖干湿、擦除、涂自定义场、删湖都要有东西可改
    const w0 = eng.world;
    const cellKm = w0.mesh.spacing * w0.kmPerUnit;
    const s = w0.mesh.spacing;
    const inMiddle = (i: number) => w0.mesh.x[i] > 0.2 * w0.mesh.width && w0.mesh.x[i] < 0.8 * w0.mesh.width && w0.mesh.y[i] > 0.2 * w0.mesh.height && w0.mesh.y[i] < 0.8 * w0.mesh.height;
    const find = (keep: (i: number) => boolean, from = 0) => {
      for (let i = from; i < w0.mesh.n; i += 7) if (keep(i)) return i;
      throw new Error('找不到合适的格');
    };
    const ring = (i: number, r: number) => brushCells(w0, w0.mesh.x[i], w0.mesh.y[i], r * cellKm).cells;
    const coastal = (i: number) => [...w0.mesh.adj.subarray(w0.mesh.off[i], w0.mesh.off[i + 1])].some((j) => !w0.causes.land[j]);
    const inland = find((i) => inMiddle(i) && w0.causes.land[i] === 1 && ring(i, 6).every((c) => w0.causes.land[c]));
    const coast = find((i) => inMiddle(i) && w0.causes.land[i] === 1 && coastal(i));
    const sea = find((i) => inMiddle(i) && ring(i, 4).every((c) => !w0.causes.land[c]));
    const sea2 = find((i) => inMiddle(i) && ring(i, 4).every((c) => !w0.causes.land[c]) && Math.hypot(w0.mesh.x[i] - w0.mesh.x[sea], w0.mesh.y[i] - w0.mesh.y[sea]) > 12 * s);
    const painted = ring(coast, 2);
    eng.exec({ op: 'paint_land', cells: painted, t: painted.map(() => 0), mode: 'land' });
    const warmed = ring(inland, 2);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: warmed, values: warmed.map(() => 2), mode: 'add' });
    eng.exec({ op: 'add_field', name: 'mana' });
    const sp = eng.world.small.species.find((x) => x.id !== eng.world.small.species[eng.world.derived.dominant[inland]]?.id)!;
    eng.exec({ op: 'add_constraint', constraint: { cells: warmed, species: sp.id, mode: 'override', ratio: 1, radius: 100, label: '' } });
    eng.exec({ op: 'add_lake', lake: { cell: inland, radius: 1.5 * cellKm, depth: 120, perennial: true } });
    const w = eng.world;
    world.value = w;
    sliderActive.value = false;
    setOptions({ brushKm: 1.5 * cellKm, islandKm: 2 * cellKm, chainKm: 2 * cellKm, lakeKm: 1.2 * cellKm, reachKm: 3 * cellKm, field: 'mana', biome: sp.id });

    const at = (x: number, y: number, extra: Partial<Pointer> = {}): Pointer => {
      const c = brushCells(w, x, y, 0.01).cells[0] ?? -1;
      return { x, y, cell: c, sx: x * ZOOM, sy: y * ZOOM, shift: false, alt: false, ...extra };
    };
    const atCell = (c: number, extra: Partial<Pointer> = {}) => at(w.mesh.x[c], w.mesh.y[c], extra);
    // 一串点：从 a 到 b 每 0.4 格一点
    const line = (a: number, b: number, extra: Partial<Pointer> = {}): Pointer[] => {
      const [ax, ay, bx, by] = [w.mesh.x[a], w.mesh.y[a], w.mesh.x[b], w.mesh.y[b]];
      const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / (0.4 * s)));
      return Array.from({ length: n + 1 }, (_, k) => at(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, extra));
    };
    // 绕着一格画一圈
    const circle = (c: number, r: number): Pointer[] => Array.from({ length: 25 }, (_, k) => at(w.mesh.x[c] + r * s * Math.cos((k * Math.PI) / 12), w.mesh.y[c] + r * s * Math.sin((k * Math.PI) / 12)));

    const log: unknown[] = [];
    const record = async (name: string, t: ToolHandler, act: (t: ToolHandler) => Promise<Preview | null>) => {
      vi.mocked(exec).mockClear();
      toast.value = null;
      const pv = await act(t);
      log.push({
        name,
        preview: pv ? summary(pv) : null,
        sent: vi.mocked(exec).mock.calls.map((c) => ({ cmd: c[0] as Command, busy: c[1] ?? null, head: typeof c[3] })),
        toast: (toast.value as { text: string } | null)?.text ?? null,
      });
    };
    // 按住拖过这串点再松手；返回松手前的预览
    const drag = async (t: ToolHandler, pts: Pointer[]) => {
      t.move?.(pts[0], false);
      t.down?.(pts[0]);
      for (const p of pts.slice(1)) t.move?.(p, true);
      const pv = t.preview();
      await t.up?.(pts[pts.length - 1]);
      return pv;
    };
    const click = async (t: ToolHandler, p: Pointer) => {
      t.move?.(p, false);
      const pv = t.preview();
      await t.click?.(p);
      return pv;
    };
    const tap = async (t: ToolHandler, p: Pointer) => drag(t, [p, p]);

    const far = find((i) => w.causes.land[i] === 1 && Math.hypot(w.mesh.x[i] - w.mesh.x[coast], w.mesh.y[i] - w.mesh.y[coast]) > 3 * s && Math.hypot(w.mesh.x[i] - w.mesh.x[coast], w.mesh.y[i] - w.mesh.y[coast]) < 5 * s);
    // 地形
    setOptions({ landMode: 'land', landShape: 'brush' });
    await record('画陆地', landTool(), (t) => drag(t, line(coast, far)));
    await record('画海（Shift）', landTool(), (t) => drag(t, line(coast, far, { shift: true })));
    setOptions({ landShape: 'lasso' });
    await record('圈一片', landTool(), (t) => drag(t, circle(coast, 3)));
    setOptions({ landShape: 'brush' });
    const island = islandTool();
    await record('放岛（点一下）', island, (t) => tap(t, atCell(sea)));
    await record('放岛（拖出大小）', island, (t) => drag(t, [atCell(sea2), at(w.mesh.x[sea2] + 3 * s, w.mesh.y[sea2])]));
    await record('湖里放岛', island, (t) => tap(t, atCell(inland)));
    const chain = chainTool();
    await record('岛链', chain, (t) => drag(t, line(sea, sea2)));
    setOptions({ chainFrag: 0.3 });
    await record('岛链（碎岛）', chain, (t) => drag(t, line(sea2, sea)));
    setOptions({ chainFrag: 0 });
    setOptions({ reliefMode: 'up', reliefAmount: 0.7 });
    await record('堆山', reliefTool(), (t) => drag(t, line(inland, far)));
    await record('压低（Shift）', reliefTool(), (t) => drag(t, line(inland, far, { shift: true })));
    setOptions({ fragMode: 'blocks', fragAmount: 0.5 });
    await record('打碎', fragmentTool(), (t) => drag(t, line(coast, far)));
    setOptions({ fragMode: 'coast' });
    await record('只打碎海岸', fragmentTool(), (t) => drag(t, line(coast, far)));
    await record('重画这一片', rerollTool(), (t) => click(t, atCell(coast)));
    await record('恢复原样', restoreTool(), (t) => drag(t, line(coast, far)));
    // 气候
    setOptions({ tempMode: 'warm', moistMode: 'dry' });
    await record('冷暖', climateTool('temp'), (t) => drag(t, line(inland, far)));
    await record('冷暖（Shift）', climateTool('temp'), (t) => drag(t, line(inland, far, { shift: true })));
    await record('干湿', climateTool('moist'), (t) => drag(t, line(inland, far)));
    await record('擦掉冷暖干湿', climateEraseTool(), (t) => drag(t, line(inland, far)));
    setOptions({ fieldMode: 'add', fieldAmount: 0.25 });
    await record('涂自定义场', fieldTool(), (t) => drag(t, line(inland, far)));
    // 自然
    setOptions({ biomeMode: 'natural' });
    await record('涂生态', biomeTool(), (t) => drag(t, line(inland, far)));
    setOptions({ biomeMode: 'force' });
    await record('涂生态（强制）', biomeTool(), (t) => drag(t, line(inland, far)));
    await record('拖动扩张', growTool(), (t) => drag(t, line(far, coast)));
    await record('擦除', eraseTool(), (t) => drag(t, line(inland, far)));
    rangePick.value = { species: sp.id, kind: 'cells', back: 'biome' };
    await record('选范围（圈一片）', rangeTool(), (t) => drag(t, circle(far, 3)));
    rangePick.value = { species: sp.id, kind: 'island', back: 'biome' };
    await record('选范围（点岛）', rangeTool(), (t) => click(t, atCell(far)));
    rangePick.value = null;
    // 水系
    setOptions({ riverMode: 'course', riverEnd: 'flow', riverFlow: 4 });
    await record('画河（自定义走向）', riverTool(() => ZOOM), (t) => drag(t, line(far, coast)));
    selectedRiver.value = null;
    setOptions({ riverMode: 'flow' });
    await record('画河（顺地势，点一下）', riverTool(() => ZOOM), (t) => tap(t, atCell(far)));
    selectedRiver.value = null;
    const lakeAt = find((i) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1 && ring(i, 5).every((c) => w.causes.land[c] && w.derived.lake[c] !== 1));
    await record('放湖', lakeTool(), (t) => tap(t, atCell(lakeAt)));
    await record('放湖（拖出大小）', lakeTool(), (t) => drag(t, [atCell(lakeAt), at(w.mesh.x[lakeAt] + 2 * s, w.mesh.y[lakeAt])]));
    await record('点湖选中', lakeTool(), (t) => tap(t, atCell(inland)));
    selectedLake.value = null;
    await record('删除湖', unwaterTool(() => ZOOM), (t) => click(t, atCell(inland)));
    // 省份
    const p0 = w.causes.province[far];
    const nb = (() => {
      for (const c of ring(far, 8)) if (w.causes.province[c] >= 0 && w.causes.province[c] !== p0 && w.small.provinces[w.causes.province[c]]?.land) return c;
      throw new Error('没有邻省');
    })();
    selectedProvince.value = p0;
    await record('涂省', provinceBrushTool(), (t) => drag(t, line(far, nb)));
    await record('剪刀', provinceCutTool(() => ZOOM), (t) => drag(t, line(far, inland)));
    selectedProvince.value = null;
    await record('重新划分', provinceRegenTool(), (t) => drag(t, line(inland, far)));
    // 地名
    const noLabel = () => null;
    await record('圈一块起名', regionTool(noLabel), (t) => drag(t, circle(far, 3)));
    await record('放一个地名', spotTool(noLabel, () => ZOOM), (t) => click(t, atCell(far)));

    // 拖出大小之后底部条上的滑块停在拖出的大小
    log.push({ sizes: [options.value.islandKm, options.value.lakeKm] });
    await expect(JSON.stringify(log, null, 1)).toMatchFileSnapshot('./__snapshots__/tool-replay.json');
  });
});
