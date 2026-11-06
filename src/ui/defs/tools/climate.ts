import { CloudRain, Sparkles, Thermometer } from 'lucide-preact';
import { FIELD_MAX } from '../tool-values';
import { BRUSH, CLIMATE_AMOUNT } from '../tool-sliders';
import type { ToolSpec } from '../types';

// 工具表的“气候”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const CLIMATE_TOOLS = {
  temp: {
    category: 'climate',
    icon: Thermometer,
    name: '冷暖',
    short: '冷暖',
    how: '按住涂，变冷或变暖；Shift 反过来',
    size: BRUSH,
    amount: CLIMATE_AMOUNT('temp'),
    bar: () => [
      {
        kind: 'choice',
        key: 'tempMode',
        options: [
          { value: 'cold', label: '更冷' },
          { value: 'warm', label: '更暖' },
        ],
      },
    ],
  },
  moist: {
    category: 'climate',
    icon: CloudRain,
    name: '干湿',
    short: '干湿',
    how: '按住涂，变湿或变干；Shift 反过来',
    size: BRUSH,
    amount: CLIMATE_AMOUNT('moist'),
    bar: () => [
      {
        kind: 'choice',
        key: 'moistMode',
        options: [
          { value: 'wet', label: '更湿' },
          { value: 'dry', label: '更干' },
        ],
      },
    ],
  },
  field: {
    category: 'climate',
    icon: Sparkles,
    name: '涂自定义场',
    short: '场',
    how: '按住涂，增减自定义场',
    size: BRUSH,
    amount: { key: 'fieldAmount', label: '力度', range: () => [0.05, FIELD_MAX], scale: 'log', snap: (v) => Math.round(v * 100) / 100, format: (v) => `±${v.toFixed(2)}` },
    hidden: (w) => !Object.keys(w.causes.fields).length,
    bar: (w) => [
      { kind: 'choice', key: 'field', options: Object.keys(w.causes.fields).map((f) => ({ value: f, label: f })) },
      {
        kind: 'choice',
        key: 'fieldMode',
        options: [
          { value: 'add', label: '增加' },
          { value: 'sub', label: '减少' },
        ],
      },
    ],
  },
} satisfies Record<string, ToolSpec>;
