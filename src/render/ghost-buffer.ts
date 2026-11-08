// 幽灵海岸（第八十三轮从 src/render/colors.ts 原样搬出）：拖画笔、放岛时预览的那一层颜色
import type { World } from '../../core/world';
import type { CellLayers } from './renderer';
import { landPatch, type TerrainPreview } from '../../core/terrain';
import { coastPatch, coastValues } from '../../core/subcell';
import { isLake, terrainLikeMode, type RGB, ramp, HYPSO, SEA, warmth, fragColors } from './color-ramps';
import { lakeCoast } from '../../core/display';
import type { ViewMode } from '../state';
import { type FjordNet, fjordLayer } from '../../core/fjords';
import { coastStyle } from '../../core/coast-style';

// ---------- 幽灵海岸 ----------
// 陆地、海的工具（画陆地、圈一片、恢复原样、放岛、岛链、放湖、“调整”里的地形滑块、重画这一片）在松手前、算的时候
// 就画出将来真实的海岸线：几格的地形输入（海岸值、高程、颜色、对岸的颜色，以及平涂、分组）换成将来的样子，着色器照常画。
// 海岸值与结果逐格相同（core/subcell.ts 的 coastPatch、core/terrain.ts 的 previewTerrain）；
// 变成陆地、变成海的格，颜色与高程在结果到来之前是估计：颜色取同类邻格的平均，高程取 ±40 m（海岸细节的幅度随高程变）

// 工具给的改动：这些格的 landness 将来加多少；lake：将来成湖的格
export interface GhostEdit {
  cells: number[];
  delta: number[];
  lake?: number[];
  // 这些格将来的破碎度（0–255，第十八轮：放碎岛、画陆地 / 海清掉破碎度）
  frag?: { cells: number[]; value: number[] };
}

// 补丁：这些格（升序）将来的海岸值与陆海；lake：将来是湖面（海岸值照 staticLayers 的规则取负）
export interface GhostPatch {
  cells: Int32Array;
  coast: Float32Array;
  land: Uint8Array;
  lake?: Uint8Array;
  // 将来的破碎度（0–1）：这些格换成这些值
  frag?: { cells: Int32Array; value: Float32Array };
}

// 工具的改动 → 补丁：landPatch 的那些格（改动的格与邻格，邻格可能因补单格海洞而变）再加上成湖的格。
// 原来的湖还是陆地时照旧画成湖面（湖会不会变要等结果）
export function editGhost(world: World, base: CellLayers, edit: GhostEdit): GhostPatch {
  const lp = landPatch(world, edit.cells, edit.delta);
  const coast = coastPatch(world, lp.cells, lp.landness, lp.land);
  const at = new Map<number, number>();
  lp.cells.forEach((i, k) => at.set(i, k));
  const lakes = new Set(edit.lake ?? []);
  const extra = [...lakes].filter((i) => !at.has(i));
  const cells = extra.length ? Int32Array.from([...lp.cells, ...extra]).sort() : lp.cells;
  const out: GhostPatch = { cells, coast: new Float32Array(cells.length), land: new Uint8Array(cells.length), lake: new Uint8Array(cells.length) };
  cells.forEach((i, k) => {
    const j = at.get(i);
    out.coast[k] = j !== undefined ? coast[j] : base.coast[i];
    out.land[k] = j !== undefined ? lp.land[j] : world.causes.land[i];
    out.lake![k] = out.land[k] && (lakes.has(i) || isLake(world, i)) ? 1 : 0;
  });
  if (edit.frag?.cells.length) out.frag = { cells: Int32Array.from(edit.frag.cells), value: Float32Array.from(edit.frag.value, (v) => v / 255) };
  return out;
}

// 整份将来的海岸（调整滑块、重画这一片）→ 补丁：海岸值与现在不同的格。原来的湖还是陆地时照旧画成湖面。
// 第三十三轮：现在画面上的海岸值含三角洲向海凸出的那一点（core/delta.ts），将来的（previewTerrain）只按成因算：
// 按成因与现在一样的格不换（凸出的那一点照旧画着）
export function terrainGhost(world: World, base: CellLayers, t: TerrainPreview): GhostPatch {
  const n = world.mesh.n;
  const gained = new Set(t.gained);
  const lost = new Set(t.lost);
  const now = coastValues(world);
  const cells: number[] = [];
  for (let i = 0; i < n; i++) {
    const land = gained.has(i) || (world.causes.land[i] === 1 && !lost.has(i));
    if (Object.is(Math.fround(t.coast[i]), now[i]) && land === (world.causes.land[i] === 1)) continue;
    const c = land && isLake(world, i) ? lakeCoast(t.coast[i]) : t.coast[i];
    if (!Object.is(Math.fround(c), base.coast[i])) cells.push(i);
  }
  const out: GhostPatch = { cells: Int32Array.from(cells), coast: new Float32Array(cells.length), land: new Uint8Array(cells.length), lake: new Uint8Array(cells.length) };
  cells.forEach((i, k) => {
    const land = gained.has(i) || (world.causes.land[i] === 1 && !lost.has(i));
    out.coast[k] = t.coast[i];
    out.land[k] = land ? 1 : 0;
    out.lake![k] = land && isLake(world, i) ? 1 : 0;
  });
  return out;
}

export interface GhostLayers {
  smooth: Uint8Array;
  other: Uint8Array;
  elevation: Float32Array;
  coast: Float32Array;
  // 破碎度（第十八轮）；底子和补丁里都没有时为 null
  frag: Float32Array | null;
  flat: Uint8Array | null;
  group: Float32Array | null;
  // 海岸类型与小湖群（第三十四轮，每格两个数，见 core/coast-style.ts）：湖面格不画沙坝、岛礁；底子没有时为 null
  style: Float32Array | null;
  // 峡湾（第三十六轮，core/fjords.ts 的 fjordLayer 的 tex）：按将来的陆海重算；与底子相同时就是底子的那一份，没有峡湾时 null
  fjord?: Float32Array | null;
  // 现在与底子不同的格（升序）：上传时只传这些格（与上一次不同的格）所在的行
  cells: Int32Array;
  // 将来的海岸细节幅度（海岸曲折的滑块）；没有时照旧
  coastAmp?: number;
}

// 持久的幽灵缓冲：底子的一份副本，每次只把上次改过的格还原、再写这次的补丁，不必每动一下都复制整张图。
// 底子（setLayers 给的图层）换了就新建一个
export class GhostBuffer {
  readonly smooth: Uint8Array;
  readonly other: Uint8Array;
  readonly elevation: Float32Array;
  readonly coast: Float32Array;
  // 破碎度：底子有时是它的副本；没有时第一次用到才建（全是 0）
  frag: Float32Array | null;
  readonly flat: Uint8Array | null;
  readonly group: Float32Array | null;
  readonly style: Float32Array | null;
  // 峡湾（第三十六轮）：这一次按将来的陆海算的（与底子相同时是底子的那一份）
  private fjord: Float32Array | null | undefined;
  // 上一次算峡湾时谷网里的点所在的格的陆海（都没变时不重算）
  private fjLand: Uint8Array | null = null;
  private fjOut: Float32Array | null = null;
  // 上次写过的格
  private written: number[] = [];
  private mark: Uint8Array;

  constructor(
    readonly base: CellLayers,
    readonly mode: ViewMode,
  ) {
    this.smooth = base.smooth.slice();
    this.other = base.other.slice();
    this.elevation = base.elevation.slice();
    this.coast = base.coast.slice();
    this.frag = base.frag ? base.frag.slice() : null;
    this.flat = base.flat ? base.flat.slice() : null;
    this.group = base.group ? base.group.slice() : null;
    this.style = base.style ? base.style.slice() : null;
    this.mark = new Uint8Array(base.coast.length);
  }

  apply(world: World, patch: GhostPatch | null, coastAmp?: number): GhostLayers {
    const { base } = this;
    for (const i of this.written) {
      this.mark[i] = 0;
      for (let c = 0; c < 4; c++) {
        this.smooth[i * 4 + c] = base.smooth[i * 4 + c];
        this.other[i * 4 + c] = base.other[i * 4 + c];
        if (this.flat) this.flat[i * 4 + c] = base.flat![i * 4 + c];
      }
      this.elevation[i] = base.elevation[i];
      this.coast[i] = base.coast[i];
      if (this.frag) this.frag[i] = base.frag ? base.frag[i] : 0;
      if (this.group) {
        this.group[2 * i] = base.group![2 * i];
        this.group[2 * i + 1] = base.group![2 * i + 1];
      }
      if (this.style) {
        this.style[2 * i] = base.style![2 * i];
        this.style[2 * i + 1] = base.style![2 * i + 1];
      }
    }
    this.written = [];
    this.fjord = base.fjord ?? null;
    if (patch) this.write(world, patch);
    const cells = Int32Array.from(this.written).sort();
    return { smooth: this.smooth, other: this.other, elevation: this.elevation, coast: this.coast, frag: this.frag, flat: this.flat, group: this.group, style: this.style, fjord: this.fjord, cells, coastAmp };
  }

  // 按将来的陆海的峡湾：谷网里的点所在的格的陆海与底子相同时就是底子的那一份，与上一次相同时是上一次的
  private fjordFor(net: FjordNet, land: Uint8Array, now: Uint8Array, n: number): Float32Array | null {
    const w = net.watch;
    const base = this.base.fjord ?? null;
    let same = true;
    for (let k = 0; k < w.length && same; k++) if (land[w[k]] !== now[w[k]]) same = false;
    if (same) return base;
    if (this.fjLand && this.fjOut) {
      let again = true;
      for (let k = 0; k < w.length && again; k++) if (land[w[k]] !== this.fjLand[k]) again = false;
      if (again) return this.fjOut;
    }
    const fl = this.fjLand ?? (this.fjLand = new Uint8Array(w.length));
    for (let k = 0; k < w.length; k++) fl[k] = land[w[k]];
    this.fjOut = fjordLayer(net, land, n).tex;
    return this.fjOut;
  }

  private touch(i: number) {
    if (this.mark[i]) return;
    this.mark[i] = 1;
    this.written.push(i);
  }

  private write(world: World, p: GhostPatch) {
    const { mesh } = world;
    const { base, smooth, coast, elevation } = this;
    // 变成陆地、变成海、新成湖的格
    const toLand: number[] = [];
    const toSea: number[] = [];
    const toLake: number[] = [];
    const flipped = new Uint8Array(mesh.n);
    for (let k = 0; k < p.cells.length; k++) {
      const i = p.cells[k];
      const lake = p.lake?.[k] === 1;
      const c = Math.fround(lake ? lakeCoast(p.coast[k]) : p.coast[k]);
      if (!Object.is(c, base.coast[i])) {
        coast[i] = c;
        this.touch(i);
      }
      // 湖变成了海：照海的样子画（海岸值本来就是负的）
      const lakeToSea = !p.land[k] && isLake(world, i);
      if (base.coast[i] <= 0 === c <= 0 && !lakeToSea) continue;
      flipped[i] = 1;
      (c > 0 ? toLand : lake ? toLake : toSea).push(i);
    }
    const terrainLike = terrainLikeMode(this.mode);
    const depthColors = terrainLike || this.mode === 'elevation' || this.mode === 'uplift';
    const put = (i: number, rgb: RGB, a: number) => {
      smooth.set([Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), a], i * 4);
      this.touch(i);
    };
    // 颜色：同类邻格（不是刚变过来的）的平均，往里最多推三层；推不到的用这种底图的默认色
    const fill = (list: number[], same: (j: number) => boolean, fallback: (i: number) => [RGB, number]) => {
      const known = new Uint8Array(mesh.n);
      let left = list;
      for (let pass = 0; pass < 3 && left.length; pass++) {
        const got: [number, number[]][] = [];
        const rest: number[] = [];
        for (const i of left) {
          const sum = [0, 0, 0, 0];
          let k = 0;
          for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
            const j = mesh.adj[e];
            if (!same(j) || (flipped[j] && !known[j])) continue;
            for (let c = 0; c < 4; c++) sum[c] += smooth[j * 4 + c];
            k++;
          }
          if (k) got.push([i, sum.map((v) => v / k)]);
          else rest.push(i);
        }
        for (const [i, s] of got) {
          put(i, [s[0], s[1], s[2]], Math.round(s[3]));
          known[i] = 1;
        }
        left = rest;
      }
      for (const i of left) put(i, ...fallback(i));
    };
    fill(
      toLand,
      (j) => coast[j] > 0,
      () => [depthColors ? ramp(HYPSO, 40) : [128, 128, 128], 128],
    );
    fill(
      toSea,
      (j) => coast[j] <= 0 && !(world.causes.land[j] === 1 && flipped[j] === 0),
      (i) => [depthColors ? ramp(SEA, -40) : [40, 50, 70], warmth(world, i)],
    );
    for (const i of toLake) put(i, depthColors ? ramp(SEA, -60) : [70, 125, 175], warmth(world, i));
    // 高程：新陆地至少 40 m、新海至少 40 m 深、新湖 30 m 深（海岸细节的幅度跟着高程）
    for (const i of toLand) elevation[i] = Math.max(base.elevation[i], 40);
    for (const i of toSea) elevation[i] = Math.min(base.elevation[i], -40);
    for (const i of toLake) elevation[i] = -30;
    // 平涂不画在变过的格上（湖还在原来的省里）；分组（省界）取同类邻省的，没有就不算哪个省
    for (const i of [...toLand, ...toSea, ...toLake]) if (this.flat) this.flat[i * 4 + 3] = 0;
    for (const i of [...toLand, ...toSea]) {
      if (!this.group) break;
      const land = coast[i] > 0;
      let g = 0;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && !g; e++) {
        const v = base.group![2 * mesh.adj[e]];
        if (!flipped[mesh.adj[e]] && v !== 0 && v > 0 === land) g = v;
      }
      this.group[2 * i] = g;
      this.group[2 * i + 1] = 0;
    }
    // 破碎度（第十八轮）：换上将来的值
    const fragged: number[] = [];
    if (p.frag) {
      const frag = (this.frag ??= new Float32Array(coast.length));
      for (let k = 0; k < p.frag.cells.length; k++) {
        const i = p.frag.cells[k];
        if (frag[i] === p.frag.value[k]) continue;
        frag[i] = p.frag.value[k];
        fragged.push(i);
        this.touch(i);
      }
    }
    // 对岸的颜色：变过的格与它们的邻格重新取（与 cellLayers 同一个规则，用将来的海岸值分陆海）
    const redo = new Set<number>();
    for (const list of [toLand, toSea, toLake, fragged]) {
      for (const i of list) {
        redo.add(i);
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) redo.add(mesh.adj[e]);
      }
    }
    const frag = this.frag;
    const alt = frag ? { frag, rgba: fragColors(world, this.mode, 'annual', smooth, coast, frag, redo) } : null;
    for (const i of redo) fillOther(mesh, smooth, coast, this.other, i, alt);
    for (const i of redo) this.touch(i);
    // 海岸类型（第三十四轮）：将来是湖面的格不画沙坝、岛礁；峡湾（第三十六轮）按将来的陆海重算淹到哪里（core/fjords.ts）
    const cs = this.style ? coastStyle(world) : null;
    if (cs && this.style) {
      const land = world.causes.land.slice();
      for (let k = 0; k < p.cells.length; k++) {
        const i = p.cells[k];
        land[i] = p.land[k];
        const a = p.land[k] && p.lake?.[k] === 1 ? 0 : cs.packed[2 * i + 1];
        if (cs.packed[2 * i] === this.style[2 * i] && a === this.style[2 * i + 1]) continue;
        this.style[2 * i] = cs.packed[2 * i];
        this.style[2 * i + 1] = a;
        this.touch(i);
      }
      if (cs.net) this.fjord = this.fjordFor(cs.net, land, world.causes.land, world.mesh.n);
    }
  }
}

// 一格对岸的颜色：陆地格取相邻水面格的平均色，水面格取相邻陆地格的平均色（含 alpha）；没有对岸就是自己的。
// alt（第十八轮）：破碎的格（frag > 0）没有对岸时用 alt.rgba（碎岛、裂缝的颜色，见 fragColors）
type FragAlt = { frag: Float32Array; rgba: Uint8Array } | null;
export function fillOther(mesh: World['mesh'], smooth: Uint8Array, coast: Float32Array, out: Uint8Array, i: number, alt: FragAlt = null) {
  const wet = coast[i] <= 0;
  let k = 0;
  const sum = [0, 0, 0, 0];
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const j = mesh.adj[e];
    if (coast[j] <= 0 === wet) continue;
    for (let c = 0; c < 4; c++) sum[c] += smooth[j * 4 + c];
    k++;
  }
  const own = !k && alt && alt.frag[i] > 0 ? alt.rgba : smooth;
  for (let c = 0; c < 4; c++) out[i * 4 + c] = k ? Math.round(sum[c] / k) : own[i * 4 + c];
}

// 一次性的幽灵图层（测试、不必持久时用）
export function ghostLayers(world: World, base: CellLayers, patch: GhostPatch, mode: ViewMode, coastAmp?: number): GhostLayers {
  return new GhostBuffer(base, mode).apply(world, patch, coastAmp);
}
