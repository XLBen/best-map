import { signal } from '@preact/signals';
import type { PackRead } from '../../../core/packs';
import { refreshLibrary } from '../../library';
import type { Obj } from './fields';
import type { RepoFilter } from './repo';

// 仓库的界面状态：浮在地图左边的仓库（按类列出内容、开关、编辑），和角落“⋯”里打开的弹窗（导入文件、从世界存进仓库、资源包）。
// 都是点了才开（世界菜单的“仓库…”、生态抽屉的“示例生态…”、地名里的“仓库…”、导入文件），不会自己弹出来

// 编辑器：改的是哪一项（新建、复制的没有 origin；改的是世界里的一项时 worldId 是它在世界里的 id）
export interface RepoEdit {
  item: Obj;
  how: 'new' | 'copy' | 'edit';
  worldId?: string;
}

export interface RepoState {
  // 左边选着的一类（登记表里的 id）
  kind: string;
  filter: RepoFilter;
  query: string;
  // 只看一个包（资源库里的键：刚导入的包“用到世界”）
  entry?: string;
  edit?: RepoEdit;
}

export const repo = signal<RepoState | null>(null);

export function openRepo(st: Partial<RepoState> = {}) {
  void refreshLibrary();
  packDialog.value = null;
  repo.value = { kind: repo.value?.kind ?? 'nameStyle', filter: 'all', query: '', ...st };
}

export const closeRepo = () => (repo.value = null);

export function patchRepo(patch: Partial<RepoState>) {
  if (repo.value) repo.value = { ...repo.value, ...patch };
}

export type DialogView =
  // 资源包：资源库里的包（导出、删除）
  | { view: 'packs' }
  // 导入：读好的文件（只解析、检查过，没运行任何脚本）；installed：已经装进资源库
  | { view: 'import'; read: PackRead; file: string; installed?: string }
  | { view: 'export' };

export const packDialog = signal<DialogView | null>(null);

export function openPackList() {
  void refreshLibrary();
  packDialog.value = { view: 'packs' };
}

// 文件名去掉 .map2pack.json、.json：旧的生态文件没有名字，用它
export const fileLabel = (name: string) => name.replace(/(\.map2pack)?\.json$/i, '');

// 导入一个读好的文件（资源包，或旧的生态、文字包文件）：列出内容、问题和脚本，等用户确认
export function openPackImport(read: PackRead, file: string) {
  void refreshLibrary();
  packDialog.value = { view: 'import', read, file };
}
