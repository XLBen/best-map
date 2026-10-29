import type { Command, RemovedItem } from './commands';
import { itemId, itemName, kindOf, usageOf } from './content/registry';
import { strictWorld } from './content/usage';
import { type ContentRef, TIDY_KINDS, unusedContent } from './content/unused';
import type { Engine } from './engine';
import { dimensionValues, worldCultureGroups, worldCultures, worldDimensions } from './human/era';
import { worldResources } from './human/resources';
import { worldTerrainClasses } from './human/terrain-class';
import { lakeTypesOf } from './lake-types';
import { riverTypesOf } from './river-types';
import type { World } from './world';

// 整理本世界的计划（第二十九轮）：一步移出哪里都没用到的内容（content/unused.ts 判断），但要保证地图不变——
// 在世界的副本上真的移出、重算，与原来逐值比较地图（生态、河湖的种类、地形类别、资源、宜居度、人口、国家、生态对周围的影响、地名），
// 编号不同的按 id 比（移出一种之后后面的编号会往前挪，那不算变）。比较出不同的那一项不移，留着并写明原因。
// 先整批试一遍（一般就过了）；不过时按种类一批批试，再不过的那一种一项项试。结果是一条 tidy_content（items 写明移出哪些），
// 执行、重放都只照着 items 做，同一个世界总是一样。命令本身不碰资源库：移出的项（removed）由界面存进资源库

export interface TidyKept {
  kind: string;
  id: string;
  name: string;
  reason: string;
}

export interface TidyPlan {
  // 没有要移出的时为 null
  command: Extract<Command, { op: 'tidy_content' }> | null;
  // 会移出的项（与执行后引擎的 lastRemoved 一样）
  removed: RemovedItem[];
  // 没用到、但移出后地图会变的，留着
  kept: TidyKept[];
}

// 一层按 id 比：a、b 是编号（k + offset 对应 ids[k]），返回不同的格数
// 只在用到时才有的数组（河、湖的种类，生态对周围的影响……）没有时按全是 0 比
function codedDiff(a0: ArrayLike<number> | undefined, idsA: readonly string[], b0: ArrayLike<number> | undefined, idsB: readonly string[], offset: number): number {
  if (!a0 && !b0) return 0;
  const a = a0 ?? new Uint8Array(b0!.length);
  const b = b0 ?? new Uint8Array(a0!.length);
  if (a.length !== b.length) return Math.max(a.length, b.length) || 1;
  const name = (v: number, ids: readonly string[]) => (v - offset >= 0 && v - offset < ids.length ? ids[v - offset] : `#${v}`);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && name(a[i], idsA) !== name(b[i], idsB)) n++;
  return n;
}

function rawDiff(a0: ArrayLike<number> | undefined, b0: ArrayLike<number> | undefined): number {
  if (!a0 && !b0) return 0;
  const a = a0 ?? new Uint8Array(b0!.length);
  const b = b0 ?? new Uint8Array(a0!.length);
  if (a.length !== b.length) return Math.max(a.length, b.length) || 1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) n++;
  return n;
}

// 两个世界的地图差在哪里：[说明, 不同的格数]（一样时是空的）
export function mapDiff(a: World, b: World): [string, number][] {
  const da = a.derived;
  const db = b.derived;
  const ids = <T>(list: readonly T[], id: (x: T) => string) => list.map(id);
  const out: [string, number][] = [];
  const put = (what: string, n: number) => {
    if (n) out.push([what, n]);
  };
  put('生态', codedDiff(da.dominant, ids(a.small.species, (s) => s.id), db.dominant, ids(b.small.species, (s) => s.id), 0));
  put('河的种类', codedDiff(da.riverType, ids(riverTypesOf(a.small), (t) => t.id), db.riverType, ids(riverTypesOf(b.small), (t) => t.id), 1));
  put('湖的种类', codedDiff(da.lakeType, ids(lakeTypesOf(a.small), (t) => t.id), db.lakeType, ids(lakeTypesOf(b.small), (t) => t.id), 1));
  put('生态对周围的影响', rawDiff(da.effT, db.effT) + rawDiff(da.effP, db.effP));
  put('植被的颜色', rawDiff(da.look, db.look));
  put('地形类别', codedDiff(da.terrainClass, ids(worldTerrainClasses(a.small), (c) => c.id), db.terrainClass, ids(worldTerrainClasses(b.small), (c) => c.id), 1));
  put('资源', codedDiff(da.resource, ids(worldResources(a.small), (r) => r.id), db.resource, ids(worldResources(b.small), (r) => r.id), 1));
  put('宜居度', rawDiff(da.habitability, db.habitability));
  put('人口', rawDiff(da.popDensity, db.popDensity));
  put('文化', codedDiff(da.popCulture, ids(worldCultures(a.small), (c) => c.id), db.popCulture, ids(worldCultures(b.small), (c) => c.id), 1));
  put('文化组', codedDiff(da.popCultureGroup, ids(worldCultureGroups(a.small), (g) => g.id), db.popCultureGroup, ids(worldCultureGroups(b.small), (g) => g.id), 1));
  // 维度的取值：按维度分段（第 k 维是 [k·n, (k+1)·n)），每段按这一维的取值比
  const dimsA = worldDimensions(a.small);
  const dimsB = worldDimensions(b.small);
  if (da.popValue || db.popValue) {
    if (!da.popValue || !db.popValue || dimsA.length !== dimsB.length || dimsA.some((d, k) => d.id !== dimsB[k].id)) put('人口的取值', 1);
    else {
      const n = a.mesh.n;
      let diff = 0;
      dimsA.forEach((d, k) => {
        const seg = (arr: Uint16Array) => arr.subarray(k * n, (k + 1) * n);
        diff += codedDiff(seg(da.popValue!), ids(dimensionValues(a.small, d.id), (v) => v.id), seg(db.popValue!), ids(dimensionValues(b.small, d.id), (v) => v.id), 1);
      });
      put('人口的取值', diff);
    }
  }
  put('国家', rawDiff(da.country, db.country));
  const names = (w: World) => w.derived.features.map((f) => `${f.key}=${f.name}`);
  const na = names(a);
  const nb = names(b);
  put('地名', na.length !== nb.length ? Math.abs(na.length - nb.length) || 1 : na.filter((x, k) => x !== nb[k]).length);
  return out;
}

// 移出这些之后地图差在哪里（在副本上试，原来的世界不动）
function tryRemove(engine: Engine, items: readonly ContentRef[]): [string, number][] {
  if (!items.length) return [];
  const copy = engine.clone();
  copy.exec({ op: 'tidy_content', items: [...items] });
  copy.update();
  return mapDiff(engine.world, copy.world);
}

const reasonOf = (diff: [string, number][]) => `移出后地图会变：${diff.map(([what, n]) => `${n} 格的${what}`).join('、')}`;

// 整理的计划。engine 的推导会先算到最新。
// only：只考虑这几项（界面整个小包移出时：小包里的项，没在用、移出后地图不变的才移）；省略时是 unusedContent 列出的全部。
// only 里在用的（usage.ts 说在用）、不在世界里的直接不要（不写进 kept）
export function planTidy(engine: Engine, opts: { only?: readonly ContentRef[] } = {}): TidyPlan {
  engine.update();
  const world = engine.world;
  const candidates = opts.only ? opts.only.filter((r) => findItem(world, r) !== undefined && !inUse(world, r)) : unusedContent(world);
  const kept: TidyKept[] = [];
  let accepted: ContentRef[] = [];
  if (candidates.length && tryRemove(engine, candidates).length) {
    // 按种类一批批试；不过的那一种一项项试（之前通过的一起移出时再试）
    for (const kind of TIDY_KINDS) {
      const group = candidates.filter((c) => c.kind === kind);
      if (!group.length) continue;
      if (!tryRemove(engine, [...accepted, ...group]).length) {
        accepted = [...accepted, ...group];
        continue;
      }
      for (const ref of group) {
        const diff = tryRemove(engine, [...accepted, ref]);
        if (!diff.length) accepted = [...accepted, ref];
        else kept.push({ ...ref, name: nameOf(world, ref), reason: reasonOf(diff) });
      }
    }
  } else accepted = candidates;
  // 留下的场若是给留下的生态用的，没有问题：unusedContent 只列没有内容写到的场
  const removed = accepted.map((ref) => removedItem(world, ref));
  return { command: accepted.length ? { op: 'tidy_content', items: accepted } : null, removed, kept };
}

function inUse(world: World, ref: ContentRef): boolean {
  const k = kindOf(ref.kind);
  return !k || !!usageOf(k, strictWorld(world), ref.id);
}

function findItem(world: World, ref: ContentRef): unknown {
  const k = kindOf(ref.kind);
  if (!k) return undefined;
  if (k.store === 'content') return world.small.content?.[ref.kind]?.[ref.id];
  return k.inWorld(world).find((x) => itemId(k, x) === ref.id);
}

function nameOf(world: World, ref: ContentRef): string {
  const k = kindOf(ref.kind);
  const item = findItem(world, ref);
  return k && item !== undefined ? itemName(k, item) : ref.id;
}

function removedItem(world: World, ref: ContentRef): RemovedItem {
  const item = findItem(world, ref);
  const origin = world.small.origin?.[ref.kind]?.[ref.id];
  return { kind: ref.kind, id: ref.id, name: nameOf(world, ref), item: structuredClone(item), ...(origin ? { origin: [...origin] } : {}) };
}
