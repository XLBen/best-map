import { EDITING, MINE_EDIT_NOTE, PICKING_TO, SOURCE_GROUPS, VIEW_ONLY, WORLD_NAME } from './copy';
import { type PageCtx, type SourceMenu, type SourceMenuItem, type SourceRef, entryOf, sourceKind } from './page-source';

// 分得清（第九十二轮）：面板顶上一直在的一句“现在改的是哪一份”，和来源下拉怎么列。
// 平时只改这张地图：下拉里默认只有“这张地图”和“从别的库添加…”，别的（直接改我的库、看内置的库、读文件）收在“更多”下面；
// 要不要都摊开只问一个函数（lib-prefs.ts 的 showAllSources，第九十九轮接全局的“完整界面”开关）。不碰界面，测试直接调

// ---------- 改的是哪一份 ----------

// world：这张地图（强调色）；mine：我的库（警告色：改这里地图不变）；readonly：只能看（灰）
export type EditingTone = 'world' | 'mine' | 'readonly';
export interface EditingLine {
  tone: EditingTone;
  // “改的是”“只能看”“挑了加到”
  head: string;
  // “这张地图”“我的库“X””“中世纪与近世”
  name: string;
  // 括号里的一句：“新地图会用”
  note?: string;
}

const mineName = (name: string) => `我的库“${name}”`;

// pickTo：正在从这一份里挑（挑选的模式），挑了加到哪一份
export function editingLine(src: SourceRef, ctx: PageCtx, pickTo?: SourceRef | null): EditingLine | null {
  if (pickTo) {
    if (pickTo.t === 'world') return { tone: 'world', head: PICKING_TO, name: WORLD_NAME };
    const to = entryOf(pickTo, ctx);
    return to ? { tone: 'mine', head: PICKING_TO, name: mineName(to.pack.name), note: MINE_EDIT_NOTE } : null;
  }
  const k = sourceKind(src, ctx);
  if (k === 'world') return ctx.world ? { tone: 'world', head: EDITING, name: WORLD_NAME } : null;
  const e = entryOf(src, ctx);
  if (!k || !e) return null;
  if (k === 'mine') return { tone: 'mine', head: EDITING, name: mineName(e.pack.name), note: ctx.world ? `${MINE_EDIT_NOTE}，这张地图不变` : MINE_EDIT_NOTE };
  return { tone: 'readonly', head: VIEW_ONLY, name: k === 'file' ? `文件“${e.pack.name || e.file}”` : e.pack.name };
}

export const editingText = (l: EditingLine): string => `${l.head}：${l.name}${l.note ? `（${l.note}）` : ''}`;

// ---------- 来源下拉 ----------

export interface SourceGroup {
  title: string;
  items: SourceMenuItem[];
}
export interface SourceMenuView {
  // 一直列着的：这张地图（没有世界时没有）
  top: SourceMenuItem[];
  // “从别的库添加…”这一项出不出（不在挑选、有地方加时）
  pickEntry: boolean;
  // 直接列着的几组（挑选时：从哪个库挑；都摊开时：全部）
  groups: SourceGroup[];
  // 收在“更多”下面的几组；null：没有“更多”这一层（都摊开了）
  more: SourceGroup[] | null;
  // “更多”一开始是不是展开着（正在看的那一份就在里面）
  moreOpen: boolean;
}

export function sourceMenuView(m: SourceMenu, o: { all: boolean; picking: boolean; canPick: boolean; hasWorld: boolean }): SourceMenuView {
  const groups: SourceGroup[] = [
    { title: SOURCE_GROUPS.mine, items: m.mine },
    { title: SOURCE_GROUPS.builtin, items: m.builtin },
    { title: SOURCE_GROUPS.imported, items: m.imported },
    { title: SOURCE_GROUPS.files, items: m.files },
  ].filter((g) => g.items.length);
  const top = o.hasWorld ? [m.world] : [];
  // 挑选时下拉选的是“从哪个库挑”：库都列着（内置的在前），不收
  if (o.picking) {
    const order = [SOURCE_GROUPS.builtin, SOURCE_GROUPS.mine, SOURCE_GROUPS.imported, SOURCE_GROUPS.files];
    return { top, pickEntry: false, groups: [...groups].sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title)), more: null, moreOpen: false };
  }
  // 没有世界时只能看库：都列着
  if (o.all || !o.hasWorld) return { top, pickEntry: o.canPick, groups, more: null, moreOpen: false };
  return { top, pickEntry: o.canPick, groups: [], more: groups, moreOpen: groups.some((g) => g.items.some((x) => x.on)) };
}
