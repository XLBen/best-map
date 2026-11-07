import { runPatterns } from './patterns';
import type { CountryRun } from './state';

// 外交（第二十三轮，只在新长出来的国家之间）：邻国（陆上接壤，或隔着一格海）→ 格局的 diplomacy 钩子（附庸，见 patterns/vassals.ts）→ 同盟、敌对。
// 第七十三轮从 countries.ts 搬来（原样），附庸挪进格局

export function diplomacy(g: CountryRun) {
  const { ctx, world, seeds, owner } = g;
  const metas = g.metas!;
  const { mesh, causes } = world;
  const k = seeds.length;
  const pairs = new Map<number, number>();
  const add = (a: number, b: number, w: number) => {
    if (a === b || a < 0 || b < 0) return;
    const key = a < b ? a * k + b : b * k + a;
    pairs.set(key, (pairs.get(key) ?? 0) + w);
  };
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i]) {
      const a = owner[i];
      if (a < 0) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (j > i && causes.land[j]) add(a, owner[j], 1);
      }
    } else {
      const near: number[] = [];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const o = owner[mesh.adj[e]];
        if (causes.land[mesh.adj[e]] && o >= 0 && !near.includes(o)) near.push(o);
      }
      for (let p = 0; p < near.length; p++) for (let q = p + 1; q < near.length; q++) add(near[p], near[q], 0.5);
    }
  }
  const neighbors: number[][] = seeds.map(() => []);
  const keys = [...pairs.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    const a = Math.floor(key / k);
    const b = key % k;
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  const group = (o: number) => ctx.cultureGroup[seeds[o].culture];
  g.neighbors = neighbors;
  const overlord = (g.overlord = new Int32Array(k).fill(-1));
  // 附庸、从属的种类（第二十六轮；第七十三轮起是格局，见 patterns/vassals.ts）
  runPatterns(g, 'diplomacy');
  // 同盟、敌对：亲近（同一个文化 2、同一个组 1、兼容 0.5、别的 −1，同一类政体再 + 0.5）
  for (const key of keys) {
    const a = Math.floor(key / k);
    const b = key % k;
    if (overlord[a] === b || overlord[b] === a) continue;
    const ma = metas[a];
    const mb = metas[b];
    let aff = seeds[a].culture === seeds[b].culture ? 2 : group(a) === group(b) ? 1 : ma.acceptedGroups.some((x) => mb.acceptedGroups.includes(x)) ? 0.5 : -1;
    if (seeds[a].gov.category.some((c) => seeds[b].gov.category.includes(c))) aff += 0.5;
    const r = g.stream('diplomacy', a, b)();
    if (aff >= 1 && r < 0.3 && ma.allies.length < 3 && mb.allies.length < 3) {
      ma.allies.push(mb.id);
      mb.allies.push(ma.id);
    } else if (aff <= 0 && r < 0.35 && ma.rivals.length < 2 && mb.rivals.length < 2) {
      ma.rivals.push(mb.id);
      mb.rivals.push(ma.id);
    }
  }
}
