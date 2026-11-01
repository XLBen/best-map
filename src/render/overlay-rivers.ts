import type { World } from '../../core/world';
import { type OverlayPaths, refZoom } from './overlay-base';
import { type MapStyle, mapStyleKey, typeColor } from '../../core/map-style';
import type { RiverStyle, RiverType } from '../../core/river-types';
import { guideShape, guidesSignature, type RiverLine, traceRivers } from '../../core/rivers';
import { drawTypes, drawTypesKey, MAP_UNDER_SHORE, type PackedRivers, riverDraw, type RiverDraw, unpackRivers } from '../../core/river-pack';
import { coastSeed } from '../../core/terrain';
import { wrapX } from '../../core/geo';

// 叠加层的河：河线、画法、路径（第四十一轮从 overlay.ts 原样搬来）

// ---------- 河的画法（地图上的河、预览的河共用，预览与结果画出来一样） ----------

// 河宽随放大变宽，一直到最大缩放（一格约 64 像素）：按“相当于 4 万格地区地图的缩放”算
export function riverScale(world: World, zoom: number): number {
  return Math.max(0.7, Math.min(4, refZoom(world, zoom) / 1400));
}

// 河的颜色（第三十八轮起按画风，core/map-style.ts）
export function riverStroke(style: Pick<MapStyle, 'river'>): string {
  return style.river;
}
// 两岸的细线（压在河面下面，露出外侧的一半）：画风的 riverBank

// 一种河流类型画出来的颜色（画风选了另一种颜色时用 atlasColor）
export function riverTypeColor(t: Pick<RiverType, 'color' | 'atlasColor'>, style: Pick<MapStyle, 'typeColors'>): string {
  return typeColor(t, style);
}

// 按河流类型的画法沿中线描一条（虚线、双线、发光：整条河一笔，lw 是线宽，单位与路径相同）：
// 虚线（3 倍线宽一段、2 倍线宽一空）；双线（先描整条，再在中间描一道 0.45 倍宽的半透明白线）；发光（同色的 6 像素光晕）
export function strokeRiverStyle(ctx: CanvasRenderingContext2D, path: Path2D, lw: number, color: string, style: RiverStyle, dpr: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  if (style === 'dashed') {
    ctx.setLineDash([3 * lw, 2 * lw]);
    ctx.stroke(path);
    ctx.setLineDash([]);
    return;
  }
  if (style === 'glow') {
    ctx.shadowBlur = 6 * dpr;
    ctx.shadowColor = color;
    ctx.stroke(path);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    return;
  }
  ctx.stroke(path);
  if (style === 'double') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 0.45 * lw;
    ctx.stroke(path);
  }
}

// 一串河线画成要画的河（测试用，与地图上的河同一套：河口多画 0.3 格进水里，合成时按陆地裁掉；见 buildPaths）
export function riverDraws(world: World, lines: RiverLine[]): RiverDraw[] {
  return lines.map((line) => riverDraw(line, world.small.planet.riverThreshold, world.mesh.spacing, null, 1, MAP_UNDER_SHORE));
}

// 一次画的河：画布上要描的几样东西（按颜色合成一笔：同色的带子一次填，交汇处不会叠出深色）
export interface RiverPaint {
  banks: Path2D | null;
  // 细于一个像素的河：沿中线描（颜色|线宽 → 路径；lw 是 CSS 像素）
  thin: Map<string, { path: Path2D; color: string; lw: number }>;
  fills: Map<string, Path2D>;
  // 虚线、双线、发光的河：每条一笔
  styled: { path: Path2D; color: string; lw: number; style: RiverStyle }[];
}

// 每次加一条河用的几个数组（按最长的河分配，反复用）
export let scratch = { length: 0, idx: new Int32Array(0), bx: new Float64Array(0), by: new Float64Array(0) };

// 把要画的河加进 paint。k：半宽（屏幕像素）合多少地图单位；unit：一个 CSS 像素合多少地图单位；
// view：看得见的范围（地图单位，第 0 份），null 不裁（预览的河：调用方按副本挪好了变换）；sphere：整个星球（按副本平移 2）
export function addRiverPaint(
  paint: RiverPaint,
  d: RiverDraw,
  k: number,
  unit: number,
  scale: number,
  view: [number, number, number, number] | null,
  sphere: boolean,
  colorOf: (t: number) => { color: string; style: RiverStyle },
  step = 0.7 * unit,
) {
  const rb = d.rb;
  const n = rb.x.length;
  if (n < 2) return;
  const margin = rb.maxHw * k + 2 * unit;
  let c0 = 0;
  let c1 = 0;
  if (view) {
    if (rb.y1 + margin < view[1] || rb.y0 - margin > view[3]) return;
    if (sphere) {
      c0 = Math.ceil((view[0] - rb.x1 - margin) / 2);
      c1 = Math.min(c0 + 6, Math.floor((view[2] - rb.x0 + margin) / 2));
    } else if (rb.x1 + margin < view[0] || rb.x0 - margin > view[2]) return;
  }
  // 屏幕上相隔不到 0.7 像素的点不要（看全图时一格只有几个像素）
  const dmin = step;
  const thin = 2 * rb.maxHw * scale < 1;
  const wide = 2 * rb.maxHw * scale >= 2.5;
  const S = rb.s;
  if (scratch.length < n) scratch = { length: n, idx: new Int32Array(n), bx: new Float64Array(n), by: new Float64Array(n) };
  const { idx, bx, by } = scratch;
  for (let cp = c0; cp <= c1; cp++) {
    const dx = 2 * cp;
    for (let i0 = 0; i0 < n - 1; ) {
      // 同一种河的一段（相邻两段共用分界的点）
      const t = d.type ? d.type[rb.src[i0]] : 0;
      let i1 = i0 + 1;
      while (i1 < n - 1 && (d.type ? d.type[rb.src[i1]] : 0) === t) i1++;
      let m = 0;
      idx[m++] = i0;
      for (let i = i0 + 1; i < i1; i++) if (S[i] - S[idx[m - 1]] >= dmin) idx[m++] = i;
      idx[m++] = i1;
      const { color, style } = colorOf(t);
      const X = rb.x;
      const Y = rb.y;
      if (style !== 'solid' || thin) {
        let sum = 0;
        for (let i = i0; i <= i1; i++) sum += rb.hw[i];
        const lw = Math.max(0.25, Math.round(((2 * sum) / (i1 - i0 + 1)) * scale * 4) / 4);
        let path: Path2D;
        if (style !== 'solid') paint.styled.push({ path: (path = new Path2D()), color, lw: lw * unit, style });
        else {
          const key = `${color}|${lw}`;
          let e = paint.thin.get(key);
          if (!e) paint.thin.set(key, (e = { path: new Path2D(), color, lw }));
          path = e.path;
        }
        path.moveTo(X[idx[0]] + dx, Y[idx[0]]);
        for (let j = 1; j < m; j++) path.lineTo(X[idx[j]] + dx, Y[idx[j]]);
      } else {
        let f = paint.fills.get(color);
        if (!f) paint.fills.set(color, (f = new Path2D()));
        // 两岸的点（左岸 ox + ux，右岸 ox − ux）
        for (let j = 0; j < m; j++) {
          const i = idx[j];
          const o = rb.hw[i] * k;
          bx[j] = rb.nx[i] * o;
          by[j] = rb.ny[i] * o;
        }
        f.moveTo(X[idx[0]] + dx + bx[0], Y[idx[0]] + by[0]);
        for (let j = 1; j < m; j++) f.lineTo(X[idx[j]] + dx + bx[j], Y[idx[j]] + by[j]);
        for (let j = m - 1; j >= 0; j--) f.lineTo(X[idx[j]] + dx - bx[j], Y[idx[j]] - by[j]);
        f.closePath();
        if (wide) {
          paint.banks ??= new Path2D();
          const b = paint.banks;
          b.moveTo(X[idx[0]] + dx + bx[0], Y[idx[0]] + by[0]);
          for (let j = 1; j < m; j++) b.lineTo(X[idx[j]] + dx + bx[j], Y[idx[j]] + by[j]);
          b.moveTo(X[idx[0]] + dx - bx[0], Y[idx[0]] - by[0]);
          for (let j = 1; j < m; j++) b.lineTo(X[idx[j]] + dx - bx[j], Y[idx[j]] - by[j]);
        }
      }
      i0 = i1;
    }
  }
}

// 描出 paint：两岸的细线、细的河、同色的带子（一次填）、虚线 / 双线 / 发光的河。unit：一个 CSS 像素合多少地图单位
export function strokeRiverPaint(ctx: CanvasRenderingContext2D, paint: RiverPaint, unit: number, style: MapStyle, dpr: number) {
  ctx.lineJoin = 'round';
  if (paint.banks) {
    ctx.lineCap = 'butt';
    ctx.strokeStyle = style.riverBank;
    ctx.lineWidth = 1.1 * unit;
    ctx.stroke(paint.banks);
  }
  ctx.lineCap = 'round';
  for (const e of paint.thin.values()) {
    ctx.strokeStyle = e.color;
    ctx.lineWidth = e.lw * unit;
    ctx.stroke(e.path);
  }
  for (const [color, path] of paint.fills) {
    ctx.fillStyle = color;
    ctx.fill(path);
  }
  for (const e of paint.styled) strokeRiverStyle(ctx, e.path, e.lw, e.color, e.style, dpr);
}

export const newPaint = (): RiverPaint => ({ banks: null, thin: new Map(), fills: new Map(), styled: [] });

// 缩小到一格不到 6 个像素时（河多、每条只占几个像素，看不出两岸和弯曲）：整个世界的河沿中线按宽度分档描，
// 一次加好缓存着（第 0 份的坐标，与缩放无关：线宽按档 × 现在的系数，点隔多远分三档），每帧只描。
// Path2D 每加一个点要约一微秒，看全图时有几万个点，每帧现加会卡；放大以后只加看得见的那几条，每帧现加带子
export const LOW_ZOOM_CELL_PX = 6;
export interface LowZoomStrokes {
  // 颜色|宽度档（CSS 像素，未乘系数）→ 路径
  plain: Map<string, { path: Path2D; color: string; w: number }>;
  styled: { path: Path2D; color: string; w: number; style: RiverStyle }[];
}
export const lowZoomCaches = new WeakMap<OverlayPaths, { key: string; types: unknown; v: LowZoomStrokes }[]>();
export function lowZoomStrokes(paths: OverlayPaths, cellPx: number, spacing: number, style: MapStyle, colorOf: (t: number) => { color: string; style: RiverStyle }, types: unknown): LowZoomStrokes {
  const lod = cellPx < 2 ? 0.5 : cellPx < 4 ? 0.25 : 0.125;
  const key = `${lod}|${mapStyleKey(style)}`;
  let list = lowZoomCaches.get(paths);
  if (!list) lowZoomCaches.set(paths, (list = []));
  const hit = list.find((e) => e.key === key && e.types === types);
  if (hit) return hit.v;
  const v: LowZoomStrokes = { plain: new Map(), styled: [] };
  const dmin = lod * spacing;
  const bucket = (hw: number) => Math.max(0.25, Math.round(2 * hw * 4) / 4);
  for (const d of paths.rivers) {
    const rb = d.rb;
    const n = rb.x.length;
    for (let i0 = 0; i0 < n - 1; ) {
      const t = d.type ? d.type[rb.src[i0]] : 0;
      let i1 = i0 + 1;
      while (i1 < n - 1 && (d.type ? d.type[rb.src[i1]] : 0) === t) i1++;
      const { color, style: st } = colorOf(t);
      if (st !== 'solid') {
        let sum = 0;
        for (let i = i0; i <= i1; i++) sum += rb.hw[i];
        const path = new Path2D();
        path.moveTo(rb.x[i0], rb.y[i0]);
        let last = i0;
        for (let i = i0 + 1; i <= i1; i++) if (i === i1 || rb.s[i] - rb.s[last] >= dmin) path.lineTo(rb.x[(last = i)], rb.y[i]);
        v.styled.push({ path, color, w: (2 * sum) / (i1 - i0 + 1), style: st });
      } else {
        // 宽度档相同的一段一笔（相邻两段共用分界的点）
        for (let a = i0; a < i1; ) {
          const w = bucket(rb.hw[a]);
          let b = a + 1;
          while (b < i1 && bucket(rb.hw[b]) === w) b++;
          const k = `${color}|${w}`;
          let e = v.plain.get(k);
          if (!e) v.plain.set(k, (e = { path: new Path2D(), color, w }));
          e.path.moveTo(rb.x[a], rb.y[a]);
          let last = a;
          for (let i = a + 1; i <= b; i++) if (i === b || rb.s[i] - rb.s[last] >= dmin) e.path.lineTo(rb.x[(last = i)], rb.y[i]);
          a = b;
        }
      }
      i0 = i1;
    }
  }
  list.unshift({ key, types, v });
  list.length = Math.min(list.length, 3);
  return v;
}

// 一种河的颜色与画法：0 是普通的河（color），k + 1 是第 k 种河流类型
export function typeColors(types: readonly RiverType[], style: MapStyle, plain: string): (t: number) => { color: string; style: RiverStyle } {
  return (t) => {
    const spec = t > 0 ? types[t - 1] : undefined;
    return spec ? { color: riverTypeColor(spec, style), style: spec.style ?? 'solid' } : { color: plain, style: 'solid' };
  };
}

// 一条连续的折线加进 Path2D（河道的虚线标记：虚线不在每段重新开始）。整个星球：按段的起点挪到 [0, 2) 里，
// 挪的份数变了才另起一笔
export function addPolyline(p: Path2D, pts: readonly [number, number][], sphere: boolean) {
  let cur = Number.NaN;
  for (let k = 0; k + 1 < pts.length; k++) {
    const shift = sphere ? 2 * Math.floor(pts[k][0] / 2) : 0;
    if (shift !== cur) {
      p.moveTo(pts[k][0] - shift, pts[k][1]);
      cur = shift;
    }
    p.lineTo(pts[k + 1][0] - cur, pts[k + 1][1]);
  }
}

// 拖一条画的河的“粗细”时先这样画（不等 worker，立即看到）；hide：先不画它（拖“大小”、改这条河时用预览的样子代替）。
// cells（改一条自然的河时）：自然的河上两头都在这些格里的那几段先不画（id 为 ''）
export interface RiverStyleOverride {
  id: string;
  width?: number;
  hide?: boolean;
  cells?: ReadonlySet<number>;
}

// 一条河线上两头的格都在 cells 里的那几段（keep 为 false 时是其余的段）：拆成几条线
export function splitRiverLine(line: RiverLine, cells: ReadonlySet<number>, keep: boolean): RiverLine[] {
  const out: RiverLine[] = [];
  const c = line.cells;
  if (!c) return keep ? [] : [line];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length > 1) {
      const pick = <T>(a: T[] | undefined) => (a ? cur.map((k) => a[k]) : undefined);
      const piece: RiverLine = { points: pick(line.points)!, flow: pick(line.flow)!, cells: pick(line.cells) };
      if (line.mul) piece.mul = pick(line.mul);
      if (line.type) piece.type = pick(line.type);
      if (line.guide !== undefined) piece.guide = line.guide;
      // 源头、河口还在这一段上时照样收尖、张开
      if (line.head && cur[0] === 0) piece.head = line.head;
      if (line.mouth && cur[cur.length - 1] === line.points.length - 1) piece.mouth = true;
      out.push(piece);
    }
    cur = [];
  };
  for (let k = 0; k + 1 < line.points.length; k++) {
    const inside = cells.has(c[k]) && cells.has(c[k + 1]);
    if (inside === keep) {
      if (!cur.length) cur.push(k);
      cur.push(k + 1);
    } else flush();
  }
  flush();
  return out;
}

// 河的路径缓存的键：描河读的数组（流量、流向、湖面、高程、陆海；推导换了就换）、河的门槛、
// 河道的内容（每次快照的河道数组都是新的，按内容认）、拖粗细时的临时样子。只改了名字的轻快照不重画，改了粗细的会重画。
// 预览世界（地图画将来的样子）只换了内容变了的数组：流量没变、湖面或高程变了的预览也不会错用当前世界的河
export function riverPathsKey(world: World, override: RiverStyleOverride | null): unknown[] {
  return [
    ...riverLinesKey(world),
    override ? `${override.id}|${override.width ?? ''}|${override.hide ? 1 : 0}` : '',
    override?.cells ?? null,
    // 河流类型（第三批）：类型的颜色、画法、粗细（按内容）
    riverTypesSignature(world.small.riverTypes),
  ];
}

// 河的折线（traceRivers）读的：上面那些数组、门槛、河道的内容，每格是哪一种河（推导换了就换），和画面上的岸线。
// 河流类型的颜色、画法、粗细不改折线：只改这几项时不重新描河（大星球上描一遍要几十毫秒），只重新分档
export function riverLinesKey(world: World): unknown[] {
  return [
    world.mesh,
    world.derived.discharge,
    world.derived.receiver,
    world.derived.lake,
    world.derived.elevation,
    world.causes.land,
    world.small.planet.riverThreshold,
    guidesSignature(world.small.guides),
    world.derived.riverType,
    // 河口画到画面上的岸线（core/display.ts 的 shoreCrossing）：岸线跟着陆地程度、海岸破碎度、海岸的种子、湖面走
    world.causes.landness,
    world.derived.water,
    world.small.terrain.coastRoughness,
    coastSeed(world),
  ];
}

// 河流类型里影响画法的几项（没有河流类型时为 ''）
export function riverTypesSignature(types: readonly RiverType[] | undefined): string {
  return types?.length ? JSON.stringify(types.map((t) => [t.id, t.color, t.atlasColor ?? '', t.style ?? 'solid', t.width ?? 1])) : '';
}

export const samePathsKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// 地图上的河的折线（traceRivers），按 riverLinesKey 缓存。只在主线程用：worker 里水文就地改写流量数组，
// 按数组认会认错。留最近用过的两份：地图画预览世界（将来的河）时，点河、河的光照旧按当前世界的河算，
// 预览世界一份份换（拖着调整面板的滑块）也不会把当前世界的那份挤掉、来回重描
export const linesMemo: { key: unknown[]; lines: RiverLine[] }[] = [];
export function riverLines(world: World): RiverLine[] {
  const key = riverLinesKey(world);
  // Worker 描好送来的（见 seedRivers）
  const seeded = seeds.get(world);
  if (seeded) {
    seeds.delete(world);
    if (!linesMemo.some((m) => samePathsKey(m.key, key))) {
      linesMemo.unshift({ key, lines: seeded });
      linesMemo.length = Math.min(linesMemo.length, 2);
    }
  }
  const at = linesMemo.findIndex((m) => samePathsKey(m.key, key));
  if (at >= 0) {
    const [hit] = linesMemo.splice(at, 1);
    linesMemo.unshift(hit);
    return hit.lines;
  }
  const lines = traceRivers(world);
  linesMemo.unshift({ key, lines });
  linesMemo.length = Math.min(linesMemo.length, 2);
  return lines;
}

// Worker 描好的河（第十三轮，core/river-pack.ts）：快照、预览世界到了主线程就交给这里，画这个世界的河时直接用，不在主线程上描。
// 带子按河线记（只在门槛、格距、河流类型的粗细都一样时用；拖粗细、只画一段时照样现画）
export const seeds = new WeakMap<World, RiverLine[]>();
export const seededDraws = new WeakMap<RiverLine, { key: string; d: RiverDraw }>();
export const drawKeyOf = (thr: number, spacing: number, types: string) => `${thr}|${spacing}|${types}`;
export function seedRivers(world: World, packed: PackedRivers): void {
  const { lines, draws } = unpackRivers(packed);
  seeds.set(world, lines);
  if (draws && packed.rb) {
    const key = drawKeyOf(packed.rb.thr, packed.rb.spacing, packed.rb.types);
    lines.forEach((l, i) => seededDraws.set(l, { key, d: draws[i] }));
  }
}

export function buildPaths(world: World, override: RiverStyleOverride | null = null): OverlayPaths {
  const { mesh, small } = world;
  const thr = small.planet.riverThreshold;
  const sphere = mesh.kind === 'sphere';
  const own = override ? small.guides.find((g) => g.id === override.id) : undefined;
  // 带类型的河（第三批）：只在世界里有河流类型时分开画
  const types = drawTypes(world);
  const rivers: RiverDraw[] = [];
  const dk = drawKeyOf(thr, mesh.spacing, drawTypesKey(types));
  // 地图上的河在合成一步里按陆地裁（renderer 的 uRiver），河口多画 0.3 格进水里，裁出来正好停在岸线上。Worker 描好的直接用
  const add = (line: RiverLine, scale = 1) => {
    const seeded = scale === 1 ? seededDraws.get(line) : undefined;
    rivers.push(seeded && seeded.key === dk ? seeded.d : riverDraw(line, thr, mesh.spacing, types, scale, MAP_UNDER_SHORE));
  };
  for (const line of riverLines(world)) {
    if (override?.cells && line.guide === undefined) for (const piece of splitRiverLine(line, override.cells, false)) add(piece);
    else if (!override || line.guide !== override.id) add(line);
    else if (!override.hide) add(line, override.width !== undefined ? override.width / (own?.width ?? 1) : 1);
  }
  const guides = new Path2D();
  const lockedGuides = new Path2D();
  const sinks: [number, number][] = [];
  const guideLines: { pts: [number, number][]; locked: boolean }[] = [];
  for (const g of small.guides) {
    // 改着的这条河：标记也先不画（预览画改好的样子）
    if (override?.hide && g.id === override.id) continue;
    // 画出来的那条线（与河一致；整个星球上沿线展开经度，跨过接缝的线是连续的）
    const pts = guideShape(world, g);
    addPolyline(g.locked ? lockedGuides : guides, pts, sphere);
    guideLines.push({ pts, locked: !!g.locked });
    if (g.end === 'sink' && pts.length) {
      const [x, y] = pts[pts.length - 1];
      sinks.push([sphere ? wrapX(x) : x, y]);
    }
  }
  return { rivers, guides, lockedGuides, sinks, guideLines };
}

