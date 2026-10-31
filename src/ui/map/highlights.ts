import { activeConflicts } from '../../../core/constraints';
import type { World } from '../../../core/world';
import type { HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { FLASH_MS, adjustPreview, adjustPreviewWorld, flash, overlays, provinceSet, riverStyleOverride, selectedFeature, selectedProvince, selectedRiver } from '../../state';
import { editLayers } from '../edits';
import { riverGlow, riverInfo } from '../riverCourse';
import { type Preview, reliefLayers } from '../tools';

// 地图上的高亮：哪一类工具开着时多画什么，由 defs/tools.ts 里各类、各工具声明（CategoryDef.map、ToolDef.focus），
// 这里是它们的画法，以及把工具的预览、排队中的编辑、“调整”的预览、闪烁叠在一起的顺序

// 一类工具开着时地图上多画的高亮：layers 按顺序叠上，key 是判断要不要重新上传用的（同样的输入给同样的 key）
export type CategoryHighlights = (w: World, shown: World) => { layers: HighlightLayer[]; key: unknown[] };

// 自然：没涂成的格画红色斜线（说了“就这样”的不画，收在“!”里），按画出来的世界
export const failingHighlights: CategoryHighlights = (_w, shown) => {
  const failing = activeConflicts(shown).flatMap((x) => x.failing);
  return { layers: failing.length ? [{ cells: failing, color: [235, 60, 50], alpha: 0.85, pattern: 'hatch' }] : [], key: [] };
};

// 无人区省份的斜线图层：按省份数组与各省的类型缓存（同一个图层对象，不必重新上传）
let waste: { key: string; province: Int32Array; layer: HighlightLayer | null } | null = null;
function wasteLayer(w: World): HighlightLayer | null {
  const ids = Object.entries(w.small.provinces)
    .filter(([, m]) => m.kind === 'wasteland')
    .map(([p]) => p)
    .join(',');
  if (waste?.province === w.causes.province && waste.key === ids) return waste.layer;
  const set = new Set(ids ? ids.split(',').map(Number) : []);
  const cells: number[] = [];
  if (set.size) for (let i = 0; i < w.mesh.n; i++) if (set.has(w.causes.province[i])) cells.push(i);
  waste = { key: ids, province: w.causes.province, layer: cells.length ? { cells, color: [90, 90, 90], alpha: 0.45, pattern: 'hatch' } : null };
  return waste.layer;
}

// 省份：选中的省淡淡地亮；无人区画灰色斜线，压在选中高亮之上（选中的省改成无人区时当场看得见）
export const provinceHighlights: CategoryHighlights = (w) => {
  const layers: HighlightLayer[] = [];
  const key: unknown[] = [];
  // 第二十七轮：⇧+点多选的省都亮
  const ids = provinceSet.value.length ? provinceSet.value : selectedProvince.value !== null ? [selectedProvince.value] : [];
  if (ids.length) {
    const set = new Set(ids);
    const cells: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (set.has(w.causes.province[i])) cells.push(i);
    layers.push({ cells, color: [255, 255, 255], alpha: 0.28 });
    key.push(ids.join(','));
  }
  const wl = wasteLayer(w);
  if (wl) layers.push(wl);
  key.push(wl);
  return { layers, key };
};

// 地名：选中的地名淡黄
export const featureHighlights: CategoryHighlights = (w) => {
  const sel = selectedFeature.value;
  if (!sel) return { layers: [], key: [] };
  const f = w.derived.features.find((x) => x.key === sel);
  return { layers: f ? [{ cells: Array.from(f.cells), color: [255, 230, 120], alpha: 0.35 }] : [], key: [sel] };
};

// 画河时选中的河：沿河一道淡黄的光（正在改这条河、原来的样子先不画时不亮），它自己的地名先不标（不盖住它的控制点、“+”）
export const selectedRiverFocus = {
  glow(w: World): Shape[] {
    const sel = selectedRiver.value;
    const editing = !!riverStyleOverride.value?.hide || !!riverStyleOverride.value?.cells;
    return sel && !editing ? riverGlow(w, sel) : [];
  },
  hideLabel(w: World): string {
    const sel = selectedRiver.value;
    return sel ? (riverInfo(w, sel)?.feature?.key ?? '') : '';
  },
};

// shown：画出来的世界（确切预览、调整面板预览的将来的世界，或当前世界）：没涂成的格按它画
// back：工具选中时一直画着的图层（橡皮擦能擦的格、重画过的范围），画在预览下面；category：这一类多画的
export function highlightLayers(w: World, shown: World, preview: Preview, back: HighlightLayer[], category: unknown, more?: CategoryHighlights): { layers: HighlightLayer[]; key: unknown[] } {
  const layers: HighlightLayer[] = [];
  // 图层里的“我改过的地方”：四种改动分色（任何工具下都能打开）。压在工具的描边之上、
  // 别的高亮之下：只描边的格一盖就没了颜色，而描边本来就画在有高亮与没有高亮的格之间，盖上以后照样在
  // 钉住的格、指针下的格不在这里（第三十七轮：按画面上的陆海描边，见 renderer.setFocus）
  const edits = overlays.value.edits ? editLayers(w) : [];
  layers.push(...back.filter((l) => l.pattern === 'outline'), ...edits);
  // 工具一直画着的其余图层（橡皮擦能擦的格的白斜线）：放在没涂成的红斜线、选中、闪烁之下，免得把它们盖掉
  layers.push(...back.filter((l) => l.pattern !== 'outline'));
  // 按每个图层对象比较：工具沿用同一个图层时不必重新上传
  const key: unknown[] = [w, shown, category, '|', ...edits, '|', ...back, '|', ...preview.layers];
  if (more) {
    const h = more(w, shown);
    layers.push(...h.layers);
    key.push(...h.key);
  }
  // “调整”面板拖滑块：将来的海岸线由幽灵海岸画出（见 MapView 的 applyGhost），这里只涂山会变高（橙）/ 变矮（蓝灰）的格
  const ap = adjustPreview.value;
  if (ap) {
    if (ap.relief.cells.length) layers.push(...reliefLayers(ap.relief));
    key.push(ap);
  }
  // 调整面板、资源包的预览世界带的高亮（资源包：会变的格描边、新生态的格淡淡涂上）
  const apw = adjustPreviewWorld.value;
  if (apw?.layers && apw.base === w) {
    layers.push(...apw.layers);
    key.push(apw);
  }
  // 改完后变化的格：淡淡地亮一下就淡出，轮廓跟着一起淡（着色器里轮廓的浓淡随填充）
  const fl = flash.value;
  if (fl) {
    const t = (performance.now() - fl.at) / FLASH_MS;
    const a = Math.max(0, 0.18 * (1 - t));
    // 每帧只在不透明度变化明显时更新
    const step = Math.round(a * 40);
    if (step > 0) layers.push({ cells: fl.cells, color: [255, 236, 120], alpha: step / 40 });
    key.push(fl, step);
  }
  layers.push(...preview.layers);
  return { layers, key };
}
