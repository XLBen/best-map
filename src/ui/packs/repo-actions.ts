import type { Command } from '../../../core/commands';
import { type ContentKind, itemId, kindOf } from '../../../core/content/registry';
import type { IslandType } from '../../../core/island-types';
import { type MapStyle, styleRgba } from '../../../core/map-style';
import { packFileName } from '../../../core/packs';
import { editMineList, library, removeItem, saveItem } from '../../library';
import { askUser, download, exec, execAdjust, focusSpecies, knowIsolation, openPanel, openWaterTypeEditor, planTidy, sheet, showToast, world } from '../../state';
import { trustScripts, untrustedScripts } from '../../trust';
import { scriptTrustText } from '../copy';
import { category, setTool } from '../defs/tools';
import { createAndUse as createIslandType, islandSwatch, requestIslandTypeEditor } from '../panels/islandTypes';
import { createAndUse as createWaterType } from '../panels/waterTypes';
import { DEDICATED, canRename, renameCommand, renamed, reorderById, startEdit } from './edit';
import { blankItem } from './fields';
import { type RepoRow, type TreeNode, canDeleteFromLibrary, itemPack, packRemoveRefs, repoRows, saveableItem } from './repo';
import { isolationNote } from './Scripts';
import { type RepoState, openRepo, patchRepo, repo } from './store';

// 资源库里各个按钮做的事（第四十五轮从 RepoPanel.tsx 分出来）：添加、移出之前问脚本，存进资源库、导出、从库里删除，
// 选中一项（右栏摊开编辑器）、新建、改名、换先后，几种有自己编辑器的打开那个编辑器

export const fmt = (n: number) => n.toLocaleString('en-US');

// 添加、移出、“默认”之前：没信任过的脚本先问
export async function runTrusted(cmd: Command, busy: string): Promise<boolean> {
  const list = await untrustedScripts(cmd);
  if (list.length) {
    await knowIsolation();
    const v = await askUser({
      title: '信任脚本',
      text: `${scriptTrustText(list.length)}${isolationNote()}`,
      scripts: list,
      choices: [
        { value: 'ok', label: '信任并启用', primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (v !== 'ok') return false;
    await trustScripts(list);
  }
  return execAdjust(cmd, busy);
}

// ---------- 一行的样子 ----------

// 画风的色块（第三十八轮）：左上是陆地（平常的陆地色混上底色），右下是海（分层的海取第二层，不然取平常的海色）
const PLAIN_LAND = [157, 176, 122];
const PLAIN_SEA = '#4f7fa8';
function mapStyleSwatch(s: MapStyle): string {
  const t = styleRgba(s.landTint);
  const k = t ? s.landTintAmount : 0;
  const land = PLAIN_LAND.map((v, i) => Math.round(v + ((t?.[i] ?? v) - v) * k));
  const sea = s.sea === 'tiers' ? s.tier2 : PLAIN_SEA;
  return `linear-gradient(135deg, rgb(${land.join(', ')}) 50%, ${sea} 50%)`;
}

export function swatchOf(row: Pick<RepoRow, 'kind' | 'item'>): string | null {
  if (row.kind.id === 'islandType') return islandSwatch(row.item as IslandType);
  if (row.kind.id === 'mapStyle') return mapStyleSwatch(row.item as MapStyle);
  const c = (row.item as { color?: unknown }).color;
  return typeof c === 'string' && c.startsWith('#') ? c : null;
}

// 几个示例名字（地名风格）：每类地物的第一个，最多三类
const sampleCache = new WeakMap<object, string>();
export function sampleLine(row: RepoRow): string {
  const it = row.item as object;
  let s = sampleCache.get(it);
  if (s === undefined) {
    try {
      s = (row.kind.samples?.(row.item, 1) ?? [])
        .slice(0, 3)
        .map((g) => g.lines[0])
        .filter(Boolean)
        .join('、');
    } catch {
      s = '';
    }
    sampleCache.set(it, s);
  }
  return s;
}

export const descOf = (row: RepoRow): string => {
  const it = row.item as { description?: unknown; hint?: unknown };
  const d = it.description ?? it.hint;
  return typeof d === 'string' ? d : '';
};

// ---------- 一项 ----------

// 存进资源库（“我的资源”）
export async function saveRow(row: RepoRow) {
  const item = saveableItem(row);
  if (item === null) return;
  const r = await saveItem(row.kind.pack.key, item);
  if (!r.ok) showToast(r.error, true);
  else showToast(r.stored ? `“${row.name}”已存进资源库（我的资源）` : '存不进浏览器：只在这次打开的页面里', !r.stored);
}

// 单独这一项导出成文件
export const exportRow = (row: RepoRow) => {
  const pack = itemPack(row);
  download(packFileName(pack), JSON.stringify(pack, null, 2), 'application/json');
};

// 从资源库里删掉（只有我的；先问）
export async function deleteRow(row: RepoRow) {
  if (!canDeleteFromLibrary(row)) return;
  const v = await askUser({
    title: `从资源库删除“${row.name}”`,
    text: '用过它的世界不受影响（世界里有自己的一份）。',
    choices: [
      { value: 'delete', label: '删除', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'delete') return;
  const r = await removeItem(row.entry!, row.kind.pack.key, row.id);
  showToast(r.ok ? `“${row.name}”已从资源库删除` : (r.error ?? '删不了'), !r.ok);
  if (r.ok && repo.value?.sel === row.key) patchRepo({ sel: undefined, edit: undefined });
}

// 本世界一栏的一个包：移出没用到的（在副本上试，地图会变的、在用的留着）
export async function removeUnused(n: TreeNode) {
  const refs = packRemoveRefs(n);
  if (!refs.length) return;
  const plan = await planTidy(refs);
  if (!plan) return;
  if (!plan.command) {
    showToast(plan.kept.length ? `移出后地图会变：${plan.kept[0].name}` : '都在用');
    return;
  }
  const ok = await exec(plan.command, '正在移出…');
  if (ok && plan.kept.length) showToast(`${plan.kept.length} 项移出后地图会变，留着`);
}

// ---------- 选中、编辑 ----------

// 选中一项：右栏是它的详情；能编辑的种类同时摊开编辑器（从世界里的那一份、或资源库里的那一份改起）
export function selectRow(row: RepoRow) {
  patchRepo({ sel: row.key, edit: startEdit(row, world.value) ?? undefined });
}

// 生态、河、湖、岛的种类打开各自的编辑器（编辑的是世界里的那一项）
export function openDedicated(row: RepoRow) {
  const wid = row.status.worldId ?? row.id;
  switch (row.kind.id) {
    case 'biome':
      focusSpecies.value = wid;
      sheet.value = 'species';
      return;
    case 'riverType':
    case 'lakeType':
      openWaterTypeEditor(row.kind.id === 'riverType' ? 'river' : 'lake', wid);
      return;
    case 'islandType':
      if (category.value !== 'terrain') setTool('island');
      requestIslandTypeEditor(wid);
      openPanel.value = 'cat:terrain';
      return;
  }
}

// 这一种里已用的 id（世界里的、资源库里的）：新建、复制时避开
export function takenIds(kind: ContentKind): Set<string> {
  const w = world.value;
  return new Set(
    repoRows(kind, w, library.value)
      .map((r) => r.id)
      .concat(w ? kind.inWorld(w).map((x) => itemId(kind, x)) : []),
  );
}

export const canNew = (kind: ContentKind) => DEDICATED.has(kind.id) || !!kind.blank;

// 新建：有自己编辑器的在那里新建，别的用登记的空样子（右栏摊开）
export function newItem(kind: ContentKind) {
  switch (kind.id) {
    case 'biome':
      sheet.value = 'species';
      return;
    case 'riverType':
    case 'lakeType':
      void createWaterType(kind.id === 'riverType' ? 'river' : 'lake', null);
      return;
    case 'islandType':
      if (category.value !== 'terrain') setTool('island');
      void createIslandType(null);
      return;
  }
  const item = blankItem(kind, takenIds(kind));
  if (item) patchRepo({ sel: undefined, edit: { item, how: 'new', kind: kind.id } });
}

// 从别处打开资源库的一种（“城市 ⋯”里的“资源库…”，工具里的“从资源库添加…”）
export function openRepoKind(kindId: string, filter?: RepoState['filter']) {
  openRepo({ kind: kindId, edit: undefined, sel: undefined, ...(filter ? { filter } : {}) });
}
// 打开资源库的一种，同时新建一项（底部条上的“新类型…”）
export function openNewItem(kindId: string) {
  const kind = kindOf(kindId);
  if (!kind) return;
  openRepoKind(kindId);
  newItem(kind);
}

// ---------- 改名、换先后（第四十五轮） ----------

// 双击改名：本世界里的是一步命令（可以撤销），我的资源里的直接改资源库
export async function renameRow(row: RepoRow, name: string): Promise<boolean> {
  if (!canRename(row) || name.trim() === row.name) return false;
  const w = world.value;
  if (row.source === 'world') {
    if (!w) return false;
    const r = renameCommand(row, name, w);
    if (!r.ok) {
      showToast(r.error, true);
      return false;
    }
    return runTrusted(r.cmd, '正在改名…');
  }
  const r = renamed(row.kind, row.item, name);
  if (!r.ok) {
    showToast(r.error, true);
    return false;
  }
  const done = await editMineList(row.path ?? [row.entry!], row.kind.pack.key, (list) => list.map((x) => (itemId(row.kind, x) === row.id ? r.item : x)));
  if (!done.ok || done.error) showToast(done.error ?? '改不了', true);
  return done.ok;
}

// 拖到同一个小包的另一项上：换到它的位置（只限我的资源）
export async function reorderRow(from: RepoRow, to: RepoRow): Promise<void> {
  const done = await editMineList(from.path ?? [from.entry!], from.kind.pack.key, (list) => reorderById(from.kind, list, from.id, to.id));
  if (!done.ok || done.error) showToast(done.error ?? '换不了', true);
}
