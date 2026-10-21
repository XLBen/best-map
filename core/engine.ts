import { type ClimateBase, computeClimate, finalizeClimate } from './climate';
import { type Command, CommandError, Dirty, type UndoRecord, applyCommand, revert } from './commands';
import { checkConstraints, type SolveResult, solveConstraints } from './constraints';
import { computeClimateSphere } from './planet-climate';
import { computeElevation } from './elevation';
import { assignNames, detectFeatures, regionFeatures } from './features';
import { computeHydrology } from './hydrology';
import type { Mesh } from './mesh';
import { computeVegetation, isVegetated } from './vegetation';
import { resolveTerrain } from './terrain';
import { type Causes, type Derived, type Settings, type World, createWorld, emptyDerived, settingsSchema } from './world';

// 引擎：持有世界、命令历史与推导缓存。命令改原因 → 标记从哪层开始重算 → 流水线
//   高程 → 气候（基础）→ [约束求解 → 修正场] → 水文 → 植被 → 冲突检查

export interface WorldDoc {
  format: 'map2-world';
  // 2：一块地区；3：整个星球（旧版程序打不开，不会把星球当成平面重放）
  version: 2 | 3;
  settings: Settings;
  commands: Command[];
}

export interface Timings {
  elevation?: number;
  climate?: number;
  solve?: number;
  hydrology?: number;
  vegetation?: number;
  features?: number;
  total: number;
}

export class Engine {
  world: World;
  private base: ClimateBase | null = null;
  private solve: SolveResult = { plans: [] };
  private dirty: Dirty = Dirty.Elevation;
  // 每一步记下它影响到哪一层：撤销时只需从这一层重算
  private done: { cmd: Command; undo: UndoRecord; summary: string; dirty: Dirty }[] = [];
  private undone: { cmd: Command; summary: string }[] = [];
  // 上次取走以来实际重算到的最深一层（Worker 据此决定只发名字、省份，还是整个世界）
  private recomputed: Dirty = Dirty.None;
  lastTimings: Timings = { total: 0 };

  constructor(settings: Partial<Settings> = {}, mesh?: Mesh) {
    this.world = createWorld(settings, mesh);
    resolveTerrain(this.world);
  }

  get history(): { summary: string; done: boolean }[] {
    return [...this.done.map((h) => ({ summary: h.summary, done: true })), ...[...this.undone].reverse().map((h) => ({ summary: h.summary, done: false }))];
  }
  get canUndo() {
    return this.done.length > 0;
  }
  get canRedo() {
    return this.undone.length > 0;
  }

  // 执行命令；推导立即更新
  exec(cmd: Command): string {
    const summary = this.applyOnly(cmd);
    this.undone = [];
    this.update();
    return summary;
  }

  private applyOnly(cmd: Command): string {
    const r = applyCommand(this.world, cmd, { ensureDerived: () => this.update() });
    const dirty = Math.max(r.dirty, this.speciesChanged() ? Dirty.Solve : Dirty.None) as Dirty;
    this.done.push({ cmd, undo: r.undo, summary: r.summary, dirty });
    this.dirty = Math.max(this.dirty, dirty) as Dirty;
    return r.summary;
  }

  // 生态的种数变了：份额、适宜度数组要重新分配，至少从求解重算
  private speciesChanged() {
    return this.world.derived.share.length !== this.world.mesh.n * this.world.small.species.length;
  }

  // 撤掉一步：原因退回去，推导从这一步影响到的那一层重算。推导只取决于原因，所以结果与从头重算逐值一致
  private revertLast(): { cmd: Command; summary: string } | null {
    const h = this.done.pop();
    if (!h) return null;
    revert(this.world, h.undo);
    this.dirty = Math.max(this.dirty, h.dirty, this.speciesChanged() ? Dirty.Solve : Dirty.None) as Dirty;
    return h;
  }

  undo(): boolean {
    const h = this.revertLast();
    if (!h) return false;
    this.undone.push({ cmd: h.cmd, summary: h.summary });
    this.update();
    return true;
  }

  redo(): boolean {
    const h = this.undone.pop();
    if (!h) return false;
    this.applyOnly(h.cmd);
    this.update();
    return true;
  }

  // 换一个：撤掉最后一步，执行新命令（“换个形状”用）。只重算一次，历史里只留新的一步
  replaceLast(cmd: Command): string {
    const h = this.revertLast();
    if (!h) throw new CommandError('没有可以替换的一步');
    let summary: string;
    try {
      summary = this.applyOnly(cmd);
    } catch (e) {
      // 新命令做不了：把原来那一步放回去
      this.applyOnly(h.cmd);
      this.update();
      throw e;
    }
    this.undone = [];
    this.update();
    return summary;
  }

  // 上次取走以来实际重算到的最深一层，取走后清零
  takeRecomputed(): Dirty {
    const r = this.recomputed;
    this.recomputed = Dirty.None;
    return r;
  }

  update(): Derived {
    if (this.dirty === Dirty.None) return this.world.derived;
    this.recomputed = Math.max(this.recomputed, this.dirty) as Dirty;
    const w = this.world;
    const d = w.derived;
    if (this.dirty === Dirty.Names) {
      // 只改了名字或用户的区块：自动识别的地物不变，换上新的区块再重新起名
      d.features = [...d.features.filter((f) => !f.region), ...regionFeatures(w, d)];
      assignNames(w, d.features);
      this.dirty = Dirty.None;
      return d;
    }
    const t0 = performance.now();
    const timings: Timings = { total: 0 };
    let t = t0;
    const lap = (k: keyof Timings) => {
      const now = performance.now();
      timings[k] = now - t;
      t = now;
    };
    if (this.dirty >= Dirty.Elevation) {
      // 总是从固定初值求解：推导只取决于原因，与编辑历史无关，重放与撤销都逐值一致
      const r = computeElevation(w);
      d.elevation.set(r.elevation);
      lap('elevation');
    }
    if (this.dirty >= Dirty.Climate || !this.base) {
      // 整个星球用球面版本（没有地图边，风带绕星球一圈）
      this.base = w.mesh.kind === 'sphere' ? computeClimateSphere(w, d.elevation, d) : computeClimate(w, d.elevation, d);
      lap('climate');
    }
    if (d.share.length !== w.mesh.n * w.small.species.length) {
      const fresh = emptyDerived(w.mesh.n, w.small.species.length);
      d.share = fresh.share;
      d.suit = fresh.suit;
      d.reach = fresh.reach;
    }
    // 先在无修正的气候上算一遍水文与植被，得到求解器需要的湿度、可达性
    d.corrT.fill(0);
    d.corrP.fill(0);
    for (const k of Object.keys(d.corrF)) delete d.corrF[k];
    finalizeClimate(w, this.base, d);
    computeHydrology(w, d.elevation, d);
    computeVegetation(w, d);
    lap('hydrology');
    this.solve = { plans: [] };
    if (w.small.constraints.some((c) => c.mode === 'constraint')) {
      // 水文随修正场变化会影响湿地等类型，最多再迭代一轮
      for (let round = 0; round < 2; round++) {
        this.solve = solveConstraints(w, this.base, d);
        finalizeClimate(w, this.base, d);
        computeHydrology(w, d.elevation, d);
        computeVegetation(w, d);
        const failing = this.solve.plans.some((p) => p.anchors.some((k) => d.dominant[p.cells[k]] !== p.target));
        if (!failing) break;
      }
      lap('solve');
    }
    d.conflicts = checkConstraints(w, d, this.solve);
    lap('vegetation');
    d.features = detectFeatures(w, d);
    lap('features');
    timings.total = performance.now() - t0;
    this.lastTimings = timings;
    this.dirty = Dirty.None;
    return d;
  }

  toDoc(): WorldDoc {
    return { format: 'map2-world', version: this.world.settings.globe ? 3 : 2, settings: this.world.settings, commands: this.done.map((h) => h.cmd) };
  }

  static fromDoc(doc: WorldDoc, mesh?: Mesh): Engine {
    if (doc.format !== 'map2-world') throw new CommandError('不是 map2 世界文件');
    if (doc.version !== 2 && doc.version !== 3) throw new CommandError('这是旧版本的世界文件，与当前版本的地形模型不兼容');
    const settings = settingsSchema.parse(doc.settings);
    const engine = new Engine(settings, mesh);
    doc.commands.forEach((cmd, k) => {
      try {
        engine.applyOnly(cmd);
      } catch (e) {
        throw new CommandError(`第 ${k + 1} 条命令失败：${(e as Error).message}`);
      }
    });
    engine.update();
    return engine;
  }

  // 预览：在世界的副本上执行命令，返回与当前结果的差异，不改变当前状态
  preview(cmd: Command): PreviewResult {
    const current = this.world;
    this.update();
    const copy = new Engine(current.settings, current.mesh);
    copy.world = cloneWorld(current);
    copy.base = this.base;
    copy.dirty = Dirty.None;
    copy.applyOnly(cmd);
    copy.update();
    return diffWorlds(current, copy.world);
  }
}

export interface PreviewResult {
  // 主导类型改变的格
  changedCells: number[];
  // 新出现 / 消失的河流格
  riverAdded: number[];
  riverRemoved: number[];
  maxCorrT: number;
  maxCorrP: number;
  conflicts: number;
  // 预览后各约束的满足比例
  satisfied: { id: string; satisfied: number; required: number }[];
}

function diffWorlds(a: World, b: World): PreviewResult {
  const n = a.mesh.n;
  const thr = a.small.planet.riverThreshold;
  const changedCells: number[] = [];
  const riverAdded: number[] = [];
  const riverRemoved: number[] = [];
  let maxCorrT = 0;
  let maxCorrP = 0;
  for (let i = 0; i < n; i++) {
    const da = a.derived.dominant[i];
    const db = b.derived.dominant[i];
    const ida = da >= 0 ? a.small.species[da]?.id : da;
    const idb = db >= 0 ? b.small.species[db]?.id : db;
    if (ida !== idb) changedCells.push(i);
    // 与屏幕上画出来的河一致：陆地、不是湖、流量不低于门槛
    const ra = a.causes.land[i] === 1 && a.derived.lake[i] !== 1 && a.derived.discharge[i] >= thr;
    const rb = b.causes.land[i] === 1 && b.derived.lake[i] !== 1 && b.derived.discharge[i] >= thr;
    if (rb && !ra) riverAdded.push(i);
    if (ra && !rb) riverRemoved.push(i);
    maxCorrT = Math.max(maxCorrT, Math.abs(b.derived.corrT[i]));
    maxCorrP = Math.max(maxCorrP, Math.abs(b.derived.corrP[i]));
  }
  const S = b.small.species.length;
  const satisfied = b.small.constraints.map((c) => {
    const t = b.small.species.findIndex((s) => s.id === c.species);
    const valid = c.cells.filter((i) => isVegetated(b, b.derived, i));
    const ok = valid.filter((i) => b.derived.dominant[i] === t).length;
    void S;
    return { id: c.id, satisfied: valid.length ? ok / valid.length : 0, required: c.ratio };
  });
  return { changedCells, riverAdded, riverRemoved, maxCorrT, maxCorrP, conflicts: b.derived.conflicts.length, satisfied };
}

function cloneCauses(c: Causes, fields: Record<string, Float32Array>): Causes {
  const out = {} as Causes;
  for (const [k, v] of Object.entries(c)) (out as unknown as Record<string, unknown>)[k] = ArrayBuffer.isView(v) ? (v as Float32Array).slice() : v;
  out.fields = fields;
  return out;
}

export function cloneWorld(w: World): World {
  const c = w.causes;
  const d = w.derived;
  const fields: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(c.fields)) fields[k] = v.slice();
  const corrF: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(d.corrF)) corrF[k] = v.slice();
  const derived = {} as Derived;
  for (const [k, v] of Object.entries(d)) {
    (derived as unknown as Record<string, unknown>)[k] = ArrayBuffer.isView(v) ? (v as Float32Array).slice() : v;
  }
  derived.corrF = corrF;
  derived.conflicts = structuredClone(d.conflicts);
  return {
    settings: w.settings,
    mesh: w.mesh,
    kmPerUnit: w.kmPerUnit,
    causes: cloneCauses(c, fields),
    small: structuredClone(w.small),
    derived,
  };
}
