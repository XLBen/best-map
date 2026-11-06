import type { Command } from '../../core/commands';
import type { World } from '../../core/world';
import { outsideRangeReason } from '../biome-range';
import { noteCost } from './cost-gate';
import { type NoteAction, noteChange, noteSkipped, showToast } from './notes';
import { trustOwn } from './script-trust';
import { keepRemoved } from './tidy';
import { call, handle } from './worker-host';
import { history, regenTrack, world } from './world';

// 编辑（第七十轮从 state.ts 分出来）：执行、换掉最后一步、撤销、重做

// 执行一条编辑命令；成功后显示“改了什么”、撤销，以及额外的按钮
// head：顶部说的话（不用引擎的说法时）；是函数时按改完的世界说（返回 null 照用引擎的说法）
export async function exec(cmd: Command, label = '正在计算…', action?: NoteAction, head?: string | ((after: World, summary: string) => string | null)): Promise<boolean> {
  const r = await call({ kind: 'exec', cmd }, label);
  // 这类命令重算一次要多久（成本闸门：太慢的不自动预览）
  if (r.ok && r.snapshot && !('light' in r.snapshot)) noteCost(cmd, r.snapshot.timings.total);
  // 改动前的世界：排在前面的笔画已经算完、换上了，所以在回复到达时取
  const before = world.value;
  if (r.ok && r.noop) {
    if (r.skipped?.length) noteSkipped(r.skipped);
    else showToast('没有变化');
    return true;
  }
  regenTrack.pending = cmd;
  const ok = await handle(r);
  // 第二十九轮：这一步移出世界的内容里自己做的、改过的存进资源库“来自《世界名》”
  if (ok && r.ok && r.removed?.length) void keepRemoved(r.removed);
  // 第三十轮：缺了内容跳过的步骤在顶上说一次（带“从资源库添加…”）
  if (ok && r.ok) noteSkipped(r.skipped);
  if (ok && r.ok) {
    trustOwn(cmd);
    const said = typeof head === 'function' ? (world.value ? head(world.value, r.summary ?? '') : null) : head;
    const text = said ?? ((cmd.op === 'add_constraint' && before && world.value && paintNote(before, world.value)) || r.summary || '完成');
    noteChange(text, before, true, action, cmd.op === 'add_guide' || cmd.op === 'update_guide');
  }
  return ok;
}

// 涂了一片生态之后实际的结果（与按住时的预览一样说）：“水晶丛林：60 格变了 · 495 格没涂成（这里长不了）”。
// 没涂成的格大多在生态的范围（只在一个岛上、圈的范围里）外面时说“不在这个生态的范围里（只长在「X岛」）”。
// 刚涂的是 after 里最后一条涂的设定；没涂成的格是它在冲突里列出的格。拼不出来时返回 null（照用引擎的说法）
export function paintNote(before: World, after: World): string | null {
  const c = after.small.constraints[after.small.constraints.length - 1];
  if (!c || before.mesh !== after.mesh) return null;
  const sp = after.small.species.find((x) => x.id === c.species);
  const name = sp?.name || c.species;
  const id = (w: World, i: number) => {
    const k = w.derived.dominant[i];
    return k >= 0 ? w.small.species[k]?.id : null;
  };
  let changed = 0;
  for (let i = 0; i < after.mesh.n; i++) if (id(before, i) !== id(after, i)) changed++;
  const cells = after.derived.conflicts.find((x) => x.constraintId === c.id)?.failing ?? [];
  const failing = cells.length;
  const mode = c.mode === 'constraint' ? '自然融入' : '强制';
  const head = changed ? `${name} · ${changed} 格变了` : `${name} · 生态没变`;
  const outside = failing ? outsideRangeReason(after, sp, cells) : null;
  if (outside) return `${head} · ${failing} 格没涂成：${outside}`;
  return failing ? `${head} · ${failing} 格没涂成` : `${head} · ${mode}`;
}

// 撤掉刚做的一步，换成新的命令（只重算一次，历史里只留一步）
export async function replaceLast(cmd: Command, label = '正在计算…'): Promise<boolean> {
  const r = await call({ kind: 'replaceLast', cmd }, label);
  if (r.ok && r.snapshot && !('light' in r.snapshot)) noteCost(cmd, r.snapshot.timings.total);
  const before = world.value;
  regenTrack.pending = cmd;
  const ok = await handle(r);
  if (ok && r.ok) {
    trustOwn(cmd);
    noteChange(r.summary ?? '完成', before);
  }
  return ok;
}

// 改动前的世界、历史都在回复到达时取：排在前面的笔画那时已经换上了
export async function undo() {
  const r = await call({ kind: 'undo' }, '撤销…');
  const before = world.value;
  const last = history.value.filter((h) => h.done).pop();
  regenTrack.pending = 'history';
  const ok = await handle(r);
  if (ok && last) noteChange(`撤销：${last.summary}`, before, false);
}

export async function redo() {
  const r = await call({ kind: 'redo' }, '重做…');
  const before = world.value;
  const next = history.value.find((h) => !h.done);
  regenTrack.pending = 'history';
  const ok = await handle(r);
  if (ok && next) noteChange(`重做：${next.summary}`, before);
}
