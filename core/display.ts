import { wrapX } from './geo';
import { findCell } from './mesh';
import { type SeamLayers, seamLayers, seamPick } from './seams';
import { coastDetail, coastDetail3, coastDetailAmp, coastValues, locate, warpOffset, warpOffset3 } from './subcell';
import { coastSeed } from './terrain';
import type { World } from './world';

// 屏幕上的一点画的是哪一格：与着色器同一套规则（src/render/renderer.ts 的 FS_COMPOSE 与地形层）。
//   · 陆还是海：三角形内插值的海岸值 + 格以下的海岸细节（地形层画海岸线的那一条，见 subcell.ts 的 pointIsLand；
//     整个星球上细节噪声在球面上取，与着色器、导出相同）；
//   · 生态、省份着色、省界按扭曲后的位置取最近的格（着色器的 id），省份再按剪刀切线的规则换格（着色器的 idG）。
// 着色器取格时不看陆海（导出的位图另外换成同类的邻格），所以海岸附近“画成陆地的像素”取到的格可能是海格：
// 悬停卡片、吸取生态、点地名要说的是这一点画成的陆地或海，用 here（与这一点同类的格：同类时就是 cell，
// 不同类时按导出的规则换成最近的同类邻格）。
// 悬停卡片“这里”、Alt 吸取、选省、合并、点地名都用它：说的、取的就是屏幕上画出来的那一格

export interface DisplayCell {
  // 扭曲后的最近格（着色器的 id：生态的平涂、按格着色的视图画的是它）
  cell: number;
  // 这一点画成陆地还是海
  land: boolean;
  // 与这一点同类的格（描述这里是什么、吸取生态、点地名用）
  here: number;
  // 省份按哪一格算（剪刀切线附近按在线的哪一边换过：省界、省份着色画的是它）
  province: number;
}

// 海岸值按陆度数组缓存（同一个世界只算一次；只改了名字、省份的轻快照沿用同一个数组）
const coastCache = new WeakMap<Float32Array, { land: Uint8Array; rough: number; seed: number; s: Float32Array }>();
function coastOf(world: World): Float32Array {
  const { causes } = world;
  const rough = world.small.terrain.coastRoughness;
  const seed = coastSeed(world);
  const c = coastCache.get(causes.landness);
  if (c && c.land === causes.land && c.rough === rough && c.seed === seed) return c.s;
  const s = coastValues(world);
  coastCache.set(causes.landness, { land: causes.land, rough, seed, s });
  return s;
}

// 切线的分组按省份数组与切线缓存（鼠标每动一下都要查）
const seamCache = new WeakMap<Int32Array, { seams: unknown; L: SeamLayers | null }>();
function seamsOf(world: World): SeamLayers | null {
  const seams = world.small.provinceSeams;
  if (!seams?.length) return null;
  const province = world.causes.province;
  const c = seamCache.get(province);
  if (c && c.seams === seams) return c.L;
  const L = seamLayers(world, province, seams);
  seamCache.set(province, { seams, L });
  return L;
}

// (x, y)：地图单位（整个星球上 x 可以在平铺的任何一份里）；hint：附近的格（找格的起点，比如上一次的结果）
export function displayCellAt(world: World, x: number, y: number, hint = 0): DisplayCell {
  const { mesh, causes, derived } = world;
  const sphere = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const px = sphere ? wrapX(x) : x;
  // 陆还是海：与 rasterizeWorld 逐像素的判定相同
  const s = coastOf(world);
  const loc = locate(mesh, px, y, hint);
  const [a, b, c] = loc.i;
  const [wa, wb, wc] = loc.w;
  const sv = s[a] * wa + s[b] * wb + s[c] * wc;
  const h = derived.elevation[a] * wa + derived.elevation[b] * wb + derived.elevation[c] * wc;
  const weight = Math.min(1, Math.max(0, (1 - Math.max(wa, wb, wc)) * 2.2));
  const detail = sphere ? coastDetail3(px, y, sp) : coastDetail(px, y, sp);
  const land = sv + weight * coastDetailAmp(world, Math.max(0, h)) * detail > 0;
  // 扭曲后的最近格（整个星球：南北夹在两极以内，与着色器相同）
  const [wx, wy] = sphere ? warpOffset3(px, y, sp) : warpOffset(px, y, sp);
  const qy = sphere ? Math.min(1, Math.max(0, y + wy)) : y + wy;
  const cell = findCell(mesh, px + wx, qy, loc.nearest);
  const here = (causes.land[cell] === 1) === land ? cell : sameKindNear(world, land, cell, loc.nearest, px, y);
  return { cell, land, here, province: seamPick(seamsOf(world), world, px, y, cell) };
}

// 最近格、扭曲后那一格与最近格的邻格里，离这一点最近的同类格（与导出 rasterizeWorld 的 sameKindCell 相同）；都不同类时保持原格
function sameKindNear(world: World, land: boolean, cell: number, near: number, x: number, y: number): number {
  const { mesh, causes } = world;
  let best = -1;
  let bd = Infinity;
  const tryCell = (j: number) => {
    if ((causes.land[j] === 1) !== land) return;
    const dx = mesh.kind === 'sphere' ? mesh.x[j] - x - 2 * Math.round((mesh.x[j] - x) / 2) : mesh.x[j] - x;
    const d = dx * dx + (mesh.y[j] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = j;
    }
  };
  tryCell(near);
  for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) tryCell(mesh.adj[e]);
  for (let e = mesh.off[near]; e < mesh.off[near + 1]; e++) tryCell(mesh.adj[e]);
  return best >= 0 ? best : cell;
}
