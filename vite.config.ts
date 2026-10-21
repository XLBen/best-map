/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  worker: { format: 'es' },
  // 地形统计测试要生成多个 4 万格的世界，几个测试文件并行时单个测试会超过默认的 5 秒
  test: { testTimeout: 60000 },
});
