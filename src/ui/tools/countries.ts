import { hexToRgb } from '../../../core/export';
import { ringCells } from '../../../core/select';
import type { CountryMeta, World } from '../../../core/world';
import type { HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { askUser, exec, options, selectedCountry, setOptions, sheet, showToast, world } from '../../state';
import { NO_COUNTRIES, cellsOf, countryAt, countryOf, hasCountries, largestCountry, mergeCommand, newCountryCommand, territoryCommand } from '../countries';
import { type Backdrop, BLOCKED_RGB, EMPTY, type Pointer, type RGB, type ToolHandler, WHITE, aroundPole, guard, isBusy, worldId } from './api';
import { brushTool } from './brush';
import { POLE_HINT, POLE_TOAST, lassoAdd, lassoShapes } from './gestures';

// “国家”一类的工具（第二十三轮）：选国家（点一下打开档案）、领土（paint_country）、新建国家（点一个省份或圈一片）、
// 合并（先点一国，再点要并进来的）。都只改陆地（湖面也算）；海上的领海由领土推出来

// 能画领土的格：陆地（湖面也算）
export const countryLand = (w: World, i: number) => w.causes.land[i] === 1;

// 这一点画的是哪一格（屏幕上的陆海、切线两边，见 core/display.ts）
const cellOf = (p: Pointer) => p.shown?.here ?? p.cell;

export const countryName = (w: World, id: number | null) => (id ? (countryOf(w, id)?.name ?? String(id)) : '无主地');
const rgbOf = (m: CountryMeta | undefined): RGB => (m ? hexToRgb(m.color) : WHITE);

// 选中国家并打开档案
export function selectCountry(id: number | null, open = true) {
  selectedCountry.value = id;
  if (id !== null && open) sheet.value = 'country';
  if (id === null && sheet.value === 'country') sheet.value = null;
}

// ---------- 首都与选中的国家：几个工具一直画着（第二十七轮：首都在城市、格、国家的档案里改） ----------

const STAR = Array.from({ length: 11 }, (_, k) => {
  const a = -Math.PI / 2 + (k * Math.PI) / 5;
  const r = k % 2 ? 0.45 : 1;
  return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
});

// 首都：每国一颗星（选中的国家的大一些、描一道黄边）
export function capitalShapes(w: World, zoom: number, sel: number | null): Shape[] {
  if (!hasCountries(w)) return [];
  const out: Shape[] = [];
  for (const m of Object.values(w.small.countries!)) {
    if (m.capitalCell === undefined) continue;
    const x = w.mesh.x[m.capitalCell];
    const y = w.mesh.y[m.capitalCell];
    const on = m.id === sel;
    const r = (on ? 8 : 5.5) / zoom;
    out.push({ kind: 'circle', x, y, r: r * 0.9, color: m.color, fill: true, width: 1 });
    out.push({ kind: 'line', points: STAR.map(([a, b]) => [x + a * r * 0.8, y + b * r * 0.8]), color: 'rgba(255, 255, 255, 0.95)', width: on ? 1.6 : 1.2 });
    out.push({ kind: 'circle', x, y, r: r * 0.9, color: on ? 'rgba(255, 225, 77, 0.95)' : 'rgba(20, 20, 24, 0.75)', width: on ? 2.2 : 1 });
  }
  return out;
}

// 选中的国家：描出领土的外沿（按领土数组缓存同一个图层）
let selMemo: { c: Int32Array | undefined; id: number; layer: HighlightLayer } | null = null;
export function selectedLayer(w: World): HighlightLayer | null {
  const id = selectedCountry.value;
  if (id === null || !countryOf(w, id)) return null;
  if (!selMemo || selMemo.c !== w.causes.country || selMemo.id !== id) selMemo = { c: w.causes.country, id, layer: { cells: cellsOf(w, id), color: [255, 255, 255], alpha: 0.18 } };
  return selMemo.layer;
}

function backdropOf(w: World, zoom: number): Backdrop {
  const l = selectedLayer(w);
  return { layers: l ? [l] : [], shapes: capitalShapes(w, zoom, selectedCountry.value) };
}

// 一国的领土（悬停时淡淡地亮）：按领土数组与编号缓存
let hoverMemo: { c: Int32Array | undefined; id: number; color: string; layer: HighlightLayer } | null = null;
function hoverLayer(w: World, id: number, color: RGB = [255, 255, 255], alpha = 0.3): HighlightLayer {
  const key = color.join(',');
  if (!hoverMemo || hoverMemo.c !== w.causes.country || hoverMemo.id !== id || hoverMemo.color !== key) hoverMemo = { c: w.causes.country, id, color: key, layer: { cells: cellsOf(w, id), color, alpha } };
  return hoverMemo.layer;
}

// ---------- 选国家 ----------

export function countrySelectTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave() {
      pointer = null;
    },
    click(p) {
      const w = world.value;
      if (!w || p.cell < 0 || !hasCountries(w)) return;
      selectCountry(countryAt(w, cellOf(p)));
    },
    backdrop() {
      const w = world.value;
      return w ? backdropOf(w, zoom()) : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      if (!hasCountries(w)) return { ...EMPTY, hint: NO_COUNTRIES, warn: true };
      const id = countryAt(w, cellOf(pointer));
      if (!id) return { ...EMPTY, hint: w.causes.land[cellOf(pointer)] ? '无主地' : null };
      return { layers: [hoverLayer(w, id)], shapes: [], hint: countryName(w, id) };
    },
  };
}

// ---------- 领土 ----------

// 领土笔刷涂给谁：选着的（0 是无主地）；没选、选的那国没了时是选中的国家，再没有时是最大的那国
export function chosenTerritory(w: World): { id: number | null; meta?: CountryMeta } | undefined {
  if (!hasCountries(w)) return undefined;
  const t = options.value.territory;
  if (t === 0) return { id: null };
  const m = countryOf(w, t > 0 ? t : null) ?? countryOf(w, selectedCountry.value) ?? largestCountry(w);
  return m ? { id: m.id, meta: m } : undefined;
}

// 这一笔里真改了的格（已经是这国的不算）
const changed = (w: World, cells: number[], id: number | null) => cells.filter((i) => (w.causes.country?.[i] ?? -1) !== (id ?? -1)).length;

export function territoryTool(zoom: () => number): ToolHandler {
  const label = (t: { id: number | null }, w: World) => (t.id === null ? '无主地' : `领土“${countryName(w, t.id)}”`);
  return brushTool({
    hint: () => {
      const w = world.value;
      if (w && !hasCountries(w)) return { text: NO_COUNTRIES, warn: true };
      return { text: null };
    },
    filter: countryLand,
    here: (w, _cells, p) => {
      if (!hasCountries(w) || p.cell < 0 || !countryLand(w, p.cell)) return null;
      return `这里：${countryName(w, countryAt(w, p.cell))}`;
    },
    layers(w, s) {
      const t = chosenTerritory(w);
      if (!t) return { layers: [{ cells: s.cells, color: BLOCKED_RGB, alpha: 0.5 }], hint: NO_COUNTRIES, warn: true };
      const k = changed(w, s.cells, t.id);
      return {
        layers: [{ cells: s.cells, color: t.id === null ? WHITE : rgbOf(t.meta), alpha: t.id === null ? 0.45 : 0.7 }],
        hint: s.t.size ? (k ? `${label(t, w)} · ${k} 格` : `已经是${t.id === null ? '无主地' : `“${countryName(w, t.id)}”`}`) : '这里没有陆地',
        warn: !k,
      };
    },
    backdrop: (w) => backdropOf(w, zoom()),
    async commit(w, s) {
      const t = chosenTerritory(w);
      if (!t || !s.t.size || !changed(w, s.cells, t.id)) return;
      await exec(territoryCommand(s.cells, t.id), '正在计算…');
    },
  });
}

// Alt+点：吸取这一格的国家（无主地吸取“无主”）
export function pickTerritory(w: World, cell: number): string | null {
  if (!hasCountries(w) || !countryLand(w, cell)) return null;
  const id = countryAt(w, cell);
  setOptions({ territory: id ?? 0 });
  return countryName(w, id);
}

// ---------- 新建国家 ----------

// 一个省份的陆地格（海省、没有省份时为空）
function provinceLand(w: World, cell: number): { id: number; cells: number[] } | null {
  const p = cell >= 0 ? w.causes.province[cell] : -1;
  if (p < 0 || !w.causes.land[cell] || !w.small.provinces[p]) return null;
  const cells: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.province[i] === p && w.causes.land[i]) cells.push(i);
  return { id: p, cells };
}

// 新建以后选中它、打开档案（新的编号是建之前的 nextCountry）
async function create(w: World, cells: number[]) {
  const next = w.small.nextCountry ?? Math.max(0, ...Object.keys(w.small.countries ?? {}).map(Number)) + 1;
  if (await exec(newCountryCommand(cells), '正在计算…')) {
    const now = world.value;
    if (now?.small.countries?.[next]) selectCountry(next);
  }
}

export function newCountryTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  let ringId = 0;
  let provMemo: { key: string; v: { id: number; cells: number[] } | null } | null = null;
  let lassoMemo: { key: string; cells: number[] } | null = null;
  const lasso = () => options.value.newCountryShape === 'lasso';
  const provinceAt = (w: World, p: Pointer) => {
    const key = `${worldId(w)}|${w.causes.province[cellOf(p)] ?? -1}`;
    if (provMemo?.key !== key) provMemo = { key, v: provinceLand(w, cellOf(p)) };
    return provMemo.v;
  };
  const ringLand = (w: World, pts: [number, number][]) => {
    const key = `${worldId(w)}|${ringId}|${pts.length}`;
    if (lassoMemo?.key !== key) lassoMemo = { key, cells: ringCells(w, pts).filter((i) => countryLand(w, i)) };
    return lassoMemo.cells;
  };
  return {
    get drags() {
      return lasso();
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (w && pressed && ring) lassoAdd(w, ring, p);
    },
    leave() {
      pointer = null;
    },
    down(p) {
      const w = world.value;
      if (!w || !lasso() || p.cell < 0 || !hasCountries(w) || guard('refuse')) return;
      ring = [[p.x, p.y]];
      ringId++;
    },
    async up() {
      const w = world.value;
      const pts = ring;
      ring = null;
      if (!w || !pts || !lasso()) return;
      if (aroundPole(w, pts)) {
        showToast(POLE_TOAST, true);
        return;
      }
      const cells = pts.length >= 3 ? ringLand(w, pts) : [];
      if (!cells.length) {
        showToast(pts.length < 3 ? '圈太小' : '圈里没有陆地', true);
        return;
      }
      await create(w, cells);
    },
    async click(p) {
      const w = world.value;
      if (!w || lasso() || p.cell < 0 || !hasCountries(w) || isBusy()) return;
      const v = provinceAt(w, p);
      if (!v) {
        showToast(Object.keys(w.small.provinces).length ? '点陆地上的省份' : '没有省份，用“圈一片”', true);
        return;
      }
      await create(w, v.cells);
    },
    cancel() {
      ring = null;
    },
    backdrop() {
      const w = world.value;
      return w ? backdropOf(w, zoom()) : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      if (!hasCountries(w)) return { ...EMPTY, hint: NO_COUNTRIES, warn: true };
      if (lasso()) {
        if (!ring) return EMPTY;
        const shapes = lassoShapes(ring);
        if (ring.length < 3) return { layers: [], shapes, hint: null };
        if (aroundPole(w, ring)) return { layers: [], shapes, hint: POLE_HINT, warn: true };
        const cells = ringLand(w, ring);
        return { layers: [{ cells, color: [255, 236, 140], alpha: 0.45 }], shapes, hint: cells.length ? `新国家 · ${cells.length} 格` : '圈里没有陆地', warn: !cells.length };
      }
      const v = provinceAt(w, pointer);
      if (!v) return { ...EMPTY, hint: Object.keys(w.small.provinces).length ? null : '没有省份，用“圈一片”', warn: !Object.keys(w.small.provinces).length };
      return { layers: [{ cells: v.cells, color: [255, 236, 140], alpha: 0.45 }], shapes: [], hint: `“${w.small.provinces[v.id].name || v.id}”成为新国家` };
    },
  };
}

// ---------- 合并 ----------

// 合并之前问一句（可以撤销）
export async function confirmMerge(w: World, a: number, b: number): Promise<boolean> {
  const v = await askUser({
    title: '合并国家',
    text: `“${countryName(w, b)}”并进“${countryName(w, a)}”，领土与兼容的文化组都归“${countryName(w, a)}”。可以撤销。`,
    choices: [
      { value: 'cancel', label: '取消' },
      { value: 'ok', label: '合并', primary: true },
    ],
  });
  return v === 'ok';
}

export function countryMergeTool(zoom: () => number): ToolHandler {
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
      if (!w || p.cell < 0 || !hasCountries(w) || isBusy()) return;
      const id = countryAt(w, cellOf(p));
      const sel = selectedCountry.value;
      if (!id) return;
      if (sel === null || sel === id || !countryOf(w, sel)) {
        selectCountry(id, false);
        return;
      }
      if (!(await confirmMerge(w, sel, id))) return;
      await exec(mergeCommand(sel, id), '正在计算…');
    },
    backdrop() {
      const w = world.value;
      return w ? backdropOf(w, zoom()) : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      if (!hasCountries(w)) return { ...EMPTY, hint: NO_COUNTRIES, warn: true };
      const id = countryAt(w, cellOf(pointer));
      const sel = selectedCountry.value;
      if (!id) return EMPTY;
      if (sel === null || sel === id || !countryOf(w, sel)) return { layers: [hoverLayer(w, id)], shapes: [], hint: sel === id ? `“${countryName(w, id)}” · 再点要并进来的` : countryName(w, id) };
      return { layers: [hoverLayer(w, id, rgbOf(countryOf(w, sel)), 0.65)], shapes: [], hint: `并进“${countryName(w, sel)}”` };
    },
  };
}
