import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import { splitCells } from '../../core/provinces';
import { inheritSeams } from '../../core/seams';
import { provinceCells } from '../../core/select';
import { type World, provinceColor } from '../../core/world';
import type { HighlightLayer } from '../render/colors';
import { previewProvinces, world } from '../state';
import type { ProvincePreview } from './tools';

// 底部条、“⋯”里的按钮：鼠标停在按钮上时，地图上先画出点下去会变成什么样（对半分开、按新规则重新划分、换一种划分），
// 与执行同一个算法，所以就是结果。点下去还是一下就做、可以撤销，不多问一句。
// base：算的时候的世界，世界换了就不再画；held：点下去了，结果回来之前一直留着（鼠标移开也不先跳回原样）

export interface BarPreview {
  base: World;
  provinces: ProvincePreview;
  layers: HighlightLayer[];
  held?: boolean;
}

export const barPreview = signal<BarPreview | null>(null);

// 每次换一个按钮、移开就换一代：还在路上的旧预览不再显示
let token = 0;
// 鼠标停下后才去算的那一次（还没发出去）
let timer: ReturnType<typeof setTimeout> | null = null;
const stop = () => {
  if (timer) clearTimeout(timer);
  timer = null;
};

// 对半分开：分出来的那一半（与命令同一个算法：splitCells 只看网格与这个省的格）用它将来的颜色淡淡地涂上，
// 新的省界画在中间。切线也像命令一样让分出来的那一半接着管
export function showSplit(w: World, id: number) {
  token++;
  const cells = provinceCells(w, id);
  if (cells.length < 2) return;
  const [, right] = splitCells(w, cells);
  const born = w.small.nextProvince;
  const seams = w.small.provinceSeams;
  barPreview.value = {
    base: w,
    provinces: { cells: right, ids: right.map(() => born), ...(seams ? { seamList: inheritSeams(seams, id, [born]) } : {}) },
    layers: [{ cells: right, color: provinceColor(born), alpha: 0.45 }],
  };
}

// 整张图重新划分：鼠标停 150 毫秒后在 Worker 里算好将来的省界与省名再画（几十到一两百毫秒）；
// 只是从按钮上划过去的不算，算好时鼠标已经移开就不画
export function showProvinceCommand(cmd: Command) {
  const t = ++token;
  stop();
  timer = setTimeout(() => {
    timer = null;
    const w = world.value;
    if (t !== token || !w) return;
    void previewProvinces(cmd).then((r) => {
      if (!r || t !== token || world.value !== w) return;
      barPreview.value = { base: w, provinces: { cells: [], ids: [], province: r.province, seamList: r.seams, metas: r.provinces }, layers: [] };
    });
  }, 150);
}

// 鼠标移开：不再预览（点下去了的留到结果回来）
export function clearBarPreview() {
  token++;
  stop();
  if (barPreview.value && !barPreview.value.held) barPreview.value = null;
}

// 点下去了：预览留到这一步的结果回来（还没开始算的预览不算了：Worker 先算这一步）
export function holdBarPreview(done: Promise<unknown>) {
  stop();
  const p = barPreview.value;
  if (!p) return;
  const held = { ...p, held: true };
  barPreview.value = held;
  void done.finally(() => {
    if (barPreview.value === held) barPreview.value = null;
  });
}
