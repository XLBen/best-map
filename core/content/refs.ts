import { VARIABLES, codeOnly } from '../script';
import type { Species } from '../species';

// 内容之间的引用（从 packs.ts 拆出来，content/kinds.ts 与 packs.ts 共用）：脚本里的 field('x')、river('x')……、
// 耐受条件里的 field:x、river:x、lake:x，改名时跟着改；两项是不是一模一样

export const ITEM_ID = /^[\w-]+$/;

// 键排好序的 JSON：比较两项是不是一模一样（键的顺序不算）
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

export function sameItem(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

// 没写“自然生成”的写成 false（写了的照旧）
export function naturalOff<T extends object>(x: T): T {
  return (x as { natural?: boolean }).natural === undefined ? { ...x, natural: false } : x;
}

// ---------- 脚本里的引用：field('x')、river('x')、hasRiver('x')、nearLake('x')、hasLake('x') ----------

const VAR_NAMES = new Set(VARIABLES.flatMap((v) => (v.zh ? [v.key, v.zh] : [v.key])));
const CALL_RE = /(?<![\p{L}\p{N}_$.])(field|river|hasRiver|nearLake|hasLake)\s*\(/gu;
const RIVER_FNS = new Set(['river', 'hasRiver']);
const LAKE_FNS = new Set(['nearLake', 'hasLake']);

export interface Ref {
  // river、hasRiver 引用河流类型；nearLake、hasLake 引用湖泊类型
  fn: 'field' | 'river' | 'hasRiver' | 'nearLake' | 'hasLake';
  name: string;
  // 名字在源码里的位置（不含引号）
  start: number;
  end: number;
}

// 源码里 field('x')、river('x')、hasRiver('x') 的字面量参数（只看代码，注释里的不算；参数不是字面量的找不到，不报）
export function scriptRefs(src: string): Ref[] {
  const code = codeOnly(src);
  const out: Ref[] = [];
  for (const m of code.matchAll(CALL_RE)) {
    let at = m.index + m[0].length;
    while (at < src.length && /\s/.test(src[at])) at++;
    const q = src[at];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    const end = src.indexOf(q, at + 1);
    if (end < 0) continue;
    const name = src.slice(at + 1, end);
    if (name.includes('${') || name.includes('\n')) continue;
    out.push({ fn: m[1] as Ref['fn'], name, start: at + 1, end });
  }
  return out;
}

// 一种生态（或河流类型）写到的自定义场的名字：耐受条件里的 field:x，脚本里的 field('x')（内置变量的名字不算）。可能有不合规的名字
export function fieldRefs(sp: Pick<Species, 'scripts'> & { tolerances?: Species['tolerances'] }): string[] {
  const out = new Set<string>();
  for (const t of sp.tolerances ?? []) if (t.field.startsWith('field:')) out.add(t.field.slice(6));
  for (const s of Object.values(sp.scripts ?? {})) {
    if (!s) continue;
    for (const r of scriptRefs(s.src)) if (r.fn === 'field' && !VAR_NAMES.has(r.name)) out.add(r.name);
  }
  return [...out];
}

// 一种生态用到的自定义场（只算合规的名字：别的名字世界里不会有这个场，加也加不了，脚本照“出错”处理）
export function biomeFields(sp: Species): string[] {
  return fieldRefs(sp).filter((f) => ITEM_ID.test(f));
}

// 一种生态的脚本、耐受条件（river:x，“靠近某种河”）里用到的河流类型
export function biomeRivers(sp: Species): string[] {
  const out = new Set<string>();
  for (const t of sp.tolerances) if (t.field.startsWith('river:')) out.add(t.field.slice(6));
  for (const s of Object.values(sp.scripts ?? {})) if (s) for (const r of scriptRefs(s.src)) if (RIVER_FNS.has(r.fn)) out.add(r.name);
  return [...out];
}

// 一种生态的脚本、耐受条件（lake:x，“靠近某种湖”）里用到的湖泊类型
export function biomeLakes(sp: Species): string[] {
  const out = new Set<string>();
  for (const t of sp.tolerances) if (t.field.startsWith('lake:')) out.add(t.field.slice(5));
  for (const s of Object.values(sp.scripts ?? {})) if (s) for (const r of scriptRefs(s.src)) if (LAKE_FNS.has(r.fn)) out.add(r.name);
  return [...out];
}

// 把源码里 river('旧')、hasRiver('旧')（以及 nearLake('旧')、hasLake('旧')，按 lakes）换成新的（只换代码里的字面量）
export function rewriteRiverRefs(src: string, rivers: ReadonlyMap<string, string>, lakes: ReadonlyMap<string, string> = new Map()): string {
  if (!rivers.size && !lakes.size) return src;
  let out = src;
  for (const r of scriptRefs(src).reverse()) {
    const to = RIVER_FNS.has(r.fn) ? rivers.get(r.name) : LAKE_FNS.has(r.fn) ? lakes.get(r.name) : undefined;
    if (to !== undefined && to !== r.name) out = out.slice(0, r.start) + to + out.slice(r.end);
  }
  return out;
}

// 模板里用到的词表名：{xxx}
export function templateLists(p: string): string[] {
  return [...p.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}
