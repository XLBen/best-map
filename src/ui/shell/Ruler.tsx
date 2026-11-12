import { Maximize, Ruler } from 'lucide-preact';
import { cornerLift, measure } from '../../state';
import { mapApi } from '../camera';
import { TOUCH_TEXT } from '../copy';
import { touchUi } from '../touch-ui';

// 左下角、比例尺左边：量距离（M）
export function RulerButton() {
  const on = measure.value !== null;
  return (
    <button
      class={`ruler-btn ${on ? 'on' : ''}`}
      style={{ bottom: `${6 + cornerLift.value}px` }}
      onClick={() => (measure.value = on ? null : [])}
      title={on ? '退出量距离（M）' : '量距离（M）'}
    >
      <Ruler />
    </button>
  );
}

// 第一百轮：看全图（F 键的那一下）。没有键盘的人捏远了找不回地图：触摸设备上量距离按钮的上面多这一个
export function FitButton() {
  if (!touchUi()) return null;
  return (
    <button class="ruler-btn fit-btn" style={{ bottom: `${6 + cornerLift.value}px` }} onClick={() => mapApi.current?.fit()} title={TOUCH_TEXT.fitTip} aria-label={TOUCH_TEXT.fit}>
      <Maximize />
    </button>
  );
}
