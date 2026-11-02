import { VARIABLES, codeOnly } from '../script';
import type { ContentKind } from './registry';

// 引用的底层小工具（从 packs.ts 拆出来）：脚本里的 field('x')、river('x')……在源码里的位置；两项是不是一模一样。
// 一项内容引用了什么、谁引用它、改名时怎么跟着改，都在 links.ts（第四十九轮）

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

// 同一种内容里的两项算不算“同一项”（第四十九轮）：比较时不看这一种写的 pack.sameIgnore（顶层的键）。
// 同一项在不同的库里只差权重时算同一项，导入时不改名（第五十轮的 cultureGroup.weight 写在那里）
export function sameContent(kind: Pick<ContentKind, 'pack'>, a: unknown, b: unknown): boolean {
  const skip = kind.pack.sameIgnore;
  if (!skip?.length) return sameItem(a, b);
  const bare = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([k]) => !skip.includes(k))) : x);
  return sameItem(bare(a), bare(b));
}

// 没写“自然生成”的写成 false（写了的照旧）
export function naturalOff<T extends object>(x: T): T {
  return (x as { natural?: boolean }).natural === undefined ? { ...x, natural: false } : x;
}

// ---------- 脚本里的引用：field('x')、river('x')、hasRiver('x')、nearLake('x')、hasLake('x')、biome('x') ----------

const VAR_NAMES = new Set(VARIABLES.flatMap((v) => (v.zh ? [v.key, v.zh] : [v.key])));
// 内置变量的名字：field('tMean') 不是自定义场
export const isScriptVariable = (name: string): boolean => VAR_NAMES.has(name);
const CALL_RE = /(?<![\p{L}\p{N}_$.])(field|river|hasRiver|nearLake|hasLake|biome)\s*\(/gu;
// 河、湖的 match 脚本里拿生态的 id 比：dominantBiome() === 'x'（字面量在右边的才找得到）
const COMPARE_RE = /(?<![\p{L}\p{N}_$.])(?:dominantBiome|biomeAtSource|biomeAtMouth)\s*\(\s*\)\s*[!=]==?\s*/gu;

export interface Ref {
  // river、hasRiver 引用河流类型；nearLake、hasLake 引用湖泊类型；biome（以及和 dominantBiome() 比的字面量）引用生态
  fn: 'field' | 'river' | 'hasRiver' | 'nearLake' | 'hasLake' | 'biome';
  name: string;
  // 名字在源码里的位置（不含引号）
  start: number;
  end: number;
}

// 源码里这些写法的字面量参数（只看代码，注释里的不算；参数不是字面量的找不到，不报）。按在源码里的先后
export function scriptRefs(src: string): Ref[] {
  const code = codeOnly(src);
  const out: Ref[] = [];
  const literal = (fn: Ref['fn'], from: number) => {
    let at = from;
    while (at < src.length && /\s/.test(src[at])) at++;
    const q = src[at];
    if (q !== "'" && q !== '"' && q !== '`') return;
    const end = src.indexOf(q, at + 1);
    if (end < 0) return;
    const name = src.slice(at + 1, end);
    if (name.includes('${') || name.includes('\n')) return;
    out.push({ fn, name, start: at + 1, end });
  };
  for (const m of code.matchAll(CALL_RE)) literal(m[1] as Ref['fn'], m.index + m[0].length);
  for (const m of code.matchAll(COMPARE_RE)) literal('biome', m.index + m[0].length);
  return out.sort((x, y) => x.start - y.start);
}

// 模板里用到的词表名：{xxx}
export function templateLists(p: string): string[] {
  return [...p.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}
