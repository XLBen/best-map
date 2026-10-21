import { MinHeap } from './heap';
import { type Mesh, gradient } from './mesh';
import { clamp, smoothstep } from './rng';
import { type Derived, type World, worldLatitude } from './world';

// 气候：少参数的物理过程模型，不对地球的海陆形状做拟合，换一块大陆也成立。
//   温度 = 日照（纬度、季节）→ 辐射平衡温度；海陆热惯性由“海洋气团占比”（大陆度）调节；海拔直减
//   风   = 三圈环流的纬向风带随季节南北摆动 + 大陆夏季热低压（季风）
//   降水 = 水汽沿风向在格图上输运：海上蒸发补充，陆上按速率降落；
//          抬升冷却使饱和水汽量下降，多出的水汽在迎风坡降下 → 背风坡雨影自然出现
// 两个季节：s = 北半球夏半年，w = 北半球冬半年。

export interface ClimateBase {
  tS: Float32Array;
  tW: Float32Array;
  pS: Float32Array;
  pW: Float32Array;
}

export let SWEEPS = 32;
export const setSweeps = (v: number) => (SWEEPS = v);
const cache = new WeakMap<Mesh, { rev: Int32Array; orders: Int32Array[] }>();

// rev[e]：邻接项 e（i→j）在 j 的邻接表中指回 i 的那一项
export function meshAux(mesh: Mesh) {
  let aux = cache.get(mesh);
  if (aux) return aux;
  const rev = new Int32Array(mesh.adj.length);
  for (let i = 0; i < mesh.n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) {
        if (mesh.adj[f] === i) {
          rev[e] = f;
          break;
        }
      }
    }
  }
  const idx = Array.from({ length: mesh.n }, (_, i) => i);
  const byX = Int32Array.from([...idx].sort((a, b) => mesh.x[a] - mesh.x[b]));
  const byY = Int32Array.from([...idx].sort((a, b) => mesh.y[a] - mesh.y[b]));
  const orders = [byX, Int32Array.from(byX).reverse(), byY, Int32Array.from(byY).reverse()];
  aux = { rev, orders };
  cache.set(mesh, aux);
  return aux;
}

// 陆地占比的平滑很耗时（几百轮扩散），陆海不变时复用上次结果
let landFracCache: { mesh: Mesh; kmPerUnit: number; land: Uint8Array; result: Float64Array } | null = null;

function landFraction(mesh: Mesh, land: Uint8Array, kmPerUnit: number): Float64Array {
  const c = landFracCache;
  if (c && c.mesh === mesh && c.kmPerUnit === kmPerUnit && c.land.length === land.length && c.land.every((v, i) => v === land[i])) return c.result;
  const n = mesh.n;
  const landFrac = new Float64Array(n);
  for (let i = 0; i < n; i++) landFrac[i] = land[i];
  const iters = Math.round(((1500 / kmPerUnit / mesh.spacing) ** 2) / 2);
  const tmp = new Float64Array(n);
  for (let it = 0; it < Math.min(400, iters); it++) {
    for (let i = 0; i < n; i++) {
      let s = landFrac[i];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) s += landFrac[mesh.adj[e]];
      tmp[i] = s / (1 + mesh.off[i + 1] - mesh.off[i]);
    }
    landFrac.set(tmp);
  }
  landFracCache = { mesh, kmPerUnit, land: land.slice(), result: landFrac };
  return landFrac;
}

// 日平均日照（W/m²）
function dailyInsolation(latDeg: number, declDeg: number, s0: number): number {
  const phi = (latDeg * Math.PI) / 180;
  const dec = (declDeg * Math.PI) / 180;
  const x = clamp(-Math.tan(phi) * Math.tan(dec), -1, 1);
  const h0 = Math.acos(x);
  return Math.max(0, (s0 / Math.PI) * (h0 * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(h0)));
}

// 按纬度预计算全年平均与两个半年的平均日照
export function insolationTable(tilt: number, solar: number) {
  const s0 = 1361 * solar;
  const lats = 361;
  const ann = new Float64Array(lats);
  const sum = new Float64Array(lats);
  const win = new Float64Array(lats);
  const steps = 48;
  for (let k = 0; k < lats; k++) {
    const lat = -90 + k * 0.5;
    let a = 0;
    let s = 0;
    let w = 0;
    for (let t = 0; t < steps; t++) {
      const decl = tilt * Math.sin((2 * Math.PI * (t + 0.5)) / steps);
      const q = dailyInsolation(lat, decl, s0);
      a += q;
      if (t < steps / 2) s += q;
      else w += q;
    }
    ann[k] = a / steps;
    sum[k] = s / (steps / 2);
    win[k] = w / (steps / 2);
  }
  return (lat: number) => {
    const f = (clamp(lat, -90, 90) + 90) * 2;
    const k = Math.min(lats - 2, Math.floor(f));
    const t = f - k;
    const lerp = (arr: Float64Array) => arr[k] + (arr[k + 1] - arr[k]) * t;
    return { ann: lerp(ann), s: lerp(sum), w: lerp(win) };
  };
}

// 年均温与年均日照的关系，按地球的赤道（27 °C）、45°（11 °C）、极地（-18 °C）三点拟合；
// 日照变了（倾角、太阳常数）温度跟着变
export function radiativeTemp(q: number): number {
  const qq = Math.min(q, 520);
  return -77.12 + 0.4071 * qq - 0.000378 * qq * qq;
}

// 相对饱和水汽量（25 °C 为 1）
export function saturation(t: number): number {
  return Math.exp(0.045 * (clamp(t, -40, 40) - 25));
}

export function petHalf(t: number): number {
  return t >= 0 ? 100 + 24 * t : 100 * Math.exp(t / 8);
}

export function computeClimate(world: World, elevation: Float32Array, out: Derived): ClimateBase {
  const { mesh, causes, small, kmPerUnit } = world;
  const n = mesh.n;
  const planet = small.planet;
  const land = causes.land;
  const ins = insolationTable(planet.tilt, planet.solar);
  const aux = meshAux(mesh);
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) lat[i] = worldLatitude(world, mesh.y[i]);
  const spacingKm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) s += mesh.dist[e];
    spacingKm[i] = (s / Math.max(1, mesh.off[i + 1] - mesh.off[i])) * kmPerUnit;
  }

  // 大尺度陆地占比（约 1500 km 平滑），季风用
  const landFrac = landFraction(mesh, land, kmPerUnit);

  // 高程梯度（m/km），陆地用于地形抬升判断。先平滑到约 200 km 尺度：
  // 地形雨看的是山体整体的迎风背风，不是单格尺度的谷与脊，否则会出现逐格交替的条纹
  const hx = new Float64Array(n);
  const hy = new Float64Array(n);
  const hPos = new Float64Array(n);
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? Math.max(0, elevation[i]) : 0;
  {
    const passes = Math.max(1, Math.round(((200 / kmPerUnit / mesh.spacing) ** 2) / 2));
    const next = new Float64Array(n);
    for (let it = 0; it < passes; it++) {
      for (let i = 0; i < n; i++) {
        let s = hPos[i];
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) s += hPos[mesh.adj[e]];
        next[i] = s / (1 + mesh.off[i + 1] - mesh.off[i]);
      }
      hPos.set(next);
    }
  }
  for (let i = 0; i < n; i++) {
    const [gx, gy] = gradient(mesh, hPos, i);
    hx[i] = gx / kmPerUnit;
    hy[i] = gy / kmPerUnit;
  }

  const seasons = [1, -1] as const;
  const winds: [Float32Array, Float32Array][] = [
    [out.windSX, out.windSY],
    [out.windWX, out.windWY],
  ];
  const itczOf = (sigma: number) => sigma * 0.35 * planet.tilt;
  seasons.forEach((sigma, si) => {
    const [wx, wy] = winds[si];
    const phiC = itczOf(sigma);
    for (let i = 0; i < n; i++) {
      const d = lat[i] - phiC;
      const ad = Math.min(90, Math.abs(d));
      const uZonal = -Math.cos((Math.PI * ad) / 45) * planet.rotation * (ad < 22.5 ? 0.8 : 1);
      const toward = ad < 67.5 ? 0.3 * Math.sin((2 * Math.PI * ad) / 45) : 0.25;
      let u = uZonal;
      let v = d > 0 ? toward : -toward;
      // 季风：夏半球风吹向大陆，冬半球吹离大陆
      const [gx, gy] = gradient(mesh, landFrac, i);
      const L = 1500 / kmPerUnit;
      const summer = Math.sign(lat[i]) === sigma;
      const g = Math.exp(-(((Math.abs(lat[i]) - 22) / 12) ** 2));
      const k = (summer ? 1.1 : -0.25) * g * L;
      u += k * gx;
      v += k * gy;
      const mag = Math.hypot(u, v);
      const lim = 1.3;
      if (mag > lim) {
        u *= lim / mag;
        v *= lim / mag;
      }
      wx[i] = u;
      wy[i] = v;
    }
  });

  // 每个季节的输运权重：格 i 的出流按风向分给下风方向的邻居，另有一小部分各向均匀扩散
  const flow = winds.map(([wx, wy]) => buildFlow(mesh, wx, wy));

  // 大陆度：海洋气团示踪量随风深入陆地后衰减
  const marine = new Float64Array(n);
  for (let si = 0; si < 2; si++) {
    const [wx, wy] = winds[si];
    const f = flow[si];
    const m = solveTransport(mesh, aux, f, wx, wy, planet.outsideOcean ? 1 : 0, (i, inflow) => (land[i] ? inflow * Math.exp(-spacingKm[i] / 1500) : 1));
    for (let i = 0; i < n; i++) marine[i] += 0.5 * clamp(m[i], 0, 1);
  }
  for (let i = 0; i < n; i++) out.continentality[i] = land[i] ? 1 - marine[i] : 0;

  // 温度
  const base: ClimateBase = { tS: new Float32Array(n), tW: new Float32Array(n), pS: new Float32Array(n), pW: new Float32Array(n) };
  const oceanT: Float64Array[] = [new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const q = ins(lat[i]);
    const tAnn = radiativeTemp(q.ann);
    const amp = land[i] ? 0.3 + 0.7 * out.continentality[i] : 0.3;
    const lapse = land[i] ? (planet.lapse * Math.max(0, elevation[i])) / 1000 : 0;
    const off = causes.tempOffset[i];
    // 高纬的季节振幅更大（极昼极夜）
    const k = 0.09 * (1 + (0.4 * Math.abs(lat[i])) / 90);
    base.tS[i] = tAnn + k * (q.s - q.ann) * amp - lapse + off;
    base.tW[i] = tAnn + k * (q.w - q.ann) * amp - lapse + off;
    oceanT[0][i] = tAnn + k * (q.s - q.ann) * 0.3;
    oceanT[1][i] = tAnn + k * (q.w - q.ann) * 0.3;
  }

  // 降水
  for (let si = 0; si < 2; si++) {
    const sigma = seasons[si];
    const [wx, wy] = winds[si];
    const T = si === 0 ? base.tS : base.tW;
    const P = si === 0 ? base.pS : base.pW;
    const phiC = itczOf(sigma);
    const rate = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = lat[i] - phiC;
      const ad = Math.abs(d);
      const conv = 1 + 1.6 * Math.exp(-((d / 9) ** 2));
      const subs = 1 - 0.75 * Math.exp(-(((ad - 27) / 9) ** 2));
      const storm = 1 + 0.45 * Math.exp(-(((ad - 52) / 11) ** 2));
      const warmth = 0.45 + 0.55 * smoothstep(-10, 25, T[i]);
      let r = (conv * subs * storm * warmth) / 1800;
      if (land[i]) {
        const wm = Math.hypot(wx[i], wy[i]) || 1;
        const up = (wx[i] * hx[i] + wy[i] * hy[i]) / wm;
        // 背风下沉气流抑制降水
        if (up < 0) r *= Math.exp(up / 1.5);
      }
      rate[i] = r;
    }
    const satOcean = (i: number) => planet.humidity * saturation(oceanT[si][i]);
    const removed = new Float64Array(n);
    solveTransport(mesh, aux, flow[si], wx, wy, planet.outsideOcean ? -1 : 0, (i, inflow) => {
      const dKm = spacingKm[i];
      let m = inflow;
      let p = m * (1 - Math.exp(-rate[i] * dKm));
      m -= p;
      if (land[i]) {
        // 抬升冷却：超过当地饱和量的部分在约 150 km 的距离上降下（按距离而不是按格，结果与格的大小无关）
        const cap = planet.humidity * saturation(T[i]) * 1.1;
        if (m > cap) {
          const excess = (m - cap) * (1 - Math.exp(-dKm / 150));
          p += excess;
          m -= excess;
        }
        // 陆面蒸散回补一部分
        m += p * 0.6 * smoothstep(0, 25, T[i]);
      } else {
        const sat = satOcean(i);
        // 超过饱和量的部分同样在约 150 km 内降下
        if (m > sat * 1.1) {
          const excess = (m - sat * 1.1) * (1 - Math.exp(-dKm / 150));
          p += excess;
          m -= excess;
        }
        m += (sat - m) * (1 - Math.exp(-dKm / 900));
      }
      removed[i] = p / dKm;
      return Math.max(0, m);
    }, satOcean);
    const off = causes.moistOffset;
    for (let i = 0; i < n; i++) P[i] = removed[i] * 1.7e6 * Math.exp(off[i]);
  }
  return base;
}

// 把修正场（约束求解结果）叠到基础气候上，并计算派生的年值与指数
export function finalizeClimate(world: World, base: ClimateBase, out: Derived) {
  for (let i = 0; i < world.mesh.n; i++) {
    const dT = out.corrT[i];
    const fP = Math.exp(out.corrP[i]);
    const tS = base.tS[i] + dT;
    const tW = base.tW[i] + dT;
    const pS = base.pS[i] * fP;
    const pW = base.pW[i] * fP;
    out.tS[i] = tS;
    out.tW[i] = tW;
    out.pS[i] = pS;
    out.pW[i] = pW;
    summarize(out, i, tS, tW, pS, pW);
  }
}

export function summarize(out: Derived, i: number, tS: number, tW: number, pS: number, pW: number) {
  out.tMean[i] = (tS + tW) / 2;
  const summerWarm = tS >= tW;
  out.tWarm[i] = summerWarm ? tS : tW;
  out.tCold[i] = summerWarm ? tW : tS;
  const pWarm = summerWarm ? pS : pW;
  const pCold = summerWarm ? pW : pS;
  out.precip[i] = pS + pW;
  out.seasonality[i] = (pWarm - pCold) / (pWarm + pCold + 1);
  out.pet[i] = petHalf(tS) + petHalf(tW);
  // 蒸散分母设下限：极寒处 PET 趋近 0，湿润指数会变得没有意义的大
  out.moisture[i] = out.precip[i] / Math.max(out.pet[i], 120);
}

// 由一组季节值算出与 summarize 相同的字段，供约束求解试算
export function climateFields(tS: number, tW: number, pS: number, pW: number) {
  const summerWarm = tS >= tW;
  const pWarm = summerWarm ? pS : pW;
  const pCold = summerWarm ? pW : pS;
  const precip = pS + pW;
  const pet = Math.max(petHalf(tS) + petHalf(tW), 120);
  return {
    tMean: (tS + tW) / 2,
    tWarm: summerWarm ? tS : tW,
    tCold: summerWarm ? tW : tS,
    precip,
    seasonality: (pWarm - pCold) / (pWarm + pCold + 1),
    moisture: precip / pet,
  };
}

export interface Flow {
  // 与 adj 对齐：格 i 出流分给邻居 adj[e] 的比例
  frac: Float64Array;
  // 沿风向的拓扑序（上风在前）；风场有环时环上的格按 x 顺序补在后面
  order: Int32Array;
}

export function buildFlow(mesh: Mesh, wx: Float32Array, wy: Float32Array): Flow {
  const n = mesh.n;
  const frac = new Float64Array(mesh.adj.length);
  const diffuse = 0.15;
  const dots = new Float64Array(32);
  const calm = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = mesh.off[i];
    const b = mesh.off[i + 1];
    const mag = Math.hypot(wx[i], wy[i]);
    const ux = mag > 1e-6 ? wx[i] / mag : 0;
    const uy = mag > 1e-6 ? wy[i] / mag : 0;
    let sum = 0;
    let fwdLen = 0;
    for (let e = a; e < b; e++) {
      const j = mesh.adj[e];
      const ex = (mesh.x[j] - mesh.x[i]) / mesh.dist[e];
      const ey = (mesh.y[j] - mesh.y[i]) / mesh.dist[e];
      const dot = ux * ex + uy * ey;
      dots[e - a] = dot;
      if (dot > 0) {
        frac[e] = dot * dot * mesh.edgeLen[e];
        sum += frac[e];
        fwdLen += mesh.edgeLen[e];
      } else frac[e] = 0;
    }
    if (sum <= 0) {
      // 无风：均匀分给所有邻居（这些边不参与排序，否则会和邻居互成环）。
      // 无风带是下沉气流，空气偏干：只传出六成，两格之间来回传递的环因此不会越积越多
      let total = 0;
      for (let e = a; e < b; e++) total += mesh.edgeLen[e];
      for (let e = a; e < b; e++) frac[e] = (0.6 * mesh.edgeLen[e]) / total;
      calm[i] = 1;
      continue;
    }
    // 贴图边的格：吹向图外的部分流失
    const lostShare = mesh.boundary[i] ? Math.max(0, -(ux * mesh.inwardX[i] + uy * mesh.inwardY[i])) * 0.5 : 0;
    const keep = 1 - lostShare;
    // 侧向扩散只给下风一侧的邻居：不回流，按拓扑序扫描一遍即可推进
    for (let e = a; e < b; e++) {
      if (dots[e - a] <= 0) continue;
      frac[e] = keep * ((1 - diffuse) * (frac[e] / sum) + (diffuse * mesh.edgeLen[e]) / fwdLen);
    }
  }

  // Kahn 拓扑排序：边 i→j 当 i 有风且把水汽送往下风的 j
  const edge = (i: number, e: number) => !calm[i] && frac[e] > 0;
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (edge(i, e)) indeg[mesh.adj[e]]++;
  const order = new Int32Array(n);
  const placed = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  const place = (c: number) => {
    order[tail++] = c;
    placed[c] = 1;
  };
  // 风场里有环时，放入剩余入度最小的格（打断环的代价最小）；堆里允许过期项，弹出时跳过
  const heap = new MinHeap(n);
  for (let i = 0; i < n; i++) {
    if (indeg[i] === 0) place(i);
    else heap.push(i, indeg[i]);
  }
  while (tail < n) {
    while (head < tail) {
      const i = order[head++];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (!edge(i, e)) continue;
        const j = mesh.adj[e];
        if (placed[j]) continue;
        if (--indeg[j] === 0) place(j);
        else heap.push(j, indeg[j]);
      }
    }
    if (tail >= n) break;
    for (;;) {
      const c = heap.pop();
      if (!placed[c] && heap.lastKey === indeg[c]) {
        place(c);
        break;
      }
    }
  }
  // 只保留顺着拓扑序往下游的输送：风弱、风向杂乱的地方格与格会互相指向，
  // 水汽在环里来回累积会算出离谱的降水（格越小越严重）。去掉逆序的边后输送图无环，
  // 水汽顺风走一遍；流进死角的那部分视为随上升气流带走
  const pos = new Int32Array(n);
  for (let k = 0; k < n; k++) pos[order[k]] = k;
  for (let i = 0; i < n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (frac[e] > 0 && pos[mesh.adj[e]] < pos[i]) frac[e] = 0;
  }
  return { frac, order };
}

// 稳态输运：in_i = Σ_j out_j · frac(j→i) + 图外来流；out_i = step(i, in_i)。
// 交替按 x、y 正反顺序做 Gauss-Seidel 扫描，沿风向一遍就能推进很远。
// outside > 0 时图外来流的量为 outside；为 -1 时用 outsideAt(i)（图外是海时取当地海面饱和量）
export function solveTransport(
  mesh: Mesh,
  aux: { rev: Int32Array; orders: Int32Array[] },
  flow: Flow,
  wx: Float32Array,
  wy: Float32Array,
  outside: number,
  step: (i: number, inflow: number) => number,
  outsideAt?: (i: number) => number,
  // 没有任何上风来源的格（辐散中心）取的初值
  fallback: (i: number) => number = () => 0,
): Float64Array {
  const n = mesh.n;
  const out = new Float64Array(n);
  const { rev, orders } = aux;
  const frac = flow.frac;
  // 图外来流：作为一个虚拟的上风邻居参与平均
  const edgeW = new Float64Array(n);
  const edgeM = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!mesh.boundary[i] || outside === 0) continue;
    const mag = Math.hypot(wx[i], wy[i]);
    if (mag < 1e-6) continue;
    const dot = (wx[i] * mesh.inwardX[i] + wy[i] * mesh.inwardY[i]) / mag;
    edgeW[i] = Math.max(0, dot);
    edgeM[i] = outside > 0 ? outside : outsideAt ? outsideAt(i) : 0;
  }
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    let change = 0;
    const order = sweep % 2 === 0 ? flow.order : orders[(sweep >> 1) % 4];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      // 上风加权平均（半拉格朗日）：到达这一格的空气来自上风各格，取它们的平均，
      // 所以水汽不会在风向杂乱处被“汇流”放大，也不超过上风的最大值
      let num = edgeW[i] * edgeM[i];
      let den = edgeW[i];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const f = frac[rev[e]];
        if (f <= 0) continue;
        num += out[mesh.adj[e]] * f;
        den += f;
      }
      const inflow = den > 1e-9 ? num / den : fallback(i);
      const v = step(i, inflow);
      change = Math.max(change, Math.abs(v - out[i]));
      out[i] = v;
    }
    if (sweep >= 2 && change < 1e-4) break;
  }
  return out;
}
