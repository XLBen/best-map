import { type Obj, isObj } from './fields';

// 倾向的表（第四十五轮）：文化组、文化的 tendencies（维度 → 取值与权重）与 eraTendencies（时代 → 维度 → 取值与权重）
// 在资源库里画成一张表：表上面选“不分时代”或某个时代，行是维度，每行是几个取值、各自的权重。
// 取值与权重的写法同 core 的 weightedIds：'a'（权重 1）或 ['a', 3]。不碰界面，测试直接调

export interface TendencyEntry {
  id: string;
  w: number;
}
export interface TendencyRow {
  dim: string;
  entries: TendencyEntry[];
}

// 选的是哪一份：null 是不分时代的
export type EraKey = string | null;

const entryOf = (x: unknown): TendencyEntry | null => {
  if (typeof x === 'string') return { id: x, w: 1 };
  if (Array.isArray(x) && typeof x[0] === 'string') return { id: x[0], w: typeof x[1] === 'number' ? x[1] : 1 };
  return null;
};
const valueOf = (e: TendencyEntry): unknown => (e.w === 1 ? e.id : [e.id, e.w]);

// 一份倾向（维度 → 取值与权重）的行
export function tendencyRows(table: unknown): TendencyRow[] {
  if (!isObj(table)) return [];
  return Object.entries(table).map(([dim, list]) => ({ dim, entries: Array.isArray(list) ? list.map(entryOf).filter((e): e is TendencyEntry => e !== null) : [] }));
}

// 行 → 一份倾向（先后不变）
export function tendencyTable(rows: readonly TendencyRow[]): Obj {
  return Object.fromEntries(rows.map((r) => [r.dim, r.entries.map(valueOf)]));
}

// 选的那一份
export function tableAt(obj: Obj, era: EraKey): Obj {
  if (era === null) return isObj(obj.tendencies) ? obj.tendencies : {};
  const by = isObj(obj.eraTendencies) ? obj.eraTendencies : {};
  return isObj(by[era]) ? by[era] : {};
}

// 换掉选的那一份；空了的去掉（时代的一份空了去掉这个时代，整个空了去掉字段）
export function withTable(obj: Obj, era: EraKey, table: Obj): Obj {
  const next: Obj = { ...obj };
  const empty = !Object.keys(table).length;
  if (era === null) {
    if (empty) delete next.tendencies;
    else next.tendencies = table;
    return next;
  }
  const by: Obj = { ...(isObj(obj.eraTendencies) ? obj.eraTendencies : {}) };
  if (empty) delete by[era];
  else by[era] = table;
  if (Object.keys(by).length) next.eraTendencies = by;
  else delete next.eraTendencies;
  return next;
}

// 写了按时代倾向的时代（按写的先后）
export const erasWritten = (obj: Obj): string[] => (isObj(obj.eraTendencies) ? Object.keys(obj.eraTendencies) : []);

// ---------- 改一处：都返回整个对象 ----------

function editRows(obj: Obj, era: EraKey, fn: (rows: TendencyRow[]) => TendencyRow[]): Obj {
  return withTable(obj, era, tendencyTable(fn(tendencyRows(tableAt(obj, era)))));
}

// 加一维（已有时不变）：先空着，再往里加取值
export const addDim = (obj: Obj, era: EraKey, dim: string): Obj => editRows(obj, era, (rows) => (rows.some((r) => r.dim === dim) ? rows : [...rows, { dim, entries: [] }]));

export const removeDim = (obj: Obj, era: EraKey, dim: string): Obj => editRows(obj, era, (rows) => rows.filter((r) => r.dim !== dim));

// 这一维加一个取值（已有时不变），权重 1
export const addValue = (obj: Obj, era: EraKey, dim: string, id: string): Obj =>
  editRows(obj, era, (rows) => {
    const has = rows.some((r) => r.dim === dim);
    const list = has ? rows : [...rows, { dim, entries: [] }];
    return list.map((r) => (r.dim === dim && !r.entries.some((e) => e.id === id) ? { ...r, entries: [...r.entries, { id, w: 1 }] } : r));
  });

export const removeValue = (obj: Obj, era: EraKey, dim: string, id: string): Obj =>
  editRows(obj, era, (rows) => rows.map((r) => (r.dim === dim ? { ...r, entries: r.entries.filter((e) => e.id !== id) } : r)));

// 权重（0–1000，不是数时不改）
export const setWeight = (obj: Obj, era: EraKey, dim: string, id: string, w: number): Obj =>
  Number.isFinite(w) ? editRows(obj, era, (rows) => rows.map((r) => (r.dim === dim ? { ...r, entries: r.entries.map((e) => (e.id === id ? { ...e, w: Math.max(0, Math.min(1000, w)) } : e)) } : r))) : obj;

// 这一维里各取值占多少（权重的比例，0–1；表里每一项旁边写百分比）
export function shares(row: TendencyRow): number[] {
  const sum = row.entries.reduce((a, e) => a + e.w, 0);
  return row.entries.map((e) => (sum > 0 ? e.w / sum : 0));
}
