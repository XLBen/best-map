import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 隔离的静态检查（看源码，不运行）：
//   计算 Worker（连同它引用的全部模块）不碰 IndexedDB —— 隔离的环境里打不开，检查点交给存储 Worker；
//   只有自查用的 isolation-probe.ts 试着打开一下；也不用 import.meta（data: 地址开的 Worker 没有自己的文件地址）；
//   存储 Worker 不引用运行脚本的模块（它与页面同源，能读写全部存档，绝不能跑用户的代码）

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 只用作类型的引用（import type、export type、花括号里每一项都带 type）：打包后不在里面
function typeOnly(clause: string): boolean {
  if (/^\s*type\s/.test(clause)) return true;
  if (!/^\s*\{[^}]*\}\s*$/.test(clause)) return false;
  const items = clause.replace(/[{}]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  return items.length > 0 && items.every((x) => x.startsWith('type '));
}

// 从 entry 起，相对路径引用到的 .ts 文件（看 import/export … from '…' 和 import '…'）。
// values：只跟着值引用走（打包后真的在里面的）；否则类型引用也算（宁多勿少）
function graph(entry: string, values = false): string[] {
  const seen = new Set<string>();
  const stack = [resolve(root, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b([^'";]*?)(?:from\s*)?['"](\.{1,2}\/[^'"?]+)['"]/g)) {
      if (values && typeOnly(m[1])) continue;
      const base = resolve(dirname(file), m[2]);
      const hit = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find((p) => existsSync(p) && /\.tsx?$/.test(p));
      if (hit) stack.push(hit);
    }
  }
  return [...seen].map((f) => relative(root, f)).sort();
}

// 用到（读属性、调用）IndexedDB 和别的存储才算；core/script.ts 里遮住全局名字的那张表只是写着这些名字
const STORAGE_USE = /\bindexedDB\s*[.?[]|\.indexedDB\b|\bidb(?:Tx|Get|All)\s*[(<]|\bopenDb\s*\(|\bkv(?:Get|Put|Delete)\s*[(<]|\bcaches\s*\.|\blocalStorage\s*\./;

describe('隔离的静态检查', () => {
  it('计算 Worker 的模块不碰 IndexedDB（只有自查的那一处），也不用 import.meta', () => {
    const files = graph('src/worker.ts');
    // 确实走遍了引擎
    expect(files).toContain('core/engine.ts');
    expect(files).toContain('core/script.ts');
    expect(files).toContain('src/isolation-probe.ts');
    expect(files).not.toContain('src/idb.ts');
    expect(files).not.toContain('src/state.ts');
    for (const f of files) {
      if (f === 'src/isolation-probe.ts') continue;
      expect(readFileSync(resolve(root, f), 'utf8'), f).not.toMatch(STORAGE_USE);
    }
    // 对照：主线程、存储 Worker 确实用这些名字（检查本身管用）
    expect(readFileSync(resolve(root, 'src/storage-worker.ts'), 'utf8')).toMatch(STORAGE_USE);
    expect(readFileSync(resolve(root, 'src/idb.ts'), 'utf8')).toMatch(STORAGE_USE);
    // 自查只打开一个试用的库（不碰存档）
    expect(readFileSync(resolve(root, 'src/isolation-probe.ts'), 'utf8')).not.toMatch(/['"]map2['"]/);
    expect(readFileSync(resolve(root, 'src/worker.ts'), 'utf8')).not.toMatch(/import\.meta/);
  });

  it('存储 Worker 不引用运行脚本的模块（core 里的只用作类型）', () => {
    expect(graph('src/storage-worker.ts', true)).toEqual(['src/checkpoint-store.ts', 'src/idb.ts', 'src/storage-worker.ts', 'src/transfer.ts']);
    // 对照：计算 Worker 按值引用了运行脚本的模块
    expect(graph('src/worker.ts', true)).toContain('core/script.ts');
  });
});
