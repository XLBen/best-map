import { type GeoFeature, overrideKeyOf } from '../features';
import { hashString } from '../names';
import { type GenName, hasType, styleFor, styleName } from '../name-styles';
import { type CellMeta, type World, longitudeOf, worldLatitude } from '../world';
import { CATEGORY_LABEL, type Resource, type ResourceCategory, resourceAt } from './resources';
import { classAt, type TerrainClass } from './terrain-class';
import { type CellPopulation, cellPopulation } from './layers';
import { cityTable } from './settlements';
import { landmarkName } from './landmarks';
import { landmarkTypeById, pointTypeById } from './settle-content';

// 格的档案（第二十一轮）：悬停卡片展开后看、改的那些——小地名（不上地图，按当地的地名风格起）、地形类别、资源、
// 是山峰时的“xx峰 · 高度”、备注。自己写的存在 small.cells（命令 set_cell），别的都按推导现算

// 一格的小地名：自己起的（small.cells），否则按这一格所在的省份的风格起（山峰按“山峰”的模板，别的按“地点”）。
// 种子是“世界种子:cell:格:盐”（风格不是世界默认时加上风格 id），与格数无关的只有格本身——格的编号在一个世界里是固定的
export function cellName(world: World, cell: number): GenName & { custom: boolean } {
  const meta = world.small.cells?.[cell];
  if (meta?.name) return { zh: meta.name, ...(meta.orig ? { orig: meta.orig } : {}), custom: true };
  const rs = styleFor(world, { cell });
  const peak = world.derived.peak[cell] === 1;
  const type = peak && hasType(rs.style, 'peak') ? 'peak' : hasType(rs.style, 'spot') ? 'spot' : 'province';
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const n = styleName(rs.style, type, peak ? peakTags(world, cell) : cellTags(world, cell), hashString(`${seed}:cell:${cell}:${meta?.salt ?? 0}${rs.suffix}`));
  return { ...n, custom: false };
}

function cellTags(world: World, i: number): string[] {
  const { mesh, causes, derived: d } = world;
  const tags: string[] = [];
  let coast = false;
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) coast = true;
  if (!causes.land[i]) tags.push('sea');
  else if (coast) tags.push('coastal');
  if (causes.land[i] && d.discharge[i] >= world.small.planet.riverThreshold && d.lake[i] !== 1) tags.push('river');
  if (d.elevation[i] >= 1300 || classAt(world.small, d.terrainClass[i])?.ore) tags.push('mountain');
  if (d.tMean[i] < 0) tags.push('cold');
  return tags;
}

function peakTags(world: World, i: number): string[] {
  const tags: string[] = [];
  if (world.derived.tMean[i] < -5) tags.push('cold');
  // 孤零零的高峰（附近的山脉很小）按火山起名：与地物的规则一致，见 features.ts 的 reliefInputs
  const f = rangeOf(world, i);
  if (f?.tags.includes('volcanic')) tags.push('volcanic');
  return tags;
}

// 这一格是哪个山脉的一部分
function rangeOf(world: World, cell: number): GeoFeature | undefined {
  return world.derived.features.find((f) => f.type === 'range' && f.cells.includes(cell));
}

// 这一格是不是某个山峰地物（山脉的主峰）
export function peakFeatureAt(world: World, cell: number): GeoFeature | undefined {
  return world.derived.features.find((f) => f.type === 'peak' && f.anchor === cell);
}

export interface CellArchive {
  cell: number;
  // 陆地、湖面、海
  surface: 'land' | 'lake' | 'sea';
  // 小地名：山脉的主峰是地物的名字（feature 是改名用的键，rename_feature），否则是这一格自己的（custom：自己起的）
  name: string;
  orig?: string;
  custom: boolean;
  feature?: string;
  // 起名用的地名风格
  style: string;
  note?: string;
  elevation: number;
  lat: number;
  lon: number;
  province: number;
  provinceName?: string;
  biome?: { id: string; name: string };
  // 生效的地形类别（auto：没画过；autoId 是自动的那一种）
  terrainClass?: { id: string; name: string; color: string; auto: boolean; autoId?: string };
  // 生效的资源；没有时 resource 为空、none 写“无矿”（地形类别写了“有没有矿”时）或“无”，auto 是没画过
  resource?: { id: string; name: string; color: string; icon?: string; category: ResourceCategory; categoryLabel: string };
  resourceAuto: boolean;
  resourceNone?: string;
  // 是山峰时：名字（同上面的 name）与海拔（m，取整）
  peak?: { name: string; orig?: string; elevation: number; feature?: string };
  // 宜居度（第二十二轮，0–1；水面为 0）
  habitability: number;
  // 人口与成分（第二十二轮）：生成过人文时才有（海上也有，人数为 0）
  population?: CellPopulation;
  // 这一格上的城市、地标、自定义点（第二十四轮）：有时才有
  city?: { id: number; name: string; orig?: string; rank: string; rankName: string; icon: string; capital: boolean; secondCapital: boolean; population: number };
  landmarks?: { id: number; type: string; typeName: string; name: string; orig?: string }[];
  points?: { id: number; type: string; typeName: string; name: string }[];
}

// 一格的档案（界面直接用）
export function cellArchive(world: World, cell: number): CellArchive {
  const { causes, derived: d, small, mesh } = world;
  const land = causes.land[cell] === 1;
  const surface = !land ? 'sea' : d.lake[cell] === 1 ? 'lake' : 'land';
  const meta: CellMeta | undefined = small.cells?.[cell];
  const pf = peakFeatureAt(world, cell);
  const own = cellName(world, cell);
  // 山脉的主峰：名字跟着地物（地图上的那个名字），在档案里改名改的是地物
  const name = pf && !meta?.name ? { zh: pf.name, orig: pf.orig, custom: pf.custom } : own;
  const feature = pf && !meta?.name ? overrideKeyOf(world, pf) : undefined;
  const lat = worldLatitude(world, mesh.y[cell]);
  const lonSpan = (mesh.width * world.kmPerUnit) / 111.2;
  const lon = world.settings.globe ? longitudeOf(mesh.x[cell]) : (mesh.x[cell] / mesh.width - 0.5) * lonSpan;
  const pid = causes.province[cell];
  const sp = d.dominant[cell] >= 0 ? small.species[d.dominant[cell]] : undefined;
  const tc: TerrainClass | undefined = classAt(small, d.terrainClass[cell]);
  const auto = classAt(small, d.terrainClassAuto[cell]);
  const r: Resource | undefined = resourceAt(small, d.resource[cell]);
  const over = causes.resource?.[cell] ?? 0;
  const out: CellArchive = {
    cell,
    surface,
    name: name.zh,
    ...(name.orig ? { orig: name.orig } : {}),
    custom: name.custom,
    ...(feature ? { feature } : {}),
    style: styleFor(world, { cell }).id,
    ...(meta?.note ? { note: meta.note } : {}),
    elevation: Math.round(d.elevation[cell]),
    lat,
    lon,
    province: pid,
    ...(pid >= 0 && small.provinces[pid] ? { provinceName: small.provinces[pid].name } : {}),
    ...(sp ? { biome: { id: sp.id, name: sp.name || sp.id } } : {}),
    resourceAuto: !over,
    habitability: d.habitability[cell] ?? 0,
  };
  const pop = cellPopulation(world, cell);
  if (pop) out.population = pop;
  if (small.cities) {
    const c = cityTable(world).list.find((x) => x.cell === cell && !x.point);
    if (c) out.city = { id: c.id, name: c.name, ...(c.orig ? { orig: c.orig } : {}), rank: c.rank.id, rankName: c.rank.name, icon: c.rank.icon, capital: c.capital, secondCapital: c.secondCapital, population: c.population };
  }
  const ls = Object.values(small.landmarks ?? {}).filter((l) => l.cell === cell).sort((a, b) => a.id - b.id);
  if (ls.length)
    out.landmarks = ls.map((l) => {
      const n = landmarkName(world, l);
      return { id: l.id, type: l.type, typeName: landmarkTypeById(small, l.type)?.name ?? l.type, name: n.zh, ...(n.orig ? { orig: n.orig } : {}) };
    });
  const ps = Object.values(small.points ?? {}).filter((p) => p.cell === cell).sort((a, b) => a.id - b.id);
  if (ps.length) out.points = ps.map((p) => ({ id: p.id, type: p.type, typeName: pointTypeById(small, p.type)?.name ?? p.type, name: p.name }));
  if (surface === 'land') {
    if (tc) out.terrainClass = { id: tc.id, name: tc.name, color: tc.color, auto: !causes.terrainClass?.[cell], ...(auto ? { autoId: auto.id } : {}) };
    if (r) out.resource = { id: r.id, name: r.name, color: r.color, ...(r.icon ? { icon: r.icon } : {}), category: r.category, categoryLabel: CATEGORY_LABEL[r.category] };
    else out.resourceNone = tc?.ore ? '无矿' : '无';
    if (d.peak[cell] || pf) out.peak = { name: name.zh, ...(name.orig ? { orig: name.orig } : {}), elevation: Math.round(d.elevation[cell]), ...(feature ? { feature } : {}) };
  }
  return out;
}

// 画在地图上的全部山峰（界面的“显示山峰”）：格、名字、海拔，按海拔从高到低。limit 是最多几个
export function peakMarks(world: World, limit = Infinity): { cell: number; x: number; y: number; name: string; elevation: number; feature?: string }[] {
  const { derived: d, mesh } = world;
  const out: { cell: number; x: number; y: number; name: string; elevation: number; feature?: string }[] = [];
  const byAnchor = new Map(d.features.filter((f) => f.type === 'peak').map((f) => [f.anchor, f]));
  const cells: number[] = [];
  for (let i = 0; i < d.peak.length; i++) if (d.peak[i] || byAnchor.has(i)) cells.push(i);
  cells.sort((a, b) => d.elevation[b] - d.elevation[a] || a - b);
  for (const c of cells.slice(0, Math.min(cells.length, limit))) {
    const f = byAnchor.get(c);
    const name = f && !world.small.cells?.[c]?.name ? f.name : cellName(world, c).zh;
    out.push({ cell: c, x: mesh.x[c], y: mesh.y[c], name, elevation: Math.round(d.elevation[c]), ...(f ? { feature: f.key } : {}) });
  }
  return out;
}
