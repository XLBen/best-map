import { effect, signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import { isCurrentDoc } from '../../core/doc-version';
import type { WorldDoc } from '../../core/engine';
import { type AutosaveHead, type AutosaveIo, AutosaveWriter, type HeadMark, type SaveExtra, type WriteOutcome, browserAutosaveIo, markOf, newPageId, wholeDoc } from '../autosave-io';
import { type LockIo, SaveRole, browserLockIo } from '../autosave-lock';
import { AUTOSAVE_KEY, splitHead, staleLocalAutosave } from '../backups';
import { openDb } from '../idb';
import { type StorageLike, askPersist, storageNearlyFull } from '../storage-health';
import { keepGate, keepStaleOnce, refreshBackups } from './backups';
import { THUMB_EVERY_MS, activeLink, idbMapStore, isQuotaError, mapLink, mapSavedState, thumbHook } from '../maps';
import { fileAfterSave } from './file-save';
import { showToast } from './notes';
import { failWhy, saveFail, saveRole, savedState, storageTight, unsaved } from './save-status';
import { adoptWorldId, freeVersionRoom, overwriteLinked, versionAfterSave, worldId } from './versions';
import { call, currentHost, getDoc, hostHooks, safeMode } from './worker-host';
import { world, worldEpoch, worldState } from './world';

// 第七十轮从 state.ts 分出来

// ---------- 自动保存（只存在本浏览器里） ----------
// 存在 IndexedDB：结构化克隆，不必转成 JSON，也没有 localStorage 约 5 MB 的上限（以前画多了会存不下、
// 之后悄悄不再保存）。每次只写变了的那些命令（撤销、换一个只改动最后几步）。IndexedDB 用不了时退回 localStorage。
// 第九十四轮：写什么、谁写在 ../autosave-io.ts、../autosave-lock.ts（纯规则，测试直接调）；这里是定时、信号、接到 Worker 和页面的事件上。
// 没写成不再只提示一次：原因一直在 saveFail 里（save-status.ts），下一次写成了才清掉

// 改了以后多久写；隔多久看一眼存储用掉多少
export const AUTOSAVE_MS = 1500;
const STORAGE_CHECK_MS = 10 * 60 * 1000;

// 已写进 IndexedDB 的步的编号在 writer 里（autosave-io.ts）；属于哪一个世界（新建、打开后从头写）
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let savedEpoch = -1;
// Worker 换了一个（卡住后恢复）时加一：新引擎的步号从 1 起，旧的编号对不上，从头写
let savedGen = 0;
export function resetAutosaveIds() {
  parts?.writer.forget();
  savedGen++;
}

// 上次自动保存的时间（向导里“继续上次的世界”用）；没有时为 null
export const autosaved = signal<number | null>(null);

// ---------- 谁写（第九十四轮，见 autosave-io.ts、autosave-lock.ts） ----------

// 这一次打开页面的写入者、是不是写的那一方。第一次用到时才建（测试里没有页面：没有锁，靠头里的核对）
interface Parts {
  writer: AutosaveWriter;
  role: SaveRole;
}
let parts: Parts | null = null;
let custom: { io: AutosaveIo; lock: LockIo | null } | null = null;
function setup(): Parts {
  if (parts) return parts;
  const id = newPageId();
  const { lock, channel } = custom ? { lock: custom.lock, channel: custom.lock } : typeof document !== 'undefined' ? browserLockIo() : { lock: null, channel: null };
  const role: SaveRole = new SaveRole(
    lock,
    id,
    {
      changed: (r) => {
        if (r === 'other') writer.yield();
        else if (r === 'writer') writer.holder = true;
        saveRole.value = r;
        // 轮到这个页面写了（那一页关了）：有世界就写一次
        if (r === 'writer' && world.peek()) scheduleAutosave();
      },
      // 那一页关了：存着的那一份是这一页的世界的开头才不问就接着写
      canPromote: () => writer.canPromote(world.value ? (currentHost()?.mirror.full() ?? null) : null),
    },
    channel,
  );
  const writer = new AutosaveWriter(custom?.io ?? browserAutosaveIo, id, lock === null, {
    lost: () => role.giveUp(),
    kept: () => void refreshBackups().catch(() => {}),
  });
  parts = { writer, role };
  return parts;
}
// 测试换成内存里的存储和锁（每次调用是一个新的“页面”）；不给就回到浏览器的
export function useAutosaveIo(io?: AutosaveIo, lock: LockIo | null = null) {
  custom = io ? { io, lock } : null;
  parts = null;
  savedEpoch = -1;
  saveRole.value = 'unknown';
  saveFail.value = null;
  savedState.value = -2;
}

// 留着的旧世界只由写的那一方挪（state/backups.ts 的 keepStaleOnce 先问这里）
keepGate.ready = async () => {
  const p = setup();
  await p.role.start();
  return p.writer.holder;
};

// “在这里接着做”：把写自动保存的权利拿到这个页面，马上把这一页的世界整份写下
export async function takeOverSaving(): Promise<void> {
  const p = setup();
  await p.role.take();
  p.writer.claim();
  await autosaveNow();
}

// 打开了上次的世界（resumeLast）：存着的就是这一页的世界，盖掉它不用先留；没改之前不算“有没存的改动”
export function noteResumed(saved: Autosaved) {
  const p = setup();
  p.writer.opened = saved.mark ?? null;
  p.writer.keepWhy = { why: 'replaced' };
  savedState.value = worldState.value;
  // 第九十五轮：还是同一个世界——它的版本接着记在同一个编号上
  adoptWorldId(saved.wid);
}
// 上次的世界没能打开、没打开（取消了）：之后这个页面的自动保存盖掉它之前先原样留着，写上为什么
export function noteNotResumed(why: 'failed' | 'cancelled', error?: string) {
  setup().writer.keepWhy = { why, ...(error ? { error } : {}) };
}

// 一次只写一份：前一次还没写完时，接在它后面
let autosaving: Promise<void> = Promise.resolve();
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    autosaving = autosaving.then(autosave);
  }, AUTOSAVE_MS);
}

// 马上自动保存一次（连上、断开“我的地图”里的一张之后，换别的世界之前）；等它写完
export function autosaveNow(): Promise<void> {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = null;
  autosaving = autosaving.then(autosave);
  return autosaving;
}

// 连着的地图上次换缩略图的时间；存满了只提醒一次
let thumbAt = 0;
let linkWarned = false;
export function noteThumb(at = Date.now()) {
  thumbAt = at;
}

// 自动保存之后：连着“我的地图”里的一张就把它也更新（世界文件；隔几分钟换一张缩略图）。
// link、state 是这次自动保存开始时的：之后换了世界（纪元变了）就不写
async function syncLinked(link: { id: string; name: string; epoch: number }, state: number) {
  if (mapSavedState.value === state) return;
  const doc = await getDoc();
  if (!doc || link.epoch !== worldEpoch.value || activeLink(mapLink.value, worldEpoch.value)?.id !== link.id) return;
  const now = Date.now();
  const thumb = now - thumbAt > THUMB_EVERY_MS ? (thumbHook.make?.() ?? null) : null;
  try {
    // 第九十五轮：别的页面往这一张里存过、盖掉会丢东西时，先把那一份留成一个版本（versions.ts 的 overwriteKeeping）
    const e = await overwriteLinked(idbMapStore, link.id, { doc, thumb, now });
    if (!e) {
      // 别的页面里删掉了：这个世界不再连着它
      if (mapLink.value?.id === link.id) mapLink.value = null;
      return;
    }
    if (thumb) thumbAt = now;
    if (mapLink.value?.id === link.id && link.epoch === worldEpoch.value) mapSavedState.value = state;
  } catch (e) {
    if (!linkWarned) showToast(isQuotaError(e) ? `存储已满，“${link.name}”没能自动保存。请删除几张地图，或导出世界文件` : `“${link.name}”没能自动保存：浏览器存储不可用`, true);
    linkWarned = true;
  }
}

// 头里除了世界以外的几项：安全模式的原因、连着哪一张地图、这个世界的编号（第九十五轮：以前的版本按它记）
function extraNow(link: { id: string } | null, synced: boolean): SaveExtra {
  return { ...(safeMode.value ? { safe: safeMode.value.reason } : {}), ...(link ? { mapId: link.id, ...(synced ? { mapSynced: true } : {}) } : {}), wid: worldId() };
}

async function autosave() {
  try {
    await autosaveOnce();
  } catch (e) {
    // 不该到这里；到了也不让后面排着的自动保存都停下
    console.error(e);
  }
}

async function autosaveOnce() {
  // 第九十一轮：写之前先确认这一版打不开的旧自动保存已经挪走（启动时读自动保存那一下就挪了；这里是万一还没读过）
  await keepStaleOnce();
  const { writer, role } = setup();
  await role.start();
  if (savedEpoch !== worldEpoch.value) {
    writer.forget();
    savedEpoch = worldEpoch.value;
  }
  // 这个页面不是写的那一方（这个世界已在另一个页面打开）：不写，也不去问 Worker
  if (!writer.holder) return;
  const epoch = savedEpoch;
  const gen = savedGen;
  const link = activeLink(mapLink.value, epoch);
  const state = worldState.value;
  let idbError: unknown = null;
  // 第九十五轮：写不进去是因为满了时，先把以前的版本丢掉一半腾地方再试一次——不能因为留着版本让现在这一份存不下
  let roomTried = false;
  const madeRoom = async (e: unknown) => {
    if (roomTried || !isQuotaError(e)) return false;
    roomTried = true;
    return (await freeVersionRoom()) > 0;
  };
  // 最多两次：第二次是“要整份”（头不是这一页上一次写的那一代）时重新取整份
  for (let round = 0; round < 2; round++) {
    const base = writer.savedIds;
    const r = await call({ kind: 'docTail', ids: base as number[] }, null);
    if (!r.ok || !r.tail || epoch !== worldEpoch.value || gen !== savedGen) return;
    // 回复到的时候主线程的命令记录正是这一份：记下是哪个引擎的（关页面的那一下拿它认下标还对不对）
    const key = currentHost()?.mirror.keyFor(r.tail.ids) ?? null;
    let out: WriteOutcome;
    try {
      out = await writer.write(r.tail, extraNow(link, mapSavedState.value === state), { base, key });
    } catch (e) {
      if (await madeRoom(e)) {
        round--;
        continue;
      }
      idbError = e ?? new Error('自动保存没写成');
      break;
    }
    if (out.kind === 'again') continue;
    if (out.kind === 'other') return;
    if (out.kind === 'keep-failed') {
      if (await madeRoom(out.error)) {
        round--;
        continue;
      }
      // 原来那一份没能留下来（多半是满了）：不盖它，和写不进去一样退回 localStorage
      idbError = out.error ?? new Error('自动保存没写成');
      break;
    }
    // 写的时候换了世界、换了 Worker：这些编号不是现在这个引擎的
    if (epoch !== worldEpoch.value || gen !== savedGen) writer.forget();
    autosaved.value = out.head.savedAt;
    savedState.value = state;
    saveFail.value = null;
    // IndexedDB 用不了时存在 localStorage 里的：已经有更新的了（没能挪走的旧世界不删，见 backups.ts）
    try {
      if (!staleLocalAutosave(localStorage)) localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      // 没有 localStorage
    }
    void storageCheck();
    if (link) await syncLinked(link, state);
    // 第九十五轮：隔一阵留一份以前的样子；这个世界连着电脑上的文件时也写进去（都不等、都有自己的节流）
    versionAfterSave();
    fileAfterSave();
    return;
  }
  if (idbError === null) return;
  // IndexedDB 用不了（比如隐私模式）、满了：整份存进 localStorage
  const doc = await getDoc();
  if (!doc || epoch !== worldEpoch.value) return;
  try {
    // 位置上还压着一份没能挪走的旧世界（存储满了，见 backups.ts）：不盖它
    if (staleLocalAutosave(localStorage)) {
      saveFail.value = failWhy(idbError, 'blocked');
      return;
    }
    const at = Date.now();
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: at, doc, ...(safeMode.value ? { safe: safeMode.value.reason } : {}), wid: worldId() }));
    autosaved.value = at;
    savedState.value = state;
    saveFail.value = null;
  } catch (e) {
    saveFail.value = failWhy(idbError, e);
  }
}

// 第一次自动保存成功之后：申请一次“持久”的存储；隔一阵看一眼存储用掉多少（快满了界面提醒一次）
let persistAsked = false;
let estimatedAt = 0;
async function storageCheck() {
  if (typeof navigator === 'undefined') return;
  const storage = (navigator as { storage?: StorageLike }).storage;
  if (!persistAsked) {
    persistAsked = true;
    let local: Storage | null = null;
    try {
      local = localStorage;
    } catch {
      local = null;
    }
    await askPersist(storage, local);
  }
  if (Date.now() - estimatedAt < STORAGE_CHECK_MS) return;
  estimatedAt = Date.now();
  storageTight.value = await storageNearlyFull(storage);
}

// ---------- 关页面、切走：不丢最后几秒（第九十四轮） ----------

// 同步地把没写的尾巴发出去：不问 Worker，用主线程手上的命令记录（sandbox.ts 的 Mirror）；Worker 里还没应答的编辑不在里面。
// sent：发出去了；nothing：没有没写的；cannot：这样写不了（不是写的那一方、还没写成过、没有锁可用……）
export function flushNow(): 'sent' | 'nothing' | 'cannot' {
  if (!world.value) return 'nothing';
  const doc = currentHost()?.mirror.full();
  if (!doc) return 'nothing';
  // 新的几步还没写进连着的那一张地图：不说“已经相同”，下次打开时补写
  return setup().writer.blind(doc, extraNow(activeLink(mapLink.value, worldEpoch.value), false));
}

// 页面要隐藏、要关：马上写。先同步发一次（页面真的没了也多半写得成），再照平常的路写一次（页面还在时把 Worker 里排着的也写上、核对）
function saveOnLeave() {
  if (!world.value) return;
  const sent = flushNow();
  if (sent === 'cannot' || autosaveTimer !== null || unsaved.peek()) void autosaveNow();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOnLeave();
  });
  window.addEventListener('pagehide', saveOnLeave);
  // 有没存的改动时关页面：浏览器自带的确认。只在真有没存的时候挂着
  const warn = (e: BeforeUnloadEvent) => {
    if (leaving) return;
    flushNow();
    e.preventDefault();
    e.returnValue = '';
  };
  effect(() => {
    if (unsaved.value) window.addEventListener('beforeunload', warn);
    else window.removeEventListener('beforeunload', warn);
  });
}

// 第九十五轮：这个页面要自己重新载入（“重新载入”：打开别的页面里保存的那一份；这个页面里的样子已经另外留了一份）——
// 浏览器不用再问“要离开吗”
let leaving = false;
export function skipLeaveWarning() {
  leaving = true;
}

// 读上次的自动保存：IndexedDB 与 localStorage（IndexedDB 用不了时的后备）里较新的那一份。safe：上次是安全模式（原因）。
// 这一版打不开的世界（旧版本的、更新的版本做的）不在这里读：读之前先原样挪进“留着的旧世界”（第九十一轮，backups.ts），
// 位置空出来，新世界的自动保存碰不到它；这里照旧返回 null（启动时弹出向导），界面另有一条一直在的提示
export interface Autosaved {
  savedAt: number;
  doc: WorldDoc;
  safe?: string;
  mapId?: string;
  mapSynced?: boolean;
  // 第九十四轮：读的是 IndexedDB 里的哪一份（谁写的、第几代）——这个页面第一次写时认“盖掉的就是我打开的那一份”
  mark?: HeadMark;
  // 第九十五轮：这个世界的编号（以前的版本按它记）
  wid?: string;
}
export async function readAutosave(): Promise<Autosaved | null> {
  await keepStaleOnce();
  let best: Autosaved | null = null;
  try {
    const db = await openDb();
    const tx = db.transaction(['kv', 'autosave'], 'readonly');
    const get = <T>(req: IDBRequest) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result as T)), (req.onerror = () => reject(req.error))));
    const meta = await get<AutosaveHead | undefined>(tx.objectStore('kv').get('autosave'));
    if (meta && meta.count > 0) {
      const commands = await get<Command[]>(tx.objectStore('autosave').getAll(IDBKeyRange.bound(0, meta.count - 1)));
      const { info, head } = splitHead(meta);
      const doc = { ...head, commands };
      // 没存完整的（条数对不上）不在这里打开：启动时已经原样挪进“留着的旧世界”（backups.ts 的 staleWhy）；
      // 这个页面不是写的那一方时没挪，照样不打开
      if (wholeDoc(meta, commands) && isCurrentDoc(doc))
        best = { savedAt: info.savedAt, doc, ...(info.safe !== undefined ? { safe: info.safe } : {}), ...(info.mapId !== undefined ? { mapId: info.mapId, mapSynced: info.mapSynced === true } : {}), ...(info.wid !== undefined ? { wid: info.wid } : {}), mark: markOf(meta) };
    }
    db.close();
  } catch {
    // 读不了就看 localStorage
  }
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    const old = raw ? (JSON.parse(raw) as Autosaved) : null;
    if (old && isCurrentDoc(old.doc) && (!best || old.savedAt > best.savedAt)) best = { savedAt: old.savedAt, doc: old.doc, ...(typeof old.safe === 'string' ? { safe: old.safe } : {}), ...(typeof old.wid === 'string' ? { wid: old.wid } : {}) };
  } catch {
    // 坏了就当没有
  }
  autosaved.value = best?.savedAt ?? null;
  return best;
}

// 换上快照、换了 Worker 时（worker-host.ts 在原来的地方调用）
hostHooks.snapshotApplied = scheduleAutosave;
hostHooks.resetAutosaveIds = resetAutosaveIds;
