import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERA_PACKS } from '../packs/eras';
import { continents, humanExec } from '../testing/fixtures';
import type { World } from '../world';
import type { GenContext } from './context';
import { composedDims } from './era';
import { registerHumanStage, unregisterHumanStage } from './generate';
import { GroupTable, type Share } from './groups';
import { compilePrefs, prefAt, preferenceFactors } from './habitability';
import type { CellInputs } from './rules';
import { noiseAt } from './space';
import { type DimPlan, composeCell, dimPlans, valueDist } from './population';

// 第七十九轮的提速，新旧逐位相同：population.ts 的 composeCell（组合里记每一维取的值、群体的键直接拼）；
// generate.ts 里文化的偏好倍数：没写偏好时用组的那一份，写了的在组的双精度乘积上接着乘（以前每个文化按“组的 + 文化的”再算一遍）。
// 生成时在人口一步之后记下这一次的 GenContext，每个有文化的格（一个文化；再掺一个别的文化）新旧各算一遍：
// 成分（群体的编号与占比）一样，两张群体表里的群体（编号、文化、取值、取值的键的先后）一样。
// 下面的 oldValueDist、oldComposeCell 是第七十八轮（8facf5e）的原样拷贝（只改了名字），不要改它

const VALUE_WAVE_KM = 1200;
const VALUE_SHARP = 2.5;
const VALUE_NOISE = 1.6;

// 一个文化在第 i 格、某一维的取值分布（已归一；没有取值时是一项 null）
function oldValueDist(world: World, plan: DimPlan, c: number, x: CellInputs, cls: Uint8Array, i: number, noise: Map<number, Float32Array>): { id: string | null; p: number }[] {
  const opts = plan.options[c];
  if (!opts.length) return [{ id: null, p: 1 }];
  if (opts.length === 1) return [{ id: opts[0].id, p: 1 }];
  const raw: { id: string; p: number }[] = [];
  let sum = 0;
  for (const o of opts) {
    let f = noise.get(o.seed);
    if (!f) noise.set(o.seed, (f = new Float32Array(world.mesh.n).fill(NaN)));
    let v = f[i];
    if (v !== v) v = f[i] = noiseAt(world, o.seed, VALUE_WAVE_KM, i);
    const score = Math.pow(o.w * prefAt(o.prefs, x, cls, i) * Math.exp(VALUE_NOISE * v), VALUE_SHARP);
    raw.push({ id: o.id, p: score });
    sum += score;
  }
  if (!(sum > 0)) return [{ id: opts[0].id, p: 1 }];
  const kept = raw
    .map((r) => ({ id: r.id, p: r.p / sum }))
    .filter((r) => r.p >= 0.04)
    .sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1))
    .slice(0, 3);
  const k = kept.reduce((a, b) => a + b.p, 0);
  return kept.map((r) => ({ id: r.id, p: r.p / k }));
}

// 第 i 格里 parts（文化的下标与占比）的成分：每个文化各维取值的组合，取最多的几种
function oldComposeCell(world: World, ctx: Pick<GenContext, 'x' | 'cls' | 'cultures'>, plans: readonly DimPlan[], parts: readonly { c: number; s: number }[], i: number, noise: Map<number, Float32Array>, table: GroupTable): Share[] {
  const out: Share[] = [];
  for (const part of parts) {
    let combos: { values: Record<string, string>; p: number }[] = [{ values: {}, p: part.s }];
    for (const plan of plans) {
      const dist = oldValueDist(world, plan, part.c, ctx.x, ctx.cls, i, noise);
      const next: typeof combos = [];
      for (const cb of combos) for (const v of dist) next.push({ values: v.id ? { ...cb.values, [plan.dim.id]: v.id } : cb.values, p: cb.p * v.p });
      next.sort((a, b) => b.p - a.p);
      combos = next.slice(0, 8);
    }
    for (const cb of combos) out.push({ code: table.code({ culture: ctx.cultures[part.c].id, values: cb.values }), s: cb.p });
  }
  return out;
}

let last: GenContext | undefined;
beforeAll(() => registerHumanStage({ id: 'peek-79', run: (ctx) => void (last = ctx) }, { after: 'population' }));
afterAll(() => unregisterHumanStage('peek-79'));

describe('第七十九轮：一格的成分，新旧逐位相同', () => {
  for (const era of ERA_PACKS.keys()) {
    it(era, () => {
      const e = continents();
      humanExec(e, { op: 'generate_human', packs: [[era]], groups: ERA_PACKS.get(era)!.cultures.map(([id, weight]) => ({ id, weight })), countries: {} });
      const ctx = last!;
      const w = ctx.world;
      const plans = dimPlans(w, ctx.era.id, ctx.cultures, composedDims(ctx.era), w.small.species, ctx.classIds, ctx.seed);
      expect(plans.length).toBeGreaterThan(0);
      // 组的、每个文化的偏好倍数：以前的算法（组的；组的 + 文化的偏好连成一串再编译，逐格算）
      ctx.groups.forEach((g, k) => {
        const old = preferenceFactors(compilePrefs(g.group.prefs, w.small.species, ctx.classIds), ctx.x, ctx.cls);
        expect(Buffer.from(ctx.groupPref[k].buffer).equals(Buffer.from(old.buffer))).toBe(true);
      });
      ctx.cultures.forEach((c, k) => {
        const g = ctx.groups[ctx.cultureGroup[k]].group;
        const old = preferenceFactors(compilePrefs([...(g.prefs ?? []), ...(c.prefs ?? [])], w.small.species, ctx.classIds), ctx.x, ctx.cls);
        expect(Buffer.from(ctx.culturePref[k].buffer).equals(Buffer.from(old.buffer))).toBe(true);
      });
      // 两张空的表，同样的先后各给编号（新的群体都经 make 建）
      const small = () => ({ popGroups: undefined, human: w.small.human ? { ...w.small.human, nextGroup: 1 } : undefined });
      const sa = small();
      const sb = small();
      const ta = new GroupTable(sa);
      const tb = new GroupTable(sb);
      const na = new Map<number, Float32Array>();
      const nb = new Map<number, Float32Array>();
      const K = ctx.cultures.length;
      let cells = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        const c = ctx.cultureOf![i];
        if (c < 0 || !ctx.x.dry[i]) continue;
        cells++;
        const parts = i % 3 === 0 && K > 1 ? [{ c, s: 0.7 }, { c: (c + 1 + (i % (K - 1))) % K, s: 0.3 }] : [{ c, s: 1 }];
        const a = oldComposeCell(w, ctx, plans, parts, i, na, ta);
        const b = composeCell(w, ctx, plans, parts, i, nb, tb);
        if (JSON.stringify(a) !== JSON.stringify(b)) expect([i, b]).toEqual([i, a]);
        // 取值的分布（add-dimension.ts 也用）：每一维、这一格的文化
        for (const plan of plans) {
          const va = oldValueDist(w, plan, c, ctx.x, ctx.cls, i, na);
          const vb = valueDist(w, plan, c, ctx.x, ctx.cls, i, nb);
          if (JSON.stringify(va) !== JSON.stringify(vb)) expect([i, plan.dim.id, vb]).toEqual([i, plan.dim.id, va]);
        }
      }
      expect(cells).toBeGreaterThan(1000);
      ta.commit();
      tb.commit();
      expect(JSON.stringify(sb.popGroups)).toBe(JSON.stringify(sa.popGroups));
      expect(sb.human?.nextGroup).toBe(sa.human?.nextGroup);
      expect(sa.human!.nextGroup).toBeGreaterThan(10);
    });
  }
});
