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

// ---------- 人口（第二十二轮） ----------

// 档案里的一个群体：文化 + 每一维的取值、占比（0–1）
export interface PopRow {
  culture: string;
  values: Record<string, string>;
  share: number;
}

// 档案的人口一栏 → 一行一个群体
export function popRows(p: NonNullable<CellArchive['population']>): PopRow[] {
  return p.groups.flatMap((g) => (g.culture ? [{ culture: g.culture.id, values: Object.fromEntries(g.values.map((v) => [v.dimension, v.id])), share: g.share }] : []));
}

// 写的人数：“5000”“12,000”“3.2万”“1.5 亿”；认不出时 null
export function parsePeople(text: string): number | null {
  const m = text.replace(/[,，\s]/g, '').match(/^(\d+(?:\.\d+)?)(万|亿)?(人)?$/);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1);
  return Number.isFinite(v) && v <= 1e13 ? Math.round(v) : null;
}

// 改人数（总数，成分不变）：认不出、没变时 null
export function cellTotalCommand(cell: number, text: string, before: number): Command | null {
  const v = parsePeople(text);
  if (v === null || Math.abs(v - before) < 0.5) return null;
  return { op: 'set_cell_pop', cell, total: v };
}

const tupleKey = (t: Pick<PopRow, 'culture' | 'values'>) => `${t.culture}|${JSON.stringify(Object.entries(t.values).sort())}`;

const groupsCommand = (cell: number, rows: PopRow[]): Command => ({
  op: 'set_cell_pop',
  cell,
  groups: rows.map((r) => ({ culture: r.culture, values: r.values, share: Math.round(Math.max(0, Math.min(1, r.share)) * 1000) / 1000 })),
});

// 去掉一个群体：别的按比例补上它的那一份（“其他”不变）
export function removeGroupCommand(cell: number, rows: readonly PopRow[], k: number): Command {
  const rest = rows.filter((_, j) => j !== k);
  const all = rows.reduce((a, r) => a + r.share, 0);
  const left = rest.reduce((a, r) => a + r.share, 0);
  const f = left > 0 ? all / left : 0;
  return groupsCommand(
    cell,
    rest.map((r) => ({ ...r, share: r.share * f })),
  );
}

// 加一个群体（占 share，已有的按比例让出；已经有这一群时它的占比加上去）。一格最多记 4 群：占比最小的并进“其他”
export function addGroupCommand(cell: number, rows: readonly PopRow[], tuple: Pick<PopRow, 'culture' | 'values'>, share = 0.25): Command {
  const k = rows.findIndex((r) => tupleKey(r) === tupleKey(tuple));
  const kept = rows.map((r) => ({ ...r, share: r.share * (1 - share) }));
  if (k >= 0) kept[k] = { ...kept[k], share: kept[k].share + share };
  else kept.push({ culture: tuple.culture, values: { ...tuple.values }, share });
  return groupsCommand(cell, kept.sort((a, b) => b.share - a.share).slice(0, 4));
}

// 改一个群体的占比（0–1）：别的（连同“其他”）按比例让出或补上。没变时 null
export function groupShareCommand(cell: number, rows: readonly PopRow[], k: number, share: number): Command | null {
  const s = Math.max(0, Math.min(1, share));
  if (!rows[k] || Math.abs(s - rows[k].share) < 0.005) return null;
  const others = 1 - rows[k].share;
  const f = others > 0 ? (1 - s) / others : 0;
  return groupsCommand(
    cell,
    rows.map((r, j) => ({ ...r, share: j === k ? s : r.share * f })),
  );
}
