import { codeOnly, inScope, lineCount, type MatchScope, MAX_SCRIPT_CHARS, NAME_RE, type ScriptKind, VARIABLES } from './format';
import { SHADOW } from './shadow';
import { makeIssue, runtimeText, ScriptError, type ScriptIssue, syntaxText } from './issues';
import { HELPER_NAMES, HELPERS, RUN_STATE as RUN, SHADOW_VALUES } from './helpers';

// 编译（生成整段循环的代码、缓存、安全模式的开关）和出错时的行号（第一百零一轮从 core/script.ts 原样搬来；两节互相要用，放在一个文件里）

// ---------- 编译 ----------

// 一个变量在循环里怎么传：按格取数组、整个世界一个值、格的编号
export type ParamMode = 'array' | 'scalar' | 'cell';
export interface ScriptParam {
  name: string;
  key: string;
  mode: ParamMode;
}

export interface CompiledScript {
  readonly kind: ScriptKind;
  readonly src: string;
  // 源码里出现的变量名（按 VARIABLES 的顺序；中文名、英文名各算一个参数）
  readonly names: readonly string[];
  // 每个参数对应的英文名
  readonly keys: readonly string[];
  readonly params: readonly ScriptParam[];
  // 每格的函数（参数就是 names）；布局脚本直接调用它
  readonly script: (...args: unknown[]) => unknown;
  // 整段循环（布局脚本没有）：(cells, out, host, put, ...输入) → 出错的下标，全部正常为 −1
  readonly loop: ((...args: unknown[]) => number) | null;
}

interface Failure {
  raw: string;
  text: string;
  line?: number;
}

// 编译缓存：键为 kind + '\0' + 源码，最近用过的 128 段。编辑器每次停顿都会提交一次，同一段源码不重复编译。
// 编译出的函数只在这里（以及调用方临时的局部变量里），不能放进会被克隆的数据
const CACHE_SIZE = 128;
const cache = new Map<string, CompiledScript | Failure>();

// 统计（测试用）
export const scriptStats = { compiles: 0, hits: 0 };

export let enabled = true;
let disallowed = false;

// 安全模式：在一个 worker 的生命周期内由调用方固定（关掉后所有脚本都按“没有脚本”处理）
export function setScriptsEnabled(on: boolean): void {
  enabled = on;
}
export function scriptsEnabled(): boolean {
  return enabled;
}

// 主线程调用：之后任何编译都抛错，防止不小心在主线程跑用户代码
export function disallowScripts(): void {
  disallowed = true;
}

// 语法错误的行号：V8 的 new Function 不给行号，编辑器可以装一个只做解析的定位器（比如懒加载的 acorn）
let syntaxLocator: ((src: string) => number | undefined) | null = null;
export function setSyntaxLocator(f: ((src: string) => number | undefined) | null): void {
  syntaxLocator = f;
}

// 源码里用到的变量（只看代码：注释、字符串里的不算）
function paramsOf(kind: ScriptKind, src: string, scope?: MatchScope): ScriptParam[] {
  const code = codeOnly(src);
  const out: ScriptParam[] = [];
  for (const v of VARIABLES) {
    if (!v.kinds.includes(kind) || !inScope(v, kind, scope)) continue;
    const mode: ParamMode = v.key === 'cell' ? 'cell' : v.scalar ? 'scalar' : 'array';
    for (const name of v.zh ? [v.key, v.zh] : [v.key]) if (NAME_RE.get(name)!.test(code)) out.push({ name, key: v.key, mode });
  }
  return out;
}

// 每种脚本的返回值在循环里就地检查、写进输出（长在哪里、河流匹配直接写；颜色、地形交给 put）
function convertSource(kind: ScriptKind): string {
  switch (kind) {
    case 'placement':
      return (
        "if (typeof __v === 'number') { if (__v !== __v) { __st.bad = __v; return __j; } __out[__j] = __v < 0 ? 0 : __v > 1 ? 1 : __v; }\n" +
        'else if (__v === true) __out[__j] = 1;\nelse if (__v === false) __out[__j] = 0;\nelse { __st.bad = __v; return __j; }\n'
      );
    case 'match':
      // 真假随意（没有 return 的分支是 undefined，算不匹配），只有 NaN 算出错
      return 'if (__v !== __v) { __st.bad = __v; return __j; }\n__out[__j] = __v ? 1 : 0;\n';
    default:
      return 'if (!__put(__v, __j)) { __st.bad = __v; return __j; }\n';
  }
}

// 生成代码自己用的名字：在用户的函数里遮成 undefined。否则脚本能拿到 __st（本模块的运行状态，
// 顺着 __st.inputs 还能改引擎的推导数组）、在 __map2_script 上挂东西，跨格、跨运行地记住数据
const INTERNAL = ['__h', '__st', '__map2_script', '__map2_loop'];

// 生成的代码（外层是宽松模式的工厂，参数遮住全局名字；里面的函数都是严格模式）。
// 用户源码前面的行数固定（所有声明写在同一行），所以运行时的行号只差一个按种类标定的常数。
// 用户源码放在一个块里：用户自己声明与变量同名的 const/let 是合法的遮蔽，不会和参数冲突
function generate(kind: ScriptKind, src: string, params: ScriptParam[]): string {
  const helpers = HELPER_NAMES.map((h) => `${h} = __h.${h}`).join(', ');
  const hide = `const ${INTERNAL.map((n) => `${n} = void 0`).join(', ')};`;
  const head = `const ${helpers};\nfunction __map2_script(${params.map((p) => p.name).join(', ')}) { "use strict"; ${hide} {\n`;
  let loop = 'const __map2_loop = null;';
  if (kind !== 'setup') {
    const inputs: string[] = [];
    const args = params.map((p) => {
      if (p.mode === 'cell') return '__i';
      const a = `__a${inputs.length}`;
      inputs.push(a);
      return p.mode === 'array' ? `${a}[__i]` : a;
    });
    loop =
      `function __map2_loop(${['__cells', '__out', '__host', '__put', ...inputs].join(', ')}) {\n"use strict";\n` +
      'const __m = __cells.length;\nfor (let __j = 0; __j < __m; __j++) {\nconst __i = __cells[__j];\n__st.cell = __i;\n' +
      `const __v = __map2_script(${args.join(', ')});\n${convertSource(kind)}` +
      'if ((__j & 255) === 255) __host.tick();\n}\nreturn -1;\n}';
  }
  return `${head}${src}\n} }\n${loop}\nreturn [__map2_script, __map2_loop];`;
}

function build(kind: ScriptKind, src: string, scope?: MatchScope): CompiledScript {
  const params = paramsOf(kind, src, scope);
  const factory = new Function(...SHADOW, '__h', '__st', generate(kind, src, params)) as (...a: unknown[]) => [CompiledScript['script'], CompiledScript['loop']];
  const [script, loop] = factory(...SHADOW_VALUES, HELPERS, RUN);
  return { kind, src, names: params.map((p) => p.name), keys: params.map((p) => p.key), params, script, loop };
}

// 语法检查：源码单独作为一个严格模式的函数体能通过解析，才放进生成的代码（这样它不可能用多余的 } 跑出那个块）。
// 源码从新的一行开始，与生成代码里一样（行首的 --> 是 HTML 注释，这一点与在不在行首有关）
const checkBody = (src: string) => `"use strict";\n${src}\n`;
function syntaxFailure(src: string): Failure | null {
  try {
    new Function(checkBody(src));
    return null;
  } catch (e) {
    const raw = errorInfo(e).raw;
    return { raw, text: syntaxText(raw, src), line: firefoxSyntaxLine(e, src) };
  }
}

// 动态的 import()：脚本不能加载别的代码。隔离的 Worker 和页面的 CSP 也会挡住它，这里在编译时就拒绝（多一道防线），
// 并说清楚是第几行。只看代码（注释、字符串里写的不算）；obj.import(…) 是属性、#import(…) 是私有方法，不算；...import(…) 照样算
const IMPORT_CALL = /(?<![\p{ID_Continue}$#‌‍])(?<!(?<!\.)\.\s*)import\s*\(/u;
function importFailure(src: string): Failure | null {
  const m = IMPORT_CALL.exec(codeOnly(src));
  return m ? { raw: 'import()', text: '脚本里不能用 import', line: lineCount(src.slice(0, m.index)) } : null;
}

export function compileScript(kind: ScriptKind, src: string, owner = '脚本', scope?: MatchScope): CompiledScript {
  if (disallowed) throw new Error('主线程不运行脚本');
  const sc = kind === 'match' && scope === 'lake' ? 'lake' : undefined;
  const key = `${kind}${sc ? `:${sc}` : ''}\0${src}`;
  let hit = cache.get(key);
  if (hit) {
    scriptStats.hits++;
    cache.delete(key);
    cache.set(key, hit);
  } else {
    scriptStats.compiles++;
    if (src.length > MAX_SCRIPT_CHARS) hit = { raw: 'too long', text: `脚本太长（最多 ${MAX_SCRIPT_CHARS} 个字符）` };
    else hit = importFailure(src) ?? syntaxFailure(src) ?? undefined;
    if (!hit) {
      try {
        hit = build(kind, src, sc);
      } catch (e) {
        // 单独能通过、放进生成代码却不行：用了生成代码自己的名字（var __st）
        const raw = errorInfo(e).raw;
        hit = { raw, text: syntaxText(raw, src) };
      }
    }
    cache.set(key, hit);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  // 行号的定位器可能是缓存之后才装上的，所以每次报错时再问一次
  if ('raw' in hit) throw new ScriptError(makeIssue(owner, kind, 'syntax', hit.text, hit.raw, hit.line ?? syntaxLocator?.(src)));
  return hit;
}

// ---------- 行号 ----------

// 脚本抛出的东西可以是任何值（throw 5、message 是会抛错的 getter、代理……）：取说明和栈时自己也绝不抛错，
// 否则“软失败”就变成了硬失败
function errorInfo(e: unknown): { raw: string; stack?: string } {
  try {
    if (e instanceof Error) {
      const stack = e.stack;
      return { raw: String(e.message), stack: typeof stack === 'string' ? stack : undefined };
    }
  } catch {
    // 落到下面
  }
  try {
    return { raw: String(e) };
  } catch {
    return { raw: '（脚本抛出的值无法显示）' };
  }
}

// 错误栈里第一处生成代码的位置（V8：“<anonymous>:行:列”；Firefox：“> Function:行:列”）。
// 辅助函数里抛出的错误也会落在调用它的那一行
function stackLine(stack: string | undefined): number | undefined {
  if (!stack) return undefined;
  for (const l of stack.split('\n')) {
    const m = /<anonymous>:(\d+):\d+\)?\s*$/.exec(l) ?? /> (?:Function|eval):(\d+):\d+\s*$/.exec(l);
    if (m) return Number(m[1]);
  }
  return undefined;
}

// 每种脚本的行号偏移：第一次需要时编译一段第 1 行就抛错的脚本，看栈里报的是第几行
const lineOffset = new Map<ScriptKind, number | null>();
function offsetFor(kind: ScriptKind): number | null {
  let off = lineOffset.get(kind);
  if (off === undefined) {
    off = null;
    try {
      build(kind, 'throw new Error("probe");').script();
    } catch (e) {
      const l = stackLine(errorInfo(e).stack);
      off = l === undefined ? null : l - 1;
    }
    lineOffset.set(kind, off);
  }
  return off;
}

// 栈里的行号换成用户源码的行号；落在源码外面（生成的循环、辅助函数）就不说行号
function userLine(stack: string | undefined, kind: ScriptKind, src: string): number | undefined {
  const l = stackLine(stack);
  const off = l === undefined ? null : offsetFor(kind);
  if (l === undefined || off === null) return undefined;
  const line = l - off;
  return line >= 1 && line <= lineCount(src) ? line : undefined;
}

// Firefox 的 SyntaxError 带 lineNumber（相对 new Function 的源码）：同样用一段第 1 行就出错的源码标定
let syntaxOffset: number | null | undefined;
function firefoxSyntaxLine(e: unknown, src: string): number | undefined {
  let l: unknown;
  try {
    l = (e as { lineNumber?: unknown }).lineNumber;
  } catch {
    return undefined;
  }
  if (typeof l !== 'number') return undefined;
  if (syntaxOffset === undefined) {
    syntaxOffset = null;
    try {
      new Function(checkBody(')'));
    } catch (p) {
      const pl = (p as { lineNumber?: unknown }).lineNumber;
      if (typeof pl === 'number') syntaxOffset = pl - 1;
    }
  }
  if (syntaxOffset === null) return undefined;
  const line = l - syntaxOffset;
  return line >= 1 && line <= lineCount(src) ? line : undefined;
}

// 运行时出错的说明（软失败用）
export function runtimeIssue(e: unknown, owner: string, kind: ScriptKind, src: string, cell?: number): ScriptIssue {
  const { raw, stack } = errorInfo(e);
  let line: number | undefined;
  try {
    line = userLine(stack, kind, src);
  } catch {
    line = undefined;
  }
  return makeIssue(owner, kind, 'runtime', runtimeText(raw, kind), raw, line, cell);
}
