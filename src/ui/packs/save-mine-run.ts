import type { Command } from '../../../core/commands';
import type { ContentRef } from '../../../core/content/links';
import { recordedOrigin } from '../../../core/content/origin';
import { itemId, kindOf } from '../../../core/content/registry';
import { worldLibrary } from '../../../core/packs/switch';
import type { World } from '../../../core/world';
import { type LibraryEntry, library } from '../../library';
import { copyLibrary, libEdits } from '../../library-edit';
import { askUser, noteAction, showToast } from '../../state';
import { rememberMine, rememberedMine } from './lib-prefs';
import { queueWorld, repointCommand } from './page-actions';
import type { PageCtx } from './page-source';
import { lookAt } from './panel-store';
import { MY_LIBRARY_NAME, type SavePlan, copyBaseOf, mergePlan, myLibraryOf, nothingNote, saveLabel, savePlan, saveableRefs, savedNote } from './save-mine';
import { SAVE_TO_MINE, firstSaveText, saveAllText } from './copy';

// 存到我的库（第九十二轮）：写入、提示、撤销。算在 save-mine.ts（去向、怎么存、说的话）。
// 一项的页面上的按钮、“⋯ → 存到我的库…”、没有时代的库首页上的“并进我的库”都走这里：同一个去向，同一句话

// 存进哪个库；还没有时先问一句、复制一份（base：复制哪一个）。取消、建不了时 null
async function destination(worldLib: string | undefined, why: string | null): Promise<LibraryEntry | null> {
  // 面板打开时已经读过存储（panel-store.ts）；之后的改动都在内存里，不再读一遍（一个带六个库的存储每读一次要解开约 9 MB）
  const list = library.value;
  const have = myLibraryOf(list, worldLib, rememberedMine());
  if (have) return have;
  const base = copyBaseOf(list, worldLib);
  const from = list.find((e) => e.key === base);
  if (!base || !from) {
    showToast('没有能复制的库', true);
    return null;
  }
  if (why !== null) {
    const v = await askUser({
      title: SAVE_TO_MINE,
      text: `${why}${firstSaveText(from.pack.name)}`,
      choices: [
        { value: 'ok', label: SAVE_TO_MINE, primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (v !== 'ok') return null;
  }
  const made = await copyLibrary(base, MY_LIBRARY_NAME);
  const e = made && library.value.find((x) => x.key === made.key);
  if (!made || !e) return null;
  if (!made.stored) showToast('存不进浏览器：只在这次打开的页面里', true);
  return e;
}

// 写进去（一步，在这个库的撤销里）
function write(dest: LibraryEntry, plan: SavePlan): boolean {
  if (!plan.count || plan.pack === dest.pack) {
    showToast(nothingNote(plan, dest.pack.name), plan.skipped.length > 0);
    return false;
  }
  const done = libEdits.setPack(dest.key, plan.pack, saveLabel(plan));
  if (!done.ok) {
    showToast(done.error, true);
    return false;
  }
  rememberMine(dest.key);
  return true;
}

// 顶上说去了哪、以后怎么用上（带“去看看”、撤销：撤销的是库里的这一步）
function say(dest: LibraryEntry, plan: SavePlan, look: readonly ContentRef[]) {
  noteAction(savedNote(plan, dest.pack.name), look.length ? { label: '去看看', run: () => lookAt({ t: 'lib', key: dest.key }, look) } : undefined, () => void libEdits.undo(dest.key));
}

// 这张地图里这几项的来源记成这个库（内容不变）：之后“和库不同”的标记、再存一次都和它比。一步，在世界的撤销里
function repointAll(refs: readonly ContentRef[], key: string): Promise<boolean> {
  return queueWorld((w) => {
    const commands: Command[] = [];
    for (const r of refs) {
      const kind = kindOf(r.kind);
      const item = kind?.inWorld(w).find((x) => itemId(kind, x) === r.id);
      if (!kind || item === undefined) continue;
      const rec = recordedOrigin((w as World).small, kind.id, r.id);
      if (rec?.[0] === key) continue;
      const cmd = repointCommand(kind, r.id, item, [key, ...(rec ?? []).slice(1)], w);
      if (cmd) commands.push(cmd);
    }
    return commands.length ? { op: 'batch', label: `来源记成“${library.value.find((e) => e.key === key)?.pack.name ?? MY_LIBRARY_NAME}”`, commands } : null;
  });
}

// 把这张地图里的几项存到我的库。ask：还没有我的库时先问的那一句前面写什么（null：不问，调用的地方已经问过）
export async function saveToMine(refs: readonly ContentRef[], ctx: PageCtx, why: string | null = ''): Promise<boolean> {
  const w = ctx.world;
  if (!w || !refs.length) return false;
  const dest = await destination(worldLibrary(w.small), why);
  if (!dest) return false;
  const plan = savePlan(refs, w, dest.pack);
  if (!write(dest, plan)) return false;
  // 库里没有它们以前，来源记的是别处（内置的库）或没有：记成这个库。这一步是世界的一条命令，做完它顶上会换成它的话：最后再说存到了哪
  await repointAll(refs, dest.key);
  say(dest, plan, refs);
  return true;
}

// “⋯ → 存到我的库…”：这张地图里改过的、自己做的都存。先说有几项、去哪
export async function saveAllToMine(ctx: PageCtx): Promise<boolean> {
  const w = ctx.world;
  if (!w) return false;
  const list = library.value;
  const worldLib = worldLibrary(w.small);
  const have = myLibraryOf(list, worldLib, rememberedMine());
  const base = have ?? list.find((e) => e.key === copyBaseOf(list, worldLib));
  if (!base) {
    showToast('没有能复制的库', true);
    return false;
  }
  const refs = saveableRefs(w, base.pack);
  if (!refs.length) {
    showToast('这张地图里没有改过、自己做的内容');
    return false;
  }
  const names = refs.slice(0, 3).map((r) => {
    const kind = kindOf(r.kind)!;
    const item = kind.inWorld(w).find((x) => itemId(kind, x) === r.id) as { name?: string } | undefined;
    return item?.name ?? r.id;
  });
  const v = await askUser({
    title: `${SAVE_TO_MINE}`,
    text: saveAllText(refs.length, names, have?.pack.name ?? null, base.pack.name),
    choices: [
      { value: 'ok', label: `存 ${refs.length} 项`, primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'ok') return false;
  return saveToMine(refs, ctx, null);
}

// 没有时代的库（以前存的）整个并进我的库。原来的库留着（要删自己删）
export async function mergeIntoMine(fromKey: string, ctx: PageCtx): Promise<boolean> {
  const from = ctx.lib.find((e) => e.key === fromKey);
  if (!from) return false;
  const dest = await destination(ctx.world ? worldLibrary(ctx.world.small) : undefined, '');
  if (!dest || dest.key === fromKey) return false;
  const plan = mergePlan(from.pack, dest.pack);
  if (!write(dest, plan)) return false;
  say(dest, plan, []);
  return true;
}
