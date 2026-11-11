import { continues } from './autosave-io';
import { idbAll, idbGet, idbTx } from './idb';
import { type MapEntry, type MapKind, type MapStore, isQuotaError, overwriteMap } from './maps';
import type { WorldDoc } from '../core/engine';

// 以前的版本（第九十五轮）。
// 自动保存只有一份、“我的地图”里每张也只有一份：画坏了又存下了，就回不去。现在每个世界自动留几份以前的样子。
//   一份版本是整份世界文件的字（和导出的文件一字不差），放在 versionDocs 表；列表要用的一小条（时间、几步、多大、缩略图）
//   放在 versions 表——打开列表不用把每一份都读出来。两张表总在同一个事务里写。
//   属于哪个世界（series）：连着“我的地图”里的一张时是 m:<那一张的 id>；没存进“我的地图”的（只有自动保存的）是 w:<世界的编号>
//   ——世界的编号是新建、打开时起的，记在自动保存的头里（wid），刷新以后还是同一个。第一次存进“我的地图”时这一串跟着改到那一张上。
//   留哪些（thin）：越近留得越密——最近一小时每 5 分钟一份、一天之内每小时一份、昨天每 6 小时一份、一周之内每天一份，
//   再早的只留最新的一份。回去之前留的、被换掉之前留的那几种一周之内不稀疏。
//   没存进“我的地图”、也不是现在开着的世界：只留最近的 ORPHAN_WORLDS 个（再早的整串丢掉）。
//   合计有字节的上限（budget）：超过了从最旧的丢起，刚写的那一份不丢。
// 这里是规则和存取：规则只经 VersionIo 碰存储，测试换成内存里的（memoryVersionIo）。
// 信号、什么时候写在 state/versions.ts；界面在 ui/maps/versions.ts、VersionsDialog.tsx

// 为什么留的这一份：平常隔一阵留的；打开时留的（上次结束时的样子）；回到以前的版本之前留的；
// 被别的页面（或这个页面的保存）换掉之前留的；重新载入之前这个页面里的
export type VersionWhy = 'auto' | 'opened' | 'before-restore' | 'replaced' | 'before-reload';

export interface VersionInfo {
  id: string;
  series: string;
  // 留下的时间
  at: number;
  steps: number;
  // 占多少（世界文件的字数 × 2，加缩略图）
  bytes: number;
  why: VersionWhy;
  // 那时的名字（连着的那一张的名字；没存进“我的地图”的没有）、概况（列表里写“一块地区 · 4 万格”）
  name?: string;
  kind?: MapKind;
  sizeKm?: number;
  cells?: number;
  thumb?: string;
}

export const mapSeries = (mapId: string) => `m:${mapId}`;
export const worldSeries = (worldId: string) => `w:${worldId}`;
// 是哪一张地图的（不是连着地图的那一种时 null）
export const seriesMap = (series: string): string | null => (series.startsWith('m:') ? series.slice(2) : null);

export interface VersionIo {
  // 全部的小条（不带世界文件）
  list(): Promise<VersionInfo[]>;
  // 那一份世界文件的字；不在了时 undefined
  text(id: string): Promise<string | undefined>;
  // 一个事务：放进一份、改几份的小条、删掉几份。存储用不了、满了时抛错
  commit(c: { put?: { info: VersionInfo; text: string }; update?: readonly VersionInfo[]; drop?: readonly string[] }): Promise<void>;
}

// ---------- 留哪些 ----------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 多久以内、每多久留一份（从近到远）
export const TIERS: readonly { within: number; every: number }[] = [
  { within: HOUR, every: 5 * MIN },
  { within: DAY, every: HOUR },
  { within: 2 * DAY, every: 6 * HOUR },
  { within: 8 * DAY, every: DAY },
];
// 平常隔多久留一份（最密的那一档）
export const VERSION_EVERY_MS = TIERS[0].every;
// 回去之前留的、被换掉之前留的：这么久以内不稀疏
const SPECIAL_MS = TIERS[TIERS.length - 1].within;
const special = (why: VersionWhy | undefined) => why !== undefined && why !== 'auto' && why !== 'opened';

// 一个世界的几份里留哪些：给时间（和为什么留的）、现在的时间 → 留下的那几份的下标（从小到大）。
// 每一档按固定的格子（时间整除间隔）分，一格里留最新的一份；最远一档以外的只留最新的一份
export function thin(list: readonly { at: number; why?: VersionWhy }[], now: number): number[] {
  const best = new Map<string, number>();
  const keep = new Set<number>();
  list.forEach((v, k) => {
    const age = Math.max(0, now - v.at);
    if (special(v.why) && age < SPECIAL_MS) {
      keep.add(k);
      return;
    }
    const tier = TIERS.findIndex((t) => age < t.within);
    const key = tier < 0 ? 'old' : `${tier}:${Math.floor(v.at / TIERS[tier].every)}`;
    const cur = best.get(key);
    if (cur === undefined || list[cur].at < v.at || (list[cur].at === v.at && cur < k)) best.set(key, k);
  });
  for (const k of best.values()) keep.add(k);
  return [...keep].sort((a, b) => a - b);
}

// 合计最多占多少（字节）。浏览器说得出一共给多少（quota）时不超过它的四分之一；用掉九成以上（快满了）时减半
export const VERSION_BYTES = 400 * 1024 * 1024;
export function versionBudget(est: { quota?: number; usage?: number } | null, cap = VERSION_BYTES): number {
  if (!est || !est.quota || !(est.quota > 0)) return cap;
  let b = Math.min(cap, est.quota / 4);
  if (typeof est.usage === 'number' && est.usage / est.quota >= 0.9) b /= 2;
  return Math.floor(b);
}

// 没存进“我的地图”的世界最多留几个的版本（现在开着的那个不算在里面）
export const ORPHAN_WORLDS = 6;

// 要丢掉哪几份：没存的旧世界只留最近几个；各个世界按时间稀疏；再看合计——超过上限从最旧的丢起。
// protect：这一份不丢（刚写的）；current：这一串是现在开着的世界（不算没存的旧世界）
export function planDrop(list: readonly VersionInfo[], now: number, budget: number, keep: { protect?: string; current?: string | null } = {}): string[] {
  const { protect } = keep;
  const drop = new Set<string>();
  const bySeries = new Map<string, VersionInfo[]>();
  for (const v of list) {
    const g = bySeries.get(v.series);
    if (g) g.push(v);
    else bySeries.set(v.series, [v]);
  }
  const orphans = [...bySeries.entries()]
    .filter(([s, g]) => seriesMap(s) === null && s !== keep.current && !g.some((v) => v.id === protect))
    .map(([s, g]) => ({ s, at: Math.max(...g.map((v) => v.at)) }))
    .sort((a, b) => b.at - a.at || (a.s < b.s ? -1 : 1));
  for (const { s } of orphans.slice(ORPHAN_WORLDS)) {
    for (const v of bySeries.get(s)!) drop.add(v.id);
    bySeries.delete(s);
  }
  for (const g of bySeries.values()) {
    const keep = new Set(thin(g, now));
    g.forEach((v, k) => {
      if (!keep.has(k) && v.id !== protect) drop.add(v.id);
    });
  }
  const left = list.filter((v) => !drop.has(v.id)).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  let total = left.reduce((n, v) => n + v.bytes, 0);
  for (const v of left) {
    if (total <= budget) break;
    if (v.id === protect) continue;
    drop.add(v.id);
    total -= v.bytes;
  }
  return [...drop];
}

// ---------- 存、删、改键 ----------

let seq = 0;
function newVersionId(now: number): string {
  return `v${now.toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const versionBytes = (text: string, thumb?: string | null): number => text.length * 2 + (thumb ? thumb.length : 0);

export interface NewVersion {
  series: string;
  text: string;
  steps: number;
  why: VersionWhy;
  name?: string;
  summary?: Pick<MapEntry, 'kind' | 'sizeKm' | 'cells'>;
  thumb?: string | null;
}

// 一个世界最新的那一份
export function latestOf(list: readonly VersionInfo[], series: string): VersionInfo | null {
  let best: VersionInfo | null = null;
  for (const v of list) if (v.series === series && (!best || v.at > best.at || (v.at === best.at && v.id > best.id))) best = v;
  return best;
}

export type AddResult =
  // 留下了；dropped：顺带丢掉的几份
  | { kind: 'kept'; info: VersionInfo; dropped: string[] }
  // 和这个世界最新的那一份一样，不用再留
  | { kind: 'same'; info: VersionInfo }
  // 没留成（存储满了、用不了）
  | { kind: 'failed'; error: unknown };

// 留一份。和这个世界最新的那一份一字不差时不留。写不进去（满了）时先丢掉一半旧的再试一次
export async function addVersion(io: VersionIo, v: NewVersion, opts: { now?: number; budget?: number; current?: string | null } = {}): Promise<AddResult> {
  const now = opts.now ?? Date.now();
  const budget = opts.budget ?? VERSION_BYTES;
  const keep = (id: string) => ({ protect: id, current: opts.current ?? null });
  try {
    const list = await io.list();
    const last = latestOf(list, v.series);
    const bytes = versionBytes(v.text, v.thumb);
    if (last && last.steps === v.steps && last.bytes - (last.thumb?.length ?? 0) === v.text.length * 2 && (await io.text(last.id)) === v.text) return { kind: 'same', info: last };
    const info: VersionInfo = {
      id: newVersionId(now),
      series: v.series,
      at: now,
      steps: v.steps,
      bytes,
      why: v.why,
      ...(v.name ? { name: v.name } : {}),
      ...(v.summary ? { kind: v.summary.kind, sizeKm: v.summary.sizeKm, cells: v.summary.cells } : {}),
      ...(v.thumb ? { thumb: v.thumb } : {}),
    };
    const put = { info, text: v.text };
    const drop = planDrop([...list, info], now, budget, keep(info.id));
    try {
      await io.commit({ put, drop });
      return { kind: 'kept', info, dropped: drop };
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      // 满了：把旧的丢掉一半（先腾地方，单独一个事务），再试一次
      const more = planDrop(list, now, Math.floor(list.reduce((n, x) => n + x.bytes, 0) / 2), { current: opts.current ?? null });
      if (!more.length) throw e;
      await io.commit({ drop: more });
      const rest = list.filter((x) => !more.includes(x.id));
      const drop2 = planDrop([...rest, info], now, budget, keep(info.id));
      await io.commit({ put, drop: drop2 });
      return { kind: 'kept', info, dropped: [...more, ...drop2] };
    }
  } catch (error) {
    return { kind: 'failed', error };
  }
}

// 腾地方（自动保存写不进去时）：把旧的版本丢掉一半（至少一份）。返回丢了几份
export async function makeRoom(io: VersionIo, now = Date.now()): Promise<number> {
  const list = await io.list();
  if (!list.length) return 0;
  const total = list.reduce((n, v) => n + v.bytes, 0);
  let drop = planDrop(list, now, Math.floor(total / 2));
  if (!drop.length) drop = [list.reduce((a, b) => (a.at <= b.at ? a : b)).id];
  await io.commit({ drop });
  return drop.length;
}

export async function removeVersion(io: VersionIo, id: string): Promise<void> {
  await io.commit({ drop: [id] });
}

// 一个世界的版本都改到另一个键上（第一次存进“我的地图”：w:<编号> → m:<地图>；连着的那一张删掉了：反过来）
export async function moveSeries(io: VersionIo, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  const mine = (await io.list()).filter((v) => v.series === from);
  if (mine.length) await io.commit({ update: mine.map((v) => ({ ...v, series: to })) });
  return mine.length;
}

export async function dropSeries(io: VersionIo, series: string): Promise<number> {
  const mine = (await io.list()).filter((v) => v.series === series);
  if (mine.length) await io.commit({ drop: mine.map((v) => v.id) });
  return mine.length;
}

// 列表：最近留的在前
export const sortVersions = (list: readonly VersionInfo[]): VersionInfo[] => [...list].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));

// 导出的文件名：“赤原 2026-11-11 1405.json”
export function versionFileName(v: Pick<VersionInfo, 'at' | 'name'>): string {
  const d = new Date(v.at);
  const two = (n: number) => String(n).padStart(2, '0');
  const base = (v.name ?? '世界').replace(/[\\/:*?"<>|]/g, '_').trim() || '世界';
  return `${base} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}.json`;
}

// ---------- 盖掉“我的地图”里的一张之前（第九十四轮留下的静默覆盖） ----------

// 盖掉一张。known：这个页面上一次看到、写下那一张时它的保存时间。存着的不是那一次的（别的页面写过），
// 而且不是要写的这一份的开头（盖掉会丢东西）：盖之前把存着的那一份留成一个版本。
// 留不下来（存储满了）照样盖：⌘S 不能因为留版本存不成。那一张已经不在了时返回 null
export async function overwriteKeeping(
  store: MapStore,
  io: VersionIo,
  id: string,
  a: { doc: WorldDoc; thumb?: string | null; now?: number; known?: number | null; budget?: number; current?: string | null },
): Promise<{ entry: MapEntry; kept: VersionInfo | null } | null> {
  let kept: VersionInfo | null = null;
  if (a.known !== undefined) {
    try {
      const old = await store.entry(id);
      if (old && old.savedAt !== a.known) {
        const oldDoc = await store.doc(id);
        if (oldDoc && !continues(oldDoc, a.doc)) {
          const r = await addVersion(
            io,
            { series: mapSeries(id), text: JSON.stringify(oldDoc), steps: oldDoc.commands.length, why: 'replaced', name: old.name, summary: old, thumb: old.thumb ?? null },
            { now: a.now, budget: a.budget, current: a.current },
          );
          if (r.kind === 'kept') kept = r.info;
        }
      }
    } catch {
      // 读不了旧的：照样写
    }
  }
  const entry = await overwriteMap(store, id, a);
  return entry ? { entry, kept } : null;
}

// ---------- 只在内存里的（测试用） ----------

export interface MemoryVersionIo extends VersionIo {
  infos: Map<string, VersionInfo>;
  texts: Map<string, string>;
  // 存储用不了；最多放多少字节（超过就按“满了”失败）
  down: boolean;
  quota: number;
  commits: number;
}

export function memoryVersionIo(): MemoryVersionIo {
  const infos = new Map<string, VersionInfo>();
  const texts = new Map<string, string>();
  const io: MemoryVersionIo = {
    infos,
    texts,
    down: false,
    quota: Infinity,
    commits: 0,
    list: async () => {
      if (io.down) throw new Error('down');
      return [...infos.values()].map((v) => structuredClone(v));
    },
    text: async (id) => {
      if (io.down) throw new Error('down');
      return texts.get(id);
    },
    commit: async (c) => {
      if (io.down) throw new Error('down');
      // 一个事务：先在副本上做，放得下才换上
      const ni = new Map(infos);
      const nt = new Map(texts);
      for (const id of c.drop ?? []) {
        ni.delete(id);
        nt.delete(id);
      }
      for (const v of c.update ?? []) if (ni.has(v.id)) ni.set(v.id, structuredClone(v));
      if (c.put) {
        ni.set(c.put.info.id, structuredClone(c.put.info));
        nt.set(c.put.info.id, c.put.text);
      }
      let used = 0;
      for (const [id, t] of nt) used += versionBytes(t, ni.get(id)?.thumb);
      if (used > io.quota && (c.put || c.update?.length)) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
      infos.clear();
      texts.clear();
      for (const [k, v] of ni) infos.set(k, v);
      for (const [k, v] of nt) texts.set(k, v);
      io.commits++;
    },
  };
  return io;
}

// ---------- 浏览器里的 ----------

export const browserVersionIo: VersionIo = {
  list: () => idbAll<VersionInfo>('versions'),
  text: (id) => idbGet<string>('versionDocs', id),
  commit: (c) =>
    idbTx(['versions', 'versionDocs'], 'readwrite', (infos, docs) => {
      for (const id of c.drop ?? []) {
        infos.delete(id);
        docs.delete(id);
      }
      for (const v of c.update ?? []) infos.put(v, v.id);
      if (c.put) {
        infos.put(c.put.info, c.put.info.id);
        docs.put(c.put.text, c.put.info.id);
      }
    }),
};
