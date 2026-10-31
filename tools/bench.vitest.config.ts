/// <reference types="vitest/config" />
// 在 vitest 里跑的测速（要 Vite 才认的写法——界面的状态模块引了引擎的地址——tsx 跑不了）：npx vitest run -c tools/bench.vitest.config.ts
// 只跑 tools/bench-*.vitest.ts，不进平常的测试
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

export default mergeConfig(base, defineConfig({ test: { include: ['tools/bench-*.vitest.ts'], testTimeout: 600000 } }));
