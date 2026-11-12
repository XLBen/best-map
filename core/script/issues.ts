import { CommandError } from '../errors';
import { codeOnly, SCRIPT_KIND_LABEL, type ScriptKind, scriptVariablesFor, VAR_BY_NAME } from './format';
import { POISONED, SHADOW } from './shadow';
import { HELPER_NAMES } from './helpers';

// 脚本出错时的说明：ScriptIssue / ScriptError、没有的变量、语法错误和运行时出错的中文（第一百零一轮从 core/script.ts 原样搬来）

// ---------- 出错 ----------

export interface ScriptIssue {
  owner: string;
  // 所属对象的 id（runScript 给出的说明里有；界面靠它找到是哪一种生态的脚本，名字可能重复）
  id?: string;
  kind: ScriptKind;
  // syntax 语法错误；runtime 运行时出错；value 返回值不对（NaN、类型）；disabled 安全模式下没有运行
  reason: 'syntax' | 'runtime' | 'value' | 'disabled';
  // 用户源码里的行号（从 1 起）；不知道时没有
  line?: number;
  // 出错的格（runScript 的 cells 里的值）
  cell?: number;
  // 原因（中文），编辑器的红字：`第 ${line} 行：${text}`
  text: string;
  // 引擎给的原始信息
  raw: string;
  // 完整的一句话：「X」的长在哪里脚本第 3 行出错：…
  message: string;
}

export class ScriptError extends CommandError {
  readonly owner: string;
  readonly kind: ScriptKind;
  readonly line: number | undefined;
  readonly cell: number | undefined;
  readonly issue: ScriptIssue;
  constructor(issue: ScriptIssue) {
    super(issue.message);
    this.name = 'ScriptError';
    this.owner = issue.owner;
    this.kind = issue.kind;
    this.line = issue.line;
    this.cell = issue.cell;
    this.issue = issue;
  }
}

export function makeIssue(owner: string, kind: ScriptKind, reason: ScriptIssue['reason'], text: string, raw: string, line?: number, cell?: number): ScriptIssue {
  const where = `“${owner}”的${SCRIPT_KIND_LABEL[kind]}脚本${line ? `第 ${line} 行` : ''}`;
  const message =
    reason === 'syntax' ? `${where}有语法错误：${text}` : reason === 'disabled' ? `${where}没有运行：${text}` : `${where}出错：${text}`;
  return { owner, kind, reason, line, cell, text, raw, message };
}

// 编辑距离（按字符，中文也按一个字算）
function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, k) => k);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

export function missingVariable(name: string, kind: ScriptKind): string {
  const v = VAR_BY_NAME.get(name);
  if (v && !v.kinds.includes(kind)) {
    return `${SCRIPT_KIND_LABEL[kind]}脚本里没有变量 ${name}（只有${v.kinds.map((k) => SCRIPT_KIND_LABEL[k]).join('、')}脚本能用）`;
  }
  const names = [...scriptVariablesFor(kind).flatMap((u) => (u.zh ? [u.key, u.zh] : [u.key])), ...HELPER_NAMES];
  let best = '';
  let bestD = Infinity;
  for (const c of names) {
    const d = c.toLowerCase() === name.toLowerCase() ? 0 : editDistance(name, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const len = Array.from(name).length;
  return bestD <= (len <= 3 ? 1 : 2) ? `没有变量 ${name}（是不是 ${best}？）` : `没有变量 ${name}`;
}

const POISON_MESSAGE = / is not available in scripts$/;

// 运行时的出错信息换成中文提示（V8、Firefox、Safari 的几种写法）
export function runtimeText(raw: string, kind: ScriptKind): string {
  if (/Math\.random is not a function/.test(raw)) return '用 rand() 代替 Math.random()';
  if (POISON_MESSAGE.test(raw)) return POISONED[raw.replace(POISON_MESSAGE, '') as keyof typeof POISONED] ?? raw;
  const ref = /^(\S+) is not defined$/.exec(raw) ?? /^Can't find variable: (\S+)$/.exec(raw);
  if (ref) return missingVariable(ref[1], kind);
  const fn = /^(\S+) is not a (?:function|constructor)/.exec(raw);
  if (fn && (SHADOW as readonly string[]).includes(fn[1])) return `脚本里不能用 ${fn[1]}`;
  if (/Maximum call stack size exceeded|too much recursion/.test(raw)) return '函数调用太深：递归没有尽头';
  const prop = /Cannot read properties of (undefined|null) \(reading '(.+)'\)/.exec(raw) ?? /can't access property "(.+)", .+ is (undefined|null)/.exec(raw);
  if (prop) return prop[0].startsWith('Cannot') ? `读不到“${prop[2]}”：前面的值是 ${prop[1]}` : `读不到“${prop[1]}”：前面的值是 ${prop[2]}`;
  if (fn) return `${fn[1]} 不是${raw.includes('constructor') ? '能 new 的类型' : '函数'}`;
  return raw;
}

const CLOSE_NAME: Record<string, string> = { '(': '右括号 )', '[': '右方括号 ]', '{': '右花括号 }' };
const OPEN_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

// 括号是否配对（只数代码里的，注释、字符串、正则里的不算）。V8 会用它自己包在外面的 } 补上没配对的 {，
// 再报“不该出现 )”，所以先数括号，说清楚少了哪一个
function bracketText(code: string): string | null {
  const stack: string[] = [];
  for (const c of code) {
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c in OPEN_OF) {
      const open = stack.pop();
      if (open === undefined) return `多了一个 ${c}`;
      if (open !== OPEN_OF[c]) return `括号没有配对：这里应该是${CLOSE_NAME[open]}，写成了 ${c}`;
    }
  }
  return stack.length ? `代码没写完（少了${CLOSE_NAME[stack[stack.length - 1]]}）` : null;
}

// 语法错误换成中文说明
export function syntaxText(raw: string, src: string): string {
  let m: RegExpExecArray | null;
  const code = codeOnly(src);
  const brackets = bracketText(code);
  if (brackets) return brackets;
  if (/Unexpected end of input|missing \} after function body|end of script|Unexpected EOF/i.test(raw)) return '代码没写完：少了 ) 或 }';
  if (/missing \) after argument list|missing \) in parenthetical|missing \) after condition|Expected '\)'/.test(raw)) return '少了右括号 )';
  if (/Unterminated template/i.test(raw)) return '反引号 ` 没有配对';
  if (/Unterminated string|unterminated string literal/i.test(raw)) return '引号没有配对';
  if (/Invalid or unexpected token|illegal character|Invalid character/i.test(raw)) {
    // 只看代码里的：注释、字符串里写中文标点没有关系
    return /[（），；：“”‘’。、！？【】]/.test(code) ? '中文标点（，；（ ）“ ”）要换成英文的' : '有不认识的字符，或引号没有配对';
  }
  if ((m = /Identifier '(.+)' has already been declared/.exec(raw) ?? /redeclaration of (?:let|const|var|formal parameter) (.+)/.exec(raw))) return `“${m[1]}”重复声明了`;
  if ((m = /Unexpected identifier(?: '(.+)')?/.exec(raw))) return `这里不该出现${m[1] ? `“${m[1]}”` : '名字'}：少了运算符、逗号或分号`;
  if (/Unexpected number/.test(raw)) return '这里不该出现数字：少了运算符或逗号';
  if (/Unexpected string/.test(raw)) return '这里不该出现字符串：少了运算符或逗号';
  if (/reserved word|reserved identifier/i.test(raw)) return '保留字（let、yield、static……）不能当名字';
  if (/Octal/i.test(raw)) return '不能用 0 开头的八进制数字';
  if (/Invalid left-hand side in assignment|invalid assignment left-hand side/i.test(raw)) return '等号左边不能赋值（比较用 ===）';
  if (/Illegal (break|continue)/.test(raw)) return '这里不能用 break 或 continue';
  if ((m = /Unexpected token:? '?(.+?)'?$/i.exec(raw) ?? /expected expression, got '?(.+?)'?$/.exec(raw))) return `这里不该出现“${m[1]}”`;
  if (/missing ; before statement/.test(raw)) return '少了分号或运算符';
  return `语法不对（${raw}）`;
}
