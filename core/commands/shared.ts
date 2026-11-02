import type { Derived, SmallState, World } from '../world';
import { z } from 'zod';
import type { SmallCopy } from '../small-copy';
import { clearAuto } from '../human/auto';
import { clearCountries } from '../human/countries';
import { clearCities } from '../human/settlements';
import { tidyCountries } from '../human/country-edit';
import { fitProvincesToCountries } from '../provinces';
import { styleById } from '../name-styles';

// 各类命令共用的：Dirty、撤销记录、ApplyContext、RunResult 与几个小函数（第四十一轮从 commands.ts 原样搬来）

// 推导需要从哪一层开始重算
export const Dirty = {
  None: 0,
  // 只需要重新起名（地物本身没变）
  Names: 1,
  // 只重算人文的几层（第二十一轮：地形类别、资源、山峰，见 human/index.ts）与名字；自然的部分不动
  Human: 2,
  Vegetation: 3,
  Solve: 4,
  Climate: 5,
  Elevation: 6,
} as const;
export type Dirty = (typeof Dirty)[keyof typeof Dirty];

export type ArrayKey = 'landDelta' | 'upliftDelta' | 'erodDelta' | 'tempOffset' | 'moistOffset' | 'province' | 'islandType' | 'islandHeight' | 'fragment' | HumanArray | `field:${string}`;

// 人文的原因数组（第二十一轮）：第一次画时才建，撤销到那之前时去掉（UndoRecord.dropArrays）。第二十二轮加了人口的四个
// 第二十三轮加了国家的领土 country；第二十七轮加了自动的结果（生成时的领土、人口，见 human/auto.ts）
export type HumanArray = 'terrainClass' | 'resource' | PopArray | 'country' | AutoArray;
export type PopArray = 'popTotal' | 'popGroup' | 'popShare' | 'popManual';
export type AutoArray = 'countryAuto' | 'popAutoTotal' | 'popAutoGroup' | 'popAutoShare';
export const POP_ARRAYS: readonly PopArray[] = ['popTotal', 'popGroup', 'popShare', 'popManual'];
export const AUTO_ARRAYS: readonly AutoArray[] = ['countryAuto', 'popAutoTotal', 'popAutoGroup', 'popAutoShare'];
export const HUMAN_ARRAYS: readonly HumanArray[] = ['terrainClass', 'resource', ...POP_ARRAYS, 'country', ...AUTO_ARRAYS];

export function getArray(world: World, key: ArrayKey): Float32Array | Uint8Array | Uint16Array | Int32Array | undefined {
  if (key.startsWith('field:')) return world.causes.fields[key.slice(6)];
  return world.causes[key as Exclude<ArrayKey, `field:${string}`>];
}

// 撤销记录：稀疏的数组差异 + 小状态快照（small、content，见 small-copy.ts：内容按引用共用）
export interface UndoRecord extends SmallCopy {
  arrays: { key: ArrayKey; idx: Int32Array; old: Float64Array }[];
  // 新增或删除的自定义场：撤销时恢复为 old（null 表示原来不存在）
  fields: { name: string; old: Float32Array | null }[];
  // 这一步第一次有了湖里的岛定下的高度（causes.islandHeight）：撤销时去掉整个数组
  dropHeights?: true;
  // 这一步第一次有了破碎度（causes.fragment，第十八轮）：撤销时去掉整个数组
  dropFragment?: true;
  // 这一步第一次有了画的地形类别、资源（第二十一轮）：撤销时去掉这些数组
  dropArrays?: HumanArray[];
}

export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).join('；');
}

export interface ApplyContext {
  // 需要推导结果的命令调用它，保证推导是最新的
  ensureDerived: () => Derived;
  // 在批量命令里（第十五轮：湖里的岛不能放进去——批量里前面几条改的东西还没算进推导，重放时却算进了）
  inBatch?: boolean;
}

// 这一步移出世界的一项内容（第二十九轮）：生成人文后的清理、整理本世界、资源库里的移出……凡是拿掉的都列出来，
// 界面拿它把自己做的、改过的存进资源库（“来自《世界名》”；与内置的一模一样的本来就在内置的包里，不另存——
// 第三十轮起计算 Worker 里没有内置数据，是不是内置原样由界面按内置的树判断）。
// item 是移出之前的样子，origin 是它记着的来源（没有时是本世界自己做的）
export interface RemovedItem {
  kind: string;
  id: string;
  name: string;
  item: unknown;
  origin?: string[];
}

export const nextId = (world: World, prefix: string) => `${prefix}-${world.small.nextId++}`;

// ---------- 人文（第二十二轮） ----------

// 去掉人文：人口清零（数组留着，撤销时照旧退回），小数据里的去掉
export function clearPop(world: World) {
  const c = world.causes;
  c.popTotal?.fill(0);
  c.popGroup?.fill(0);
  c.popShare?.fill(0);
  c.popManual?.fill(0);
  clearAuto(world);
  // 国家跟着人文一起去掉（第二十三轮）；城市、道路也是（第二十四轮；地标、自定义点留着）
  clearCountries(world);
  clearCities(world);
  if (!world.small.landmarks) delete world.small.settlementRules;
  delete world.small.human;
  delete world.small.popGroups;
}

// 国家变了之后（第二十三轮）：整理档案（首都、外交），省份跟着国界切开
export function afterCountries(world: World) {
  tidyCountries(world);
  fitProvincesToCountries(world);
}

// 历史里地名风格的名字（'' 是一种都没有）
export function styleLabel(small: SmallState, id: string): string {
  if (!id) return '不起名';
  const s = styleById(small, id);
  return s && 'name' in s ? s.name : id;
}

// 执行一条命令（批量里的每一条也经过这里）。带 from 的启用命令执行完记下来源（第二十九轮，见 content/origin.ts）
// 一条命令的结果：重算到哪一层、历史里的说明；skipped（第三十轮）是缺了内容跳过的步骤（见 content/missing.ts）
export type RunResult = { dirty: Dirty; summary: string; skipped?: string[] };

