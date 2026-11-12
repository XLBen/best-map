import type { LucideIcon } from 'lucide-preact';
import type { Command } from '../../../core/commands';
import type { World } from '../../../core/world';
import type { Shape } from '../../render/overlay';
import type { Category, ToolId, ToolOptions, ViewMode } from '../../state';
import type { CategoryHighlights } from '../map/highlights';
import type { ToolEnv, ToolHandler } from '../tools';
import type { PanelKey } from './panel-registry';
import type { WorldSign } from './simple-ui';

// 界面的注册表：工具、类别、世界调整、图层都在这里声明，
// 顶栏、底部工具条、调整面板、图层面板、地图上按类画的高亮、光标、换工具时的清理都由它们生成。
// 加一个工具：工具本身写在 tools/ 下（或 river/ 下），再在 defs/tools/ 下那一类的文件里加一条——ToolId、类别里的工具列表都由工具表推出来——
// 并在 tools/bind.ts 里接上它做什么（create、吸管、橡皮擦、Delete）。底部条上自己画的部件、“⋯”里的设置在工具表里只写名字（panel-registry.ts），
// 部件在 panels/ 下登记。加一个参数、一种底图也只要加一条声明。

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
  // 自己画的部件：写名字，部件在 panels/ 下登记（panel-registry.ts）
  | { kind: 'custom'; panel: PanelKey };

// 工具表里的一条（id 是它在表里的键）
export interface ToolSpec {
  category: Category;
  icon: Icon;
  name: string;
  // 底部工具条上图标下面的两个字
  short: string;
  // 一句“怎么用”：鼠标停在底部条的工具按钮上时写（底部条上不再常显）
  how: string;
  // 底部条上的两个滑块
  size?: SliderDef;
  amount?: SliderDef;
  bar?(w: World): BarItem[];
  // 不出现在工具列表里（比如没有自定义场时的“涂自定义场”）；正在用时照样显示
  hidden?(w: World): boolean;
  // 第九十九轮：只在完整界面里露（省略就是常用）。简单界面里它在这一排末尾的“还有 N 个”里；正拿着它、按了它的数字键时照常露着
  more?: true;
  // 写了 more 的工具：世界里已经有它对应的东西时（simple-ui.ts 的 WORLD_SIGNS 的一个键），简单界面里也自己露出来
  when?: WorldSign;
  // 地图上的光标：点选类的工具是手指，指针是箭头；省略时是十字（styles.css 的 .map-overlay）
  cursor?: 'pointer' | 'default';
  // 第一百轮：这个工具里按着 Shift / Alt 做的事，而且屏幕上没有别的按钮做得到（画笔的“Shift 反过来”有模式选择，不算）。
  // 没有键盘的人按不了：触摸设备上底部条第二行各多一个开关（label），开着时地图上的每一下都当作按着那个键（touch-ui.ts 的 held）
  mods?: { shift?: ModSpec; alt?: ModSpec };
  // 开着时底图换成这一层（地形类别、资源），换到别的工具时换回原来的（这期间在图层里换过就不动）。
  // 写成函数时跟着选项变（人口笔刷按模式）
  view?: ViewMode | (() => ViewMode);
  // 换到别的工具时清掉的东西（选中的河、湖，选生态的范围）
  onLeave?(): void;
  // 地图跟着重画的状态（选中的河、湖……）：读一下就行
  watch?(): unknown;
  // 选中的东西在地图上的样子（画河时选中的河）：沿着它的光，它自己的地名先不标
  focus?: { glow(w: World): Shape[]; hideLabel(w: World): string };
}

// 屏幕上代替 Shift / Alt 的开关：开关上的字、悬停里的一句
export interface ModSpec {
  label: string;
  title: string;
}

// 工具做什么（第六十九轮：tools/bind.ts 登记进工具表，工具表不引用 tools/）。
// onLeave、watch 也可以写在这里（读的是工具自己的状态时：选生态的范围、省份画笔的“新省份”）
export interface ToolBehavior {
  // Alt+点、底部条上的吸管（第二十七轮）：吸取（取这里的生态、这里的省份、这里的冷暖）。返回取到了什么，用来提示
  pick?(w: World, cell: number): string | null;
  // 橡皮擦（第二十七轮）：底部条第二行的开关打开时换成这一支。auto 恢复自动（去掉手工的改动），
  // clear 清空（只在有意义的地方有：领土清成无主地、人口清成 0、资源清成“没有”）
  eraser?: { auto?: (env: ToolEnv) => ToolHandler; clear?: (env: ToolEnv) => ToolHandler };
  // Delete 键（第二十四轮：删除选中的城市、道路、地标、点）：用掉了返回 true
  del?(): boolean;
  onLeave?(): void;
  watch?(): unknown;
  create(env: ToolEnv): ToolHandler;
}

export interface ToolDef extends ToolSpec, ToolBehavior {
  id: ToolId;
}

// 一类工具开着时地图上多画的
export interface CategoryMap {
  // 多画的高亮（没涂成的格、选中的省、无人区、选中的地名），叠在工具一直画着的图层之上、预览之下
  highlights?: CategoryHighlights;
  // 省份类：高亮、平涂按剪刀切线换过的格取，标出所有的省名，底图画省界，吸取按画出来的省
  provinces?: boolean;
  // 地名类：标出所有的地名，鼠标下的地名亮（鼠标不在地名上时亮选中的那个：给出它的 key）
  labels?: () => string | null;
  // 水系：河道的标记
  markers?: boolean;
}

export interface CategoryDef {
  id: Category;
  icon: Icon;
  label: string;
  // 这一类的工具（按工具表里的先后，由工具表推出来）
  tools: ToolId[];
  // 底部工具条末尾“⋯”里的设置（自动划分规则、文字包……）：部件的名字（panel-registry.ts）
  extras?: PanelKey;
  // 离开这一类时清掉的东西（选中的省、地名）
  onLeave?(): void;
  // 地图跟着重画的状态
  watch?(): unknown;
  map?: CategoryMap;
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
  // 第九十三轮：点数值打字时这个值写成什么数（省略时就是值本身；河流多少存的是位置，打的是门槛的流量）
  typed?(v: number): string;
  // 第九十九轮：只在完整界面里露（省略就是常用）；touched：这个世界里它不在默认值上（改过的照常露着）
  more?: true;
  touched?(w: World): boolean;
  command(w: World, v: number): Command;
  // 'terrain'：拖动时实时预览陆海变化；'world'：停下后在副本上算出将来的世界（生态、雪、河、风），地图直接画它
  preview?: 'terrain' | 'world';
  // 预览要用的参数（与 command 对应）
  patch?(v: number): Record<string, number>;
  busyLabel: string;
}
