import type { ScriptIssue } from '../../core/script';

// 脚本框的“停一下就用上”：打字停 600 毫秒、检查通过后，真的提交到世界上（地图上看到的就是结果）。
// 一次编辑（从点进框里到离开）只算一步撤销：第一次提交是新的一步（exec），之后用“换掉”（replaceLast），
// 但只在引擎的最后一步还是这次编辑做的那一步时（期间没有别的改动、撤销）。
// 出错时地图保留上一次没出错的结果：
//   - 提交前就查出来的（语法、用了没有的变量）：不提交；
//   - 引擎拒绝了这一步：世界本来就没变；
//   - 在地图上算的时候才出的错（运行时出错、算出 NaN……，引擎按“没有这段脚本”处理）：换回上一次没出错的写法。
// 这里只有逻辑，不碰界面和 Worker：检查、提交、读状态都由调用方给（测试里换成假的）。
// 以后有了临时 worker 里的验证（用真实的数组先跑一遍），接在 check 里就行

// 框下面那一行要说的问题
export interface ScriptProblem {
  // 用户源码里的第几行；不知道时没有
  line?: number;
  text: string;
  // 出错的格：“地图上有一处…（点这里去看）”
  cell?: number;
  // syntax、name：提交前就查出来的，地图没动；engine：引擎拒绝了这一步；
  // runtime、value：在地图上算的时候出的错；disabled：安全模式下脚本没有运行（不算错）
  reason: 'syntax' | 'name' | 'engine' | 'runtime' | 'value' | 'disabled';
}

// 引擎记下的出错（d.scriptIssues 里的一项）换成框下面的问题。语法错误在这里出现只可能是编辑器没查出来、引擎查出来的
export function problemOfIssue(i: ScriptIssue): ScriptProblem {
  return { line: i.line, text: i.text, cell: i.cell, reason: i.reason === 'syntax' ? 'engine' : i.reason };
}

// 红字的一行：“第 3 行：没有变量 tMeen（是不是 tMean？）”
export function problemLine(p: ScriptProblem): string {
  return `${p.line ? `第 ${p.line} 行：` : ''}${p.text}`;
}

// 要不要在后面加“（点这里去看）”：在地图上算的时候出的错，知道是哪一格
export const problemCell = (p: ScriptProblem | null): number | undefined => (p && (p.reason === 'runtime' || p.reason === 'value') ? p.cell : undefined);

export type ApplyMode = 'exec' | 'replace';
export type ApplyResult = { ok: true } | { ok: false; error: string };

export interface Timers {
  set(f: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

export interface ScriptEditDeps {
  // 提交前的检查：没问题返回 null
  check(src: string): Promise<ScriptProblem | null>;
  // 提交（src 为空表示去掉这段脚本）。exec：新的一步；replace：换掉最后一步
  apply(src: string, mode: ApplyMode): Promise<ApplyResult>;
  // 引擎现在的状态编号（每次执行、撤销、重做、换掉都会变）
  stateId(): number;
  // 世界上这段脚本现在出的错（软失败）；没有为 null
  issue(): ScriptProblem | null;
  // 显示的东西变了
  onChange?(): void;
  delay?: number;
  timers?: Timers;
}

export interface ScriptEditView {
  // 框里的文字
  draft: string;
  // 框下面要说的问题
  problem: ScriptProblem | null;
  // 框里的这段没有用上：地图上还是上一次没出错的写法
  stale: boolean;
  // 正在检查或提交
  busy: boolean;
}

export const SCRIPT_PAUSE_MS = 600;

const realTimers: Timers = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

// 只有空白的脚本等于没有脚本
export const normScript = (src: string) => (src.trim() ? src : '');

// 一个脚本框（一种生态的一种脚本）的编辑。框在界面上一直在，点进去开始“一次编辑”（focus），离开时立即提交（blur）
export class ScriptEdit {
  private draft: string;
  // 世界里现在的这段（这边最近提交的，或者打开时就有的）
  private committed: string;
  // 最近一段在地图上算的时候没出错的：出错时退回它
  private good: string;
  // 这次编辑做出的那一步之后的状态编号；引擎还在这个状态，说明最后一步还是它，再提交就换掉它
  private mine: number | null = null;
  // 第几次编辑：离开再点进来是新的一次（新的一步撤销）。还在算的上一次的结果不算到这一次头上
  private session = 0;
  private problem: ScriptProblem | null;
  private stale = false;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly timers: Timers;

  constructor(
    private readonly deps: ScriptEditDeps,
    initial: string,
    initialProblem: ScriptProblem | null = null,
  ) {
    this.draft = initial;
    this.committed = normScript(initial);
    this.good = this.committed;
    this.problem = initialProblem;
    this.timers = deps.timers ?? realTimers;
  }

  view(): ScriptEditView {
    return { draft: this.draft, problem: this.problem, stale: this.stale, busy: this.running !== null };
  }

  // 点进框里：开始新的一次编辑（之后的第一次提交是新的一步）
  focus(): void {
    this.session++;
    this.mine = null;
  }

  // 离开框：还没提交的立即检查、提交
  blur(): Promise<void> {
    return this.flush();
  }

  // 打字：停 600 毫秒后检查、提交
  input(src: string): void {
    this.draft = src;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.run();
    }, this.deps.delay ?? SCRIPT_PAUSE_MS);
    this.deps.onChange?.();
  }

  // 不等了，立即检查、提交
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    return this.run();
  }

  // 世界上的这段脚本、它的出错变了（撤销、重做、别处的改动、重算之后）。正在提交时不管（结果由提交自己记）
  sync(worldSrc: string, worldProblem: ScriptProblem | null): void {
    if (this.running || this.timer !== null) return;
    const src = normScript(worldSrc);
    const edited = normScript(this.draft) !== this.committed;
    if (src !== this.committed) {
      // 被撤销、重做或别处改了：框里没有没提交的改动时跟着换
      this.committed = src;
      this.good = src;
      if (!edited) this.draft = worldSrc;
    }
    if (normScript(this.draft) === this.committed) {
      this.problem = worldProblem;
      this.stale = false;
    }
    this.deps.onChange?.();
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    let done!: () => void;
    this.running = new Promise<void>((r) => (done = r));
    this.deps.onChange?.();
    try {
      do {
        this.again = false;
        await this.step();
      } while (this.again);
    } finally {
      this.running = null;
      done();
      this.deps.onChange?.();
    }
  }

  private async step(): Promise<void> {
    const { deps } = this;
    const session = this.session;
    const src = normScript(this.draft);
    if (src === this.committed) {
      // 没改，或者改回了地图上现在的样子
      this.problem = deps.issue();
      this.stale = false;
      return;
    }
    let p: ScriptProblem | null;
    try {
      p = await deps.check(src);
    } catch {
      // 检查本身出了问题（以后的验证 worker 起不来之类）：不提交，地图保留原来的
      p = { text: '现在检查不了这段脚本，等一下再试', reason: 'engine' };
    }
    // 检查期间又改了：等下一次停顿（或离开时）再说
    if (normScript(this.draft) !== src) return;
    if (p) {
      this.problem = p;
      this.stale = true;
      return;
    }
    const mode: ApplyMode = this.mine !== null && deps.stateId() === this.mine ? 'replace' : 'exec';
    const before = deps.stateId();
    const r = await deps.apply(src, mode);
    if (!r.ok) {
      // 世界没变（换掉失败时引擎把原来那一步放回去了，状态编号也没变）
      this.problem = { text: r.error, reason: 'engine' };
      this.stale = true;
      return;
    }
    const after = deps.stateId();
    // 做出了（或换掉了）一步：记下它之后的状态。什么都没改（状态没变）时没有新的一步。
    // 算的时候已经离开又点进来了：这是上一次编辑的一步，这一次重新开始
    if (this.session !== session) this.mine = null;
    else if (after !== before) this.mine = after;
    else if (mode === 'exec') this.mine = null;
    this.committed = src;
    const issue = deps.issue();
    if (!issue || issue.reason === 'disabled') {
      this.problem = issue;
      this.good = src;
      this.stale = false;
      return;
    }
    // 在地图上算的时候出了错：说明问题，地图换回上一次没出错的写法（还是同一步）
    this.problem = issue;
    this.stale = false;
    if (this.good !== src && this.mine !== null && deps.stateId() === this.mine) {
      const back = await deps.apply(this.good, 'replace');
      if (back.ok) {
        this.committed = this.good;
        this.mine = this.session === session ? deps.stateId() : null;
        this.stale = true;
      }
    }
  }
}
