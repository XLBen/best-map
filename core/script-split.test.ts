import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveImport, runtimeImports } from '../src/testing/imports';
import * as script from './script';

// 第一百零一轮：core/script.ts（1878 行）按职责拆进 core/script/ 下，原样搬（函数体一个字没动），core/script.ts 照旧导出全部。
// 这里钉着：导出的名字和拆之前一个不多一个不少；入口里只有导出；新文件都不大、互相不绕成圈

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// 拆之前 core/script.ts 导出的全部名字（值和类型），按字母排
const EXPORTS = [
  'BiomeInputs', 'CellKind', 'CellOutputs', 'CellResult', 'CompiledScript', 'CrustOutput', 'FoundScript', 'InputValue', 'MAX_SCRIPT_CHARS',
  'MatchScope', 'ParamMode', 'PurityResult', 'RunOptions', 'SCRIPT_API', 'SCRIPT_HELPERS', 'SCRIPT_HELPER_NAMES', 'SCRIPT_KINDS', 'SCRIPT_KIND_LABEL',
  'Script', 'ScriptError', 'ScriptHost', 'ScriptInputs', 'ScriptIssue', 'ScriptKind', 'ScriptParam', 'ScriptVariable', 'Scripts', 'SetupResult',
  'VARIABLES', 'arrayInputs', 'blockedNameText', 'checkPurity', 'codeOnly', 'compileScript', 'disallowScripts', 'findScripts', 'incrementalDistance',
  'runScript', 'runSetup', 'scriptHash', 'scriptStats', 'scriptVariablesFor', 'scriptsEnabled', 'scriptsSchema', 'setScriptHost', 'setScriptsEnabled',
  'setSyntaxLocator', 'syntaxErrorText', 'unknownVariableText', 'usesBiomeHelpers', 'worldInputs',
];

const entry = readFileSync(join(here, 'script.ts'), 'utf8');
const files = readdirSync(join(here, 'script'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(here, 'script', f));

describe('core/script.ts 拆开以后', () => {
  it('入口照旧导出全部：名字和拆之前一样', () => {
    const names = [...entry.matchAll(/^export \{([^}]*)\} from '\.\/script\/[\w-]+';$/gm)].flatMap((m) => m[1].split(',').map((n) => n.replace(/^\s*type\s+/, '').trim()));
    expect([...names].sort()).toEqual(EXPORTS);
    // 运行时真的拿得到的（类型不算）都在名单里，名单里的值都拿得到
    for (const k of Object.keys(script)) expect(EXPORTS, k).toContain(k);
    for (const k of ['runScript', 'runSetup', 'compileScript', 'worldInputs', 'arrayInputs', 'checkPurity', 'ScriptError', 'VARIABLES', 'scriptsSchema', 'disallowScripts', 'setScriptHost']) expect(typeof (script as Record<string, unknown>)[k], k).not.toBe('undefined');
  });

  it('入口里只有说明和导出，没有代码', () => {
    const code = entry.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('//'));
    expect(code.length).toBeGreaterThan(5);
    for (const l of code) expect(l, l).toMatch(/^export \{.*\} from '\.\/script\/[\w-]+';$/);
  });

  it('新文件每个不超过 800 行', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) expect(readFileSync(f, 'utf8').split('\n').length, relative(root, f)).toBeLessThanOrEqual(800);
  });

  it('新文件之间运行时的引用不绕成圈；不值引用 commands.ts、generate.ts、terrain.ts、planet-gen.ts', () => {
    const graph = new Map<string, string[]>();
    for (const f of files) {
      const deps = runtimeImports(f)
        .map((s) => resolveImport(f, s))
        .filter((p): p is string => !!p);
      graph.set(f, deps.filter((d) => files.includes(d)));
      for (const d of deps) expect(relative(root, d), relative(root, f)).not.toMatch(/^core\/(commands|generate|terrain|planet-gen)\.ts$/);
    }
    const state = new Map<string, 1 | 2>();
    const visit = (f: string, path: string[]): void => {
      if (state.get(f) === 2) return;
      if (state.get(f) === 1) throw new Error(`绕成圈了：${[...path, f].map((p) => relative(root, p)).join(' → ')}`);
      state.set(f, 1);
      for (const d of graph.get(f) ?? []) visit(d, [...path, f]);
      state.set(f, 2);
    };
    for (const f of files) visit(f, []);
    // 对照：检查本身管用（run.ts 引用 compile.ts）
    expect(graph.get(join(here, 'script', 'run.ts'))).toContain(join(here, 'script', 'compile.ts'));
  });
});
