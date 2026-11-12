import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 双击开启的两个文件：Windows 的 cmd 按系统的代码页（中文 Windows 是 GBK）读 .bat，而且边执行边按字节位置重读，
// 里面有中文、或者中途 chcp 换了代码页，后面的行就被切碎（cd 没执行，node 在别的目录里找 tools\launch.mjs）

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = (name: string) => readFileSync(resolve(root, name));

describe('双击开启的文件', () => {
  it('启动-Windows.bat 只有 ASCII、每行 CRLF；不换代码页；按这个文件所在的目录找 launch.mjs', () => {
    const b = bytes('启动-Windows.bat');
    expect([...b].every((c) => c < 0x80)).toBe(true);
    const text = b.toString('latin1');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(text).not.toMatch(/chcp/i);
    expect(text).toContain('cd /d "%~dp0"');
    expect(text).toContain('node "%~dp0tools\\launch.mjs"');
  });

  it('启动-Mac.command 是 LF 换行', () => {
    expect(bytes('启动-Mac.command').includes(0x0d)).toBe(false);
  });

  // 第一百零一轮：打包的最后一步多了 tools/offline-plugin.ts（service worker 的清单）和 public/（manifest、图标）——
  // 它们改了也要重新打包，所以“源码变没变”要把它们算进去
  it('launch.mjs 算“源码变没变”时带着打包用到的每一样', () => {
    const text = bytes('tools/launch.mjs').toString('utf8');
    const sources = /const SOURCES = \[(.*)\];/.exec(text)![1];
    for (const part of ["'src'", "'core'", "'index.html'", "'vite.config.ts'", "'isolated-engine.ts'", "'offline-plugin.ts'", "'public'"]) expect(sources, part).toContain(part);
    // vite.config.ts 引用的 tools/ 下的文件都在里面
    const config = bytes('vite.config.ts').toString('utf8');
    for (const m of config.matchAll(/from '\.\/tools\/([\w-]+\.ts)'/g)) expect(sources, m[1]).toContain(`'${m[1]}'`);
    // 地址还是固定的 5191，用 vite preview 开打包好的程序
    expect(text).toContain("Number(process.env.MAP2_PORT) || 5191");
    expect(text).toContain("[vite, 'preview', '--port', String(port), '--strictPort']");
  });
});
