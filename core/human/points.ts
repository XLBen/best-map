import { CommandError } from '../errors';
import type { PointMeta, World } from '../world';
import { cityAt, nextSettlementId } from './settlements';
import { pointTypeById } from './settle-content';

// 自定义点（第二十四轮）：自己定的类型（图标、颜色）、名字、备注，放在一格上（可以带精确的位置 x、y）。
// 类型“当作城市”（陪都……）时挂在一座城市上：放在有城市的格上时自动挂上；那座城市在档案里也算首都（见 settlements.ts 的 cityTable）

export function pointOf(world: World, id: number): PointMeta {
  const p = world.small.points?.[id];
  if (!p) throw new CommandError(`找不到点 ${id}`);
  return p;
}

export interface PointInput {
  type: string;
  cell: number;
  x?: number;
  y?: number;
  name?: string;
  note?: string;
  // 挂在哪座城市上（省略时：类型当作城市、这一格有城市时挂上它）
  attachedCity?: number | null;
}

function attach(world: World, p: PointMeta, want: number | null | undefined) {
  if (want === null) {
    delete p.attachedCity;
    return;
  }
  if (want !== undefined) {
    if (!world.small.cities?.[want]) throw new CommandError(`找不到城市 ${want}`);
    p.attachedCity = want;
    return;
  }
  const t = pointTypeById(world.small, p.type);
  const c = t?.actsAsCity ? cityAt(world, p.cell) : undefined;
  if (c) p.attachedCity = c.id;
  else delete p.attachedCity;
}

export function addPoint(world: World, input: PointInput): number {
  const t = pointTypeById(world.small, input.type);
  if (!t) throw new CommandError(`没有点的类型“${input.type}”`);
  const id = nextSettlementId(world);
  const p: PointMeta = { id, type: input.type, cell: input.cell, name: input.name?.trim() || t.name };
  if (input.x !== undefined && input.y !== undefined) {
    p.x = input.x;
    p.y = input.y;
  }
  if (input.note?.trim()) p.note = input.note;
  attach(world, p, input.attachedCity);
  (world.small.points ??= {})[id] = p;
  return id;
}

export function movePoint(world: World, id: number, cell: number, x?: number, y?: number) {
  const p = pointOf(world, id);
  p.cell = cell;
  if (x !== undefined && y !== undefined) {
    p.x = x;
    p.y = y;
  } else {
    delete p.x;
    delete p.y;
  }
  // 挂着的城市不在这一格了：按新的格重新挂（当作城市的类型）
  const host = p.attachedCity !== undefined ? world.small.cities?.[p.attachedCity] : undefined;
  if (!host || host.cell !== cell) attach(world, p, undefined);
}

export interface PointPatch {
  type?: string;
  name?: string;
  note?: string | null;
  attachedCity?: number | null;
}

export function setPoint(world: World, id: number, patch: PointPatch): string[] {
  const p = pointOf(world, id);
  const what: string[] = [];
  if (patch.type !== undefined) {
    if (!pointTypeById(world.small, patch.type)) throw new CommandError(`没有点的类型“${patch.type}”`);
    p.type = patch.type;
    what.push('类型');
  }
  if (patch.name !== undefined) {
    p.name = patch.name.trim() || pointTypeById(world.small, p.type)!.name;
    what.push('改名');
  }
  if (patch.note !== undefined) {
    if (patch.note?.trim()) p.note = patch.note;
    else delete p.note;
    what.push('备注');
  }
  if (patch.attachedCity !== undefined || patch.type !== undefined) {
    attach(world, p, patch.attachedCity);
    if (patch.attachedCity !== undefined) what.push(patch.attachedCity === null ? '不再挂在城市上' : '挂在城市上');
  }
  return what;
}

export function removePoint(world: World, id: number) {
  pointOf(world, id);
  delete world.small.points![id];
}

export interface PointInfo {
  id: number;
  type: string;
  typeName: string;
  icon?: string;
  image?: string;
  color: string;
  cell: number;
  x: number;
  y: number;
  name: string;
  note?: string;
  attachedCity?: number;
  // 类型当作城市（陪都……）
  actsAsCity: boolean;
  capital: boolean;
}

export function pointList(world: World): PointInfo[] {
  const { mesh, small } = world;
  return Object.values(small.points ?? {})
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const t = pointTypeById(small, p.type);
      return {
        id: p.id,
        type: p.type,
        typeName: t?.name ?? p.type,
        ...(t?.icon ? { icon: t.icon } : {}),
        ...(t?.image ? { image: t.image } : {}),
        color: t?.color ?? '#d94a3d',
        cell: p.cell,
        x: p.x ?? mesh.x[p.cell],
        y: p.y ?? mesh.y[p.cell],
        name: p.name,
        ...(p.note ? { note: p.note } : {}),
        ...(p.attachedCity !== undefined ? { attachedCity: p.attachedCity } : {}),
        actsAsCity: !!t?.actsAsCity,
        capital: !!t?.actsAsCity?.capital,
      };
    });
}
