import type { Program } from 'acorn';
import {
  SCRIPT_HELPER_NAMES,
  type ScriptKind,
  blockedNameText,
  codeOnly,
  scriptVariablesFor,
  setSyntaxLocator,
  syntaxErrorText,
  unknownVariableText,
} from '../../core/script';

// 脚本编辑器在主线程上的检查：用懒加载的 acorn 只解析（不编译、不运行用户的代码），
// 给出语法错误在第几行、用了没有的变量（“没有变量 tMeen（是不是 tMean？）”）。
// V8 的 new Function 报语法错误时不带行号，所以行号靠这里；装上 acorn 后也挂到 setSyntaxLocator 上。
// acorn 加载不了（离线、文件丢了）时不查：写错的脚本照样会被引擎拒绝，只是说不出第几行

export interface SyntaxProblem {
  // 用户源码里的第几行（从 1 起）；不知道时没有
  line?: number;
  // 中文说明，编辑器的红字：`第 ${line} 行：${text}`
  text: string;
  // syntax 写法不对；name 用了没有的或不能用的名字
  reason: 'syntax' | 'name';
}

type Acorn = typeof import('acorn');

let acorn: Acorn | null = null;
let loading: Promise<Acorn | null> | null = null;

// 第一次打开脚本框时才加载 acorn（单独的一小块代码，平时不下载）
export function loadAcorn(): Promise<Acorn | null> {
  if (acorn) return Promise.resolve(acorn);
  loading ??= import('acorn').then(
    (m) => {
      useAcorn(m);
      return m;
    },
    () => {
      // 下次再试
      loading = null;
      return null;
    },
  );
  return loading;
}

// 装上 acorn：之后语法错误的行号都靠它（测试直接用它）
export function useAcorn(m: Acorn): void {
  acorn = m;
  setSyntaxLocator((src) => syntaxProblem(src)?.line);
}

// 引擎把源码放进严格模式的函数里，这里同样按严格模式解析（with、八进制数、delete 变量……都算错）。
// 前缀和源码在同一行，行号不变；第 1 行的列号要减去前缀的长度
const PREFIX = '"use strict"; ';

interface ParseError {
  message: string;
  // 用户源码里的位置
  pos: number;
  line: number;
}

function parse(m: Acorn, src: string): { ast: Program } | { error: ParseError } {
  try {
    return { ast: m.parse(PREFIX + src, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, locations: true }) };
  } catch (e) {
    const err = e as { message?: unknown; pos?: unknown; loc?: { line?: unknown } };
    const message = String(err.message ?? '').replace(/\s*\(\d+:\d+\)$/, '');
    const pos = typeof err.pos === 'number' ? Math.max(0, err.pos - PREFIX.length) : src.length;
    const line = typeof err.loc?.line === 'number' ? err.loc.line : lineAt(src, pos);
    return { error: { message, pos, line } };
  }
}

// 位置 k 在第几行（与 JS 一样：\r\n、\r、\u2028、\u2029 都算换行）
export function lineAt(src: string, k: number): number {
  return src.slice(0, k).split(/\r\n|[\n\r\u2028\u2029]/).length;
}

const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

// 括号配对（只数代码里的：注释、字符串、正则里的不算）。少了右括号时，解析器要到最后才发现，
// 报的是最后一行；这里报那个没配上的左括号在哪一行，更容易找
export function bracketProblem(src: string): SyntaxProblem | null {
  const code = codeOnly(src);
  const stack: number[] = [];
  for (let k = 0; k < code.length; k++) {
    const c = code[k];
    if (c in CLOSE) stack.push(k);
    else if (c === ')' || c === ']' || c === '}') {
      const at = stack.pop();
      if (at === undefined) return { line: lineAt(src, k), text: `多了一个 ${c}`, reason: 'syntax' };
      // 配错了：是前面那个左括号少了它的右括号
      if (CLOSE[code[at]] !== c) return { line: lineAt(src, at), text: `这个 ${code[at]} 少了配对的 ${CLOSE[code[at]]}`, reason: 'syntax' };
    }
  }
  if (!stack.length) return null;
  const at = stack[stack.length - 1];
  return { line: lineAt(src, at), text: `这个 ${code[at]} 少了配对的 ${CLOSE[code[at]]}`, reason: 'syntax' };
}

// 中文标点与该换成的英文标点
const PUNCT: Record<string, string> = {
  '（': '(',
  '）': ')',
  '，': ',',
  '；': ';',
  '：': ':',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '。': '.',
  '【': '[',
  '】': ']',
  '！': '!',
  '？': '?',
  '、': ',',
  '＝': '=',
  '＋': '+',
  '－': '-',
  '＜': '<',
  '＞': '>',
};

// pos 处的一个词或一个字符；到了末尾为 null
function tokenAt(src: string, pos: number): string | null {
  if (pos >= src.trimEnd().length) return null;
  const m = /^(?:[\p{L}\p{N}_$]+|\S)/u.exec(src.slice(pos).trimStart());
  return m ? m[0] : null;
}

// acorn 的出错信息换成中文
function acornText(e: ParseError, src: string): string {
  const msg = e.message;
  let m: RegExpExecArray | null;
  if (/^Unexpected token$/.test(msg)) {
    const t = tokenAt(src, e.pos);
    return t === null ? '代码没写完（是不是后面少了什么？）' : `这里不该出现「${t}」`;
  }
  if ((m = /^Unexpected character '(.+)'$/.exec(msg))) {
    const c = m[1];
    return PUNCT[c] ? `用了中文标点「${c}」，要换成英文的「${PUNCT[c]}」` : `不认识的字符「${c}」`;
  }
  if (/^Unterminated string constant/.test(msg)) return '引号没有配对';
  if (/^Unterminated template/.test(msg)) return '反引号 ` 没有配对';
  if (/^Unterminated comment/.test(msg)) return '注释的 /* 后面少了 */';
  if (/^Unterminated regular expression/.test(msg)) return '这里的 / 没有配对（除号的两边都要有数）';
  if ((m = /^Identifier '(.+)' has already been declared/.exec(msg))) return `「${m[1]}」重复声明了`;
  if (/^Assigning to rvalue|^Invalid left-hand side/.test(msg)) return '等号左边不能被赋值（比较是否相等要用 ===）';
  if (/^Invalid number|^Identifier directly after number/.test(msg)) return '数字写得不对';
  if (/^Unsyntactic (break|continue)/.test(msg)) return '这里不能用 break 或 continue';
  if ((m = /^The keyword '(.+)' is reserved/.exec(msg))) return `「${m[1]}」是保留字，不能当名字用`;
  if ((m = /^Unexpected keyword '(.+)'/.exec(msg))) return `这里不该出现「${m[1]}」`;
  if (/^'with' in strict mode/.test(msg)) return '脚本里不能用 with';
  if (/^Deleting local variable/.test(msg)) return '不能 delete 一个变量';
  if (/octal/i.test(msg)) return '不能用 0 开头的八进制数字';
  if (/await/.test(msg)) return '脚本里不能用 await';
  return syntaxErrorText(msg, src);
}

// 解析出错时报什么：括号没配对时报括号（行号更准），否则换成中文的解析器原话
function errorProblem(e: ParseError, src: string): SyntaxProblem {
  return bracketProblem(src) ?? { line: e.line, text: acornText(e, src), reason: 'syntax' };
}

// 语法错误（只看写法）；没有错或 acorn 还没加载时为 null
export function syntaxProblem(src: string): SyntaxProblem | null {
  if (!acorn) return null;
  const r = parse(acorn, src);
  return 'error' in r ? errorProblem(r.error, src) : null;
}

// ---------- 用了没有的名字 ----------

// 脚本里能直接用的 JS 内置名字（被遮住的 Date、globalThis 这些另说，见 blockedNameText）
const BUILTINS = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'arguments',
  'Math',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'JSON',
  'Symbol',
  'BigInt',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'RegExp',
  'Reflect',
  'Proxy',
  'Promise',
  'isNaN',
  'isFinite',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
  'decodeURIComponent',
  'ArrayBuffer',
  'DataView',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

type AstNode = { type: string; loc?: { start: { line: number } } | null } & Record<string, unknown>;
const isNode = (v: unknown): v is AstNode => v !== null && typeof v === 'object' && typeof (v as AstNode).type === 'string';

// 声明出来的名字（变量、函数、参数、catch 的参数；解构也算）
function bind(p: unknown, out: Set<string>): void {
  if (!isNode(p)) return;
  switch (p.type) {
    case 'Identifier':
      out.add(p.name as string);
      return;
    case 'ObjectPattern':
      for (const q of p.properties as AstNode[]) bind(q.type === 'RestElement' ? q : q.value, out);
      return;
    case 'ArrayPattern':
      for (const q of p.elements as unknown[]) bind(q, out);
      return;
    case 'RestElement':
      bind(p.argument, out);
      return;
    case 'AssignmentPattern':
      bind(p.left, out);
      return;
  }
}

// 这个名字是属性名、标签（不是变量）
function notVariable(parent: AstNode | null, key: string): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case 'MemberExpression':
      return key === 'property' && !parent.computed;
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return key === 'key' && !parent.computed;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key === 'label';
    case 'MetaProperty':
      return true;
  }
  return false;
}

// 用了这种脚本里没有的变量、不能用的名字：按出现的先后报第一处。只看名字有没有在哪里声明过（不细分作用域），
// 所以只会少报、不会把声明过的名字报成没有。
// fields：世界上有的自定义场；给出时也查 field('名字') 里写的场在不在（内置变量的名字也算在）
export function namesProblem(ast: Program, kind: ScriptKind, fields?: readonly string[]): SyntaxProblem | null {
  const declared = new Set<string>();
  const uses: { name: string; at: number; line?: number; field?: true }[] = [];
  const visit = (node: AstNode, parent: AstNode | null, key: string): void => {
    switch (node.type) {
      case 'CallExpression': {
        const callee = node.callee as AstNode;
        const arg = (node.arguments as AstNode[])[0];
        if (fields && callee.type === 'Identifier' && callee.name === 'field' && arg?.type === 'Literal' && typeof arg.value === 'string') {
          uses.push({ name: arg.value, at: arg.start as number, line: arg.loc?.start.line, field: true });
        }
        break;
      }
      case 'VariableDeclarator':
        bind(node.id, declared);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        bind(node.id, declared);
        for (const p of node.params as unknown[]) bind(p, declared);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        bind(node.id, declared);
        break;
      case 'CatchClause':
        bind(node.param, declared);
        break;
      case 'MemberExpression': {
        const o = node.object as AstNode;
        const p = node.property as AstNode;
        if (!node.computed && o.type === 'Identifier' && o.name === 'Math' && p.type === 'Identifier' && p.name === 'random') {
          uses.push({ name: 'Math.random', at: node.start as number, line: node.loc?.start.line });
        }
        break;
      }
      case 'Identifier':
        if (!notVariable(parent, key)) uses.push({ name: node.name as string, at: node.start as number, line: node.loc?.start.line });
        return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc') continue;
      if (Array.isArray(v)) {
        for (const x of v) if (isNode(x)) visit(x, node, k);
      } else if (isNode(v)) visit(v, node, k);
    }
  };
  visit(ast as unknown as AstNode, null, '');
  const known = new Set<string>([...BUILTINS, ...SCRIPT_HELPER_NAMES]);
  // 按格变的变量（field() 也能按名字取它们）
  const perCell = new Set<string>();
  for (const v of scriptVariablesFor(kind)) {
    for (const name of v.zh ? [v.key, v.zh] : [v.key]) {
      known.add(name);
      if (!v.scalar) perCell.add(name);
    }
  }
  uses.sort((a, b) => a.at - b.at);
  for (const u of uses) {
    if (u.field) {
      // 自己定义了 field 函数时不管；内置变量的名字也能用 field('海拔') 取
      if (declared.has('field') || fields!.includes(u.name) || perCell.has(u.name)) continue;
      return { line: u.line, text: `没有自定义场「${u.name}」（先在“调整”里新建）`, reason: 'name' };
    }
    // 自己声明了的名字随便用（自己声明的 Math 上的 random 也是自己的）
    if (declared.has(u.name === 'Math.random' ? 'Math' : u.name)) continue;
    const blocked = blockedNameText(u.name);
    if (blocked) return { line: u.line, text: blocked, reason: 'name' };
    if (u.name === 'Math.random' || known.has(u.name)) continue;
    return { line: u.line, text: unknownVariableText(u.name, kind), reason: 'name' };
  }
  return null;
}

// 编辑器提交前的检查：写法、名字。没问题、或 acorn 加载不了时为 null
export function checkNow(kind: ScriptKind, src: string, fields?: readonly string[]): SyntaxProblem | null {
  if (!acorn) return null;
  const r = parse(acorn, src);
  return 'error' in r ? errorProblem(r.error, src) : namesProblem(r.ast, kind, fields);
}

export async function checkScript(kind: ScriptKind, src: string, fields?: readonly string[]): Promise<SyntaxProblem | null> {
  await loadAcorn();
  return checkNow(kind, src, fields);
}
