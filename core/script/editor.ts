import type { ScriptKind } from './format';
import { POISONED, SHADOW } from './shadow';
import { missingVariable, syntaxText } from './issues';
import { HELPER_NAMES } from './helpers';

// 编辑器用的几个：只处理文字，不编译、不运行（第一百零一轮从 core/script.ts 原样搬来）

// ---------- 编辑器用：只处理文字，不编译、不运行（主线程上也能用） ----------

// 语法错误的中文说明。raw 是解析器的原话（编辑器用 acorn 只解析时也拿它来换成中文）
export function syntaxErrorText(raw: string, src: string): string {
  return syntaxText(raw, src);
}

// 脚本里用了没有的名字：“没有变量 tMeen（是不是 tMean？）”，或者“只有颜色脚本能用”
export function unknownVariableText(name: string, kind: ScriptKind): string {
  return missingVariable(name, kind);
}

// 脚本里不能用的名字（被遮住的全局名字，还有 Math.random）的说明；能用时为 undefined
export function blockedNameText(name: string): string | undefined {
  if (name === 'Math.random') return '用 rand() 代替 Math.random()';
  if (name === 'Math' || !(SHADOW as readonly string[]).includes(name)) return undefined;
  return POISONED[name as keyof typeof POISONED] ?? `脚本里不能用 ${name}`;
}

// 辅助函数的名字（noise、rand、field……）
export const SCRIPT_HELPER_NAMES: readonly string[] = HELPER_NAMES;
