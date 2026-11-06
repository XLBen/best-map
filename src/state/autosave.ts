import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import { isCurrentDoc } from '../../core/doc-version';
import type { WorldDoc } from '../../core/engine';
import { idbTx, kvRequest, openDb } from '../idb';
import { THUMB_EVERY_MS, activeLink, idbMapStore, isQuotaError, mapLink, mapSavedState, overwriteMap, thumbHook } from '../maps';
import { showToast } from './notes';
import { call, getDoc, hostHooks, safeMode } from './worker-host';
import { worldEpoch, worldState } from './world';

// 第七十轮从 state.ts 分出来

// ---------- 自动保存（只存在本浏览器里） ----------
// 存在 IndexedDB：结构化克隆，不必转成 JSON，也没有 localStorage 约 5 MB 的上限（以前画多了会存不下、
// 之后悄悄不再保存）。每次只写变了的那些命令（撤销、换一个只改动最后几步）。IndexedDB 用不了时退回 localStorage

const AUTOSAVE_KEY = 'map2.autosave';
interface AutosaveMeta extends Omit<WorldDoc, 'commands'> {
  savedAt: number;
  count: number;
  // 安全模式（脚本没有运行）的原因：下次打开时照样用安全模式（不运行脚本打开 → 自动保存 → 刷新，脚本也不会跑起来）
  safe?: string;
  // 连着“我的地图”里的哪一张（见 maps.ts）：刷新后照样连着。mapSynced：写这份自动保存时那一张已经与它相同
  mapId?: string;
  mapSynced?: boolean;
}
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveWarned = false;
// 已写进 IndexedDB 的步的编号、属于哪一个世界（新建、打开后从头写）
let savedIds: number[] = [];
let savedEpoch = -1;
let savedCount = -1;
// Worker 换了一个（卡住后恢复）时加一：新引擎的步号从 1 起，旧的编号对不上，从头写
let savedGen = 0;
export function resetAutosaveIds() {
  savedIds = [];
  savedGen++;
}

// 上次自动保存的时间（向导里“继续上次的世界”用）；没有时为 null
export const autosaved = signal<number | null>(null);

// 一次只写一份：前一次还没写完时，接在它后面
let autosaving: Promise<void> = Promise.resolve();
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => (autosaving = autosaving.then(autosave)), 1500);
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
    const e = await overwriteMap(idbMapStore, link.id, { doc, thumb, now });
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

async function autosave() {
  if (savedEpoch !== worldEpoch.value) {
    savedIds = [];
    savedEpoch = worldEpoch.value;
  }
  const epoch = savedEpoch;
  const gen = savedGen;
  const link = activeLink(mapLink.value, epoch);
  const state = worldState.value;
  const r = await call({ kind: 'docTail', ids: savedIds }, null);
  if (!r.ok || !r.tail || epoch !== worldEpoch.value || gen !== savedGen) return;
  const { from, commands, ids, ...head } = r.tail;
  const meta: AutosaveMeta = { ...head, savedAt: Date.now(), count: ids.length };
  if (safeMode.value) meta.safe = safeMode.value.reason;
  if (link) {
    meta.mapId = link.id;
    if (mapSavedState.value === state) meta.mapSynced = true;
  }
  try {
    if (savedCount < 0) savedCount = ((await kvRequest<AutosaveMeta | undefined>('readonly', (s) => s.get('autosave')))?.count ?? 0) as number;
    const stale = savedCount;
    // 一个事务：要么全写进去，要么都不写
    await idbTx(['kv', 'autosave'], 'readwrite', (kv, store) => {
      commands.forEach((c, k) => store.put(c, from + k));
      if (stale > meta.count) store.delete(IDBKeyRange.bound(meta.count, stale - 1));
      kv.put(meta, 'autosave');
    });
    if (epoch === worldEpoch.value && gen === savedGen) savedIds = ids;
    savedCount = meta.count;
    autosaved.value = meta.savedAt;
    // IndexedDB 用不了时存在 localStorage 里的：已经有更新的了
    localStorage.removeItem(AUTOSAVE_KEY);
    if (link) await syncLinked(link, state);
  } catch {
    // IndexedDB 用不了（比如隐私模式）：整份存进 localStorage
    const doc = await getDoc();
    if (!doc) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: Date.now(), doc, ...(safeMode.value ? { safe: safeMode.value.reason } : {}) }));
      autosaved.value = Date.now();
    } catch {
      if (!autosaveWarned) showToast('世界太大，无法自动保存；请导出世界文件', true);
      autosaveWarned = true;
    }
  }
}

// 读上次的自动保存：IndexedDB 与 localStorage（IndexedDB 用不了时的后备）里较新的那一份。safe：上次是安全模式（原因）。
// 旧版本的世界（第九轮起不再兼容）当作没有：启动时弹出向导新建，不报错；新世界的自动保存会盖掉它
export interface Autosaved {
  savedAt: number;
  doc: WorldDoc;
  safe?: string;
  mapId?: string;
  mapSynced?: boolean;
}
export async function readAutosave(): Promise<Autosaved | null> {
  let best: Autosaved | null = null;
  try {
    const db = await openDb();
    const tx = db.transaction(['kv', 'autosave'], 'readonly');
    const get = <T>(req: IDBRequest) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result as T)), (req.onerror = () => reject(req.error))));
    const meta = await get<AutosaveMeta | undefined>(tx.objectStore('kv').get('autosave'));
    if (meta && meta.count > 0) {
      const commands = await get<Command[]>(tx.objectStore('autosave').getAll(IDBKeyRange.bound(0, meta.count - 1)));
      const { savedAt, count, safe, mapId, mapSynced, ...head } = meta;
      const doc = { ...head, commands };
      if (commands.length === count && isCurrentDoc(doc))
        best = { savedAt, doc, ...(typeof safe === 'string' ? { safe } : {}), ...(typeof mapId === 'string' ? { mapId, mapSynced: mapSynced === true } : {}) };
    }
    db.close();
  } catch {
    // 读不了就看 localStorage
  }
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    const old = raw ? (JSON.parse(raw) as Autosaved) : null;
    if (old && isCurrentDoc(old.doc) && (!best || old.savedAt > best.savedAt)) best = { savedAt: old.savedAt, doc: old.doc, ...(typeof old.safe === 'string' ? { safe: old.safe } : {}) };
  } catch {
    // 坏了就当没有
  }
  autosaved.value = best?.savedAt ?? null;
  return best;
}

// 换上快照、换了 Worker 时（worker-host.ts 在原来的地方调用）
hostHooks.snapshotApplied = scheduleAutosave;
hostHooks.resetAutosaveIds = resetAutosaveIds;
