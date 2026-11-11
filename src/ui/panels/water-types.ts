import type { Command } from '../../../core/commands';
import { LAKE_STYLES, LAKE_STYLE_LABEL } from '../../../core/lake-types';
import { RIVER_STYLES, RIVER_STYLE_LABEL } from '../../../core/river-types';
import { SCRIPT_API } from '../../../core/script';
import type { WaterType } from '../../../core/water-types';
import type { World } from '../../../core/world';
import { kindOf } from '../../../core/content/registry';
import { editsIdle, exec, openPanel, replaceLast, toast, trustHandledElsewhere, whenEditsIdle, world } from '../../state';
import { noteScriptCommitted } from '../editor-hooks';
import { blankItem } from '../packs/fields';
import { openWorldItem } from '../packs/panel-store';
import { type ApplyMode, type ApplyResult, type ScriptProblem, normScript, problemOfIssue } from '../script-commit';

// 水体类型（waterTypes.tsx）的逻辑：河、湖两种的说明，新建并用上，规则脚本的提交与出错。
// 第九十三轮：“水系 ⋯”里另一个编辑器并进了资源库里这一种的页面（只有一处能改）：这里以前给它排队的 queueTypeEdit、clean 去掉了，
// 新建之后直达那一页；规则的脚本框（WaterScript.tsx）照旧用这里的 applyMatch、matchIssue

export type WaterKind = 'river' | 'lake';

export interface KindDef {
  kind: WaterKind;
  noun: '河' | '湖';
  // “河流类型”“湖泊类型”
  title: string;
  styles: readonly string[];
  styleLabel: Record<string, string>;
  // 有没有“粗细”（只有河有）
  width: boolean;
  list(w: World): readonly WaterType[];
  set(t: WaterType): Command;
  remove(id: string): Command;
  busy: string;
  // 资源库里的种类（第二十八轮：血河、晶川……这些示例在资源库里，从那里添加到本世界）
  library: 'riverType' | 'lakeType';
  idPrefix: string;
  matchLabel: string;
  matchHint: string;
  intro: string;
  namesHint: string;
}

export const KINDS: Record<WaterKind, KindDef> = {
  river: {
    kind: 'river',
    noun: '河',
    title: '河流类型',
    styles: RIVER_STYLES,
    styleLabel: RIVER_STYLE_LABEL,
    width: true,
    list: (w) => w.small.riverTypes ?? [],
    set: (t) => ({ op: 'set_river_type', type: t as never }),
    remove: (id) => ({ op: 'remove_river_type', id }),
    busy: '正在计算…',
    library: 'riverType',
    idPrefix: 'river-type',
    matchLabel: '哪些自然的河是这一种',
    matchHint: '每条河算一次，返回真就是这一种',
    intro: '没有河流类型',
    namesHint: '{color}血河',
  },
  lake: {
    kind: 'lake',
    noun: '湖',
    title: '湖泊类型',
    styles: LAKE_STYLES,
    styleLabel: LAKE_STYLE_LABEL,
    width: false,
    list: (w) => w.small.lakeTypes ?? [],
    set: (t) => ({ op: 'set_lake_type', type: t as never }),
    remove: (id) => ({ op: 'remove_lake_type', id }),
    busy: '正在计算…',
    library: 'lakeType',
    idPrefix: 'lake-type',
    matchLabel: '哪些自然的湖是这一种',
    matchHint: '每个湖算一次，返回真就是这一种',
    intro: '没有湖泊类型',
    namesHint: '{color}血池',
  },
};

// 新的一种：和资源库列表上的“新建”同一个样子、同一种 id（packs/fields.ts 的 blankItem：my-river、my-river-2……，
// 第九十三轮以前这里另起 river-type-1），只是颜色轮着取。
// 第九十轮：新建的自然生成开着：选了生态、写了条件或规则就按它自己出现，什么都没写时只用在画的、选了它的上
const NEW_COLORS = ['#b03a2e', '#2a7fbf', '#7a4fb0', '#c47f17', '#2e8b57', '#d4508a'];
export function newWaterType(w: World, kind: WaterKind): WaterType {
  const def = KINDS[kind];
  const all = def.list(w);
  const blank = blankItem(kindOf(def.library)!, new Set(all.map((t) => t.id)))!;
  return { ...(blank as unknown as WaterType), color: NEW_COLORS[all.length % NEW_COLORS.length] };
}

// 新建一种并用上：then 是用上它的命令（新画的河、新放的湖只改选项，没有命令）。一整步，然后打开资源库里这一种的页面
export async function createAndUse(kind: WaterKind, use: ((id: string) => Command | null) | null, after?: (id: string) => void): Promise<void> {
  const w = world.value;
  if (!w) return;
  openPanel.value = null;
  const t = newWaterType(w, kind);
  const def = KINDS[kind];
  const then = use?.(t.id) ?? null;
  const cmd: Command = then ? { op: 'batch', label: `新建${def.title}“${t.name}”`, commands: [def.set(t), then] } : def.set(t);
  const ok = await exec(cmd, def.busy);
  if (!ok) return;
  after?.(t.id);
  openWorldItem(def.library, t.id);
}

// ---------- 脚本框问“排着的编辑都做完了没有” ----------
// 资源库页面上别的字段改了是排着队发命令的（packs/page-actions.ts 的 queueWorld：等前一步算完）；脚本框等它们都算完再提交

export const typeEditsSettled = () => editsIdle();
export const settleTypeEdits = (): Promise<void> => whenEditsIdle();

// match 脚本换成 src（空的就去掉）
export function typeScriptCommand(kind: WaterKind, t: WaterType, src: string): Command {
  const s = normScript(src);
  const next = { ...t } as WaterType;
  if (s) next.scripts = { match: { api: SCRIPT_API, src: s } };
  else delete next.scripts;
  return KINDS[kind].set(next);
}

// 提交规则脚本。信任与生态的脚本框一样只记框里写的这一段（同一步里被换掉的中间版本会去掉，见 trust.ts 的 trustDraft）；
// revert：出错后换回旧写法，不报给信任列表
export async function applyMatch(kind: WaterKind, id: string, src: string, mode: ApplyMode, revert = false): Promise<ApplyResult> {
  const w = world.value;
  const def = KINDS[kind];
  const t = w ? def.list(w).find((x) => x.id === id) : undefined;
  if (!t) return { ok: false, error: `这种${def.noun}已删除` };
  const before = t.scripts?.match?.src ?? '';
  const cmd = trustHandledElsewhere(typeScriptCommand(kind, t, src));
  const ok = mode === 'exec' ? await exec(cmd, def.busy) : await replaceLast(cmd, def.busy);
  if (ok) {
    if (!revert) noteScriptCommitted({ species: `${kind}:${id}`, kind: 'match', src: normScript(src), before, mode });
    return { ok: true };
  }
  const x = toast.value;
  return { ok: false, error: x?.error ? x.text : '没改成' };
}

// 世界上这种的 match 脚本现在出的错
export function matchIssue(id: string, name: string): ScriptProblem | null {
  const list = world.value?.derived.scriptIssues?.filter((i) => i.kind === 'match' && i.id === id) ?? [];
  const hit = list.find((i) => i.owner === name) ?? list[0];
  return hit ? problemOfIssue(hit) : null;
}
