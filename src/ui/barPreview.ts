import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import type { Guide, World } from '../../core/world';
import type { HighlightLayer } from '../render/colors';
import type { ProvincePreview } from './tools';

// 底部条、“⋯”里的按钮：鼠标停在按钮上（或拖着底部条上的滑块）时，地图上先画出点下去会变成什么样。一个通道：
//   · provinces：对半分开、按新规则重新划分、换一种划分（provincePreview.ts）。base：算的时候的世界，世界换了就不再画；
//     held：点下去了，结果回来之前一直留着（鼠标移开也不先跳回原样）
//   · river：改一条河的大小、分水，悬停“从这里往下去掉”（river/bar.ts）：先画估计的样子，停一下换成确切的
// 省份的那一份由地图画在当前工具的预览下面，河的那一份由画河工具画（正在画、正在算时不画）；换工具时 setTool 清掉（clearBarPreview）

export type BarPreview =
  | { kind: 'provinces'; base: World; provinces: ProvincePreview; layers: HighlightLayer[]; held?: boolean }
  | { kind: 'river'; key: string; cmd: Command; after: Guide; estimate: number[] };

export const barPreview = signal<BarPreview | null>(null);

// 清掉时要一起停下的（还没算好、还没发出去的预览）：省份、河各登记一个
const stoppers: (() => void)[] = [];
export function onBarPreviewClear(stop: () => void) {
  stoppers.push(stop);
}

// 鼠标移开、换工具：不再预览（点下去了的留到结果回来）
export function clearBarPreview() {
  for (const stop of stoppers) stop();
  const p = barPreview.value;
  if (p && !(p.kind === 'provinces' && p.held)) barPreview.value = null;
}
