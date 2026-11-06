import { signal } from '@preact/signals';
import type { Command } from '../../../core/commands';
import { type RiverRef, cancelPreviews, exec, selectedRiver, switchTool, tool, world } from '../../state';

// 选河、加河（第七十轮从 river/tool.ts 分出来）：河流列表、地名栏、底部条上的按钮用

// “从这里往下去掉”：点了按钮以后在选中的自然的河上点一下选位置（悬停时预览）
export const riverCutPick = signal(false);

// 选中一条河（河流列表、地名栏里点的）：换到画河工具，底部条换成这条河的设置
export function selectRiver(ref: RiverRef) {
  if (tool.value !== 'river') switchTool('river');
  selectedRiver.value = ref;
}

// 执行一条加河道的命令，成功后选中新加的那条
export async function execAndSelect(cmd: Command, label: string): Promise<boolean> {
  cancelPreviews();
  const before = new Set(world.value?.small.guides.map((g) => g.id) ?? []);
  const ok = await exec(cmd, label);
  const g = ok ? world.value?.small.guides.find((x) => !before.has(x.id)) : undefined;
  if (g) selectedRiver.value = { kind: 'guide', id: g.id };
  return ok;
}
