import type { PreviewResult } from '../../../core/engine';
import type { Command } from '../../../core/commands';
import type { Guide, World } from '../../../core/world';
import type { Shape } from '../../render/overlay';
import { previewCommand, redrawTick } from '../../state';
import { type BarPreview, barPreview, onBarPreviewClear } from '../barPreview';
import { Settle } from '../exact';
import type { Preview } from '../tools';
import { riverTypeOfGuide } from './model';
import { tempLine } from './query';
import { courseRiver, exactLayers, ringAt } from './shapes';

// 底部条上改一条河时的预览（拖大小、分水，悬停“从这里往下去掉”）：走底部条预览的通道（barPreview.ts），画河工具每帧画它

type RiverBar = Extract<BarPreview, { kind: 'river' }>;

// 确切的结果：停一下后在 worker 里执行这条命令（同一个世界上同一条命令只算一次；没算成时下次再要就重新算）
const barExact = new Settle<PreviewResult>(true);
onBarPreviewClear(() => barExact.reset());

// 先画估计的样子，停 delay 毫秒后换成确切的
export function previewRiverBar(cmd: Command, after: Guide, estimate: number[], delay = 150) {
  const key = JSON.stringify(cmd);
  const cur = barPreview.value;
  if (cur?.kind !== 'river' || cur.key !== key) {
    barPreview.value = { kind: 'river', key, cmd, after, estimate };
    redrawTick.value++;
  }
  // 同一条命令也再要一次：世界变了（别的一步算完了）时要重新算，没变时不重复算
  barExact.want(key, () => previewCommand(cmd), delay);
}

// 松手执行了：还没发出去的确切预览不必再算（预览照旧画着，直到结果换上）
export const holdRiverBarPreview = () => barExact.hold();

// 地图上画成什么样：改完后的这条河（确切的流量到了换上），会变干的格涂红
export function riverBarView(w: World, b: RiverBar, zoom: number): Preview {
  const x = barExact.get(b.key);
  const line = tempLine(w, b.after);
  const flow = x?.guide && x.guide.flow.length === b.after.cells.length ? x.guide.flow : b.estimate;
  const r = courseRiver(w, line, b.after, flow, b.after.id || null);
  const shapes: Shape[] = [];
  if (r.points.length > 1) shapes.push({ kind: 'river', points: r.points, flow: r.flow, mul: r.mul, riverType: riverTypeOfGuide(w, b.after) });
  if (b.after.end === 'sink' && r.points.length) {
    const [tx, ty] = r.points[r.points.length - 1];
    shapes.push(ringAt(w, tx, ty, 4 / zoom, 1.5));
  }
  return { layers: x ? exactLayers(x) : [], shapes, hint: null };
}
