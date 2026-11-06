import { signal } from '@preact/signals';
import { type PackRead, readPack } from '../../../core/packs';
import { refreshLibrary } from '../../library';
import { showToast } from '../../state';
import { ESC_RANK, pushEscape } from '../shell/escape';

// 资源库面板“⋯”里打开的弹窗的状态（PackDialog.tsx）：资源包的列表、读好的一个文件、从本世界存进资源库。
// 都是点了才开（面板的“⋯”、生态抽屉的“读文件”），不会自己弹出来。面板自己的状态在 panel-store.ts，勾选在 pick-store.ts

export type DialogView =
  // 资源包：资源库里的包（导出、删除）
  | { view: 'packs' }
  // 导入：读好的文件（只解析、检查过，没运行任何脚本）；installed：已经装进资源库
  | { view: 'import'; read: PackRead; file: string; installed?: string }
  | { view: 'export' };

export const packDialog = signal<DialogView | null>(null);
// Esc 先关它（最上面的一层）
pushEscape(ESC_RANK.packDialog, () => {
  if (!packDialog.value) return false;
  packDialog.value = null;
  return true;
});

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

// 导入生态文件：和资源包走同一条路（只解析、检查，带脚本的先问信任），只装进资源库（第二十九轮：以前的生态文件也不再整套换掉世界里的生态），
// 在面板上添加到本世界。第六十九轮从 ClimateChart.tsx 搬来
export function importBiomeFile(text: string, file: string) {
  const read = readPack(text, fileLabel(file));
  if (!read.ok) {
    showToast(`导入失败：${read.errors.slice(0, 2).join('；')}`, true);
    return;
  }
  openPackImport(read, file);
}
