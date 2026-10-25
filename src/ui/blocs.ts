import type { Command } from '../../core/commands';
import { BLOC_KINDS, BLOC_NAMES, type BlocPatch, SUBJECT_NAMES, type SubjectKind, blocList, blocsOf } from '../../core/human';
import type { Bloc, BlocKind, CountryMeta, World } from '../../core/world';
import { selectedBloc, sheet } from '../state';
import { cellsOf, countryAt, countryOf, patchCommand, withId, withoutId } from './countries';
import { BLOC_REGION_KINDS } from './map/political';

// 帝国、联邦、同盟（第二十六轮）的界面逻辑：选中、各种 set_bloc 命令、档案的改动、国家档案里的从属与所在的集团、同盟模式里一格是什么。
// 不碰界面，测试直接调

export const BLOC_KIND_OPTIONS: [BlocKind, string][] = BLOC_KINDS.map((k) => [k, BLOC_NAMES[k]]);
export const SUBJECT_OPTIONS = Object.entries(SUBJECT_NAMES) as [SubjectKind, string][];

// 选中、打开集团的档案
export function selectBloc(id: number | null, open = true) {
  selectedBloc.value = id;
  if (id !== null && open) sheet.value = 'bloc';
  if (id === null && sheet.value === 'bloc') sheet.value = null;
}

// ---------- 命令 ----------

export const blocCommand = (id: number, patch: BlocPatch): Command => ({ op: 'set_bloc', id, patch });
export const removeBlocCommand = (id: number): Command => ({ op: 'set_bloc', id, patch: null });
// 新建：这一国是盟主，只有它一个成员
export const newBlocCommand = (kind: BlocKind, leader: number): Command => ({ op: 'set_bloc', patch: { kind, leader, members: [leader] } });
export const joinBlocCommand = (b: Bloc, id: number): Command => blocCommand(b.id, { members: withId(b.members, id) });
// 退出：最后一个成员退出时集团删掉
export const leaveBlocCommand = (b: Bloc, id: number): Command => (b.members.length <= 1 && b.members.includes(id) ? removeBlocCommand(b.id) : blocCommand(b.id, { members: withoutId(b.members, id) }));

// 从属的种类：附庸是默认（写 null）；没有宗主时改不了
export function subjectCommand(m: CountryMeta, kind: SubjectKind): Command | null {
  if (m.overlord === undefined || kind === (m.subject ?? 'vassal')) return null;
  return patchCommand(m.id, { subject: kind === 'vassal' ? null : kind });
}

// 名字：'' 恢复自动；原文跟着名字（同国家的 namePatch）
export function blocNamePatch(b: Bloc, name: string, orig: string): BlocPatch | null {
  const n = name.trim();
  const o = orig.trim();
  if (!n) return b.nameLocked ? { name: '' } : null;
  if (n === b.name && o === (b.orig ?? '')) return null;
  return { name: n, ...(o ? { orig: o } : {}) };
}

// ---------- 国家档案里 ----------

// 能加入的集团（还不在里面的），按种类、名字
export const joinableBlocs = (w: Pick<World, 'small'>, id: number): Bloc[] =>
  blocList(w.small)
    .filter((b) => !b.members.includes(id))
    .sort((a, b) => BLOC_KINDS.indexOf(a.kind) - BLOC_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, 'zh'));

// 加入一个帝国或联邦时会退出原来的那一个（同一类只能在一个里）
export function joinNote(w: Pick<World, 'small'>, b: Bloc, id: number): string | undefined {
  const cur = blocsOf(w, id).find((x) => (x.kind === 'alliance') === (b.kind === 'alliance'));
  return cur ? `退出“${cur.name}”` : undefined;
}

// 一个集团的成员（盟主在前）
export const blocMembers = (w: Pick<World, 'small'>, b: Bloc): CountryMeta[] => b.members.flatMap((id) => (w.small.countries?.[id] ? [w.small.countries[id]] : []));

// 一个集团的陆地格（定位用）
export const blocCellsOf = (w: World, b: Bloc): number[] => b.members.flatMap((id) => cellsOf(w, id));

// ---------- 同盟模式 ----------

// 一国在同盟模式里算哪个集团（与 blocMapColors 的颜色同一个：同盟优先，再是帝国、联邦）
export function shownBloc(w: Pick<World, 'small'>, id: number): Bloc | undefined {
  const mine = blocsOf(w, id);
  for (const k of BLOC_REGION_KINDS) {
    const b = mine.find((x) => x.kind === k);
    if (b) return b;
  }
  return undefined;
}

// 一格所在的集团（同上）
export function blocAt(w: World, cell: number): Bloc | undefined {
  const id = countryAt(w, cell);
  return id !== null ? shownBloc(w, id) : undefined;
}

// 鼠标旁的一句：集团 · 国家；不在集团里的只写国名
export function blocHereText(w: World, cell: number): string | null {
  const id = countryAt(w, cell);
  if (id === null) return w.causes.land[cell] && w.derived.lake[cell] !== 1 ? '无主地' : null;
  const m = countryOf(w, id);
  const b = shownBloc(w, id);
  return b ? `${b.name} · ${m?.name ?? ''}` : (m?.name ?? null);
}
