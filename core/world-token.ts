import type { World } from './world';

// 一个世界里全部数组（原因、推导、修正场、自定义场）的“这一批”编号（第八十轮）。
// 主线程收到的快照里没变的数组沿用同一个对象（src/worker-snapshot.ts）：两个世界的数组一个不差是同一批对象时编号相同。
// 读的数组多、一个一个列键容易漏的缓存（城市表、城市地标的列表、国家的统计）用它当键里的一项：
// 只改了国名、颜色（数组都没变）时命中，别的编辑（总有数组变了）照旧重算——和第八十轮以前每份快照的数组都是新副本时一样
const tokens = new WeakMap<object, number>();
const recent: { list: unknown[]; token: number }[] = [];
let next = 1;

function arraysOf(w: World): unknown[] {
  const out: unknown[] = [w.mesh];
  for (const [k, v] of Object.entries(w.causes)) {
    if (ArrayBuffer.isView(v)) out.push(k, v);
  }
  for (const [k, v] of Object.entries(w.causes.fields)) out.push(`f:${k}`, v);
  for (const [k, v] of Object.entries(w.derived)) {
    if (ArrayBuffer.isView(v)) out.push(k, v);
  }
  for (const [k, v] of Object.entries(w.derived.corrF ?? {})) out.push(`c:${k}`, v);
  return out;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function arraysToken(w: World): number {
  let t = tokens.get(w);
  if (t !== undefined) return t;
  const list = arraysOf(w);
  const hit = recent.find((r) => sameList(r.list, list));
  t = hit ? hit.token : next++;
  if (!hit) {
    recent.unshift({ list, token: t });
    recent.length = Math.min(recent.length, 4);
  }
  tokens.set(w, t);
  return t;
}
