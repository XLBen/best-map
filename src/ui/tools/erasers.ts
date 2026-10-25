import type { Command } from '../../../core/commands';
import type { World } from '../../../core/world';
import { exec, options, showToast, world } from '../../state';
import { NO_COUNTRIES, hasCountries } from '../countries';
import { type EditMask, classMask, countryMask, erasableLayer, fieldMask, popMask, resourceMask } from '../edits';
import { type RGB, type ToolHandler, BLOCKED_RGB, WHITE } from './api';
import { type Stroke, brushTool, oneLayer } from './brush';
import { NO_HUMAN, hasHuman } from './culture';
import { dryLand } from './human';
import { biomeChange } from './nature';

// 橡皮擦（第二十七轮）：底部条第二行的开关打开时，笔刷换成这里的一支（见 defs/tools.ts 的 eraser）。
// 恢复自动：只涂得到改过的格（选中时地图上一直用浅斜线标出），去掉手工的改动；
// 清空：领土清成无主地、人口清成 0、资源清成“没有”。地形、冷暖干湿、生态的恢复自动沿用原来的三支（restoreTool 等）

interface EraserSpec {
  // 能不能用（没有人文、没有国家时说一声）
  ready?: (w: World) => string | null;
  // 恢复自动：改过的格（地图上标出来，只涂得到它们）
  mask?: (w: World) => EditMask;
  // 清空：涂得到哪些格
  filter?: (w: World, i: number) => boolean;
  // 这一笔说的是什么（“恢复自动”“无主地”）、什么都擦不到时的一句话
  label: string;
  empty: string;
  color?: RGB;
  command: (w: World, s: Stroke) => Command | null;
  // 擦完生态会变（自定义场）：停顿时确切预览
  exact?: boolean;
}

function eraserBrush(spec: EraserSpec): ToolHandler {
  const filter = (w: World, i: number) => (spec.mask ? spec.mask(w).has[i] === 1 : true) && (!spec.filter || spec.filter(w, i));
  return brushTool({
    hint: () => {
      const w = world.value;
      const why = w && spec.ready?.(w);
      return why ? { text: why, warn: true } : { text: null };
    },
    filter,
    backdrop: (w) => (spec.mask && !spec.ready?.(w) ? oneLayer(erasableLayer(spec.mask(w))) : null),
    layers(w, s) {
      const why = spec.ready?.(w);
      if (why) return { layers: [{ cells: s.cells, color: BLOCKED_RGB, alpha: 0.5 }], hint: why, warn: true };
      return { layers: [{ cells: s.cells, values: s.weights(), color: spec.color ?? WHITE, alpha: 0.6 }], hint: s.t.size ? `${spec.label} · ${s.t.size} 格` : spec.empty, warn: !s.t.size };
    },
    ...(spec.exact
      ? {
          exact: (w: World, s: Stroke) => (s.t.size ? spec.command(w, s) : null),
          exactHint: (_w: World, s: Stroke, _shift: boolean, r: Parameters<typeof biomeChange>[0]) => `${spec.label} · ${s.t.size} 格 · ${biomeChange(r)}`,
        }
      : {}),
    async commit(w, s) {
      const cmd = s.t.size && !spec.ready?.(w) ? spec.command(w, s) : null;
      if (!cmd) {
        showToast(spec.empty, true);
        return;
      }
      await exec(cmd, '正在计算…');
    },
  });
}

const noHuman = (w: World) => (hasHuman(w) ? null : NO_HUMAN);
const noCountries = (w: World) => (hasCountries(w) ? null : NO_COUNTRIES);

// 地形类别、资源：去掉画过的
export const classEraser = () =>
  eraserBrush({ mask: classMask, label: '类别恢复自动', empty: '这里的类别没画过', command: (_w, s) => ({ op: 'set_cell_class', cells: s.cells, class: null }) });
export const resourceEraser = () =>
  eraserBrush({ mask: resourceMask, label: '资源恢复自动', empty: '这里的资源没画过', command: (_w, s) => ({ op: 'set_cell_resource', cells: s.cells, resource: null }) });
export const resourceClear = () =>
  eraserBrush({ filter: dryLand, label: '没有资源', empty: '这里没有陆地', command: (_w, s) => ({ op: 'set_cell_resource', cells: s.cells, resource: 'none' }) });

// 自定义场：中心擦掉、边缘渐变（与擦冷暖干湿相同）
export const fieldEraser = () =>
  eraserBrush({
    ready: (w) => (options.value.field && w.causes.fields[options.value.field] ? null : '先在“调整”里新建场'),
    mask: (w) => fieldMask(w, options.value.field ?? ''),
    label: '擦除',
    empty: '这里的场没涂过',
    exact: true,
    command: (w, s) => {
      const name = options.value.field;
      const f = name ? w.causes.fields[name] : undefined;
      if (!f) return null;
      const wt = s.weights();
      return { op: 'paint', field: `field:${name}`, cells: s.cells, values: s.cells.map((i, k) => f[i] * (1 - wt[k])), mode: 'set' };
    },
  });

// 人口、文化：恢复成生成时的人；清空：这里没有人
export const popEraser = () => eraserBrush({ ready: noHuman, mask: popMask, label: '人口恢复自动', empty: '这里的人口没改过', command: (_w, s) => ({ op: 'restore_pop', cells: s.cells }) });
export const popClear = () =>
  eraserBrush({
    ready: noHuman,
    filter: (w, i) => dryLand(w, i) && (w.causes.popTotal?.[i] ?? 0) > 0,
    label: '清空人口',
    empty: '这里没有人',
    color: [120, 120, 130],
    command: (_w, s) => ({ op: 'paint_pop', cells: s.cells, mode: 'clear' }),
  });

// 领土：恢复成生成国家时的样子；清空：无主地
export const countryEraser = () => eraserBrush({ ready: noCountries, mask: countryMask, label: '领土恢复自动', empty: '这里的领土没改过', command: (_w, s) => ({ op: 'restore_country', cells: s.cells }) });
export const countryClear = () =>
  eraserBrush({
    ready: noCountries,
    filter: (w, i) => w.causes.land[i] === 1 && (w.causes.country?.[i] ?? -1) >= 0,
    label: '无主地',
    empty: '这里已经是无主地',
    command: (_w, s) => ({ op: 'paint_country', cells: s.cells, country: null }),
  });
