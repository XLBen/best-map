import type { GhostEdit } from '../../render/colors';
import type { Preview, ProvincePreview } from '../tools';

// 一帧里几份预览叠在一起（第七十轮从 MapView.tsx 分出来）：排队中的编辑、底部条按钮悬停的、当前工具的

// 几个省份预览叠在一起（排队中的、按钮悬停的、当前工具的，后面的盖住前面的）。整份的（重划、重新划分）作底，
// 它前面的就不要了。同样的几个预览给同一个对象（地图不必重新上传）
let merged: { from: (ProvincePreview | null | undefined)[]; out: ProvincePreview | null } = { from: [], out: null };
export function mergeProvinces(from: (ProvincePreview | null | undefined)[]): ProvincePreview | null {
  if (from.length === merged.from.length && from.every((x, k) => x === merged.from[k])) return merged.out;
  const list = from.filter((x): x is ProvincePreview => !!x);
  let out: ProvincePreview | null = list[0] ?? null;
  if (list.length > 1) {
    const top = list.map((x) => !!x.province).lastIndexOf(true);
    const base = top >= 0 ? list[top] : null;
    const rest = list.slice(top + 1);
    // 将来全部的切线：最后给出的那一份（对半分开时切线接着管分出来的一半）
    const seamList = [base, ...rest].reverse().find((x) => x && x.seamList !== undefined)?.seamList;
    out = {
      cells: [...(base?.cells ?? []), ...rest.flatMap((x) => x.cells)],
      ids: [...(base?.ids ?? []), ...rest.flatMap((x) => x.ids)],
      seams: [...(base?.seams ?? []), ...rest.flatMap((x) => x.seams ?? [])],
      ...(base ? { province: base.province, metas: base.metas } : {}),
      ...(seamList !== undefined ? { seamList } : {}),
    };
  }
  merged = { from, out };
  return out;
}

// 几步的幽灵海岸合在一起（排队中的、当前工具的；同一格的增量相加）。同样的几份给同一个对象（地图不必重算）
let ghosts: { from: (GhostEdit | null | undefined)[]; out: GhostEdit | null } = { from: [], out: null };
export function mergeGhosts(from: (GhostEdit | null | undefined)[]): GhostEdit | null {
  if (from.length === ghosts.from.length && from.every((x, k) => x === ghosts.from[k])) return ghosts.out;
  const list = from.filter((x): x is GhostEdit => !!x);
  const out = list.length <= 1 ? (list[0] ?? null) : { cells: list.flatMap((g) => g.cells), delta: list.flatMap((g) => g.delta), lake: list.flatMap((g) => g.lake ?? []) };
  ghosts = { from, out };
  return out;
}

export const NO_PREVIEW: Preview = { layers: [], shapes: [], hint: null };
export const PICK_PREVIEW: Preview = { layers: [], shapes: [], hint: '点一下吸取' };

// 排队中的编辑（松手时的预览，直到结果换上，鼠标离开地图也留着）与底部条、“⋯”里按钮悬停的预览
// （省份的对半分开、重新划分，改一条河）画在当前工具的预览下面。幽灵海岸几步合在一起；将来的世界用当前工具的确切预览，
// 没有时用排队中最后一个有确切预览的（都是按当前世界算的，见 pending.ts）。button：底部条预览的通道里省份的那一份
export function withQueued(own: Preview, queued: Preview[], button: Pick<Preview, 'layers' | 'provinces'> | null): Preview {
  return queued.length || button
    ? {
        ...own,
        layers: [...queued.flatMap((q) => q.layers), ...(button?.layers ?? []), ...own.layers],
        shapes: [...queued.flatMap((q) => q.shapes), ...own.shapes],
        provinces: mergeProvinces([...queued.map((q) => q.provinces), button?.provinces, own.provinces]),
        ghost: mergeGhosts([...queued.map((q) => q.ghost), own.ghost]),
        world: own.world ?? [...queued].reverse().find((q) => q.world)?.world ?? null,
      }
    : own;
}
