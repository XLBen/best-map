import { speciesOwner } from '../../core/biome-scripts';
import type { Command } from '../../core/commands';
import { SCRIPT_API } from '../../core/script';
import { SPECIES_SCRIPT_KINDS, type Species } from '../../core/species';
import { exec, replaceLast, toast, world } from '../state';
import { noteScriptCommitted } from './editor-hooks';
import { type ApplyMode, type ApplyResult, type ScriptProblem, normScript, problemOfIssue } from './script-commit';

// 生态的两个脚本框（长在哪里、颜色）怎样提交到世界上、怎样读回出错

export type SpeciesScriptKind = (typeof SPECIES_SCRIPT_KINDS)[number];

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

// 提交：exec 新的一步，replace 换掉最后一步（只有这次编辑做的那一步还是最后一步时，调用方才会这样要）
export async function applySpeciesScript(id: string, kind: SpeciesScriptKind, src: string, mode: ApplyMode): Promise<ApplyResult> {
  const sp = world.value?.small.species.find((s) => s.id === id);
  if (!sp) return { ok: false, error: '这种生态已经不在了' };
  const cmd = speciesScriptCommand(sp, kind, src);
  const ok = mode === 'exec' ? await exec(cmd, LABEL) : await replaceLast(cmd, LABEL);
  if (ok) {
    noteScriptCommitted(cmd);
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
