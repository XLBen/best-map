// 第八十五轮的冰川刻蚀（测试用，见 glacialLegacy）：在高程求解里按原始单位挖（第三十四轮到第八十五轮的写法，原样拷贝）。
// 第八十六轮起冰川挪出求解、在流水线里按米另挖（glacial.ts 的 scourTerrain），气候按没挖的地形算。
// glacialLegacy.on 时照第八十五轮的做法：求解里挖、流水线不再挖。只给按第八十五轮录下的快照的测试用（src/ui/tool-replay.test.ts），
// 与 precipOn、BELT.M0、RELIEF_TUNING 一起把地形退回第八十五轮
import type { Mesh } from './mesh';
import { GLACIAL, type GlacialField, glacialOn, glacialStats } from './glacial';

export const glacialLegacy = { on: false };

const sm01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 挖：todo 里的陆格，低于高度上限的小洼（depth > 0 的格连成的一片）按四周最低的岸取平底，再往下挖 depth（按高度、离海渐弱）：
// 一片小洼一定低过它的岸，水文照常按溢出口蓄成湖（只往下挖、不取平底时，坡上的一片洼常常顺着坡就流走了）。
// 一片洼只看它自己与四周的岸（岸不挖），与陆块、洼之间的先后无关。h、mToRaw 是求解的原始单位
export function glacialScourInSolve(f: GlacialField, mesh: Mesh, todo: Uint8Array, land: Uint8Array, coastKm: Float64Array, kmPerUnit: number, mToRaw: number, h: Float64Array): void {
  if (!f.any || !glacialOn.on) return;
  const n = h.length;
  const dig = new Float64Array(n);
  if (!scourDepths(f.depth, f.limit, todo, land, coastKm, mesh.spacing * kmPerUnit, mToRaw, h, dig)) return;
  glacialStats.carved += scourBlobs(mesh, dig, h);
}

// 每格要挖多深（原始单位，0 不挖）；返回有没有要挖的（模块里的小函数：很快被编译优化）
function scourDepths(depth: Float32Array, limit: Float32Array, todo: Uint8Array, land: Uint8Array, coastKm: Float64Array, cellKm: number, mToRaw: number, h: Float64Array, dig: Float64Array): boolean {
  const C = GLACIAL;
  let any = false;
  for (let i = 0; i < h.length; i++) {
    const d = depth[i];
    if (d <= 0 || todo[i] !== 1 || land[i] !== 1) continue;
    const lim = limit[i];
    const low = 1 - sm01((h[i] / mToRaw - C.ELEV_FULL * lim) / ((1 - C.ELEV_FULL) * lim));
    if (low <= 0) continue;
    const fade = sm01((coastKm[i] - C.COAST_CELLS0 * cellKm) / (C.COAST_CELLS1 * cellKm));
    if (fade <= 0) continue;
    dig[i] = d * low * fade * mToRaw;
    any = true;
  }
  return any;
}

// 要挖的格连成的一片：按四周最低的岸取平底再挖。返回挖了几格
function scourBlobs(mesh: Mesh, dig: Float64Array, h: Float64Array): number {
  const { off, adj } = mesh;
  const n = h.length;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let carved = 0;
  for (let s = 0; s < n; s++) {
    if (dig[s] <= 0 || seen[s]) continue;
    let len = 0;
    queue[len++] = s;
    seen[s] = 1;
    let rim = Infinity;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (dig[j] > 0) {
          if (!seen[j]) {
            seen[j] = 1;
            queue[len++] = j;
          }
        } else if (h[j] < rim) rim = h[j];
      }
    }
    // 一两格的不挖（与挖洼地的 PIT_MIN_CELLS 一样）：水文不把一两格的洼地当湖（没有自己的湖省；海岸上画成水面的像素
    // 找省份时会找到它所在的陆上的省），格以下的小湖由画法的小湖群画
    if (len < GLACIAL.MIN_CELLS) continue;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      const floor = rim - dig[c];
      if (floor < h[c]) h[c] = floor;
    }
    carved += len;
  }
  return carved;
}
