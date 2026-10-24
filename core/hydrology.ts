import { ContentMemo } from './climate';
import { placedLakeAnchor, sinkMask } from './elevation';
import { gradient } from './mesh';
import { type Routing, route } from './routing';
import { type Derived, FREE_HEIGHT, type World } from './world';

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
  // 分出去的一股（branch）：第一格在干流上，它的流向不改（水按比例分出去，见下面）
  for (const g of small.guides) for (let k = g.branch ? 1 : 0; k < g.cells.length - 1; k++) if (land[g.cells[k]]) forced[g.cells[k]] = g.cells[k + 1];
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

  // 湖里的岛（第十五轮，定了高度的格，见 terrain.ts 的 lakeIslandStamp）永远是干的陆地：不算进湖
  // （内流湖涨落、湖岸抬高时也不会淹掉、变成干盐湖）。没有往湖里放过岛时与以前逐值相同
  const fixed = causes.islandHeight;
  const wet = (i: number) => r.water[i] - elevation[i] >= 0.5 && (!fixed || fixed[i] === FREE_HEIGHT);
  // 放的湖认哪一格（湖心那一格不再是水面时取碗里最近的水面格，见 placedLakeAnchor）
  const anchors = small.lakes.map((l) => placedLakeAnchor(world, l, (i) => land[i] === 1 && wet(i)));
  // 湖：填洼深度超过 3 m 的连通平水面
  const lakeId = new Int32Array(n).fill(-1);
  const lakes: { cells: number[]; outlet: number; area: number; perennial: boolean; evap: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || lakeId[i] >= 0 || !wet(i)) continue;
    const id = lakes.length;
    const cells = [i];
    lakeId[i] = id;
    let maxDepth = 0;
    for (let h = 0; h < cells.length; h++) {
      const c = cells[h];
      maxDepth = Math.max(maxDepth, r.water[c] - elevation[c]);
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (land[j] && lakeId[j] < 0 && Math.abs(r.water[j] - r.water[i]) < 1e-6 && wet(j)) {
          lakeId[j] = id;
          cells.push(j);
        }
      }
    }
    lakes.push({ cells, outlet: -1, area: 0, perennial: false, evap: 0 });
    // 太浅的不算湖；只有一两格的自然洼地多半是高程平滑留下的小坑，也不算（水照常流过），
    // 否则荒漠里会有零星的蓝点。用户放的湖照旧
    const tiny = cells.length < 3 && !anchors.some((a) => cells.includes(a));
    if (maxDepth < 3 || tiny) for (const c of cells) lakeId[c] = -2 - id;
  }
  small.lakes.forEach((spec, k) => {
    const id = lakeId[anchors[k]];
    if (id >= 0 && spec.perennial) lakes[id].perennial = true;
  });
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

  splitFlows(world, r, land, Q);

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
  // 画的河（有折线的河道）整条都是河：水不够的格按最小的河的水量补上（只补这一格，不往下游加），
  // 所以画出来的线一路都在，预览里画的就是松手后的。最后一格汇入别的河时本来就是河（补不补一样）；
  // 那条河后来没了时，这一格就是这条河自己的。没有画的河时什么都不做（逐值照旧）
  // 只补水真的照这条河道走的那段：到被别的河道接管的一格（后画的河从这里截走了它）为止，截下的下游照样变干
  const minQ = small.planet.riverThreshold * (1 + 1e-6);
  for (const g of small.guides) {
    if (!g.path) continue;
    const cells = g.cells;
    // 分出去的一股从第二格起（第一格是干流的）
    for (let k = g.branch ? 1 : 0; k < cells.length; k++) {
      const c = cells[k];
      if (!land[c]) break;
      if (d.lake[c] !== 1 && d.discharge[c] < minQ) d.discharge[c] = minQ;
      // 按路由实际的下游（强制方向绕成圈时那几格恢复成了自然的流向：水不照这条河道走，不再往下补）
      if (k + 1 < cells.length && r.receiver[c] !== cells[k + 1]) break;
    }
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

// ---------- 分流（第十三轮） ----------
// 分出去的一股（guide.branch）：分出的那一格 s 的水按 share 分一部分沿这条河道流走。流向仍是一格一个下游（流域、拓扑序都不变），
// 只是流量：从这条河道的第二格起顺着下游加上 share × Q[s]，从 s 的下游起顺着干流往下减去同样多（不小于 0）。
// 分出去的又流回干流（汇回同一条河的下游）时，汇合以下加减相抵，水回到干流。上游的分流先算（下游的分流按算过的水量分）
function splitFlows(world: World, r: Routing, land: Uint8Array, Q: Float64Array) {
  const { small, mesh } = world;
  const splits = small.guides.filter((g) => g.branch && g.cells.length >= 2 && land[g.cells[0]] && land[g.cells[1]]);
  if (!splits.length) return;
  const pos = new Int32Array(mesh.n).fill(-1);
  for (let k = 0; k < r.count; k++) pos[r.order[k]] = k;
  // 上游的先算：在拓扑序（下游在前）里靠后的先
  const list = splits.map((g, i) => ({ g, i, at: pos[g.cells[0]] })).filter((x) => x.at >= 0);
  list.sort((a, b) => b.at - a.at || a.i - b.i);
  for (const { g } of list) {
    const s = g.cells[0];
    const amount = g.branch!.share * Q[s];
    if (!(amount > 0)) continue;
    for (let c = g.cells[1], guard = 0; c >= 0 && land[c] && c !== s && guard < mesh.n; c = r.receiver[c], guard++) Q[c] += amount;
    for (let c = r.receiver[s], guard = 0; c >= 0 && land[c] && guard < mesh.n; c = r.receiver[c], guard++) Q[c] = Math.max(0, Q[c] - amount);
  }
}

// ---------- 自然湖的湖底（第十二轮） ----------
// 自然的湖是填洼填出来的：水面平，湖底就是洼地本来的地形，常常只有几米深、一片平。这里在水文算完之后
// 把洼地的底按离岸的距离往下修成真实的样子：岸边浅、往里变深，最深处随洼地的面积（约 12 m × 面积^0.3，
// 1 km² 约 12 m，1 万 km² 约 190 m，最多 600 m）。修的是整片洼地（湖面与干涸的湖底，d.lake 为 1 或 2）：
// 洼地在哪里、多大只取决于地形（填洼），与气候无关，所以湖底不随气候变（湖干了、涨了，底还是那个底）；
// 深度从洼地里最高的那格往下量。只往深里挖，不改水面、湖的范围与流向；
// 用户放的湖（userLake 里的格）已经有自己的湖底，不动。只改 d.elevation（地形底图、导出、检查器看到的湖底）
export function shapeLakeBeds(world: World, d: Derived, userLake: Uint8Array | null) {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const { off, adj } = mesh;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const dist = new Float64Array(n).fill(Infinity);
  const cellKm = mesh.spacing * kmPerUnit;
  const inBasin = (i: number) => land[i] === 1 && d.lake[i] !== 0 && !userLake?.[i];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !inBasin(s)) continue;
    // 一片洼地：相连的湖格与干湖底格
    let len = 0;
    queue[len++] = s;
    seen[s] = 1;
    let area = 0;
    let ref = -Infinity;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      area += mesh.area[c] * kmPerUnit * kmPerUnit;
      ref = Math.max(ref, d.elevation[c]);
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (!seen[j] && inBasin(j)) {
          seen[j] = 1;
          queue[len++] = j;
        }
      }
    }
    const cells = queue.slice(0, len);
    // 离岸的距离（km）：从挨着岸的格起，只在这片洼地里走
    const order: number[] = [];
    for (const c of cells) {
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (!inBasin(j)) {
          dist[c] = 0;
          order.push(c);
          break;
        }
      }
    }
    for (let q = 0; q < order.length; q++) {
      const c = order[q];
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (!inBasin(j)) continue;
        const nd = dist[c] + mesh.dist[e] * kmPerUnit;
        if (nd < dist[j]) {
          dist[j] = nd;
          order.push(j);
        }
      }
    }
    let far = 0;
    for (const c of cells) if (dist[c] < Infinity) far = Math.max(far, dist[c]);
    const maxDepth = Math.min(600, Math.max(4, 12 * Math.pow(area, 0.3)));
    for (const c of cells) {
      const s01 = Math.min(1, ((dist[c] < Infinity ? dist[c] : far) + 0.5 * cellKm) / (far + 0.5 * cellKm));
      // 岸边一圈浅滩，往里落下去，中间平缓
      const f = 0.12 + 0.88 * (s01 * s01 * (3 - 2 * s01));
      const bed = ref - maxDepth * f;
      if (bed < d.elevation[c]) d.elevation[c] = bed;
    }
  }
}
