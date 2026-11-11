import type { UndoRecord } from './commands';

// 撤销记录的内存上限（第九十五轮）。
// 每一步的撤销记录里有：这一步之前的小数据（一段 JSON；内容、人口群体、国家档案按引用共用，不在这段字里）、
// 改到的格原来的值（下标 4 字节 + 值 8 字节）、换掉的自定义场。以前没有上限：每做一步多占 0.14–0.34 MB，
// 一千步就是 140–340 MB，检查点（存进浏览器）也跟着一样大。量到的数见 docs/dev/history/第95轮.md。
// 现在合计超过 UNDO_RECORD_BYTES 时，最老的几步丢掉撤销记录：命令还在（世界文件、历史照旧），只是撤销不回那么早。
// 世界本身不受影响：有上限与没上限时撤销到同一步、重做回来逐位相同（undo-budget.test.ts）

// 合计最多多少字节。按量到的每步 136 KB（一块地区）、288 KB（星球）、341 KB（带人文）：约 700、330、280 步
export const UNDO_RECORD_BYTES = 96 * 1024 * 1024;
// 最近这几步总留着（哪怕一步就超过上限）
export const UNDO_KEEP_STEPS = 8;

// 小数据那段 JSON 一个字算几个字节：里面有中文（地名、国名），V8 里这样的字符串每个字 2 字节
const CHAR_BYTES = 2;

// 一步的撤销记录占多少字节（估计；和真的内存对过，差 1%）
export function undoRecordBytes(u: UndoRecord): number {
  let b = u.small.length * CHAR_BYTES;
  for (const a of u.arrays) b += a.idx.byteLength + a.old.byteLength;
  for (const f of u.fields) if (f.old) b += f.old.byteLength;
  return b;
}

// 丢掉了撤销记录的那一步留下的：只剩这一步之前的内容（按引用共用，regen-base.ts 从历史里读“上一次生成时的内容”要用）
export function droppedUndo(u: UndoRecord): UndoRecord {
  return { small: '', arrays: [], fields: [], ...(u.content !== undefined ? { content: u.content } : {}), gone: true };
}
