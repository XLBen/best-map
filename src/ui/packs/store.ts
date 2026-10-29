import { signal } from '@preact/signals';
import type { PackRead } from '../../../core/packs';
import { refreshLibrary } from '../../library';
import type { Obj } from './fields';
import type { RepoFilter } from './repo';

// 资源库的界面状态：浮在地图左边的资源库（第二十九轮：两栏，本世界 | 资源库，都按资源包分组；顶上筛种类、搜索），
// 和角落“⋯”里打开的弹窗（导入文件、从世界存进资源库、资源包）。
// 都是点了才开（世界菜单的“资源库…”、生态抽屉的“示例生态…”、地名里的“资源库…”、导入文件），不会自己弹出来

// 编辑器：改的是哪一项（新建、复制的没有 origin；改的是世界里的一项时 worldId 是它在世界里的 id）
export interface RepoEdit {
  item: Obj;
  how: 'new' | 'copy' | 'edit';
  worldId?: string;
  // 哪一种（第二十九轮：种类筛成“全部”时也能编辑；省略时按 RepoState.kind）
  kind?: string;
}

export interface RepoState {
  // 筛的种类（登记表里的 id；'all' 是全部种类）
  kind: string;
  // 'off'：资源库一栏只列不在本世界的（工具里的“从资源库添加…”）；别的值都列全部
  filter: RepoFilter;
  query: string;
  // 资源库一栏只看一个包（资源库里的键：刚导入的包、生态抽屉的“示例生态…”），展开着
  entry?: string;
  edit?: RepoEdit;
}

export const repo = signal<RepoState | null>(null);

export function openRepo(st: Partial<RepoState> = {}) {
  void refreshLibrary();
  packDialog.value = null;
  repo.value = { kind: repo.value?.kind ?? 'all', filter: 'all', query: '', ...st };
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
