import { ContentMemo } from './climate';
import { sinkMask } from './elevation';
import { gradient } from './mesh';
import { type Routing, route } from './routing';
import type { Derived, World } from './world';

// 水文：径流（Budyko 曲线）→ 汇流 → 河流与湖泊。
// 洼地按溢出口蓄水；干旱区入流不足以抵消湖面蒸发时成为内流湖，只占洼地的一部分。
// 水文从不手绘：手工意图通过河道引导（改汇流方向）和湖（挖洼地）表达，结果始终与高程、气候一致。

const SEC_PER_YEAR = 3.156e7;

// 汇流只取决于高程、海陆、画的河强制的方向和在哪里消失：只改气候、河流门槛时（以及约束求解的每一轮）原样复用，结果只读
export const routeMemo = new ContentMemo<Routing>();

export function computeHydrology(world: World, elevation: Float32Array, d: Derived) {
  const { mesh, causes, small, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const forced = new Int32Array(n).fill(-1);
  for (const g of small.guides) for (let k = 0; k < g.cells.length - 1; k++) if (land[g.cells[k]]) forced[g.cells[k]] = g.cells[k + 1];
  // 在终点消失的河：那一格当作出口（水流到那里就没了）。没有这种河时与原来逐值相同
  const sinks = sinkMask(world);
  const terminal = sinks ?? new Uint8Array(n);
  let r = routeMemo.find(mesh, [elevation, land, forced, terminal], []);
  if (!r) {
    r = route(mesh, elevation, land, forced, sinks ?? undefined);
    routeMemo.keep(mesh, [elevation.slice(), land.slice(), forced, terminal], [], r);
  }

  const areaKm = new Float64Array(n);
  for (let i = 0; i < n; i++) areaKm[i] = mesh.area[i] * kmPerUnit * kmPerUnit;

  // 湖：填洼深度超过 3 m 的连通平水面
  const lakeId = new Int32Array(n).fill(-1);
  const lakes: { cells: number[]; outlet: number; area: number; perennial: boolean; evap: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || lakeId[i] >= 0 || r.water[i] - elevation[i] < 0.5) continue;
    const id = lakes.length;
    const cells = [i];
    lakeId[i] = id;
    let maxDepth = 0;
    for (let h = 0; h < cells.length; h++) {
      const c = cells[h];
      maxDepth = Math.max(maxDepth, r.water[c] - elevation[c]);
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (land[j] && lakeId[j] < 0 && Math.abs(r.water[j] - r.water[i]) < 1e-6 && r.water[j] - elevation[j] >= 0.5) {
          lakeId[j] = id;
          cells.push(j);
        }
      }
    }
    lakes.push({ cells, outlet: -1, area: 0, perennial: false, evap: 0 });
    // 太浅的不算湖；只有一两格的自然洼地多半是高程平滑留下的小坑，也不算（水照常流过），
    // 否则荒漠里会有零星的蓝点。用户放的湖照旧
    const tiny = cells.length < 3 && !small.lakes.some((l) => cells.includes(l.cell));
    if (maxDepth < 3 || tiny) for (const c of cells) lakeId[c] = -2 - id;
  }
  for (const spec of small.lakes) {
    const id = lakeId[spec.cell];
    if (id >= 0 && spec.perennial) lakes[id].perennial = true;
  }
  for (let id = 0; id < lakes.length; id++) {
    const L = lakes[id];
    if (lakeId[L.cells[0]] !== id) continue;
    for (const c of L.cells) {
      L.area += areaKm[c];
      // 湖面蒸发约等于潜在蒸散（mm/年）→ m³/s
      L.evap += (d.pet[c] * 1e-3 * areaKm[c] * 1e6) / SEC_PER_YEAR;
      const rc = r.receiver[c];
      if (rc < 0 || lakeId[rc] !== id) L.outlet = c;
    }
  }

  // 本地产流（m³/s）
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const P = d.precip[i];
    let R: number;
    if (lakeId[i] >= 0) R = P;
    else if (d.tWarm[i] < 0) R = P * 0.9;
    else {
      const phi = d.pet[i] / Math.max(P, 1e-6);
      const w = 2.6;
      const et = P * (1 + phi - Math.pow(1 + Math.pow(phi, w), 1 / w));
      R = Math.max(0, P - et);
    }
    local[i] = (R * 1e-3 * areaKm[i] * 1e6) / SEC_PER_YEAR;
  }
  // 画的河：源头的泉水让整条河从源头起就可见（沿河道往下的流量都不低于它）；
  // 选了更大的河，多出来的水沿路线平均加进来（末端那格除外），河越往下越宽
  for (const g of small.guides) {
    if (!g.spring || !land[g.cells[0]]) continue;
    local[g.cells[0]] += 1.2 * small.planet.riverThreshold;
    if (g.flow === undefined || g.flow <= 1.2) continue;
    const body = g.cells.slice(0, -1).filter((c) => land[c]);
    const extra = ((g.flow - 1.2) * small.planet.riverThreshold) / body.length;
    for (const c of body) local[c] += extra;
  }

  const Q = new Float64Array(n);
  const A = new Float64Array(n);
  const lakeFill = new Float64Array(lakes.length).fill(1);
  for (let k = 0; k < r.count; k++) {
    const i = r.order[k];
    Q[i] = local[i];
    A[i] = areaKm[i];
  }
  for (let k = r.count - 1; k >= 0; k--) {
    const i = r.order[k];
    const id = lakeId[i];
    if (id >= 0 && lakes[id].outlet === i && !lakes[id].perennial) {
      const loss = lakes[id].evap;
      if (Q[i] < loss) lakeFill[id] = Q[i] / loss;
      Q[i] = Math.max(0, Q[i] - loss);
    }
    const j = r.receiver[i];
    if (j >= 0 && land[j]) {
      Q[j] += Q[i];
      A[j] += A[i];
    }
  }

  d.lake.fill(0);
  d.water.fill(0);
  for (let id = 0; id < lakes.length; id++) {
    const L = lakes[id];
    if (lakeId[L.cells[0]] !== id) continue;
    if (lakeFill[id] >= 1) {
      for (const c of L.cells) {
        d.lake[c] = 1;
        d.water[c] = r.water[c];
      }
      continue;
    }
    // 内流湖：只淹到蒸发与入流平衡的面积，从最低处起
    const sorted = [...L.cells].sort((a, b) => elevation[a] - elevation[b]);
    const target = L.area * lakeFill[id];
    let acc = 0;
    let level = elevation[sorted[0]];
    for (const c of sorted) {
      if (acc >= target) break;
      acc += areaKm[c];
      level = elevation[c];
      d.lake[c] = 1;
    }
    for (const c of sorted) if (d.lake[c]) d.water[c] = Math.max(level, elevation[c] + 0.5);
    // 洼地里没被水淹的部分是干盐湖
    for (const c of L.cells) if (!d.lake[c]) d.lake[c] = 2;
  }

  for (let i = 0; i < n; i++) {
    d.discharge[i] = land[i] ? Q[i] : 0;
    d.drainArea[i] = land[i] ? A[i] : 0;
    d.receiver[i] = land[i] ? r.receiver[i] : -1;
  }
  // 流域：沿下游方向找到出海口
  d.basin.fill(-1);
  for (let k = 0; k < r.count; k++) {
    const i = r.order[k];
    const j = r.receiver[i];
    d.basin[i] = j >= 0 && land[j] ? d.basin[j] : i;
  }
  // 坡度（m/km）与地形湿度指数 ln(a / tanβ)
  const hPos = new Float64Array(n);
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? elevation[i] : 0;
  for (let i = 0; i < n; i++) {
    if (!land[i]) {
      d.slope[i] = 0;
      d.wetness[i] = 0;
      continue;
    }
    const [gx, gy] = gradient(mesh, hPos, i);
    const s = Math.hypot(gx, gy) / kmPerUnit;
    d.slope[i] = s;
    // 单位宽度汇水面积（m）：面积 / 格宽
    const width = Math.sqrt(areaKm[i]) * 1000;
    const a = (A[i] * 1e6) / width;
    d.wetness[i] = Math.log(a / Math.max(s / 1000, 1e-5));
  }
}
