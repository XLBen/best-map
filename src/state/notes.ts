import { signal } from '@preact/signals';
import type { World } from '../../core/world';
import { NOTE_ACTION_MS, NOTE_MS, PausableTimer } from '../notice-timer';
import { world } from './world';

// 顶上的提示（第七十轮从 state.ts 分出来）：一句话的提示、缺了内容跳过的步骤、编辑后的“改了什么”与几秒钟的高亮

export const toast = signal<{ text: string; error: boolean } | null>(null);
// 缺了内容跳过的步骤（第三十轮）：顶上的横幅说一次，关掉、点“从资源库添加…”、新建或打开别的世界时去掉
export const skippedNote = signal<{ id: number; notes: string[] } | null>(null);
let skippedId = 0;
export function noteSkipped(notes: readonly string[] | undefined) {
  if (notes?.length) skippedNote.value = { id: ++skippedId, notes: [...notes] };
}

// 编辑后的变化：一句话汇总（带撤销、“换一个”）与几秒钟的高亮
// action：提示条上的另一个按钮（比如新建了特有生态后的“编辑”）
export type NoteAction = { label: string; run: () => void };
// undo：撤销的不是世界（加到我的库之后的提示条，第六十七轮）
export const changeNote = signal<{ id: number; head: string; detail: string; undoable: boolean; action?: NoteAction; undo?: () => void } | null>(null);
export const flash = signal<{ cells: number[]; at: number } | null>(null);
// 改完后变化的格淡淡地亮一下，这么久（毫秒）淡完
export const FLASH_MS = 1200;

// 改的不是世界（存回我的库）：顶上说一句，带一个按钮；undo：再带一个“撤销”（撤销那个库）
export function noteAction(head: string, action: NoteAction | undefined, undo?: () => void) {
  changeNote.value = { id: ++noteId, head, detail: '', undoable: false, ...(action ? { action } : {}), ...(undo ? { undo } : {}) };
  noteTimer.start(NOTE_ACTION_MS);
}

export function showToast(text: string, error = false) {
  toast.value = { text, error };
  const current = toast.value;
  setTimeout(() => {
    if (toast.value === current) toast.value = null;
  }, error ? 6000 : 2500);
}

// 编辑前后的差别：哪些格变了、用一句话怎么说
export function describeChange(a: World, b: World): { cells: number[]; detail: string } {
  if (a.mesh !== b.mesh) return { cells: [], detail: '' };
  const n = a.mesh.n;
  const cells: number[] = [];
  let gained = 0;
  let lost = 0;
  let biome = 0;
  let relief = 0;
  let temp = 0;
  let province = 0;
  const riverChanged = new Uint8Array(n);
  const thrA = a.small.planet.riverThreshold;
  const thrB = b.small.planet.riverThreshold;
  const sp = (w: World, i: number) => {
    const s = w.derived.dominant[i];
    return s >= 0 ? w.small.species[s]?.id : String(s);
  };
  // 只换了省份的格（切开、合并、涂省）：另记，最后看情况一起闪
  const provinceOnly: number[] = [];
  for (let i = 0; i < n; i++) {
    const la = a.causes.land[i];
    const lb = b.causes.land[i];
    const pc = a.causes.province[i] !== b.causes.province[i];
    if (pc) province++;
    if (la !== lb) {
      if (lb) gained++;
      else lost++;
      cells.push(i);
      continue;
    }
    if (!lb) {
      if (pc) provinceOnly.push(i);
      continue;
    }
    let changed = false;
    if (sp(a, i) !== sp(b, i)) {
      biome++;
      changed = true;
    }
    if (Math.abs(a.derived.elevation[i] - b.derived.elevation[i]) > 30) {
      relief++;
      changed = true;
    }
    if (Math.abs(a.derived.tMean[i] - b.derived.tMean[i]) > 0.5) {
      temp++;
      changed = true;
    }
    const ra = a.derived.discharge[i] >= thrA && a.derived.lake[i] !== 1;
    const rb = b.derived.discharge[i] >= thrB && b.derived.lake[i] !== 1;
    if (ra !== rb || a.derived.lake[i] !== b.derived.lake[i]) {
      riverChanged[i] = 1;
      changed = true;
    }
    if (changed) cells.push(i);
    else if (pc) provinceOnly.push(i);
  }
  // 切省、合并、涂省也闪一下；整张图重新划分（三成以上的格换了省）时不闪，免得整张图一亮
  if (province <= n * 0.3) for (const i of provinceOnly) cells.push(i);
  // 河道的变化按连通的片数计
  let rivers = 0;
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!riverChanged[i] || seen[i]) continue;
    rivers++;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      for (let e = a.mesh.off[q[h]]; e < a.mesh.off[q[h] + 1]; e++) {
        const j = a.mesh.adj[e];
        if (riverChanged[j] && !seen[j]) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
  }
  const parts: string[] = [];
  if (gained) parts.push(`陆地 +${gained} 格`);
  if (lost) parts.push(`陆地 −${lost} 格`);
  if (relief) parts.push(`${relief} 格地势变了`);
  if (temp) parts.push(`${temp} 格气温变了`);
  if (biome) parts.push(`${biome} 格生态变了`);
  if (rivers) parts.push(`${rivers} 处河道变了`);
  if (province && !parts.length) parts.push(`${province} 格换了省份`);
  return { cells, detail: parts.join('，') };
}

let noteId = 0;
// 改完后的一句话多久消失：带按钮（撤销、换一个……）的 20 秒，别的 9 秒；鼠标停在提示条上时暂停（holdNote）
const noteTimer = new PausableTimer(() => (changeNote.value = null));
export function holdNote(on: boolean) {
  if (on) noteTimer.pause();
  else noteTimer.resume();
}
let flashTimer: ReturnType<typeof setTimeout> | null = null;

// 让这些格淡淡地亮一下（比如“地图上有一处出错（点这里去看）”），FLASH_MS 后去掉
export function flashCells(cells: number[]) {
  flash.value = cells.length ? { cells, at: performance.now() } : null;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.value = null), FLASH_MS);
}

// quiet：不闪变了的格（改河：拖的时候地图上已经是改完的样子，松手后再闪一圈反而像出了别的变化）
export function noteChange(head: string, before: World | null, undoable = true, action?: NoteAction, quiet = false) {
  const after = world.value;
  if (!after || !before) return;
  const { cells, detail } = describeChange(before, after);
  const id = ++noteId;
  changeNote.value = { id, head, detail, undoable, action };
  noteTimer.start(undoable || action ? NOTE_ACTION_MS : NOTE_MS);
  flash.value = cells.length && !quiet ? { cells, at: performance.now() } : null;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.value = null), FLASH_MS);
}
