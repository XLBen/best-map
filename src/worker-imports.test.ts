import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 第三十轮：计算 Worker 不打包内置的内容（时代、政体、文化、地名风格、城市地标、生态、基础、奇幻……都在 core/packs/ 下，
// 只在主线程用）。从 src/worker.ts 起顺着 import 走一遍（只看会留到运行时的：import type、全是 type 的花括号不算），
// 走到的文件里不能有 core/packs/ 下的

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (existsSync(p) && !p.endsWith('/')) if (/\.(ts|tsx|json)$/.test(p)) return p;
  return null;
}

// 一个文件里运行时还在的相对引用
export function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s*from\s+['"](\.{1,2}\/[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    if (m[4]) {
      out.push(m[4]);
      continue;
    }
    const clause = m[2].trim();
    if (clause.startsWith('type ')) continue;
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces && braces[1].split(',').map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith('type '))) continue;
    out.push(m[3]);
  }
  return out;
}

export function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.tsx?$/.test(f)) continue;
    for (const spec of runtimeImports(f)) {
      const r = resolveImport(f, spec);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

describe('计算 Worker 不引用内置的内容（第三十轮）', () => {
  it('从 src/worker.ts 走到的文件里没有 core/packs/ 下的', () => {
    const files = [...importGraph(resolve(root, 'src/worker.ts'))].map((f) => relative(root, f));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => f.startsWith('core/packs/'))).toEqual([]);
    // 对照：检查本身管用（主线程的资源库引用内置的树）
    expect([...importGraph(resolve(root, 'src/library.ts'))].map((f) => relative(root, f))).toContain('core/packs/builtin-tree.ts');
  });

  it('看得出只引用类型的写法', () => {
    expect(runtimeImports(resolve(root, 'core/content/missing.ts'))).toContain('../human/era');
    expect(runtimeImports(resolve(root, 'core/packs/base.ts'))).toEqual([]);
  });
});
