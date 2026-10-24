import { worldSeedOf } from './biome-scripts';
import { CommandError } from './errors';
import { type IslandType, hasIslandScripts, islandCode, islandTypeById } from './island-types';
import { riverProvider } from './river-types';
import { type ScriptInputs, type ScriptIssue, compileScript, runScript, worldInputs } from './script';
import {
  type IslandSpec,
  type StampResult,
  centerCell,
  footprintOf,
  islandCellTarget,
  islandCore,
  islandGeometry,
  islandRadiusOf,
  islandStamp,
  reefLandDelta,
} from './terrain';
import type { Derived, World } from './world';

// 岛的种类的脚本（第十五轮）：放在哪里（placement）、岛的样子（shape）。引擎里没有哪一种岛是特别的——
// 湖心岛只是一种带这两段脚本的自己的岛（见内置示例包 packs/fantasy-islands.ts）。
//
// 只在放岛、画岛链的那一刻、在 Worker 里运行（主线程只画轮廓，确切的样子靠确切预览，见 ui/tools.ts）。
// 结果记进原因（陆度、抬升、岩性的增量，岛的种类，脚本定下的高度 causes.islandHeight），所以：
//   · 改了脚本只影响以后放的岛（与形状、高低、岩石一样）；
//   · 重放时这一步之前的小数据里就是当时的那一种（连同脚本），推导按原因重算，输入逐值相同，结果也相同；
//   · 脚本读到的推导（海拔、湖、气候……）是这一步之前的（命令里调 ensureDerived）。
//     所以带脚本的岛不能放进批量命令里：批量里前面几条改的东西，执行时还没有算进推导，重放时却算进了
//
// 岛的范围：这种岛本来的样子会改到的格（按形状量的距离 1.9 倍以内，见 terrain.ts 的 islandGeometry）与岛心那一格。
// 放在哪里：范围里每格一次，真（> 0.5）的格岛才能占，别的格一格不动；岛心那一格不行就整个不放（“「X」的脚本说这里放不了”）。
//   有它时代替内置的“只能放在海里”（没有它时岛的样子脚本只改海里的格，本来的样子照旧）。
// 岛的样子：离岛心 1 以内（与岛心那一格）能放的格每格一次；外面一圈照这种岛本来的样子（海底慢慢变浅）。
//   返回一个数是这格的高度（米，海平面以上为正）；或者 {height?, rock?, land?}：
//   height 高度（没写按这种岛本来的样子），rock 岩石软硬（0.3–5），land: false 这一格不动、land: true 一定成陆。
//   海里的格：高度大于 0（或 land: true）时抬成陆地，否则还是海；陆地（连湖）里的格：高度直接用上（湖里高出湖面的就是干的岛）。
//   定下的高度在高程算完之后直接换上（见 elevation.ts），所以湖里的岛就是给的高度，湖照旧按溢出口蓄水。
//   有这段脚本时环礁不挖潟湖。
// 出错（运行时出错、返回值不对、安全模式）：那一段按没有脚本算，说明接在这一步的说明后面；语法错误在新建、修改种类时就被拒绝

// 新建、修改岛的种类时检查脚本：只能是放在哪里、岛的样子两种，语法要对（错了整条命令不生效，并说明第几行错了）
export function checkIslandScripts(t: IslandType): void {
  const box = t.scripts;
  if (!box) return;
  for (const [kind, s] of Object.entries(box)) {
    if (!s) continue;
    if (kind !== 'placement' && kind !== 'shape') throw new CommandError(`岛的种类「${islandOwner(t)}」只能有“放在哪里”和“岛的样子”两种脚本`);
    compileScript(kind, s.src, islandOwner(t), 'island');
  }
}

export const islandOwner = (t: Pick<IslandType, 'name' | 'id'>) => t.name || t.id;

// 一条命令里几个岛共用的东西：推导、标准输入、水面高度、是不是海
export interface IslandScriptContext {
  d: Derived;
  base: ScriptInputs;
  water: Float32Array | null;
  sea: Uint8Array | null;
  // 出过的错（同一段脚本只记一次）
  issues: ScriptIssue[];
}

export function islandScriptContext(world: World, d: Derived): IslandScriptContext {
  return { d, base: worldInputs(world, d, { river: riverProvider(world, d) }), water: null, sea: null, issues: [] };
}

// 水面高度：湖面的格是湖面的海拔，海是 0，别的陆地是地面的海拔
function waterLevels(world: World, ctx: IslandScriptContext): Float32Array {
  if (!ctx.water) {
    const { d } = ctx;
    const land = world.causes.land;
    const n = world.mesh.n;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = !land[i] ? 0 : d.lake[i] === 1 ? d.water[i] : d.elevation[i];
    ctx.water = out;
  }
  return ctx.water;
}

function seaMask(world: World, ctx: IslandScriptContext): Uint8Array {
  if (!ctx.sea) ctx.sea = Uint8Array.from(world.causes.land, (v) => (v ? 0 : 1));
  return ctx.sea;
}

// 一个岛的脚本输入：世界的标准输入，加上只给岛的几个（离岛心、方位按这个岛算，只填它范围里的格）
function islandInputs(world: World, ctx: IslandScriptContext, spec: IslandSpec, at: Map<number, { r: number; angle: number }>): ScriptInputs {
  const n = world.mesh.n;
  let rArr: Float64Array | null = null;
  let aArr: Float64Array | null = null;
  const fill = () => {
    rArr = new Float64Array(n);
    aArr = new Float64Array(n);
    for (const [i, v] of at) {
      rArr[i] = v.r;
      aArr[i] = v.angle;
    }
  };
  return {
    n,
    globe: ctx.base.globe,
    get: (key) => {
      switch (key) {
        case 'r':
          if (!rArr) fill();
          return rArr!;
        case 'angle':
          if (!aArr) fill();
          return aArr!;
        case 'waterLevel':
          return waterLevels(world, ctx);
        case 'sea':
          return seaMask(world, ctx);
        case 'size':
          return spec.size;
        default:
          return ctx.base.get(key);
      }
    },
    field: ctx.base.field,
    river: ctx.base.river,
  };
}

const note = (ctx: IslandScriptContext, issue: ScriptIssue) => {
  if (!ctx.issues.some((x) => x.kind === issue.kind && x.owner === issue.owner)) ctx.issues.push(issue);
};

// 放一个带脚本的岛。返回 null：放在哪里的脚本说岛心那一格不行（整个不放）
export function scriptedIslandStamp(world: World, spec: IslandSpec, ctx: IslandScriptContext): StampResult | null {
  const t = islandTypeById(world.small, spec.kind);
  if (!t) throw new CommandError(`没有“${spec.kind}”这种岛`);
  const code = islandCode(world.small, spec.kind);
  const { mesh, causes } = world;
  const land = causes.land;
  const owner = islandOwner(t);
  const placement = t.scripts?.placement?.src.trim() ? t.scripts.placement : undefined;
  const shapeScript = t.scripts?.shape?.src.trim() ? t.scripts.shape : undefined;
  // 岛的范围：每格离岛心多远、在哪个方向（一格的岛只有岛心那一格）
  const geo = t.shape === 'cell' ? null : islandGeometry(world, spec, t);
  const c0 = geo ? geo.c0 : centerCell(mesh, spec.x, spec.y);
  const at = new Map<number, { r: number; angle: number; k: number }>();
  if (geo) {
    for (let k = 0; k < geo.cells.length; k++) {
      const r = islandRadiusOf(t, geo.dd[k]);
      at.set(geo.cells[k], { r, angle: Math.atan2(-geo.dy[k], geo.dx[k]), k });
    }
  }
  if (!at.has(c0)) at.set(c0, { r: 0, angle: 0, k: -1 });
  // 岛的范围：这种岛本来的样子会改到的格（离岛心约 1.9 倍以内）与岛心那一格。按编号排
  const range = [...at.keys()].sort((a, b) => a - b);
  const inputs = islandInputs(world, ctx, spec, at);
  const runOpts = { owner, id: t.id, seedKey: `${t.id}:${spec.variant}`, seed: worldSeedOf(world), inputs };

  // 放在哪里：真的格岛才能占（别的格一格不动）。没有这段脚本（或它出错了）时照内置的规则：
  // 本来的样子照旧，岛的样子脚本只改海里的格（原来是陆地的格不动）
  let allowed: Set<number> | null = null;
  if (placement) {
    const r = runScript({ kind: 'placement', src: placement.src, scope: 'island' }, { ...runOpts, cells: range });
    if (r.ok) {
      allowed = new Set();
      for (let j = 0; j < range.length; j++) if (r.output.factor[j] > 0.5) allowed.add(range[j]);
    } else note(ctx, r.issue);
  }
  if (allowed && !allowed.has(c0)) return null;
  const may = (i: number) => !allowed || allowed.has(i);

  if (!shapeScript) {
    // 本来的样子里能放的格
    const plain = islandStamp(world, spec);
    const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [] };
    plain.cells.forEach((i, k) => {
      if (!may(i)) return;
      out.cells.push(i);
      out.landDelta.push(plain.landDelta[k]);
      out.upliftDelta.push(plain.upliftDelta[k]);
      out.erodDelta.push(plain.erodDelta[k]);
      out.types.push(plain.types[k]);
    });
    out.footprint = footprintOf(world, out);
    return out;
  }

  // 岛的样子：离岛心 1 以内（和岛心那一格）能放的格每格一次；外面一圈照这种岛本来的样子（海底慢慢变浅）
  const cells = range.filter((i) => (allowed ? allowed.has(i) : !land[i]) && (at.get(i)!.r <= 1 || i === c0));
  const r = runScript({ kind: 'shape', src: shapeScript.src, scope: 'island' }, { ...runOpts, cells });
  if (!r.ok) note(ctx, r.issue);
  const { height, rock, land: want } = r.output;
  const slot = new Map<number, number>();
  cells.forEach((i, j) => slot.set(i, j));
  const core = islandCore(world);
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [], heights: [] };
  const rocks: number[] = [];
  for (const i of range) {
    if (!may(i)) continue;
    const j = slot.get(i);
    const h = j === undefined ? NaN : height[j];
    const wants = j === undefined ? -1 : want[j];
    const rk = j === undefined ? NaN : rock[j];
    if (wants === 0) continue;
    const L = causes.landness[i];
    const g = at.get(i)!;
    let delta = 0;
    let lift = 0;
    let fix = NaN;
    if (!Number.isNaN(h)) {
      if (land[i]) fix = h;
      else if (h > 0 || wants === 1) {
        delta = Math.max(0, core - L);
        fix = h;
      } else continue;
    } else if (!land[i] && wants === 1) {
      delta = Math.max(0, core - L);
    } else if (geo && g.k >= 0) {
      // 本来的样子（只添陆地：有这段脚本时环礁不挖潟湖）
      const c = islandCellTarget(t, geo.dd[g.k], core, geo, g.k);
      delta = Math.max(0, c.target - L);
      lift = c.lift;
    } else if (!land[i]) {
      // 岛心那一格不在轮廓里（岛太小）：与本来的样子一样把它抬成陆地
      delta = t.shape === 'cell' ? reefLandDelta(world, i) : Math.max(0, core - L);
    }
    if (delta === 0 && lift === 0 && Number.isNaN(fix) && Number.isNaN(rk)) continue;
    out.cells.push(i);
    out.landDelta.push(delta);
    out.upliftDelta.push(lift);
    out.heights!.push(fix);
    rocks.push(rk);
  }
  // 放岛后是陆地的格：新长出的陆地与定了高度的陆地记上这种岛；岩石：脚本给的照用，没给时新长出的陆地用这种岛的岩石
  out.footprint = footprintOf(world, out);
  const after = new Set(out.footprint);
  out.cells.forEach((i, k) => {
    const mine = after.has(i) && (!land[i] || !Number.isNaN(out.heights![k]));
    if (!after.has(i)) out.heights![k] = NaN;
    out.types.push(mine ? code : 0);
    const rk = rocks[k];
    out.erodDelta.push(!Number.isNaN(rk) ? rk - causes.erod[i] : mine && !land[i] && t.rock !== undefined ? t.rock - causes.erod[i] : 0);
  });
  if (!out.heights!.some((h) => !Number.isNaN(h))) delete out.heights;
  return out;
}

// 命令里放一个岛：带脚本的按脚本，否则照旧。issues：脚本出的错（按没有脚本算了的那一段）
export function stampIsland(world: World, spec: IslandSpec, derived: () => Derived): { stamp: StampResult; issues: ScriptIssue[] } {
  const t = islandTypeById(world.small, spec.kind);
  if (!hasIslandScripts(t)) return { stamp: islandStamp(world, spec), issues: [] };
  const ctx = islandScriptContext(world, derived());
  const stamp = scriptedIslandStamp(world, spec, ctx);
  if (!stamp) throw new CommandError(`「${islandOwner(t!)}」的脚本说这里放不了`);
  return { stamp, issues: ctx.issues };
}

// 一条命令里放几个岛（岛链）：放在哪里的脚本说岛心不行的岛不放
export function scriptedStamper(world: World, derived: () => Derived): { stamp: (w: World, s: IslandSpec) => StampResult; issues: () => ScriptIssue[]; refused: () => number } {
  let ctx: IslandScriptContext | null = null;
  let refused = 0;
  return {
    stamp: (w, s) => {
      ctx ??= islandScriptContext(world, derived());
      const r = scriptedIslandStamp(w, s, ctx);
      if (r) return r;
      refused++;
      return { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [] };
    },
    issues: () => ctx?.issues ?? [],
    refused: () => refused,
  };
}

// 出错的脚本接在这一步的说明后面
export function issueNote(issues: readonly ScriptIssue[]): string {
  return issues.length ? `；${issues[0].message}（按没有这段脚本放的）` : '';
}

// 主线程上画的岛的轮廓（不运行脚本）：岛的范围（离岛心 ≤ 1 的格，至少岛心那一格）。确切的样子靠 Worker 里的确切预览
export function islandOutline(world: World, spec: IslandSpec): number[] {
  const t = islandTypeById(world.small, spec.kind);
  if (!t) return [];
  if (t.shape === 'cell') return [centerCell(world.mesh, spec.x, spec.y)];
  const geo = islandGeometry(world, spec, t);
  const out = geo.cells.filter((_, k) => islandRadiusOf(t, geo.dd[k]) <= 1);
  if (!out.includes(geo.c0)) out.push(geo.c0);
  return out.sort((a, b) => a - b);
}
