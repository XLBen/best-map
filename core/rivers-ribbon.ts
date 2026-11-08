// 河的带子（第八十三轮从 core/rivers.ts 原样搬出）：沿折线按宽度铺成两条边，屏幕与导出共用
import { type RiverLine, riverWidth } from './rivers-line';
import { vnoise } from './subcell';

// ---------- 河画出来的样子：一条连续的带子（屏幕与导出的 rivers.bmp 共用） ----------
// 河线（traceRivers 的折线）加密到约 1/16 格，宽度沿河平滑、往下游只增不减；源头收尖（约 1.25 格里从一成半宽到全宽），
// 从湖里流出来的短河从湖岸起收细（见 OUTLET_MIN），
// 入海、入湖的河口在最后约 0.6 格里略张开、平头收在岸线上；再沿法向加一点细小的弯曲（约 0.08 格、半格一个弯，
// 宽的河弯得少，两头不弯）。弯曲只在画的时候加：存下的折线、点河、量长度都照原来的线

export interface RiverRibbon {
  // 中线（地图单位；整个星球上沿河展开经度，与河线相同）
  x: Float64Array;
  y: Float64Array;
  // 沿河的长度（地图单位）
  s: Float64Array;
  // 左手的单位法向
  nx: Float32Array;
  ny: Float32Array;
  // 半宽（屏幕像素，未乘随缩放变宽的系数）
  hw: Float32Array;
  // 每一点来自河线的第几段（带类型的河按它取类型）
  src: Uint32Array;
  // 外接框（中线）与最宽处的半宽
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  maxHw: number;
}

const RIBBON_STEP = 1 / 16;
const TAPER_LEN = 1.25;
const TAPER_MIN = 0.15;
const FLARE_LEN = 0.6;
const FLARE = 0.3;
// 溺谷的河口（第三十四轮）：最后 RIA_LEN 格渐渐张开到 1 + RIA_FLARE 倍
const RIA_LEN = 1.5;
const RIA_FLARE = 1.6;
// 从湖里流出来的短河（不到 2 格；2–4 格之间渐渐不收）：从湖岸起收细，湖岸处约四成宽，到全长的七成是全宽。
// 不然一个小湖流出来一两格就入海、入别的湖的河画成一块平头的方块
const OUTLET_MIN = 0.4;
const OUTLET_SHORT = 2;
const OUTLET_FADE = 2;
const WIDTH_SMOOTH = 0.5;
const MEANDER_AMP = 0.08;
// 弯曲的噪声频率：格点相隔 1/4 格，约半格一个弯
const MEANDER_FREQ = 4;

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// line：河线；thr：河的门槛；spacing：格距；mulAt（可选）：每个河线点再乘的粗细（拖粗细、河流类型的粗细）
// opts.underShore（格，可选）：入海、入湖的河沿最后一段的方向再往水里多画这么长（河口的平头埋在水面下）。只给按陆地裁掉水面上那部分的画法用
// （地图的河那一层按画面上的陆地遮住：河口正好收在弯弯曲曲的岸线上，不是一个跨在岸线上的平头）
let ribbonPad = new Float64Array(4096);

export function riverRibbon(line: RiverLine, thr: number, spacing: number, mulAt?: (k: number) => number, opts?: { underShore?: number }): RiverRibbon {
  const under = line.mouth && opts?.underShore && line.points.length >= 2 ? opts.underShore * spacing : 0;
  if (under > 0) {
    const Q = line.points;
    const [ax, ay] = Q[Q.length - 2];
    const [bx, by] = Q[Q.length - 1];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const more: [number, number] = [bx + ((bx - ax) / l) * under, by + ((by - ay) / l) * under];
    line = { ...line, points: [...Q, more], flow: withLast(line.flow), ...(line.mul ? { mul: withLast(line.mul) } : {}), ...(line.type ? { type: withLast(line.type) } : {}), ...(line.cells ? { cells: withLast(line.cells) } : {}) };
  }
  const P = line.points;
  const m = P.length;
  // 1. 加密：每段等分到不长于 1/16 格
  const step = RIBBON_STEP * spacing;
  // 河线的点与流量先抄进类型化数组（第三十三轮提速：点的小数组、流量数组的元素种类各式各样，逐点读时优化过的代码一碰到新的种类就退回去；值不变）
  const px = new Float64Array(m);
  const py = new Float64Array(m);
  const fl = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    px[k] = P[k][0];
    py[k] = P[k][1];
    fl[k] = line.flow[k];
  }
  let count = 1;
  const parts = new Uint32Array(Math.max(0, m - 1));
  for (let k = 0; k + 1 < m; k++) {
    parts[k] = Math.max(1, Math.ceil(Math.hypot(px[k + 1] - px[k], py[k + 1] - py[k]) / step));
    count += parts[k];
  }
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  // 第五十七轮（提速）：宽度、粗细、平滑的系数只在这一条带子里用，留着下一条接着用（每条都先写后读，一条河一组数组，改一笔要开上千块）
  if (ribbonPad.length < 3 * count) ribbonPad = new Float64Array(6 * count);
  const w = ribbonPad.subarray(0, count);
  const mul = ribbonPad.subarray(count, 2 * count);
  const smoothA = ribbonPad.subarray(2 * count, 3 * count);
  const src = new Uint32Array(count);
  // 每个河线点的粗细倍数先算好（第三十三轮提速：以前每个加密的点算四遍；值与先后不变）
  const mk = new Float64Array(m);
  for (let k = 0; k < m; k++) mk[k] = (line.mul ? line.mul[k] : 1) * (mulAt ? mulAt(k) : 1);
  densify(px, py, fl, mk, parts, thr, x, y, w, mul, src);
  // 2. 沿河的长度
  const s = new Float64Array(count);
  cumLength(x, y, s, count);
  const L = s[count - 1];
  // 岸线在哪里（往水里多画的那段之前）
  const Ls = L - under;
  // 3. 宽度：往下游只增不减，再沿河来回各平滑一遍（约半格；只增不减的数列平滑后仍只增不减）
  smoothWidth(w, s, count, WIDTH_SMOOTH * spacing, smoothA);
  // 4. 源头收尖、河口张开（从湖里流出来的短河从湖岸起收细），乘上粗细
  const outlet = line.head === 'lake' && L > 0 ? 1 - smooth01((L / spacing - OUTLET_SHORT) / OUTLET_FADE) : 0;
  const hw = new Float32Array(count);
  const maxHw = halfWidths(hw, w, mul, s, count, line.head === 'source', outlet, !!line.mouth, L, Ls, spacing, line.mouth && line.ria ? 1 : 0);
  // 断流的尾巴收尖（第五十七轮），和源头一样长
  if (line.tail) for (let i = 0; i < count; i++) hw[i] *= TAPER_MIN + (1 - TAPER_MIN) * smooth01((L - s[i]) / (TAPER_LEN * spacing));
  // 5. 细小的弯曲：沿原来那条线的法向错开（按位置取噪声，结果确定）；两头半格之内渐渐不弯，水多（按流量的宽）的河弯得少，
  //    拖粗细不改中线
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  ribbonNormals(x, y, nx, ny, count);
  if (count > 2) {
    const q = MEANDER_FREQ / spacing;
    // 别的河汇进来的地方前后半格也渐渐不弯：支流的最后一点在原来那条线上，也就落在画出来的中线上（见 RiverLine.joins）
    let damp: Float64Array | null = null;
    if (line.joins?.length) {
      damp = new Float64Array(count).fill(1);
      const start = new Uint32Array(Math.max(1, m - 1));
      for (let k = 1; k + 1 < m; k++) start[k] = start[k - 1] + parts[k - 1];
      for (const pos of line.joins) {
        const k = Math.max(0, Math.min(m - 2, Math.floor(pos)));
        // 汇合点在加密后的第 i0、i0 + 1 点之间；前后各一步之内一点也不弯（这一小段就在原来的线上）
        const f = (pos - k) * parts[k];
        const i0 = Math.min(count - 1, start[k] + Math.floor(f));
        const i1 = Math.min(count - 1, i0 + 1);
        const sj = s[i0] + (s[i1] - s[i0]) * (f - Math.floor(f));
        const reach = 0.5 * spacing + step;
        for (let i = i0; i >= 0 && sj - s[i] < reach; i--) damp[i] = Math.min(damp[i], smooth01((Math.abs(s[i] - sj) - step) / (0.5 * spacing)));
        for (let i = i1; i < count && s[i] - sj < reach; i++) damp[i] = Math.min(damp[i], smooth01((Math.abs(s[i] - sj) - step) / (0.5 * spacing)));
      }
    }
    meanderRibbon(x, y, nx, ny, w, s, damp, count, spacing, Ls, q);
    ribbonNormals(x, y, nx, ny, count);
  }
  ribbonBox(x, y, count);
  return { x, y, s, nx, ny, hw, src, x0: boxOut[0], y0: boxOut[1], x1: boxOut[2], y1: boxOut[3], maxHw };
}

// 带子的几段逐点的循环都是模块里的小函数（第三十三轮提速）：河线对象的样子各式各样（有的带粗细、汇合处、类型、分汊），
// riverRibbon 碰到新的样子时优化过的代码会退回去，循环放在外面就不受牵连。算式、先后与以前写在 riverRibbon 里的一样

// 第 2 步：沿河的长度
function cumLength(x: Float64Array, y: Float64Array, s: Float64Array, count: number): void {
  for (let i = 1; i < count; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
}

// 第 4 步：源头收尖、湖口收细、河口张开，乘上粗细；返回最宽处的半宽
function halfWidths(hw: Float32Array, w: Float64Array, mul: Float64Array, s: Float64Array, count: number, source: boolean, outlet: number, mouth: boolean, L: number, Ls: number, spacing: number, ria: number): number {
  let maxHw = 0;
  // 溺谷（ria = 1）：喇叭口更长、更宽
  const flareLen = ria ? RIA_LEN : FLARE_LEN;
  const flare = ria ? RIA_FLARE : FLARE;
  for (let i = 0; i < count; i++) {
    let f = mul[i];
    if (source) f *= TAPER_MIN + (1 - TAPER_MIN) * smooth01(s[i] / (TAPER_LEN * spacing));
    if (outlet > 0) f *= 1 - outlet * (1 - OUTLET_MIN) * (1 - smooth01(s[i] / (0.7 * L)));
    if (mouth) f *= 1 + flare * smooth01((s[i] - (Ls - flareLen * spacing)) / (flareLen * spacing));
    hw[i] = (w[i] * f) / 2;
    if (hw[i] > maxHw) maxHw = hw[i];
  }
  return maxHw;
}

// 第 5 步：沿法向错开的细小弯曲
function meanderRibbon(x: Float64Array, y: Float64Array, nx: Float32Array, ny: Float32Array, w: Float64Array, s: Float64Array, damp: Float64Array | null, count: number, spacing: number, Ls: number, q: number): void {
  for (let i = 1; i < count - 1; i++) {
    const ends = smooth01(s[i] / (0.5 * spacing)) * smooth01((Ls - s[i]) / (0.5 * spacing)) * (damp ? damp[i] : 1);
    if (ends <= 0) continue;
    const amp = (MEANDER_AMP * spacing * ends) / (1 + 0.5 * Math.max(0, w[i] - 1));
    const off = amp * vnoise(x[i] * q + 5.3, y[i] * q - 7.9);
    x[i] += nx[i] * off;
    y[i] += ny[i] * off;
  }
}

// 中线的外接框，放进 boxOut（x0、y0、x1、y1）
const boxOut = new Float64Array(4);
function ribbonBox(x: Float64Array, y: Float64Array, count: number): void {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    if (x[i] < x0) x0 = x[i];
    if (x[i] > x1) x1 = x[i];
    if (y[i] < y0) y0 = y[i];
    if (y[i] > y1) y1 = y[i];
  }
  boxOut[0] = x0;
  boxOut[1] = y0;
  boxOut[2] = x1;
  boxOut[3] = y1;
}

// 带子的左手单位法向：每一点按前后两点的方向（模块里的函数：以前是 riverRibbon 里的闭包，几样数组都成了闭包里的变量，整个函数都慢）
function ribbonNormals(x: Float64Array, y: Float64Array, nx: Float32Array, ny: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    const tx = x[b] - x[a];
    const ty = y[b] - y[a];
    const l = Math.hypot(tx, ty) || 1;
    nx[i] = -ty / l;
    ny[i] = tx / l;
  }
}

const withLast = <T>(a: T[]): T[] => [...a, a[a.length - 1]];

// 带子第 1 步：每段等分 parts[k] 份，逐点插值中线、按流量的宽、粗细倍数（mk：每个河线点的），记下来自第几段。
// 模块里的函数（不是每条河新建的闭包），算式与先后同以前的 put
function densify(px: Float64Array, py: Float64Array, flow: Float64Array, mk: Float64Array, parts: Uint32Array, thr: number, x: Float64Array, y: Float64Array, w: Float64Array, mul: Float64Array, src: Uint32Array): void {
  const m = px.length;
  putAt(px, py, flow, mk, thr, x, y, w, mul, src, 0, 0, 0);
  let o = 1;
  for (let k = 0; k + 1 < m; k++) for (let j = 1; j <= parts[k]; j++) putAt(px, py, flow, mk, thr, x, y, w, mul, src, o++, k, j / parts[k]);
}
function putAt(px: Float64Array, py: Float64Array, flow: Float64Array, mk: Float64Array, thr: number, x: Float64Array, y: Float64Array, w: Float64Array, mul: Float64Array, src: Uint32Array, o: number, k: number, t: number): void {
  const m = px.length;
  const k1 = Math.min(m - 1, k + 1);
  x[o] = px[k] + (px[k1] - px[k]) * t;
  y[o] = py[k] + (py[k1] - py[k]) * t;
  w[o] = riverWidth(flow[k] + (flow[k1] - flow[k]) * t, thr);
  mul[o] = mk[k] + (mk[k1] - mk[k]) * t;
  src[o] = Math.min(k, Math.max(0, m - 2));
}

// 带子第 3 步：宽度往下游只增不减，再沿河来回各平滑一遍（lam：平滑的长度）。
// 来回两遍用的是同一对相邻点的 1 − exp(−Δs / lam)，只算一遍（第三十三轮提速，值不变）
function smoothWidth(w: Float64Array, s: Float64Array, count: number, lam: number, A: Float64Array): void {
  for (let i = 1; i < count; i++) if (w[i] < w[i - 1]) w[i] = w[i - 1];
  for (let i = 1; i < count; i++) {
    const a = 1 - Math.exp(-(s[i] - s[i - 1]) / lam);
    A[i] = a;
    w[i] = w[i - 1] + (w[i] - w[i - 1]) * a;
  }
  for (let i = count - 2; i >= 0; i--) w[i] = w[i + 1] + (w[i] - w[i + 1]) * A[i + 1];
}
