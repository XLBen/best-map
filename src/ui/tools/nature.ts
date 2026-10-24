import { signal } from '@preact/signals';
import type { PreviewResult } from '../../../core/engine';
import { hexToRgb } from '../../../core/export';
import type { GeoFeature } from '../../../core/features';
import { growRegion, ringCells } from '../../../core/select';
import { explainCell, isVegetated, landmassCells } from '../../../core/vegetation';
import type { World } from '../../../core/world';
import type { HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { type ToolId, type ToolOptions, exec, focusSpecies, options, sheet, showToast, switchTool, world } from '../../state';
import { erasableLayer, natureHere, natureMask } from '../edits';
import { Covered, Exact, slowTail } from '../exact';
import { EMPTY, type Pointer, type ToolHandler, WHITE, aroundPole, isBusy, mapDist, worldId } from './api';
import { brushR, brushTool, exactCounts, oneLayer, optionsId } from './brush';
import { POLE_TOAST, lassoAdd, lassoShapes } from './gestures';

// 自然：涂生态、拖动扩张、擦除、给生态选“长在哪里”

const speciesOf = (w: World, id: string | null) => (id ? w.small.species.find((s) => s.id === id) : undefined);

// 涂生态、拖动扩张发出的命令：自然融入（调整这里的冷暖干湿让它长出来）或强制，过渡的范围
function constraintCmd(cells: number[], species: string, o: ToolOptions) {
  return { op: 'add_constraint' as const, constraint: { cells, species, mode: o.biomeMode === 'natural' ? ('constraint' as const) : ('override' as const), ratio: 1, radius: o.reachKm, label: '' } };
}

// 确切预览的结果怎么说：几格生态会变（没有变的说“生态不变”）
export const biomeChange = (r: PreviewResult) => (r.changedCells.length ? `${r.changedCells.length} 格生态会变` : '生态不变');

// “自然融入”涂一种生态几乎都没涂成时（第十三轮修：幻想生态常常一格都涂不上，只写“没涂成”看不出为什么），
// 用一句话说为什么、怎么办：按一个没涂成的格看它卡在哪里。“强制”时不会没涂成，不说
export function biomeFailWhy(w: World, sp: { id: string; name: string; natural?: boolean }, failing: readonly number[], mode = options.value.biomeMode): string | null {
  if (mode !== 'natural' || !failing.length) return null;
  const e = explainCell(w, w.derived, failing[0]).find((x) => x.species === sp.id);
  if (e && !e.reachable && e.why === 'range') return `涂不上：这里在「${sp.name}」长的范围外，改用“强制”或改它长在哪里`;
  if (sp.natural === false) return `涂不上：这里不合「${sp.name}」的条件，改用“强制”，或打开它的“自然生成”、放宽条件`;
  return `涂不上：这里不合「${sp.name}」的条件，改用“强制”或放宽它的条件`;
}

export function biomeTool(): ToolHandler {
  return brushTool({
    hint: () => {
      const w = world.value;
      const sp = w && speciesOf(w, options.value.biome);
      if (!sp) return { text: '先在右上角“生态”里选一种', warn: true };
      return { text: null };
    },
    filter: (w, i) => isVegetated(w, w.derived, i),
    layers(w, s) {
      const sp = speciesOf(w, options.value.biome)!;
      // 估计：涂到的格淡淡地涂上这种生态的颜色（停一下就换成确切的结果）
      return { layers: [{ cells: s.cells, color: hexToRgb(sp.color), alpha: 0.35 }], hint: `${sp.name} ${s.t.size} 格` };
    },
    exact: (w, s) => (speciesOf(w, options.value.biome) && s.t.size ? constraintCmd(s.cells, options.value.biome!, options.value) : null),
    exactHint(w, s, _shift, r) {
      const sp = speciesOf(w, options.value.biome)!;
      const { changed, failing } = exactCounts(r, s.t.keys());
      const why = failing && failing >= s.t.size * 0.8 ? biomeFailWhy(w, sp, r.failing.filter((c) => s.t.has(c))) : null;
      return why ?? `${sp.name} · ${changed} 格会变${failing ? ` · ${failing} 格没涂成` : ''}`;
    },
    // 自然融入：周围这么远跟着平滑过渡
    reach: (w) => (options.value.biomeMode === 'natural' ? options.value.reachKm / w.kmPerUnit : null),
    commit: (_w, s) => exec(constraintCmd(s.cells, options.value.biome!, options.value), '正在计算生态…'),
  });
}

// 同一种生态、离按下处不超过画笔半径（km）的连片格：拖动扩张的“起点地块”
function patchAt(w: World, cell: number, km: number): number[] {
  const { mesh } = w;
  const s = w.derived.dominant[cell];
  const r = brushR(w, km);
  const out = [cell];
  const seen = new Set(out);
  for (let h = 0; h < out.length; h++) {
    const c = out[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (seen.has(j) || w.derived.dominant[j] !== s || !w.causes.land[j]) continue;
      seen.add(j);
      if (mapDist(w, mesh.x[j], mesh.y[j], mesh.x[cell], mesh.y[cell]) <= r) out.push(j);
    }
  }
  return out;
}

// 拖动扩张：按住一片生态往外拖。手停下 250 毫秒时确切地预览（与涂生态同一套：变了的格描边，之后多拖出来的格淡淡地涂上），
// 松手执行同一条命令
export function growTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let start: { x: number; y: number; cell: number; region: number[]; species: number } | null = null;
  let committing = false;
  let cache: { key: string; grown: number[] } | null = null;
  const ex = new Exact();
  // 确切预览算的时候扩张到了哪些格（之后多出来的格另外淡淡地涂上）
  const covered = new Covered();
  const grownNow = (w: World): number[] => {
    if (!start || !pointer) return [];
    const dx = pointer.x - start.x;
    const dy = pointer.y - start.y;
    const reach = mapDist(w, pointer.x, pointer.y, start.x, start.y) * w.kmPerUnit;
    const key = `${worldId(w)}|${start.cell}|${dx.toFixed(5)},${dy.toFixed(5)}|${options.value.brushKm}`;
    if (cache?.key !== key) cache = { key, grown: reach > 0 ? growRegion(w, w.derived, start.region, start.species, reach, [dx, dy], [start.x, start.y]) : [] };
    return cache.grown;
  };
  return {
    drags: true,
    down(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy() || committing) return;
      const s = w.derived.dominant[p.cell];
      if (s < 0 || !isVegetated(w, w.derived, p.cell)) {
        showToast('在一片有生态的陆地上按住，再往外拖', true);
        return;
      }
      start = { x: p.x, y: p.y, cell: p.cell, region: patchAt(w, p.cell, options.value.brushKm), species: s };
      pointer = p;
      ex.clear();
      covered.clear();
    },
    move(p) {
      pointer = p;
    },
    async up() {
      const w = world.value;
      if (!w || !start || committing) return;
      const grown = grownNow(w);
      const sp = w.small.species[start.species];
      // 不再算新的确切预览；已经算好的一直显示到结果换上
      ex.stop();
      if (!grown.length || !sp) {
        start = null;
        ex.clear();
        return;
      }
      committing = true;
      try {
        await exec(constraintCmd(grown, sp.id, options.value), '正在计算生态…');
      } finally {
        committing = false;
        start = null;
        cache = null;
        ex.clear();
      }
    },
    cancel() {
      if (!committing) {
        start = null;
        ex.clear();
      }
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      if (!start) {
        const c = pointer.cell;
        const s = c >= 0 ? w.derived.dominant[c] : -1;
        if (s < 0) return EMPTY;
        const sp = w.small.species[s];
        return {
          layers: [{ cells: patchAt(w, c, options.value.brushKm), color: WHITE, alpha: 0.3 }],
          shapes: [],
          hint: sp.name,
        };
      }
      const sp = w.small.species[start.species];
      const grown = grownNow(w);
      const shapes: Shape[] = [{ kind: 'arrow', points: [[start.x, start.y], [pointer.x, pointer.y]], color: 'rgba(255, 240, 140, 0.95)', width: 2.5 }];
      const key = `${cache?.key}|${optionsId()}`;
      if (!committing && grown.length && sp) {
        ex.want(key, () => {
          if (world.value !== w || `${cache?.key}|${optionsId()}` !== key) return null;
          covered.note(key, grown);
          return constraintCmd(grown, sp.id, options.value);
        });
      }
      const v = ex.view;
      const slow = slowTail(ex.slow);
      if (v && sp) {
        // 确切预览：地图画出将来的世界，变了的格描边；之后多拖出来的格淡淡地涂上
        const { changed, failing } = exactCounts(v.result, grown);
        return {
          layers: covered.layers(v, [{ cells: grown, color: hexToRgb(sp.color), alpha: 0.35 }]),
          shapes,
          hint: committing ? '正在计算…' : v.key === key ? `${sp.name} +${grown.length} 格 · ${changed} 格会变${failing ? ` · ${failing} 格没涂成` : ''}` : `${sp.name} +${grown.length} 格${slow || '…'}`,
          world: v.world,
        };
      }
      return {
        layers: [
          { cells: start.region, color: WHITE, alpha: 0.3 },
          { cells: grown, color: hexToRgb(sp.color), alpha: 0.8 },
        ],
        shapes,
        hint: committing ? '正在计算…' : `${sp.name} +${grown.length} 格${slow}`,
      };
    },
  };
}

// 自然的擦除：擦掉涂过的生态。选中时地图上一直用浅斜线标出涂过的格，悬停说这里涂成了什么
export function eraseTool(): ToolHandler {
  return brushTool({
    hint: () => ({ text: null }),
    filter: (w, i) => natureMask(w).has[i] === 1,
    backdrop: (w) => oneLayer(erasableLayer(natureMask(w))),
    here: (w, cells) => natureHere(w, cells),
    layers(_w, s) {
      return { layers: [{ cells: s.cells, color: WHITE, alpha: 0.6 }], hint: s.t.size ? `擦掉 ${s.t.size} 格` : '这里没涂过' };
    },
    exact: (_w, s) => (s.t.size ? { op: 'erase_constraints', cells: s.cells } : null),
    exactHint: (_w, s, _shift, r) => `擦掉 ${s.t.size} 格 · ${biomeChange(r)}`,
    async commit(_w, s) {
      if (!s.t.size) {
        showToast('这里没有涂过的生态', true);
        return;
      }
      await exec({ op: 'erase_constraints', cells: s.cells }, '正在计算生态…');
    },
  });
}

// ---------- 第十二轮：给生态选“长在哪里” ----------

// 每格属于哪个陆块要素（大陆或岛），按世界缓存
const landmassCache = new WeakMap<World, Map<number, GeoFeature>>();
function landmassOf(w: World, cell: number): GeoFeature | null {
  let m = landmassCache.get(w);
  if (!m) {
    m = new Map();
    for (const f of w.derived.features) if (f.type === 'island' || f.type === 'continent') for (const c of f.cells) m.set(c, f);
    landmassCache.set(w, m);
  }
  return m.get(cell) ?? null;
}

// 岛在哪个群岛里（没有时 null）。群岛的名字标在地图上时，岛自己的名字常常让开不标：说岛时带上群岛的名字
const archipelagoCache = new WeakMap<World, Map<number, GeoFeature>>();
function archipelagoOf(w: World, f: GeoFeature): GeoFeature | null {
  let m = archipelagoCache.get(w);
  if (!m) {
    m = new Map();
    for (const a of w.derived.features) if (a.type === 'archipelago') for (const c of a.cells) m.set(c, a);
    archipelagoCache.set(w, m);
  }
  return m.get(f.anchor) ?? m.get(f.cells[0]) ?? null;
}

// 岛的叫法：在群岛里的写成“炎柳岛（二雁列岛）”
function islandLabel(w: World, f: GeoFeature): string {
  const a = archipelagoOf(w, f);
  return a?.name && a.name !== f.name ? `${f.name}（${a.name}）` : f.name;
}

// 生态编辑器里点“选岛”“圈一下”进来：点一个岛（那块陆地）或按住圈一片，选好回到生态编辑器。
// back：进来之前用的工具（选好、取消都换回它）
export const rangePick = signal<{ species: string; kind: 'island' | 'cells'; back: ToolId } | null>(null);

// 选好、取消：换回原来的工具，打开生态编辑器
function leaveRangePick() {
  const pick = rangePick.value;
  rangePick.value = null;
  if (!pick) return;
  focusSpecies.value = pick.species;
  sheet.value = 'species';
  switchTool(pick.back);
}
export const cancelRangePick = leaveRangePick;

export function rangeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  // 鼠标下的那块陆地（同一块不重算）
  let mass: { w: World; mask: Uint8Array; cells: number[]; layer: HighlightLayer } | null = null;
  const massAt = (w: World, cell: number) => {
    if (cell < 0 || w.causes.land[cell] !== 1) return null;
    if (mass?.w !== w || !mass.mask[cell]) {
      const mask = landmassCells(w, cell);
      const cells: number[] = [];
      for (let i = 0; i < mask.length; i++) if (mask[i]) cells.push(i);
      mass = { w, mask, cells, layer: { cells, color: WHITE, alpha: 0.35 } };
    }
    return mass;
  };
  const target = () => {
    const pick = rangePick.value;
    const w = world.value;
    return pick && w ? { pick, w, sp: w.small.species.find((x) => x.id === pick.species) ?? null } : null;
  };
  const commit = async (range: { kind: 'island'; cell: number } | { kind: 'cells'; cells: number[] }, what: string) => {
    const t = target();
    if (!t?.sp) return leaveRangePick();
    const ok = await exec({ op: 'update_species', id: t.sp.id, patch: { range } }, '正在计算生态…', undefined, `「${t.sp.name || t.sp.id}」只长在${what}`);
    if (ok) leaveRangePick();
  };
  return {
    // 点岛时是单击类工具（按住拖动是平移地图），圈一片时按住画圈
    get drags() {
      return rangePick.value?.kind === 'cells';
    },
    down(p) {
      const t = target();
      if (!t || t.pick.kind !== 'cells' || p.cell < 0) return;
      if (isBusy()) return;
      ring = [[p.x, p.y]];
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !ring || !w) return;
      lassoAdd(w, ring, p);
    },
    leave() {
      pointer = null;
    },
    cancel() {
      ring = null;
    },
    async click(p) {
      const t = target();
      if (!t || t.pick.kind !== 'island' || isBusy()) return;
      const m = massAt(t.w, p.cell);
      if (!m) {
        showToast('点一块陆地（岛或大陆）', true);
        return;
      }
      const f = landmassOf(t.w, p.cell);
      await commit({ kind: 'island', cell: p.cell }, f?.name ? `「${islandLabel(t.w, f)}」上` : '这块陆地上');
    },
    async up() {
      const t = target();
      const pts = ring;
      ring = null;
      if (!t || t.pick.kind !== 'cells' || !pts) return;
      if (aroundPole(t.w, pts)) {
        showToast(POLE_TOAST, true);
        return;
      }
      const cells = pts.length >= 3 ? ringCells(t.w, pts).filter((i) => t.w.causes.land[i] === 1) : [];
      if (!cells.length) {
        showToast('圈里没有陆地：按住拖一圈再松手', true);
        return;
      }
      await commit({ kind: 'cells', cells }, `圈的 ${cells.length} 格里`);
    },
    preview() {
      const t = target();
      if (!t || !pointer) return EMPTY;
      const name = t.sp?.name || t.pick.species;
      if (t.pick.kind === 'island') {
        const m = massAt(t.w, pointer.cell);
        if (!m) return { layers: [], shapes: [], hint: `点一块陆地：「${name}」只长在那上面` };
        const f = landmassOf(t.w, pointer.cell);
        return { layers: [m.layer], shapes: [], hint: `「${name}」只长在${f?.name ? `「${islandLabel(t.w, f)}」` : '这块陆地'}上（${m.cells.length} 格）` };
      }
      if (!ring) return { layers: [], shapes: [], hint: `按住圈一片：「${name}」只长在圈里` };
      const shapes = lassoShapes(ring);
      if (ring.length < 3) return { layers: [], shapes, hint: null };
      const cells = ringCells(t.w, ring).filter((i) => t.w.causes.land[i] === 1);
      return { layers: cells.length ? [{ cells, color: WHITE, alpha: 0.35 }] : [], shapes, hint: `圈里 ${cells.length} 格陆地` };
    },
  };
}
