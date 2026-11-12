/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { isolatedEngine } from './tools/isolated-engine.ts';
import { offlineFiles } from './tools/offline-plugin.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ command }) => ({
  // 打包好的程序里地址都是相对的：dist/ 放在任何子路径下都能开（第一百零一轮）。开发服务器照旧在根上
  base: command === 'build' ? './' : '/',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  // 开发时也让计算 Worker 隔离：/__map2/engine.js 是现打包的一整个引擎文件（见 tools/isolated-engine.ts）
  // 打包的最后一步：service worker 与第三方许可证（见 tools/offline-plugin.ts）
  plugins: [isolatedEngine(root), offlineFiles(root)],
  // Worker 都打包成一个文件（计算 Worker 要从 data: 地址开，加载不了别的模块）
  worker: { format: 'es', rolldownOptions: { output: { codeSplitting: false } } },
  // 地形统计测试要生成多个 4 万格的世界，几个测试文件并行时单个测试会超过默认的 5 秒
  // .claude/worktrees 里是并行改动用的 git 工作树，不在这里跑它们的测试
  test: { testTimeout: 60000, exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] },
}));
