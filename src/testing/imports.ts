import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 测试用：读一个文件里运行时还在的相对引用（import type、全是 type 的花括号不算），顺着引用走。
// 计算 Worker 不打包内置内容（worker-imports.test.ts，第三十轮）、界面的分层（ui/layering.test.ts，第六十九轮）都用它

export function resolveImport(from: string, spec: string): string | null {
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
