import { WHEN_RANGE } from '../../../core/water-types';

// 流量的滑块按对数走（河的流量从一百到几万），取两位有效数字；到两头是“不限”。
// 第九十三轮从 panels/waterTypes.tsx 原样搬来：那里的编辑器并进了资源库里河、湖的页面，通用表单的“条件”用它（字段表的 show: 'flow'）
const FLOW_LOG_LO = 50;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const logPos = (v: number, lo: number, hi: number) => clamp01(Math.log(v / lo) / Math.log(hi / lo));
const logAt = (p: number, lo: number, hi: number) => lo * Math.pow(hi / lo, p);

export const flowScale = {
  pos: (v: number) => (v <= 0 ? 0 : v >= WHEN_RANGE.flow.hi ? 1 : 0.02 + 0.96 * clamp01(logPos(v, FLOW_LOG_LO, WHEN_RANGE.flow.hi))),
  at: (p: number) => {
    if (p <= 0.01) return 0;
    if (p >= 0.99) return WHEN_RANGE.flow.hi;
    return Number(logAt(clamp01((p - 0.02) / 0.96), FLOW_LOG_LO, WHEN_RANGE.flow.hi).toPrecision(2));
  },
};
