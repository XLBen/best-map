import type { Command } from '../../core/commands';
import type { CellArchive } from '../../core/human';

// 格的档案（第二十一轮）：卡片里改名字、换一个、恢复自动、地形类别、资源、备注发出的命令。
// 山脉的主峰（archive.feature）名字是地物的：改名、换一个、恢复自动走地物的命令（rename_feature、reroll_feature）

type Named = Pick<CellArchive, 'cell' | 'name' | 'orig' | 'custom' | 'feature'>;

// 改名（原文可以不写：只改中文名时原文去掉）。名字没变时 null
export function renameCommand(a: Named, name: string, orig = ''): Command | null {
  const zh = name.trim();
  const o = orig.trim();
  if (!zh || (zh === a.name && o === (a.orig ?? '') && a.custom)) return null;
  if (a.feature) return { op: 'rename_feature', key: a.feature, name: zh, ...(o ? { orig: o } : {}) };
  return { op: 'set_cell', cell: a.cell, name: zh, ...(o ? { orig: o } : {}) };
}

// 换一个自动的名字
export function rerollCommand(a: Named): Command {
  return a.feature ? { op: 'reroll_feature', key: a.feature } : { op: 'set_cell', cell: a.cell, reroll: true };
}

// 恢复自动：不用自己起的名字，也不用换过的（盐回到 0）。salt：这一格存着的盐。已经是自动的、没换过时 null
export function autoNameCommand(a: Named, salt = 0): Command | null {
  if (a.feature) return a.custom ? { op: 'rename_feature', key: a.feature, name: '' } : null;
  if (!a.custom && !salt) return null;
  return { op: 'batch', label: '名字恢复自动', commands: [{ op: 'set_cell', cell: a.cell, name: null, salt: 0 }] };
}

// 地形类别：id，null 恢复自动
export const cellClassCommand = (cell: number, id: string | null): Command => ({ op: 'set_cell_class', cells: [cell], class: id });

// 资源：id，'none' 无，null 恢复自动
export const cellResourceCommand = (cell: number, id: string | null): Command => ({ op: 'set_cell_resource', cells: [cell], resource: id });

// 备注：没变时 null，空了是删除
export function noteCommand(cell: number, text: string, before: string | undefined): Command | null {
  const t = text.trim();
  if (t === (before ?? '')) return null;
  return { op: 'set_cell', cell, note: t || null };
}
