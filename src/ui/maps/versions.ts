import { signal } from '@preact/signals';
import type { WorldDoc } from '../../../core/engine';
import { describeMap, idbMapStore, mapLink, mapSavedState } from '../../maps';
import { type VersionInfo, mapSeries, seriesMap, versionFileName } from '../../versions';
import {
  adoptWorldId,
  askUser,
  autosaveNow,
  currentSeries,
  deleteVersion,
  download,
  keepText,
  keepVersion,
  loadDoc,
  noteMapSeen,
  noteThumb,
  refreshVersions,
  showToast,
  versionEvents,
  versionText,
  versions,
  worldEpoch,
} from '../../state';
import { VERSION_TEXT as T } from '../copy';
import { ESC_RANK, pushEscape } from '../shell/escape';
import { beforeLeave, exportCurrent } from './store';

// 以前的版本的界面这边（第九十五轮，规则在 src/versions.ts，信号在 state/versions.ts）：
// 列表怎么分段、一行写什么、回到某一份（先把现在的样子留一份）、导出、删除（先问）。
// 组件（VersionsDialog.tsx、“世界”菜单的一行、“我的地图”每张上的按钮）只调这里

// 弹窗看的是哪一串：现在的世界（world），或者“我的地图”里的一张
export type VersionScope = { t: 'world' } | { t: 'map'; id: string; name: string };
export const versionsDialog = signal<VersionScope | null>(null);
pushEscape(ESC_RANK.versionsDialog, () => {
  if (!versionsDialog.value) return false;
  versionsDialog.value = null;
  return true;
});

export function openVersions(scope: VersionScope = { t: 'world' }) {
  versionsDialog.value = scope;
  void refreshVersions();
}

// 别的页面往同一张地图里存过、盖掉之前留了一份：说一声
versionEvents.replaced = (name) => showToast(T.replaced(name));

// ---------- 写什么 ----------

const two = (n: number) => String(n).padStart(2, '0');
const dayStart = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
// “今天 14:05”“昨天 09:12”“11月3日 20:10”，不是今年的带年份
export function versionWhen(t: number, now: number): string {
  const d = new Date(t);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}年`}${date} ${time}`;
}

// 列表的一行：时间；灰字（几步、为什么留的）
export function versionRow(v: VersionInfo, now: number): { when: string; note: string } {
  const why = T.why[v.why];
  return { when: versionWhen(v.at, now), note: [T.steps(v.steps), why].filter(Boolean).join(' · ') };
}

// 现在的世界有几份（“世界”菜单的一行）；别的没存的世界有几份也算（都在那个弹窗里）
export function versionCount(list: readonly VersionInfo[] | null, series: string | null): number {
  return (list ?? []).filter((v) => v.series === series || seriesMap(v.series) === null).length;
}
// 一张地图有几份
export const mapVersionCount = (list: readonly VersionInfo[] | null, mapId: string): number => (list ?? []).filter((v) => v.series === mapSeries(mapId)).length;

export interface VersionGroup {
  // 这一段是现在开着的世界的（按钮是“回到这一份”）；不是时是别的没存的世界（按钮是“打开”）
  current: boolean;
  // 小标题（现在的世界那一段没有）和下面一行灰字
  title: string | null;
  hint: string | null;
  rows: VersionInfo[];
}
// 弹窗里列哪些、怎么分段。看现在的世界：先是它自己的，再是别的没存进“我的地图”的世界（一个世界一段，最近的在前）；
// 看一张地图：只有它的
export function versionGroups(list: readonly VersionInfo[], scope: VersionScope, series: string | null): VersionGroup[] {
  if (scope.t === 'map') {
    const mine = list.filter((v) => v.series === mapSeries(scope.id));
    return [{ current: series === mapSeries(scope.id), title: null, hint: null, rows: mine }];
  }
  const out: VersionGroup[] = [{ current: true, title: null, hint: null, rows: list.filter((v) => v.series === series) }];
  const others = new Map<string, VersionInfo[]>();
  for (const v of list) {
    if (v.series === series || seriesMap(v.series) !== null) continue;
    const g = others.get(v.series);
    if (g) g.push(v);
    else others.set(v.series, [v]);
  }
  let first = true;
  for (const rows of others.values()) {
    const head = rows[0];
    out.push({ current: false, title: first ? T.others : null, hint: first ? T.othersHint : head.kind && head.cells ? describeMap({ kind: head.kind, sizeKm: head.sizeKm ?? 0, cells: head.cells }) : null, rows });
    first = false;
  }
  return out;
}

// ---------- 做什么 ----------

// 那一份的世界文件；读不出来时说一声
async function docOf(v: VersionInfo): Promise<{ text: string; doc: WorldDoc } | null> {
  const text = await versionText(v.id);
  if (text === null) {
    showToast(T.gone, true);
    void refreshVersions();
    return null;
  }
  try {
    return { text, doc: JSON.parse(text) as WorldDoc };
  } catch {
    showToast(T.failed, true);
    return null;
  }
}

// 现在的样子没能留下来：问还回不回去（能先导出）
async function askNotKept(): Promise<boolean> {
  for (;;) {
    const a = await askUser({
      title: T.notKept.title,
      text: T.notKept.text,
      choices: [
        { value: 'export', label: T.notKept.export, primary: true },
        { value: 'go', label: T.notKept.go },
        { value: 'cancel', label: T.notKept.cancel },
      ],
    });
    if (a === 'go') return true;
    if (a !== 'export') return false;
    await exportCurrent();
  }
}

// 回到这一份（现在开着的世界的、或者“我的地图”里一张的）；别的没存的世界的是“打开”。
// 回去之前先把要被换掉的样子留一份——所以回去本身能反悔
export async function restoreVersion(v: VersionInfo): Promise<boolean> {
  const got = await docOf(v);
  if (!got) return false;
  const mapId = seriesMap(v.series);
  const now = Date.now();
  const current = v.series === currentSeries.value;
  if (current) {
    // 现在开着的世界：留一份现在的样子
    if (!(await keepVersion('before-restore')) && !(await askNotKept())) return false;
  } else {
    // 别的世界：现在的世界照平常换世界那样先问要不要保存，也留一份
    if (!(await beforeLeave())) return false;
    if (mapId) {
      // “我的地图”里的一张：它现在存着的样子留一份（打开以后自动保存会把那一张换成这一份）
      try {
        const [entry, doc] = await Promise.all([idbMapStore.entry(mapId), idbMapStore.doc(mapId)]);
        if (!entry || !doc) {
          showToast(T.gone, true);
          return false;
        }
        const kept = await keepText({ series: v.series, text: JSON.stringify(doc), steps: doc.commands.length, why: 'before-restore', name: entry.name, summary: entry, thumb: entry.thumb ?? null });
        if (!kept && !(await askNotKept())) return false;
      } catch {
        showToast(T.failed, true);
        return false;
      }
    }
  }
  const link = mapId ? await idbMapStore.entry(mapId).catch(() => undefined) : undefined;
  versionsDialog.value = null;
  if (!(await loadDoc(got.doc))) return false;
  if (mapId && link) {
    // 接着连着那一张：下一次自动保存把它换成这一份
    mapLink.value = { id: mapId, name: link.name, epoch: worldEpoch.value };
    mapSavedState.value = -1;
    noteMapSeen(mapId, link.savedAt);
    noteThumb(0);
  } else if (!mapId) {
    // 没存进“我的地图”的世界：还是它，版本接着记在同一个编号上
    adoptWorldId(v.series.slice(2));
  }
  void autosaveNow();
  const when = versionWhen(v.at, now);
  showToast(current || mapId ? T.restored(when) : T.opened(when));
  return true;
}

export async function exportVersion(v: VersionInfo): Promise<boolean> {
  const text = await versionText(v.id);
  if (text === null) {
    showToast(T.gone, true);
    void refreshVersions();
    return false;
  }
  download(versionFileName(v), text, 'application/json');
  return true;
}

// 删除：先问（删了找不回来）
export async function removeVersionAsk(v: VersionInfo): Promise<boolean> {
  const a = await askUser({
    title: T.deleteTitle,
    text: T.deleteText,
    choices: [
      { value: 'delete', label: '删除', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (a !== 'delete') return false;
  try {
    await deleteVersion(v.id);
  } catch {
    showToast('删除失败：浏览器存储不可用', true);
    return false;
  }
  return true;
}

export { versions };
