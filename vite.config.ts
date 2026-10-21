/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  worker: { format: 'es' },
  // 地形统计测试要生成多个 4 万格的世界，几个测试文件并行时单个测试会超过默认的 5 秒
  // .claude/worktrees 里是并行改动用的 git 工作树，不在这里跑它们的测试
  test: { testTimeout: 60000, exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] },
});
