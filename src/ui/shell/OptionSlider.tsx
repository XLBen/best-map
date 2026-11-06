import type { World } from '../../../core/world';
import { options, setOptions, sliderActive } from '../../state';
import { Slider } from '../components/Slider';
import type { SliderDef } from '../defs/types';
import { nudgeSlider, sliderPos, sliderValue } from './sliders';

// 第六十九轮从 components/Slider.tsx 搬来（它读写工具的选项，components 只放不认识世界的控件）
// 底部条上工具的滑块（直径、力度……）：值在 options 里；拖动时地图在鼠标最后停的地方预览（sliderActive）
export function OptionSlider({ def, w }: { def: SliderDef; w: World }) {
  const value = options.value[def.key];
  const done = () => (sliderActive.value = false);
  return (
    <Slider
      label={def.label}
      pos={sliderPos(def, w, value)}
      text={def.format(value, w)}
      onDraft={(p) => {
        sliderActive.value = true;
        setOptions({ [def.key]: sliderValue(def, w, p) });
      }}
      onCommit={done}
      onCancel={done}
      onStep={(dir) => nudgeSlider(def, dir)}
    />
  );
}
