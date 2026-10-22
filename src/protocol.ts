import type { Command } from '../core/commands';
import type { DocTail, PreviewResult, ProvincesPreview, Timings, WorldDoc } from '../core/engine';
import type { ExportOptions } from '../core/export';
import type { WorldgenInput } from '../core/generate';
import type { PreviewPatch } from '../core/preview-world';
import type { TerrainPatch, TerrainPreview } from '../core/terrain';
import type { GeoFeature } from '../core/features';
import type { Causes, Derived, Settings, SmallState } from '../core/world';

// 主线程与计算 Worker 之间的消息

// safe：安全模式（脚本不运行）。一个 Worker 从第一次新建、打开起就固定是不是安全模式，换模式时主线程另开一个 Worker
export type Request =
  | { kind: 'init'; settings: Partial<Settings>; commands?: Command[]; safe?: boolean }
  | { kind: 'load'; doc: WorldDoc; safe?: boolean }
  | { kind: 'exec'; cmd: Command }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'preview'; cmd: Command }
  // 省份命令的轻预览：只算省份（重划、按新规则重新划分之前先看新的省界和省名）
  | { kind: 'previewProvinces'; cmd: Command }
  // “调整”面板拖滑块时：只组合地形，返回陆海的变化
  | { kind: 'previewTerrain'; patch: TerrainPatch }
  // 预览，连同将来的世界（与当前世界的差别）：地图画出将来的样子
  | { kind: 'previewWorld'; cmd: Command }
  // 换一个：撤掉最后一步并执行新命令
  | { kind: 'replaceLast'; cmd: Command }
  | { kind: 'doc' }
  // 自动保存：只要已存的步之后变了的命令
  | { kind: 'docTail'; ids: number[] }
  // 页面要被隐藏、关掉：立即写检查点
  | { kind: 'checkpoint' }
  // 新建向导：用少量格子快速生成一张缩略图（一张一张要，画好一张显示一张）
  | { kind: 'thumb'; settings: Partial<Settings>; gen: WorldgenInput; width: number; height: number };

export interface Snapshot {
  settings: Settings;
  causes: Causes;
  small: SmallState;
  derived: Derived;
  history: { summary: string; done: boolean }[];
  canUndo: boolean;
  canRedo: boolean;
  timings: Timings;
  // 引擎的状态编号（预览按它判断过没过期）
  stateId: number;
}

// 轻快照：只改了名字、省份（推导没有重算）时只发这些，推导数组沿用主线程上已有的
export interface LightSnapshot {
  light: true;
  small: SmallState;
  features: GeoFeature[];
  province: Int32Array;
  history: { summary: string; done: boolean }[];
  canUndo: boolean;
  canRedo: boolean;
  timings: Timings;
  stateId: number;
}

// 导出 Worker：一次导出一个世界；进度消息之后是结果
export interface ExportJob {
  settings: Settings;
  causes: Causes;
  small: SmallState;
  derived: Derived;
  doc: WorldDoc;
  opts: ExportOptions;
}

// warnings：导出时要告诉用户的话（比如极小的省在切线附近分不到像素）
export type ExportReply = { progress: number } | { ok: true; zip: Uint8Array; warnings?: string[] } | { ok: false; error: string };

// 主线程保存的命令记录（Worker 卡住、崩了时用它恢复世界）：执行、撤销、重做、换一个、新建、打开的回复都带上
// 上次回复以来变了的命令（engine.docTail）。epoch：Worker 里的引擎换一个（新建、打开）就加一，那时 from 为 0
export interface MirrorLog extends DocTail {
  epoch: number;
}

// Worker 主动发来的消息（没有 id）：脚本开始运行、还在算（最多每 250 毫秒一次）、算完（含出错）。
// 主线程的看门狗只在脚本运行期间计时（见 sandbox.ts）
export interface ScriptPing {
  kind: 'script';
  phase: 'enter' | 'tick' | 'exit';
  // 谁的脚本（生态名……）
  label: string;
}

export type Response =
  | {
      id: number;
      ok: true;
      summary?: string;
      log?: MirrorLog;
      // 这个 Worker 是安全模式（新建、打开的回复里带）
      safe?: boolean;
      // 命令什么都没改：没有快照，也没有进历史
      noop?: boolean;
      snapshot?: Snapshot | LightSnapshot;
      preview?: PreviewResult;
      provinces?: ProvincesPreview;
      terrain?: TerrainPreview;
      // 预览世界：与当前世界的差别（previewWorld）
      world?: PreviewPatch;
      doc?: WorldDoc;
      tail?: DocTail;
      thumb?: Uint8ClampedArray;
    }
  | { id: number; ok: false; error: string };
