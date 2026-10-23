import { computed, signal } from '@preact/signals';
import type { WorldDoc } from '../../../core/engine';
import {
  type MapEntry,
  type MapStore,
  activeLink,
  createMap,
  defaultMapName,
  deleteMap,
  fileHint,
  fileNameOf,
  idbMapStore,
  isQuotaError,
  listMaps,
  mapLink,
  mapSavedState,
  nameFromFile,
  needsSaveQuestion,
  overwriteMap,
  renameMap,
  thumbHook,
  uniqueName,
} from '../../maps';
import { askText, askUser, autosaveNow, download, getDoc, history, loadDoc, noteThumb, showToast, world, worldEpoch, worldState } from '../../state';

// “我的地图”的界面这边：保存（⌘S）、另存为、打开、改名、导出、删掉，换世界之前问“先保存吗”。
// 存进浏览器失败（隐私模式、存储被关、满了）时改成下载世界文件，并说清楚

let store: MapStore = idbMapStore;
// 测试里换成内存里的
export function useMapStore(s: MapStore) {
  store = s;
}

// 我的地图的弹窗；列表（打开弹窗时读一次，改了之后重读）
export const mapsDialog = signal(false);
export const mapList = signal<MapEntry[] | null>(null);

// 当前的世界连着的那一张（新建、打开了别的世界之后为 null）
export const currentMap = computed(() => activeLink(mapLink.value, worldEpoch.value));
// 连着的那一张有没写进去的改动（自动保存 1.5 秒后就写进去）
export const mapDirty = computed(() => currentMap.value !== null && mapSavedState.value !== worldState.value);

// “当前：赤原 · 已保存”“当前：没保存的新世界”
export function mapStatus(): string {
  const link = currentMap.value;
  if (!world.value) return '还没有世界';
  if (!link) return '当前：没保存的新世界';
  return `当前：${link.name} · ${mapDirty.value ? '有改动没保存' : '已保存'}`;
}

export async function refreshMaps(): Promise<MapEntry[]> {
  try {
    mapList.value = await listMaps(store);
  } catch {
    mapList.value = [];
  }
  return mapList.value;
}

export function openMaps() {
  mapsDialog.value = true;
  void refreshMaps();
}

// 缩略图：截地图画面（干净的，不带高亮和预览），缩成约 240 像素宽的 JPEG
const THUMB_W = 240;
export function makeThumb(): string | null {
  try {
    const hook = (window as unknown as { __map2?: { snapshot: (clean?: boolean) => HTMLCanvasElement } }).__map2;
    const src = hook?.snapshot(true);
    if (!src || !src.width || !src.height) return null;
    const c = document.createElement('canvas');
    c.width = THUMB_W;
    c.height = Math.max(1, Math.round((THUMB_W * src.height) / src.width));
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
if (typeof window !== 'undefined') thumbHook.make = makeThumb;

const doneSteps = () => history.value.reduce((n, h) => n + (h.done ? 1 : 0), 0);

// 存不进浏览器：下载世界文件，说清楚为什么
function fallback(e: unknown, name: string, doc: WorldDoc) {
  download(fileNameOf(name), JSON.stringify(doc), 'application/json');
  showToast(
    isQuotaError(e)
      ? `浏览器的存储满了，存不进“我的地图”：已下载成世界文件「${fileNameOf(name)}」。删掉几张不要的地图后再存`
      : `这个浏览器存不了“我的地图”（可能是隐私模式）：已下载成世界文件「${fileNameOf(name)}」`,
    true,
  );
}

async function takenNames(): Promise<string[]> {
  try {
    return (await listMaps(store)).map((e) => e.name);
  } catch {
    return [];
  }
}

// 第一次保存、另存为时问名字。取消时为 null
async function askName(title: string, initial: string): Promise<string | null> {
  const r = await askText({
    title,
    input: initial,
    choices: [
      { value: 'save', label: '保存', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (r.value !== 'save') return null;
  return r.text.trim() || initial;
}

// 存成新的一张、连上它
async function saveNew(title: string, initial: string): Promise<boolean> {
  const name = await askName(title, initial);
  if (name === null) return false;
  const epoch = worldEpoch.value;
  const state = worldState.value;
  const doc = await getDoc();
  if (!doc || epoch !== worldEpoch.value) return false;
  const thumb = makeThumb();
  try {
    const e = await createMap(store, { name, doc, thumb });
    if (epoch === worldEpoch.value) {
      mapLink.value = { id: e.id, name: e.name, epoch };
      mapSavedState.value = state;
      if (thumb) noteThumb();
      // 自动保存记下连着的是这一张（刷新后照样连着）
      void autosaveNow();
    }
    showToast(`已保存「${e.name}」，在“世界 → 我的地图”里`);
    void refreshMaps();
    return true;
  } catch (err) {
    fallback(err, name, doc);
    return true;
  }
}

// 默认名字：打开的世界文件的名字，或最大的一块陆地的名字，或“新世界”（重了加个数）
async function defaultName(): Promise<string> {
  const taken = await takenNames();
  const hint = fileHint.value;
  if (hint && hint.epoch === worldEpoch.value && hint.name) return uniqueName(hint.name, taken);
  return defaultMapName(world.value?.derived.features ?? [], taken);
}

// 保存（⌘S）：连着一张就盖掉它，没连着就问个名字存成新的。存好了（或下载了文件）返回 true
export async function saveMap(): Promise<boolean> {
  if (!world.value) return false;
  const link = currentMap.value;
  if (!link) return saveNew('保存到“我的地图”', await defaultName());
  const epoch = worldEpoch.value;
  const state = worldState.value;
  const doc = await getDoc();
  if (!doc || epoch !== worldEpoch.value) return false;
  const thumb = makeThumb();
  try {
    const e = await overwriteMap(store, link.id, { doc, thumb });
    // 那一张已经被删掉了（别的页面里）：当作没保存过，问个名字
    if (!e) {
      mapLink.value = null;
      return saveNew('保存到“我的地图”', await defaultName());
    }
    if (epoch === worldEpoch.value && mapLink.value?.id === link.id) mapSavedState.value = state;
    if (thumb) noteThumb();
    showToast(`已保存「${e.name}」`);
    void refreshMaps();
    return true;
  } catch (err) {
    fallback(err, link.name, doc);
    return true;
  }
}

// 另存为：总是问名字，存成新的一张，之后连着新的这一张
export async function saveMapAs(): Promise<boolean> {
  if (!world.value) return false;
  const link = currentMap.value;
  return saveNew('另存为', link ? uniqueName(link.name, await takenNames()) : await defaultName());
}

// 换别的世界之前（新世界、打开我的地图里的一张）：
// 没连着地图、又改过时先问“先保存吗”；连着的那一张有没写进去的改动就马上写。取消时返回 false
export async function beforeLeave(): Promise<boolean> {
  if (!world.value) return true;
  if (currentMap.value) {
    if (mapDirty.value) await autosaveNow();
    return true;
  }
  if (!needsSaveQuestion(false, doneSteps())) return true;
  const v = await askUser({
    title: '当前的世界还没保存：先保存吗？',
    text: '不保存的话，换了世界之后它就找不回来了。',
    choices: [
      { value: 'save', label: '保存', primary: true },
      { value: 'drop', label: '不保存' },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v === 'save') return saveMap();
  return v === 'drop';
}

// 打开我的地图里的一张
export async function openMap(e: MapEntry): Promise<boolean> {
  if (currentMap.value?.id === e.id) {
    mapsDialog.value = false;
    return true;
  }
  if (!(await beforeLeave())) return false;
  let doc: WorldDoc | undefined;
  try {
    doc = await store.doc(e.id);
  } catch {
    doc = undefined;
  }
  if (!doc) {
    showToast(`读不出「${e.name}」`, true);
    return false;
  }
  mapsDialog.value = false;
  const ok = await loadDoc(doc);
  if (!ok) return false;
  mapLink.value = { id: e.id, name: e.name, epoch: worldEpoch.value };
  mapSavedState.value = worldState.value;
  noteThumb(e.thumb ? e.savedAt : 0);
  void autosaveNow();
  showToast(`已打开「${e.name}」`);
  return true;
}

export async function renameSaved(e: MapEntry): Promise<void> {
  const r = await askText({
    title: '改名',
    input: e.name,
    choices: [
      { value: 'ok', label: '改名', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (r.value !== 'ok' || !r.text.trim() || r.text.trim() === e.name) return;
  try {
    const n = await renameMap(store, e.id, r.text);
    if (n && mapLink.value?.id === e.id) mapLink.value = { ...mapLink.value, name: n.name };
  } catch {
    showToast('改不了名（浏览器的存储用不了）', true);
  }
  void refreshMaps();
}

export async function exportSaved(e: MapEntry): Promise<void> {
  try {
    const doc = await store.doc(e.id);
    if (doc) {
      download(fileNameOf(e.name), JSON.stringify(doc), 'application/json');
      return;
    }
  } catch {
    // 下面说
  }
  showToast(`读不出「${e.name}」`, true);
}

export async function deleteSaved(e: MapEntry): Promise<void> {
  const v = await askUser({
    title: `删掉「${e.name}」？删了找不回来`,
    text: currentMap.value?.id === e.id ? '它就是现在开着的世界：删掉后这个世界还开着，变成没保存的新世界。' : undefined,
    choices: [
      { value: 'delete', label: '删掉', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'delete') return;
  try {
    await deleteMap(store, e.id);
    if (mapLink.value?.id === e.id) {
      mapLink.value = null;
      void autosaveNow();
    }
    showToast(`已删掉「${e.name}」`);
  } catch {
    showToast('删不了（浏览器的存储用不了）', true);
  }
  void refreshMaps();
}

// 导出世界文件（.json）：连着地图时用地图的名字当文件名
export async function exportCurrent(): Promise<void> {
  const doc = await getDoc();
  if (doc) download(fileNameOf(currentMap.value?.name ?? 'world'), JSON.stringify(doc), 'application/json');
}

// 打开世界文件：不连着任何一张（之后 ⌘S 存进我的地图，默认名字是文件名）
export async function openFile(f: File): Promise<void> {
  let doc: WorldDoc;
  try {
    doc = JSON.parse(await f.text()) as WorldDoc;
  } catch {
    showToast(`「${f.name}」不是世界文件`, true);
    return;
  }
  if (!(await beforeLeave())) return;
  if (await loadDoc(doc)) fileHint.value = { name: nameFromFile(f.name), epoch: worldEpoch.value };
}
