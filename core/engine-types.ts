// 引擎的几种记录（第八十三轮从 core/engine.ts 原样搬出）：世界文件、各步耗时、历史的一步、检查点、预览的结果
import { DOC_VERSION } from './doc-version';
import type { Settings, Derived, Causes, SmallState } from './world';
import { type Command, type UndoRecord, Dirty } from './commands';
import type { ClimateBase } from './climate';
import type { SolveResult } from './constraints';

export interface WorldDoc {
  format: 'map2-world';
  // 文档的版本（doc-version.ts 的 DOC_VERSION）。第九轮起不再兼容旧存档：别的版本一律打不开
  version: typeof DOC_VERSION;
  settings: Settings;
  commands: Command[];
}

export interface Timings {
  elevation?: number;
  climate?: number;
  solve?: number;
  hydrology?: number;
  vegetation?: number;
  features?: number;
  // 人文的几层（第二十一轮：地形类别、资源、山峰）
  human?: number;
  total: number;
}

// 气候的基础（没有修正场时的两季温度、降水），加上地形：自然求解的高程（含湖的碗，不含只挖河床的河）。
// 气候、山名都按它算，所以画河、改河不会改变气候和山名，也不用重算高程与气候。
export interface EngineBase extends ClimateBase {
  terrain: Float32Array;
}

// 一份完整的推导结果：撤销、重做时直接换回，不必重算
export interface DerivedState {
  derived: Derived;
  base: EngineBase | null;
  solve: SolveResult;
  timings: Timings;
}

export interface DoneStep {
  // 编号（自动保存据此只写变了的那些步）
  id: number;
  cmd: Command;
  undo: UndoRecord;
  summary: string;
  dirty: Dirty;
  // 这一步之前的推导结果（撤销时换回）
  state?: DerivedState;
  // 第九十五轮：撤销记录算了多少字节（undo-budget.ts；丢掉了的是 0）。只在引擎里记，不进检查点
  bytes?: number;
}

// 检查点：引擎的完整状态（原因、推导、历史）。存进浏览器后，打开时直接恢复，不必重放所有命令
export interface Checkpoint {
  settings: Settings;
  causes: Causes;
  small: SmallState;
  derived: Derived;
  base: EngineBase | null;
  solve: SolveResult;
  done: Omit<DoneStep, 'state' | 'bytes'>[];
  timings: Timings;
}

export interface UndoneStep {
  cmd: Command;
  summary: string;
  // 这一步之后的推导结果（重做时换回）
  state?: DerivedState;
}

export interface DocTail extends Omit<WorldDoc, 'commands'> {
  // 从第 from 条起的命令；ids 是全部步的编号
  from: number;
  commands: Command[];
  ids: number[];
}

// 第八轮加的几项（在 diffWorlds 之外算）：执行后涂不成的格（与执行后的冲突一致）、变成陆地 / 变成海的格、
// 历史里会写的话、预览算了多久（毫秒，成本闸门用）、按哪个状态算的（主线程只显示与当前世界同一状态的预览）
export interface PreviewExtras {
  failing: number[];
  landGained: number[];
  landLost: number[];
  summary: string;
  ms: number;
  stateId: number;
}

export interface PreviewResult extends PreviewExtras {
  // 主导类型改变的格
  changedCells: number[];
  // 新出现 / 消失的河流格
  riverAdded: number[];
  riverRemoved: number[];
  maxCorrT: number;
  maxCorrP: number;
  conflicts: number;
  // 预览后各约束的满足比例
  satisfied: { id: string; satisfied: number; required: number }[];
  // 新出现 / 消失的湖面格
  lakeAdded: number[];
  lakeRemoved: number[];
  // 挖低了至少 1 m 的格（画河挖出的峡谷），最深挖了多少米
  carved: { cells: number[]; maxDrop: number };
  // 画河、改河（add_guide / update_guide）：这条河执行后的样子。flow 是河道每格的流量（与 cells 对齐）；
  // name 是它的地名（还没名字时为 ''）；followed：陆地上每一格都流向河道的下一格（完全照着画的走）
  guide?: { id: string; flow: number[]; name: string; followed: boolean };
}

// 省份的轻预览（Engine.previewProvinces）：执行后的省份数组、各省、切线（没有切线时为 null）与历史里会写的一句话
export interface ProvincesPreview {
  province: Int32Array;
  provinces: SmallState['provinces'];
  seams: NonNullable<SmallState['provinceSeams']> | null;
  summary: string;
  // 命令有没有改动什么（什么都没改时执行也不进历史）
  changed: boolean;
}
