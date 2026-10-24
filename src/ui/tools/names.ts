import { type GeoFeature, REGION_KIND_INFO, guessRegionKind } from '../../../core/features';
import { ringCells } from '../../../core/select';
import type { RegionKind, World } from '../../../core/world';
import { exec, focusName, selectedFeature, showToast, world } from '../../state';
import { EMPTY, type Pointer, type RGB, type ToolHandler, aroundPole, isBusy, keepX, worldId } from './api';
import { POLE_HINT, POLE_TOAST, lassoAdd, lassoShapes } from './gestures';
import { shownAt } from './provinces';

// 地名：改名、圈一块起名、放一个地名。hitLabel：屏幕上这一点是哪个地名的字（地图给的）

// 地名模式：点地图上的字选中地名；点在别处则选中这里最小的要素
export function renameTool(hitLabel: (sx: number, sy: number) => string | null): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    click(p) {
      const w = world.value;
      if (!w) return;
      const key = hitLabel(p.sx, p.sy);
      if (key) {
        selectedFeature.value = key;
        return;
      }
      // 屏幕上这一点画成陆地就找陆上的地名，画成海就找海上的
      const cell = shownAt(w, p)?.here ?? -1;
      if (cell < 0) return;
      let best: GeoFeature | null = null;
      for (const f of w.derived.features) if (f.cells.includes(cell) && (!best || f.areaKm2 < best.areaKm2)) best = f;
      selectedFeature.value = best?.key ?? null;
    },
    preview() {
      if (!pointer) return EMPTY;
      const key = hitLabel(pointer.sx, pointer.sy);
      return { layers: [], shapes: [], hint: key ? '点一下改名' : null };
    },
  };
}

// 刚加上的地名：选中它，底部条的名字框直接可以打字
function selectNewRegion() {
  const w = world.value;
  const r = w?.small.regions[w.small.regions.length - 1];
  if (!r) return;
  selectedFeature.value = `region:${r.id}`;
  focusName.value = `region:${r.id}`;
}

const fmtArea = (km2: number) => (km2 >= 1e4 ? `${(km2 / 1e4).toFixed(km2 >= 1e5 ? 0 : 1)} 万 km²` : `${Math.round(km2).toLocaleString()} km²`);
const REGION_RGB: RGB = [255, 225, 120];

// 圈一块起名：按住画一个圈，圈里的格成为一个地名区块（类型“自动”：按圈里现在的地形判断，之后涂了沙漠就变成沙漠；底部条上可以改成固定的）。
// 预览高亮的格就是区块；点在地名上（不拖）是选中那个地名
export function regionTool(hitLabel: (sx: number, sy: number) => string | null): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  let ringId = 0;
  let committing = false;
  let cache: { key: string; cells: number[]; kind: Exclude<RegionKind, 'spot'>; km2: number } | null = null;
  const compute = (w: World, pts: [number, number][]) => {
    const key = `${worldId(w)}|${ringId}|${pts.length}`;
    if (cache?.key === key) return cache;
    const cells = ringCells(w, pts);
    let km2 = 0;
    for (const c of cells) km2 += w.mesh.area[c] * w.kmPerUnit * w.kmPerUnit;
    cache = { key, cells, kind: cells.length ? guessRegionKind(w, w.derived, cells) : 'region', km2 };
    return cache;
  };
  return {
    drags: true,
    down(p) {
      if (!world.value || isBusy() || committing) return;
      ring = [[p.x, p.y]];
      ringId++;
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !ring || !w || committing) return;
      lassoAdd(w, ring, p);
    },
    async up(p) {
      const w = world.value;
      const pts = ring;
      if (!w || !pts || committing) return;
      if (aroundPole(w, pts)) {
        ring = null;
        showToast(POLE_TOAST, true);
        return;
      }
      const c = pts.length >= 3 ? compute(w, pts) : null;
      if (!c || c.cells.length < 3) {
        ring = null;
        const key = hitLabel(p.sx, p.sy);
        if (key) selectedFeature.value = key;
        else showToast('圈太小了：按住拖一圈再松手', true);
        return;
      }
      committing = true;
      try {
        if (await exec({ op: 'add_region', region: { kind: c.kind, cells: c.cells, auto: true } }, '正在起名…')) selectNewRegion();
      } finally {
        committing = false;
        ring = null;
      }
    },
    cancel() {
      if (!committing) ring = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || !ring) return EMPTY;
      const shapes = lassoShapes(ring);
      if (ring.length < 3) return { layers: [], shapes, hint: null };
      if (aroundPole(w, ring)) return { layers: [], shapes, hint: POLE_HINT, warn: true };
      const c = compute(w, ring);
      return {
        layers: [{ cells: c.cells, color: REGION_RGB, alpha: 0.4 }],
        shapes,
        hint: committing ? '正在起名…' : c.cells.length ? `${REGION_KIND_INFO[c.kind].label} · ${fmtArea(c.km2)}` : null,
      };
    },
  };
}

// 放一个地名：点一下放一个点状地名（城镇、渡口、海角……），名字按那里的地形自动起，可以直接改。
// 点在已有的地名上是选中它
export function spotTool(hitLabel: (sx: number, sy: number) => string | null, zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave() {
      pointer = null;
    },
    async click(p) {
      const w = world.value;
      if (!w || isBusy()) return;
      const key = hitLabel(p.sx, p.sy);
      if (key) {
        selectedFeature.value = key;
        return;
      }
      if (p.cell < 0) return;
      const round = (v: number) => Math.round(v * 1e5) / 1e5;
      if (await exec({ op: 'add_region', region: { kind: 'spot', cells: [p.cell], at: [round(keepX(w, p.x)), round(p.y)] } }, '正在起名…')) selectNewRegion();
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0 || hitLabel(pointer.sx, pointer.sy)) return EMPTY;
      return { layers: [], shapes: [{ kind: 'circle', x: pointer.x, y: pointer.y, r: 4 / zoom(), color: 'rgba(255, 255, 255, 0.95)', width: 2 }], hint: null };
    },
  };
}
