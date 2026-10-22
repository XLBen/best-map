import type { Command } from '../core/commands';
import type { DocTail, PreviewResult, Timings, WorldDoc } from '../core/engine';
import type { ExportOptions } from '../core/export';
import type { WorldgenInput } from '../core/generate';
import type { TerrainPatch, TerrainPreview } from '../core/terrain';
import type { GeoFeature } from '../core/features';
import type { Causes, Derived, Settings, SmallState } from '../core/world';

// 主线程与计算 Worker 之间的消息

export type Request =
  | { kind: 'init'; settings: Partial<Settings>; commands?: Command[] }
  | { kind: 'load'; doc: WorldDoc }
  | { kind: 'exec'; cmd: Command }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'preview'; cmd: Command }
  // “调整”面板拖滑块时：只组合地形，返回陆海的变化
  | { kind: 'previewTerrain'; patch: TerrainPatch }
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

export type Response =
  | {
      id: number;
      ok: true;
      summary?: string;
      // 命令什么都没改：没有快照，也没有进历史
      noop?: boolean;
      snapshot?: Snapshot | LightSnapshot;
      preview?: PreviewResult;
      terrain?: TerrainPreview;
      doc?: WorldDoc;
      tail?: DocTail;
      thumb?: Uint8ClampedArray;
    }
  | { id: number; ok: false; error: string };
