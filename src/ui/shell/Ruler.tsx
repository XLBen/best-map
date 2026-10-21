import { Ruler } from 'lucide-preact';
import { cornerLift, measure } from '../../state';

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
      <Ruler size={17} strokeWidth={1.8} />
    </button>
  );
}
