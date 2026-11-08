// 编辑城市（第八十三轮从 core/human/settlements.ts 原样搬出）：加、删、挪、改；改地形之后、每步之后的修补
import type { World, CityMeta } from '../world';
import { CommandError } from '../errors';
import { cityAt, nextSettlementId, cityOf, territory } from './city-table';
import { cityRankById } from './settle-content';

// ---------- 编辑 ----------

const isLand = (world: World, cell: number) => world.causes.land[cell] === 1;

export interface CityInput {
  name?: string;
  orig?: string;
  rank?: string;
}

export function addCity(world: World, cell: number, opts: CityInput = {}): number {
  if (!isLand(world, cell)) throw new CommandError('城市要在陆地上');
  if (cityAt(world, cell)) throw new CommandError('这一格已经有城市');
  if (opts.rank && !cityRankById(world.small, opts.rank)) throw new CommandError(`没有城市等级“${opts.rank}”`);
  const id = nextSettlementId(world);
  const c: CityMeta = { id, cell };
  if (opts.name?.trim()) {
    c.name = opts.name.trim();
    if (opts.orig?.trim()) c.orig = opts.orig.trim();
  }
  if (opts.rank) c.rank = opts.rank;
  (world.small.cities ??= {})[id] = c;
  return id;
}

// 删除城市：连着它的自动道路一起删，挂着它的点不再挂着
export function removeCity(world: World, id: number) {
  cityOf(world, id);
  delete world.small.cities![id];
  for (const [k, r] of Object.entries(world.small.roads ?? {})) {
    if (r.auto && (r.from === id || r.to === id)) delete world.small.roads![k];
    else {
      if (r.from === id) delete r.from;
      if (r.to === id) delete r.to;
    }
  }
  for (const p of Object.values(world.small.points ?? {})) if (p.attachedCity === id) delete p.attachedCity;
}

// 挪城市：是首都时首都跟着挪（新的格在同一个国家里；锁定首都）。连着它的道路由 roads.ts 的 rerouteCity 重走
export function moveCityCell(world: World, id: number, cell: number) {
  const c = cityOf(world, id);
  if (!isLand(world, cell)) throw new CommandError('城市要在陆地上');
  const other = cityAt(world, cell);
  if (other && other.id !== id) throw new CommandError('这一格已经有城市');
  const country = c.country ?? territory(world, c.cell);
  const m = country >= 0 ? world.small.countries?.[country] : undefined;
  if (m && m.capitalCell === c.cell && territory(world, cell) === country) {
    m.capitalCell = cell;
    m.capitalLocked = true;
  }
  c.cell = cell;
}

export interface CityPatch {
  name?: string;
  orig?: string;
  reroll?: true;
  rank?: string | null;
  country?: number | null;
  founded?: number | null;
  description?: string | null;
  notes?: string | null;
  locked?: boolean;
}

export function setCity(world: World, id: number, p: CityPatch): string[] {
  const c = cityOf(world, id);
  const what: string[] = [];
  if (p.name !== undefined) {
    const v = p.name.trim();
    if (v) {
      c.name = v;
      const o = p.orig?.trim();
      if (o) c.orig = o;
      else delete c.orig;
      what.push('改名');
    } else {
      delete c.name;
      delete c.orig;
      what.push('名字恢复自动');
    }
  }
  if (p.reroll) {
    delete c.name;
    delete c.orig;
    c.salt = (c.salt ?? 0) + 1;
    what.push('换一个名字');
  }
  if (p.rank !== undefined) {
    if (p.rank === null) delete c.rank;
    else {
      if (!cityRankById(world.small, p.rank)) throw new CommandError(`没有城市等级“${p.rank}”`);
      c.rank = p.rank;
    }
    what.push(p.rank === null ? '等级恢复自动' : '等级');
  }
  if (p.country !== undefined) {
    if (p.country === null) delete c.country;
    else {
      if (!world.small.countries?.[p.country]) throw new CommandError(`找不到国家 ${p.country}`);
      c.country = p.country;
    }
    what.push(p.country === null ? '所属恢复自动' : '所属');
  }
  const text = (key: 'description' | 'notes', v: string | null | undefined, label: string) => {
    if (v === undefined) return;
    if (v === null || !v.trim()) delete c[key];
    else c[key] = v;
    what.push(label);
  };
  text('description', p.description, '简介');
  text('notes', p.notes, '备注');
  if (p.founded !== undefined) {
    if (p.founded === null) delete c.founded;
    else c.founded = p.founded;
    what.push('建城年份');
  }
  if (p.locked !== undefined) {
    if (p.locked) c.locked = true;
    else delete c.locked;
    what.push(p.locked ? '锁定' : '解锁');
  }
  // 自己改过的自动城市在重新生成时也留着
  if (what.length && c.auto && (p.name !== undefined || p.rank !== undefined || p.country !== undefined)) delete c.auto;
  return what;
}

// ---------- 改地形之后、每步之后 ----------

// 离 cell 最近的陆地格（按步数；cell 本身是陆地就是它），occupied 里的跳过。没有时为 −1
export function nearestLand(world: World, cell: number, occupied?: Set<number>): number {
  const { mesh, causes } = world;
  if (causes.land[cell] && !occupied?.has(cell)) return cell;
  const seen = new Uint8Array(mesh.n);
  seen[cell] = 1;
  let q = [cell];
  while (q.length) {
    const next: number[] = [];
    for (const i of q) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (seen[j]) continue;
        seen[j] = 1;
        if (causes.land[j] && !occupied?.has(j)) return j;
        next.push(j);
      }
    }
    q = next.sort((a, b) => a - b);
  }
  return -1;
}

// 改了陆海之后（applyTerrain 里，只看原因）：变成海的格上的城市删掉（锁定的挪到最近的陆地）
export function repairCities(world: World): boolean {
  const cities = world.small.cities;
  if (!cities) return false;
  let changed = false;
  const occupied = new Set(Object.values(cities).map((c) => c.cell));
  for (const c of Object.values(cities).sort((a, b) => a.id - b.id)) {
    if (world.causes.land[c.cell]) continue;
    changed = true;
    occupied.delete(c.cell);
    const to = c.locked ? nearestLand(world, c.cell, occupied) : -1;
    if (to >= 0) {
      c.cell = to;
      occupied.add(to);
    } else removeCity(world, c.id);
  }
  return changed;
}

// 每步之后的整理（有城市时）：每个国家的首都格上都有一座城市（没有时补一座自动的），挂着、连着没了的城市的去掉
export function tidyCities(world: World) {
  const { small, causes } = world;
  if (!small.cities) return;
  const at = new Set(Object.values(small.cities).map((c) => c.cell));
  for (const m of Object.values(small.countries ?? {}).sort((a, b) => a.id - b.id)) {
    const cap = m.capitalCell;
    if (cap === undefined || !causes.land[cap] || at.has(cap)) continue;
    const id = nextSettlementId(world);
    small.cities[id] = { id, cell: cap, auto: true };
    at.add(cap);
  }
  for (const p of Object.values(small.points ?? {})) if (p.attachedCity !== undefined && !small.cities[p.attachedCity]) delete p.attachedCity;
  for (const r of Object.values(small.roads ?? {})) {
    if (r.from !== undefined && !small.cities[r.from]) delete r.from;
    if (r.to !== undefined && !small.cities[r.to]) delete r.to;
  }
}

// 去掉城市（与道路：道路连着城市）
export function clearCities(world: World) {
  delete world.small.cities;
  delete world.small.roads;
  for (const p of Object.values(world.small.points ?? {})) delete p.attachedCity;
}
