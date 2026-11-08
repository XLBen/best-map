// 城市的档案（第八十三轮从 core/human/settlements.ts 原样搬出）
import { type CityInfo, seedOf, type CityTable, cityTable } from './city-table';
import type { World } from '../world';
import { worldEra } from './era';
import { mulberry32, mixSeed } from '../rng';
import { hashString } from '../names';
import { terrainLabel } from './terrain-class';

// ---------- 档案 ----------

export interface CityArchive extends CityInfo {
  rankName: string;
  countryName?: string;
  // 管着的格里的人口构成（文化，按人数从多到少）
  cultures: { id: string; name: string; color: string; share: number }[];
  founded: number;
  foundedAuto: boolean;
  description: string;
  descriptionAuto: boolean;
  notes?: string;
  elevation: number;
  terrainClass?: string;
  coastal: boolean;
  river: boolean;
  province: number;
  provinceName?: string;
  // 连着的道路
  roads: number;
}

// 建城年份：首都是建国那年，别的在建国年份与时代的“现在”之间（按编号定）；无主的城市按时代的年份范围
function autoFounded(world: World, c: CityInfo): number {
  const era = worldEra(world.small);
  const [lo, hi] = era?.years ?? [500, 1000];
  const m = c.country !== null ? world.small.countries?.[c.country] : undefined;
  const start = m?.founded ?? Math.min(lo, hi);
  if (c.capital && m) return m.founded;
  const rand = mulberry32(mixSeed(seedOf(world), hashString('city:year'), c.id));
  const end = Math.max(lo, hi);
  return Math.round(start - 200 * rand() + Math.pow(rand(), 1.4) * Math.max(0, end - start));
}

export function popText(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return `${Math.round(n)}`;
}

// 简介（自动的）：“X 是 Y 的首都，位于 Z 河畔，人口约 N。”
function autoDescription(c: CityInfo, a: Pick<CityArchive, 'coastal' | 'river' | 'rankName' | 'countryName'>): string {
  const where = a.coastal && a.river ? '位于河口' : a.coastal ? '位于海边' : a.river ? '位于河畔' : '';
  // 第八十四轮：港口另写一句
  const port = c.port ? '是一座港口' : '';
  const role = c.capital ? `${a.countryName ?? ''}的首都` : c.secondCapital ? `${a.countryName ?? ''}的陪都` : a.countryName ? `${a.countryName}的${a.rankName}` : `一座${a.rankName}`;
  const parts = [`${c.name}是${role}`];
  if (where) parts.push(where);
  if (port) parts.push(port);
  if (c.population > 0) parts.push(`人口约 ${popText(c.population)}`);
  return `${parts.join('，')}。`;
}

// 每座城市管着的格里各文化的人数（一遍算完，按城市表缓存；“其他”不算）
const culturesMemo = new WeakMap<CityTable, Map<string, number>[]>();
function tableCultures(world: World, t: CityTable): Map<string, number>[] {
  let out = culturesMemo.get(t);
  if (out) return out;
  const { causes, small, mesh } = world;
  out = t.list.map(() => new Map<string, number>());
  if (causes.popTotal && causes.popGroup && causes.popShare) {
    for (let i = 0; i < mesh.n; i++) {
      const k = t.owner[i];
      if (k < 0) continue;
      const p = causes.popTotal[i];
      const m = out[k];
      for (let s = 0; s < 4; s++) {
        const g = causes.popGroup[i * 4 + s];
        if (!g) break;
        const tu = small.popGroups?.[g];
        if (tu) m.set(tu.culture, (m.get(tu.culture) ?? 0) + (p * causes.popShare[i * 4 + s]) / 255);
      }
    }
  }
  culturesMemo.set(t, out);
  return out;
}

// t：城市表（一次写很多座城市的档案时先算好传进来）
const indexMemo = new WeakMap<CityTable, Map<number, number>>();
export function cityArchive(world: World, id: number, t: CityTable = cityTable(world)): CityArchive | undefined {
  let idx = indexMemo.get(t);
  if (!idx) indexMemo.set(t, (idx = new Map(t.list.map((c, q) => [c, q] as const).filter(([c]) => !c.point).map(([c, q]) => [c.id, q]))));
  const k = idx.get(id) ?? -1;
  if (k < 0) return undefined;
  const c = t.list[k];
  const { small, causes, derived: d, mesh } = world;
  const meta = small.cities![id];
  // 管着的格里的文化
  const cult = tableCultures(world, t)[k];
  let all = 0;
  for (const v of cult.values()) all += v;
  const cultures = [...cult]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 6)
    .map(([cid, people]) => {
      const cu = (small.content?.culture as Record<string, { name: string; color: string }> | undefined)?.[cid];
      return { id: cid, name: cu?.name ?? cid, color: cu?.color ?? '#999999', share: all > 0 ? people / all : 0 };
    });
  let coastal = false;
  for (let e = mesh.off[c.cell]; e < mesh.off[c.cell + 1]; e++) if (!causes.land[mesh.adj[e]]) coastal = true;
  const river = d.discharge[c.cell] >= small.planet.riverThreshold && d.lake[c.cell] !== 1;
  const m = c.country !== null ? small.countries?.[c.country] : undefined;
  const pid = causes.province[c.cell];
  const base = {
    rankName: c.rank.name,
    ...(m ? { countryName: m.name } : {}),
    coastal,
    river,
  };
  let roads = 0;
  for (const r of Object.values(small.roads ?? {})) if (r.from === id || r.to === id || r.cells[0] === c.cell || r.cells[r.cells.length - 1] === c.cell) roads++;
  return {
    ...c,
    ...base,
    cultures,
    founded: meta.founded ?? autoFounded(world, c),
    foundedAuto: meta.founded === undefined,
    description: meta.description ?? autoDescription(c, base),
    descriptionAuto: meta.description === undefined,
    ...(meta.notes ? { notes: meta.notes } : {}),
    elevation: Math.round(d.elevation[c.cell]),
    ...(terrainLabel(world, c.cell) ? { terrainClass: terrainLabel(world, c.cell)! } : {}),
    province: pid,
    ...(pid >= 0 && small.provinces[pid] ? { provinceName: small.provinces[pid].name } : {}),
    roads,
  };
}

// 每个国家的城市数与首都（首都、陪都的城市编号；首都在前）
export function countryCities(world: World): Map<number, { cities: number; capitals: number[] }> {
  const out = new Map<number, { cities: number; capitals: number[] }>();
  if (!world.small.cities && !world.small.points) return out;
  for (const c of cityTable(world).list) {
    if (c.country === null) continue;
    let e = out.get(c.country);
    if (!e) out.set(c.country, (e = { cities: 0, capitals: [] }));
    e.cities++;
    if (c.capital) e.capitals.unshift(c.id);
    else if (c.secondCapital) e.capitals.push(c.id);
  }
  return out;
}
