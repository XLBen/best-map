import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import type { Visual } from '../../core/species';
import { FLASH_MS, flash, focusSpecies, sheet, world } from '../state';
import { focusOn } from './camera';
import type { SpeciesScriptKind } from './species-scripts';

// 生态编辑器（第三批）与别处接上的几个口子

// ---------- 拖花纹、发光滑块时立即看到 ----------
// 画面那边（花纹与发光的着色）装上实现：在主线程上临时换掉这种生态的外观，松手提交后再去掉（传 null）。
// 没装上时松手才提交、才看到
export type VisualOverride = (speciesId: string, visual: Visual | null) => void;
let visualOverride: VisualOverride | null = null;

export function registerVisualOverride(f: VisualOverride | null): void {
  visualOverride = f;
}

// 返回 true：地图上已经在按这个外观画
export function previewVisual(speciesId: string, visual: Visual | null): boolean {
  if (!visualOverride) return false;
  visualOverride(speciesId, visual);
  return true;
}

// ---------- 自己在编辑器里写的脚本提交了 ----------
// 信任列表那边装上：用户自己写、提交的脚本记为信任（第一次是 exec，之后是 replaceLast，两种都会报到这里）
export type ScriptCommitted = (cmd: Command) => void;
let committedHook: ScriptCommitted | null = null;

export function registerScriptCommitted(f: ScriptCommitted | null): void {
  committedHook = f;
}

export function noteScriptCommitted(cmd: Command): void {
  committedHook?.(cmd);
}

// ---------- 从别处打开某种生态的脚本框 ----------
// 比如顶部“「X」的脚本出错了 [编辑]”：打开生态抽屉、选中这种生态、展开“高级”、光标放进那个脚本框
export const scriptEditorRequest = signal<{ species: string; kind: SpeciesScriptKind } | null>(null);

export function openScriptEditor(species: string, kind: SpeciesScriptKind): void {
  focusSpecies.value = species;
  sheet.value = 'species';
  scriptEditorRequest.value = { species, kind };
}

// ---------- 地图上有一处…（点这里去看） ----------
// 镜头移到这一格，这一格和周围几格亮一下
let flashTimer: ReturnType<typeof setTimeout> | null = null;
export function showCell(cell: number): void {
  const w = world.value;
  if (!w || cell < 0 || cell >= w.mesh.n) return;
  const cells = [cell];
  for (let e = w.mesh.off[cell]; e < w.mesh.off[cell + 1]; e++) cells.push(w.mesh.adj[e]);
  focusOn(cells);
  flash.value = { cells, at: performance.now() };
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (flash.value?.cells === cells) flash.value = null;
  }, FLASH_MS);
}
