import { signal } from '@preact/signals';
import type { ScriptKind } from '../../core/script';
import type { Visual } from '../../core/species';
import { flashCells, focusSpecies, sheet, world } from '../state';
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
// 信任列表那边装上：用户自己写、提交的脚本记为信任（第一次是 exec，之后是 replaceLast，两种都会报到这里）。
// 只报框里写的这一段：同一条命令里整份带着的另一段脚本、出错后换回的旧写法都不报
// （“不运行脚本打开”别人的世界、改了其中一段时，另一段别人的脚本不能顺带被信任）。src 为 '' 表示去掉了这段。
// before：提交之前世界上的这一段；mode：新的一步（exec）还是换掉最后一步（replace）。信任列表据此去掉
// 同一步里被换掉的中间版本（见 trust.ts 的 trustDraft）
export type CommittedScript = { species: string; kind: ScriptKind; src: string; before: string; mode: 'exec' | 'replace' };
export type ScriptCommitted = (s: CommittedScript) => void;
let committedHook: ScriptCommitted | null = null;

export function registerScriptCommitted(f: ScriptCommitted | null): void {
  committedHook = f;
}

export function noteScriptCommitted(s: CommittedScript): void {
  committedHook?.(s);
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
// 镜头移到这一格，这一格和周围几格亮一下（顶部出错的提示条也用它）
export function showCell(cell: number): void {
  const w = world.value;
  if (!w || cell < 0 || cell >= w.mesh.n) return;
  const cells = [cell];
  for (let e = w.mesh.off[cell]; e < w.mesh.off[cell + 1]; e++) cells.push(w.mesh.adj[e]);
  focusOn(cells);
  flashCells(cells);
}
