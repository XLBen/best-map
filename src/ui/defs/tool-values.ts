import { roundKm } from '../../../core/terrain';
import type { ToolOptions } from '../../state';

// 工具的几个数（第六十九轮从 tools/ 下搬来）：滑块的上限、取整、右边数值的写法。
// 工具表（tools.ts 的滑块）和工具本身（tools/ 下，照旧从那里导出）都用，工具表不引用 tools/

// 岛、湖的大小取整成好读的直径：气泡、提示、历史里是同一个数
export const snapRadiusKm = (r: number) => roundKm(r * 2) / 2;

// 堆山 / 压低的力度最大是多少（底部条滑块的上限，预览深浅按它算）
export const RELIEF_MAX = 1.6;

// 河的大小（“河流多少”门槛的倍数）叫什么
export const riverSizeName = (flow: number) => (flow < 3 ? '小河' : flow < 15 ? '中等的河' : '大河');

// 流量取两位有效数字，好读
export const fmtFlow = (q: number) => {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(q, 1))) - 1));
  return (Math.round(q / p) * p).toLocaleString();
};

// 冷暖干湿四种画笔
export type ClimateKind = 'warm' | 'cold' | 'wet' | 'dry';

// 冷暖干湿、自定义场的力度最大是多少（底部条滑块的上限，预览深浅按它算）
export const CLIMATE_MAX = 2;
export const FIELD_MAX = 1;

// 力度 1：中心升降 4 °C，或雨水乘除 e^0.5（多约 65% / 少约 39%）。short 是底部条上滑块右边的数
export function climateEffect(c: ClimateKind, amount: number): { field: 'tempOffset' | 'moistOffset'; value: number; text: string; short: string } {
  if (c === 'warm' || c === 'cold') {
    const v = (c === 'warm' ? 4 : -4) * amount;
    const deg = Math.abs(v).toFixed(Math.abs(v) < 2 ? 1 : 0);
    return { field: 'tempOffset', value: v, text: `中心${v > 0 ? '升温' : '降温'}约 ${deg} °C`, short: `${v > 0 ? '+' : '−'}${deg} °C` };
  }
  const v = (c === 'wet' ? 0.5 : -0.5) * amount;
  const pct = Math.round(Math.abs(Math.exp(v) - 1) * 100);
  return { field: 'moistOffset', value: v, text: `中心雨水${v > 0 ? '多' : '少'}约 ${pct}%`, short: `雨水${v > 0 ? '+' : '−'}${pct}%` };
}

// 冷暖（group = temp）或干湿（moist）画笔：选的是哪一种、力度多大（冷暖、干湿各有各的力度）
export const climateKind = (group: 'temp' | 'moist', o: ToolOptions): ClimateKind => (group === 'temp' ? o.tempMode : o.moistMode);

// 增减的比例写成“+50%”“−30%”
export const percentText = (p: number) => (Math.abs(p) < 0.005 ? '0%' : `${p > 0 ? '+' : '−'}${Math.round(Math.abs(p) * 100)}%`);
