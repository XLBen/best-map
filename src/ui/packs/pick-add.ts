import type { Command } from '../../../core/commands';
import type { ContentRef } from '../../../core/content/links';
import { type ImportAsk, type ImportOnto, type ImportPreview, type ImportTarget, type WorldImport, importCommand, importLabel, importToPack } from '../../../core/packs/closure';
import type { ResourcePack } from '../../../core/packs';
import type { SmallState } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { libEdits } from '../../library-edit';
import type { Content } from '../../regen-track';
import { type NoteAction, noteAction, worldEpoch } from '../../state';
import { queueWorld } from './page-actions';
import type { PageCtx, SourceRef } from './page-source';
import { lastPress } from './panel-store';
import { clearPicks, destFor, destRef, isFileSource, pickAsk, pickLead, picksOf } from './pick-store';
import { type RegenNeed, addRegenLabel, addedNeed, regenCommand } from './regen';

// 添加（第六十六轮）：把勾的写进本世界或我的库，一步，撤销全撤。世界里可以接着重新生成（“添加并重新生成国家”这类按钮）：
// 重新生成接在同一个 batch 的后面，所以一次撤销连添加一起撤掉；锁定的国家照旧不动（同面板顶上的“重新生成”，regen.ts）。
// 要不要重新生成、按钮叫什么，拿添加前后的内容比（regen.ts 的 addedNeed，用的是那里人文、国家、城市的同一张表）。
// 资源库面板按库记的勾选（addPicked；“从别的库加”的右栏也是它，上级页面打开的带 onto，第六十八轮）都走这里

// 一条命令之后世界里的内容（只看 set_content：从资源库加进世界的内容都是这一条）。算重新生成要用添加之后的内容：
// 新加的文化组要参与（regen.ts 的 beyondWeights 看世界里的组），库里生成要用的、世界里已经有了的不再加一遍
export function contentAfter(content: Content, cmd: Command): Content {
  let out = content;
  const one = (c: Command) => {
    if (c.op === 'batch') {
      for (const x of c.commands) one(x);
      return;
    }
    if (c.op !== 'set_content') return;
    const store = { ...((out?.[c.kind] ?? {}) as Record<string, unknown>) };
    if (c.item === null) delete store[c.id];
    else store[c.id] = c.item;
    out = { ...out, [c.kind]: store } as Content;
  };
  one(cmd);
  return out;
}

export interface WorldAdd extends WorldImport {
  // 添加之后要重新生成什么（按钮的字是 addRegenLabel(regen)）；不用时 null
  regen: RegenNeed | null;
}

type AddOpts = { path?: readonly string[]; onto?: ImportOnto; regen?: boolean; lead?: ContentRef };

// 添加进世界的命令。regen：需要时接上重新生成，成为一个 batch（撤销条写“添加“X”等 N 项，重新生成国家”）。lead：用户点的那一项（撤销条写它）
export function worldAddCommand(ask: ImportAsk, opts: AddOpts = {}, lib: readonly LibraryEntry[] = []): WorldAdd {
  if (ask.target.t !== 'world') throw new Error('worldAddCommand 只给世界用');
  const r = importCommand(ask, opts);
  if (!r.command) return { ...r, regen: null };
  const small = ask.target.world.small as SmallState;
  const after = contentAfter(small.content, r.command);
  const need = addedNeed(small, after, lib);
  if (!opts.regen || !need) return { ...r, regen: need };
  const regen = regenCommand(need, { ...small, content: after }, lib);
  const tail = regen.op === 'batch' ? regen.commands : [regen];
  return { ...r, regen: need, command: { op: 'batch', label: `${r.command.label ?? '添加'}，${need.label}`, commands: [...r.command.commands, ...tail] } };
}

// “添加并重新生成…”按钮的字：加到世界、加的东西要重新生成才用得上、世界生成过那一样时才有；别的时候 null
export function addRegenButton(ask: ImportAsk | null, lib: readonly LibraryEntry[] = []): string | null {
  if (!ask || ask.target.t !== 'world' || !ask.picks.length) return null;
  return addRegenLabel(worldAddCommand(ask, {}, lib).regen);
}

export interface AddDone {
  ok: boolean;
  count: number;
  error?: string;
  // 写入时带不了、跳过的
  skipped?: ImportPreview['dropped'];
  // 接着重新生成了
  regen?: boolean;
  // 写进去的各项（来源里的种类和 id：刚加的行闪一下、“去看看”高亮）
  rows?: ContentRef[];
}

export interface AddRequest extends AddOpts {
  ask: ImportAsk;
  // 加到哪里（本世界、我的库）
  target: SourceRef;
  // 提示条上“去看看”
  look?: NoteAction;
}

// 跳过的项写成一句：一个原因时“还有 3 项需要意识形态，没加”，别的“还有 3 项没加：政体最多 128 个”
export function skippedLine(dropped: ImportPreview['dropped']): string | null {
  if (!dropped.length) return null;
  const reasons = [...new Set(dropped.map((d) => d.reason))];
  if (reasons.length === 1 && reasons[0].startsWith('需要')) return `还有 ${dropped.length} 项${reasons[0]}，没加`;
  // 几种“需要”写不下：每一行上写着各自的原因
  if (reasons.every((x) => x.startsWith('需要'))) return `还有 ${dropped.length} 项缺别的内容，没加`;
  return `还有 ${dropped.length} 项没加：${reasons.slice(0, 2).join('；')}${reasons.length > 2 ? ' 等' : ''}`;
}

// 加完顶上那句：“已添加“社会主义共和国”等 19 项”，跳过了的接在后面
export const doneHead = (label: string, dropped: ImportPreview['dropped']): string => [`已${label}`, skippedLine(dropped)].filter(Boolean).join('。');

const refsOf = (p: ImportPreview): ContentRef[] => p.rows.map((r) => ({ kind: r.kind, id: r.id }));

// 写进去：世界里一个 batch（按点的时候最新的世界算），库里一次 setPack。都在顶上说一句（带“去看看”、撤销）
export async function runAdd(req: AddRequest, ctx: PageCtx): Promise<AddDone> {
  const { ask, onto, lead } = req;
  if (req.target.t === 'world') {
    let count = 0;
    let skipped: ImportPreview['dropped'] = [];
    let rows: ContentRef[] = [];
    let regen = false;
    let label = '';
    const ok = await queueWorld(
      (w) => {
        const r = worldAddCommand({ ...ask, target: { t: 'world', world: w } }, { ...(req.path ? { path: req.path } : {}), ...(onto ? { onto } : {}), ...(lead ? { lead } : {}), regen: !!req.regen }, ctx.lib);
        count = r.preview.count;
        skipped = r.preview.dropped;
        rows = refsOf(r.preview);
        regen = !!req.regen && !!r.regen;
        label = r.command?.label ?? '';
        return r.command;
      },
      req.regen ? '正在添加并重新生成…' : '正在添加…',
      () => ({ head: doneHead(label, skipped), ...(req.look ? { action: req.look } : {}) }),
    );
    return { ok, count, skipped, rows, ...(regen ? { regen } : {}) };
  }
  const key = req.target.key;
  const r = importToPack(ask, onto ? { onto } : {});
  if (r.pack === (ask.target as Extract<ImportTarget, { t: 'pack' }>).pack) return { ok: true, count: 0, skipped: r.preview.dropped };
  // 写用户点的那一项；它不在清单里时（加到库里的变量是跟着时代来的）写项数
  const label = lead && r.preview.rows.some((x) => x.kind === lead.kind && x.id === lead.id) ? importLabel(r.preview, lead) : `添加 ${r.preview.count} 项`;
  const done = libEdits.setPack(key, r.pack as ResourcePack, label);
  if (!done.ok) return { ok: false, count: 0, error: done.error };
  lastPress.inPanel = true;
  noteAction(doneHead(label, r.preview.dropped), req.look, () => void libEdits.undo(key));
  return { ok: true, count: r.preview.count, skipped: r.preview.dropped, rows: refsOf(r.preview) };
}

// 资源库面板清单的“添加 N 项”“添加并重新生成…”：把这个库勾的加到它的目的地，成功后清掉这个库的勾选。撤销条写用户点的那一项（pickLead）。
// onto：上级页面“从别的库加”打开的，勾的这一种都放到上级下面（同一步）
export async function addPicked(key: string, ctx: PageCtx, opts: { regen?: boolean; look?: NoteAction; onto?: ImportOnto } = {}): Promise<AddDone> {
  const dest = destFor(key, ctx);
  const ask = dest && pickAsk(key, ctx, dest);
  if (!dest || !ask) return { ok: false, count: 0, error: '来源或目的地不在了' };
  const epoch = worldEpoch.value;
  const lead = pickLead(picksOf(key));
  const r = await runAdd({ ask, target: destRef(dest), ...(isFileSource(key) ? {} : { path: [key] }), ...(lead ? { lead } : {}), regen: !!opts.regen, ...(opts.look ? { look: opts.look } : {}), ...(opts.onto ? { onto: opts.onto } : {}) }, ctx);
  if (r.ok && worldEpoch.value === epoch) clearPicks(key);
  return r;
}
