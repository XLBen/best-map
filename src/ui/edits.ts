import { placedLakeCell } from '../../core/elevation';
import type { World } from '../../core/world';
import type { HighlightLayer } from '../render/colors';

// 我改过的地方：每格是不是被用户改过（地形、气候、生态、河湖），都从快照里已有的数组算出来，
// 按数组对象缓存（数组没换就不重算，指针移动时不扫整张图）。三个橡皮擦用它在地图上标出能擦的格、
// 悬停时说这里改过什么；图层里的“我改过的地方”用它分色标出。

// 地形改动多大才算“改过”：画笔、放岛边上那一圈很淡的零头不算（恢复原样擦掉它们看不出变化），
// 否则一笔画陆地就会把周围一大片都标上。landness 的单位约是米（海岸值的幅度 180），抬升、岩性是 0–2、0.1–5 的系数
const TERRAIN_EPS = { land: 20, uplift: 0.02, erod: 0.05 };
// 冷暖干湿：0.05 °C、雨水 1%
const CLIMATE_EPS = { temp: 0.05, moist: 0.01 };

export type EditKind = 'terrain' | 'climate' | 'nature' | 'water';

export interface EditMask {
  // 改过的格（升序）
  cells: number[];
  // 每格是否改过（0 / 1）
  has: Uint8Array;
}

// 分色（图层里的“我改过的地方”）：地形橙、气候蓝、生态绿、河湖青
const EDIT_COLORS: Record<EditKind, [number, number, number]> = {
  terrain: [240, 150, 60],
  climate: [110, 150, 255],
  nature: [110, 215, 90],
  water: [70, 220, 235],
};

// 一格的缓存：键里的对象都没换就沿用
function memo<T>(f: (w: World) => T, keys: (w: World) => unknown[]): (w: World) => T {
  let last: { k: unknown[]; v: T } | null = null;
  return (w) => {
    const k = keys(w);
    if (last && last.k.length === k.length && last.k.every((x, i) => x === k[i])) return last.v;
    const v = f(w);
    last = { k, v };
    return v;
  };
}

function fromFlags(has: Uint8Array): EditMask {
  const cells: number[] = [];
  for (let i = 0; i < has.length; i++) if (has[i]) cells.push(i);
  return { cells, has };
}

// 打碎过（第十八轮）：破碎度至少这么多（0–255）才算改过
const FRAG_EPS = 8;
const terrainEdited = (w: World, i: number) => {
  const c = w.causes;
  return Math.abs(c.landDelta[i]) >= TERRAIN_EPS.land || Math.abs(c.upliftDelta[i]) >= TERRAIN_EPS.uplift || Math.abs(c.erodDelta[i]) >= TERRAIN_EPS.erod || (c.fragment?.[i] ?? 0) >= FRAG_EPS;
};

export const terrainMask = memo(
  (w) => {
    const has = new Uint8Array(w.mesh.n);
    for (let i = 0; i < w.mesh.n; i++) if (terrainEdited(w, i)) has[i] = 1;
    return fromFlags(has);
  },
  (w) => [w.causes.landDelta, w.causes.upliftDelta, w.causes.erodDelta, w.causes.fragment],
);

export const climateMask = memo(
  (w) => {
    const { tempOffset: t, moistOffset: m } = w.causes;
    const has = new Uint8Array(w.mesh.n);
    for (let i = 0; i < w.mesh.n; i++) if (Math.abs(t[i]) >= CLIMATE_EPS.temp || Math.abs(m[i]) >= CLIMATE_EPS.moist) has[i] = 1;
    return fromFlags(has);
  },
  (w) => [w.causes.tempOffset, w.causes.moistOffset],
);

// 涂过的生态：每格最后涂成的那一种（后涂的盖住先涂的，与求解相同）
export const natureMask = memo(
  (w) => {
    const has = new Uint8Array(w.mesh.n);
    const species = new Map<number, string>();
    for (const c of w.small.constraints) {
      for (const i of c.cells) {
        if (i >= w.mesh.n) continue;
        has[i] = 1;
        species.set(i, c.species);
      }
    }
    return { ...fromFlags(has), species };
  },
  (w) => [w.mesh, w.small.constraints],
);

// 只长在某个岛上、圈的范围里的生态长着的格（不是涂上去的，擦除擦不掉；只在图层的“我改过的地方”里和涂过的生态一起标绿）
const rangedMask = memo(
  (w) => {
    const has = new Uint8Array(w.mesh.n);
    const ids = new Set<number>();
    w.small.species.forEach((s, k) => {
      if (s.range) ids.add(k);
    });
    if (ids.size) for (let i = 0; i < w.mesh.n; i++) if (ids.has(w.derived.dominant[i])) has[i] = 1;
    return fromFlags(has);
  },
  (w) => [w.mesh, w.small.species, w.derived.dominant],
);

// 画的河（河道经过的格）与放的湖（湖心所在的那一片湖面；干了的湖只标湖心）
export const waterMask = memo(
  (w) => {
    const { mesh } = w;
    const has = new Uint8Array(mesh.n);
    for (const g of w.small.guides) for (const i of g.cells) if (i < mesh.n) has[i] = 1;
    const lake = w.derived.lake;
    for (const l of w.small.lakes) {
      if (l.cell >= mesh.n) continue;
      has[l.cell] = 1;
      // 湖心放了岛：从碗里最近的湖格起（见 placedLakeCell）
      const at = placedLakeCell(w, l, lake);
      if (lake[at] !== 1) continue;
      const stack = [at];
      const seen = new Set(stack);
      while (stack.length) {
        const c = stack.pop()!;
        has[c] = 1;
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (lake[j] === 1 && !seen.has(j)) {
            seen.add(j);
            stack.push(j);
          }
        }
      }
    }
    return fromFlags(has);
  },
  (w) => [w.mesh, w.small.guides, w.small.lakes, w.derived.lake],
);

// 橡皮擦选中时：能擦的格淡淡的白色斜线（同一个掩码给同一个图层对象，不必重新上传）
const hatchLayers = new WeakMap<EditMask, HighlightLayer>();
export function erasableLayer(m: EditMask): HighlightLayer | null {
  if (!m.cells.length) return null;
  let l = hatchLayers.get(m);
  if (!l) hatchLayers.set(m, (l = { cells: m.cells, color: [255, 255, 255], alpha: 0.4, pattern: 'hatch' }));
  return l;
}

// 图层里的“我改过的地方”：四种分色，后面的盖住前面的（河湖最细，放在最上面）；生态连同只长在某处的生态
const fillLayers = new WeakMap<EditMask, HighlightLayer>();
export function editLayers(w: World): HighlightLayer[] {
  const out: HighlightLayer[] = [];
  const kinds: [EditKind, EditMask][] = [
    ['terrain', terrainMask(w)],
    ['climate', climateMask(w)],
    ['nature', natureMask(w)],
    ['nature', rangedMask(w)],
    ['water', waterMask(w)],
  ];
  for (const [k, m] of kinds) {
    if (!m.cells.length) continue;
    let l = fillLayers.get(m);
    if (!l) fillLayers.set(m, (l = { cells: m.cells, color: EDIT_COLORS[k], alpha: 0.42 }));
    out.push(l);
  }
  return out;
}

// ---------- 悬停时说这里改过什么（cells：画笔圈住的格） ----------

const signed = (v: number, digits = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

// 高度变化写成“约 +900 m”：一千米以上取整到百米，一百米以上取整到 50 米；太小返回 null
function meters(v: number): string | null {
  const m = Math.abs(v);
  if (m < 5) return null;
  const step = m >= 1000 ? 100 : m >= 100 ? 50 : 10;
  return `约 ${v > 0 ? '+' : '−'}${(Math.round(m / step) * step).toLocaleString()} m`;
}

// 地形：画过陆地 / 海、堆过山 / 压低过（约多少米）、改过岩石软硬
export function terrainHere(w: World, cells: number[]): string {
  const m = terrainMask(w);
  const c = w.causes;
  let landUp = false;
  let landDown = false;
  let erod = false;
  let frag = false;
  // 抬升改了多少对应的高度变化：高度大致与（0.035 + 抬升）成正比，按这一格现在的高度估计
  let up = 0;
  let down = 0;
  let upSeen = false;
  let downSeen = false;
  for (const i of cells) {
    if (!m.has[i]) continue;
    if (c.landDelta[i] >= TERRAIN_EPS.land) landUp = true;
    if (c.landDelta[i] <= -TERRAIN_EPS.land) landDown = true;
    if (Math.abs(c.erodDelta[i]) >= TERRAIN_EPS.erod) erod = true;
    if ((c.fragment?.[i] ?? 0) >= FRAG_EPS) frag = true;
    const d = c.upliftDelta[i];
    if (Math.abs(d) < TERRAIN_EPS.uplift) continue;
    const e = Math.max(0, w.derived.elevation[i]);
    const dm = (e * d) / (0.035 + c.uplift[i]);
    if (d > 0) {
      upSeen = true;
      up = Math.max(up, dm);
    } else {
      downSeen = true;
      down = Math.min(down, dm);
    }
  }
  const parts: string[] = [];
  if (landUp) parts.push('画过陆地');
  if (landDown) parts.push('画过海');
  if (upSeen) parts.push(`堆过山${meters(up) ? `（${meters(up)}）` : ''}`);
  if (downSeen) parts.push(`压低过${meters(down) ? `（${meters(down)}）` : ''}`);
  if (erod) parts.push('改过岩石软硬');
  if (frag) parts.push('打碎过');
  return parts.length ? `这里：${parts.join('、')}` : '这里没改过';
}

// 气候：更冷 −3 °C、更湿（雨水 +40%）。取圈里改得最多的那一格
export function climateHere(w: World, cells: number[]): string {
  const m = climateMask(w);
  let t = 0;
  let p = 0;
  for (const i of cells) {
    if (!m.has[i]) continue;
    if (Math.abs(w.causes.tempOffset[i]) > Math.abs(t)) t = w.causes.tempOffset[i];
    if (Math.abs(w.causes.moistOffset[i]) > Math.abs(p)) p = w.causes.moistOffset[i];
  }
  const parts: string[] = [];
  if (Math.abs(t) >= CLIMATE_EPS.temp) parts.push(`${t < 0 ? '更冷' : '更暖'} ${signed(t, Math.abs(t) < 2 ? 1 : 0)} °C`);
  if (Math.abs(p) >= CLIMATE_EPS.moist) parts.push(`${p > 0 ? '更湿' : '更干'}（雨水 ${signed(Math.round((Math.exp(p) - 1) * 100))}%）`);
  return parts.length ? `这里：${parts.join('、')}` : '这里没改过';
}

// 生态：涂成了森林、草原；涂了却没长出来（自然融入时这里长不了）的说“涂过……（没长成）”。
// 一种生态在圈里有的格长成了、有的没有：“涂成了……（有几格没长成）”
export function natureHere(w: World, cells: number[]): string {
  const m = natureMask(w);
  const ids: string[] = [];
  const grew = new Map<string, { yes: number; no: number }>();
  for (const i of cells) {
    const s = m.species.get(i);
    if (s === undefined) continue;
    if (!ids.includes(s)) ids.push(s);
    const k = w.small.species.findIndex((x) => x.id === s);
    const g = grew.get(s) ?? { yes: 0, no: 0 };
    if (k >= 0 && w.derived.dominant[i] === k) g.yes++;
    else g.no++;
    grew.set(s, g);
  }
  if (!ids.length) return '这里没涂过';
  const nameOf = (id: string) => w.small.species.find((x) => x.id === id)?.name || id;
  const list = (names: string[]) => `${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 种` : ''}`;
  const done = ids.filter((id) => grew.get(id)!.yes > 0);
  const failed = ids.filter((id) => grew.get(id)!.yes === 0);
  const parts: string[] = [];
  if (done.length) {
    const partly = done.length === 1 && grew.get(done[0])!.no > 0;
    parts.push(`涂了${list(done.map(nameOf))}${partly ? ' · 有几格没涂成' : ''}`);
  }
  if (failed.length) parts.push(`${list(failed.map(nameOf))}没涂成`);
  return `这里：${parts.join('；')}`;
}
