import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpOpen, measure, openPanel, picking, provinceSet, selectedFeature, selectedLake, selectedProvince, selectedRiver, sheet, uiHidden, wizardOpen, world } from '../../state';
import { mapApi, type MapApi } from '../camera';
import { formEditor } from '../form-store';
import { mapsDialog } from '../maps/store';
import { HOME, WORLD_SOURCE } from '../packs/pages';
import { libPanel } from '../packs/panel-store';
import { packDialog } from '../packs/store';
import { ESC_RANK, onEscapeCapture, pushEscape } from './escape';
import { onKeyDown } from './keys';

// 第六十九轮：Esc 一层层退出的先后（改成 escape.ts 的栈之前照 keys.ts 的 if/else 链写下来，换了以后照样通过）。
// 全部打开，一下一下按 Esc，记下每一下关的是哪一层

// 输入框：focused 时 Esc 的 target 是它，blur 后不是
let focused = false;
const input = { tagName: 'INPUT', isContentEditable: false, blur: vi.fn(() => (focused = false)) };

// 地图：正在画的一笔、工具自己的 Esc 各用掉一次
let cancels = 0;
let escapes = 0;
const fakeMap = { cancel: () => cancels-- > 0, escape: () => escapes-- > 0, fit() {}, zoomBy() {}, enter: () => false } satisfies MapApi;

function esc() {
  const e = { key: 'Escape', code: 'Escape', target: focused ? input : null, repeat: false, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  onKeyDown(e as unknown as KeyboardEvent);
}

// 现在开着的各层
function openLayers() {
  return {
    packDialog: !!packDialog.value,
    mapsDialog: mapsDialog.value,
    help: helpOpen.value,
    formEditor: !!formEditor.value,
    wizard: wizardOpen.value,
    openPanel: !!openPanel.value,
    input: focused,
    mapCancel: cancels > 0,
    mapEscape: escapes > 0,
    measurePoints: !!measure.value?.length,
    measure: !!measure.value,
    picking: picking.value,
    uiHidden: uiHidden.value,
    libStack: (libPanel.value?.stack.length ?? 0) > 1,
    library: !!libPanel.value,
    sheet: !!sheet.value,
    provinceSet: provinceSet.value.length > 0,
    selection: selectedProvince.value !== null || !!selectedFeature.value || !!selectedRiver.value || !!selectedLake.value,
  };
}

function openAll() {
  world.value = {} as never;
  packDialog.value = { view: 'packs' };
  mapsDialog.value = true;
  helpOpen.value = true;
  formEditor.value = {} as never;
  wizardOpen.value = true;
  openPanel.value = 'layers';
  focused = true;
  cancels = 1;
  escapes = 1;
  measure.value = [[0, 0]];
  picking.value = true;
  uiHidden.value = true;
  libPanel.value = { source: WORLD_SOURCE, stack: [HOME, { p: 'list', kind: 'species' }] };
  sheet.value = 'species';
  provinceSet.value = [1, 2];
  selectedProvince.value = 3;
  selectedFeature.value = 'island:1';
  selectedRiver.value = { kind: 'natural', cell: 5 } as never;
  selectedLake.value = 7 as never;
}

afterEach(() => {
  packDialog.value = null;
  mapsDialog.value = false;
  helpOpen.value = false;
  formEditor.value = null;
  wizardOpen.value = false;
  openPanel.value = null;
  focused = false;
  cancels = 0;
  escapes = 0;
  measure.value = null;
  picking.value = false;
  uiHidden.value = false;
  libPanel.value = null;
  sheet.value = null;
  provinceSet.value = [];
  selectedProvince.value = null;
  selectedFeature.value = null;
  selectedRiver.value = null;
  selectedLake.value = null;
  world.value = null;
  mapApi.current = null;
});

describe('Esc 的先后（第六十九轮）', () => {
  it('全部开着时一下关一层，顺序固定', () => {
    mapApi.current = fakeMap;
    openAll();
    const closed: string[] = [];
    for (let k = 0; k < 30; k++) {
      const before = openLayers();
      esc();
      const after = openLayers();
      const gone = (Object.keys(before) as (keyof typeof before)[]).filter((key) => before[key] && !after[key]);
      if (!gone.length) break;
      closed.push(gone.join('+'));
      // 编辑器关上以后再点进一个输入框：看“输入框”这一层排在哪里
      if (gone.includes('formEditor')) focused = true;
    }
    expect(closed).toEqual([
      'packDialog',
      'mapsDialog',
      'help',
      // 星球形态编辑器：先离开正在写的框，再按一次关上
      'input',
      'formEditor',
      'wizard',
      'openPanel',
      'input',
      'mapCancel',
      'mapEscape',
      // 量距离：先清空点，再退出
      'measurePoints',
      'measure',
      'picking',
      'uiHidden',
      // 资源库：一层层返回，首页再按一次关上
      'libStack',
      'library',
      'sheet',
      'provinceSet',
      'selection',
    ]);
    expect(input.blur).toHaveBeenCalledTimes(2);
  });

  it('没有世界时向导关不上，Esc 也不往下传', () => {
    wizardOpen.value = true;
    openPanel.value = 'layers';
    esc();
    expect(wizardOpen.value).toBe(true);
    expect(openPanel.value).toBe('layers');
  });

  it('地图上的一笔没取消到什么时往下走', () => {
    world.value = {} as never;
    mapApi.current = fakeMap;
    picking.value = true;
    esc();
    expect(picking.value).toBe(false);
  });
});

describe('捕获阶段的几层（第六十九轮：问话、拖卡片、脚本框的“变量和例子”）', () => {
  const capture = () => {
    const e = { key: 'Escape', target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    onEscapeCapture(e as unknown as KeyboardEvent);
    return e;
  };

  it('在冒泡的各层之上；问话 → 拖卡片 → 脚本框的帮助', () => {
    const order = Object.entries(ESC_RANK)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    expect(order.slice(0, 4)).toEqual(['ask', 'drag', 'scriptHelp', 'packDialog']);
    const hit: string[] = [];
    const open = new Set(['scriptHelp', 'ask', 'drag']);
    const off = (['scriptHelp', 'ask', 'drag'] as const).map((k) =>
      pushEscape(
        ESC_RANK[k],
        () => {
          if (!open.has(k)) return false;
          open.delete(k);
          hit.push(k);
          return true;
        },
        'capture',
      ),
    );
    for (let i = 0; i < 3; i++) expect(capture().stopPropagation).toHaveBeenCalled();
    expect(hit).toEqual(['ask', 'drag', 'scriptHelp']);
    // 都关了：不拦，交给输入框、面板和 keys.ts
    expect(capture().stopPropagation).not.toHaveBeenCalled();
    for (const f of off) f();
  });

  it('冒泡的一层不在捕获阶段用', () => {
    packDialog.value = { view: 'packs' };
    expect(capture().stopPropagation).not.toHaveBeenCalled();
    expect(packDialog.value).not.toBeNull();
    esc();
    expect(packDialog.value).toBeNull();
  });
});
