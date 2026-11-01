import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHADER_PROGRAMS } from './renderer';

// 第四十一轮：着色器源码搬到 src/render/shaders/ 时逐字节不变。shader-hashes.json 是搬之前（086a66c）记下的每个程序源码的 sha256；
// 改着色器的轮次照常改源码，然后 RECORD_SHADERS=1 npx vitest run src/render/shader-sources.test.ts 重记
const FILE = new URL('./shaders/shader-hashes.json', import.meta.url);

describe('着色器源码', () => {
  it('每个程序的源码与记下的 sha256 相同', () => {
    const now: Record<string, string> = {};
    for (const [k, v] of Object.entries(SHADER_PROGRAMS)) now[k] = createHash('sha256').update(v).digest('hex');
    if (process.env.RECORD_SHADERS) writeFileSync(FILE, `${JSON.stringify(now, null, 1)}\n`);
    const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
    expect(now).toEqual(saved);
  });
});
