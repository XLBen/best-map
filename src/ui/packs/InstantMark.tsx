import { INSTANT, INSTANT_TIP } from './copy';

// 改了地图马上变的一段标题旁的小字（第八十一轮：本世界的生态、省份划分的“湖”；别的改了要底下的“重新生成”）
export function InstantMark() {
  return (
    <span class="chip static lp-instant" title={INSTANT_TIP}>
      {INSTANT}
    </span>
  );
}
