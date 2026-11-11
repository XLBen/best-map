import { computed, signal } from '@preact/signals';
import type { Role } from '../autosave-lock';
import { isQuotaError } from '../maps';
import { busy } from './worker-host';
import { world, worldState } from './world';

// 自动保存现在怎么样（第九十四轮）：界面读这里的信号（顶栏“世界”上的记号、“世界”菜单的第一行、顶上的一条、关页面前的提醒）。
// 规则是纯函数（测试直接调）；写在 autosave.ts

// 没存成的原因：存储满了；浏览器存储不可用（隐私模式）；世界太大（存储不可用时退回的小地方放不下）
export type SaveFail = 'quota' | 'unavailable' | 'too-big';
// 加上：这个页面不是写的那一方（这个世界已在另一个页面打开）
export type SaveProblem = SaveFail | 'other-page';

// 最近一次自动保存没存成的原因（存成了、还没存过时 null）
export const saveFail = signal<SaveFail | null>(null);
// 这个页面是不是写自动保存的那一方
export const saveRole = signal<Role>('unknown');
// 写进自动保存的那一份是世界的哪个状态（worldState 的值；还没写过时 -2）
export const savedState = signal(-2);
// 浏览器给的存储快满了（用掉九成以上）
export const storageTight = signal(false);

// 自动保存没写成时怎么分原因。idb：IndexedDB 那一次的错；local：退回 localStorage 那一次的错（'blocked'：位置上压着没能挪走的旧世界）
export function failWhy(idb: unknown, local: unknown): SaveFail {
  if (isQuotaError(idb) || local === 'blocked') return 'quota';
  return isQuotaError(local) ? 'too-big' : 'unavailable';
}

// 现在要告诉用户的那一种（没有世界时不说；不是写的那一方先说）
export function saveProblemOf(s: { world: boolean; role: Role; fail: SaveFail | null }): SaveProblem | null {
  if (!s.world) return null;
  if (s.role === 'other') return 'other-page';
  return s.fail;
}

// 现在有没有没存进自动保存的改动：世界不是写下的那个状态（改了还没到写的时候、正在写、没写成、这个页面不写），
// 或者计算程序里还有没应答的编辑
export function hasUnsaved(s: { world: boolean; state: number; saved: number; pending: boolean }): boolean {
  return s.world && (s.pending || s.state !== s.saved);
}

export const saveProblem = computed<SaveProblem | null>(() => saveProblemOf({ world: world.value !== null, role: saveRole.value, fail: saveFail.value }));
export const unsaved = computed(() => hasUnsaved({ world: world.value !== null, state: worldState.value, saved: savedState.value, pending: busy.value !== null }));
