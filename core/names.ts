import { z } from 'zod';
import zhPack from './packs/zh.json';
import { mixSeed, mulberry32 } from './rng';

// 文字包：按地貌类型给出命名模板与词表，用户可以导入、导出、替换。
//   lists：词表，名字 → 若干字或词
//   types：每种地貌的模板；模板里的 {词表名} 换成该词表中的一项
//   byTag：地物带有某个情境标签（寒、热、干、湿、高、火山、大、小……）时优先用的模板
// 名字由“文字包 + 类型 + 情境 + 种子”确定性生成：同一个地物重算后名字不变。

const patternSchema = z.object({ p: z.string().min(1), w: z.number().positive().optional() });
const typeSchema = z.object({
  patterns: z.array(patternSchema).min(1),
  byTag: z.record(z.string(), z.array(patternSchema).min(1)).optional(),
});
export const wordPackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  lists: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  types: z.record(z.string(), typeSchema),
});
export type WordPack = z.output<typeof wordPackSchema>;

export const DEFAULT_PACK: WordPack = wordPackSchema.parse(zhPack);

// 检查模板里引用的词表都存在，返回问题列表（导入时提示用户）
export function packProblems(pack: WordPack): string[] {
  const problems: string[] = [];
  for (const [type, t] of Object.entries(pack.types)) {
    const all = [...t.patterns, ...Object.values(t.byTag ?? {}).flat()];
    for (const p of all) {
      for (const m of p.p.matchAll(/\{([^{}]+)\}/g)) if (!pack.lists[m[1]]) problems.push(`“${type}”的模板“${p.p}”用到了不存在的词表 {${m[1]}}`);
    }
  }
  return problems;
}

function pick<T extends { w?: number }>(items: T[], rand: () => number): T {
  let total = 0;
  for (const it of items) total += it.w ?? 1;
  let r = rand() * total;
  for (const it of items) {
    r -= it.w ?? 1;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function fill(pattern: string, pack: WordPack, rand: () => number): string {
  const used = new Set<string>();
  return pattern.replace(/\{([^{}]+)\}/g, (_, list: string) => {
    const words = pack.lists[list];
    if (!words) return '';
    // 同一个名字里尽量不重复用字
    for (let t = 0; t < 6; t++) {
      const w = words[Math.floor(rand() * words.length)];
      if (!used.has(w) || t === 5) {
        used.add(w);
        return w;
      }
    }
    return words[0];
  });
}

// 生成名字；taken 中已有的名字会避开（换几次种子）
export function generateName(pack: WordPack, type: string, tags: string[], seed: number, taken?: Set<string>): string {
  const t = pack.types[type] ?? pack.types.island ?? Object.values(pack.types)[0];
  if (!t) return '';
  for (let attempt = 0; attempt < 12; attempt++) {
    const rand = mulberry32(mixSeed(seed, attempt, 0x51ed));
    const tagged = tags.flatMap((tag) => t.byTag?.[tag] ?? []);
    const pool = tagged.length && rand() < 0.65 ? tagged : t.patterns;
    const name = fill(pick(pool, rand).p, pack, rand);
    if (!taken || !taken.has(name) || attempt === 11) {
      taken?.add(name);
      return name;
    }
  }
  return '';
}

// 字符串的稳定哈希（把“类型:锚点”变成种子）
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
