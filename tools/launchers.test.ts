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
});
