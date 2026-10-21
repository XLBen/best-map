import { type ClimateBase, climateFields } from './climate';
import { graphDistance } from './mesh';
import { BUILTIN_FIELDS, trapezoid } from './species';
import { fieldGetter, isVegetated } from './vegetation';
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

export function solveConstraints(world: World, base: ClimateBase, d: Derived): SolveResult {
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
  const climateSlot = CLIMATE_KEYS.map((k) => fieldIndex.get(k) ?? -1);
  const staticGetters = fieldIds.map((f) => ((CLIMATE_KEYS as readonly string[]).includes(f) || f.startsWith('field:') ? null : fieldGetter(world, d, f)));
  const tolIdx = species.map((sp) => sp.tolerances.map((t) => fieldIndex.get(t.field)!));
  const vals = new Float64Array(fieldIds.length);
  const scores = new Float64Array(S);

  const evalScores = (i: number, dT: number, dl: number, dF: Record<string, number>) => {
    const f = climateFields(base.tS[i] + dT, base.tW[i] + dT, base.pS[i] * Math.exp(dl), base.pW[i] * Math.exp(dl));
    CLIMATE_KEYS.forEach((k, idx) => {
      if (climateSlot[idx] >= 0) vals[climateSlot[idx]] = f[k];
    });
    for (let k = 0; k < fieldIds.length; k++) {
      const id = fieldIds[k];
      if (id.startsWith('field:')) {
        const name = id.slice(6);
        vals[k] = (causes.fields[name]?.[i] ?? 0) + (dF[name] ?? 0);
      }
    }
    for (let s = 0; s < S; s++) {
      let v = 1;
      const tols = species[s].tolerances;
      for (let t = 0; t < tols.length && v > 0; t++) v *= trapezoid(tols[t], vals[tolIdx[s][t]]);
      scores[s] = v * species[s].competition * d.reach[i * S + s];
    }
  };
  const dominates = (target: number) => {
    const st = scores[target];
    if (st <= 0) return false;
    for (let s = 0; s < S; s++) if (s !== target && scores[s] * 1.02 >= st) return false;
    return true;
  };
  const argmax = () => {
    let b = -1;
    let bs = 0;
    for (let s = 0; s < S; s++) if (scores[s] > bs) {
      bs = scores[s];
      b = s;
    }
    return b;
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
      let bestTargetScore = -1;
      for (const [dT, dl] of CANDIDATES) {
        evalScores(i, dT, dl, dF);
        if (dominates(target)) {
          plan.cost[idx] = (dT / 5) ** 2 + (dl / 0.5) ** 2 + fCost;
          plan.dT[idx] = dT;
          plan.dl[idx] = dl;
          return;
        }
        if (scores[target] > bestTargetScore) {
          bestTargetScore = scores[target];
          plan.nearest[idx] = argmax();
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
  const customNames = new Set(plans.flatMap((p) => Object.keys(p.dF)));
  for (const name of customNames) {
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
  for (const ch of channels) {
    const field = new Float64Array(n);
    fixed.fill(0);
    for (const p of plans) {
      for (const k of p.anchors) {
        const i = p.cells[k];
        field[i] = ch.value(p, k);
        fixed[i] = 1;
      }
    }
    let any = false;
    for (let i = 0; i < n; i++) if (fixed[i] && field[i] !== 0) any = true;
    if (!any) continue;
    const region: number[] = [];
    for (let i = 0; i < n; i++) if (inRegion[i] && !fixed[i]) region.push(i);
    for (let it = 0; it < 3000; it++) {
      let change = 0;
      for (const i of region) {
        let s = 0;
        let w = 0;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          const wt = mesh.edgeLen[e] / mesh.dist[e];
          // 区域外的邻居视为 0（Dirichlet 边界）
          s += wt * (inRegion[j] ? field[j] : 0);
          w += wt;
        }
        const v = s / w;
        change = Math.max(change, Math.abs(v - field[i]));
        field[i] = v;
      }
      if (change < 1e-4) break;
    }
    for (let i = 0; i < n; i++) ch.target[i] = field[i];
  }
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
    const counts = new Map<number, number>();
    for (const i of failing) {
      const k = plan ? plan.cells.indexOf(i) : -1;
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
