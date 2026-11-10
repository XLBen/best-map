import { type Timing, TIMING_LABEL, TIMING_TIP } from './timing';

// 改了什么时候用上的小字（第九十轮，规则在 timing.ts）：一段标题旁写“即时 / 要重新生成 / 只影响新地图”之一。
// 第八十一轮只有“即时”一种、手标了两处（本世界的生态、省份划分的“湖”），文件叫 InstantMark.tsx
export function TimingMark({ t }: { t: Timing }) {
  return (
    <span class={`chip static lp-timing ${t}`} title={TIMING_TIP[t]}>
      {TIMING_LABEL[t]}
    </span>
  );
}
