import { cleanableContent } from '../../../core/content/cleanable';
import { kindOf } from '../../../core/content/registry';
import type { TidyPlan } from '../../../core/tidy';
import { askUser, exec, planTidy, showToast, world } from '../../state';
import { kindTitle } from './page-source';

// 清理没用到的（第六十二轮，第二十九轮叫“整理本世界”）：清的就是列表上变淡的（core/content/cleanable.ts）。
// 先在副本上算计划，列出要清哪些，确认后一步清掉，能撤销；移出后地图会变的留着，写明。
// 河、湖、生态不清：现在一格都没有的，改一笔之后可能就有了；画风是“图层”里的选项。要清到那一项的页面上“移出本世界”。
// 移出的内容里自己做的、改过的由 state.ts 的 exec 存进资源库

const titleOf = (kind: string) => {
  const k = kindOf(kind);
  return k ? kindTitle(k) : kind;
};
const SHOW = 12;

// 问话里列的几行：一种一行（种类、个数，灰字是名字），留着的一行一项
export function tidyLines(plan: TidyPlan): { label: string; hint?: string }[] {
  const byKind = new Map<string, string[]>();
  for (const r of plan.removed) {
    const list = byKind.get(r.kind);
    if (list) list.push(r.name || r.id);
    else byKind.set(r.kind, [r.name || r.id]);
  }
  return [
    ...[...byKind].map(([kind, names]) => ({ label: `${titleOf(kind)} ${names.length}`, hint: `${names.slice(0, SHOW).join('、')}${names.length > SHOW ? ' 等' : ''}` })),
    ...plan.kept.map((k) => ({ label: `留着：${k.name || k.id}`, hint: k.reason })),
  ];
}

export function tidyText(plan: TidyPlan): string {
  const n = plan.removed.length;
  return `清掉 ${n} 项生成后没用到的内容，地图不变，可以撤销。${plan.kept.length ? `${plan.kept.length} 项清掉后地图会变，留着。` : ''}自己做的、改过的存进资源库。河、湖、生态、画风不清：现在没有的，以后可能用到。`;
}

export async function tidyWorld(): Promise<boolean> {
  const w = world.value;
  const only = w ? cleanableContent(w) : [];
  if (!only.length) {
    showToast('没有没用到的内容');
    return false;
  }
  const plan = await planTidy(only);
  if (!plan) return false;
  if (!plan.command) {
    showToast(`${plan.kept.length} 项没用到，但清掉后地图会变`);
    return false;
  }
  const v = await askUser({
    title: '清理没用到的',
    text: tidyText(plan),
    lines: tidyLines(plan),
    choices: [
      { value: 'ok', label: `清理 ${plan.removed.length} 项`, primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'ok') return false;
  return exec({ op: 'batch', label: `清理没用到的 · ${plan.removed.length} 项`, commands: [plan.command] }, '正在清理…');
}
