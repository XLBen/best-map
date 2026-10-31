import { smoothstep } from './rng';

// 大陆轮廓（第三十五轮）：地区（generate.ts）与整个星球（planet-gen.ts）共用的式子与常数。
//
// 裂开、漂移的大陆块（逐点的逆映射）：大块（r ≥ 0.14）一半的概率带一条弯曲的裂谷线（块的局部坐标里一条抛物线，
// 加上按漂移前的位置取的分形噪声），两半绕同一个极各转开一点（地区在平面上转，星球是欧拉极旋转）：块中心处两半分开 D，
// 离极越远开得越大，过了极不开（极在块边附近时是只裂开一半的“红海”，极很远时差不多是平移的“大西洋”）。
// 每一点先按自己在裂谷线的哪一边（漂移后的位置相对原来的裂谷线：两半对称地转开，中线就是原来的线）找到漂移前的位置，
// 这一族块（母块与它的半岛）的场、大陆的低频噪声、近地表的起伏都在漂移前的位置上算，所以两岸的海岸能对上。
// 切口：离裂谷线（漂移前、往这一半里面量）x，x ≥ 0 一侧的大陆场至多 eHard(x)（台阶：x = 0 处一定是陆地，
// 往外一点一定是海——海平面在 −70 到 210 m、海岸噪声 ±180 m、近地表起伏都压不过去），所以海岸就在切口上，两岸逐点对上；
// 外侧是宽的大陆架（地壳高度 −420 到 −600 m：海底的后处理把它当陆壳）、陆坡、深海。造山、基准面、丘陵用的“形状”场
// 按 eSoft（从海岸 0.02 往内陆缓缓抬起），裂开的海岸是低平的被动边缘，往里是大陡崖（T_esc）。
//
// 地峡：块与块之间一条弯曲的窄带（折线），中线上大陆场是 C_IN（一定是陆地），不加噪声；近地表的起伏压低七成。

// 切口的内侧：台阶的高与往里抬的快慢；“形状”场从海岸往内陆
export const C_IN = 0.8;
const G_IN = 8;
const SOFT_C = 0.02;
const SOFT_G = 4.5;
// 外侧：大陆架（宽 ws）、陆坡（宽 wsl）、深海
const SHELF_C = -0.0135;
const SHELF_END = -0.0175;
const SLOPE_END = -0.08;
const DEEP_G = 4;

// 切口外侧的大陆场（x < 0，按切口往外量的距离）
function eOut(x: number, ws: number, wsl: number): number {
  const t = -x;
  if (t < ws) return SHELF_C + ((SHELF_END - SHELF_C) * t) / ws;
  if (t < ws + wsl) return SHELF_END + ((SLOPE_END - SHELF_END) * (t - ws)) / wsl;
  return SLOPE_END - DEEP_G * (t - ws - wsl);
}

export function eHard(x: number, ws: number, wsl: number): number {
  return x >= 0 ? C_IN + G_IN * x : eOut(x, ws, wsl);
}

export function eSoft(x: number, ws: number, wsl: number): number {
  return x >= 0 ? SOFT_C + SOFT_G * x : eOut(x, ws, wsl);
}

// 大陆架、陆坡按这一处两半分开了多少（disp：这一点到漂移前位置的距离，约是缝宽的一半）定宽窄；
// 缝很窄（不到一格）时把切口往外挪，缝合上（不留一串单格的海）
export const SHELF = { wsMax: 0.03, wslMax: 0.012, wsK: 0.45, wslK: 0.3, close: 0.006 };
export function shelfWidth(disp: number, max: number, k: number): number {
  return Math.min(max, k * disp) + 1e-4;
}
export function closeGap(x: number, disp: number): number {
  return disp < SHELF.close ? x + 2 * (SHELF.close - disp) : x;
}

// 裂谷线的弯曲噪声：幅度、频率、层数（分形：海岸也是分形的，按漂移前的位置取，两岸一样）
export const WIGGLE = { amp: 0.035, freq: 3.5, oct: 6, gain: 0.55 };

// 缝里的洋中脊：半宽（与板块的洋中脊相同），缝开到多宽才有（按 disp）
export const RIDGE_W = 0.04;
export function ridgeOpen(disp: number): number {
  return smoothstep(0.004, 0.02, disp);
}

// 近地表起伏（分形噪声）在切口两侧的倍数：缝里不加（宽的大陆架、陆坡平整），切口内侧 0.012 以内压到四成
export function reliefNear(x: number): number {
  return x < 0 ? 0 : 1 - 0.6 * (1 - smoothstep(0, 0.012, x));
}

// 被动边缘的大陡崖：裂开的海岸往里 0.1–0.2 以内至少有一半（分段的噪声、“离活动边缘多远”都至少 0.5）。
// 整段都有（1）时沿海低地少了：区域 12 个种子 200 m 以下 28.4% → 25.7%、低平地 14.9% → 11.7%、低处大干流两旁高出 59 → 65 m；
// 不加时 200 m 以下 30.7%、最长流路 ÷ 直径 0.70。一半时这几项与第三十四轮差不多
export const ESC_K = 0.5;
export function escNear(x: number): number {
  return x < 0 ? 0 : ESC_K * (1 - smoothstep(0.1, 0.2, x));
}

// 地峡：中线上的大陆场、近地表起伏压低的权重（两端 15% 渐渐不压）
// 半宽以外往下降（窄的岛架）：外接圆的边上已到深海（建地峡时外接圆比折线多 ISTHMUS_PAD）
export const ISTHMUS_PAD = 0.12;
export function isthmusC(d: number, w: number): number {
  return d < w ? C_IN * (1 - smoothstep(0.4, 1, d / w)) : -3 * (d - w);
}
export function isthmusW(d: number, w: number, t: number): number {
  return (1 - smoothstep(0.5, 1.5, d / w)) * smoothstep(0, 0.15, t) * smoothstep(0, 0.15, 1 - t);
}

// 三角形的半岛：沿长轴（往外为正，u / r 从 −1 到 1）宽度从 1 收到 1 − tri（尖端），整体加宽 TRI_W
export const TRI_W = 1.25;
export function triWidth(uOverR: number, tri: number): number {
  const t = Math.min(1.2, Math.max(0, 0.5 + 0.5 * uOverR));
  return TRI_W * Math.max(0.1, 1 - tri * t);
}
