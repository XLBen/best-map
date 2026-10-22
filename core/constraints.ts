import { placementSlots } from './biome-scripts';
import { type ClimateBase, type ClimateEffects, petHalf } from './climate';
import { graphDistance } from './mesh';
import { BUILTIN_FIELDS, type Tolerance, trapezoid } from './species';
import { fieldGetter, invadeBoost, invadeTable, isVegetated } from './vegetation';
import type { Conflict, Constraint, Derived, World } from './world';

// 约束求解：用户规定结果（这些格是类型 X），系统反推原因。
// 1. 对每个约束格，在温度修正 dT 与降水对数修正 dl 的网格上按代价从小到大试，找到使 X 成为主导的最小修正；
//    X 对自定义场有要求时，把该场直接移进最适区间。
// 2. 省份级约束只要求 ratio 比例：取代价最低的那部分格作为锚点，其余格自然变化。
// 3. 锚点的修正值固定，半径 R 外为 0，中间在格图上解拉普拉斯方程（调和插值）→ 修正从地块向外平滑衰减。
// 修正场作用在气候上，水文、植被随之重算，所以河流与手工设定始终自洽。

export const MAX_DT = 15;
export const MAX_DL = 2.5;

const CANDIDATES: [number, number][] = (() => {
  const list: [number, number, number][] = [];
  for (let t = -MAX_DT; t <= MAX_DT; t += 1) {
    for (let l = -MAX_DL * 10; l <= MAX_DL * 10; l += 1) {
      const dl = l / 10;
      list.push([t, dl, (t / 5) ** 2 + (dl / 0.5) ** 2]);
    }
  }
  return list.sort((a, b) => a[2] - b[2]).map(([t, l]) => [t, l]);
})();
// 每个候选的 dT 序号（dT + MAX_DT）与 exp(dl)，与试算时现算的值相同
const NT = 2 * MAX_DT + 1;
const CAND_T = Int32Array.from(CANDIDATES, ([t]) => t + MAX_DT);
const CAND_E = Float64Array.from(CANDIDATES, ([, l]) => Math.exp(l));

const CLIMATE_KEYS = ['tMean', 'tWarm', 'tCold', 'precip', 'seasonality', 'moisture'] as const;

interface Plan {
  constraint: Constraint;
  target: number;
  cells: number[];
  cost: Float64Array;
  dT: Float64Array;
  dl: Float64Array;
  dF: Record<string, Float64Array>;
  anchors: number[];
  // 不可行时，在修正上限内能做到的最接近类型
  nearest: Int32Array;
}

export interface SolveResult {
  plans: Plan[];
}

// 曲线端点都是不太大的有限数时，梯形值总在 [0, 1]、不会是 NaN（输入为 NaN 时是 1）
const tame = (x: number) => Math.abs(x) <= 1e15;

// eff：生态、河对周围的影响（effects.ts）。有的时候试算的基础气候先加上它（与 finalizeClimate 的有影响的分支一致），
// 求解出的修正就把影响算进去了；没有时照原来的算式
export function solveConstraints(world: World, base: ClimateBase, d: Derived, eff?: ClimateEffects | null): SolveResult {
  const { mesh, small, causes } = world;
  const n = mesh.n;
  const species = small.species;
  const S = species.length;
  d.corrT.fill(0);
  d.corrP.fill(0);
  for (const k of Object.keys(d.corrF)) delete d.corrF[k];

  // 所有类型用到的字段：气候类每次试算重新计算，其余每格取一次
  const fieldIds = [...new Set(species.flatMap((sp) => sp.tolerances.map((t) => t.field)))];
  const fieldIndex = new Map(fieldIds.map((f, k) => [f, k]));
  const staticGetters = fieldIds.map((f) => ((CLIMATE_KEYS as readonly string[]).includes(f) || f.startsWith('field:') ? null : fieldGetter(world, d, f)));
  const customNames = fieldIds.map((f) => (f.startsWith('field:') ? f.slice(6) : null));
  const vals = new Float64Array(fieldIds.length);
  const scores = new Float64Array(S);

  // 所有耐受曲线排成一列：类型 s 的是 tolStart[s]..tolStart[s+1]；tolClim 为气候字段序号（-1：每格不变的字段）
  const tols: Tolerance[] = species.flatMap((sp) => sp.tolerances);
  const tolStart = new Int32Array(S + 1);
  for (let s = 0; s < S; s++) tolStart[s + 1] = tolStart[s] + species[s].tolerances.length;
  const tolClim = Int32Array.from(tols, (t) => (CLIMATE_KEYS as readonly string[]).indexOf(t.field));
  const tolVal = Int32Array.from(tols, (t) => fieldIndex.get(t.field)!);
  // tame 的类型：各曲线值在 [0, 1]，有一条为 0（或竞争力、可达为 0）则得分恒为 0
  const tameSp = species.map((sp) => Number.isFinite(sp.competition) && sp.tolerances.every((t) => tame(t.min) && tame(t.optLow) && tame(t.optHigh) && tame(t.max)));

  // 每格：不随试算变的曲线值先算好（恰为 1 的乘上不改变结果，略去），prog 是各类型要乘的曲线
  const fac = new Float64Array(tols.length);
  const prog = new Int32Array(tols.length);
  const progStart = new Int32Array(S + 1);
  // 得分可能不为 0 的类型（按序号）
  const live = new Int32Array(S);
  let nLive = 0;
  let ri = 0;
  // 本次试算的气候字段（与 core/climate.ts 的 summarize 同一算式，改那里时这里也要改：只随 dT 变的部分每格按 dT 存一份）
  const cv = new Float64Array(CLIMATE_KEYS.length);
  const tMeanT = new Float64Array(NT);
  const tWarmT = new Float64Array(NT);
  const tColdT = new Float64Array(NT);
  const petT = new Float64Array(NT);
  const warmT = new Uint8Array(NT);
  // 目标类型只随温度变的曲线在这个 dT 下有一条为 0（目标得分必为 0）
  const zeroT = new Uint8Array(NT);
  const stampT = new Int32Array(NT);
  let stamp = 0;

  // 第三批：长在哪里的脚本的系数、侵占的倍数。都按最近一遍植被的结果（气候是那一遍的），试算各个修正时当作不变
  // （脚本只在 Worker 的植被一步里跑，这里只读 placeF；侵占的目标适宜度也取那一遍的）。
  // 两样都没有时 extra 为 false，得分走原来的算式（逐值不变）
  const { slot: placeSlot, P } = placementSlots(species);
  const placeF = P > 0 && d.placeF?.length === n * P ? d.placeF : null;
  const invade = invadeTable(species);
  const extra = placeF !== null || invade !== null;
  // 这一格各类型要再乘的倍数（系数 × 侵占）
  const mul = new Float64Array(S).fill(1);

  const scoreOf = !extra
    ? (s: number) => {
        let v = 1;
        for (let q = progStart[s]; q < progStart[s + 1] && v > 0; q++) {
          const j = prog[q];
          v *= tolClim[j] >= 0 ? trapezoid(tols[j], cv[tolClim[j]]) : fac[j];
        }
        return v * species[s].competition * d.reach[ri + s];
      }
    : (s: number) => {
        let v = 1;
        for (let q = progStart[s]; q < progStart[s + 1] && v > 0; q++) {
          const j = prog[q];
          v *= tolClim[j] >= 0 ? trapezoid(tols[j], cv[tolClim[j]]) : fac[j];
        }
        return v * species[s].competition * d.reach[ri + s] * mul[s];
      };

  const plans: Plan[] = [];
  for (const c of small.constraints) {
    if (c.mode !== 'constraint') continue;
    const target = species.findIndex((sp) => sp.id === c.species);
    if (target < 0) continue;
    const cells = c.cells.filter((i) => i < n);
    const m = cells.length;
    const plan: Plan = {
      constraint: c,
      target,
      cells,
      cost: new Float64Array(m).fill(Infinity),
      dT: new Float64Array(m),
      dl: new Float64Array(m),
      dF: {},
      anchors: [],
      nearest: new Int32Array(m).fill(-1),
    };
    // 自定义场：直接移到目标类型的最适区间
    const customTols = species[target].tolerances.filter((t) => t.field.startsWith('field:'));
    for (const t of customTols) plan.dF[t.field.slice(6)] = new Float64Array(m);

    cells.forEach((i, idx) => {
      if (!isVegetated(world, d, i)) return;
      for (let k = 0; k < fieldIds.length; k++) if (staticGetters[k]) vals[k] = staticGetters[k]!(i);
      const dF: Record<string, number> = {};
      let fCost = 0;
      for (const t of customTols) {
        const name = t.field.slice(6);
        const v = causes.fields[name]?.[i] ?? 0;
        const delta = v < t.optLow ? t.optLow - v : v > t.optHigh ? t.optHigh - v : 0;
        dF[name] = delta;
        plan.dF[name][idx] = delta;
        fCost += delta * delta;
      }
      // 自定义场的值试算中不变
      for (let k = 0; k < fieldIds.length; k++) {
        const name = customNames[k];
        if (name !== null) vals[k] = (causes.fields[name]?.[i] ?? 0) + (dF[name] ?? 0);
      }
      ri = i * S;
      let q = 0;
      nLive = 0;
      let targetDead = false;
      for (let s = 0; s < S; s++) {
        progStart[s] = q;
        let zero = d.reach[ri + s] === 0 || species[s].competition === 0;
        if (extra) {
          // 脚本的系数为 0：怎么修正气候都长不出来（目标是它时这一格做不到，进冲突）
          let m = placeF && placeSlot[s] >= 0 ? placeF[i * P + placeSlot[s]] : 1;
          if (invade) m *= invadeBoost(invade, d.suit, S, i, s);
          mul[s] = m;
          if (m === 0) zero = true;
        }
        for (let j = tolStart[s]; j < tolStart[s + 1]; j++) {
          if (tolClim[j] < 0) {
            const f = trapezoid(tols[j], vals[tolVal[j]]);
            if (f === 1) continue;
            if (f === 0) zero = true;
            fac[j] = f;
          }
          prog[q++] = j;
        }
        if (!(zero && tameSp[s])) live[nLive++] = s;
        else if (s === target) targetDead = true;
      }
      progStart[S] = q;

      const tS0 = eff ? base.tS[i] + eff.t[i] : base.tS[i];
      const tW0 = eff ? base.tW[i] + eff.t[i] : base.tW[i];
      const pS0 = eff ? base.pS[i] * Math.exp(eff.p[i]) : base.pS[i];
      const pW0 = eff ? base.pW[i] * Math.exp(eff.p[i]) : base.pW[i];
      stamp++;
      let bestTargetScore = -1;
      // 上一次挡住目标的类型（先试它；挡没挡住与试的顺序无关）
      let block = -1;
      for (let k = 0; k < CANDIDATES.length; k++) {
        const ti = CAND_T[k];
        if (stampT[ti] !== stamp) {
          const tS = tS0 + (ti - MAX_DT);
          const tW = tW0 + (ti - MAX_DT);
          const summerWarm = tS >= tW;
          tMeanT[ti] = (tS + tW) / 2;
          tWarmT[ti] = summerWarm ? tS : tW;
          tColdT[ti] = summerWarm ? tW : tS;
          petT[ti] = Math.max(petHalf(tS) + petHalf(tW), 120);
          warmT[ti] = summerWarm ? 1 : 0;
          let z = 0;
          if (tameSp[target]) {
            for (let j = tolStart[target]; j < tolStart[target + 1]; j++) {
              const kc = tolClim[j];
              if (kc >= 0 && kc <= 2 && trapezoid(tols[j], kc === 0 ? tMeanT[ti] : kc === 1 ? tWarmT[ti] : tColdT[ti]) === 0) z = 1;
            }
          }
          zeroT[ti] = z;
          stampT[ti] = stamp;
        }
        // 目标得分必为 0：不会主导；第一个候选之后也不会比已有的更接近
        if (bestTargetScore >= 0 && (targetDead || zeroT[ti])) {
          if (targetDead) break;
          continue;
        }
        const e = CAND_E[k];
        const pS = pS0 * e;
        const pW = pW0 * e;
        const pWarm = warmT[ti] ? pS : pW;
        const pCold = warmT[ti] ? pW : pS;
        const precip = pS + pW;
        cv[0] = tMeanT[ti];
        cv[1] = tWarmT[ti];
        cv[2] = tColdT[ti];
        cv[3] = precip;
        cv[4] = (pWarm - pCold) / (pWarm + pCold + 1);
        cv[5] = precip / petT[ti];
        const st = scoreOf(target);
        // 目标比已有的更接近时要全部得分（找此时的主导类型）
        const all = st > bestTargetScore;
        if (all) for (let a = 0; a < nLive; a++) scores[live[a]] = live[a] === target ? st : scoreOf(live[a]);
        if (!(st <= 0)) {
          // 主导：其他类型都不到目标的 1/1.02（得分恒为 0 的类型挡不住）
          let blocked = false;
          if (block >= 0 && (all ? scores[block] : scoreOf(block)) * 1.02 >= st) blocked = true;
          else {
            for (let a = 0; a < nLive; a++) {
              const s = live[a];
              if (s === target || s === block) continue;
              if ((all ? scores[s] : scoreOf(s)) * 1.02 >= st) {
                blocked = true;
                block = s;
                break;
              }
            }
          }
          if (!blocked) {
            const [dT, dl] = CANDIDATES[k];
            plan.cost[idx] = (dT / 5) ** 2 + (dl / 0.5) ** 2 + fCost;
            plan.dT[idx] = dT;
            plan.dl[idx] = dl;
            return;
          }
        }
        if (all) {
          bestTargetScore = st;
          let b = -1;
          let bs = 0;
          for (let a = 0; a < nLive; a++) {
            const s = live[a];
            if (scores[s] > bs) {
              bs = scores[s];
              b = s;
            }
          }
          plan.nearest[idx] = b;
        }
      }
    });

    // 锚点：代价最低的 ratio 比例的可行格
    const order = cells.map((_, k) => k).filter((k) => Number.isFinite(plan.cost[k])).sort((a, b) => plan.cost[a] - plan.cost[b]);
    // 多留一点余量：降水增加后个别锚点可能被湖淹没，不再计入植被
    const valid = cells.filter((i) => isVegetated(world, d, i)).length;
    const need = Math.min(valid, Math.ceil(Math.min(1, c.ratio + 0.04) * valid));
    plan.anchors = order.slice(0, need);
    plans.push(plan);
  }

  // 调和插值：锚点固定，半径外为 0
  const channels: { key: string; target: Float32Array; value: (p: Plan, k: number) => number }[] = [
    { key: 'T', target: d.corrT, value: (p, k) => p.dT[k] },
    { key: 'P', target: d.corrP, value: (p, k) => p.dl[k] },
  ];
  const customFields = new Set(plans.flatMap((p) => Object.keys(p.dF)));
  for (const name of customFields) {
    d.corrF[name] = new Float32Array(n);
    channels.push({ key: `F:${name}`, target: d.corrF[name], value: (p, k) => p.dF[name]?.[k] ?? 0 });
  }
  if (plans.every((p) => p.anchors.length === 0)) return { plans };

  const fixed = new Uint8Array(n);
  const inRegion = new Uint8Array(n);
  for (const p of plans) {
    const anchorCells = p.anchors.map((k) => p.cells[k]);
    if (!anchorCells.length) continue;
    const limit = p.constraint.radius / world.kmPerUnit;
    const dist = graphDistance(mesh, anchorCells, limit);
    for (let i = 0; i < n; i++) if (dist[i] < limit) inRegion[i] = 1;
  }
  for (const p of plans) for (const k of p.anchors) fixed[p.cells[k]] = 1;
  // 各通道的锚点值；全为 0 的通道修正恒为 0，不用解。第 n 格恒为 0（代表区域外的邻居）
  const solving: { target: Float32Array; field: Float64Array }[] = [];
  for (const ch of channels) {
    const field = new Float64Array(n + 1);
    for (const p of plans) {
      for (const k of p.anchors) {
        const i = p.cells[k];
        field[i] = ch.value(p, k);
      }
    }
    let any = false;
    for (let i = 0; i < n; i++) if (fixed[i] && field[i] !== 0) any = true;
    if (any) solving.push({ target: ch.target, field });
  }
  if (!solving.length) return { plans };

  // 求解区（区域内、非锚点）的邻接表：只留区域内的邻居。区域外的邻居视为 0（Dirichlet 边界），
  // 它那一项 wt·0 = 0 加上不改变和，略去（wt 不是有限数时照算，指向第 n 格）。权重和按原顺序先加好
  const list: number[] = [];
  for (let i = 0; i < n; i++) if (inRegion[i] && !fixed[i]) list.push(i);
  const region = Int32Array.from(list);
  const R = region.length;
  const rOff = new Int32Array(R + 1);
  let edges = 0;
  for (const i of region) edges += mesh.off[i + 1] - mesh.off[i];
  const rAdj = new Int32Array(edges);
  const rWt = new Float64Array(edges);
  const rSum = new Float64Array(R);
  let q = 0;
  for (let r = 0; r < R; r++) {
    const i = region[r];
    let w = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const wt = mesh.edgeLen[e] / mesh.dist[e];
      w += wt;
      if (inRegion[j] || !Number.isFinite(wt)) {
        rAdj[q] = inRegion[j] ? j : n;
        rWt[q] = wt;
        q++;
      }
    }
    rSum[r] = w;
    rOff[r + 1] = q;
  }
  // 一遍 Gauss-Seidel，返回最大变化
  const sweep = (f: Float64Array) => {
    let change = 0;
    for (let r = 0; r < R; r++) {
      const i = region[r];
      let s = 0;
      for (let e = rOff[r]; e < rOff[r + 1]; e++) s += rWt[e] * f[rAdj[e]];
      const v = s / rSum[r];
      change = Math.max(change, Math.abs(v - f[i]));
      f[i] = v;
    }
    return change;
  };
  // 两个通道同一遍扫：互不影响，各自的算式、更新顺序与单独扫时相同（两条加法链交错着算）
  const change2 = new Float64Array(2);
  const sweep2 = (f: Float64Array, g: Float64Array) => {
    let cf = 0;
    let cg = 0;
    for (let r = 0; r < R; r++) {
      const i = region[r];
      let sf = 0;
      let sg = 0;
      for (let e = rOff[r]; e < rOff[r + 1]; e++) {
        const j = rAdj[e];
        sf += rWt[e] * f[j];
        sg += rWt[e] * g[j];
      }
      const vf = sf / rSum[r];
      const vg = sg / rSum[r];
      cf = Math.max(cf, Math.abs(vf - f[i]));
      cg = Math.max(cg, Math.abs(vg - g[i]));
      f[i] = vf;
      g[i] = vg;
    }
    change2[0] = cf;
    change2[1] = cg;
  };
  // 每个通道最多 3000 遍，某一遍最大变化 < 1e-4 即停（与逐个通道解时的遍数相同）
  for (let a = 0; a < solving.length; a += 2) {
    const f = solving[a].field;
    const g = a + 1 < solving.length ? solving[a + 1].field : null;
    let doneF = false;
    let doneG = g === null;
    for (let it = 0; it < 3000 && !(doneF && doneG); it++) {
      if (!doneF && !doneG) {
        sweep2(f, g!);
        doneF = change2[0] < 1e-4;
        doneG = change2[1] < 1e-4;
      } else if (!doneF) doneF = sweep(f) < 1e-4;
      else doneG = sweep(g!) < 1e-4;
    }
  }
  for (const { target, field } of solving) for (let i = 0; i < n; i++) target[i] = field[i];
  return { plans };
}

const FIELD_LABEL = new Map(BUILTIN_FIELDS.map((f) => [f.id, f]));

// 最终结果出来后检查每个约束是否达成；未达成的列入冲突面板，并说明卡在哪里
export function checkConstraints(world: World, d: Derived, solve: SolveResult): Conflict[] {
  const { small } = world;
  const species = small.species;
  const conflicts: Conflict[] = [];
  for (const c of small.constraints) {
    const target = species.findIndex((sp) => sp.id === c.species);
    if (target < 0) {
      conflicts.push({ constraintId: c.id, species: c.species, satisfied: 0, required: c.ratio, failing: c.cells, reasons: [], nearest: null, suggestions: [`类型“${c.species}”已不存在：删除这条设定或换一个类型`] });
      continue;
    }
    const cells = c.cells.filter((i) => i < world.mesh.n);
    const water = cells.filter((i) => !isVegetated(world, d, i));
    const valid = cells.filter((i) => isVegetated(world, d, i));
    const ok = valid.filter((i) => d.dominant[i] === target);
    const satisfied = valid.length ? ok.length / valid.length : 0;
    if (valid.length && satisfied >= c.ratio - 1e-9) continue;
    const failing = valid.filter((i) => d.dominant[i] !== target);
    const sp = species[target];
    const reasons: Conflict['reasons'] = [];
    const suggestions: string[] = [];
    if (water.length && !valid.length) suggestions.push('这些格是水体（海或湖），长不了植被');
    // 每条耐受曲线在失败格上的典型取值
    const median = (arr: number[]) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[s.length >> 1];
    };
    const limiting: { field: string; value: number; factor: number; need: [number, number] }[] = [];
    for (const t of sp.tolerances) {
      const get = fieldGetter(world, d, t.field);
      const values = failing.map(get);
      if (!values.length) continue;
      const value = median(values);
      const factor = trapezoid(t, value);
      if (factor < 0.999) limiting.push({ field: t.field, value, factor, need: [t.optLow, t.optHigh] });
    }
    limiting.sort((a, b) => a.factor - b.factor);
    for (const l of limiting) reasons.push({ field: l.field, value: l.value, need: l.need });
    const S = species.length;
    const unreachable = failing.filter((i) => d.reach[i * S + target] === 0).length;
    if (unreachable > failing.length / 2) suggestions.push('该类型从起源扩散不到这里：增加起源格、加大扩散距离，或降低跨海/跨不适宜地带的代价');
    // 长在哪里的脚本在没涂成的格里大多是 0：怎么调气候都长不出来
    const { slot: placeSlot, P } = placementSlots(species);
    const placeF = P > 0 && placeSlot[target] >= 0 && d.placeF?.length === world.mesh.n * P ? d.placeF : null;
    if (placeF) {
      const zero = failing.filter((i) => placeF[i * P + placeSlot[target]] === 0).length;
      // 不写生态的名字：只改名字时不重算冲突（Dirty.Names），写了会对不上
      if (zero > failing.length / 2) suggestions.push('这种生态的脚本条件在这些格里是 0（“长在哪里”的脚本不让它长在这里，怎么调冷暖干湿都长不出来）：改一改这个脚本');
    }
    for (const l of limiting.slice(0, 3)) {
      const info = FIELD_LABEL.get(l.field);
      const label = info?.label ?? l.field;
      const unit = info?.unit ?? '';
      const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
      const range = `${fmt(l.need[0])}–${fmt(l.need[1])}${unit}`;
      const cur = `${fmt(l.value)}${unit}`;
      if (info?.correctable === 'temp') {
        const need = l.value < l.need[0] ? l.need[0] - l.value : l.need[1] - l.value;
        suggestions.push(
          Math.abs(need) > MAX_DT
            ? `${label}约 ${cur}，需要 ${range}：所需温度修正 ${need.toFixed(1)} °C 超过 ±${MAX_DT} °C 上限`
            : `${label}约 ${cur}，需要 ${range}：需${need > 0 ? '升温' : '降温'}约 ${Math.abs(need).toFixed(1)} °C（在修正范围内，但与其他条件不能同时满足）`,
        );
      } else if (info?.correctable === 'precip') {
        const factor = l.value > 0 ? (l.value < l.need[0] ? l.need[0] / l.value : l.need[1] / l.value) : Infinity;
        const within = Math.abs(Math.log(factor)) <= MAX_DL;
        suggestions.push(
          within
            ? `${label}约 ${cur}，需要 ${range}：降水需×${factor.toFixed(2)}（在修正范围内，但与其他条件不能同时满足）`
            : `${label}约 ${cur}，需要 ${range}：降水需×${factor.toFixed(1)}，超过修正上限（×${Math.exp(MAX_DL).toFixed(0)}）`,
        );
      }
      else if (l.field === 'elevation') suggestions.push(`海拔约 ${cur}，需要 ${range}：用抬升笔${l.value > l.need[1] ? '降低' : '抬高'}这里的抬升`);
      else if (l.field === 'wetness' || l.field === 'discharge') suggestions.push(`${label}约 ${cur}，需要 ${range}：加一条河道引导或湖，让水汇到这里`);
      else if (l.field === 'slope') suggestions.push(`${label}约 ${cur}，需要 ${range}：调整这里的抬升或岩性`);
      else if (l.field === 'seasonality') suggestions.push(`${label}约 ${cur}，需要 ${range}：季节性由风带与季风决定，需要改变海陆格局或纬度`);
      else suggestions.push(`${label}约 ${cur}，需要 ${range}`);
    }
    if (!suggestions.length) suggestions.push('竞争不过当地的其他类型：提高该类型的竞争力，或改用硬覆盖');
    suggestions.push('也可以改用硬覆盖（标为例外，水文不认它）');
    // 最接近的可行类型：失败格上最常见的“修正上限内能达到的主导类型”
    const plan = solve.plans.find((p) => p.constraint.id === c.id);
    // 格在计划里的序号（同一格出现多次时取第一次，与 indexOf 相同）
    const pos = new Map<number, number>();
    if (plan) for (let k = plan.cells.length - 1; k >= 0; k--) pos.set(plan.cells[k], k);
    const counts = new Map<number, number>();
    for (const i of failing) {
      const k = pos.get(i) ?? -1;
      const s = k >= 0 && plan!.nearest[k] >= 0 ? plan!.nearest[k] : d.dominant[i];
      if (s >= 0) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let nearest: string | null = null;
    let best = 0;
    for (const [s, cnt] of counts) if (cnt > best && s !== target) {
      best = cnt;
      nearest = species[s].id;
    }
    conflicts.push({ constraintId: c.id, species: c.species, satisfied, required: c.ratio, failing, reasons, nearest, suggestions });
  }
  return conflicts;
}
