import { type ContentKind, type ContentWorld, type FieldDesc, itemId, itemName } from '../../../core/content/registry';
import { itemErrors } from '../../../core/packs';
import { SCRIPT_API } from '../../../core/script';

// 通用编辑器（仓库里的“编辑”“新建”）的逻辑：按登记表的字段表（FieldDesc）显示哪些、改一个字段、新建与复制、
// 检查（格式、启用前的检查、不挡启用的提醒）。界面在 ContentEditor.tsx

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// 同一层里看得见的字段：when 指的那个字段等于给的值时才有（地名风格的模板式 / 音译式各有一份 lists、types）
export function shownFields(fields: readonly FieldDesc[], obj: Obj): FieldDesc[] {
  return fields.filter((f) => !f.when || obj[f.when.key] === f.when.is);
}

// 一组全是可以不写的字段、而且很多（第二十一轮：地形类别、资源的规则有十几个条件）：只列写了的，其余从“添加”里选
export const SPARSE_MIN = 7;
export function isSparse(fields: readonly FieldDesc[]): boolean {
  return fields.length >= SPARSE_MIN && fields.every((f) => f.optional);
}
// 写了的、还能加的
export function sparseSplit(fields: readonly FieldDesc[], obj: Obj): { present: FieldDesc[]; missing: FieldDesc[] } {
  return { present: fields.filter((f) => obj[f.key] !== undefined), missing: fields.filter((f) => obj[f.key] === undefined) };
}
// 从“添加”里加上的字段的初始值：开关是打开的（只写了才有意义）
export const addedValue = (f: FieldDesc): unknown => (f.type === 'bool' ? true : defaultValue(f));

// 新加一个字段（或列表里新加一项）时的样子
export function defaultValue(f: FieldDesc): unknown {
  switch (f.type) {
    case 'text':
    case 'longtext':
      return '';
    case 'number':
      return Math.min(f.max ?? 1, Math.max(f.min ?? 1, 1));
    case 'bool':
      return false;
    case 'color':
      return '#888888';
    case 'enum':
      return f.options?.[0]?.value ?? '';
    case 'tags':
    case 'weighted':
    case 'list':
      return [];
    case 'map':
      return {};
    case 'script':
      return { api: SCRIPT_API, src: '' };
    case 'json':
      return f.of ? objectOf(f.of) : [];
  }
}

// 一组字段的新对象：只填必填的
export function objectOf(fields: readonly FieldDesc[]): Obj {
  const out: Obj = {};
  for (const f of shownFields(fields, out)) if (!f.optional && !f.when) out[f.key] = defaultValue(f);
  return out;
}

// 空的（可以不写的字段空了就去掉）
export function isEmpty(v: unknown): boolean {
  return v === undefined || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
}

// 改一个字段。value 为 undefined、或可以不写的字段空了：去掉这一项。
// 改的是别的字段 when 指着的那个（地名风格的“写法”）：这时看不见的字段去掉，新看得见的必填字段补上
export function setField(fields: readonly FieldDesc[], obj: Obj, key: string, value: unknown): Obj {
  const next: Obj = { ...obj, [key]: value };
  const desc = shownFields(fields, obj).find((f) => f.key === key);
  if (value === undefined || (desc?.optional && isEmpty(value))) delete next[key];
  if (fields.some((f) => f.when?.key === key)) {
    const now = shownFields(fields, next);
    const keys = new Set(now.map((f) => f.key));
    for (const f of fields) if (f.when && !keys.has(f.key)) delete next[f.key];
    for (const f of now) if (!f.optional && next[f.key] === undefined) next[f.key] = defaultValue(f);
  }
  return next;
}

// map 里改键（顺序不变）。新键已有时不改
export function renameKey(obj: Obj, from: string, to: string): Obj {
  if (from === to || !to || to in obj) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]));
}

// map 里新加一项的键：base、base2、base3……
export function newKey(obj: Obj, base = 'new'): string {
  if (!(base in obj)) return base;
  let k = 2;
  while (`${base}${k}` in obj) k++;
  return `${base}${k}`;
}

// ---------- 几种写法的转换 ----------

// 一组字：用空格、逗号、顿号隔开
export const tagsText = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(' ') : '');
export const parseTags = (text: string): string[] => text.split(/[\s,，、]+/).filter(Boolean);

// 带权重的一组：'k' 或 ['k', 3]，编辑时是一行一项（字、权重）
export interface WeightedRow {
  text: string;
  w?: number;
}
export function weightedRows(v: unknown): WeightedRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (Array.isArray(x) ? { text: String(x[0] ?? ''), w: typeof x[1] === 'number' ? x[1] : undefined } : { text: String(x) }));
}
export const weightedValue = (rows: readonly WeightedRow[]): unknown[] => rows.map((r) => (r.w === undefined || r.w === 1 ? r.text : [r.text, r.w]));

// ---------- 检查 ----------

export interface EditorIssue {
  path: PropertyKey[];
  // 出错的地方怎么叫（“各类地物 · island · 模板 · 第 1 个 · 写法”）
  where: string;
  message: string;
}

// 出错的位置按字段表的名字说
export function pathLabel(fields: readonly FieldDesc[], obj: unknown, path: readonly PropertyKey[]): string {
  const parts: string[] = [];
  let fs: readonly FieldDesc[] | undefined = fields;
  let cur: unknown = obj;
  let desc: FieldDesc | undefined;
  for (let i = 0; i < path.length; i++) {
    const k = path[i];
    if (desc && (desc.type === 'list' || desc.type === 'weighted' || desc.type === 'tags') && typeof k === 'number') {
      parts.push(`第 ${k + 1} 个`);
      cur = Array.isArray(cur) ? cur[k] : undefined;
      if (desc.type === 'list') {
        fs = desc.of;
        desc = undefined;
      }
      continue;
    }
    if (desc && desc.type === 'map') {
      parts.push(String(k));
      cur = isObj(cur) ? cur[String(k)] : undefined;
      if (desc.of) {
        fs = desc.of;
        desc = undefined;
      } else {
        desc = desc.value;
        fs = undefined;
      }
      continue;
    }
    const f: FieldDesc | undefined = fs && isObj(cur) ? shownFields(fs, cur).find((x) => x.key === k) : fs?.find((x) => x.key === k);
    if (!f) {
      parts.push(String(k));
      cur = isObj(cur) ? cur[String(k)] : undefined;
      continue;
    }
    parts.push(f.label);
    cur = isObj(cur) ? cur[f.key] : undefined;
    desc = f;
    fs = f.type === 'json' && f.of ? f.of : undefined;
    if (fs) desc = undefined;
  }
  return parts.join(' · ');
}

// 格式、启用前的检查（不行就不能存、不能用）与提醒（不挡）
export function editorIssues(kind: ContentKind, item: unknown, world?: ContentWorld | null): { errors: EditorIssue[]; notes: string[] } {
  const errs = itemErrors(kind, item);
  const errors: EditorIssue[] = errs.map((e) => ({ path: e.path, where: pathLabel(kind.fields, item, e.path), message: e.message }));
  if (errors.length) return { errors, notes: [] };
  const parsed = kind.schema.parse(item);
  try {
    kind.check?.(parsed, world ?? { small: {} as ContentWorld['small'], causes: { fields: {} } as unknown as ContentWorld['causes'] });
  } catch (e) {
    errors.push({ path: [], where: '', message: (e as Error).message });
  }
  return { errors, notes: kind.notes?.(parsed) ?? [] };
}

// 这一处（及下面）的错
export const issuesAt = (issues: readonly EditorIssue[], path: readonly PropertyKey[]): EditorIssue[] => issues.filter((i) => path.every((k, j) => i.path[j] === k));

// ---------- 新建、复制 ----------

// 不撞 id：id、id-2、id-3……
export function freeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let k = 2;
  while (taken.has(`${base}-${k}`)) k++;
  return `${base}-${k}`;
}

// 新建：登记的空样子，id 不撞
export function blankItem(kind: ContentKind, taken: ReadonlySet<string>): Obj | null {
  const b = kind.blank?.();
  if (!isObj(b)) return null;
  const id = freeId(String(b.id ?? 'item'), taken);
  return { ...structuredClone(b), id };
}

// 复制：另起 id，名字带上编号（“西欧·日耳曼 2”）
export function copyItem(kind: ContentKind, item: unknown, taken: ReadonlySet<string>): Obj {
  const src = structuredClone(item) as Obj;
  const id = freeId(itemId(kind, item), new Set([...taken, itemId(kind, item)]));
  const k = id.slice(itemId(kind, item).length + 1) || '2';
  const name = itemName(kind, item);
  return { ...src, id, ...(typeof src.name === 'string' ? { name: `${name.slice(0, 40)} ${k}` } : {}) };
}

// ---------- 称号（第二十三轮：政体的国家称号、统治者称号） ----------
// 写法有三种（一个字符串、{zh, orig}、按文化换说法的表），编辑器里一律是一行一种：键（default、文化 id、文化组 id）、中文、原文。
// 只有 default 一行时存回最简单的写法。登记表里这两个字段是 json，界面按 key 认出来换成这种编辑器

export interface TitleRow {
  key: string;
  zh: string;
  orig: string;
}

export const isTitleField = (f: Pick<FieldDesc, 'type' | 'key' | 'of'>) => f.type === 'json' && !f.of && (f.key === 'title' || f.key === 'rulerTitle');

export function titleRows(v: unknown): TitleRow[] {
  const one = (key: string, x: unknown): TitleRow => (typeof x === 'string' ? { key, zh: x, orig: '' } : isObj(x) ? { key, zh: String(x.zh ?? ''), orig: String(x.orig ?? '') } : { key, zh: '', orig: '' });
  if (v === undefined || v === null) return [];
  if (typeof v === 'string' || (isObj(v) && 'zh' in v)) return [one('default', v)];
  return isObj(v) ? Object.entries(v).map(([k, x]) => one(k, x)) : [];
}

// 空着中文、空着键的行去掉；一行都没有时 undefined
export function titleValue(rows: readonly TitleRow[]): unknown {
  const ok = rows.filter((r) => r.zh.trim() && r.key.trim());
  const one = (r: TitleRow) => (r.orig.trim() ? { zh: r.zh.trim(), orig: r.orig.trim() } : r.zh.trim());
  if (!ok.length) return undefined;
  if (ok.length === 1 && ok[0].key.trim() === 'default') return one(ok[0]);
  return Object.fromEntries(ok.map((r) => [r.key.trim(), one(r)]));
}
