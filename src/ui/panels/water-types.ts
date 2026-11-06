import type { Command } from '../../../core/commands';
import { LAKE_STYLES, LAKE_STYLE_LABEL } from '../../../core/lake-types';
import { RIVER_STYLES, RIVER_STYLE_LABEL } from '../../../core/river-types';
import { SCRIPT_API } from '../../../core/script';
import type { WaterType } from '../../../core/water-types';
import type { World } from '../../../core/world';
import { editsIdle, exec, openPanel, replaceLast, toast, trustHandledElsewhere, waterTypeEditorRequest, whenEditsIdle, world, worldEpoch } from '../../state';
import { noteScriptCommitted } from '../editor-hooks';
import { type ApplyMode, type ApplyResult, type ScriptProblem, normScript, problemOfIssue } from '../script-commit';

// 水体类型（waterTypes.tsx）的逻辑：河、湖两种的说明，新建并用上，连着改几项时排队，规则脚本的提交与出错

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

// 新的一种：id 不与已有的重复；颜色轮着取
const NEW_COLORS = ['#b03a2e', '#2a7fbf', '#7a4fb0', '#c47f17', '#2e8b57', '#d4508a'];
export function newWaterType(w: World, kind: WaterKind): WaterType {
  const def = KINDS[kind];
  const ids = new Set(def.list(w).map((t) => t.id));
  let k = 1;
  while (ids.has(`${def.idPrefix}-${k}`)) k++;
  // 新建的默认不自然生成（第十二轮）：只用在画的河、选了它的河（湖）上，打开“自然生成”才按条件自己出现
  return { id: `${def.idPrefix}-${k}`, name: `新的${def.noun} ${k}`, color: NEW_COLORS[(k - 1) % NEW_COLORS.length], natural: false };
}

// 新建一种并用上：then 是用上它的命令（新画的河、新放的湖只改选项，没有命令）。一整步，然后打开它的编辑
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
  waterTypeEditorRequest.value = { kind, id: t.id };
  openPanel.value = 'cat:water';
}

// ---------- 编辑：排队按最新的样子做出命令 ----------
// 大星球上一步要算一会儿：连着改几项时，后一步按前一步算完之后世界上的这种类型做出整份（set_*_type 是整份换掉）

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;

export const typeEditsSettled = () => queued === 0 && editsIdle();
export async function settleTypeEdits(): Promise<void> {
  while (!typeEditsSettled()) {
    await tail;
    await whenEditsIdle();
  }
}

export function queueTypeEdit(kind: WaterKind, id: string, label: string, make: (t: WaterType) => WaterType | null): Promise<boolean> {
  const epoch = worldEpoch.value;
  queued++;
  const job = tail.then(async () => {
    await whenEditsIdle();
    const w = world.value;
    if (worldEpoch.value !== epoch || !w) return false;
    const t = KINDS[kind].list(w).find((x) => x.id === id);
    const next = t ? make(structuredClone(t)) : null;
    return next ? exec(KINDS[kind].set(next), label) : false;
  });
  tail = job.then(
    () => void queued--,
    () => void queued--,
  );
  return job;
}

// 去掉值为 undefined 的项（存进命令的 JSON 里不留空项）
export function clean(t: WaterType): WaterType {
  const out = { ...t } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (t.bank) {
    const b = { ...t.bank } as Record<string, unknown>;
    for (const k of Object.keys(b)) if (b[k] === undefined || b[k] === 0) delete b[k];
    out.bank = b;
  }
  return out as unknown as WaterType;
}

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
