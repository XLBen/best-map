import type { Command } from '../../../core/commands';
import { type ImportAsk, type ImportOnto, type ImportPreview, type ImportTarget, type WorldImport, importCommand, importToPack } from '../../../core/packs/closure';
import type { ResourcePack } from '../../../core/packs';
import type { SmallState } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { libEdits } from '../../library-edit';
import type { Content } from '../../regen-track';
import { worldEpoch } from '../../state';
import { queueWorld } from './page-actions';
import type { PageCtx, SourceRef } from './page-source';
import { lastPress } from './panel-store';
import { clearPicks, destRef, isFileSource, pickAsk, pickDest } from './pick-store';
import { type RegenNeed, addRegenLabel, addedNeed, regenCommand } from './regen';

// 添加（第六十六轮）：把勾的写进本世界或我的库，一步，撤销全撤。世界里可以接着重新生成（“添加并重新生成国家”这类按钮）：
// 重新生成接在同一个 batch 的后面，所以一次撤销连添加一起撤掉；锁定的国家照旧不动（同面板顶上的“重新生成”，regen.ts）。
// 要不要重新生成、按钮叫什么，拿添加前后的内容比（regen.ts 的 addedNeed，用的是那里人文、国家、城市的同一张表）。
// 导入窗口（page-import.ts 的 runImport）和资源库面板按库记的勾选（addPicked）都走这里

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

// 添加进世界的命令。regen：需要时接上重新生成，成为一个 batch（撤销条写“添加“X”等 N 项，重新生成国家”）
export function worldAddCommand(ask: ImportAsk, opts: { path?: readonly string[]; onto?: ImportOnto; regen?: boolean } = {}, lib: readonly LibraryEntry[] = []): WorldAdd {
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
}

export interface AddRequest {
  ask: ImportAsk;
  // 加到哪里（本世界、我的库）
  target: SourceRef;
  // 来源在资源库里的路径（记进世界的来源）；读进来的文件没有
  path?: readonly string[];
  onto?: ImportOnto;
  regen?: boolean;
}

// 写进去：世界里一个 batch（按点的时候最新的世界算），库里一次 setPack
export async function runAdd(req: AddRequest, ctx: PageCtx): Promise<AddDone> {
  const { ask, onto } = req;
  if (req.target.t === 'world') {
    let count = 0;
    let skipped: ImportPreview['dropped'] = [];
    let regen = false;
    const ok = await queueWorld((w) => {
      const r = worldAddCommand({ ...ask, target: { t: 'world', world: w } }, { ...(req.path ? { path: req.path } : {}), ...(onto ? { onto } : {}), regen: !!req.regen }, ctx.lib);
      count = r.preview.count;
      skipped = r.preview.dropped;
      regen = !!req.regen && !!r.regen;
      return r.command;
    }, req.regen ? '正在添加并重新生成…' : '正在添加…');
    return { ok, count, skipped, ...(regen ? { regen } : {}) };
  }
  const key = req.target.key;
  const r = importToPack(ask, onto ? { onto } : {});
  if (r.pack === (ask.target as Extract<ImportTarget, { t: 'pack' }>).pack) return { ok: true, count: 0, skipped: r.preview.dropped };
  const done = libEdits.setPack(key, r.pack as ResourcePack, `添加 ${r.preview.count} 项`);
  if (!done.ok) return { ok: false, count: 0, error: done.error };
  lastPress.inPanel = true;
  return { ok: true, count: r.preview.count, skipped: r.preview.dropped };
}

// 资源库面板的“添加 N 项”“添加并重新生成…”（第六十七轮接到清单上）：把这个库勾的加到选的目的地，成功后清掉这个库的勾选
export async function addPicked(key: string, ctx: PageCtx, opts: { regen?: boolean } = {}): Promise<AddDone> {
  const dest = pickDest(ctx);
  const ask = dest && pickAsk(key, ctx, dest);
  if (!dest || !ask) return { ok: false, count: 0, error: '来源或目的地不在了' };
  const epoch = worldEpoch.value;
  const r = await runAdd({ ask, target: destRef(dest), ...(isFileSource(key) ? {} : { path: [key] }), regen: !!opts.regen }, ctx);
  if (r.ok && worldEpoch.value === epoch) clearPicks(key);
  return r;
}
