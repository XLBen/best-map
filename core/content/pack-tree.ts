import type { PackNode } from '../packs';
import { itemId, kindByPackKey } from './registry';

// 包的树（从 packs.ts 拆出来，第四十九轮）：引用表（links.ts）在计算 Worker 那边也可能用到，不能引用 packs.ts（它带内置的地名风格）

// 这一层自己的一段（不含小包里的；没有时是空的）
export function ownItems<T = unknown>(node: PackNode, key: string): T[] {
  const v = node[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

// 这一层的小包
export const subPacks = (node: PackNode): PackNode[] => (Array.isArray(node.packs) ? node.packs : []);

// 按先后走一遍整棵树（先这一层，再各个小包）：path 是从 node 往下的小包 id（node 自己是 []）
export function walkPacks(node: PackNode, fn: (n: PackNode, path: string[]) => void, path: string[] = []): void {
  fn(node, path);
  for (const c of subPacks(node)) walkPacks(c, fn, [...path, c.id]);
}

// 按路径找小包（[] 是 node 自己）
export function findPack(node: PackNode, path: readonly string[]): PackNode | undefined {
  let cur: PackNode | undefined = node;
  for (const id of path) cur = cur && subPacks(cur).find((c) => c.id === id);
  return cur;
}

// 包里一段的项：整棵树里的（同一个 id 只算先出现的那一个；几个小包共用的是同一项）
export function packItems<T = unknown>(pack: PackNode, key: string): T[] {
  if (!subPacks(pack).length) return ownItems<T>(pack, key);
  const kind = kindByPackKey(key);
  const seen = new Set<string>();
  const out: T[] = [];
  walkPacks(pack, (n) => {
    for (const x of ownItems<T>(n, key)) {
      const id = kind ? itemId(kind, x) : JSON.stringify(x);
      if (!seen.has(id) && !!seen.add(id)) out.push(x);
    }
  });
  return out;
}

// 一项在包里的哪几个小包（从 pack 往下的路径，[] 是 pack 自己那一层），按先后
export function packPaths(pack: PackNode, key: string, id: string): string[][] {
  const kind = kindByPackKey(key);
  const out: string[][] = [];
  walkPacks(pack, (n, path) => {
    if (ownItems(n, key).some((x) => (kind ? itemId(kind, x) : x) === id)) out.push(path);
  });
  return out;
}
