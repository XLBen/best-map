// 整个星球的投影（第十三轮 G4）：等距圆柱（原来的平铺图，不经过这里）、等面积（Equal Earth，椭圆形）、球形（正射，从太空看）。
//
// 坐标：世界 x = 1 + 经度/180°（0–2）、y = (90° − 纬度)/180°（0–1，与 core/geo.ts 相同）；
// 投影平面 (u, v)：镜头（x、y、zoom）在投影平面上，屏幕 = (平面 − 镜头) × zoom + 画面中心。等距圆柱时平面就是世界坐标。
//   等面积：u = 1 + K·X，v = 0.5 − K·Y（X、Y 是单位球的 Equal Earth，K 使南北高为 1，东西宽约 2.05），中央经线是 lon0
//   球形：u = 1 + G·X，v = 0.5 − G·Y（X、Y 是单位球的正射投影，G = 0.5：球的直径为 1），朝着 (lon0, lat0)
// 着色器里的同一套算式见 PROJ_GLSL（合成一步按每个像素反算回世界坐标，再到等距圆柱的场景上取）

export type ProjKind = 'equirect' | 'equalEarth' | 'globe';

// 投影与它的朝向（弧度）。等距圆柱没有这一项（镜头上的 proj 为空）
export interface Proj {
  kind: 'equalEarth' | 'globe';
  lon0: number;
  lat0: number;
}

const PI = Math.PI;
// Equal Earth（Šavrič, Patterson, Jenny 2018）
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const eeY = (t: number) => {
  const t2 = t * t;
  const t6 = t2 * t2 * t2;
  return t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
};
const eeDY = (t: number) => {
  const t2 = t * t;
  const t6 = t2 * t2 * t2;
  return A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
};
// 两极的 Y（单位球）与平面的缩放：南北高为 1
export const EE_YMAX = eeY(PI / 3);
export const EE_K = 0.5 / EE_YMAX;
// 赤道上东西的半宽（平面单位）
export const EE_HALF_W = (EE_K * PI) / (M * A1);
// 球形：直径为 1
export const GLOBE_G = 0.5;

// 经度绕回 [−π, π)
const wrapLon = (l: number) => l - 2 * PI * Math.floor((l + PI) / (2 * PI));
const wrapX = (x: number) => x - 2 * Math.floor(x / 2);

// 投影平面的范围（u0, u1, v0, v1）
export function planeBounds(p: Proj): [number, number, number, number] {
  if (p.kind === 'equalEarth') return [1 - EE_HALF_W, 1 + EE_HALF_W, 0, 1];
  return [1 - GLOBE_G, 1 + GLOBE_G, 0.5 - GLOBE_G, 0.5 + GLOBE_G];
}

// 世界 → 平面；球形背面（看不见）返回 null
export function forward(p: Proj, x: number, y: number): [number, number] | null {
  const lon = PI * (x - 1);
  const lat = PI * (0.5 - y);
  if (p.kind === 'equalEarth') {
    const l = wrapLon(lon - p.lon0);
    const t = Math.asin(M * Math.sin(lat));
    const X = (l * Math.cos(t)) / (M * eeDY(t));
    return [1 + EE_K * X, 0.5 - EE_K * eeY(t)];
  }
  const dl = lon - p.lon0;
  const s0 = Math.sin(p.lat0);
  const c0 = Math.cos(p.lat0);
  const cl = Math.cos(lat);
  const cosc = s0 * Math.sin(lat) + c0 * cl * Math.cos(dl);
  if (cosc < 0) return null;
  const X = cl * Math.sin(dl);
  const Y = c0 * Math.sin(lat) - s0 * cl * Math.cos(dl);
  return [1 + GLOBE_G * X, 0.5 - GLOBE_G * Y];
}

// 平面 → 世界（x 在 [0, 2)）；投影之外返回 null
export function inverse(p: Proj, u: number, v: number): [number, number] | null {
  if (p.kind === 'equalEarth') {
    const X = (u - 1) / EE_K;
    const Y = (0.5 - v) / EE_K;
    if (Math.abs(Y) > EE_YMAX) return null;
    let t = Y / A1;
    for (let i = 0; i < 8; i++) {
      const d = (eeY(t) - Y) / eeDY(t);
      t -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    const ct = Math.cos(t);
    const l = ct > 1e-12 ? (M * X * eeDY(t)) / ct : 0;
    if (Math.abs(l) > PI) return null;
    const lat = Math.asin(Math.max(-1, Math.min(1, Math.sin(t) / M)));
    return [wrapX(1 + (l + p.lon0) / PI), 0.5 - lat / PI];
  }
  const X = (u - 1) / GLOBE_G;
  const Y = (0.5 - v) / GLOBE_G;
  const r2 = X * X + Y * Y;
  if (r2 > 1) return null;
  const cc = Math.sqrt(1 - r2);
  const s0 = Math.sin(p.lat0);
  const c0 = Math.cos(p.lat0);
  const lat = Math.asin(Math.max(-1, Math.min(1, cc * s0 + Y * c0)));
  const den = cc * c0 - Y * s0;
  const lon = p.lon0 + (Math.abs(X) < 1e-15 && Math.abs(den) < 1e-15 ? 0 : Math.atan2(X, den));
  return [wrapX(1 + lon / PI), 0.5 - lat / PI];
}

// 平面上的点在不在投影之内
export const insidePlane = (p: Proj, u: number, v: number) => inverse(p, u, v) !== null;

// 平面上的一点到投影之内最近的地方（在投影之外时沿着到中心的方向往里收，略微靠里）
export function clampToShape(p: Proj, u: number, v: number): [number, number] {
  if (insidePlane(p, u, v)) return [u, v];
  const cu = 1;
  const cv = 0.5;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (insidePlane(p, cu + (u - cu) * m, cv + (v - cv) * m)) lo = m;
    else hi = m;
  }
  return [cu + (u - cu) * lo, cv + (v - cv) * lo];
}

// 这一点上“真实距离”的比例：平面单位 / 地图单位（地图单位 = 球面弧长 / π，与 mesh.dist 相同）。
// 按面积算（√ 行列式，除去经度方向的 cos 纬度）：等面积处处相同（K·π），球形在正中是 G·π、往边上变小。
// 背面、投影之外返回 0
export function trueScale(p: Proj, x: number, y: number): number {
  const h = 1e-5;
  const yc = Math.min(1 - 2 * h, Math.max(2 * h, y));
  const a = forward(p, x, yc);
  const b = forward(p, x + h, yc);
  const c = forward(p, x, yc + h);
  if (!a || !b || !c) return 0;
  const det = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / (h * h);
  const cosLat = Math.max(1e-6, Math.sin(PI * yc));
  return Math.sqrt(det / cosLat);
}

// 投影在正中的“真实距离”比例（工具的像素容差、河宽、何时标地名按它算）
export function centerScale(p: Proj): number {
  return p.kind === 'equalEarth' ? EE_K * PI : GLOBE_G * PI;
}

// ---------- 镜头 ----------

export interface ProjCamera {
  x: number;
  y: number;
  zoom: number;
  proj?: Proj;
}

// 屏幕（CSS 像素，cw × ch 的画布）→ 平面
export function screenToPlane(cam: ProjCamera, cw: number, ch: number, sx: number, sy: number): [number, number] {
  return [cam.x + (sx - cw / 2) / cam.zoom, cam.y + (sy - ch / 2) / cam.zoom];
}

// 屏幕 → 世界：inside 是这一点在地图上（投影之内、南北之内）。投影之外时给最近的边上的一点（坐标总是有限的数）
export function screenToWorld(cam: ProjCamera, cw: number, ch: number, sx: number, sy: number): { x: number; y: number; inside: boolean } {
  const [u, v] = screenToPlane(cam, cw, ch, sx, sy);
  const p = cam.proj;
  if (!p) return { x: u, y: v, inside: v >= 0 && v <= 1 };
  const w = inverse(p, u, v);
  if (w) return { x: w[0], y: w[1], inside: true };
  const [cu, cv] = clampToShape(p, u, v);
  const e = inverse(p, cu, cv) ?? [1 + p.lon0 / PI, 0.5 - p.lat0 / PI];
  return { x: e[0], y: e[1], inside: false };
}

// 世界 → 屏幕（CSS 像素）；球形背面返回 null
export function worldToScreen(cam: ProjCamera, cw: number, ch: number, x: number, y: number): [number, number] | null {
  const p = cam.proj;
  const q = p ? forward(p, x, y) : [x, y];
  if (!q) return null;
  return [(q[0] - cam.x) * cam.zoom + cw / 2, (q[1] - cam.y) * cam.zoom + ch / 2];
}

// 相当于等距圆柱的哪个缩放（工具的像素容差按它算：一个“地图单位”的真实距离合几个像素）
export function effectiveZoom(cam: ProjCamera): number {
  return cam.proj ? cam.zoom * centerScale(cam.proj) : cam.zoom;
}

// 球形：转到让世界上的 (x, y) 正好落在平面上的 (u, v)（拖着转、在鼠标处缩放时鼠标下的那一点不动）。
// (u, v) 在球外时按球的边上算。南北不翻过两极（lat0 在 ±90° 之内）；做不到时返回原来的
export function rotateToAnchor(p: Proj, x: number, y: number, u: number, v: number): Proj {
  let X = (u - 1) / GLOBE_G;
  let Y = (0.5 - v) / GLOBE_G;
  const r = Math.hypot(X, Y);
  if (r > 0.999) {
    X *= 0.999 / r;
    Y *= 0.999 / r;
  }
  const lon = PI * (x - 1);
  const lat = PI * (0.5 - y);
  const cc = Math.sqrt(Math.max(0, 1 - X * X - Y * Y));
  // sin(lat) = cc·sin(lat0) + Y·cos(lat0) = R·sin(lat0 + δ)
  const R = Math.hypot(cc, Y);
  const d = Math.atan2(Y, cc);
  const s = Math.sin(lat) / R;
  if (Math.abs(s) > 1) return p;
  const a = Math.asin(s);
  const cands = [a - d, PI - a - d, -PI - a - d].filter((c) => c >= -PI / 2 - 1e-9 && c <= PI / 2 + 1e-9);
  if (!cands.length) return p;
  const lat0 = Math.max(-PI / 2, Math.min(PI / 2, cands.reduce((b, c) => (Math.abs(c - p.lat0) < Math.abs(b - p.lat0) ? c : b))));
  const lon0 = wrapLon(lon - Math.atan2(X, cc * Math.cos(lat0) - Y * Math.sin(lat0)));
  return { kind: 'globe', lon0, lat0 };
}

// 换投影：画面中心那一点留在画面中心，那里的大小（真实距离的比例）不变。
// 等距圆柱的“比例”按南北方向（1）；中央经线 / 球的朝向转到画面中心那一点
export function convertCamera(cam: ProjCamera, cw: number, ch: number, to: ProjKind): ProjCamera {
  const c = screenToWorld(cam, cw, ch, cw / 2, ch / 2);
  const from = cam.proj;
  let cx = c.x;
  let cy = Math.max(0, Math.min(1, c.y));
  if (!c.inside && from) {
    cx = 1 + from.lon0 / PI;
    cy = 0.5 - from.lat0 / PI;
  }
  const s0 = from ? trueScale(from, cx, cy) || centerScale(from) : 1;
  const zEff = cam.zoom * s0;
  const lon = PI * (wrapX(cx) - 1);
  const lat = PI * (0.5 - cy);
  if (to === 'equirect') return { x: from ? wrapX(cx) : cx, y: cy, zoom: zEff };
  if (to === 'equalEarth') {
    const p: Proj = { kind: 'equalEarth', lon0: lon, lat0: 0 };
    const q = forward(p, cx, cy)!;
    return { x: q[0], y: q[1], zoom: zEff / (trueScale(p, cx, cy) || centerScale(p)), proj: p };
  }
  const p: Proj = { kind: 'globe', lon0: lon, lat0: Math.max(-PI / 2, Math.min(PI / 2, lat)) };
  return { x: 1, y: 0.5, zoom: zEff / centerScale(p), proj: p };
}

// ---------- 合成用的场景：要画等距圆柱的哪一块、多密 ----------

// 画面上看得见的世界范围（x 在投影中心的经度附近展开，可能伸出 [0, 2)）与需要的密度（每地图单位多少 CSS 像素，东西、南北分开）。
// full：整圈经度都要（看得见极点，或者范围已经很宽）：x0 = 0、x1 = 2，与朝向无关（转动球时不必重画场景）。
// 画面上一点地图都没有时返回 null。margin：四周多留的地图单位（扭曲、取周围格要用到）
export interface SceneNeed {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  zx: number;
  zy: number;
  full: boolean;
}

export function sceneNeed(cam: ProjCamera & { proj: Proj }, cw: number, ch: number, margin: number): SceneNeed | null {
  const p = cam.proj;
  const N = 24;
  const xc = 1 + p.lon0 / PI;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let zx = 0;
  let zy = 0;
  let stepX = 0;
  let stepY = 0;
  const grid: ([number, number] | null)[] = [];
  const h = 1e-5;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const [u, v] = screenToPlane(cam, cw, ch, (cw * i) / N, (ch * j) / N);
      const w = inverse(p, u, v);
      if (!w) {
        grid.push(null);
        continue;
      }
      const x = xc + (w[0] - xc - 2 * Math.round((w[0] - xc) / 2));
      const y = w[1];
      grid.push([x, y]);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      const yc = Math.min(1 - 2 * h, Math.max(2 * h, y));
      const a = forward(p, x, yc);
      const b = forward(p, x + h, yc);
      const c = forward(p, x, yc + h);
      if (a && b && c) {
        zx = Math.max(zx, (Math.hypot(b[0] - a[0], b[1] - a[1]) / h) * cam.zoom);
        zy = Math.max(zy, (Math.hypot(c[0] - a[0], c[1] - a[1]) / h) * cam.zoom);
      }
      const left = i > 0 ? grid[grid.length - 2] : null;
      const up = j > 0 ? grid[grid.length - 1 - (N + 1)] : null;
      for (const o of [left, up]) {
        if (!o) continue;
        stepX = Math.max(stepX, Math.abs(o[0] - x));
        stepY = Math.max(stepY, Math.abs(o[1] - y));
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  // 极点在画面上：南北伸到那一极，东西要整圈
  let full = false;
  const onScreen = (q: [number, number] | null) => {
    if (!q) return false;
    const sx = (q[0] - cam.x) * cam.zoom + cw / 2;
    const sy = (q[1] - cam.y) * cam.zoom + ch / 2;
    return sx >= -2 && sx <= cw + 2 && sy >= -2 && sy <= ch + 2;
  };
  if (onScreen(forward(p, xc, 0))) {
    y0 = 0;
    full = true;
  }
  if (onScreen(forward(p, xc, 1))) {
    y1 = 1;
    full = true;
  }
  stepX = Math.min(stepX, 0.5);
  x0 -= stepX + margin;
  x1 += stepX + margin;
  y0 = Math.max(0, y0 - stepY - margin);
  y1 = Math.min(1, y1 + stepY + margin);
  // 已经很宽（球形看得见整个半球时约 1）：直接要整圈，转动时不必重画
  if (full || x1 - x0 > 0.9) {
    full = true;
    x0 = 0;
    x1 = 2;
    // 南北也已经很宽：整个世界都要（转动时南北的范围也不必跟着变）
    if (y1 - y0 > 0.5) {
      y0 = 0;
      y1 = 1;
    }
  }
  return { x0, x1, y0, y1, zx: Math.max(zx, 1e-6), zy: Math.max(zy, 1e-6), full };
}

// ---------- 着色器里的同一套算式 ----------

const glf = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// 合成一步用：uProj（1 等面积、2 球形）、uProjP（lon0、sin lat0、cos lat0、0）。
// projInv：平面 → 世界（x 在 [0, 2)），edge 是到投影边缘的距离（平面单位，抗锯齿用）；在投影之外返回 false。
// 要在 PI 定义之后
export const PROJ_GLSL = `
uniform int uProj;
uniform vec4 uProjP;
bool projInv(vec2 plane, out vec2 w, out float edge) {
  w = vec2(0.0);
  edge = 0.0;
  if (uProj == 1) {
    float X = (plane.x - 1.0) / ${glf(EE_K)};
    float Y = (0.5 - plane.y) / ${glf(EE_K)};
    if (abs(Y) > ${glf(EE_YMAX)}) return false;
    float t = Y / ${glf(A1)};
    float fp = ${glf(A1)};
    for (int i = 0; i < 6; i++) {
      float t2 = t * t;
      float t6 = t2 * t2 * t2;
      float f = t * (${glf(A1)} + ${glf(A2)} * t2 + t6 * (${glf(A3)} + ${glf(A4)} * t2)) - Y;
      fp = ${glf(A1)} + 3.0 * ${glf(A2)} * t2 + t6 * (7.0 * ${glf(A3)} + 9.0 * ${glf(A4)} * t2);
      t -= f / fp;
    }
    float t2 = t * t;
    float t6 = t2 * t2 * t2;
    fp = ${glf(A1)} + 3.0 * ${glf(A2)} * t2 + t6 * (7.0 * ${glf(A3)} + 9.0 * ${glf(A4)} * t2);
    float ct = max(cos(t), 1e-6);
    float xmax = PI * ct / (${glf(M)} * fp);
    if (abs(X) > xmax) return false;
    float lam = ${glf(M)} * X * fp / ct;
    float phi = asin(clamp(sin(t) / ${glf(M)}, -1.0, 1.0));
    w = vec2(1.0 + (lam + uProjP.x) / PI, 0.5 - phi / PI);
    edge = min(xmax - abs(X), ${glf(EE_YMAX)} - abs(Y)) * ${glf(EE_K)};
  } else {
    vec2 q = vec2(plane.x - 1.0, 0.5 - plane.y) / ${glf(GLOBE_G)};
    float r2 = dot(q, q);
    if (r2 > 1.0) return false;
    float cc = sqrt(1.0 - r2);
    float phi = asin(clamp(cc * uProjP.y + q.y * uProjP.z, -1.0, 1.0));
    float den = cc * uProjP.z - q.y * uProjP.y;
    float lam = uProjP.x + ((abs(q.x) < 1e-9 && abs(den) < 1e-9) ? 0.0 : atan(q.x, den));
    w = vec2(1.0 + lam / PI, 0.5 - phi / PI);
    edge = (1.0 - sqrt(r2)) * ${glf(GLOBE_G)};
  }
  w.x -= 2.0 * floor(w.x / 2.0);
  return true;
}
`;
