import type { Command } from '../../core/commands';
import { checkDoc } from '../../core/doc-version';
import type { WorldDoc } from '../../core/engine';
import { type FoundScript, findScripts } from '../../core/script';
import type { Settings } from '../../core/world';
import { buildKey } from '../engine-source';
import { idbMapStore, mapLink, mapSavedState } from '../maps';
import type { Request, Response } from '../protocol';
import { clearLoading, markLoading, readLoading, tidyTrusted, uniqueScripts } from '../trust';
import { askUser } from './ask';
import { type Autosaved, autosaveNow, noteNotResumed, noteResumed, readAutosave, resetAutosaveIds } from './autosave';
import { download } from './export-host';
import { prebuildMesh } from './mesh';
import { changeNote, flash, noteSkipped, showToast, skippedNote } from './notes';
import { askTrust } from './script-trust';
import { call, currentHost, engineHost, getDoc, handle, hostOpts, safeMode, whenEditsIdle } from './worker-host';
import { worldEpoch, worldState } from './world';

// 新建、打开世界（第七十轮从 state.ts 分出来）：带脚本时先查信任，安全模式；继续上次的世界、“再试一次”

// 打开时选了“不运行脚本”
const SAFE_CHOSEN = '打开时选了不运行脚本';

// 新建、打开完：标上是不是安全模式；正常打开时整理信任列表（当前世界的留着）
function afterOpen(r: Response, scripts: FoundScript[]) {
  const safe = r.ok && r.safe === true;
  if (r.ok) noteSkipped(r.skipped);
  safeMode.value = safe ? { reason: engineHost().safeReason ?? SAFE_CHOSEN } : null;
  if (!safe) void tidyTrusted(scripts);
}

export interface OpenOptions {
  // 用安全模式打开（脚本不运行），值是原因（横幅里写）
  safe?: string;
  // 镜头不动（“再试一次”打开的是同一个世界）
  keepView?: boolean;
  // 打不开时不在顶上弹出原因（调用方自己说：继续上次的世界没打开时停在一个问话上）
  quiet?: boolean;
}

// 打开的结果：打开了；用户取消了（不信任脚本时点了取消）；没能打开（原因）
export type OpenResult = { ok: true } | { ok: false; cancelled: true } | { ok: false; cancelled?: undefined; error: string };

// 新建、打开：带脚本时先查信任（没见过的问用户）；正常打开带脚本的世界期间记下标记（页面停止响应后下次启动时先问）。
// 不带脚本时与以前一样立刻发给 Worker
async function open(req: Extract<Request, { kind: 'init' | 'load' }>, label: string, opts: OpenOptions, verb: '打开' | '新建', settings: Partial<Settings>): Promise<OpenResult> {
  // 新建时设置也一起查（脚本可能出现在任何地方：findScripts 找的是所有叫 scripts 的容器）
  const scripts = uniqueScripts(findScripts(req.kind === 'init' ? [req.settings, req.commands] : req.doc));
  // 没有脚本的世界不用安全模式（安全模式只是不运行脚本；比如在安全模式里把脚本都删了，自动保存还记着安全模式）
  let safe = scripts.length ? (opts.safe ?? null) : null;
  if (safe === null && scripts.length) {
    const d = await askTrust(scripts, verb);
    if (d === 'cancel') return { ok: false, cancelled: true };
    if (d === 'safe') safe = SAFE_CHOSEN;
  }
  changeNote.value = null;
  skippedNote.value = null;
  if (req.kind === 'init') flash.value = null;
  const marked = safe === null && scripts.length > 0;
  if (marked) await markLoading(scripts.map((s) => s.hash));
  // 检查点的版本号（开发时要先取引擎文件算哈希；页面里才有）
  if (typeof document !== 'undefined') hostOpts.build = await buildKey();
  let meshReady: Promise<void> = Promise.resolve();
  let ok = false;
  let error = '没能打开';
  // 等网格、换上快照都在 call 的 after 里：做完之前新建、打开一直算在 pending、busy 里（见 call）
  const r = call(safe === null ? req : { ...req, safe: true }, label, safe ?? undefined, async (res) => {
    await meshReady;
    if (marked) void clearLoading();
    // 新的引擎（可能在新开的 Worker 里）：步号从 1 起，自动保存从头写（镜头不动时世界的纪元不变，要在这里清）
    if (res.ok) resetAutosaveIds();
    // 第三个参数：引擎是新的，“上一次生成时的内容”从这份回复里带的重新起头（镜头不动的“再试一次”也是）
    if (!res.ok) error = res.error;
    ok = await handle(res, !opts.keepView, true, opts.quiet);
    if (ok) afterOpen(res, scripts);
  });
  meshReady = prebuildMesh(settings, hostOpts.build);
  await r;
  return ok ? { ok: true } : { ok: false, error };
}

export async function newWorld(settings: Partial<Settings>, commands: Command[], opts: OpenOptions = {}) {
  return (await open({ kind: 'init', settings, commands }, '正在生成世界…', opts, '新建', settings)).ok;
}

// 打开世界：世界文件、自动保存（连同检查点）、“再试一次”都经过这里，带脚本时统一查信任。
// 不是世界文件、是旧版本的世界（第九轮起不再兼容）时直接说打不开，不去重放
export async function loadDoc(doc: WorldDoc, opts: OpenOptions = {}) {
  return (await openDoc(doc, opts)).ok;
}
// 同上，另说是取消了还是没能打开（原因）
export async function openDoc(doc: WorldDoc, opts: OpenOptions = {}): Promise<OpenResult> {
  try {
    checkDoc(doc);
  } catch (e) {
    if (!opts.quiet) showToast((e as Error).message, true);
    return { ok: false, error: (e as Error).message };
  }
  return open({ kind: 'load', doc }, '正在打开世界…', opts, '打开', doc.settings);
}

// 继续上次的世界（启动时、向导里）：读自动保存，上次是安全模式就照样用安全模式打开。
// 上次正常打开带脚本的世界时页面停止了响应（标记还在、是这个世界的脚本）：先问要不要用安全模式。没有自动保存时返回 null。
// 第九十四轮：没能打开（重放出错、计算程序出错……）时不直接进向导——停在一个问话上：再试一次、用安全模式打开（有脚本时）、
// 导出文件、新建。那一份自动保存原样在原处；选了新建，新世界第一次自动保存之前它被挪进“留着的旧世界”（autosave-io.ts）。
// 用户自己取消（不信任脚本时点了取消）不算打不开：照旧返回 false（进向导），同样在被盖掉之前留着
export async function resumeLast(): Promise<boolean | null> {
  const saved = await readAutosave();
  if (!saved) return null;
  let safe = saved.safe ?? null;
  const scripts = findScripts(saved.doc);
  const mark = await readLoading();
  if (mark) {
    await clearLoading();
    const mine = new Set(scripts.map((s) => s.hash));
    if (safe === null && mark.hashes.some((h) => mine.has(h))) {
      const v = await askUser({
        title: '上次打开时停止了响应',
        text: '安全模式下脚本不运行。',
        choices: [
          { value: 'safe', label: '用安全模式打开', primary: true },
          { value: 'run', label: '照常打开' },
        ],
      });
      if (v !== 'run') safe = '上次打开时程序停止了响应';
    }
  }
  for (;;) {
    const r = await openDoc(saved.doc, { ...(safe !== null ? { safe } : {}), quiet: true });
    if (r.ok) {
      noteResumed(saved);
      if (saved.mapId) await relink(saved.mapId, saved.mapSynced ? 0 : saved.savedAt);
      return true;
    }
    if (r.cancelled) {
      noteNotResumed('cancelled');
      return false;
    }
    noteNotResumed('failed', r.error);
    const v = await askResumeFailed(saved, r.error, scripts.length > 0 && safe === null);
    if (v === 'safe') safe = SAFE_AFTER_FAIL;
    else if (v !== 'retry') return false;
  }
}

const SAFE_AFTER_FAIL = '上次的世界没能打开';
// 上次的世界没能打开：问怎么办。导出文件之后接着问（文件已经在下载里了，世界还在浏览器里）
export const RESUME_FAILED = {
  title: '上次的世界没能打开',
  text: '它还存在这个浏览器里，没有丢。可以再试一次，或者先导出成世界文件。',
  textScripts: '它还存在这个浏览器里，没有丢。可以再试一次、不运行脚本打开，或者先导出成世界文件。',
  exported: '已导出。它也还存在这个浏览器里；新建以后在“世界 → 留着的旧世界”里找。',
  reason: '原因',
  retry: '再试一次',
  safe: '用安全模式打开',
  export: '导出文件',
  fresh: '新建',
} as const;
// 导出的文件名：“上次的世界 2026-11-11.json”
export function resumeFileName(savedAt: number): string {
  const d = new Date(savedAt);
  const two = (n: number) => String(n).padStart(2, '0');
  return `上次的世界 ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.json`;
}
async function askResumeFailed(saved: Autosaved, error: string, canSafe: boolean): Promise<'retry' | 'safe' | 'new'> {
  const T = RESUME_FAILED;
  let exported = false;
  for (;;) {
    const v = await askUser({
      title: T.title,
      text: exported ? T.exported : canSafe ? T.textScripts : T.text,
      // 原因原样写一行（能选中、复制，问别人时用）
      note: { label: T.reason, text: error },
      choices: [
        { value: 'retry', label: T.retry, primary: true },
        ...(canSafe ? [{ value: 'safe', label: T.safe }] : []),
        { value: 'export', label: T.export },
        { value: 'new', label: T.fresh },
      ],
    });
    if (v === 'retry' || v === 'safe') return v;
    if (v !== 'export') return 'new';
    download(resumeFileName(saved.savedAt), JSON.stringify(saved.doc), 'application/json');
    exported = true;
  }
}

// 打开上次的世界后：它连着“我的地图”里的一张就接着连上（那一张不在了就不连）。
// 那一张比自动保存旧（上次写完自动保存、还没来得及写它就关了页面）：马上补写一次。
// autosavedAt：自动保存的时间；写自动保存时那一张已经相同（只是打开了它，没改）时为 0
async function relink(id: string, autosavedAt: number) {
  try {
    const e = await idbMapStore.entry(id);
    if (!e) return;
    mapLink.value = { id, name: e.name, epoch: worldEpoch.value };
    mapSavedState.value = e.savedAt >= autosavedAt ? worldState.value : -1;
    if (mapSavedState.value < 0) void autosaveNow();
  } catch {
    // 读不了就当没连着
  }
}

// 安全模式横幅的“再试一次”：另开一个 Worker，脚本照常运行（没信任过的照样先问）。
// 先等排着的改动算完再取世界：比如脚本框里刚写的一段，点按钮时离开框就提交了，还在算；
// 不等的话取到的世界里没有它，重新打开后这一段就丢了
export async function retryScripts(): Promise<boolean> {
  await whenEditsIdle();
  const doc = currentHost()?.mirror.doc() ?? (await getDoc());
  return doc ? loadDoc(doc, { keepView: true }) : false;
}
