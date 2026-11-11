import type { Command } from '../../core/commands';
import { checkDoc } from '../../core/doc-version';
import type { WorldDoc } from '../../core/engine';
import { type FoundScript, findScripts } from '../../core/script';
import type { Settings } from '../../core/world';
import { crashState } from '../crash-host';
import { humanError } from '../error-text';
import { OPEN_TWICE_TEXT, STOP_TEXT } from '../crash-text';
import { buildKey } from '../engine-source';
import { idbMapStore, mapLink, mapSavedState } from '../maps';
import { OPEN_SETTLE_MS, askBeforeOpen, beginOpen, endOpen, readOpenMark } from '../open-guard';
import type { Request, Response } from '../protocol';
import { clearLoading, markLoading, readLoading, tidyTrusted, uniqueScripts } from '../trust';
import { askUser } from './ask';
import { type Autosaved, autosaveNow, noteNotResumed, noteResumed, readAutosave, resetAutosaveIds } from './autosave';
import { download } from './export-host';
import { prebuildMesh } from './mesh';
import { changeNote, flash, noteSkipped, showToast, skippedNote } from './notes';
import { askTrust } from './script-trust';
import { keepVersion, noteMapSeen } from './versions';
import { call, currentHost, engineHost, getDoc, handle, hostOpts, safeMode, whenEditsIdle } from './worker-host';
import { world, worldEpoch, worldState } from './world';

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

// 打开的结果：打开了；用户取消了（不信任脚本时点了取消）；没能打开（原因）。
// stopped（第九十六轮）：正在打开时用户点了“停止”（计算程序被停下了，不是打不开）
export type OpenResult = { ok: true } | { ok: false; cancelled: true } | { ok: false; cancelled?: undefined; error: string; stopped?: boolean };

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
  let stopped = false;
  // 等网格、换上快照都在 call 的 after 里：做完之前新建、打开一直算在 pending、busy 里（见 call）
  const r = call(safe === null ? req : { ...req, safe: true }, label, safe ?? undefined, async (res) => {
    // 没打开成（出错、被取消）的不等它的网格（第九十七轮）：取消了新建以后，提示不该还挂着等一张用不上的网格
    if (res.ok) await meshReady;
    if (marked) void clearLoading();
    // 新的引擎（可能在新开的 Worker 里）：步号从 1 起，自动保存从头写（镜头不动时世界的纪元不变，要在这里清）
    if (res.ok) resetAutosaveIds();
    // 第三个参数：引擎是新的，“上一次生成时的内容”从这份回复里带的重新起头（镜头不动的“再试一次”也是）
    if (!res.ok) {
      error = res.error;
      stopped = res.stopped === true;
    }
    ok = await handle(res, !opts.keepView, true, opts.quiet);
    if (ok) afterOpen(res, scripts);
  });
  meshReady = prebuildMesh(settings, hostOpts.build);
  await r;
  // 被停下、而原来没有世界可回（向导里新建到一半）：这里说一句（有世界时恢复那边说“回到了这一步之前”）
  if (stopped && !opts.quiet && !world.peek()) showToast(error);
  return ok ? { ok: true } : { ok: false, error, ...(stopped ? { stopped } : {}) };
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
// 用户自己取消（不信任脚本时点了取消）不算打不开：照旧返回 false（进向导），同样在被盖掉之前留着。
// 第九十六轮：
//   - 正在打开时用户点了“停止”：和取消一样（那一份留着，进向导；向导上面“继续上次的世界”还在）；
//   - 连着两次动手打开都没打开成（页面出了问题、卡住被关掉、被停下——../open-guard.ts 记在 localStorage 里）：这一次先问，
//     就是没能打开时的那一个问话（再试一次 / 用安全模式打开 / 导出文件 / 新建），不直接再打开一遍
export async function resumeLast(): Promise<boolean | null> {
  const saved = await readAutosave();
  if (!saved) return null;
  let safe = saved.safe ?? null;
  const scripts = findScripts(saved.doc);
  const guard = guardStore();
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
  if (askBeforeOpen(readOpenMark(guard, saved.savedAt))) {
    const v = await askResumeFailed(saved, null, scripts.length > 0 && safe === null);
    if (v === 'safe') safe = SAFE_AFTER_FAIL;
    else if (v !== 'retry') {
      // 选了新建：那一份在被新世界盖掉之前留着（原因写连着两次没打开成）；记的那几笔擦掉
      noteNotResumed('failed', OPEN_TWICE_TEXT.why);
      endOpen(guard);
      return false;
    }
  }
  for (;;) {
    // 要动手了：记一笔。打开成了、明白地没打开才擦掉；页面就此出了问题、被停下，这一笔留着
    beginOpen(guard, saved.savedAt, Date.now());
    const r = await openDoc(saved.doc, { ...(safe !== null ? { safe } : {}), quiet: true });
    if (r.ok) {
      // 打开了：过几秒界面没有坏才算数（世界一画出来整个界面就坏的，下次不能再照样打开）
      setTimeout(() => {
        if (!crashState.fatal) endOpen(guard);
      }, openSettle.ms);
      noteResumed(saved);
      if (saved.mapId) await relink(saved.mapId, saved.mapSynced ? 0 : saved.savedAt);
      // 第九十五轮：打开时的样子留一份（和最新的那一份一样就不留）——之后画坏了，回得到“上次结束时”
      void keepVersion('opened', saved.doc);
      return true;
    }
    if (r.cancelled) {
      endOpen(guard);
      noteNotResumed('cancelled');
      return false;
    }
    if (r.stopped) {
      // 用户停下的：不问“没能打开”，和取消一样进向导；记的那一笔不擦（连着两次停下，下次先问）
      noteNotResumed('cancelled');
      showToast(STOP_TEXT.openStopped);
      return false;
    }
    // 有原因的没打开：马上就问，不用下次再问
    endOpen(guard);
    noteNotResumed('failed', r.error);
    const v = await askResumeFailed(saved, r.error, scripts.length > 0 && safe === null);
    if (v === 'safe') safe = SAFE_AFTER_FAIL;
    else if (v !== 'retry') return false;
  }
}

// 打开以后多久没出事才擦掉记的那一笔（测试里改短）
export const openSettle = { ms: OPEN_SETTLE_MS };
// 记“连着几次没打开成”的地方（没有 localStorage 时不记）
function guardStore(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
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
// error 为 null（第九十六轮）：不是这一次没打开，是连着两次动手都没打开成——还没试，先问（没有原因可写）
async function askResumeFailed(saved: Autosaved, error: string | null, canSafe: boolean): Promise<'retry' | 'safe' | 'new'> {
  const T = RESUME_FAILED;
  const twice = error === null;
  // 原因先翻成人话（引擎的原话里常带英文）；原话不一样时折叠着留在下面，能选中、复制（问别人时用）
  const why = twice ? null : humanError(error);
  let exported = false;
  for (;;) {
    const v = await askUser({
      title: twice ? OPEN_TWICE_TEXT.title : T.title,
      text: exported ? T.exported : twice ? (canSafe ? OPEN_TWICE_TEXT.textScripts : OPEN_TWICE_TEXT.text) : canSafe ? T.textScripts : T.text,
      ...(why ? { note: { label: T.reason, text: why.text, ...(why.detail ? { detail: why.detail } : {}) } } : {}),
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
    noteMapSeen(id, e.savedAt);
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
