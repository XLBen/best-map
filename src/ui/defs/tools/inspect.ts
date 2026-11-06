import { MousePointer } from 'lucide-preact';
import type { ToolSpec } from '../types';

// 工具表的“指针”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const INSPECT_TOOLS = {
  // ---------- 第二十五轮：指针 ----------
  pointer: {
    category: 'inspect',
    icon: MousePointer,
    name: '指针',
    short: '指针',
    how: '点击查看档案，不改地图',
    cursor: 'default',
  },
} satisfies Record<string, ToolSpec>;
