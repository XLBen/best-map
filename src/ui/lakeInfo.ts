import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import type { GeoFeature } from '../../core/features';
import { type LakeType, PLAIN_LAKE } from '../../core/lake-types';
import type { LakeSpec, World } from '../../core/world';
import { type LakeRef, options } from '../state';

// 湖（第九轮）：点中的是哪个湖、它是哪一种、给它选类型的命令（底部条见 panels/lakes.tsx，放湖工具见 tools.ts）

// ---------- 一个湖 ----------

// 这一格所在的湖（湖面与干涸的湖底连成的一片）的格；不是湖为空
export function lakeCellsAt(w: World, cell: number): number[] {
  const { mesh, causes, derived: d } = w;
  if (cell < 0 || cell >= mesh.n || !d.lake[cell] || !causes.land[cell]) return [];
  const seen = new Set([cell]);
  const q = [cell];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (!seen.has(j) && d.lake[j] && causes.land[j]) {
        seen.add(j);
        q.push(j);
      }
    }
  }
  return q;
}

// 一串格里放的湖（几个连成一片时取最后放的那个，与起名、类型一致）
function placedIn(w: World, cells: readonly number[]): LakeSpec | undefined {
  const set = new Set(cells);
  for (let k = w.small.lakes.length - 1; k >= 0; k--) if (set.has(w.small.lakes[k].cell)) return w.small.lakes[k];
  return undefined;
}

// 点在湖上：选中的是哪个湖（里面有放的湖时是那个放的湖）
export function lakeRefAt(w: World, cell: number): LakeRef | null {
  const cells = lakeCellsAt(w, cell);
  if (!cells.length) return null;
  const p = placedIn(w, cells);
  return p ? { kind: 'placed', id: p.id } : { kind: 'natural', cell };
}

export interface LakeInfo {
  cells: number[];
  placed: LakeSpec | undefined;
  // 地名（湖面的那一片）；只剩干涸湖底的没有
  feature: GeoFeature | undefined;
  areaKm2: number;
  dry: boolean;
}

export function lakeInfo(w: World, ref: LakeRef): LakeInfo | null {
  const placed = ref.kind === 'placed' ? w.small.lakes.find((l) => l.id === ref.id) : undefined;
  const at = ref.kind === 'placed' ? placed?.cell : ref.cell;
  if (at === undefined) return null;
  const cells = lakeCellsAt(w, at);
  if (!cells.length) return null;
  const d = w.derived;
  const set = new Set(cells);
  const feature = d.features.find((f) => f.type === 'lake' && set.has(f.anchor));
  let area = 0;
  for (const c of cells) area += w.mesh.area[c];
  return { cells, placed, feature, areaKm2: area * w.kmPerUnit * w.kmPerUnit, dry: !cells.some((c) => d.lake[c] === 1) };
}

// ---------- 是哪一种 ----------

export interface LakeTypeOfLake {
  // 现在画出来是哪一种（普通的湖为 null）
  type: LakeType | null;
  // 这个湖自己选的：一种类型、“普通的湖”；没选（按各类型的规则）为 null
  chosen: 'type' | 'plain' | null;
}

// 自然的湖上选的（lakeTyping 里落在这个湖里的，后面的说了算）
function typingIn(w: World, cells: readonly number[]) {
  const set = new Set(cells);
  return (w.small.lakeTyping ?? []).filter((e) => set.has(e.cell));
}

export function lakeTypeOfLake(w: World, ref: LakeRef): LakeTypeOfLake {
  const types = w.small.lakeTypes ?? [];
  const info = lakeInfo(w, ref);
  const own = info?.placed?.type ?? (info ? typingIn(w, info.cells).at(-1)?.type : undefined);
  if (own === PLAIN_LAKE) return { type: null, chosen: 'plain' };
  const t = own !== undefined ? types.find((x) => x.id === own) : undefined;
  if (t) return { type: t, chosen: 'type' };
  const v = info ? (w.derived.lakeType?.[info.cells[0]] ?? 0) : 0;
  return { type: v ? (types[v - 1] ?? null) : null, chosen: null };
}

export const hasLakeRules = (w: World) => (w.small.lakeTypes ?? []).some((t) => !!t.scripts?.match);

// 给一个湖选类型（choice：类型 id、'plain' 普通的湖、null 按规则）的命令；不用改时为 null。
// 放的湖改它自己的 type；自然的湖记在 lakeTyping（这个湖里原来选的先去掉）
export function lakeTypeChoiceCommand(w: World, ref: LakeRef, choice: string | null): Command | null {
  const info = lakeInfo(w, ref);
  if (!info) return null;
  // 没有规则时“普通的湖”就是不选
  const want = choice === PLAIN_LAKE && !hasLakeRules(w) ? null : choice;
  const name = info.feature?.name;
  const who = name ? `「${name}」` : '这个湖';
  const what = choice === PLAIN_LAKE ? '普通的湖' : ((w.small.lakeTypes ?? []).find((t) => t.id === choice)?.name ?? choice);
  const label = choice === null ? `${who}的类型改回按规则` : `${who}改成${what}`;
  if (info.placed) {
    if ((info.placed.type ?? null) === want) return null;
    return { op: 'update_lake', id: info.placed.id, patch: { type: want }, label };
  }
  const old = typingIn(w, info.cells);
  if ((old.at(-1)?.type ?? null) === want && old.length <= 1) return null;
  const cell = ref.kind === 'natural' ? ref.cell : info.cells[0];
  return { op: 'type_lake', cell, type: want, ...(old.length ? { drop: old.map((e) => e.cell) } : {}), label };
}

// 新放的湖带上的类型（工具条上选的；那种类型已经删掉了时不带）
export function chosenLakeType(w: World): { type: string } | Record<string, never> {
  const id = options.value.lakeType;
  if (!id) return {};
  if (id === PLAIN_LAKE) return hasLakeRules(w) ? { type: id } : {};
  return w.small.lakeTypes?.some((t) => t.id === id) ? { type: id } : {};
}

// 拖“大小”时地图上先画出将来的湖面（放湖工具的预览读它）
export const lakeSizeDraft = signal<{ id: string; radius: number } | null>(null);

