import { mixSeed } from '../rng';
import { hashString } from '../names';
import type { HumanHearth, World } from '../world';
import type { GenContext, HumanStage } from './context';
import { RIVER } from './rules';
import { cellKm2, distKm, growByBudget, noiseAt } from './space';
import { cellMovement } from './terrain-class';

// 文化圈（第二十二轮）：先给每个文化组按喜欢的地理挑发源地，从发源地按代价往外扩（山、河、海峡难走；跨海贵但能过），
// 各组的地盘按权重定大小（宜居的面积按权重分）；再在每个组的地盘里同样给组里的文化分地盘。
// 结果是每格归哪个组、哪个文化（ctx.groupOf / cultureOf），人口一步按它放人。拖过的发源地（locked）留在原处

// 一个组有几个发源地：大世界、权重大的组多几个（每 2500 万 km² 陆地一个）
const AREA_PER_HEARTH = 25e6;
// 发源地之间至少隔开多远：√(陆地面积 / 发源地个数) 的这么多倍
const SPACING = 0.6;

// 走一条边的代价（km × 难走的倍数）：陆上按通行难度（地形类别的起伏 × 生态的植被）、高低差、过河；进湖 ×3；下海 ×8、海上 ×4、上岸 ×2
export function edgeCosts(ctx: Pick<GenContext, 'world' | 'x' | 'cls'>): Float32Array {
  const { world, x, cls } = ctx;
  const { mesh, causes } = world;
  const move = cellMovement(world.small, x, cls);
  const km = world.kmPerUnit;
  const out = new Float32Array(mesh.adj.length);
  const elev = x.elevation;
  for (let i = 0; i < mesh.n; i++) {
    const di = x.dry[i] === 1;
    const ri = (x.flags[i] & RIVER) !== 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      let mv: number;
      if (x.dry[j]) {
        mv = move[j];
        if (di) {
          mv *= 1 + Math.abs(elev[j] - elev[i]) / 600;
          if (((x.flags[j] & RIVER) !== 0) !== ri) mv *= 1.5;
        } else mv *= 2;
      } else if (causes.land[j]) mv = 3;
      else mv = di ? 8 : 4;
      out[e] = mesh.dist[e] * km * mv;
    }
  }
  return out;
}

// 离 cell 最近的干的陆地格（按步数；cell 本身是就是它）。没有干的陆地时为 −1
function nearestDry(world: World, dry: Uint8Array, cell: number): number {
  if (dry[cell]) return cell;
  const { mesh } = world;
  const seen = new Uint8Array(mesh.n);
  let frontier = [cell];
  seen[cell] = 1;
  while (frontier.length) {
    const next: number[] = [];
    for (const i of frontier) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (seen[j]) continue;
        if (dry[j]) return j;
        seen[j] = 1;
        next.push(j);
      }
    }
    frontier = next.sort((a, b) => a - b);
  }
  return -1;
}

// mask 里相连的几块（干的陆地）：每格属于哪一块、每块宜居的面积。发源地不放在装不下它那一份的小岛上
function pieces(world: World, mask: (i: number) => boolean, mass: Float64Array): { piece: Int32Array; size: number[] } {
  const { mesh } = world;
  const piece = new Int32Array(mesh.n).fill(-1);
  const size: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < mesh.n; s++) {
    if (piece[s] >= 0 || !mask(s)) continue;
    const id = size.length;
    let m = 0;
    piece[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      m += mass[i];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (piece[j] < 0 && mask(j)) {
          piece[j] = id;
          stack.push(j);
        }
      }
    }
    size.push(m);
  }
  return { piece, size };
}

// 一块地方够不够放下要的那么多宜居的面积：够一半为 1，越小越低
const room = (have: number, want: number): number => (want > 0 ? Math.min(1, have / (0.5 * want)) : 1);

// 在 cands 里挑一个发源地：得分最高、离已有的发源地都不近于 minKm（挑不出来时距离放宽）
function pick(world: World, cands: readonly number[], score: (i: number) => number, placed: readonly number[], minKm: number): number {
  for (let gap = minKm; ; gap *= 0.7) {
    let best = -1;
    let bs = -Infinity;
    for (const i of cands) {
      const s = score(i);
      if (!(s > bs)) continue;
      let ok = true;
      for (const p of placed) {
        if (distKm(world, i, p) < gap) {
          ok = false;
          break;
        }
      }
      if (ok) {
        bs = s;
        best = i;
      }
    }
    if (best >= 0 || gap < 1) return best;
  }
}

// 按权重分地盘：各方占的宜居的面积按权重的比例（见 space.ts 的 growByBudget）
function share(
  ctx: GenContext,
  seeds: { cell: number; owner: number }[],
  weights: readonly number[],
  edge: Float32Array,
  pref: (Float32Array | null)[],
  allow: Uint8Array | null,
  mass: Float64Array,
): Int32Array {
  let total = 0;
  for (let i = 0; i < mass.length; i++) if (!allow || allow[i]) total += mass[i];
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const budget = Float64Array.from(weights, (w) => (w / wsum) * total);
  return growByBudget(ctx.world.mesh, seeds, weights.length, edge, pref, allow, mass, budget);
}

function placeCultures(ctx: GenContext) {
  const { world, x, groups, seed, hab } = ctx;
  const { mesh } = world;
  const n = mesh.n;
  const dry = x.dry;
  const edge = edgeCosts(ctx);
  // 宜居的面积（km² × 宜居度）
  const mass = new Float64Array(n);
  const cands: number[] = [];
  let dryArea = 0;
  for (let i = 0; i < n; i++) {
    if (!dry[i]) continue;
    const a = cellKm2(world, i);
    dryArea += a;
    mass[i] = a * hab[i];
    cands.push(i);
  }
  const groupOf = new Int32Array(n).fill(-1);
  const cultureOf = new Int32Array(n).fill(-1);
  ctx.groupOf = groupOf;
  ctx.cultureOf = cultureOf;
  if (!cands.length || !groups.length) {
    ctx.hearths = [];
    return;
  }
  const jitter = (salt: number) => {
    const s = mixSeed(seed, salt);
    return (i: number) => 1 + 0.35 * noiseAt(world, s, 600, i);
  };

  // ---- 文化组的发源地 ----
  const wsum = groups.reduce((a, g) => a + g.weight, 0) || 1;
  const total = Math.max(groups.length, Math.round(dryArea / AREA_PER_HEARTH));
  const counts = groups.map((g) => Math.max(1, Math.round((total * g.weight) / wsum)));
  const minKm = SPACING * Math.sqrt(dryArea / counts.reduce((a, b) => a + b, 0));
  const locked = (g: string) => ctx.hearths.filter((h) => h.locked && h.group === g && !h.culture);
  const placed: number[] = [];
  const hearths: HumanHearth[] = [];
  const own: number[][] = groups.map(() => []);
  // 权重大的组先挑；每一轮每组挑一个
  const order = groups.map((_, k) => k).sort((a, b) => groups[b].weight - groups[a].weight || (groups[a].group.id < groups[b].group.id ? -1 : 1));
  const lockedOf = groups.map((g) => locked(g.group.id));
  // 拖过的先放上（变成了海的挪到最近的陆地）
  groups.forEach((g, k) => {
    for (const h of lockedOf[k].slice(0, counts[k])) {
      const c = nearestDry(world, dry, h.cell);
      if (c < 0) continue;
      placed.push(c);
      own[k].push(c);
      hearths.push({ group: g.group.id, cell: c, locked: true });
    }
  });
  const jg = jitter(hashString('hearth:group'));
  const maxCount = Math.max(...counts);
  const land = pieces(world, (i) => dry[i] === 1, mass);
  let totalMass = 0;
  for (const m of land.size) totalMass += m;
  for (let round = 0; round < maxCount; round++) {
    for (const k of order) {
      if (own[k].length > round || own[k].length >= counts[k]) continue;
      const pf = ctx.groupPref[k];
      const mine = own[k];
      const want = (totalMass * groups[k].weight) / wsum / counts[k];
      const score = (i: number) => {
        let s = hab[i] * pf[i] * jg(i) * room(land.size[land.piece[i]], want);
        // 同一组的第二个发源地靠近第一个
        if (mine.length) {
          let dmin = Infinity;
          for (const p of mine) dmin = Math.min(dmin, distKm(world, i, p));
          s *= 0.5 + Math.exp(-dmin / (3 * minKm));
        }
        return s;
      };
      const c = pick(world, cands, score, placed, minKm);
      if (c < 0) continue;
      placed.push(c);
      mine.push(c);
      hearths.push({ group: groups[k].group.id, cell: c });
    }
  }

  // ---- 文化组的地盘 ----
  const prefSqrt = (p: Float32Array): Float32Array => {
    const out = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) if (dry[i]) out[i] = Math.sqrt(Math.min(5, Math.max(0.2, p[i])));
    return out;
  };
  const gSeeds = own.flatMap((cells, k) => cells.map((cell) => ({ cell, owner: k })));
  const gOwner = share(
    ctx,
    gSeeds,
    groups.map((g) => g.weight),
    edge,
    ctx.groupPref.map(prefSqrt),
    null,
    mass,
  );
  groupOf.set(gOwner);

  // ---- 组里的文化 ----
  const jc = jitter(hashString('hearth:culture'));
  let base = 0;
  groups.forEach((g, k) => {
    const list = g.cultures;
    const first = base;
    base += list.length;
    if (!list.length) return;
    const allow = new Uint8Array(n);
    const inside: number[] = [];
    let area = 0;
    for (let i = 0; i < n; i++) {
      if (groupOf[i] !== k) continue;
      allow[i] = 1;
      if (dry[i]) {
        inside.push(i);
        area += cellKm2(world, i);
      }
    }
    const cMin = SPACING * Math.sqrt(Math.max(area, 1) / list.length);
    const local = pieces(world, (i) => allow[i] === 1 && dry[i] === 1, mass);
    const gMass = local.size.reduce((a, b) => a + b, 0);
    const cw = list.reduce((a, c) => a + c.weight, 0) || 1;
    const cPlaced: number[] = [];
    const seeds: { cell: number; owner: number }[] = [];
    list.forEach((c, q) => {
      const h = ctx.hearths.find((x) => x.locked && x.culture === c.culture.id);
      let cell = -1;
      if (h) {
        cell = nearestDry(world, dry, h.cell);
        if (cell >= 0 && groupOf[cell] !== k) {
          // 拖到了组的地盘外：那一格归这个组
          groupOf[cell] = k;
          allow[cell] = 1;
        }
      }
      if (cell < 0) {
        const pf = ctx.culturePref[first + q];
        const want = (gMass * c.weight) / cw;
        cell = inside.length ? pick(world, inside, (i) => hab[i] * pf[i] * jc(i) * room(local.size[local.piece[i]], want), cPlaced, cMin) : own[k][0];
      }
      if (cell === undefined || cell < 0) return;
      cPlaced.push(cell);
      seeds.push({ cell, owner: q });
      hearths.push({ group: g.group.id, culture: c.culture.id, cell, ...(h ? { locked: true as const } : {}) });
    });
    if (!seeds.length) return;
    const owner = share(
      ctx,
      seeds,
      list.map((c) => c.weight),
      edge,
      list.map((_, q) => prefSqrt(ctx.culturePref[first + q])),
      allow,
      mass,
    );
    for (let i = 0; i < n; i++) if (allow[i] && owner[i] >= 0) cultureOf[i] = first + owner[i];
  });
  ctx.hearths = hearths;
}

export const culturesStage: HumanStage = { id: 'cultures', run: placeCultures };
