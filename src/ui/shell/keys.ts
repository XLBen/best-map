import { helpOpen, measure, openPanel, redo, selectedFeature, selectedLake, selectedProvince, selectedRiver, sheet, tool, uiHidden, undo, wizardOpen, world } from '../../state';
import { mapApi } from '../camera';
import { TOOL_DEFS, category, setTool, toolsOf } from '../defs/tools';
import { nudgeSlider } from './sliders';
import { packApply, packDialog } from '../packs/store';
import { closeFormEditor, formEditor } from '../form-store';
import { mapsDialog, saveMap, saveMapAs } from '../maps/store';

// 键盘：一个地方统一处理，Esc 按固定顺序一层层退出

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
};

export function onKeyDown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  // ⌘S 保存到“我的地图”，⇧⌘S 另存为。任何时候都不让浏览器弹出“存储网页”；向导、说明、弹窗开着时不保存。
  // 正在框里写时先离开框（写的东西先提交，再存）
  if (mod && !e.altKey && (e.key.toLowerCase() === 's' || e.code === 'KeyS')) {
    e.preventDefault();
    if (e.repeat || !world.value || helpOpen.value || wizardOpen.value || packDialog.value || formEditor.value) return;
    if (typing(e.target)) (e.target as HTMLElement).blur();
    openPanel.value = null;
    void (e.shiftKey ? saveMapAs() : saveMap());
    return;
  }
  if (e.key === 'Escape') {
    // （信任的问话、安全模式的问话自己先接住 Esc，见 Ask.tsx）资源包弹窗 → 我的地图 → 说明 → 星球形态编辑器 → 向导 → 弹出面板 → 输入框 → 正在画的一笔 →
    // 工具自己的（不截走别的河）→ 量距离（先清空再退出）→ 隐藏的界面 → 资源包“用到这个世界”的卡片 → 抽屉 → 选中的省份 / 地名 / 河
    if (packDialog.value) packDialog.value = null;
    else if (mapsDialog.value) mapsDialog.value = false;
    else if (helpOpen.value) helpOpen.value = false;
    else if (formEditor.value) {
      // 正在框里写：先离开框（写的东西还在），再按一次才关上编辑器
      if (typing(e.target)) (e.target as HTMLElement).blur();
      else closeFormEditor();
    }
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
    else if (selectedProvince.value !== null || selectedFeature.value || selectedRiver.value || selectedLake.value) {
      selectedProvince.value = null;
      selectedFeature.value = null;
      selectedRiver.value = null;
      selectedLake.value = null;
    }
    return;
  }
  if (typing(e.target) || helpOpen.value || wizardOpen.value || packDialog.value || mapsDialog.value) return;
  // 回车：交给工具（画河时确认截走别的河）
  if (e.key === 'Enter' && !openPanel.value && mapApi.current?.enter()) {
    e.preventDefault();
    return;
  }
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
