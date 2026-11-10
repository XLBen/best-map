import { coastStyleCached, fjordData, landStyle } from './coast-style';
import { prepareClimatePlane } from './climate';
import { DOC_VERSION, checkDoc } from './doc-version';
import { type RegenBaseOf, regenBaseOf } from './regen-base';
import { type Command, CommandError, Dirty, type RemovedItem, addArrayUndo, applyCommand, revert } from './commands';
import { cloneSmall, copySmall, restoreSmall, type SmallCopy } from './small-copy';
import type { ContentRef } from './content/unused';
import { type TidyPlan, planTidy } from './tidy';
import { lakeProvinceFix } from './provinces';
import { type SolveResult } from './constraints';
import { warmClimateSphereSteps } from './planet-climate';
import { warmElevationSteps } from './elevation';
import { type GeoFeature, applyNameCarry, carryNames, detectFeatures, mergeNameCarry, prepareFeatures } from './features';
import type { Mesh } from './mesh';
import { type PreviewPatch, previewPatch } from './preview-world';
import { scriptsEnabled } from './script';
import { resolveTerrain, shareTerrainBase, warmTerrainSteps } from './terrain';
import { SLOTS } from './human/groups';
import { applyPopFix, moveCells, populationFix } from './human/population';
import { computePopLayers } from './human/layers';
import { type Derived, type Settings, type World, createWorld, kmPerUnit, settingsSchema } from './world';
import type { WorldDoc, Timings, EngineBase, DerivedState, DoneStep, Checkpoint, UndoneStep, DocTail, PreviewResult, ProvincesPreview } from './engine-types';
import { type RecomputeState, recomputeDerived, warmWater } from './engine-recompute';
export { passStats } from './engine-recompute';
import { onlyRestyled, drain, landAndFailing, provinceOnly, diffWorlds, undoDepth, UNDO_BYTES, keptBytes, sameContent, privatize, cloneWorld } from './engine-helpers';
export type { WorldDoc, Timings, EngineBase, Checkpoint, DocTail, PreviewExtras, PreviewResult, ProvincesPreview } from './engine-types';

// 引擎：持有世界、命令历史与推导缓存。命令改原因 → 标记从哪层开始重算 → 流水线
//   高程 → 气候（基础）→ [约束求解 → 修正场] → 水文 → 植被 → 冲突检查

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
  // 存着推导结果的步（先存的在前）；最多 undoCache 份，合计不超过 UNDO_BYTES。每份是整个世界的推导数组
  // （4 万格约 11 MB，10 万格约 27 MB），但相邻几份内容相同的数组共用一个（见 shareSame），只改气候、生态的步只多占变了的那些
  private kept: (DoneStep | UndoneStep)[] = [];
  undoCache: number;
  // 当前推导里的数组可能与撤销缓存共用（换上了存着的推导、或者与上一份共用了相同的数组）：重算之前要先各复制一份，
  // 不能就地改（见 recompute）。复制出来的、自己重算出来的数组只属于当前的推导
  // 不标 private：只有流水线（engine-recompute.ts）读它
  sharedDerived = false;
  private seq = 0;
  // 上次取走以来实际重算到的最深一层（Worker 据此决定只发名字、省份，还是整个世界）
  private recomputed: Dirty = Dirty.None;
  // 最近一次 exec 什么都没改（比如在陆地上画陆地）：不重算、不进历史
  lastNoop = false;
  // 最近一次 exec 移出世界的内容（第二十九轮，见 commands.ts 的 RemovedItem）：界面拿它把自己做的、改过的存进资源库
  lastRemoved: RemovedItem[] = [];
  // 最近一次 exec 缺了内容跳过的步骤（第三十轮，见 content/missing.ts）：界面显示一次
  lastSkipped: string[] = [];
  // 识别地物（起名）。向导的缩略图用不着，关掉省时间
  features = true;
  // 最近一次确切预览算好的副本：紧接着执行同一条命令时直接采用，不再重算（画河改道松手时）。
  // changed：预览的命令有没有改动什么（什么都没改的命令不能借采用预览进历史）
  private lastPreview: { key: string; copy: Engine; changed: boolean } | null = null;
  lastTimings: Timings = { total: 0 };

  constructor(settings: Partial<Settings> = {}, mesh?: Mesh) {
    this.world = createWorld(settings, mesh);
    resolveTerrain(this.world);
    this.undoCache = undoDepth(this.world.mesh.n);
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
    const prev = this.world.derived.features;
    const water0 = this.waterMask();
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
      if (fresh) this.carryNames(prev);
      this.fixLakeProvinces();
      this.fixPopulation(water0);
      this.shareWithLast();
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
  private applyOnly(cmd: Command, skipNoop = false): { summary: string; changed: boolean; removed: RemovedItem[]; added: ContentRef[] } {
    const r = applyCommand(this.world, cmd, { ensureDerived: () => this.update() });
    this.lastNoop = skipNoop && !r.changed;
    this.lastRemoved = r.removed;
    this.lastSkipped = r.skipped;
    if (this.lastNoop) return { summary: r.summary, changed: false, removed: [], added: [] };
    const dirty = Math.max(r.dirty, this.speciesChanged() ? Dirty.Solve : Dirty.None) as Dirty;
    // 新起的省名记进命令（存档、重做时照用）。
    // 安全模式（脚本不运行）下推导与正常时不同，这一步新起的省可能少几个：命令里已经记着的名字一个不丢，
    // 不然用安全模式打开一次、自动保存之后，再正常打开时那几个省就换了名字（命令照旧保留）
    const merge = !!(r.provinceNames && cmd.provinceNames && !scriptsEnabled());
    const names = merge ? { ...cmd.provinceNames, ...r.provinceNames } : r.provinceNames;
    // 省名的原文（第二十轮）跟着省名记；没有原文时不写这一项
    const orig = merge && cmd.provinceOrig ? { ...cmd.provinceOrig, ...r.provinceOrig } : r.provinceOrig;
    let recorded: Command = names ? { ...cmd, provinceNames: names } : cmd;
    // 第一次执行时才知道的（第五十八轮：涂类别那一笔下面的平均高度），记进命令
    if (r.recorded) recorded = { ...recorded, ...r.recorded } as Command;
    if (orig) recorded = { ...recorded, provinceOrig: orig };
    else if (names && recorded.provinceOrig) {
      const { provinceOrig: _, ...rest } = recorded;
      recorded = rest as Command;
    }
    this.done.push({ id: ++this.seq, cmd: recorded, undo: r.undo, summary: r.summary, dirty });
    this.dirty = Math.max(this.dirty, dirty) as Dirty;
    return { summary: r.summary, changed: r.changed, removed: r.removed, added: r.added };
  }

  // ---------- 撤销缓存：最近几步的推导结果 ----------

  // 当前的推导结果（不复制：换下来的对象不再被改动）
  private current(): DerivedState {
    return { derived: this.world.derived, base: this.base, solve: this.solve, timings: this.lastTimings };
  }

  private install(s: DerivedState) {
    this.world.derived = s.derived;
    this.sharedDerived = true;
    this.base = s.base;
    this.solve = s.solve;
    this.lastTimings = s.timings;
    this.dirty = Dirty.None;
  }

  private keep(step: DoneStep | UndoneStep, s: DerivedState) {
    step.state = s;
    this.kept = this.kept.filter((k) => k.state && k !== step);
    this.kept.push(step);
    while (this.kept.length > this.undoCache || (this.kept.length > 1 && keptBytes(this.kept) > UNDO_BYTES)) this.kept.shift()!.state = undefined;
  }

  // 刚执行的一步：推导还是执行前的（update 还没跑）。执行前的推导原样留给撤销（之后不再改动），当前的推导换成各数组的副本
  // 再重算（与以前复制一份留给撤销、就地重算逐值相同）。只给要重算推导的步留
  private keepBefore(fresh: boolean) {
    const h = this.done[this.done.length - 1];
    if (!(fresh && h.dirty > Dirty.Human && this.undoCache > 0)) return;
    // 推导对象本身不换（别处可能拿着它），换的是里面的数组：留给撤销的是一个新对象，引用原来的那些数组
    const live = this.world.derived;
    const before = { ...this.current(), derived: { ...live, corrF: { ...live.corrF } } };
    privatize(live);
    this.sharedDerived = false;
    this.keep(h, before);
  }

  // 重算完：与 prev（上一份推导，撤销缓存里的）内容相同的数组换成 prev 的那一个（共用，省下撤销缓存的内存）。
  // 共用之后当前的推导不能再就地改：下一次重算之前先复制（sharedDerived）
  private shareSame(prev: Derived | undefined) {
    if (!prev) return;
    const d = this.world.derived as unknown as Record<string, unknown>;
    const p = prev as unknown as Record<string, unknown>;
    let any = false;
    for (const [k, v] of Object.entries(d)) {
      const old = p[k];
      if (!ArrayBuffer.isView(v) || !ArrayBuffer.isView(old) || old === v || !sameContent(old, v)) continue;
      d[k] = old;
      any = true;
    }
    for (const [k, v] of Object.entries(this.world.derived.corrF)) {
      const old = prev.corrF[k];
      if (old && old !== v && sameContent(old, v)) {
        this.world.derived.corrF[k] = old;
        any = true;
      }
    }
    if (any) this.sharedDerived = true;
  }

  // 刚执行（或重做）的最后一步留着执行前的推导时，与它共用相同的数组
  private shareWithLast() {
    this.shareSame(this.done[this.done.length - 1]?.state?.derived);
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
    if (fresh && after && step.dirty > Dirty.Human) {
      const before = this.current();
      this.install(after);
      this.keep(step, before);
      this.recomputed = Math.max(this.recomputed, step.dirty) as Dirty;
    } else this.keepBefore(fresh);
    try {
      this.update();
      this.shareWithLast();
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

  // 换一个：撤掉最后一步，执行新命令（脚本框连着提交时用）。只重算一次，历史里只留新的一步。
  // 撤掉的那一步之前的推导，就是新的一步之前的推导：留给新的一步撤销用。
  // 新命令做不了、或者重算出错：原来那一步放回去，世界、历史、重做记录都与换之前相同
  replaceLast(cmd: Command): string {
    this.lastPreview = null;
    const stateBefore = this.stateId;
    // 换之前看到的地物与小数据：新的一步按它们留名字（换掉的岛还叫原来的名字）
    const shown = this.dirty === Dirty.None && this.done.length ? { features: this.world.derived.features, small: copySmall(this.world.small) } : null;
    const h = this.revertLast();
    if (!h) throw new CommandError('没有可以替换的一步');
    const water0 = this.waterMask();
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
    if (before && step.dirty > Dirty.Human) this.keep(step, before);
    try {
      this.update();
      if (shown) this.carryNames(shown.features, shown.small);
      this.fixLakeProvinces();
      this.fixPopulation(water0);
      this.shareWithLast();
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

  // 名字跟着地方走（见 features.ts 的 carryNames）：最后一步重算之后，与这一步之前的地物 prev 比，
  // 锚点挪了、名字被新出来的地物抢了的地物留着原来的名字，落不到地物上的改名挪过去。记进这一步的命令
  // （重放、重做时照用，所以从头重放与一步一步编辑一字不差），再重新起名。只改名字、省份的步，没识别地物时不做
  // prevSmall：prev 那时的小数据（副本），默认是这一步之前的
  private carryNames(prev: GeoFeature[], prevSmall?: SmallCopy) {
    const step = this.done[this.done.length - 1];
    if (!this.features || !step || step.dirty <= Dirty.None || !prev.length) return;
    const w = this.world;
    // 只重算了人文的几层（第二十二轮）：地物还是那些，名字变了的都是换了风格（当地的文化变了）的，起名的办法变了，
    // 没有要留的名字（与整个比一遍的结果相同，省下三遍起名）
    if (step.dirty === Dirty.Human && step.cmd.op !== 'batch' && onlyRestyled(prev, w.derived.features)) return;
    const carry = carryNames(w, w.derived.features, restoreSmall(prevSmall ?? step.undo), prev);
    if (!carry) return;
    applyNameCarry(w.small, carry);
    step.cmd = { ...step.cmd, nameCarry: mergeNameCarry(step.cmd.nameCarry, carry) };
    this.dirty = Dirty.Names;
    this.update();
  }

  // 湖与陆地省份的整理（见 provinces.ts 的 lakeProvinceFix）：这一步改了推导（放湖、删湖、湖干了、地形变了）之后，
  // 按新的湖把格放进对的省份。结果记进这一步的命令（重放、重做时照用，不用推导）与撤销记录；省份不进推导，不用重算
  private fixLakeProvinces() {
    const step = this.done[this.done.length - 1];
    if (!step || step.dirty <= Dirty.None || step.cmd.provinceFix) return;
    // 只画了人文（第二十二轮）：湖、陆海、岛的种类都没变，不用整理
    if (step.dirty === Dirty.Human && step.cmd.op !== 'batch') return;
    const w = this.world;
    const before = w.causes.province.slice();
    const fix = lakeProvinceFix(w, w.derived);
    if (!fix) return;
    addArrayUndo(step.undo, 'province', fix.cells, before);
    step.cmd = { ...step.cmd, provinceFix: fix };
  }

  // 有人文时这一步之前的水面（海、湖）与宜居度（第八十四轮）：改了陆海、宜居度之后修补人口用（见 fixPopulation）
  private waterMask(): { water: Uint8Array; hab: Float32Array } | null {
    const w = this.world;
    if (!w.small.human || !w.causes.popTotal) return null;
    const n = w.mesh.n;
    const land = w.causes.land;
    const lake = w.derived.lake;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!land[i] || lake[i] === 1) out[i] = 1;
    return { water: out, hab: w.derived.habitability };
  }

  // 人口的修补（第二十二轮，见 human/population.ts 的 populationFix）：这一步改了陆海、湖之后，变成水面的格没有人了，
  // 新的干的陆地按宜居度补上人；第八十四轮：宜居度变了的地方一带的人按新的宜居度在本国里重新分（总数不变）。结果记进这一步的命令（popFix，重放、重做时照用）与撤销记录，再重算人文的几层与名字
  private fixPopulation(water0: { water: Uint8Array; hab: Float32Array } | null) {
    const step = this.done[this.done.length - 1];
    const w = this.world;
    if (!water0 || !step || step.dirty <= Dirty.Human || step.cmd.popFix || !w.small.human || !w.causes.popTotal) return;
    const fix = populationFix(w, w.derived, water0.water, water0.hab);
    if (!fix) return;
    const c = w.causes;
    const before = { t: c.popTotal!.slice(), g: fix.cells.length ? c.popGroup!.slice() : c.popGroup!, s: fix.cells.length ? c.popShare!.slice() : c.popShare! };
    applyPopFix(w, fix);
    const slots = fix.cells.flatMap((i) => Array.from({ length: SLOTS }, (_, k) => i * SLOTS + k));
    addArrayUndo(step.undo, 'popTotal', fix.moves ? [...new Set([...fix.cells, ...moveCells(fix.moves)])].sort((a, b) => a - b) : fix.cells, before.t);
    if (fix.cells.length) {
      addArrayUndo(step.undo, 'popGroup', slots, before.g);
      addArrayUndo(step.undo, 'popShare', slots, before.s);
    }
    step.cmd = { ...step.cmd, popFix: fix };
    // 第八十四轮：只挪了人数（成分、陆海都没变）时只重算人口的几层（地名、国家的一层不看人数），不再走一遍人文
    if (!fix.cells.length) {
      computePopLayers(w, w.derived);
      return;
    }
    this.dirty = Dirty.Human;
    this.update();
  }

  // 推导里的数组发出去了（Worker 只发变了的数组，按引用比较上一次发的）：之后重算不能就地改它们，先复制
  freezeDerived() {
    this.sharedDerived = true;
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
    return drain(this.updateSteps());
  }

  // 同 update，分阶段：每算完一个阶段（高程、气候、每一遍水文与植被、求解）停一下（yield）。
  // 一口气走完（drain）与 update 完全相同；Worker 里的预览在两个阶段之间让出线程、看看要不要取消（见 previewWorldSteps）
  *updateSteps(): Generator<void, Derived> {
    if (this.dirty === Dirty.None) return this.world.derived;
    try {
      return yield* this.recompute();
    } catch (e) {
      this.dirty = Dirty.Elevation;
      throw e;
    }
  }

  private *recompute(): Generator<void, Derived> {
    return yield* recomputeDerived(this as unknown as RecomputeState);
  }

  // 空闲预热（第三十一轮）：打开（从检查点恢复）以后，Worker 空闲时一段一段地做（段与段之间 yield，Worker 在那里让出线程，
  // 收到请求就停下、空闲了再从头来：做过的几样一查就跳过）。只往按内容的缓存里放东西，世界、推导、历史都不动，所以结果不变：
  //   生成器的采样（terrain.ts 的 warmTerrainSteps）→ 高程的记忆（elevation.ts 的 warmElevationSteps）→
  //   气候里只取决于网格、纬度、海陆的几层（星球的 warmClimateSphereSteps；地区的 prepareClimatePlane）→ 地物各段的缓存。
  // 从检查点恢复的世界这些缓存都是空的（网格是新的），不预热时打开后的第一笔要多等 0.6–1.5 秒
  *warmSteps(): Generator<void> {
    const w = this.world;
    yield* warmTerrainSteps(w);
    yield* warmElevationSteps(w);
    // 海岸类型（第三十四轮：岸段的噪声与每格的权重按网格缓存，新网格上第一次约 20–40 ms；描河、地形层都要用）与峡湾的谷网（第三十六轮）
    if (!coastStyleCached(w)) {
      landStyle(w);
      fjordData(w);
      yield;
    }
    const terrain = this.base?.terrain;
    if (terrain) {
      if (w.mesh.kind === 'sphere') yield* warmClimateSphereSteps(w, terrain);
      else if (prepareClimatePlane(w)) yield;
      // 冰盖、挖过冰川的地形、水文的路由与坡度（第八十八轮）
      if (this.dirty === Dirty.None && warmWater(w, terrain)) yield;
    }
    if (this.features && terrain && this.dirty === Dirty.None) {
      if (prepareFeatures(w)) yield;
      // 其余几段（湖、河、山、生态区）按现在的推导认一遍，记进地物的缓存；认出来的地物不用（推导里已经有）
      detectFeatures(w, w.derived, terrain);
      yield;
    }
  }

  // 整理本世界的计划（第二十九轮，见 tidy.ts）：在副本上试过、地图不变的才移出。执行 plan.command 就是整理
  planTidy(opts: Parameters<typeof planTidy>[1] = {}): TidyPlan {
    return planTidy(this, opts);
  }

  // 每一样（人文、国家、城市、省份）上一次生成时的内容（第九十轮，见 regen-base.ts）：从历史里读，不重算、不改世界。
  // 打开世界、撤销、重做之后发给主线程（资源库面板的“改了 N 项 · 重新生成”，刷新以后还在）
  regenBase(): RegenBaseOf {
    return regenBaseOf(this.done, this.world.small.content);
  }

  toDoc(): WorldDoc {
    const commands = this.done.map((h) => h.cmd);
    return { format: 'map2-world', version: DOC_VERSION, settings: this.world.settings, commands };
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
    checkDoc(doc);
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
    e.undoCache = undoDepth(mesh.n);
    e.sharedDerived = false;
    e.seq = Math.max(0, ...cp.done.map((h) => h.id));
    e.recomputed = Dirty.Elevation;
    e.lastNoop = false;
    e.lastRemoved = [];
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

  // onStep（第二十九轮，压缩世界文件用，见 compact.ts）：每条命令之后告诉调用方这一步移出、新加了哪些内容
  static fromDoc(doc: WorldDoc, mesh?: Mesh, opts: { onStep?: (k: number, step: { removed: RemovedItem[]; added: ContentRef[] }) => void } = {}): Engine {
    checkDoc(doc);
    const settings = settingsSchema.parse(doc.settings);
    const engine = new Engine(settings, mesh);
    doc.commands.forEach((cmd, k) => {
      try {
        const r = engine.applyOnly(cmd);
        opts.onStep?.(k, r);
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
    return drain(this.previewSteps(cmd));
  }

  // 同 preview，分阶段（见 updateSteps）。中途不再走下去（取消）时：当前世界、历史都没变，也不留副本
  *previewSteps(cmd: Command): Generator<void, PreviewResult> {
    this.update();
    // 先放掉上一份副本（星球上一份约 30 MB），再复制新的
    this.lastPreview = null;
    const t0 = performance.now();
    const copy = this.clone();
    const prev = this.world.derived.features;
    const water0 = this.waterMask();
    const { changed } = copy.applyOnly(cmd);
    yield;
    yield* copy.updateSteps();
    // 与执行时一样留名字（采用预览时命令、小数据都照用副本的）
    copy.carryNames(prev);
    copy.fixLakeProvinces();
    copy.fixPopulation(water0);
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
    // 涂省、并省会让格跟着省份换国家（第二十三轮）：国家的数组也复制一份
    const causes = { ...w.causes, province: w.causes.province.slice(), ...(w.causes.country ? { country: w.causes.country.slice() } : {}) };
    const scratch: World = { ...w, causes, small: cloneSmall(w.small) };
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
    if (step.dirty > Dirty.Human && this.undoCache > 0) this.keep(this.done[this.done.length - 1], this.current());
    this.install({ derived: p.copy.world.derived, base: p.copy.base, solve: p.copy.solve, timings: p.copy.lastTimings });
    this.recomputed = Math.max(this.recomputed, step.dirty) as Dirty;
    this.lastNoop = false;
    this.lastRemoved = p.copy.lastRemoved;
    return step.summary;
  }

  // 预览，并带上将来的世界与当前世界的差别（只带内容变了的数组，见 preview-world.ts）：地图据此画出将来的样子
  previewWorld(cmd: Command): { result: PreviewResult; patch: PreviewPatch } {
    return drain(this.previewWorldSteps(cmd));
  }

  // 同 previewWorld，分阶段（Worker 里在阶段之间看看要不要取消）
  *previewWorldSteps(cmd: Command): Generator<void, { result: PreviewResult; patch: PreviewPatch }> {
    const result = yield* this.previewSteps(cmd);
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
    e.sharedDerived = false;
    e.recomputed = Dirty.None;
    e.lastNoop = false;
    e.lastRemoved = [];
    e.lastPreview = null;
    e.features = this.features;
    e.lastTimings = this.lastTimings;
    e.stateId = this.stateId;
    return e;
  }
}
