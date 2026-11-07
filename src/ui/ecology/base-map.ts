import { signal } from '@preact/signals';
import { type ViewMode, focusSpecies, mode } from '../../state';

// 生态编辑器里的“在地图上看”（第七十二轮：这几张底图从“图层”里挪到这里）。
// 编辑器开着时临时换底图，关上编辑器（关面板、返回、换到别的页）换回原来的那张；
// 这期间在“图层”里换过底图就不动（和工具换底图的规矩一样，见 defs/tools/index.ts 的 switchView）。
// 换着看别的生态时（编辑器换了一页）不换回去：适宜程度跟着看的那一种

export interface EditorView {
  id: ViewMode;
  label: string;
  hint: string;
  // 只有本世界里的生态有（适宜程度按世界里的这一种算）
  worldOnly?: boolean;
}

export const EDITOR_VIEWS: readonly EditorView[] = [
  { id: 'suitability', label: '适宜程度', hint: '越亮越适合它', worldOnly: true },
  { id: 'moisture', label: '湿润程度', hint: '降水与蒸散之比，图上的纵轴' },
  { id: 'wetness', label: '地形湿度', hint: '低洼、汇水的地方高' },
  { id: 'continentality', label: '离海远近', hint: '海风到得了的地方低' },
  { id: 'corrT', label: '涂生态时的温度调整', hint: '为涂上的生态改了多少冷暖' },
  { id: 'corrP', label: '涂生态时的降水调整', hint: '为涂上的生态改了多少干湿' },
];

// 编辑器换上的是哪一张、换之前是哪一张
let held: { before: ViewMode; set: ViewMode } | null = null;
// 开着的编辑器有几个（换一页时先关后开，同一轮里数回到 1，不换回去）
let open = 0;
// 选着的那一张（界面上的下拉跟着它；地图上不是它了时写“不换”）
export const editorView = signal<ViewMode | null>(null);

// 现在下拉里该写哪一张：编辑器换上的还在地图上时是它，否则是“不换”
export function shownEditorView(): ViewMode | null {
  const v = editorView.value;
  return v && held && mode.value === held.set ? v : null;
}

// 选一张（null：换回原来的）。biome：看的是哪一种生态（适宜程度用）
export function showEditorView(v: ViewMode | null, biome: string | null): void {
  if (!v) {
    restoreEditorView();
    return;
  }
  if (!held || mode.value !== held.set) held = { before: mode.value, set: v };
  else held.set = v;
  if (v === 'suitability' && biome) focusSpecies.value = biome;
  editorView.value = v;
  mode.value = v;
}

// 换回编辑器换上之前的那一张（地图上还是编辑器换上的时）
export function restoreEditorView(): void {
  if (held && mode.value === held.set) mode.value = held.before;
  held = null;
  editorView.value = null;
}

// 编辑器打开（组件挂上时，useLayoutEffect）：返回关上时调的。适宜程度换成这一种
export function editorOpened(biome: string | null): () => void {
  open++;
  if (biome && editorView.value === 'suitability' && held && mode.value === held.set) focusSpecies.value = biome;
  return () => {
    open--;
    queueMicrotask(() => {
      if (!open) restoreEditorView();
    });
  };
}
