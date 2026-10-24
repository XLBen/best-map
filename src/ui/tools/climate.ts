import type { Command } from '../../../core/commands';
import type { World } from '../../../core/world';
import { type ToolOptions, exec, options, showToast, world } from '../../state';
import { climateHere, climateMask, erasableLayer } from '../edits';
import { type RGB, type ToolHandler, WHITE } from './api';
import { type Stroke, brushTool, oneLayer, strengthValues } from './brush';
import { biomeChange } from './nature';

// 气候：冷暖、干湿、擦掉冷暖干湿的改动、涂自定义场

const CLIMATE_INFO = {
  warm: { name: '更暖', color: [235, 110, 70] as RGB, flip: 'cold' },
  cold: { name: '更冷', color: [90, 150, 235] as RGB, flip: 'warm' },
  wet: { name: '更湿', color: [60, 190, 170] as RGB, flip: 'dry' },
  dry: { name: '更干', color: [225, 190, 90] as RGB, flip: 'wet' },
} as const;
type ClimateKind = keyof typeof CLIMATE_INFO;

// 冷暖干湿、自定义场的力度最大是多少（底部条滑块的上限，预览深浅按它算）
export const CLIMATE_MAX = 2;
export const FIELD_MAX = 1;

// 力度 1：中心升降 4 °C，或雨水乘除 e^0.5（多约 65% / 少约 39%）。short 是底部条上滑块右边的数
export function climateEffect(c: ClimateKind, amount: number): { field: 'tempOffset' | 'moistOffset'; value: number; text: string; short: string } {
  if (c === 'warm' || c === 'cold') {
    const v = (c === 'warm' ? 4 : -4) * amount;
    const deg = Math.abs(v).toFixed(Math.abs(v) < 2 ? 1 : 0);
    return { field: 'tempOffset', value: v, text: `中心${v > 0 ? '升温' : '降温'}约 ${deg} °C`, short: `${v > 0 ? '+' : '−'}${deg} °C` };
  }
  const v = (c === 'wet' ? 0.5 : -0.5) * amount;
  const pct = Math.round(Math.abs(Math.exp(v) - 1) * 100);
  return { field: 'moistOffset', value: v, text: `中心雨水${v > 0 ? '多' : '少'}约 ${pct}%`, short: `雨水${v > 0 ? '+' : '−'}${pct}%` };
}

// 冷暖（group = temp）或干湿（moist）画笔：选的是哪一种、力度多大（冷暖、干湿各有各的力度）
export const climateKind = (group: 'temp' | 'moist', o: ToolOptions): ClimateKind => (group === 'temp' ? o.tempMode : o.moistMode);
export const climateAmount = (group: 'temp' | 'moist', o: ToolOptions): number => (group === 'temp' ? o.tempAmount : o.moistAmount);

// 按住 Shift 反着来：更暖 ↔ 更冷，更湿 ↔ 更干
export function climateTool(group: 'temp' | 'moist'): ToolHandler {
  const kindOf = (shift: boolean): ClimateKind => {
    const k = climateKind(group, options.value);
    return shift ? CLIMATE_INFO[k].flip : k;
  };
  const amountNow = () => climateAmount(group, options.value);
  // 松手时执行的命令（确切预览算的也是它）
  const cmdOf = (s: Stroke, shift: boolean): Command => {
    const e = climateEffect(kindOf(shift), amountNow());
    return { op: 'paint', field: e.field, cells: s.cells, values: s.weights().map((wt) => wt * e.value), mode: 'add' };
  };
  const head = (shift: boolean) => {
    const c = kindOf(shift);
    return `${CLIMATE_INFO[c].name} ${climateEffect(c, amountNow()).short}`;
  };
  return brushTool({
    hint: () => ({ text: null }),
    layers(_w, s, shift) {
      const c = kindOf(shift);
      const amount = amountNow();
      // 深浅跟着力度：拖“力度”滑块时预览跟着变
      const values = strengthValues(s.weights().map((wt) => wt * amount), CLIMATE_MAX);
      return { layers: [{ cells: s.cells, values, color: CLIMATE_INFO[c].color, alpha: 0.65 }], hint: head(shift) };
    },
    exact: (_w, s, shift) => (s.t.size ? cmdOf(s, shift) : null),
    exactHint: (_w, _s, shift, r) => `${head(shift)} · ${biomeChange(r)}`,
    commit: (_w, s, shift) => exec(cmdOf(s, shift), '正在计算…'),
  });
}

// 擦掉冷暖干湿的改动：只涂得到改过的格，中心全收回、边缘渐变。
// 选中时地图上一直用浅斜线标出改过的格，悬停说这里改过什么（不管自定义场和生态对周围的影响）
export function climateEraseTool(): ToolHandler {
  const changed = (w: World, i: number) => w.causes.tempOffset[i] !== 0 || w.causes.moistOffset[i] !== 0;
  return brushTool({
    hint: () => ({ text: null }),
    filter: changed,
    backdrop: (w) => oneLayer(erasableLayer(climateMask(w))),
    here: (w, cells) => climateHere(w, cells),
    layers(_w, s) {
      return { layers: [{ cells: s.cells, values: s.weights(), color: WHITE, alpha: 0.6 }], hint: s.t.size ? `擦除 ${s.t.size} 格` : '这里没改过' };
    },
    exact: (_w, s) => (s.t.size ? { op: 'restore_climate', cells: s.cells, t: s.ts } : null),
    exactHint: (_w, s, _shift, r) => `擦除 ${s.t.size} 格 · ${biomeChange(r)}`,
    async commit(_w, s) {
      if (!s.t.size) {
        showToast('这里的冷暖干湿没改过', true);
        return;
      }
      await exec({ op: 'restore_climate', cells: s.cells, t: s.ts }, '正在计算…');
    },
  });
}

// 自定义场：按住拖动增加或减少（中心多、边缘少），按住 Shift 反过来
export function fieldTool(): ToolHandler {
  const sign = (shift: boolean) => ((options.value.fieldMode === 'add') !== shift ? 1 : -1);
  // 松手时执行的命令（确切预览算的也是它）
  const cmdOf = (s: Stroke, shift: boolean): Command => {
    const amount = sign(shift) * options.value.fieldAmount;
    return { op: 'paint', field: `field:${options.value.field}`, cells: s.cells, values: s.weights().map((wt) => wt * amount), mode: 'add' };
  };
  const head = (shift: boolean) => {
    const up = sign(shift) > 0;
    return `${options.value.field} ${up ? '变大' : '变小'}：中心 ${up ? '+' : '−'}${options.value.fieldAmount.toFixed(2)}`;
  };
  return brushTool({
    hint: () => {
      const name = options.value.field;
      const w = world.value;
      if (!name || !w?.causes.fields[name]) return { text: '先在“调整”里新建场', warn: true };
      return { text: null };
    },
    layers(_w, s, shift) {
      const amount = options.value.fieldAmount;
      // 深浅跟着力度：拖“力度”滑块时预览跟着变；提示写出中心变多少
      const values = strengthValues(s.weights().map((wt) => wt * amount), FIELD_MAX);
      const up = sign(shift) > 0;
      return { layers: [{ cells: s.cells, values, color: up ? [190, 120, 230] : [120, 120, 140], alpha: 0.65 }], hint: head(shift) };
    },
    exact: (w, s, shift) => (s.t.size && options.value.field && w.causes.fields[options.value.field] ? cmdOf(s, shift) : null),
    exactHint: (_w, _s, shift, r) => `${head(shift)} · ${biomeChange(r)}`,
    commit: (_w, s, shift) => exec(cmdOf(s, shift), '正在计算…'),
  });
}
