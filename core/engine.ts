import { type ClimateBase, type ClimateEffects, computeClimate, finalizeClimate } from './climate';
import { type Command, CommandError, Dirty, type UndoRecord, applyCommand, revert } from './commands';
import { checkConstraints, type SolveResult, solveConstraints } from './constraints';
import { computeClimateSphere } from './planet-climate';
import { carveBeds, computeElevation } from './elevation';
import { assignNames, detectFeatures, guideFeatures, regionFeatures } from './features';
import { computeEffects } from './effects';
import { computeHydrology } from './hydrology';
import type { Mesh } from './mesh';
import { type PreviewPatch, previewPatch } from './preview-world';
import { typeRivers } from './river-types';
import { scriptsEnabled } from './script';
import { worldSeedOf } from './biome-scripts';
import { SPECIES_EXTENSION_KEYS } from './species';
import { computeVegetation, isVegetated } from './vegetation';
import { resolveTerrain, shareTerrainBase } from './terrain';
import { type Causes, type Derived, GUIDE_EXTENSIONS, type Settings, type SmallState, type World, createWorld, emptyDerived, kmPerUnit, settingsSchema } from './world';

// 引擎：持有世界、命令历史与推导缓存。命令改原因 → 标记从哪层开始重算 → 流水线
//   高程 → 气候（基础）→ [约束求解 → 修正场] → 水文 → 植被 → 冲突检查

export interface WorldDoc {
  format: 'map2-world';
  // 2：一块地区；3：整个星球（旧版程序打不开，不会把星球当成平面重放）；
  // 4：用了第八轮起新加的字段、命令（旧版程序会悄悄丢掉不认识的字段、按错的样子重放，所以要让它拒绝打开）。见 docVersion
  version: 2 | 3 | 4;
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

// 气候的基础（没有修正场时的两季温度、降水），加上地形：自然求解的高程（含湖的碗，不含只挖河床的河）。
// 气候、山名都按它算，所以画河、改河不会改变气候和山名，也不用重算高程与气候。
// 旧版存的检查点里没有 terrain：下次重算时从高程算起
export interface EngineBase extends ClimateBase {
  terrain?: Float32Array;
}

// 一份完整的推导结果：撤销、重做时直接换回，不必重算
interface DerivedState {
  derived: Derived;
  base: EngineBase | null;
  solve: SolveResult;
  timings: Timings;
}

interface DoneStep {
  // 编号（自动保存据此只写变了的那些步）
  id: number;
  cmd: Command;
  undo: UndoRecord;
  summary: string;
  dirty: Dirty;
  // 这一步之前的推导结果（撤销时换回）
  state?: DerivedState;
}

// 检查点：引擎的完整状态（原因、推导、历史）。存进浏览器后，打开时直接恢复，不必重放所有命令
export interface Checkpoint {
  settings: Settings;
  causes: Causes;
  small: SmallState;
  derived: Derived;
  base: EngineBase | null;
  solve: SolveResult;
  done: Omit<DoneStep, 'state'>[];
  timings: Timings;
}

interface UndoneStep {
  cmd: Command;
  summary: string;
  // 这一步之后的推导结果（重做时换回）
  state?: DerivedState;
}

// 统计（测试用）：一共算了多少遍“气候 → 水文 → 河的类型 → 植被”
export const passStats = { passes: 0 };

// 状态编号：引擎的状态每变一次（新建、打开、执行、撤销、重做、换一个）就换一个新的，同一个 Worker 里不重复。
// 快照、预览都带着它：主线程只显示按当前世界的状态算出来的预览，过期的丢掉
let states = 0;

export class Engine {
  world: World;
  stateId = ++states;
  private base: EngineBase | null = null;
  private solve: SolveResult = { plans: [] };
  private dirty: Dirty = Dirty.Elevation;
  // 每一步记下它影响到哪一层：撤销时只需从这一层重算
  private done: DoneStep[] = [];
  private undone: UndoneStep[] = [];
  // 存着推导结果的步（先存的在前）；最多 undoCache 份，每份是整个世界的推导数组（4 万格约 11 MB，10 万格约 27 MB）
  private kept: (DoneStep | UndoneStep)[] = [];
  undoCache: number;
  private seq = 0;
  // 上次取走以来实际重算到的最深一层（Worker 据此决定只发名字、省份，还是整个世界）
  private recomputed: Dirty = Dirty.None;
  // 最近一次 exec 什么都没改（比如在陆地上画陆地）：不重算、不进历史
  lastNoop = false;
  // 识别地物（起名）。向导的缩略图用不着，关掉省时间
  features = true;
  // 最近一次确切预览算好的副本：紧接着执行同一条命令时直接采用，不再重算（画河改道松手时）。
  // changed：预览的命令有没有改动什么（什么都没改的命令不能借采用预览进历史）
  private lastPreview: { key: string; copy: Engine; changed: boolean } | null = null;
  lastTimings: Timings = { total: 0 };

  constructor(settings: Partial<Settings> = {}, mesh?: Mesh) {
    this.world = createWorld(settings, mesh);
    resolveTerrain(this.world);
    this.undoCache = this.world.mesh.n > 60000 ? 2 : 3;
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

  // 执行命令；推导立即更新。命令什么都没改时不重算、不进历史（lastNoop）。
  // 整步要么生效要么不生效：命令本身做不了（applyCommand 已经复原了原因）、或者之后的重算出错，
  // 都回到执行前的样子（原因、推导、历史、重做记录、状态编号都与执行前相同）再把错误抛出去
  exec(cmd: Command): string {
    const adopted = this.adoptPreview(cmd);
    if (adopted !== null) {
      this.stateId = ++states;
      return adopted;
    }
    const fresh = this.dirty === Dirty.None;
    const { summary } = this.applyOnly(cmd, true);
    if (this.lastNoop) return summary;
    const stateBefore = this.stateId;
    this.stateId = ++states;
    // 重做记录照旧先清掉（之后存撤销缓存时不必和它们抢位置），出错时把这份列表放回去（存着的推导不要了，重做时重算）
    const undone = this.undone;
    this.dropUndone();
    this.keepBefore(fresh);
    try {
      this.update();
    } catch (e) {
      // 撤掉时的重算按说不会再出错；万一出了，历史、重做记录、状态编号也照样放回去
      try {
        this.rollbackLast();
      } finally {
        this.undone = undone;
        this.stateId = stateBefore;
      }
      throw e;
    }
    return summary;
  }

  // 刚执行的最后一步在重算时出错：撤掉它（原因退回去），推导换回这一步之前的。
  // 存着这一步之前的推导（keepBefore 复制的那份，没有被改过）就直接换上；否则从头重算——执行前的原因算过一次没出错，
  // 引擎是确定的，所以这次也不会出错
  private rollbackLast() {
    const h = this.done.pop()!;
    revert(this.world, h.undo);
    const before = h.state;
    h.state = undefined;
    this.kept = this.kept.filter((k) => k !== h && k.state);
    if (before) this.install(before);
    else {
      this.dirty = Dirty.Elevation;
      this.update();
    }
  }

  // skipNoop：什么都没改的命令不记进历史（重放存档时照旧记，历史与文件一一对应）。
  // changed：命令有没有改动原因或小数据
  private applyOnly(cmd: Command, skipNoop = false): { summary: string; changed: boolean } {
    const r = applyCommand(this.world, cmd, { ensureDerived: () => this.update() });
    this.lastNoop = skipNoop && !r.changed;
    if (this.lastNoop) return { summary: r.summary, changed: false };
    const dirty = Math.max(r.dirty, this.speciesChanged() ? Dirty.Solve : Dirty.None) as Dirty;
    // 新起的省名记进命令（存档、重做时照用）。
    // 安全模式（脚本不运行）下推导与正常时不同，这一步新起的省可能少几个：命令里已经记着的名字一个不丢，
    // 不然用安全模式打开一次、自动保存之后，再正常打开时那几个省就换了名字（命令照旧保留）
    const names = r.provinceNames && cmd.provinceNames && !scriptsEnabled() ? { ...cmd.provinceNames, ...r.provinceNames } : r.provinceNames;
    const recorded = names ? { ...cmd, provinceNames: names } : cmd;
    this.done.push({ id: ++this.seq, cmd: recorded, undo: r.undo, summary: r.summary, dirty });
    this.dirty = Math.max(this.dirty, dirty) as Dirty;
    return { summary: r.summary, changed: r.changed };
  }

  // ---------- 撤销缓存：最近几步的推导结果 ----------

  // 当前的推导结果（不复制：换下来的对象不再被改动）
  private current(): DerivedState {
    return { derived: this.world.derived, base: this.base, solve: this.solve, timings: this.lastTimings };
  }

  private install(s: DerivedState) {
    this.world.derived = s.derived;
    this.base = s.base;
    this.solve = s.solve;
    this.lastTimings = s.timings;
    this.dirty = Dirty.None;
  }

  private keep(step: DoneStep | UndoneStep, s: DerivedState) {
    step.state = s;
    this.kept = this.kept.filter((k) => k.state && k !== step);
    this.kept.push(step);
    while (this.kept.length > this.undoCache) this.kept.shift()!.state = undefined;
  }

  // 刚执行的一步：推导还是执行前的（update 还没跑），复制一份留给撤销。只给要重算推导的步留
  private keepBefore(fresh: boolean) {
    const h = this.done[this.done.length - 1];
    if (fresh && h.dirty > Dirty.Names && this.undoCache > 0) this.keep(h, { ...this.current(), derived: copyDerived(this.world.derived) });
  }

  private dropUndone() {
    for (const h of this.undone) h.state = undefined;
    this.undone = [];
  }

  // 生态的种数变了：份额、适宜度数组要重新分配，至少从求解重算
  private speciesChanged() {
    return this.world.derived.share.length !== this.world.mesh.n * this.world.small.species.length;
  }

  // 撤掉一步：原因退回去，推导从这一步影响到的那一层重算。推导只取决于原因，所以结果与从头重算逐值一致
  private revertLast(): DoneStep | null {
    const h = this.done.pop();
    if (!h) return null;
    revert(this.world, h.undo);
    this.dirty = Math.max(this.dirty, h.dirty, this.speciesChanged() ? Dirty.Solve : Dirty.None) as Dirty;
    return h;
  }

  // 撤销：原因退回去；存着这一步之前的推导时直接换回（与重算逐值一致：推导只取决于原因），否则重算
  undo(): boolean {
    this.lastPreview = null;
    const fresh = this.dirty === Dirty.None;
    const h = this.revertLast();
    if (!h) return false;
    const stateBefore = this.stateId;
    this.stateId = ++states;
    const step: UndoneStep = { cmd: h.cmd, summary: h.summary };
    const before = h.state;
    h.state = undefined;
    if (fresh && before) {
      const after = this.current();
      this.install(before);
      this.keep(step, after);
      this.recomputed = Math.max(this.recomputed, h.dirty) as Dirty;
    }
    this.undone.push(step);
    try {
      this.update();
    } catch (e) {
      // 重算出错：这一步放回去（照原来的编号），推导从头重算（撤销之前的原因算过一次没出错）
      this.undone.pop();
      this.kept = this.kept.filter((k) => k !== step && k.state);
      this.applyOnly(h.cmd);
      this.done[this.done.length - 1].id = h.id;
      this.dirty = Dirty.Elevation;
      this.update();
      this.stateId = stateBefore;
      throw e;
    }
    return true;
  }

  // 重做：命令重新作用于原因（推导此时与原来执行前相同，生成的名字也相同）；存着这一步之后的推导时直接换回。
  // 出错时（命令做不了、重算出错）回到重做之前的样子，这一步留在重做记录里
  redo(): boolean {
    this.lastPreview = null;
    const fresh = this.dirty === Dirty.None;
    const h = this.undone.pop();
    if (!h) return false;
    const stateBefore = this.stateId;
    this.stateId = ++states;
    const after = h.state;
    h.state = undefined;
    const putBack = () => {
      this.undone.push(h);
      this.stateId = stateBefore;
    };
    try {
      this.applyOnly(h.cmd);
    } catch (e) {
      h.state = after;
      putBack();
      throw e;
    }
    const step = this.done[this.done.length - 1];
    if (fresh && after && step.dirty > Dirty.Names) {
      const before = this.current();
      this.install(after);
      this.keep(step, before);
      this.recomputed = Math.max(this.recomputed, step.dirty) as Dirty;
    } else this.keepBefore(fresh);
    try {
      this.update();
    } catch (e) {
      try {
        this.rollbackLast();
      } finally {
        putBack();
      }
      throw e;
    }
    return true;
  }

  // 换一个：撤掉最后一步，执行新命令（“换个形状”用）。只重算一次，历史里只留新的一步。
  // 撤掉的那一步之前的推导，就是新的一步之前的推导：留给新的一步撤销用。
  // 新命令做不了、或者重算出错：原来那一步放回去，世界、历史、重做记录都与换之前相同
  replaceLast(cmd: Command): string {
    this.lastPreview = null;
    const stateBefore = this.stateId;
    const h = this.revertLast();
    if (!h) throw new CommandError('没有可以替换的一步');
    const before = h.state;
    h.state = undefined;
    // 把原来那一步放回去（推导要重算：before 是它之前的推导，不能直接换上）
    const restore = () => {
      this.applyOnly(h.cmd);
      const back = this.done[this.done.length - 1];
      back.id = h.id;
      if (before) this.keep(back, before);
      this.update();
      this.stateId = stateBefore;
    };
    let summary: string;
    try {
      summary = this.applyOnly(cmd).summary;
    } catch (e) {
      restore();
      throw e;
    }
    this.stateId = ++states;
    const undone = this.undone;
    this.dropUndone();
    const step = this.done[this.done.length - 1];
    if (before && step.dirty > Dirty.Names) this.keep(step, before);
    try {
      this.update();
    } catch (e) {
      // 新的一步撤掉（推导写了一半，不能留着）：原因退回去，原来那一步放回去后从头重算
      this.done.pop();
      revert(this.world, step.undo);
      step.state = undefined;
      this.kept = this.kept.filter((k) => k !== step && k.state);
      this.dirty = Dirty.Elevation;
      restore();
      this.undone = undone;
      throw e;
    }
    return summary;
  }

  // 上次取走以来实际重算到的最深一层，取走后清零
  takeRecomputed(): Dirty {
    const r = this.recomputed;
    this.recomputed = Dirty.None;
    return r;
  }

  // 按标记重算推导。中途出错时推导写了一半：标记成从高程起全部重算（下一次一定整个重算，
  // 不会把写了一半的推导当成算好的），再把错误抛出去
  update(): Derived {
    if (this.dirty === Dirty.None) return this.world.derived;
    try {
      return this.recompute();
    } catch (e) {
      this.dirty = Dirty.Elevation;
      throw e;
    }
  }

  private recompute(): Derived {
    this.recomputed = Math.max(this.recomputed, this.dirty) as Dirty;
    const w = this.world;
    const d = w.derived;
    if (this.dirty === Dirty.Names) {
      // 只改了名字、用户的区块或画的河的折线：自动识别的地物不变，换上新的区块、画的河再重新起名。
      // （画的河有没有名字、占了哪些格变了的时候不走这里，所以哪些自然的河不单独标也不变。）
      // 地物对象可能和副本（Engine.clone、撤销缓存）共用，起名会改它们的名字，所以先各复制一份
      const terrain = this.base?.terrain;
      d.features = [...d.features.filter((f) => !f.region && !f.guide).map((f) => ({ ...f })), ...regionFeatures(w, d, terrain), ...guideFeatures(w, d, terrain)];
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
    let terrain = this.base?.terrain;
    let climate = this.dirty >= Dirty.Climate;
    if (this.dirty >= Dirty.Elevation || !terrain) {
      // 总是从固定初值求解：推导只取决于原因，与编辑历史无关，重放与撤销都逐值一致
      terrain = computeElevation(w).elevation;
      climate = true;
      lap('elevation');
    }
    if (climate || !this.base) {
      // 整个星球用球面版本（没有地图边，风带绕星球一圈）。按没挖河床的地形算：画河不改变气候
      const base = w.mesh.kind === 'sphere' ? computeClimateSphere(w, terrain, d) : computeClimate(w, terrain, d);
      this.base = { ...base, terrain };
      lap('climate');
    }
    // 推导里的高程 = 地形再挖出只挖河床的河。每次都从地形重新挖，结果只取决于原因；没有这种河时就是地形
    d.elevation.set(terrain);
    carveBeds(w, d.elevation);
    if (d.share.length !== w.mesh.n * w.small.species.length) {
      const fresh = emptyDerived(w.mesh.n, w.small.species.length);
      d.share = fresh.share;
      d.suit = fresh.suit;
      d.reach = fresh.reach;
    }
    // 一遍：气候（加上修正场、对周围的影响）→ 水文 → 河的类型 → 植被
    const base = this.base;
    const seed = worldSeedOf(w);
    const pass = (eff: ClimateEffects | null) => {
      passStats.passes++;
      finalizeClimate(w, base, d, eff);
      computeHydrology(w, d.elevation, d);
      // 河流类型（第三批）：没有时什么都不做；match 脚本出的问题交给植被一起记下
      computeVegetation(w, d, typeRivers(w, d, seed));
    };
    // 先在无修正的气候上算一遍水文与植被，得到求解器需要的湿度、可达性
    d.corrT.fill(0);
    d.corrP.fill(0);
    for (const k of Object.keys(d.corrF)) delete d.corrF[k];
    pass(null);
    lap('hydrology');
    // 生态、河对周围的影响（第三批）：按第一遍的结果算一次，之后的求解和最后一遍都在加了影响的气候上算
    // （没有这种影响时为 null，下面照原来的样子）
    const eff = computeEffects(w, d);
    this.solve = { plans: [] };
    if (w.small.constraints.some((c) => c.mode === 'constraint')) {
      // 水文随修正场变化会影响湿地等类型，最多再迭代一轮
      for (let round = 0; round < 2; round++) {
        this.solve = solveConstraints(w, base, d, eff);
        pass(eff);
        const failing = this.solve.plans.some((p) => p.anchors.some((k) => d.dominant[p.cells[k]] !== p.target));
        if (!failing) break;
      }
      lap('solve');
    } else if (eff) pass(eff);
    d.conflicts = checkConstraints(w, d, this.solve);
    lap('vegetation');
    // 山脉、山峰、盆地按没挖河床的地形认：峡谷不会让山改名
    if (this.features) d.features = detectFeatures(w, d, terrain);
    lap('features');
    timings.total = performance.now() - t0;
    this.lastTimings = timings;
    this.dirty = Dirty.None;
    return d;
  }

  toDoc(): WorldDoc {
    const commands = this.done.map((h) => h.cmd);
    return { format: 'map2-world', version: docVersion(this.world.settings, commands), settings: this.world.settings, commands };
  }

  stepIds(): number[] {
    return this.done.map((h) => h.id);
  }

  // 自动保存：savedIds 是已存的步的编号。返回与它相同的前缀之后的命令（撤销、换一个只改动最后几步）
  docTail(savedIds: number[]): DocTail {
    let from = 0;
    while (from < savedIds.length && from < this.done.length && savedIds[from] === this.done[from].id) from++;
    const { commands: _, ...head } = this.toDoc();
    return { ...head, from, commands: this.done.slice(from).map((h) => h.cmd), ids: this.done.map((h) => h.id) };
  }

  // 检查点（引用当前的数组，调用方要立即复制，比如存进 IndexedDB 时的结构化克隆）。重做的步不存：与重放一致
  toCheckpoint(): Checkpoint {
    this.update();
    const w = this.world;
    return { settings: w.settings, causes: w.causes, small: w.small, derived: w.derived, base: this.base, solve: this.solve, done: this.done.map(({ state: _, ...h }) => h), timings: this.lastTimings };
  }

  // 从检查点恢复，再对齐到存档的命令：共同的前缀之后，检查点多出来的步撤掉，存档多出来的命令执行。
  // 与从头重放逐值一致（撤销、执行都与重放逐值一致）。设置不同或没有共同的前缀时返回 null（改用重放）
  static fromCheckpoint(cp: Checkpoint, doc: WorldDoc, mesh: Mesh): Engine | null {
    const settings = settingsSchema.parse(doc.settings);
    if (JSON.stringify(settings) !== JSON.stringify(cp.settings)) return null;
    let p = 0;
    while (p < cp.done.length && p < doc.commands.length && JSON.stringify(cp.done[p].cmd) === JSON.stringify(doc.commands[p])) p++;
    if (p === 0) return null;
    // 不经过构造函数（它要为空白世界组合一遍地形）
    const e = Object.create(Engine.prototype) as Engine;
    e.world = { settings, mesh, kmPerUnit: kmPerUnit(settings), causes: cp.causes, small: cp.small, derived: cp.derived };
    e.base = cp.base;
    e.solve = cp.solve;
    e.dirty = Dirty.None;
    e.done = cp.done.map((h) => ({ ...h }));
    e.undone = [];
    e.kept = [];
    e.undoCache = mesh.n > 60000 ? 2 : 3;
    e.seq = Math.max(0, ...cp.done.map((h) => h.id));
    e.recomputed = Dirty.Elevation;
    e.lastNoop = false;
    e.lastPreview = null;
    e.features = true;
    e.lastTimings = cp.timings;
    e.stateId = ++states;
    while (e.done.length > p) e.revertLast();
    for (let k = p; k < doc.commands.length; k++) {
      try {
        e.applyOnly(doc.commands[k]);
      } catch (err) {
        throw new CommandError(`第 ${k + 1} 条命令失败：${(err as Error).message}`);
      }
    }
    e.update();
    return e;
  }

  static fromDoc(doc: WorldDoc, mesh?: Mesh): Engine {
    if (doc.format !== 'map2-world') throw new CommandError('不是 map2 世界文件');
    if (doc.version !== 2 && doc.version !== 3 && doc.version !== 4) throw new CommandError('这是旧版本的世界文件，与当前版本的地形模型不兼容');
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

  // 预览：在世界的副本上执行命令，返回与当前结果的差异，不改变当前状态。副本留到下一次改动，
  // 紧接着执行同一条命令时直接采用
  preview(cmd: Command): PreviewResult {
    this.update();
    // 先放掉上一份副本（星球上一份约 30 MB），再复制新的
    this.lastPreview = null;
    const t0 = performance.now();
    const copy = this.clone();
    const { changed } = copy.applyOnly(cmd);
    copy.update();
    this.lastPreview = { key: JSON.stringify(cmd), copy, changed };
    const step = copy.done[copy.done.length - 1];
    const ms = performance.now() - t0;
    return { ...diffWorlds(this.world, copy.world, cmd), ...landAndFailing(this.world, copy.world), summary: step?.summary ?? '', ms, stateId: this.stateId };
  }

  // 省份命令的轻预览：只复制省份数组与小数据，在临时的世界上执行（推导照用当前的：省份命令不重算推导，
  // 新省的名字按同样的推导起），返回执行后的省份数组、各省（含新起的名字）、切线与历史里会写的一句话。
  // 与执行逐值相同；活的世界、历史都不变。只接受省份命令（含只由省份命令组成的 batch），别的命令报错
  previewProvinces(cmd: Command): ProvincesPreview {
    if (!provinceOnly(cmd)) throw new CommandError('这一步不是省份的改动，不能用省份预览');
    const d = this.update();
    const w = this.world;
    const scratch: World = { ...w, causes: { ...w.causes, province: w.causes.province.slice() }, small: structuredClone(w.small) };
    const r = applyCommand(scratch, cmd, { ensureDerived: () => d });
    return { province: scratch.causes.province, provinces: scratch.small.provinces, seams: scratch.small.provinceSeams ?? null, summary: r.summary, changed: r.changed };
  }

  // 采用预览算好的结果：紧接着执行同一条命令时直接换上副本的原因、小数据与推导，不再重算（画河、
  // 涂生态、冷暖干湿、调整面板松手时）。原因数组抄进当前世界的数组里，世界对象不换（地形底图缓存按世界对象存，
  // 换成副本的那一份：重画一片时副本另建过）。返回这一步的说明；用不上时返回 null。
  // 预览的命令什么都没改时不采用：照常执行，按“没有变化”处理，不进历史
  private adoptPreview(cmd: Command): string | null {
    const p = this.lastPreview;
    this.lastPreview = null;
    if (!p || !p.changed || this.dirty !== Dirty.None || p.key !== JSON.stringify(cmd)) return null;
    const step = p.copy.done[p.copy.done.length - 1];
    if (!step) return null;
    const copy = p.copy.world;
    const live = this.world.causes as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(copy.causes)) {
      if (!ArrayBuffer.isView(v)) continue;
      // 当前世界没有这个数组（命令新建的）或长短不同：直接换上副本的（副本之后就丢了）
      const a = live[k] as Float32Array | undefined;
      if (a && a.length === (v as Float32Array).length) a.set(v as Float32Array);
      else live[k] = v;
    }
    this.world.causes.fields = copy.causes.fields;
    shareTerrainBase(copy, this.world);
    this.world.small = copy.small;
    this.done.push({ id: ++this.seq, cmd: step.cmd, undo: step.undo, summary: step.summary, dirty: step.dirty });
    this.dropUndone();
    // 换下来的推导不再被改动，直接留给撤销
    if (step.dirty > Dirty.Names && this.undoCache > 0) this.keep(this.done[this.done.length - 1], this.current());
    this.install({ derived: p.copy.world.derived, base: p.copy.base, solve: p.copy.solve, timings: p.copy.lastTimings });
    this.recomputed = Math.max(this.recomputed, step.dirty) as Dirty;
    this.lastNoop = false;
    return step.summary;
  }

  // 预览，并带上将来的世界与当前世界的差别（只带内容变了的数组，见 preview-world.ts）：地图据此画出将来的样子
  previewWorld(cmd: Command): { result: PreviewResult; patch: PreviewPatch } {
    const result = this.preview(cmd);
    return { result, patch: previewPatch(this.world, this.lastPreview!.copy.world) };
  }

  // 副本：原因、推导、小数据都复制，历史照旧（撤销记录里的数组只读，自定义场的旧数组会被放回世界，另外复制）。
  // 不经过构造函数（构造函数要为空白世界组合一遍地形）。生成器的结果与原世界共用：
  // 地形命令的预览不必重新采样整个生成器
  clone(): Engine {
    const e = Object.create(Engine.prototype) as Engine;
    e.world = cloneWorld(this.world);
    shareTerrainBase(this.world, e.world);
    e.base = this.base;
    e.solve = this.solve;
    e.dirty = this.dirty;
    e.seq = this.seq;
    e.done = this.done.map((h) => ({ id: h.id, cmd: h.cmd, summary: h.summary, dirty: h.dirty, undo: { ...h.undo, fields: h.undo.fields.map((f) => ({ name: f.name, old: f.old && f.old.slice() })) } }));
    e.undone = this.undone.map((h) => ({ cmd: h.cmd, summary: h.summary }));
    e.kept = [];
    e.undoCache = this.undoCache;
    e.recomputed = Dirty.None;
    e.lastNoop = false;
    e.lastPreview = null;
    e.features = this.features;
    e.lastTimings = this.lastTimings;
    e.stateId = this.stateId;
    return e;
  }
}

// 文档的版本：2 一块地区，3 整个星球；用了新加的字段、命令时是 4（新旧世界都是）。
// 只在真的用到时才写 4，所以没用新东西的世界照旧能被旧版程序打开
export function docVersion(settings: Pick<Settings, 'globe'>, commands: readonly Command[]): WorldDoc['version'] {
  if (commands.some(usesExtensions)) return 4;
  return settings.globe ? 3 : 2;
}

// 一条命令有没有用到旧版程序不认识的字段、命令（batch 里的逐条看）。后面加新字段、新命令时在这里加一项检测
function usesExtensions(cmd: Command): boolean {
  if (cmd.op === 'batch') return cmd.commands.some(usesExtensions);
  // 第八轮 1b：小礁、只淹一格的湖、带 fine 的岛链
  if (cmd.op === 'add_island' && cmd.island.kind === 'reef') return true;
  if (cmd.op === 'add_lake' && cmd.lake.exact) return true;
  if (cmd.op === 'add_island_chain' && cmd.chain.fine) return true;
  // 第八轮 1e：山挡风
  if (cmd.op === 'set_planet' && cmd.patch.terrainWind !== undefined) return true;
  // 第八轮 1f：剪刀切线（provinceSeams）
  if (cmd.op === 'cut_province') return true;
  // 第八轮 1d：类型自动判断的地区
  if (cmd.op === 'add_region' && cmd.region.auto) return true;
  if (cmd.op === 'update_region' && cmd.auto !== undefined) return true;
  // 第八轮第二批：画的河的新几项（自定义走向、名字、只挖河床、在终点消失……）、截走、改一条画的河
  if (cmd.op === 'update_guide') return true;
  if (cmd.op === 'add_guide' && (cmd.capture !== undefined || GUIDE_EXTENSIONS.some((k) => cmd.guide[k] !== undefined))) return true;
  // 第八轮第三批：生态的外观、效果、地名、脚本、种子（补丁里写成 null 去掉的也算：旧版程序不认识这一项）
  if (cmd.op === 'add_species' && SPECIES_EXTENSION_KEYS.some((k) => (cmd.species as Record<string, unknown>)[k] !== undefined)) return true;
  if (cmd.op === 'update_species' && SPECIES_EXTENSION_KEYS.some((k) => k in cmd.patch)) return true;
  // 第八轮第三批：星球形态
  if (cmd.op === 'set_worldgen' && cmd.params.form !== undefined) return true;
  // 第八轮第三批：河流类型
  if (cmd.op === 'set_river_type' || cmd.op === 'remove_river_type') return true;
  return false;
}

export interface DocTail extends Omit<WorldDoc, 'commands'> {
  // 从第 from 条起的命令；ids 是全部步的编号
  from: number;
  commands: Command[];
  ids: number[];
}

// 第八轮加的几项（在 diffWorlds 之外算）：执行后涂不成的格（与执行后的冲突一致）、变成陆地 / 变成海的格、
// 历史里会写的话、预览算了多久（毫秒，成本闸门用）、按哪个状态算的（主线程只显示与当前世界同一状态的预览）
export interface PreviewExtras {
  failing: number[];
  landGained: number[];
  landLost: number[];
  summary: string;
  ms: number;
  stateId: number;
}

// 陆海的变化与执行后没涂成的格
function landAndFailing(a: World, b: World): Pick<PreviewExtras, 'failing' | 'landGained' | 'landLost'> {
  const landGained: number[] = [];
  const landLost: number[] = [];
  const la = a.causes.land;
  const lb = b.causes.land;
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) (lb[i] ? landGained : landLost).push(i);
  return { failing: b.derived.conflicts.flatMap((c) => c.failing), landGained, landLost };
}

export interface PreviewResult extends PreviewExtras {
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
  // 新出现 / 消失的湖面格
  lakeAdded: number[];
  lakeRemoved: number[];
  // 挖低了至少 1 m 的格（画河挖出的峡谷），最深挖了多少米
  carved: { cells: number[]; maxDrop: number };
  // 画河、改河（add_guide / update_guide）：这条河执行后的样子。flow 是河道每格的流量（与 cells 对齐）；
  // name 是它的地名（还没名字时为 ''）；followed：陆地上每一格都流向河道的下一格（完全照着画的走）
  guide?: { id: string; flow: number[]; name: string; followed: boolean };
}

// 省份的轻预览（Engine.previewProvinces）：执行后的省份数组、各省、切线（没有切线时为 null）与历史里会写的一句话
export interface ProvincesPreview {
  province: Int32Array;
  provinces: SmallState['provinces'];
  seams: NonNullable<SmallState['provinceSeams']> | null;
  summary: string;
  // 命令有没有改动什么（什么都没改时执行也不进历史）
  changed: boolean;
}

// 省份预览能做的命令：只改省份数组与小数据里的省份、切线
const PROVINCE_OPS = new Set<Command['op']>(['assign_province', 'merge_province', 'split_province', 'regenerate_provinces', 'generate_provinces', 'set_province', 'cut_province']);
function provinceOnly(cmd: Command): boolean {
  return cmd.op === 'batch' ? cmd.commands.every(provinceOnly) : PROVINCE_OPS.has(cmd.op);
}

function diffWorlds(a: World, b: World, cmd: Command): Omit<PreviewResult, keyof PreviewExtras> {
  const n = a.mesh.n;
  const thr = a.small.planet.riverThreshold;
  const changedCells: number[] = [];
  const riverAdded: number[] = [];
  const riverRemoved: number[] = [];
  const lakeAdded: number[] = [];
  const lakeRemoved: number[] = [];
  const carved: PreviewResult['carved'] = { cells: [], maxDrop: 0 };
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
    const la = a.derived.lake[i] === 1;
    const lb = b.derived.lake[i] === 1;
    if (lb && !la) lakeAdded.push(i);
    if (la && !lb) lakeRemoved.push(i);
    const drop = a.derived.elevation[i] - b.derived.elevation[i];
    if (drop >= 1) {
      carved.cells.push(i);
      carved.maxDrop = Math.max(carved.maxDrop, drop);
    }
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
  const out: Omit<PreviewResult, keyof PreviewExtras> = { changedCells, riverAdded, riverRemoved, maxCorrT, maxCorrP, conflicts: b.derived.conflicts.length, satisfied, lakeAdded, lakeRemoved, carved };
  const id = cmd.op === 'update_guide' ? cmd.id : cmd.op === 'add_guide' ? (cmd.guide.id ?? b.small.guides[b.small.guides.length - 1]?.id) : undefined;
  const g = id !== undefined ? b.small.guides.find((x) => x.id === id) : undefined;
  if (g) {
    const land = b.causes.land;
    let followed = true;
    for (let k = 0; k + 1 < g.cells.length && land[g.cells[k]]; k++) if (b.derived.receiver[g.cells[k]] !== g.cells[k + 1]) followed = false;
    out.guide = {
      id: g.id,
      flow: g.cells.map((c) => b.derived.discharge[c]),
      name: b.derived.features.find((f) => f.guide === g.id)?.name ?? '',
      followed,
    };
  }
  return out;
}

// 复制时用展开（与原对象同形），逐个赋值会让对象退化成字典模式，之后每次读写都变慢
function cloneCauses(c: Causes, fields: Record<string, Float32Array>): Causes {
  const out = { ...c };
  for (const [k, v] of Object.entries(out)) if (ArrayBuffer.isView(v)) (out as unknown as Record<string, unknown>)[k] = (v as Float32Array).slice();
  out.fields = fields;
  return out;
}

// 推导的副本：数组都复制；地物、冲突列表照旧共用（之后的完整重算总是换上新的）
function copyDerived(d: Derived): Derived {
  const out = { ...d };
  for (const [k, v] of Object.entries(out)) if (ArrayBuffer.isView(v)) (out as unknown as Record<string, unknown>)[k] = (v as Float32Array).slice();
  const corrF: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(d.corrF)) corrF[k] = v.slice();
  out.corrF = corrF;
  return out;
}

export function cloneWorld(w: World): World {
  const c = w.causes;
  const fields: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(c.fields)) fields[k] = v.slice();
  const derived = copyDerived(w.derived);
  derived.conflicts = structuredClone(w.derived.conflicts);
  return {
    settings: w.settings,
    mesh: w.mesh,
    kmPerUnit: w.kmPerUnit,
    causes: cloneCauses(c, fields),
    small: structuredClone(w.small),
    derived,
  };
}
