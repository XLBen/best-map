import type { Command } from '../core/commands';
import type { WorldDoc } from '../core/engine';
import type { MirrorLog, Request, Response, ScriptPing } from './protocol';

// 计算 Worker 的看护（第三批）：用户写的脚本只在 Worker 里跑，可能卡死、把 Worker 弄崩。主线程这边：
// - 看门狗：只在脚本运行期间计时（Worker 进入脚本、每 250 毫秒报一次平安、算完时各发一条消息），
//   4 秒没有消息就判定卡住；电脑睡眠、页面在后台被节流（检查本身晚了 2 秒以上）不算；
//   一段脚本算了 1.5 秒以上时告诉界面（“正在运行「X」的脚本…”，带“停下”）；
// - 命令记录：每次改动世界的回复都带上变了的命令，主线程留一份完整的；
// - 恢复：卡住、停下、Worker 崩了时停掉它，正在等的请求都回 {ok:false}（这一步没有做），
//   另开一个 Worker，用命令记录（加检查点）打开同一个世界；这也卡住、出错就用安全模式（脚本不运行）打开。
//   正在新建、打开的世界卡住了：直接用安全模式打开它（再正常打开一次还会卡住）；
//   刚恢复的世界还没做成过一步就在后台又出了事：也用安全模式（不然会一直恢复、卡住、再恢复）；
//   还没有世界（向导的缩略图）时不恢复；恢复到一半打开了别的世界，恢复作废（不当成打不开）；
// - Worker 发来的消息先检查：只认识的几种，字符串截短；命令记录要接得上已有的；
// - 检查点（隔离那一步）：新建、打开世界（不是安全模式）时向存储 Worker 要一条通道交给计算 Worker，
//   检查点从那里来回（打开时读、之后写），不经过主线程；计算 Worker 说写好了一个检查点时，步号与命令记录一模一样
//   才让存储 Worker 写下；
// - 一个计算 Worker 只装一个世界：新建、打开时，装过世界（或者运行过脚本）的 Worker 换一个新的。
//   脚本可能在 Worker 里留下钩子，也可能从缓存里翻出之前打开过的世界：都不能让它看到你保存的其他世界
// 不碰 DOM、不碰信号：时钟、Worker 都可以换成假的（见 sandbox.test.ts）

// ---------- 时钟 ----------

export interface Clock {
  now(): number;
  // 每 ms 毫秒调用一次 f；返回取消的函数
  every(ms: number, f: () => void): () => void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  every: (ms, f) => {
    const h = setInterval(f, ms);
    return () => clearInterval(h);
  },
};

// 看门狗的几个时间（毫秒）：多久没消息算卡住、多久算慢（显示“停下”）、多久检查一次、检查晚了多少算睡眠
export const WATCH = { silence: 4000, slow: 1500, interval: 500, late: 2000 } as const;

// ---------- 看门狗 ----------

export class Watchdog {
  // 正在运行谁的脚本；null：没在跑脚本（不计时）
  private label: string | null = null;
  private since = 0;
  private last = 0;
  private checked = 0;
  private shown = false;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly on: { hung(label: string): void; slow(label: string | null): void },
  ) {}

  get running(): string | null {
    return this.label;
  }

  ping(phase: ScriptPing['phase'], label: string) {
    const now = this.clock.now();
    if (phase === 'exit') {
      this.disarm();
      return;
    }
    if (phase === 'tick') {
      if (this.label !== null) this.last = now;
      return;
    }
    // 进入：上一段没说算完（不该发生）就当它算完了
    if (this.label !== null) this.disarm();
    this.label = label;
    this.since = this.last = this.checked = now;
    this.cancel = this.clock.every(WATCH.interval, () => this.check());
  }

  private check() {
    if (this.label === null) return;
    const now = this.clock.now();
    const late = now - this.checked - WATCH.interval;
    this.checked = now;
    // 检查本身晚了很久：电脑睡过、页面在后台被节流，Worker 的消息也没来得及处理，重新计时
    if (late > WATCH.late) {
      this.last = now;
      return;
    }
    if (now - this.last > WATCH.silence) {
      const label = this.label;
      this.disarm();
      this.on.hung(label);
      return;
    }
    if (!this.shown && now - this.since >= WATCH.slow) {
      this.shown = true;
      this.on.slow(this.label);
    }
  }

  // 不再计时（脚本算完、Worker 回复了、停掉了 Worker）
  disarm() {
    this.cancel?.();
    this.cancel = null;
    this.label = null;
    if (this.shown) {
      this.shown = false;
      this.on.slow(null);
    }
  }
}

// ---------- 检查 Worker 发来的消息 ----------

const LABEL_MAX = 60;
const ERROR_MAX = 2000;

export type WorkerMessage =
  | { type: 'reply'; reply: Response }
  | { type: 'script'; ping: ScriptPing }
  // 写好了一个检查点（已经发给存储 Worker）：写的时候的纪元、每一步的编号（与命令记录比）
  | { type: 'checkpoint'; epoch: number; ids: number[] };

// 只认三种：带 id 的回复、脚本的进入 / 平安 / 算完、写好检查点的通知。别的（包括脚本自己伪造的怪消息）一律不要。
// 招呼（hello）由开 Worker 的那一层（engine-spawn.ts）收，到不了这里
export function readWorkerMessage(data: unknown): WorkerMessage | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  if (m.kind === 'checkpointReady') {
    if (typeof m.epoch !== 'number' || !Number.isSafeInteger(m.epoch)) return null;
    if (!Array.isArray(m.ids) || !m.ids.every((x) => typeof x === 'number' && Number.isSafeInteger(x))) return null;
    return { type: 'checkpoint', epoch: m.epoch, ids: (m.ids as number[]).slice() };
  }
  if (m.kind === 'script') {
    if (m.phase !== 'enter' && m.phase !== 'tick' && m.phase !== 'exit') return null;
    if (typeof m.label !== 'string') return null;
    return { type: 'script', ping: { kind: 'script', phase: m.phase, label: m.label.slice(0, LABEL_MAX) } };
  }
  if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id) || typeof m.ok !== 'boolean') return null;
  if (!m.ok) return { type: 'reply', reply: { id: m.id, ok: false, error: typeof m.error === 'string' ? m.error.slice(0, ERROR_MAX) : '计算出错' } };
  return { type: 'reply', reply: m as unknown as Response };
}

function validLog(log: unknown): log is MirrorLog {
  if (log === null || typeof log !== 'object') return false;
  const l = log as Record<string, unknown>;
  return (
    l.format === 'map2-world' &&
    typeof l.version === 'number' &&
    l.settings !== null &&
    typeof l.settings === 'object' &&
    typeof l.epoch === 'number' &&
    Number.isSafeInteger(l.from) &&
    (l.from as number) >= 0 &&
    Array.isArray(l.commands) &&
    Array.isArray(l.ids) &&
    (l.ids as unknown[]).every((x) => typeof x === 'number') &&
    (l.ids as unknown[]).length === (l.from as number) + (l.commands as unknown[]).length
  );
}

// ---------- 命令记录 ----------

// 主线程上的一份命令记录：与 Worker 里的引擎同步（每次改动的回复带上变了的命令）。
// 只接受接得上的：同一个 Worker、同一个纪元里步号的前缀对得上；换了 Worker 或纪元时只接受从头发的（from 为 0）。
// 旧的（更早的 Worker、更早的纪元）一律不要：不会用上一个世界的命令恢复
export class Mirror {
  private gen = -1;
  private epoch = -1;
  private head: Omit<WorldDoc, 'commands'> | null = null;
  private commands: Command[] = [];
  private ids: number[] = [];

  apply(gen: number, log: unknown): boolean {
    if (!validLog(log)) return false;
    if (gen < this.gen || (gen === this.gen && log.epoch < this.epoch)) return false;
    const same = gen === this.gen && log.epoch === this.epoch;
    if (log.from > 0) {
      if (!same || log.from > this.ids.length) return false;
      for (let k = 0; k < log.from; k++) if (log.ids[k] !== this.ids[k]) return false;
    }
    this.gen = gen;
    this.epoch = log.epoch;
    this.head = { format: log.format, version: log.version, settings: log.settings };
    this.commands = [...this.commands.slice(0, log.from), ...log.commands];
    this.ids = log.ids.slice();
    return true;
  }

  // 现在的世界文件；还没有世界时为 null
  doc(): WorldDoc | null {
    return this.head ? { ...this.head, commands: this.commands.slice() } : null;
  }

  // 同一个 Worker、同一个纪元，步号一模一样（检查点写的正是命令记录里的这个世界）
  matches(gen: number, epoch: number, ids: readonly number[]): boolean {
    if (!this.head || gen !== this.gen || epoch !== this.epoch || ids.length !== this.ids.length) return false;
    for (let k = 0; k < ids.length; k++) if (ids[k] !== this.ids[k]) return false;
    return true;
  }
}

// ---------- Worker 的看护 ----------

// 计算 Worker 用到的部分（真的 Worker 或测试里的假的）
export interface WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror?: ((ev: unknown) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate?(): void;
}

type Ok = Extract<Response, { ok: true }>;

export interface HostEvents {
  // 一段脚本算了 1.5 秒以上（谁的）；null：算完了，不再显示
  slow?(label: string | null): void;
  // 卡住、停下、崩了：旧的 Worker 已经停掉，正在等的请求都回了 {ok:false}，正在用命令记录恢复。message 是给用户的话
  reset?(message: string): void;
  // 恢复好了：打开的回复（带快照）。safeReason：安全模式打开的原因，正常打开时为 null
  restored?(r: Ok, safeReason: string | null): void;
  // 恢复不了（安全模式打开也出错），或者还没有世界、没有在等的请求时出了事（只说一句）
  failed?(message: string): void;
  // 恢复到一半不恢复了：打开了别的世界（换模式另开了 Worker），或者恢复用的 Worker 也出了事、另行处理
  abandoned?(): void;
}

export interface HostOptions {
  // 这个程序的版本（检查点按它认）：随新建、打开告诉计算 Worker；没有时（开发时）不写也不读检查点
  build?: string | null;
  // 新建（doc 为 null）、打开世界（不是安全模式）时：向存储 Worker 要一条通道，返回交给计算 Worker 的那一头和通道的编号。
  // 打开时对得上这个世界的检查点从这里过来，写好的检查点从这里直接过去，都不经过主线程。要不到时为 null（不读不写）
  storeChannel?(build: string, doc: WorldDoc | null): { port: Transferable; token: number } | null;
  // 计算 Worker 说写好了一个检查点，纪元、步号与命令记录一模一样（不是安全模式）：让存储 Worker 写下这条通道上的那一份
  commit?(token: number, epoch: number, ids: number[]): void;
}

type Why = 'hang' | 'stopped' | 'crash';

// 给用户的话。world：有世界要恢复（恢复后重做记录就没了）；step：有在等的请求（这一步没做）
export function stoppedText(why: Why, label: string | null, world = true, step = true): string {
  const who = label ? `「${label}」的脚本` : '脚本';
  const head = why === 'hang' ? `${who}卡住了（4 秒没有算完），已经停下` : why === 'stopped' ? `已经停下${who}` : '计算程序停止了响应';
  return `${head}${step ? '，这一步没有做' : ''}${world ? '。重做记录清空了' : ''}`;
}

// 安全模式的原因（横幅里括号中的话）
export function safeReasonText(why: Why, label: string | null): string {
  const who = label ? `「${label}」的脚本` : '脚本';
  if (why === 'hang') return `${who}卡住了`;
  if (why === 'stopped') return `停下了${who}`;
  return '计算程序停止了响应';
}

interface Pending {
  req: Request;
  done: (r: Response) => void;
  // 恢复时自己发的打开（出错由 restore 处理）
  internal?: boolean;
}

// 不是 Worker 回的、是这里替它回的 {ok:false}（停掉 Worker、换了世界时还没回复的请求）用的编号。
// Worker 的回复编号从 1 起，伪造的 0 号回复找不到在等的请求，不会被当成这种。
// 界面据此分辨“没算完就被停下了”（星球形态编辑器的缩略图：卡住的脚本不再自动重算）
export const CANCELLED = 0;

const opens = (req: Request) => req.kind === 'init' || req.kind === 'load';

export class EngineHost {
  private worker: WorkerLike | null = null;
  // 开过几个 Worker（命令记录、消息都按它分辨新旧）
  private gen = 0;
  private nextId = 1;
  // 发出去还没回复的请求（按发出的顺序；Worker 一个一个处理，第一个就是正在算的）
  private readonly pending = new Map<number, Pending>();
  readonly mirror = new Mirror();
  private readonly watchdog: Watchdog;
  // 当前 Worker 是不是安全模式（一个 Worker 从开起就固定）、为什么
  safe = false;
  safeReason: string | null = null;
  // 当前 Worker 里有没有打开过世界（新开的 Worker 第一次打开就失败时，世界只在命令记录里）
  private loaded = false;
  // 命令记录里的世界是用哪种模式打开的（恢复时照样）
  private mirrorSafe = false;
  private mirrorReason: string | null = null;
  // 当前 Worker 是恢复时开的，而且还没有哪个界面的请求在它里面算成过。它在后台（没有在等的请求时）又卡住、崩了：
  // 多半是打开这个世界本身的问题，再正常恢复会一直循环下去，改用安全模式
  private quiet = false;
  // 当前 Worker 里运行过脚本（收到过“进入脚本”）：再新建、打开时另开一个
  private ranScripts = false;
  // 当前 Worker 里新建、打开过世界：再新建、打开时另开一个（一个 Worker 只装一个世界）
  private held = false;
  // 最近一次新建、打开时交给当前 Worker 的存储通道的编号（没有时为 null：不写检查点）
  private storeToken: number | null = null;

  constructor(
    private readonly spawnWorker: () => WorkerLike,
    private readonly events: HostEvents = {},
    clock: Clock = realClock,
    private readonly opts: HostOptions = {},
  ) {
    this.watchdog = new Watchdog(clock, {
      hung: (label) => this.recover('hang', label),
      slow: (label) => this.events.slow?.(label),
    });
  }

  // 正在运行谁的脚本（看门狗在计时）；没有时为 null
  get running(): string | null {
    return this.watchdog.running;
  }

  // 有没有开着的 Worker
  get alive(): boolean {
    return this.worker !== null;
  }

  // 还没有 Worker 时先开一个（不是安全模式）：比如问要不要信任脚本之前，先知道脚本能不能隔离运行
  warm(): void {
    if (!this.worker) this.spawn(false, null);
  }

  // w 是不是当前的 Worker（停掉的旧 Worker 说的话不算）
  isCurrent(w: unknown): boolean {
    return w !== null && this.worker === w;
  }

  // 发一个请求，回复（或停掉 Worker 时的 {ok:false}）交给 done。新建、打开时：当前 Worker 装过世界、跑过脚本，
  // 或者要的模式（safe）与它不同，另开一个；
  // safeReason：安全模式打开的原因（界面的横幅里写）
  send(req: Request, done: (r: Response) => void, safeReason?: string): void {
    if (req.kind === 'init' || req.kind === 'load') {
      const safe = req.safe === true;
      if (this.worker && (this.safe !== safe || this.ranScripts || this.held)) this.drop('这一步没有做（换了一个世界）');
      if (!this.worker) this.spawn(safe, null);
      // 安全模式的原因记这一次的
      if (safe) this.safeReason = safeReason ?? null;
    } else if (req.kind !== 'thumb' && req.kind !== 'cancelPreview' && !this.loaded && ![...this.pending.values()].some((p) => opens(p.req))) {
      // 没有装着世界的 Worker（停掉后没有自动重开：安全模式下也出了事），也没有正在打开的：
      // 要用到世界时先按原来的模式把命令记录里的世界打开（向导的缩略图用不着世界）
      const doc = this.mirror.doc();
      if (doc) {
        if (this.worker) this.drop('这一步没有做');
        this.restore(doc, this.mirrorSafe, this.mirrorReason);
      }
    }
    if (!this.worker) this.spawn(false, null);
    this.post(req, done);
  }

  // 界面上的“停下”：正在跑脚本时停掉 Worker，与卡住一样恢复
  stop(): boolean {
    const label = this.watchdog.running;
    if (label === null || !this.worker) return false;
    this.recover('stopped', label);
    return true;
  }

  private spawn(safe: boolean, reason: string | null): WorkerLike {
    const w = this.spawnWorker();
    const gen = ++this.gen;
    w.onmessage = (ev) => this.receive(gen, ev.data);
    w.onerror = () => {
      if (gen === this.gen) this.recover('crash', null);
    };
    this.worker = w;
    this.safe = safe;
    this.safeReason = safe ? reason : null;
    this.loaded = false;
    this.quiet = false;
    this.ranScripts = false;
    this.held = false;
    this.storeToken = null;
    return w;
  }

  private post(req: Request, done: (r: Response) => void, internal = false) {
    const id = this.nextId++;
    // 留着的是原来的请求（恢复时可能要改成安全模式再发一次）；版本号、存储的端口只加在发出去的这一份上
    this.pending.set(id, { req, done, internal });
    if (opens(req)) this.held = true;
    const { msg, transfer } = this.wire(req);
    this.worker!.postMessage({ id, req: msg }, transfer);
  }

  private wire(req: Request): { msg: Request; transfer: Transferable[] } {
    const build = this.opts.build;
    if (!build || (req.kind !== 'init' && req.kind !== 'load')) return { msg: req, transfer: [] };
    // 每次新建、打开都换一条通道（之前的作废）；安全模式下没有（不读不写检查点）
    const ch = req.safe === true ? null : (this.opts.storeChannel?.(build, req.kind === 'load' ? req.doc : null) ?? null);
    this.storeToken = ch?.token ?? null;
    if (ch) return { msg: { ...req, build, store: ch.port as MessagePort }, transfer: [ch.port] };
    return { msg: { ...req, build }, transfer: [] };
  }

  private receive(gen: number, data: unknown) {
    // 停掉了的 Worker 还没送到的消息
    if (gen !== this.gen) return;
    const m = readWorkerMessage(data);
    if (!m) return;
    if (m.type === 'script') {
      if (m.ping.phase === 'enter') this.ranScripts = true;
      this.watchdog.ping(m.ping.phase, m.ping.label);
      return;
    }
    if (m.type === 'checkpoint') {
      // 消息按顺序到：写检查点之前的回复（带着命令记录）都已经收到，步号此刻应当与命令记录一模一样
      const token = this.storeToken;
      if (token !== null && !this.safe && this.mirror.matches(gen, m.epoch, m.ids)) this.opts.commit?.(token, m.epoch, m.ids);
      return;
    }
    const r = m.reply;
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    // 回复了：Worker 还活着，也不在跑脚本
    this.watchdog.disarm();
    if (r.ok) {
      if (opens(p.req)) this.loaded = true;
      if (!p.internal) this.quiet = false;
      if (r.log && this.mirror.apply(gen, r.log) && opens(p.req)) {
        this.mirrorSafe = this.safe;
        this.mirrorReason = this.safeReason;
      }
    }
    p.done(r);
    // 换模式另开的 Worker 第一次打开就失败了：它里面没有世界，原来的世界只在命令记录里，按原来的模式打开回来
    if (!r.ok && opens(p.req) && !p.internal && !this.loaded && gen === this.gen) this.reopen();
  }

  private reopen() {
    const doc = this.mirror.doc();
    if (!doc) return;
    this.drop('这一步没有做');
    this.restore(doc, this.mirrorSafe, this.mirrorReason);
  }

  private kill() {
    this.watchdog.disarm();
    const w = this.worker;
    this.worker = null;
    this.loaded = false;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    w.terminate?.();
  }

  // 停掉 Worker，还没回复的请求都回 {ok:false, error}（换模式时：换了世界，它们的结果没有用了）
  private drop(error: string) {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.kill();
    for (const p of waiting) p.done({ id: CANCELLED, ok: false, error });
  }

  private recover(why: Why, label: string | null) {
    const doc = this.mirror.doc();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    const message = stoppedText(why, label, doc !== null, waiting.length > 0);
    const reason = safeReasonText(why, label);
    const wasSafe = this.safe;
    const quiet = this.quiet;
    this.kill();
    const fail = (p: Pending) => p.done({ id: CANCELLED, ok: false, error: message });
    const head = waiting[0];
    if (head && (head.req.kind === 'init' || head.req.kind === 'load') && !wasSafe) {
      // 正在新建、打开（或者正在恢复）的世界卡住了：用安全模式打开它，回复照旧交给原来的请求
      for (const p of waiting.slice(1)) fail(p);
      this.spawn(true, reason);
      this.post({ ...head.req, safe: true }, head.done, head.internal);
      return;
    }
    for (const p of waiting) fail(p);
    if (!doc) {
      // 还没有世界（比如向导的缩略图）：没有要恢复的，下次用到时再开 Worker。在等的请求已经带着这句话回去了
      if (!waiting.length) this.events.failed?.(message);
      return;
    }
    if (wasSafe) {
      // 安全模式下也出了事（不是脚本的问题）：不再自动重开，下次用到世界时再按安全模式打开
      this.events.failed?.('计算程序停止了响应，这一步没有做');
      return;
    }
    this.events.reset?.(message);
    // 刚恢复的世界什么都没做就在后台又出了事：再正常恢复还会这样，用安全模式
    if (!waiting.length && quiet) this.restore(doc, true, reason);
    else this.restore(doc, false, null);
  }

  // 用命令记录另开一个 Worker 打开同一个世界（Worker 会先试检查点）；正常打开出错就用安全模式再开一次。
  // 打开时又卡住：recover 把它当成“正在打开的世界卡住了”，用安全模式打开
  private restore(doc: WorldDoc, safe: boolean, reason: string | null) {
    const done = (r: Response) => {
      if (r.ok) this.events.restored?.(r, r.safe ? this.safeReason : null);
      // 这里替 Worker 回的：换了世界、或者恢复用的 Worker 也出了事（recover 另行处理），不是打不开
      else if (r.id === CANCELLED) this.events.abandoned?.();
      else if (!this.safe) {
        // 排在后面的请求是发给这个（打不开世界的）Worker 的：作废
        this.drop(r.error);
        this.spawn(true, '恢复时出错');
        this.post({ kind: 'load', doc, safe: true }, done, true);
      } else this.events.failed?.(`世界没能恢复：${r.error}`);
    };
    this.spawn(safe, reason);
    this.quiet = true;
    this.post(safe ? { kind: 'load', doc, safe: true } : { kind: 'load', doc }, done, true);
  }
}
