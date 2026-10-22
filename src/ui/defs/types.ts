import type { LucideIcon } from 'lucide-preact';
import type { ComponentType } from 'preact';
import type { Command } from '../../../core/commands';
import type { World } from '../../../core/world';
import type { Category, ToolId, ToolOptions } from '../../state';
import type { ToolEnv, ToolHandler } from '../tools';

// 界面的注册表：工具、类别、世界调整、图层都在这里声明，
// 顶栏、底部工具条、调整面板、图层面板都由它们生成。
// 加一个工具、一个参数、一种底图，只需要加一条声明。

export type Icon = LucideIcon;

// options 里的数值字段
export type NumKey = { [K in keyof ToolOptions]: ToolOptions[K] extends number ? K : never }[keyof ToolOptions];
// options 里的取值字段（字符串）
export type ChoiceKey = { [K in keyof ToolOptions]: ToolOptions[K] extends string | null ? K : never }[keyof ToolOptions];

// 底部条上的滑块
export interface SliderDef {
  key: NumKey;
  // 写在滑块左边的两个字：半径 / 直径 / 力度 / 疏密 / 过渡 / 大小
  label: string;
  range(w: World): [number, number];
  scale: 'log' | 'linear';
  // 取整成好读的数：滑块右边、提示、历史里显示的是同一个数
  snap?(v: number, w: World): number;
  // 滑块右边一直显示的数值，要短：“72 km”“−4 °C”
  format(v: number, w: World): string;
  // 现在用不上时不显示（比如“强制”模式下的过渡范围、“圈一片”时的画笔大小）
  enabled?(w: World): boolean;
}

export interface ChoiceOption {
  value: string;
  label: string;
  hint?: string;
  // 色块（生态、省份）
  swatch?: string;
}

// 底部选项条上的一项
export type BarItem =
  // label：写在选项左边的两个字（“走向”）
  | { kind: 'choice'; key: ChoiceKey; options: ChoiceOption[]; label?: string }
  | { kind: 'action'; icon?: Icon; label: string; title?: string; run(): void }
  | { kind: 'custom'; render: ComponentType };

export interface ToolDef {
  id: ToolId;
  category: Category;
  icon: Icon;
  name: string;
  // 底部工具条上图标下面的两个字
  short: string;
  // 鼠标停在工具上时的一句“怎么用”
  how: string;
  // 底部条上的两个滑块
  size?: SliderDef;
  amount?: SliderDef;
  bar?(w: World): BarItem[];
  // 不出现在工具列表里（比如没有自定义场时的“涂自定义场”）；正在用时照样显示
  hidden?(w: World): boolean;
  // Alt+点：吸取（取这里的生态、这里的省份）。返回取到了什么，用来提示
  pick?(w: World, cell: number): string | null;
  // R：换个形状
  reroll?(): void;
  create(env: ToolEnv): ToolHandler;
}

export interface CategoryDef {
  id: Category;
  icon: Icon;
  label: string;
  tools: ToolId[];
  // 底部工具条末尾“⋯”里的设置（自动划分规则、文字包……）
  extras?: ComponentType;
}

// “调整”面板里的一项：整个世界的参数
export interface AdjustmentDef {
  id: string;
  group: string;
  label: string;
  hint: string;
  available(w: World): boolean;
  // 这个世界里不显示（比如整个星球没有“地图在星球上的位置”）
  hidden?(w: World): boolean;
  read(w: World): number;
  range: [number, number];
  // 范围随世界而变时（比如纬度：地图越大能挪的越少）
  rangeOf?(w: World): [number, number];
  // 滑块下面的一行小字（比如纬度：跨了哪几个气候带）
  note?(w: World, v: number): string;
  scale?: 'log' | 'linear';
  step: number;
  format(v: number): string;
  command(w: World, v: number): Command;
  // 'terrain'：拖动时实时预览陆海变化
  preview?: 'terrain';
  // 预览要用的参数（与 command 对应）
  patch?(v: number): Record<string, number>;
  busyLabel: string;
}
