import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importGraph, runtimeImports } from './testing/imports';

// 第三十轮：计算 Worker 不打包内置的内容（时代、政体、文化、地名风格、城市地标、生态、基础、奇幻……都在 core/packs/ 下，
// 只在主线程用）。从 src/worker.ts 起顺着 import 走一遍（只看会留到运行时的：import type、全是 type 的花括号不算），
// 走到的文件里不能有 core/packs/ 下的

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 读引用的写法在 testing/imports.ts（第六十九轮分出来，界面的分层测试也用）

describe('计算 Worker 不引用内置的内容（第三十轮）', () => {
  it('从 src/worker.ts 走到的文件里没有 core/packs/ 下的', () => {
    const files = [...importGraph(resolve(root, 'src/worker.ts'))].map((f) => relative(root, f));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => f.startsWith('core/packs/'))).toEqual([]);
    // 第四十九轮：引用表也在 Worker 这边（整理本世界用），不带内置的数据
    expect(files).toContain('core/content/links.ts');
    // 对照：检查本身管用（主线程的资源库引用内置的树）
    expect([...importGraph(resolve(root, 'src/library.ts'))].map((f) => relative(root, f))).toContain('core/packs/builtin-tree.ts');
  });

  it('看得出只引用类型的写法', () => {
    expect(runtimeImports(resolve(root, 'core/content/missing.ts'))).toContain('../human/era');
    expect(runtimeImports(resolve(root, 'core/packs/base.ts'))).toEqual([]);
  });
});
