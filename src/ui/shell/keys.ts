import { erasing, helpOpen, measure, openPanel, picking, provinceSet, selectedFeature, selectedLake, selectedProvince, selectedRiver, sheet, tool, uiHidden, wizardOpen, world } from '../../state';
import { mapApi } from '../camera';
import { TOOL_DEFS, category, eraserModes, setTool, toolsOf } from '../defs/tools';
import { nudgeSlider } from './sliders';
import { ESC_RANK, isTyping, pushEscape, runEscape } from './escape';
import { packDialog } from '../packs/store';
import { lastPress, redoHere, undoHere } from '../packs/panel-store';
import { formEditor } from '../form-store';
import { mapsDialog, saveMap, saveMapAs } from '../maps/store';

// 键盘：一个地方统一处理。Esc 按固定顺序一层层退出（第六十九轮起是 escape.ts 的栈：各层自己登记，这里只问最上面的）

const typing = isTyping;

// ---------- Esc：界面状态（state.ts）与地图的几层（资源包弹窗、我的地图、星球形态编辑器、资源库在各自的模块里登记） ----------

const close = (on: boolean, off: () => void) => {
  if (on) off();
  return on;
};
pushEscape(ESC_RANK.help, () => close(helpOpen.value, () => (helpOpen.value = false)));
pushEscape(ESC_RANK.wizard, () => {
  if (!wizardOpen.value) return false;
  if (world.value) wizardOpen.value = false;
  return true;
});
pushEscape(ESC_RANK.openPanel, () => close(!!openPanel.value, () => (openPanel.value = null)));
pushEscape(ESC_RANK.input, (e) => close(typing(e.target), () => (e.target as HTMLElement).blur()));
pushEscape(ESC_RANK.mapCancel, () => !!mapApi.current?.cancel());
pushEscape(ESC_RANK.mapEscape, () => !!mapApi.current?.escape());
pushEscape(ESC_RANK.measure, () => close(!!measure.value, () => (measure.value = measure.value!.length ? [] : null)));
pushEscape(ESC_RANK.picking, () => close(picking.value, () => (picking.value = false)));
pushEscape(ESC_RANK.uiHidden, () => close(uiHidden.value, () => (uiHidden.value = false)));
pushEscape(ESC_RANK.sheet, () => close(!!sheet.value, () => (sheet.value = null)));
pushEscape(ESC_RANK.provinceSet, () => close(provinceSet.value.length > 0, () => (provinceSet.value = [])));
pushEscape(ESC_RANK.selection, () =>
  close(selectedProvince.value !== null || !!selectedFeature.value || !!selectedRiver.value || !!selectedLake.value, () => {
    selectedProvince.value = null;
    selectedFeature.value = null;
    selectedRiver.value = null;
    selectedLake.value = null;
  }),
);

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
  // Esc：一层层退出，先后见 escape.ts 的 ESC_RANK（这里只问最上面开着的一层）
  if (e.key === 'Escape') {
    runEscape(e, 'bubble');
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
    // 和顶栏的撤销同一个（第八十一轮）：面板看我的库时撤销这个库，看别的库时不撤销，别的都是世界
    if (e.shiftKey) redoHere();
    else undoHere();
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
      } else if (def.del?.()) e.preventDefault();
      return;
    case 'Delete':
      if (def.del?.()) e.preventDefault();
      return;
  }
  const k = e.key.toLowerCase();
  if (k === 'f') mapApi.current?.fit();
  // 指针（第二十五轮）
  else if (k === 'v') setTool('pointer');
  else if (k === 'm') measure.value = measure.value ? null : [];
  // 第二十七轮：E 橡皮擦（开着时关上），I 吸管（下一次点击吸取）
  else if (k === 'e') {
    const modes = eraserModes(tool.value);
    if (modes.length) {
      erasing.value = erasing.value ? null : modes[0];
      picking.value = false;
    }
  } else if (k === 'i') {
    if (def.pick) {
      picking.value = !picking.value;
      if (picking.value) erasing.value = null;
    }
  }
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
  // 点在面板外面：⌘Z 回到世界（点在面板里的在面板上记，见 LibPanel.tsx）
  if (!(e.target as HTMLElement).closest?.('.lib-panel')) lastPress.inPanel = false;
  if (!openPanel.value) return;
  const t = e.target as HTMLElement;
  if (t.closest('.popover') || t.closest('[data-panel]') || t.closest('.map') || t.closest('.modal-backdrop')) return;
  openPanel.value = null;
}
