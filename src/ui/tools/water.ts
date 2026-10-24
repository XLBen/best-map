import { lakeArea } from '../../../core/elevation';
import { roundKm as km } from '../../../core/terrain';
import type { World } from '../../../core/world';
import type { GhostEdit, HighlightLayer } from '../../render/colors';
import { exec, lakeRange, mode, options, selectedLake, setOptions, showToast, world } from '../../state';
import { chosenLakeType, lakeCellsAt, lakeInfo, lakeRefAt, lakeSizeDraft } from '../lakeInfo';
import { ghostFollows, queueHint, trackEdit } from '../pending';
import { EMPTY, type Pointer, type Preview, type RGB, type ToolHandler, WHITE, guard, worldId } from './api';
import { type Settled, type SizeDrag, dragTo, movedAway, sizeLine, startDrag } from './gestures';

// 水系：放湖（画河、删除河湖在 ../river/tool.ts），河的大小、流量的写法

// 河的大小（“河流多少”门槛的倍数）叫什么
export const riverSizeName = (flow: number) => (flow < 3 ? '小河' : flow < 15 ? '中等的河' : '大河');

// 流量取两位有效数字，好读
export const fmtFlow = (q: number) => {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(q, 1))) - 1));
  return (Math.round(q / p) * p).toLocaleString();
};

// 点一下：用底部滑块的大小放湖；按住往外拖：拖多远湖就多大。前面的编辑还在算时也能放（排队）。
// 点在湖上是选中它（底部条换成这个湖的设置）；选着一个湖时点别处只是取消选择。
// provinceView：底图是不是省份着色（是时湖面另涂一层湖蓝，见 preview）
const LAKE_PICK: RGB = [255, 236, 150];
export function lakeTool(provinceView = () => mode.value === 'provinces'): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: SizeDrag | null = null;
  // 按下时点在湖上：松手时没拖开就选中它；按住拖开了就照常拖出一个新湖（可以放在已有的湖上）
  let pick: { cell: number; x: number; y: number; sx: number; sy: number } | null = null;
  // 鼠标下的湖（悬停时描出来）：按格缓存
  let hover: { key: string; cells: number[] } | null = null;
  const hoverLake = (w: World, cell: number) => {
    const key = `${worldId(w)}|${cell}`;
    if (hover?.key !== key) hover = { key, cells: lakeCellsAt(w, cell) };
    return hover.cells;
  };
  let settled: Settled = null;
  let cache: { key: string; cells: number[]; ghost: GhostEdit } | null = null;
  const centerOf = () => drag ?? (pointer && pointer.cell >= 0 ? pointer : null);
  const radiusNow = () => drag?.km ?? options.value.lakeKm;
  const lakeNow = (w: World) => {
    const c = centerOf();
    if (!c) return null;
    const key = `${worldId(w)}|${c.cell}|${radiusNow()}`;
    // 新湖都带 exact：半径就按给的算（最小只淹一格）
    if (cache?.key !== key) {
      const cells = lakeArea(w, c.cell, radiusNow());
      cache = { key, cells, ghost: { cells: [], delta: [], lake: cells } };
    }
    return cache;
  };
  const cellsNow = (w: World) => lakeNow(w)?.cells ?? [];
  // 碰到海岸的湖会直接流进海里，留不住水
  const coastalOf = (w: World, cells: number[]) =>
    cells.some((c) => {
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return true;
      return false;
    });
  return {
    drags: true,
    down(p) {
      const w = world.value;
      if (!w || p.cell < 0 || !movedAway(settled, p)) return;
      // 点在湖上：选中它（按住拖开是放湖，见 move）；选着一个湖时点别处：取消选择
      if (w.causes.land[p.cell] && w.derived.lake[p.cell]) {
        pointer = p;
        pick = { cell: p.cell, x: p.x, y: p.y, sx: p.sx, sy: p.sy };
        return;
      }
      if (selectedLake.value) {
        selectedLake.value = null;
        return;
      }
      if (guard('queue')) return;
      if (!w.causes.land[p.cell]) {
        showToast('湖要放在陆地上', true);
        return;
      }
      pointer = p;
      drag = startDrag(p);
    },
    move(p, pressed) {
      pointer = p;
      if (movedAway(settled, p)) settled = null;
      const w = world.value;
      if (pressed && pick && w && Math.hypot(p.sx - pick.sx, p.sy - pick.sy) > 6) {
        const at = pick;
        pick = null;
        if (guard('queue')) return;
        selectedLake.value = null;
        drag = startDrag(at);
      }
      if (!pressed || !drag || !w) return;
      dragTo(w, drag, p, () => lakeRange(w));
    },
    async up(p) {
      const w = world.value;
      if (pick) {
        const at = pick;
        pick = null;
        if (w && Math.hypot(p.sx - at.sx, p.sy - at.sy) <= 6) selectedLake.value = lakeRefAt(w, at.cell);
        return;
      }
      const d = drag;
      if (!w || !d) return;
      // 碰到海岸的湖存不住水，放了也看不见：松手时就拦下，不进历史
      const cells = cellsNow(w);
      if (!cells.length || coastalOf(w, cells)) {
        drag = null;
        // 拖出来的大小留着：往内陆挪一点再点，还是这么大
        if (d.km !== null) setOptions({ lakeKm: d.km });
        showToast('离海太近，留不住水：往内陆挪一点', true);
        return;
      }
      const radius = radiusNow();
      drag = null;
      if (d.km !== null) setOptions({ lakeKm: d.km });
      const mark = { sx: p.sx, sy: p.sy };
      settled = mark;
      try {
        // 松手时的湖面留在图上，直到结果换上（鼠标离开地图也留着）。排在前面的编辑先换上了：按新的世界重算湖面
        const shown: Preview = { layers: [], shapes: [], hint: null, ghost: { cells: [], delta: [], lake: cells } };
        const ghostAt = (now: World): GhostEdit => ({ cells: [], delta: [], lake: lakeArea(now, d.cell, radius) });
        await trackEdit(shown, exec({ op: 'add_lake', lake: { cell: d.cell, radius, depth: 120, perennial: true, ...chosenLakeType(w) } }, '正在计算湖泊…'), ghostFollows(shown, w, ghostAt));
      } finally {
        if (settled === mark) settled = null;
      }
    },
    cancel() {
      drag = null;
      pick = null;
    },
    preview() {
      const w = world.value;
      if (!w) return EMPTY;
      // 选着一个湖：描出它；拖底部条的“大小”时画出将来的湖面
      const sel = selectedLake.value;
      if (sel) {
        const info = lakeInfo(w, sel);
        const sz = lakeSizeDraft.value;
        const spec = sz && info?.placed?.id === sz.id ? info.placed : undefined;
        const future = spec && sz ? lakeArea(w, spec.cell, sz.radius) : null;
        const over = pointer && pointer.cell >= 0 && w.derived.lake[pointer.cell] && !info?.cells.includes(pointer.cell) ? hoverLake(w, pointer.cell) : [];
        return {
          layers: [
            ...(info ? [{ cells: future ?? info.cells, color: LAKE_PICK, pattern: 'outline' as const }] : []),
            ...(over.length ? [{ cells: over, color: [255, 255, 255] as RGB, pattern: 'outline' as const }] : []),
          ],
          shapes: [],
          hint: over.length ? '点一下选中这个湖' : null,
          ghost: future ? { cells: [], delta: [], lake: future } : null,
        };
      }
      if (!pointer) return EMPTY;
      if (settled) return { ...EMPTY, hint: '正在计算…' };
      // 鼠标在湖上：描出这个湖，点一下选中它
      if (!drag && pointer.cell >= 0 && w.causes.land[pointer.cell] && w.derived.lake[pointer.cell]) {
        return { layers: [{ cells: hoverLake(w, pointer.cell), color: [255, 255, 255], pattern: 'outline' }], shapes: [], hint: '点一下选中这个湖 · 按住拖开放一个新湖' };
      }
      const c = centerOf();
      if (!c || !w.causes.land[c.cell]) return EMPTY;
      const lake = lakeNow(w);
      const cells = lake?.cells ?? [];
      const coastal = coastalOf(w, cells);
      // 留得住水：地图上直接画出湖面（湖岸照湖的画法）；贴着海：橙色，松手会被拦下。
      // 省份着色开着时（第十三轮修）：省的颜色盖在湖面上，看着像又一个省：湖面另涂一层湖蓝、描一圈白边
      const overFill: HighlightLayer[] =
        !coastal && provinceView()
          ? [
              { cells, color: [70, 125, 175], alpha: 0.75 },
              { cells, color: WHITE, pattern: 'outline' },
            ]
          : [];
      return {
        layers: coastal ? [{ cells, color: [230, 120, 70], alpha: 0.8 }] : overFill,
        shapes: sizeLine(drag, pointer),
        hint: coastal ? '离海太近，留不住水' : (queueHint() ?? `湖 · ${km(radiusNow() * 2)} km`),
        warn: coastal,
        ghost: coastal || !lake ? null : lake.ghost,
      };
    },
  };
}
