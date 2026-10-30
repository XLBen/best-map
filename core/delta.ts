import type { World } from './world';

// ---------- 三角洲的画法（第三十三轮） ----------
// 高程求解在大河口压出三角洲平原（core/plains.ts）；画的时候在这些河口：
//   · 亚格子海岸向海凸出一点（deltaBulge，不超过半格；格心的陆海不变，causes.land 一格不改）；
//   · 水多的河在河口前分几股入海（core/rivers.ts 的 deltaBranches）。
// 哪些河口是三角洲按推导认（水文的流向、汇水面积、高程）：只改气候时流向、汇水面积几乎不变，高程一格不变

export const DELTA_DRAW = {
  // 河口那一格（流进海的陆格）的汇水面积（km²）至少这么多：与三角洲平原（plains.ts 的 DELTA_KM2）同一个门槛
  KM2: 1e5,
  // 河口那一格不高于这么多（m，按默认的“最高的山”6000 m，随它缩放）：三角洲平原压到 1–4 m；
  // 河口在山脚下、陡岸上（活动边缘）的大河没有三角洲平原，也就没有凸出的岸、不分汊
  TOP_M: 5,
  // 三角洲的大小：半径 0.12·√A km（与三角洲平原同一个算式）。不到这么多格的不画（格很大时三角洲在一格以下，画出来不成比例）
  R: 0.12,
  MIN_CELLS: 0.25,
  // 凸出的范围（格，从河口那格的格心量到海格的格心）与最多凸出多少（格；也不超过三角洲的半径）
  BULGE_R: 1.6,
  BULGE_FULL: 0.6,
  BULGE_SHIFT: 0.5,
  // 分汊：河口的流量至少是门槛的这么多倍（计划写的是 8 倍：汇水面积超过 20 万 km² 的入海大河里流量到 8 倍门槛的地区上只有约三成，
  // 分汊的只有一成多；放到 2 倍，像尼罗河那样水不多的大河也有三角洲）
  FLOW: 2,
};

// 三角洲的半径（格）
export const deltaCells = (world: World, i: number) => (DELTA_DRAW.R * Math.sqrt(world.derived.drainArea[i])) / (world.mesh.spacing * world.kmPerUnit);

// 三角洲的河口：陆格（不是湖面），流向海，汇水面积 ≥ KM2、高程 ≤ TOP_M、三角洲的半径至少 MIN_CELLS 格。按编号排好
export function deltaMouths(world: World): number[] {
  const { mesh, causes, derived: d, small } = world;
  const land = causes.land;
  const top = DELTA_DRAW.TOP_M * Math.max(1, small.planet.mountainScale / 6000);
  const cellKm = mesh.spacing * world.kmPerUnit;
  const minKm2 = Math.max(DELTA_DRAW.KM2, ((DELTA_DRAW.MIN_CELLS * cellKm) / DELTA_DRAW.R) ** 2);
  const out: number[] = [];
  const n = mesh.n;
  const recv = d.receiver;
  const area = d.drainArea;
  const elev = d.elevation;
  const lake = d.lake;
  for (let i = 0; i < n; i++) {
    if (land[i] !== 1 || area[i] < minKm2 || elev[i] > top || lake[i] === 1) continue;
    const r = recv[i];
    if (r >= 0 && land[r] === 0) out.push(i);
  }
  return out;
}

// 三角洲的海岸向海凸出：河口附近（BULGE_R 格以内）挨着陆地的海格的海岸值往 0 抬，
// 抬到每条从陆格到它的边上岸线最多往海里挪 min(BULGE_SHIFT, 三角洲的半径)·w 格（w 离河口 BULGE_FULL 格以内是 1，到 BULGE_R 格渐渐到 0）。
// 海格的值仍 ≤ −1（格心仍画成海）。几个三角洲挨着时取抬得最多的（与先后无关）。s：每格的海岸值，就地改
export function deltaBulge(world: World, s: Float32Array): void {
  const mouths = deltaMouths(world);
  if (!mouths.length) return;
  const { mesh, causes } = world;
  const land = causes.land;
  const { off, adj, dist } = mesh;
  const sp = mesh.spacing;
  const R = DELTA_DRAW.BULGE_R * sp;
  const raise = new Map<number, number>();
  for (const m of mouths) {
    // 河口附近的海格：从河口那格沿海格走（按边长），R 以内
    const seen = new Map<number, number>([[m, 0]]);
    const queue = [m];
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      const dc = seen.get(c)!;
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (land[j]) continue;
        const dj = dc + dist[e];
        if (dj > R) continue;
        const old = seen.get(j);
        if (old !== undefined && old <= dj) continue;
        seen.set(j, dj);
        queue.push(j);
      }
    }
    for (const [j, dj] of seen) {
      if (j === m) continue;
      const w = 1 - smooth((dj / sp - DELTA_DRAW.BULGE_FULL) / (DELTA_DRAW.BULGE_R - DELTA_DRAW.BULGE_FULL));
      if (w <= 0) continue;
      const v = bulgeValue(mesh, land, s, j, Math.min(DELTA_DRAW.BULGE_SHIFT, deltaCells(world, m)) * w);
      if (v > (raise.get(j) ?? -Infinity)) raise.set(j, v);
    }
  }
  for (const [j, v] of raise) if (v > s[j]) s[j] = v;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 海格 j 的海岸值最多抬到多少：每个陆上的邻格 a 到它的边上，岸线（两格的值线性内插为 0 处）往海里最多挪 shift 格（边上的比例不过 0.95）。
// 没有陆上的邻格时不抬（返回原值）
function bulgeValue(mesh: World['mesh'], land: Uint8Array, s: Float32Array, j: number, shift: number): number {
  const sj = s[j];
  let best = Infinity;
  for (let e = mesh.off[j]; e < mesh.off[j + 1]; e++) {
    const a = mesh.adj[e];
    if (!land[a]) continue;
    const sa = s[a];
    if (!(sa > 0) || !(sj < 0)) continue;
    const t0 = sa / (sa - sj);
    // 挪 shift 格：按这条边的长短折成边上的比例
    const t1 = Math.min(0.95, t0 + (shift * mesh.spacing) / mesh.dist[e]);
    best = Math.min(best, sa * (1 - 1 / t1));
  }
  if (!Number.isFinite(best)) return sj;
  return Math.min(-1, Math.max(sj, best));
}
