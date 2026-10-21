import type { World } from '../../../core/world';
import { options, setOptions, world } from '../../state';
import type { SliderDef } from '../defs/types';

// 底部条滑块的位置与数值换算；键盘 [ ] { } 也用它

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function sliderPos(def: SliderDef, w: World, v: number): number {
  const [lo, hi] = def.range(w);
  return clamp01(def.scale === 'log' ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo));
}

export function sliderValue(def: SliderDef, w: World, p: number): number {
  const [lo, hi] = def.range(w);
  const raw = def.scale === 'log' ? lo * Math.pow(hi / lo, clamp01(p)) : lo + (hi - lo) * clamp01(p);
  const v = def.snap ? def.snap(raw, w) : raw;
  return Math.min(hi, Math.max(lo, v));
}

// 按滑块位置走一小步
export function nudgeSlider(def: SliderDef | undefined, dir: 1 | -1) {
  const w = world.value;
  if (!def || !w || def.enabled?.(w) === false) return;
  const p = sliderPos(def, w, options.value[def.key]);
  let v = sliderValue(def, w, p + dir * 0.06);
  // 取整后没动：再多走一点
  if (v === options.value[def.key]) v = sliderValue(def, w, p + dir * 0.12);
  setOptions({ [def.key]: v });
}
