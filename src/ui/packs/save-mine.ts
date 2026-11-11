import type { ContentRef } from '../../../core/content/links';
import { recordedOrigin } from '../../../core/content/origin';
import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import { PACK_FORMAT, PACK_VERSION, type PackNode, type PackWorld, type ResourcePack, canApply, packItems, packSections, sameItem } from '../../../core/packs';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { importToPack } from '../../../core/packs/closure';
import { savedBackItem, sourceDiff } from '../../../core/packs/source-diff';
import type { LibraryEntry } from '../../library';
import { replaceItem } from '../../library-edit';
import { hasEra, isLibrary } from '../domain/packChoice';

// 存到我的库（第九十二轮）：一个动作、一种文字、一个去向。
//
// 以前有三个“存到我的库”，去向各不一样：一项和来源的库不同时“存回”来源的库（只读的先复制）；自己新建的一项存进“我的资源”
// （没有时代，新建地图时选不到——存进去就再也用不上）；“⋯”里的是挑几样做成另一个包。现在都存进同一个库：
// **我的库**——一个带时代、带世界底子的库，新建地图的向导里选得到（domain/packChoice.ts 的 isLibrary(…, true)）。
//
//   去向（myLibraryOf）：这张地图用的库就是我的库时是它；不然是上次存进去的那个；不然是第一个新建地图时选得到的我的库；
//   一个都没有时（copyBaseOf）把这张地图用的库复制一份叫“我的库”（内置的库只读，复制出来的才能改；这张地图用的库不在了时复制默认的库）。
//   怎么存（savePlan）：这一项是从这个库来的（或这个库里有同 id 的一项）就换掉库里的那一份（id、引用换回库里的写法，
//   core/packs/source-diff.ts 的 savedBackItem）；库里没有的新加，它写到的、库里没有的内容一起带上（导入的闭包，
//   core/packs/closure.ts：和“从别的库添加…”同一套规则，只是来源是这张地图）。几项一起存是一步，撤销一次全回去。
//
// 这里只算（不碰界面、不写存储，测试直接调）；写入、提示、撤销在 save-mine-run.ts

export const MY_LIBRARY_NAME = '我的库';

type Entry = Pick<LibraryEntry, 'key' | 'pack' | 'mine' | 'builtin'> & { file?: string };

// 新建地图的向导里选得到的我的库
export const usableForNew = (e: Entry): boolean => e.mine && !e.builtin && !e.file && isLibrary(e.pack, true);

// 存进哪一个库；还没有时 null（先复制一份，见 copyBaseOf）
export function myLibraryOf<E extends Entry>(lib: readonly E[], worldLib: string | undefined, remembered: string | null): E | null {
  const ok = lib.filter(usableForNew);
  return ok.find((e) => e.key === worldLib) ?? ok.find((e) => e.key === remembered) ?? ok[0] ?? null;
}

// 还没有我的库时复制哪一个库来做它：这张地图用的库（够新建地图用时），不然默认的库，再不然第一个够用的
export function copyBaseOf(lib: readonly Entry[], worldLib: string | undefined): string | null {
  const ok = (e: Entry) => !e.file && isLibrary(e.pack, true);
  return (lib.find((e) => e.key === worldLib && ok(e)) ?? lib.find((e) => e.key === DEFAULT_LIBRARY && ok(e)) ?? lib.find(ok))?.key ?? null;
}

// 这张地图里能存进库的全部内容，当作一个来源（导入的闭包要一个包）。按世界记着
const worldPacks = new WeakMap<object, PackNode>();
export function worldAsPack(world: PackWorld): PackNode {
  let p = worldPacks.get(world);
  if (p) return p;
  p = { id: 'this-world', name: '这张地图' };
  for (const k of packSections()) {
    if (!canApply(k)) continue;
    const items = k.inWorld(world).map((x) => (k.pack.exportItem ? k.pack.exportItem(x) : x));
    if (items.length) p[k.pack.key] = items;
  }
  worldPacks.set(world, p);
  return p;
}

export interface SavePlan {
  // 存完以后的库（和原来的是同一个对象时什么都没变）
  pack: ResourcePack;
  // 真的写进去几项（连带上的也算）
  count: number;
  // 存进去的各项的名字（用户点的在前）
  names: string[];
  // 和库里的一模一样、不用存的
  same: string[];
  // 这一项写到了、这个库里没有、也带不上的（存进去以后在库里找不到）
  missing: string[];
  // 存不进去的：原因
  skipped: string[];
}

const worldItem = (kind: ContentKind, id: string, world: PackWorld): unknown => kind.inWorld(world).find((x) => itemId(kind, x) === id);
const packItem = (pack: PackNode, kind: ContentKind, id: string): unknown => packItems(pack, kind.pack.key).find((x) => itemId(kind, x) === id);

// 把这张地图里的几项存进 dest 这个库。纯函数：返回新的库和各项的去向
export function savePlan(refs: readonly ContentRef[], world: PackWorld, dest: Pick<ResourcePack, 'id' | 'name'> & PackNode): SavePlan {
  let pack = dest as ResourcePack;
  const out: SavePlan = { pack, count: 0, names: [], same: [], missing: [], skipped: [] };
  const put = (kind: ContentKind, id: string, next: unknown, name: string) => {
    const parsed = kind.schema.safeParse(next);
    if (!parsed.success) {
      out.skipped.push(`${kind.label}“${name}”：格式不对`);
      return;
    }
    pack = replaceItem(pack, kind, id, parsed.data);
    out.count++;
    out.names.push(name);
  };
  for (const ref of refs) {
    const kind = kindOf(ref.kind);
    const item = kind && worldItem(kind, ref.id, world);
    if (!kind || item === undefined || !canApply(kind)) continue;
    const name = itemName(kind, item);
    // 1. 从库里来的一项：和库里的那一份比（id、引用按库里的写法），不一样就换掉库里的
    const rec = recordedOrigin(world.small, kind.id, ref.id);
    if (rec) {
      const libs = [{ key: rec[0], pack }];
      const back = savedBackItem(kind, ref.id, item, world, libs);
      if (back) {
        put(kind, back.id, back.item, name);
        for (const m of back.missing) if (!out.missing.includes(m)) out.missing.push(m);
        continue;
      }
      const d = sourceDiff(kind, ref.id, item, world, libs);
      if (d.t === 'same' || d.t === 'trimmed') {
        out.same.push(name);
        continue;
      }
    }
    // 2. 库里有同 id 的一项（以前存过的、自己做的）：换成现在的样子
    const exported = kind.pack.exportItem ? kind.pack.exportItem(item) : item;
    const there = packItem(pack, kind, ref.id);
    if (there !== undefined) {
      if (sameItem(there, exported)) out.same.push(name);
      else put(kind, ref.id, exported, name);
      continue;
    }
    // 3. 库里没有：新加，它写到的、库里没有的一起带上
    const r = importToPack({ source: worldAsPack(world), target: { t: 'pack', pack }, picks: [ref] });
    if (r.pack === pack || !r.preview.count) {
      out.skipped.push(`${kind.label}“${name}”：${r.preview.dropped[0]?.reason ?? '放不进这个库'}`);
      continue;
    }
    pack = r.pack as ResourcePack;
    out.count += r.preview.count;
    const lead = r.preview.rows.find((x) => x.kind === ref.kind && x.id === ref.id);
    out.names.push(...[...(lead ? [lead] : []), ...r.preview.rows.filter((x) => x !== lead)].map((x) => x.name).filter((n) => !out.names.includes(n)));
  }
  out.pack = pack;
  return out;
}

// 这张地图里值得存的：自己做的（没有来源）、和 dest 这个库里那一份不一样的。“⋯ → 存到我的库…”一次都存
export function saveableRefs(world: PackWorld, dest: PackNode): ContentRef[] {
  const out: ContentRef[] = [];
  for (const kind of packSections()) {
    if (!canApply(kind)) continue;
    for (const item of kind.inWorld(world)) {
      const id = itemId(kind, item);
      const rec = recordedOrigin(world.small, kind.id, id);
      if (rec) {
        if (sourceDiff(kind, id, item, world, [{ key: rec[0], pack: dest }]).t === 'changed') out.push({ kind: kind.id, id });
        continue;
      }
      const there = packItem(dest, kind, id);
      const exported = kind.pack.exportItem ? kind.pack.exportItem(item) : item;
      if (there === undefined || !sameItem(there, exported)) out.push({ kind: kind.id, id });
    }
  }
  return out;
}

// ---------- 说的话 ----------

const head = (names: readonly string[], count: number): string => (count > 1 ? `“${names[0]}”等 ${count} 项` : `“${names[0]}”`);

// 撤销条上写的这一步
export const saveLabel = (p: Pick<SavePlan, 'names' | 'count'>): string => `存${head(p.names, p.count)}`;

// 存完顶上那一句：去了哪、以后怎么用上
export function savedNote(p: Pick<SavePlan, 'names' | 'count' | 'missing' | 'skipped'>, libName: string): string {
  const lost = p.missing.length ? `；这个库里没有：${p.missing.slice(0, 3).join('、')}` : '';
  const skipped = p.skipped.length ? `；有 ${p.skipped.length} 项没存进去` : '';
  return `已把${head(p.names, p.count)}存到“${libName}”：新建地图时选“${libName}”就带上${lost}${skipped}`;
}

// 没有可存的时候说什么
export function nothingNote(p: Pick<SavePlan, 'same' | 'skipped'>, libName: string): string {
  if (p.skipped.length) return `没存进去：${p.skipped[0]}`;
  return p.same.length ? `“${libName}”里已经是这样` : '没有要存的';
}

// ---------- 没有时代的库（以前存的“我的资源”“来自《X》”）并进我的库 ----------

// 这个库新建地图时选不到（没有时代，或不够完整）、里面又有东西：首页上给“并进我的库”
export function mergeable(e: Entry): boolean {
  if (e.builtin || e.file || isLibrary(e.pack, true)) return false;
  return packSections().some((k) => packItems(e.pack, k.pack.key).length > 0);
}
// 首页上那一句：没有时代，还是不够完整
export const lacksEra = (e: Pick<Entry, 'pack'>): boolean => !hasEra(e.pack);

// 这个库里的全部内容并进 dest（导入的闭包；同 id、内容不同的并存，不盖掉 dest 里的）
export function mergePlan(from: PackNode, dest: ResourcePack): SavePlan {
  const picks: ContentRef[] = packSections().flatMap((k) => [...new Set(packItems(from, k.pack.key).map((x) => itemId(k, x)))].map((id) => ({ kind: k.id, id })));
  const r = importToPack({ source: from, target: { t: 'pack', pack: dest }, picks });
  const names = r.preview.rows.map((x) => x.name);
  return { pack: r.pack as ResourcePack, count: r.preview.count, names, same: [], missing: [], skipped: r.preview.dropped.map((d) => `${d.kindLabel}“${d.name}”：${d.reason}`) };
}

// 我的库的空壳只在测试里用（界面是复制一个完整的库）
export const emptyPack = (id: string, name: string): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name });
