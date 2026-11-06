import { batch, signal } from '@preact/signals';
import type { Visual } from '../../core/species';
import type { TerrainPreview } from '../../core/terrain';
import type { SmallState, World } from '../../core/world';
import type { HighlightLayer } from '../render/colors';
import { RegenTrack } from '../regen-track';

// 世界与选中的东西（第七十轮从 state.ts 分出来）：Worker 的快照换上时（worker-host.ts 的 applySnapshot）要一起改的信号。
// 界面照旧从 state.ts 引用

export const world = signal<World | null>(null);
// 新建或打开世界时加一：地图据此看全图（同样大小的世界共用网格，不能只看网格变没变）
export const worldEpoch = signal(0);
export const history = signal<{ summary: string; done: boolean }[]>([]);
export const canUndo = signal(false);
export const canRedo = signal(false);

export const focusSpecies = signal<string | null>(null);

// 拖生态的花纹、发光滑块时：地图在主线程上立即按这份外观画（只影响画法，不改世界，不进历史）。按生态 id 记。
// 用法：拖动时 setSpeciesVisualOverride(id, 外观)；松手提交（update_species），等 exec 返回（不论成没成，结果已换上），
// 覆盖的还是提交的那一份（visualOverrides.value.get(id) === 它，没有又拖到别的值）时再给 null 去掉，这样中间不会闪回旧的样子。
// 新建、打开世界时全部去掉；结果换上时，世界里已经没有这种生态的、存着的外观已经与覆盖的一样的也去掉（见 pruneVisualOverrides），
// 编辑面板忘了去掉时地图也不会一直画着世界里没有的样子
export const visualOverrides = signal<ReadonlyMap<string, Visual>>(new Map());
export function setSpeciesVisualOverride(id: string, visual: Visual | null) {
  const cur = visualOverrides.value;
  if (!visual && !cur.has(id)) return;
  const next = new Map(cur);
  if (visual) next.set(id, visual);
  else next.delete(id);
  visualOverrides.value = next;
}

// 两份外观逐项相同（不看键的先后：存进世界的那份经过校验，键的顺序可能与编辑面板给的不同）
const VISUAL_KEYS = ['pattern', 'color2', 'amount', 'size', 'glow', 'glowColor'] as const;
const visualValue = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
const sameVisual = (a: Visual | undefined, b: Visual) => !!a && VISUAL_KEYS.every((k) => visualValue(a[k]) === visualValue(b[k]));

// 结果换上时去掉用不着的覆盖：那种生态已经没有了（撤销、删掉），或者世界里存着的外观就是覆盖的这一份（松手提交的结果到了）。
// 去掉后画出来的与去掉前一样，不会闪
export function pruneVisualOverrides(species: readonly { id: string; visual?: Visual }[]) {
  const cur = visualOverrides.value;
  if (!cur.size) return;
  const byId = new Map(species.map((sp) => [sp.id, sp]));
  let next: Map<string, Visual> | null = null;
  for (const [id, v] of cur) {
    const sp = byId.get(id);
    if (sp && !sameVisual(sp.visual, v)) continue;
    next ??= new Map(cur);
    next.delete(id);
  }
  if (next) visualOverrides.value = next;
}

// 右边的抽屉：生态类型编辑要一边看地图一边调，所以不随点地图关上；国家的档案（第二十三轮）、城市、地标、自定义点的档案（第二十四轮）同样
// 第二十六轮：集团（帝国、联邦、同盟）的档案
export const sheet = signal<'species' | 'country' | 'settle' | 'bloc' | null>(null);
// “调整”面板拖滑块时的预览（会变成陆地 / 海的格、山会变高变矮的格、每格将来的海岸值：地图上画出将来的海岸线）
export const adjustPreview = signal<TerrainPreview | null>(null);
// “调整”面板拖气候、河流的滑块，生态编辑器拖色块时：停下后算出的将来的世界，地图直接画它。
// key：预览的是哪条命令（JSON）；base：按哪个世界算的（世界换了就不再显示）；
// layers：同时要高亮的格（资源包“用到这个世界”：会变的格描边、新生态的格淡淡涂上）
export const adjustPreviewWorld = signal<{ key: string; base: World; world: World; layers?: HighlightLayer[] } | null>(null);
// 正在拖的那一行下面的小字：正在算预览 / 地图上是松手后的样子 / 松手后约 N 秒出结果
export const adjustPreviewNote = signal<{ key: string; text: string } | null>(null);
// 当前世界的状态编号（Worker 每改一次换一个）：预览只在按这个状态算出来时才显示，过期的丢掉
export const worldState = signal(0);
export const regenTrack = new RegenTrack();
// 量距离：已经点的点（地图单位）；null 表示没在量
export const measure = signal<[number, number][] | null>(null);
// “这里”卡片（第二十一轮）：展开着没有；钉住的格（右键点地图上的一格，卡片停在那一格，-1 没钉）
export const hereOpen = signal(false);
export const pinnedCell = signal(-1);
// 钉住的是那一格画成陆地还是水面的部分（第三十七轮：地图上描出这一部分的边，见 renderer.setFocus）；null 不描
export const pinnedPart = signal<'land' | 'water' | null>(null);
export function pinCell(cell: number, part: 'land' | 'water' | null = null) {
  batch(() => {
    pinnedCell.value = cell;
    pinnedPart.value = cell >= 0 ? part : null;
    if (cell >= 0) hereOpen.value = true;
  });
}
// 省份：选中的省份
export const selectedProvince = signal<number | null>(null);
// 国家（第二十三轮）：选中的国家（编号），档案的抽屉、首都、合并跟着它
export const selectedCountry = signal<number | null>(null);
// 集团（第二十六轮）：选中的帝国、联邦、同盟（编号），集团档案跟着它
export const selectedBloc = signal<number | null>(null);
// 城市、道路、地标、自定义点（第二十四轮）：选中的一样（编号四种共用；当作城市、没挂在城市上的点是 point）
export type SettleRef = { kind: 'city' | 'road' | 'landmark' | 'point'; id: number };
export const selectedSettle = signal<SettleRef | null>(null);
export function settleExists(small: Pick<SmallState, 'cities' | 'roads' | 'landmarks' | 'points'>, r: SettleRef): boolean {
  const table = r.kind === 'city' ? small.cities : r.kind === 'road' ? small.roads : r.kind === 'landmark' ? small.landmarks : small.points;
  return !!table?.[r.id];
}
// 河：一条画的河（河道 id），或一条自然的河（河上的一格）
export type RiverRef = { kind: 'guide'; id: string } | { kind: 'natural'; cell: number };
// 画河时点中的河（底部条换成这条河的设置）；河流列表里鼠标停着的那条（地图上亮一下，什么工具都一样）
export const selectedRiver = signal<RiverRef | null>(null);
export const hoverRiver = signal<RiverRef | null>(null);
// 湖（第九轮）：一个放的湖（id），或一个自然的湖（湖里的一格）。放湖时点中的湖（底部条换成这个湖的设置）
export type LakeRef = { kind: 'placed'; id: string } | { kind: 'natural'; cell: number };
export const selectedLake = signal<LakeRef | null>(null);
