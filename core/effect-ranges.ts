// 同一个数一套范围和单位（第九十三轮）：生态编辑器的滑块、资源库通用表单的字段表（core/content/kinds.ts）以前各写各的——
// 同一个“变暖变冷”一处 ±5、一处 ±10，“变湿变干”一处写百分比、一处写指数，“范围”一处写千米、一处写 km。
// 这里是唯一的一处定义，两边都引用它。只是滑块的范围、步子、单位：已有的值不换算、不改，格式（schema）收的范围照旧。
// 不引用别的模块（species.ts、kinds.ts、界面都能引用）

export interface NumRange {
  min: number;
  max: number;
  step: number;
  // 写在数后面；'%' 是存 0–1、写成百分之几（和字段表的 unit 一样）
  unit?: string;
}

// 生态的强弱：内置的在 1.5–4.5 之间。格式收到 100；超过 10 的值照旧留着，滑块停在最右
export const COMPETITION: NumRange = { min: 0.5, max: 10, step: 0.1 };

// 变暖变冷（生态对周围的影响、河湖的岸边）
export const EFFECT_DT: NumRange = { min: -10, max: 10, step: 0.5, unit: '°C' };

// 变湿变干：存的是指数 dP（降水乘以 e 的 dP 次方）
export const EFFECT_DP: NumRange = { min: -1.5, max: 1.5, step: 0.05 };

// 影响的范围。生态的和岸边的是两个数（格式收的范围不同），步子、单位一样
export const BIOME_RADIUS: NumRange = { min: 20, max: 3000, step: 10, unit: 'km' };
export const BANK_RADIUS: NumRange = { min: 10, max: 1000, step: 10, unit: 'km' };
// 第一次设岸边的影响时的范围（没写范围时引擎按 max(100 km, 两格半)，见 water-types.ts 的 bankRadiusKm）
export const BANK_RADIUS_DEFAULT = 100;

// 侵占的力度
export const INVADE_STRENGTH: NumRange = { min: 0, max: 10, step: 0.1 };

// 图案：明显、花纹大小、发光
export const VISUAL_AMOUNT: NumRange = { min: 0, max: 1, step: 0.05, unit: '%' };
export const VISUAL_SIZE: NumRange = { min: 0.1, max: 4, step: 0.05, unit: '格' };
export const VISUAL_GLOW: NumRange = { min: 0, max: 1, step: 0.05, unit: '%' };

// 河画多粗（普通的河是 1）
export const RIVER_WIDTH: NumRange = { min: 0.3, max: 3, step: 0.05, unit: '%' };

// 星球形态：陆地多少、岛多少、山带宽窄（新建向导的“地形”、星球形态编辑器、资源库里星球形态的字段表三处）。
// 陆地多少格式收 0–0.85；滑块是向导一直用的 3%–70%
export const LAND_FRACTION: NumRange = { min: 0.03, max: 0.7, step: 0.01, unit: '%' };
export const ISLAND_AMOUNT: NumRange = { min: 0, max: 1, step: 0.01 };
export const BELT_WIDTH: NumRange = { min: 0.3, max: 3, step: 0.05 };

// ---------- 变湿变干写成百分比 ----------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 降水多、少百分之几（界面写的）与 dP 互换
export const percentOfDp = (dP: number): number => Math.round((Math.exp(dP) - 1) * 100);
export const dpOfPercent = (p: number): number => clamp(Math.round(Math.log(1 + p / 100) * 1e4) / 1e4, EFFECT_DP.min, EFFECT_DP.max);

// 滑块：按指数等间距（左右对称，正中是不变），停在 5% 的整数倍上；两头是格式收的上下限（约 −78%、+348%）
const RAIN_STEP = 5;
export const RAIN_SCALE = {
  pos: (dP: number): number => clamp((dP - EFFECT_DP.min) / (EFFECT_DP.max - EFFECT_DP.min), 0, 1),
  at: (p: number): number => {
    const raw = EFFECT_DP.min + (EFFECT_DP.max - EFFECT_DP.min) * clamp(p, 0, 1);
    return dpOfPercent(Math.max(-99, Math.round(((Math.exp(raw) - 1) * 100) / RAIN_STEP) * RAIN_STEP));
  },
};

// “降水 +20%”“降水 −15%”，不变时“不变”
export function rainText(dP: number): string {
  const p = percentOfDp(dP);
  return p === 0 ? '不变' : `降水 ${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
}
