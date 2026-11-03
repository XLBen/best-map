import type { Derived, PopTuple, World } from '../world';
import type { GenContext } from './context';
import { type Dimension, cultureById, filledDims } from './era';
import { GroupTable, SLOTS, compactGroups } from './groups';
import { type DimPlan, dimPlans, valueDist } from './population';
import { type CellInputs, cellInputs } from './rules';
import { worldTerrainClasses } from './terrain-class';

// 给已有的世界加一维（第五十四轮，add_dimension）。用户定的：只算新变量，文化、国家、城市都不动；文化没写倾向时按平均。
//
// 每格只记 4 个群体（SLOTS，改了世界的布局就变了）。所以不能像生成那样排列组合再取人最多的 4 个：多出来的人会算进“其他”，
// 文化的比例就变了（中世纪加一维“其他”从 0.4% 到 16%）。这里原地分开：一格里每个群体的人只在“这个群体 + 新维度的某个取值”之间分，
// 整数的占比（/255）加起来和原来一样，所以每个文化、每个旧群体的占比逐值不变。
//   1. 想要的份额：这一格、这个文化按新维度的分布（valueDist，和生成同一个式子：倾向 × 偏好 × 成片的噪声，占比不到 4% 的去掉，最多 3 种）。
//   2. 群体从大到小，每个先整个归给这个文化缺得最多的取值。
//   3. 还有空位时，把多出来的人分给缺的取值（每次挑能挪最多的；少于 MIN_PIECE 的不分）。没有空位时就停在第 2 步：
//      格位满的格，新维度的比例只能精确到一个群体。
// 群体太多时（超过 MAX_POP_GROUPS）：全世界按人数从多到少留，人最少的并进同一个旧群体里人最多的分法。并只发生在同一个旧群体里，文化比例不变；
// 每个旧群体至少留一种。世界有多大才碰得到见设计文档。
//
// 生成人口时（重新生成国家……）后加的维度也走这里（fillAddedDims）：先和没有这一维时一样算好，最后分开。
// 所以加一维不会让重新生成的文化、“其他”变样；没有后加的维度的世界不走这里，结果和以前逐值相同。

// 一块最少多少（/255，约 1.2%）
const MIN_PIECE = 3;
// 群体的上限（编号是 Uint16，留一些给之后的笔刷）
export const MAX_POP_GROUPS = 60000;

// 分开之后的一种群体：从一个旧群体（root）一维一维分出来。同一种只有一个对象，先不给编号，最后才定留哪些
interface Node {
  tuple: PopTuple;
  root: Node;
  kids: Map<string, Node> | null;
  people: number;
  // 用到了（排在 leaves 里的下标 + 1）
  used: number;
  code: number;
}
interface Piece {
  node: Node;
  s: number;
}
// 这一格里一个文化的分布：取值、还缺多少（/255，负的是多了）
interface Want {
  ids: string[];
  gap: number[];
}
const newNode = (tuple: PopTuple, root?: Node): Node => {
  const n: Node = { tuple, root: root as Node, kids: null, people: 0, used: 0, code: 0 };
  if (!root) n.root = n;
  return n;
};

// 按几维原地分开。先后固定，执行、重放都一样
class Splitter {
  private plans = new Map<string, DimPlan>();
  private noise = new Map<number, Float32Array>();
  private roots = new Map<number, Node>();
  private leaves: Node[] = [];
  private classIds: string[];

  constructor(
    private world: World,
    private x: CellInputs,
    private cls: Uint8Array,
    private era: string,
    private dims: readonly Dimension[],
    private seed: number,
    private groups: Readonly<Record<string, PopTuple>>,
  ) {
    this.classIds = worldTerrainClasses(world.small).map((c) => c.id);
  }

  private planOf(dim: Dimension, culture: string): DimPlan {
    const key = `${dim.id}\u0000${culture}`;
    let p = this.plans.get(key);
    if (!p) this.plans.set(key, (p = dimPlans(this.world, this.era, [cultureById(this.world.small, culture)], [dim], this.world.small.species, this.classIds, this.seed)[0]));
    return p;
  }

  private child(node: Node, dim: string, value: string): Node {
    node.kids ??= new Map();
    let k = node.kids.get(value);
    if (!k) {
      k = newNode({ culture: node.tuple.culture, values: { ...node.tuple.values, [dim]: value } }, node.root);
      node.kids.set(value, k);
    }
    return k;
  }

  // 一格的群体按一维分开
  private splitDim(dim: Dimension, list: Piece[], i: number): Piece[] {
    const fixed: Piece[] = [];
    const pieces: (Piece & { want: Want; v: number })[] = [];
    const wants = new Map<string, Want>();
    for (const p of list) {
      // 已经有这一维取值的不动
      if (p.node.tuple.values[dim.id] !== undefined) {
        fixed.push(p);
        continue;
      }
      const culture = p.node.tuple.culture;
      let want = wants.get(culture);
      if (!want) {
        const ids: string[] = [];
        const gap: number[] = [];
        for (const d of valueDist(this.world, this.planOf(dim, culture), 0, this.x, this.cls, i, this.noise)) {
          if (!d.id) continue;
          ids.push(d.id);
          gap.push(d.p);
        }
        wants.set(culture, (want = { ids, gap }));
      }
      // 这一维没有取值（不是每人都有、也没写倾向）：不动
      if (!want.ids.length) fixed.push(p);
      else pieces.push({ node: p.node, s: p.s, want, v: 0 });
    }
    if (!pieces.length) return list;
    // 份额 → 这个文化在这一格的人数（/255）
    const sums = new Map<Want, number>();
    for (const p of pieces) sums.set(p.want, (sums.get(p.want) ?? 0) + p.s);
    for (const [w, sum] of sums) for (let v = 0; v < w.gap.length; v++) w.gap[v] *= sum;
    // 从大到小，每个归给缺得最多的（一样多时份额大的）
    pieces.sort((a, b) => b.s - a.s);
    for (const p of pieces) {
      let best = 0;
      for (let v = 1; v < p.want.gap.length; v++) if (p.want.gap[v] > p.want.gap[best]) best = v;
      p.v = best;
      p.want.gap[best] -= p.s;
    }
    // 有空位时分开
    let free = SLOTS - fixed.length - pieces.length;
    while (free > 0) {
      let from: (typeof pieces)[number] | null = null;
      let to = 0;
      let move = 0;
      for (const p of pieces) {
        const over = -p.want.gap[p.v];
        if (!(over > 0)) continue;
        for (let v = 0; v < p.want.gap.length; v++) {
          if (!(p.want.gap[v] > 0)) continue;
          const m = Math.round(Math.min(over, p.want.gap[v], p.s - MIN_PIECE));
          if (m >= MIN_PIECE && m > move) {
            from = p;
            to = v;
            move = m;
          }
        }
      }
      if (!from) break;
      from.s -= move;
      from.want.gap[from.v] += move;
      from.want.gap[to] -= move;
      pieces.push({ ...from, v: to, s: move });
      free--;
    }
    return [...fixed, ...pieces.map((p) => ({ node: this.child(p.node, dim.id, p.want.ids[p.v]), s: p.s }))];
  }

  // 第 i 格（g、s：n × 4 的群体与占比；total：这一格的人数）分开，结果记进 slots（Node）、s（占比）。g 最后才写（finish）
  cell(g: Uint16Array, s: Uint8Array, i: number, total: number, slots: (Node | null)[]) {
    const o = i * SLOTS;
    let list: Piece[] = [];
    for (let k = 0; k < SLOTS; k++) {
      const code = g[o + k];
      const share = s[o + k];
      s[o + k] = 0;
      if (!code || !share) continue;
      let node = this.roots.get(code);
      if (!node) {
        // 认不出的群体（编号表里没有）只有在坏了的世界里才有：算进“其他”
        const tuple = this.groups[code];
        if (!tuple) continue;
        this.roots.set(code, (node = newNode(tuple)));
      }
      list.push({ node, s: share });
    }
    if (!list.length) return;
    for (const dim of this.dims) list = this.splitDim(dim, list, i);
    list.forEach((p, k) => {
      slots[o + k] = p.node;
      s[o + k] = p.s;
      if (!p.node.used) p.node.used = this.leaves.push(p.node);
      p.node.people += (total * p.s) / 255;
    });
  }

  // 定下留哪些、给编号：人多的先留，每个旧群体至少留一种；room 之外的并进同一个旧群体里留下的人最多的那一种
  assign(table: GroupTable, room: number) {
    const order = [...this.leaves].sort((a, b) => b.people - a.people || a.used - b.used);
    const best = new Map<Node, Node>();
    const kept = new Set<Node>();
    for (const n of order) {
      if (best.has(n.root)) continue;
      best.set(n.root, n);
      kept.add(n);
    }
    for (const n of order) {
      if (kept.size >= room) break;
      kept.add(n);
    }
    // 编号按第一次出现的先后（和 compactGroups 一样，也不依赖人数的排法）
    for (const n of this.leaves) if (kept.has(n)) n.code = table.code(n.tuple);
    for (const n of this.leaves) if (!kept.has(n)) n.code = best.get(n.root)!.code;
  }

  // 写回一格：同一个编号的并在一起（并过的才有），按占比从大到小（一样大时编号小的在前）
  finish(g: Uint16Array, s: Uint8Array, i: number, slots: readonly (Node | null)[]) {
    const o = i * SLOTS;
    const out = new Map<number, number>();
    for (let k = 0; k < SLOTS; k++) {
      const n = slots[o + k];
      if (n) out.set(n.code, (out.get(n.code) ?? 0) + s[o + k]);
    }
    const list = [...out].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (let k = 0; k < SLOTS; k++) {
      g[o + k] = list[k]?.[0] ?? 0;
      s[o + k] = list[k]?.[1] ?? 0;
    }
  }
}

// 现有的人（含自动的快照：恢复自动后还是分开的样子）按 dim 分开。人数不动。maxGroups 只有测试改
export function fillPopulation(world: World, d: Derived, era: string, dim: Dimension, opts: { maxGroups?: number } = {}) {
  const { causes: c, small, mesh } = world;
  const n = mesh.n;
  const sp = new Splitter(world, cellInputs(world, d), d.terrainClass, era, [dim], small.human!.seed >>> 0, small.popGroups ?? {});
  const slots: (Node | null)[] = new Array(n * SLOTS).fill(null);
  for (let i = 0; i < n; i++) sp.cell(c.popGroup!, c.popShare!, i, c.popTotal![i], slots);
  const auto = c.popAutoGroup && c.popAutoShare && c.popAutoTotal ? { g: c.popAutoGroup, s: c.popAutoShare, t: c.popAutoTotal, slots: new Array<Node | null>(n * SLOTS).fill(null) } : null;
  if (auto) for (let i = 0; i < n; i++) sp.cell(auto.g, auto.s, i, auto.t[i], auto.slots);
  // 分开之后旧群体没人用了：编号另起一份
  const fresh: { popGroups?: typeof small.popGroups } = {};
  const table = new GroupTable(fresh);
  sp.assign(table, opts.maxGroups ?? MAX_POP_GROUPS);
  for (let i = 0; i < n; i++) sp.finish(c.popGroup!, c.popShare!, i, slots);
  if (auto) for (let i = 0; i < n; i++) sp.finish(auto.g, auto.s, i, auto.slots);
  table.commit();
  small.popGroups = fresh.popGroups ?? {};
  compactGroups(small, c, auto ? [auto.g] : []);
}

// 生成的最后一步：后加的维度（和超过前 3 维的）原地分开。没有时什么都不做
export function fillAddedDims(ctx: GenContext) {
  const dims = filledDims(ctx.era);
  if (!dims.length) return;
  const { world, keep } = ctx;
  const { causes: c, small, mesh } = world;
  const n = mesh.n;
  // 先去掉用不到的群体（上一次生成的、这次排列组合时没选上的）。手改过、留着的格在自动的快照里的还要
  const auto = keep && c.popAutoGroup?.length === n * SLOTS ? c.popAutoGroup : null;
  if (auto) for (let i = 0; i < n; i++) if (!keep![i]) auto.fill(0, i * SLOTS, (i + 1) * SLOTS);
  compactGroups(small, c, auto ? [auto] : []);
  const sp = new Splitter(world, ctx.x, ctx.cls, ctx.era.id, dims, ctx.seed, small.popGroups ?? {});
  const slots: (Node | null)[] = new Array(n * SLOTS).fill(null);
  for (let i = 0; i < n; i++) if (!keep?.[i]) sp.cell(c.popGroup!, c.popShare!, i, c.popTotal![i], slots);
  const table = new GroupTable(small);
  sp.assign(table, MAX_POP_GROUPS - table.nextCode + 1);
  for (let i = 0; i < n; i++) if (!keep?.[i]) sp.finish(c.popGroup!, c.popShare!, i, slots);
  table.commit();
}
