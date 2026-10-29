import type { TidyPlan } from '../../../core/tidy';
import { kindOf } from '../../../core/content/registry';
import { askUser, exec, planTidy, showToast } from '../../state';

// 整理本世界（第二十九轮，资源库的“⋯”、打开旧的世界文件后的提示）：先在副本上算计划，列出移出、留着的，确认后执行（一步，可以撤销）。
// 移出的内容里自己做的、改过的由 state.ts 的 exec 存进资源库

const kindLabel = (kind: string) => kindOf(kind)?.label ?? kind;

// 问话里列的几行：移出的（名字 · 种类），留着的（名字 · 原因）
export function tidyLines(plan: TidyPlan): { label: string; hint?: string }[] {
  return [
    ...plan.removed.map((r) => ({ label: r.name || r.id, hint: kindLabel(r.kind) })),
    ...plan.kept.map((k) => ({ label: `留着：${k.name || k.id}`, hint: k.reason })),
  ];
}

export function tidyText(plan: TidyPlan): string {
  const n = plan.removed.length;
  return `移出 ${n} 项没用到的内容${plan.kept.length ? `；${plan.kept.length} 项移出后地图会变，留着` : ''}。自己做的存进资源库。`;
}

export async function tidyWorld(): Promise<boolean> {
  const plan = await planTidy();
  if (!plan) return false;
  if (!plan.command) {
    showToast(plan.kept.length ? `${plan.kept.length} 项没用到，但移出后地图会变` : '没有没用到的内容');
    return false;
  }
  const v = await askUser({
    title: '整理本世界',
    text: tidyText(plan),
    lines: tidyLines(plan),
    choices: [
      { value: 'ok', label: '整理', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'ok') return false;
  return exec(plan.command, '正在整理…');
}
