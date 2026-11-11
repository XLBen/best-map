import type { Command } from '../core/commands';
import { DEFAULT_STEP_MS, REF_CELLS } from './progress-defaults';
import type { Request } from './protocol';

// 久的一步的进度（第九十七轮）：纯规则，时钟、存储都可以换（见 progress.test.ts）。接线在 state/progress.ts。
//
// 计算程序在每一步开头说一声走到哪了（protocol.ts 的 StagePing）。进度条画多长，按时间算、按量到的各步耗时加权：
//   已经过去的时间 ÷（已经过去的时间 + 这一步还要多久 + 后面几步要多久）
// “要多久”先用这一类请求上一次真实走过的各步耗时（ProgressBook 记着，存在浏览器里）；没有时用一份默认的（progress-defaults.ts，
// 用 tools/progress-weights.ts 量的，按格数折算）。
//
// 不骗人的几条：
//   - 走完的几步用的是真实的耗时，估的只有剩下的；每到一步的边界就按真实的重新算一次；
//   - 一步里面按时间往前走，最多走到这一步估的九成，之后停着等它真的做完——不会自己走到头；
//   - 重放命令（数得出第几条 / 共几条）按数出来的快慢算，不靠估；
//   - 不倒退：估多了、半路多出没料到的步，条子停着不动，等真实的进度追上来；
//   - 做完之前最多画到 99%。

// 一步做了多久才换成带进度的样子（毫秒）。理由：量到的编辑里最慢的一步是 0.6 秒上下（一块地区描河 560–640 毫秒，
// 第九十五轮 bench-median 的数），其余几十到三四百毫秒——1 秒是它的一倍半以上，平常的每一笔都不会闪出进度条；
// 而 1 秒也是人觉得“它在忙”而不是“点了没反应”的界线，再晚就是盯着一个转圈干等。新建、打开、重新生成都在一秒以上
export const SHOW_AFTER_MS = 1000;
// 一步里面最多走到估的几成
const WITHIN = 0.9;
// 做完之前最多画到多少
const CAP = 0.99;

// 一类请求走过的各步：[这一步的名字, 毫秒]
export type Profile = [step: string, ms: number][];

export interface Ping {
  step: string;
  k: number;
  n: number;
  inner?: boolean;
}

export class ProgressTrack {
  private readonly t0: number;
  // 对上了期望里的第几步（−1：还没对上）
  private pos = -1;
  private cur: { step: string; at: number; est: number; k: number; n: number; counted: boolean } | null = null;
  private readonly walked: Profile = [];
  private best = 0;
  // 现在这一步的名字（重放时里面的小步只换这个）；还没说过时为 null
  step: string | null = null;
  // 数得出来的一步（重放命令）数到第几条、共几条；不是这样的一步时为 null
  get count(): { k: number; n: number } | null {
    const c = this.cur;
    return c && c.counted ? { k: c.k, n: c.n } : null;
  }

  // expected：这一类请求估计会走的各步（上一次真实的，或者默认的）；weigh：期望里没有的步估多久
  constructor(
    private readonly expected: Profile,
    now: number,
    private readonly weigh: (step: string) => number = () => 0,
  ) {
    this.t0 = now;
  }

  ping(p: Ping, now: number): void {
    this.step = p.step;
    if (p.inner) return;
    const c = this.cur;
    // 同一步、数得出来的（重放到第几条了）：只是往前走了几条
    if (c && c.step === p.step && p.n === c.n && p.k > c.k) {
      c.k = p.k;
      c.counted = true;
      return;
    }
    if (c) this.walked.push([c.step, now - c.at]);
    // 在期望里往后找这一步（中间没走的几步跳过）；找不到就是没料到的一步
    let est = this.weigh(p.step);
    for (let j = this.pos + 1; j < this.expected.length; j++) {
      if (this.expected[j][0] !== p.step) continue;
      this.pos = j;
      est = this.expected[j][1];
      break;
    }
    this.cur = { step: p.step, at: now, est: Math.max(0, est), k: p.k, n: p.n, counted: false };
  }

  // 现在画到几成（0–1），不倒退
  fraction(now: number): number {
    const c = this.cur;
    if (!c) return this.best;
    let rest = 0;
    for (let j = this.pos + 1; j < this.expected.length; j++) rest += this.expected[j][1];
    const done = c.at - this.t0;
    const spent = Math.max(0, now - c.at);
    let est = c.est;
    let within = Math.min(spent, WITHIN * est);
    // 数得出来的：按到现在的快慢算这一步一共要多久
    if (c.counted && c.k > 0 && c.n > 0) {
      est = (spent * c.n) / c.k;
      within = spent;
    }
    const total = done + est + rest;
    const f = total > 0 ? Math.min(CAP, (done + within) / total) : 0;
    if (f > this.best) this.best = f;
    return this.best;
  }

  // 做完了：真实走过的各步（记下来，下一次这一类请求按它估）
  finish(now: number): Profile {
    if (this.cur) this.walked.push([this.cur.step, now - this.cur.at]);
    this.cur = null;
    return this.walked.map(([step, ms]) => [step, Math.round(ms)]);
  }
}

// ---------- 这是哪一类请求 ----------

// 流水线的几步；生成人文的几步（core/progress.ts 列着）
const PIPE = ['elevation', 'climate', 'water', 'habitat', 'features'];
const HUMAN = ['human.cultures', 'human.population', 'human.countries', 'human.claims', 'human.blocs', 'human.capitals', 'human.country-mix'];

// 一条命令是哪一种（代价相近的算一种）：批量按最后一条算（界面发的“先加内容、再生成”都是这样排的）
function opOf(cmd: Command): string {
  if (cmd.op !== 'batch') return cmd.op;
  const last = cmd.commands[cmd.commands.length - 1];
  return last ? `batch:${opOf(last)}` : 'batch';
}

// 这一类请求的键：做的是什么、哪种地图、多少格。同一个键的上一次耗时拿来估这一次
export function jobKey(req: Request, cells: number, globe: boolean): string {
  let what: string = req.kind;
  if (req.kind === 'exec' || req.kind === 'replaceLast') what = `${req.kind}:${opOf(req.cmd)}`;
  else if (req.kind === 'init') what = `init:${(req.commands ?? []).map(opOf).join('+')}`;
  return `${what}|${globe ? 'globe' : 'region'}|${cells}`;
}

// 一条命令默认会走的几步（没有上一次的耗时可用时）
function commandSteps(cmd: Command): string[] {
  switch (cmd.op) {
    case 'batch': {
      const inner = cmd.commands.flatMap((c) => (LONG_OPS.has(c.op) || c.op === 'batch' ? commandSteps(c) : []));
      return inner.length ? inner : PIPE;
    }
    case 'set_worldgen':
      return ['terrain', ...PIPE];
    case 'generate_human':
      return [...HUMAN, ...(cmd.settlements ? ['settlements'] : [])];
    case 'regenerate_human':
    case 'generate_countries':
    case 'regenerate_countries':
      return HUMAN;
    case 'generate_provinces':
    case 'regenerate_provinces':
      return ['provinces'];
    case 'generate_settlements':
    case 'regenerate_settlements':
      return ['settlements'];
    default:
      return PIPE;
  }
}
const LONG_OPS = new Set<Command['op']>(['set_worldgen', 'generate_human', 'regenerate_human', 'generate_countries', 'regenerate_countries', 'generate_provinces', 'regenerate_provinces', 'generate_settlements', 'regenerate_settlements']);

// 默认的各步耗时：按 progress-defaults.ts 的表（一块地区、整个星球各量了一份），按格数折算
export function defaultMs(step: string, cells: number, globe: boolean): number {
  const row = DEFAULT_STEP_MS[step];
  if (!row) return 0;
  const [region, planet] = row;
  return globe ? (planet * cells) / REF_CELLS.globe : (region * cells) / REF_CELLS.region;
}

// 这一类请求默认会走的各步和各要多久
export function defaultProfile(req: Request, cells: number, globe: boolean): Profile {
  let steps: string[];
  switch (req.kind) {
    case 'init':
      steps = ['mesh', ...(req.commands ?? []).flatMap(commandSteps), 'show'];
      break;
    case 'load':
      steps = ['mesh', 'replay', ...PIPE, 'show'];
      break;
    case 'exec':
    case 'replaceLast':
      steps = commandSteps(req.cmd);
      break;
    default:
      steps = PIPE;
  }
  return steps.map((s) => [s, defaultMs(s, cells, globe)]);
}

// ---------- 记着每一类请求上一次真实的耗时 ----------

// 存在 localStorage 的哪一项；最多记几类（最久没用的先丢）；一类最多几步（重放里一条一条不记，记的是外面的几步）
export const PROGRESS_KEY = 'map2.progress';
const KEEP = 24;
const STEPS_MAX = 80;

function validProfile(v: unknown): v is Profile {
  return Array.isArray(v) && v.length <= STEPS_MAX && v.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'number' && Number.isFinite(x[1]) && x[1] >= 0);
}

export class ProgressBook {
  // 按用过的先后（Map 记着插入的先后）：最后用过的在最后
  private readonly kept = new Map<string, Profile>();

  // store：浏览器的 localStorage（读不了、写不了、没有都行：只在这次打开页面期间记着）
  constructor(private readonly store: Pick<Storage, 'getItem' | 'setItem'> | null = null) {
    try {
      const raw = store?.getItem(PROGRESS_KEY);
      const list: unknown = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(list)) return;
      for (const item of list.slice(-KEEP)) {
        if (Array.isArray(item) && typeof item[0] === 'string' && validProfile(item[1])) this.kept.set(item[0], item[1]);
      }
    } catch {
      // 读不了、存的不成样子：当没有
    }
  }

  get(key: string): Profile | null {
    return this.kept.get(key) ?? null;
  }

  put(key: string, profile: Profile): void {
    if (!profile.length || !validProfile(profile)) return;
    this.kept.delete(key);
    this.kept.set(key, profile);
    while (this.kept.size > KEEP) this.kept.delete(this.kept.keys().next().value!);
    try {
      this.store?.setItem(PROGRESS_KEY, JSON.stringify([...this.kept]));
    } catch {
      // 写不了（隐私模式、满了）：只在内存里记着
    }
  }
}
