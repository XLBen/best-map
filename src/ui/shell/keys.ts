import { helpOpen, measure, openPanel, redo, selectedFeature, selectedProvince, selectedRiver, sheet, tool, uiHidden, undo, wizardOpen, world } from '../../state';
import { mapApi } from '../camera';
import { TOOL_DEFS, category, setTool, toolsOf } from '../defs/tools';
import { nudgeSlider } from './sliders';
import { packApply, packDialog } from '../packs/store';

// 键盘：一个地方统一处理，Esc 按固定顺序一层层退出

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
};

export function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // （信任的问话、安全模式的问话自己先接住 Esc，见 Ask.tsx）资源包弹窗 → 说明 → 向导 → 弹出面板 → 输入框 → 正在画的一笔 →
    // 工具自己的（不截走别的河）→ 量距离（先清空再退出）→ 隐藏的界面 → 资源包“用到这个世界”的卡片 → 抽屉 → 选中的省份 / 地名 / 河
    if (packDialog.value) packDialog.value = null;
    else if (helpOpen.value) helpOpen.value = false;
    else if (wizardOpen.value) {
      if (world.value) wizardOpen.value = false;
    } else if (openPanel.value) openPanel.value = null;
    else if (typing(e.target)) (e.target as HTMLElement).blur();
    else if (mapApi.current?.cancel()) return;
    else if (mapApi.current?.escape()) return;
    else if (measure.value) measure.value = measure.value.length ? [] : null;
    else if (uiHidden.value) uiHidden.value = false;
    else if (packApply.value) packApply.value = null;
    else if (sheet.value) sheet.value = null;
    else if (selectedProvince.value !== null || selectedFeature.value || selectedRiver.value) {
      selectedProvince.value = null;
      selectedFeature.value = null;
      selectedRiver.value = null;
    }
    return;
  }
  if (typing(e.target) || helpOpen.value || wizardOpen.value || packDialog.value) return;
  // 回车：交给工具（画河时确认截走别的河）
  if (e.key === 'Enter' && !openPanel.value && mapApi.current?.enter()) {
    e.preventDefault();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    void (e.shiftKey ? redo() : undo());
    return;
  }
  if (mod || e.altKey || !world.value) return;
  const def = TOOL_DEFS[tool.value];
  switch (e.key) {
    case '[':
      nudgeSlider(def.size, -1);
      return;
    case ']':
      nudgeSlider(def.size, 1);
      return;
    case '{':
      nudgeSlider(def.amount, -1);
      return;
    case '}':
      nudgeSlider(def.amount, 1);
      return;
    case '=':
    case '+':
      mapApi.current?.zoomBy(1.25);
      return;
    case '-':
    case '_':
      mapApi.current?.zoomBy(0.8);
      return;
    case 'Tab':
      e.preventDefault();
      uiHidden.value = !uiHidden.value;
      openPanel.value = null;
      return;
    case 'Backspace':
      if (measure.value?.length) {
        e.preventDefault();
        measure.value = measure.value.slice(0, -1);
      }
      return;
  }
  const k = e.key.toLowerCase();
  if (k === 'f') mapApi.current?.fit();
  else if (k === 'm') measure.value = measure.value ? null : [];
  else if (k === 'r') def.reroll?.();
  else {
    const n = Number(e.key);
    const list = toolsOf(category.value, world.value);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) setTool(list[n - 1]);
  }
}

// 点了浮层里的按钮后焦点不留在按钮上：否则按空格平移地图时会再按一次那个按钮
export function onMouseDownCapture(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (t.closest('button') && !t.closest('.modal') && !typing(document.activeElement)) e.preventDefault();
}

// 点弹出面板外面就关上（点地图由地图自己处理：那一下只关面板，不在地图上动手）
export function onPointerDownCapture(e: PointerEvent) {
  if (!openPanel.value) return;
  const t = e.target as HTMLElement;
  if (t.closest('.popover') || t.closest('[data-panel]') || t.closest('.map') || t.closest('.modal-backdrop')) return;
  openPanel.value = null;
}
