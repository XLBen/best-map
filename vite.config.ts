/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { isolatedEngine } from './tools/isolated-engine.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  // 开发时也让计算 Worker 隔离：/__map2/engine.js 是现打包的一整个引擎文件（见 tools/isolated-engine.ts）
  plugins: [isolatedEngine(root)],
  // Worker 都打包成一个文件（计算 Worker 要从 data: 地址开，加载不了别的模块）
  worker: { format: 'es', rolldownOptions: { output: { codeSplitting: false } } },
  // 地形统计测试要生成多个 4 万格的世界，几个测试文件并行时单个测试会超过默认的 5 秒
  // .claude/worktrees 里是并行改动用的 git 工作树，不在这里跑它们的测试
  test: { testTimeout: 60000, exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] },
});
