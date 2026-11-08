// 海冰（第八十六轮）：冷海上的一层浅色。按海面的气温（气候的两个半年 tS、tW 与全年平均 tMean；整个星球上已含洋流，
// 海面的气温跟着海水的冷暖）：
//   · 冬天的范围：那一半球的冬半年（两季里冷的那一季）−3 °C 起渐渐结冰，−10 °C 全盖住；
//   · 夏天也不化的（多年冰）：全年平均 −10 °C 起，−18 °C 全盖住；
//   · 全年（不分季节）的画面：多年冰全盖，冬天才有的那一圈画一半。
// 只是画法（colors.ts 的海的颜色、着色器里浅水不再盖过冰），不改海陆、水文、生态。湖不结冰（湖面照旧）
import type { Derived } from './world';

export type IceSeason = 'annual' | 'summer' | 'winter';

export const SEA_ICE = {
  WINTER0: -3,
  WINTER1: -10,
  PERENNIAL0: -10,
  PERENNIAL1: -18,
  // 全年的画面里冬天才有的那一圈画多少
  SEASONAL_ANNUAL: 0.5,
  // 冰的颜色与盖住的最大比例（留一点海的颜色）
  RGB: [228, 236, 242] as const,
  ALPHA: 0.85,
};

const ramp = (t: number, a: number, b: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

// 冬天的范围（0–1）
export function winterIce(d: Pick<Derived, 'tS' | 'tW'>, i: number): number {
  return ramp(Math.min(d.tS[i], d.tW[i]), SEA_ICE.WINTER0, SEA_ICE.WINTER1);
}

// 多年冰（0–1）
export function perennialIce(d: Pick<Derived, 'tMean'>, i: number): number {
  return ramp(d.tMean[i], SEA_ICE.PERENNIAL0, SEA_ICE.PERENNIAL1);
}

// 海格 i 在这个季节的画面上盖着多少冰（0–1）。夏天：多年冰；冬天：冬天的范围（不少于多年冰）；全年：多年冰 + 冬天的一半
export function seaIceAt(d: Pick<Derived, 'tS' | 'tW' | 'tMean'>, i: number, season: IceSeason): number {
  const p = perennialIce(d, i);
  if (season === 'summer') return p;
  const w = Math.max(p, winterIce(d, i));
  if (season === 'winter') return w;
  return p + (w - p) * SEA_ICE.SEASONAL_ANNUAL;
}
