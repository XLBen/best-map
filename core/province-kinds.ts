// 省份的种类与小工具（第八十三轮从 core/provinces.ts 原样搬出）：种类、目标大小、格的分类、湖、起名、统计
import type { World, Derived, ProvinceMeta } from './world';
import type { ProvinceRules } from './province-rules';
import { lakeSeaIsles } from './island-types';
import { type GenName, styleFor, hasType, styleName } from './name-styles';
import { hashString } from './names';

export const PROVINCE_KINDS = ['land', 'wasteland', 'lake', 'sea'] as const;
export type ProvinceKind = (typeof PROVINCE_KINDS)[number];
// 类型只影响导出（游戏里怎么算）、省份着色和自动起名，不改地形和生态。
// 湖省只由自动划分与“湖单独成省”的整理产生，不能把陆地改成湖省（set_province 只收陆地、无人区）
export const PROVINCE_KIND_INFO: Record<ProvinceKind, { name: string; hint: string }> = {
  land: { name: '陆地', hint: '陆地省份' },
  wasteland: { name: '无人区', hint: '没人住的荒地，导出时不可进入' },
  lake: { name: '湖省', hint: '湖面单独成省，导出时算作湖' },
  sea: { name: '海省', hint: '海上的省份' },
};

// 目标大小（格数）：一块地区按 4 万格标定，格数不同时等比缩放，所以省份的个数与网格精细度无关。
// 整个星球按面积定（第十七轮）：“中”约 20.4 万 km²（以前 10 万格的类地星球上的 40 格，那时的世界照旧一模一样），
// 不管每格多大、星球多大，省的面积都一样（每格约 100 km 的类地星球上约 33 格，陆地省约九百个）
// （world.ts 引用本文件，这里不从 world.ts 取值，免得循环引用：地球半径与 planetRadiusKm 的默认值相同）
const EARTH_KM = 6371;
const PLANET_CELL_KM2 = (4 * Math.PI * EARTH_KM * EARTH_KM) / 100000;
export function provinceTargets(world: World, rules: ProvinceRules): { land: number; sea: number } {
  const { mesh } = world;
  const scale = mesh.kind === 'sphere' ? PLANET_CELL_KM2 / ((4 * Math.PI * (world.settings.radiusKm ?? EARTH_KM) ** 2) / mesh.n) : mesh.n / 40000;
  const base = rules.size * scale;
  return { land: Math.max(3, base), sea: Math.max(6, base * (rules.seaByDistance ? 2 : 4)) };
}

// 格的类别：0 海，1 陆地，2 无人区，3 湖。省份只在同类格里生长
export const SEA = 0;
export const LAND = 1;
export const WASTE = 2;
export const LAKE = 3;
export const KIND_OF_CLASS: ProvinceKind[] = ['sea', 'land', 'wasteland', 'lake'];

// 省份类型的大类：海、陆地（陆地与无人区）、湖。不同大类的格不能在同一个省
export type ProvinceClass = 'sea' | 'land' | 'lake';
export const classOfKind = (k: ProvinceKind): ProvinceClass => (k === 'sea' ? 'sea' : k === 'lake' ? 'lake' : 'land');

// 国家（第二十三轮）：一个陆地省（陆地、无人区、湖省）只属于一个国家。每格的“国家键”：按格分是陆地的格是它的国家（−1 无主），
// 按格分是海的格（海、归海省的岛）都是 −2（海省不跟着国界）。没有国家的世界为 null（什么都不变）
export function countryKeys(world: World, pland: Uint8Array): Int32Array | null {
  const c = world.causes.country;
  if (!c || !world.small.countries) return null;
  const out = new Int32Array(c.length);
  for (let i = 0; i < c.length; i++) out[i] = pland[i] ? c[i] : -2;
  return out;
}

// 湖面的格（自动划分、整理湖省用）：连成一片、至少 3 格的湖面（与 cellClasses 同一个规则）。
// 湖里的归海省的岛（第十五轮，小礁一类放在湖面上）跟着湖走：连成一片的这种岛格挨着这样的湖面时也算（算进那个湖的湖省）
export function lakeCells(world: World, d: Derived): Uint8Array {
  const mask = new Uint8Array(world.mesh.n);
  const land = world.causes.land;
  for (const comp of components(world, (i) => land[i] === 1 && d.lake[i] === 1)) if (comp.length >= 3) for (const c of comp) mask[c] = 1;
  const isles = lakeSeaIsles(world);
  if (!isles) return mask;
  const { mesh } = world;
  const byLake = (c: number) => {
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (mask[mesh.adj[e]]) return true;
    return false;
  };
  // 岛格的连通块互不相挨（连通块是最大的），先加进去的块不影响后面的块挨不挨湖面
  for (const comp of components(world, (i) => isles[i] === 1 && d.lake[i] !== 1)) if (comp.some(byLake)) for (const c of comp) mask[c] = 1;
  return mask;
}

export function components(world: World, mask: (i: number) => boolean): number[][] {
  const { mesh } = world;
  const seen = new Uint8Array(mesh.n);
  const out: number[][] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (seen[i] || !mask(i)) continue;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      for (let e = mesh.off[q[h]]; e < mesh.off[q[h] + 1]; e++) {
        const j = mesh.adj[e];
        if (!seen[j] && mask(j)) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    out.push(q);
  }
  return out;
}

// 省份名来自文字包：按省内的地形取字（沿海、沿河、山地、干旱、寒冷；海域、无人区、湖另有模板）
function provinceTags(world: World, cells: number[], kind: ProvinceKind): string[] {
  if (kind === 'sea') return ['sea'];
  const { mesh, causes, derived: d, small } = world;
  const thr = small.planet.riverThreshold;
  let coastal = false;
  let river = false;
  let h = 0;
  let m = 0;
  let t = 0;
  for (const c of cells) {
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !coastal; e++) if (!causes.land[mesh.adj[e]]) coastal = true;
    if (d.discharge[c] >= thr * 3) river = true;
    h += Math.max(0, d.elevation[c]);
    m += Math.min(4, d.moisture[c]);
    t += d.tMean[c];
  }
  const k = Math.max(1, cells.length);
  const tags: string[] = kind === 'wasteland' ? ['waste'] : [];
  if (coastal && kind === 'land') tags.push('coastal');
  if (river && kind === 'land') tags.push('river');
  if (h / k > 1500) tags.push('mountain');
  if (m / k < 0.35) tags.push('dry');
  if (t / k < 0) tags.push('cold');
  return tags;
}

// 按这个省的地名风格起名（第二十轮：风格见 name-styles.ts 的 styleFor；不是世界默认的风格时种子加上风格 id）
export function provinceName(world: World, id: number, cells: number[], kind: ProvinceKind, taken: Set<string>): GenName {
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const rs = styleFor(world, { province: id, cells });
  const tags = provinceTags(world, cells, kind);
  // 湖省用湖的命名模板
  const type = kind === 'lake' && hasType(rs.style, 'lake') ? 'lake' : 'province';
  return styleName(rs.style, type, tags, hashString(`${seed}:province:${id}${rs.suffix}`), taken);
}

// 名字与原文写进省份（没有原文时去掉）
export function setProvinceName(meta: ProvinceMeta, n: GenName) {
  meta.name = n.zh;
  if (n.orig) meta.orig = n.orig;
  else delete meta.orig;
}

// 按现在的地名风格给一个省重新起名（换了风格时；要最新的推导）
export function renameProvince(world: World, id: number) {
  const meta = world.small.provinces[id];
  if (!meta) return;
  const cells: number[] = [];
  for (let i = 0; i < world.causes.province.length; i++) if (world.causes.province[i] === id) cells.push(i);
  const taken = takenNames(world);
  taken.delete(meta.name);
  setProvinceName(meta, provinceName(world, id, cells, meta.kind, taken));
}

function cellsByProvince(world: World): Map<number, number[]> {
  const m = new Map<number, number[]>();
  const p = world.causes.province;
  for (let i = 0; i < p.length; i++) {
    if (p[i] < 0) continue;
    const l = m.get(p[i]) ?? [];
    l.push(i);
    m.set(p[i], l);
  }
  return m;
}

// 已用的省份名
export function takenNames(world: World): Set<string> {
  return new Set(Object.values(world.small.provinces).map((p) => p.name).filter(Boolean));
}

export function nameProvinces(world: World, ids: number[]) {
  const byId = cellsByProvince(world);
  const taken = takenNames(world);
  for (const id of ids) {
    const meta = world.small.provinces[id];
    if (!meta || meta.name) continue;
    setProvinceName(meta, provinceName(world, id, byId.get(id) ?? [], meta.kind, taken));
  }
}

export function nameNewProvince(world: World, id: number) {
  const meta = world.small.provinces[id];
  if (!meta || meta.name) return;
  const cells: number[] = [];
  for (let i = 0; i < world.causes.province.length; i++) if (world.causes.province[i] === id) cells.push(i);
  setProvinceName(meta, provinceName(world, id, cells, meta.kind, takenNames(world)));
}

export interface ProvinceSummary {
  id: number;
  name: string;
  land: boolean;
  kind: ProvinceKind;
  locked: boolean;
  cells: number;
  // 主导类型（按格数）与 Paradox 地形
  species: string | null;
  terrain: string;
  meanElevation: number;
}

// 省份地形：格内各格导出地形（cellTerrain：每格的 paradoxTerrain，见 human/terrain-class.ts，海 'ocean'、湖 'lake'）的多数
// （一样多时字母在前的）；无人区、湖、海各有类别。主导类型按格数
export function summarizeProvinces(world: World, d: Derived, cellTerrain: readonly string[]): Map<number, ProvinceSummary> {
  const { mesh, causes, small } = world;
  const out = new Map<number, ProvinceSummary>();
  const counts = new Map<number, Map<number, number>>();
  const terrains = new Map<number, Map<string, number>>();
  const elev = new Map<number, number>();
  for (let i = 0; i < mesh.n; i++) {
    const p = causes.province[i];
    if (p < 0) continue;
    let m = counts.get(p);
    if (!m) counts.set(p, (m = new Map()));
    m.set(d.dominant[i], (m.get(d.dominant[i]) ?? 0) + 1);
    const t = cellTerrain[i];
    if (t !== 'ocean' && t !== 'lake') {
      let tm = terrains.get(p);
      if (!tm) terrains.set(p, (tm = new Map()));
      tm.set(t, (tm.get(t) ?? 0) + 1);
    }
    elev.set(p, (elev.get(p) ?? 0) + Math.max(0, d.elevation[i]));
  }
  for (const [p, m] of counts) {
    const meta = small.provinces[p] ?? { name: '', locked: false, land: false, kind: 'sea' as const };
    let total = 0;
    let best = -1;
    let bc = -1;
    for (const [s, c] of m) {
      total += c;
      if (s >= 0 && c > bc) {
        bc = c;
        best = s;
      }
    }
    const meanE = (elev.get(p) ?? 0) / total;
    const sp = best >= 0 ? small.species[best] : null;
    let top = '';
    let tc = 0;
    for (const [t, c] of terrains.get(p) ?? []) {
      if (c > tc || (c === tc && t < top)) {
        tc = c;
        top = t;
      }
    }
    let terrain = meta.land ? top || (sp?.terrain ?? 'plains') : 'ocean';
    if (meta.kind === 'lake') terrain = 'lake';
    else if (meta.kind === 'wasteland') terrain = 'wasteland';
    out.set(p, { id: p, name: meta.name, land: meta.land, kind: meta.kind, locked: meta.locked, cells: total, species: sp?.id ?? null, terrain, meanElevation: meanE });
  }
  return out;
}
