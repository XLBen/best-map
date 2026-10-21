import type { Command } from '../core/commands';
import type { PreviewResult, Timings, WorldDoc } from '../core/engine';
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
  | { kind: 'export'; opts: ExportOptions }
  | { kind: 'doc' }
  // 新建向导：用少量格子快速生成几张缩略图
  | { kind: 'thumbs'; settings: Partial<Settings>; gens: WorldgenInput[]; width: number; height: number };

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

export type Response =
  | {
      id: number;
      ok: true;
      summary?: string;
      snapshot?: Snapshot | LightSnapshot;
      preview?: PreviewResult;
      terrain?: TerrainPreview;
      zip?: Uint8Array;
      doc?: WorldDoc;
      thumbs?: Uint8ClampedArray[];
    }
  | { id: number; ok: false; error: string };
