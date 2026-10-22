import { signal } from '@preact/signals';
import type { PlanetForm } from '../../core/planet-form';
import type { Settings } from '../../core/world';

// 星球形态编辑器（向导里形态卡片上的“编辑…”、“自己做一个…”打开）：点了才开，不自己弹出

export interface FormEditorState {
  // 第几次打开（换一个就是新的编辑器）
  id: number;
  // 打开时的形态
  initial: PlanetForm;
  // 改的是哪一个（自己做一个时为 null）：没改过时用的就是它本身
  original: PlanetForm | null;
  // 它在列表里的键（没改过就点“存进资源库”时选上它，不再存一份一模一样的）
  originalKey: string | null;
  // 改的是“我的资源”里的：存进去替换原来的（不另起 id）
  mine: boolean;
  // 列表里别的形态（另起 id、名字时避开）
  others: readonly PlanetForm[];
  // 缩略图用的星球设置（少量的格）与星球半径（“每块约 4800 公里宽”）
  settings: Partial<Settings>;
  radiusKm: number;
  seed: number;
  // 存进资源库了（key：它在列表里的键；没改过时是原来那一个的键）
  onSaved(form: PlanetForm, key: string): void;
  // 用它新建：做成了返回 true
  onCreate(form: PlanetForm, seed: number): Promise<boolean>;
}

export const formEditor = signal<FormEditorState | null>(null);

let opened = 0;
export function openFormEditor(st: Omit<FormEditorState, 'id'>) {
  formEditor.value = { ...st, id: ++opened };
}

export function closeFormEditor() {
  formEditor.value = null;
}
