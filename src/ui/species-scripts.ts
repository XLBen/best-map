import { speciesOwner } from '../../core/biome-scripts';
import type { Command } from '../../core/commands';
import { SCRIPT_API } from '../../core/script';
import { SPECIES_SCRIPT_KINDS, type Species } from '../../core/species';
import { editsIdle, exec, replaceLast, toast, whenEditsIdle, world, worldEpoch } from '../state';
import { noteScriptCommitted } from './editor-hooks';
import { type ApplyMode, type ApplyResult, type ScriptProblem, normScript, problemOfIssue } from './script-commit';

// 生态编辑器（“高级：图案、效果与脚本”）怎样提交到世界上、怎样读回出错

export type SpeciesScriptKind = (typeof SPECIES_SCRIPT_KINDS)[number];

// ---------- 排队：按世界上最新的样子做出命令 ----------
// 大星球上一步要算一秒左右。连着点两个侵占目标、先拖“变暖”再拖“侵占强度”时，如果按界面上（还没更新的）旧样子
// 做补丁，后一步会把前一步改的冲掉（effects、scripts 都是整份替换）。所以这些改动排成一队：
// 前面的都算完、快照换上之后，再按那时世界上的这种生态做出补丁

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;

// 生态的改动都提交完了，引擎那边也没有别的改动在算
export function speciesEditsSettled(): boolean {
  return queued === 0 && editsIdle();
}

// 等到 speciesEditsSettled()
export async function settleSpeciesEdits(): Promise<void> {
  while (!speciesEditsSettled()) {
    await tail;
    await whenEditsIdle();
  }
}

// 排进队里：轮到时 make 拿到这种生态现在的样子，返回补丁（null：不用改）。世界换了、生态不在了就不做
export function queueSpeciesEdit(id: string, label: string, make: (sp: Species) => Record<string, unknown> | null): Promise<boolean> {
  const epoch = worldEpoch.value;
  queued++;
  const job = tail.then(async () => {
    await whenEditsIdle();
    if (worldEpoch.value !== epoch) return false;
    const sp = world.value?.small.species.find((s) => s.id === id);
    const patch = sp ? make(sp) : null;
    return patch ? exec({ op: 'update_species', id, patch }, label) : false;
  });
  const done = job.then(
    () => void queued--,
    () => void queued--,
  );
  tail = done;
  return job;
}

// ---------- 脚本 ----------

// 把这种生态的一段脚本换成 src（空的就去掉）。另一段照世界上现在的样子带上：
// 补丁里的 scripts 是整份，换掉上一次提交时也不会把另一个框的改动丢掉
export function speciesScriptCommand(sp: Species, kind: SpeciesScriptKind, src: string): Command {
  const scripts: Partial<Record<SpeciesScriptKind, { api: typeof SCRIPT_API; src: string }>> = {};
  for (const k of SPECIES_SCRIPT_KINDS) {
    const s = k === kind ? normScript(src) : (sp.scripts?.[k]?.src ?? '');
    if (s) scripts[k] = { api: SCRIPT_API, src: s };
  }
  return { op: 'update_species', id: sp.id, patch: { scripts: Object.keys(scripts).length ? scripts : null } };
}

const LABEL = '正在计算生态…';

// 提交：exec 新的一步，replace 换掉最后一步（只有这次编辑做的那一步还是最后一步时，调用方才会这样要）。
// 调用方先等 settleSpeciesEdits()：这时 world 就是引擎里的样子，另一个框刚提交的脚本也在里面。
// revert：换回上一次没出错的写法（不是用户这次写的，不报给信任列表）
export async function applySpeciesScript(id: string, kind: SpeciesScriptKind, src: string, mode: ApplyMode, revert = false): Promise<ApplyResult> {
  const sp = world.value?.small.species.find((s) => s.id === id);
  if (!sp) return { ok: false, error: '这种生态已经不在了' };
  const cmd = speciesScriptCommand(sp, kind, src);
  const ok = mode === 'exec' ? await exec(cmd, LABEL) : await replaceLast(cmd, LABEL);
  if (ok) {
    // 只报这次写的这一段：补丁里整份带着的另一段不是在这里写的（比如“不运行脚本打开”的别人的脚本），不能顺带信任
    if (!revert) noteScriptCommitted({ species: id, kind, src: normScript(src) });
    return { ok: true };
  }
  // 引擎拒绝了（出错的说明已经显示在顶上，这里也写在框下面）
  const t = toast.value;
  return { ok: false, error: t?.error ? t.text : '没有改成' };
}

// 世界上这种生态这段脚本现在出的错（d.scriptIssues 里找：先按 id，旧的说明没有 id 时按名字）
export function speciesIssue(id: string, kind: SpeciesScriptKind): ScriptProblem | null {
  const w = world.value;
  const list = w?.derived.scriptIssues;
  if (!w || !list?.length) return null;
  const sp = w.small.species.find((s) => s.id === id);
  const hit = list.find((i) => i.kind === kind && (i.id !== undefined ? i.id === id : !!sp && i.owner === speciesOwner(sp)));
  return hit ? problemOfIssue(hit) : null;
}
