import { Delaunay } from 'd3-delaunay';
import type { Mesh, PlaneMesh, SphereMesh } from './mesh';
import { type SphereView, adoptView, locateOn, viewOf } from './sphere';
import { type Settings, meshKey } from './world';

// 网格的打包与拆包：在别的 Worker 里建好网格（整个星球还有显示用的三角网、Voronoi 多边形），只把数组转交过来，
// 拆包得到与就地 buildMeshFor 逐值相同的网格（同样的数组内容，Delaunay 的内部数组也原样）。
// 主线程新建、打开大世界时不再自己建网格（星球上约 1 秒的停顿）

type Arr = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array;

// Delaunay 里查找（find）、邻居（neighbors）、Voronoi 用到的全部内部数组
interface DelaunayParts {
  points: Float64Array;
  halfedges: Int32Array;
  hull: Uint32Array;
  triangles: Uint32Array;
  inedges: Int32Array;
  hullIndex: Int32Array;
  collinear?: Int32Array;
}

export interface PackedMesh {
  scalars: Record<string, number | string>;
  arrays: Record<string, Arr>;
  delaunay?: DelaunayParts;
  view?: {
    x: Float64Array;
    y: Float64Array;
    cellOf: Int32Array;
    triangles: Uint32Array;
    delaunay: DelaunayParts;
    polygons: { off: Int32Array; xy: Float32Array; cell: Int32Array };
  };
}

const PLANE_ARRAYS = ['x', 'y', 'off', 'adj', 'dist', 'edgeLen', 'edgeSeg', 'area', 'boundary', 'inwardX', 'inwardY', 'polyOff', 'poly'] as const;
const SPHERE_ARRAYS = [...PLANE_ARRAYS, 'triangles', 'p', 'edx', 'edy'] as const;

function packDelaunay(d: Delaunay<number>): DelaunayParts {
  const any = d as unknown as { _hullIndex: Int32Array; collinear?: Int32Array };
  return {
    points: d.points as Float64Array,
    halfedges: d.halfedges,
    hull: d.hull as Uint32Array,
    triangles: d.triangles,
    inedges: d.inedges,
    hullIndex: any._hullIndex,
    ...(any.collinear ? { collinear: any.collinear } : {}),
  };
}

function unpackDelaunay(p: DelaunayParts): Delaunay<number> {
  const d = Object.create(Delaunay.prototype) as Record<string, unknown>;
  d._delaunator = { coords: p.points, triangles: p.triangles, halfedges: p.halfedges, hull: p.hull };
  d.points = p.points;
  d.halfedges = p.halfedges;
  d.hull = p.hull;
  d.triangles = p.triangles;
  d.inedges = p.inedges;
  d._hullIndex = p.hullIndex;
  if (p.collinear) d.collinear = p.collinear;
  return d as unknown as Delaunay<number>;
}

function delaunayBuffers(p: DelaunayParts): ArrayBuffer[] {
  return [p.points, p.halfedges, p.hull, p.triangles, p.inedges, p.hullIndex, ...(p.collinear ? [p.collinear] : [])].map((a) => a.buffer as ArrayBuffer);
}

// 打包（数组直接引用网格的：转交之后这边的网格就不能再用了，只在专门建网格的 Worker 里用）。
// 整个星球连同显示用的三角网与多边形一起打包。transfer 是要转交的缓冲区（去重）
export function packMesh(mesh: Mesh): { packed: PackedMesh; transfer: ArrayBuffer[] } {
  const scalars: PackedMesh['scalars'] = { kind: mesh.kind, n: mesh.n, width: mesh.width, height: mesh.height, spacing: mesh.spacing, totalArea: mesh.totalArea };
  const arrays: PackedMesh['arrays'] = {};
  const names = mesh.kind === 'sphere' ? SPHERE_ARRAYS : PLANE_ARRAYS;
  for (const k of names) arrays[k] = (mesh as unknown as Record<string, Arr>)[k];
  const packed: PackedMesh = { scalars, arrays };
  if (mesh.kind === 'plane') packed.delaunay = packDelaunay(mesh.delaunay);
  else {
    scalars.north = mesh.north;
    scalars.south = mesh.south;
    const v = viewOf(mesh);
    packed.view = { x: v.x, y: v.y, cellOf: v.cellOf, triangles: v.triangles, delaunay: packDelaunay(v.delaunay), polygons: v.polygons() };
  }
  const buffers = new Set<ArrayBuffer>(Object.values(arrays).map((a) => a.buffer as ArrayBuffer));
  if (packed.delaunay) for (const b of delaunayBuffers(packed.delaunay)) buffers.add(b);
  if (packed.view) {
    const v = packed.view;
    for (const a of [v.x, v.y, v.cellOf, v.triangles, v.polygons.off, v.polygons.xy, v.polygons.cell]) buffers.add(a.buffer as ArrayBuffer);
    for (const b of delaunayBuffers(v.delaunay)) buffers.add(b);
  }
  return { packed, transfer: [...buffers] };
}

// 拆包：得到与打包前逐值相同的网格（整个星球的显示用三角网也装好，不必再算）
export function unpackMesh(p: PackedMesh): Mesh {
  const s = p.scalars;
  const a = p.arrays as Record<string, never>;
  // 属性的先后与 buildMesh、buildSphereMesh 里的相同（对象同形）
  const head = {
    n: s.n as number,
    width: s.width as number,
    height: s.height as number,
    x: a.x,
    y: a.y,
    off: a.off,
    adj: a.adj,
    dist: a.dist,
    edgeLen: a.edgeLen,
    edgeSeg: a.edgeSeg,
    area: a.area,
    boundary: a.boundary,
    inwardX: a.inwardX,
    inwardY: a.inwardY,
    polyOff: a.polyOff,
    poly: a.poly,
  };
  if (s.kind === 'plane') {
    const delaunay = unpackDelaunay(p.delaunay!);
    // 平面网格的 triangles 就是 Delaunay 的那一个数组
    const plane: PlaneMesh = { kind: 'plane', ...head, triangles: delaunay.triangles, spacing: s.spacing as number, totalArea: s.totalArea as number, delaunay };
    return plane;
  }
  const mesh: SphereMesh = {
    kind: 'sphere',
    ...head,
    triangles: a.triangles,
    spacing: s.spacing as number,
    totalArea: s.totalArea as number,
    p: a.p,
    edx: a.edx,
    edy: a.edy,
    north: s.north as number,
    south: s.south as number,
    locate: () => 0,
  };
  mesh.locate = (px, py, hint) => locateOn(mesh, px, py, hint);
  const v = p.view!;
  const polys = v.polygons;
  const view: SphereView = { x: v.x, y: v.y, cellOf: v.cellOf, delaunay: unpackDelaunay(v.delaunay), triangles: v.triangles, polygons: () => polys };
  adoptView(mesh, view);
  return mesh;
}

// 存进浏览器的网格的键：程序的版本号 + 网格的键（同一个键建出同一个网格；代码一变版本号就不同）
export function storedMeshKey(build: string, settings: Settings): string {
  return `${build}|${meshKey(settings)}`;
}

// 打包的网格里全部的缓冲区（转交用）
export function packedBuffers(p: PackedMesh): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const walk = (v: unknown) => {
    if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(p);
  return [...out];
}
