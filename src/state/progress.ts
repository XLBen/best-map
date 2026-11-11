import { signal } from '@preact/signals';
import { type Ping, ProgressBook, ProgressTrack, SHOW_AFTER_MS, defaultMs, defaultProfile, jobKey } from '../progress';
import type { Request } from '../protocol';
import { world } from './world';

// 久的一步的进度（第九十七轮）：规则在 ../progress.ts（纯的），这里接到带提示的请求上（worker-host.ts 的 call）、给界面一个信号。
//
// 平常的一步（1 秒以内）什么都不显示——界面照旧只是“正在计算…”。正在算的那一步过了 SHOW_AFTER_MS 还没做完，progressView 才有值：
// 这一步的名字、画到几成；界面（shell/BusyLine.tsx）换成步名 + 进度条 +“取消”。按“正在算的这一步做了多久”算，不按“忙了多久”：
// 连着画十秒、每一笔都按时算完的，不出现（和 stall.ts 的规矩一样）。

export interface ProgressView {
  // 这一步的名字（core/progress.ts 列着的；界面翻成人话）。还没说过、不认识时界面用请求自己的提示
  step: string | null;
  // 画到几成（0–1），不倒退
  fraction: number;
  // 数得出来的一步（重放命令）：第几条、共几条
  count: { k: number; n: number } | null;
  // 能不能取消：正在恢复世界时不能（那时再停只会再恢复一次）
  cancel: boolean;
}

// 不显示进度时为 null
export const progressView = signal<ProgressView | null>(null);
// 点了“取消”，在等计算程序在下一步之前停下（界面写“正在取消…”，按钮按不了）
export const cancelling = signal(false);

// 到了该显示的时候，估着已经做了 ALMOST 以上（快好了）：再等到估计做完的时候（多留 margin，最多 extra）还没好才显示——
// 不然刚过 1 秒就做完的一步会闪一下进度条（冒烟里量到过：4 万格的一笔在无头 Chrome 里连同画面的卡顿是 1.0–1.3 秒，
// 进度条露了一帧到 0.3 秒）。所以：估着还要很久的一步 1 秒就显示，估着快好的最晚 1.5 秒
const ALMOST = 0.6;
// 测试里改短（不然每一条要真的等一秒）
export const progressTiming = { showAfter: SHOW_AFTER_MS, tick: 100, margin: 100, extra: 500 };

interface Job {
  req: Request;
  // 轮到它算的时刻（前面没有别的在等时是发出去的时刻，不然是前一个做完的时刻）
  since: number;
  track: ProgressTrack | null;
}

// 带提示的请求，按发出的先后；第一个是正在算的。恢复世界（另开的计算程序在打开命令记录里的世界）时是单独的一个
const jobs: Job[] = [];
let recovery: Job | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let book: ProgressBook | null = null;

const now = () => performance.now();
const head = (): Job | null => jobs[0] ?? recovery;

function theBook(): ProgressBook {
  if (book) return book;
  let store: Storage | null = null;
  try {
    store = typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // 用不了就只在内存里记
  }
  return (book = new ProgressBook(store));
}
// 测试：换一本空的
export function resetProgressBook(store: Pick<Storage, 'getItem' | 'setItem'> | null = null) {
  book = new ProgressBook(store);
}

// 这个请求是哪种地图、多少格：新建、打开看它自己带的设置，别的看现在的世界
function sizeOf(req: Request): { cells: number; globe: boolean } {
  const s = req.kind === 'init' ? req.settings : req.kind === 'load' ? req.doc.settings : world.peek()?.settings;
  return { cells: Number(s?.cells) || 0, globe: s?.globe === true };
}

const jobFor = (req: Request): Job => ({ req, since: now(), track: null });
const keyOf = (job: Job): string => {
  const { cells, globe } = sizeOf(job.req);
  return jobKey(job.req, cells, globe);
};

// 第一次要用时才建（计算程序说了第一步、或者该显示了）：不走流水线的一步（改名字、改资源库里的一项）用不到
function trackOf(job: Job): ProgressTrack {
  if (job.track) return job.track;
  const { cells, globe } = sizeOf(job.req);
  const expected = theBook().get(jobKey(job.req, cells, globe)) ?? defaultProfile(job.req, cells, globe);
  return (job.track = new ProgressTrack(expected, job.since, (step) => defaultMs(step, cells, globe)));
}

function hide() {
  if (showTimer) clearTimeout(showTimer);
  if (tickTimer) clearInterval(tickTimer);
  showTimer = tickTimer = null;
  if (progressView.peek()) progressView.value = null;
}

function tick() {
  const job = head();
  if (!job) return hide();
  const track = trackOf(job);
  const count = track.count;
  const next: ProgressView = { step: track.step, fraction: track.fraction(now()), count, cancel: job !== recovery };
  const was = progressView.peek();
  if (!was || was.step !== next.step || was.fraction !== next.fraction || was.cancel !== next.cancel || was.count?.k !== count?.k) progressView.value = next;
}

// 该显示了。again：已经因为“马上就好”多等过一次
function show(again: boolean) {
  showTimer = null;
  const job = head();
  if (!job) return;
  if (!again) {
    const t = now();
    const f = trackOf(job).fraction(t);
    if (f >= ALMOST) {
      // 按到现在的快慢，剩下的还要多久
      const rest = ((t - job.since) * (1 - f)) / f;
      showTimer = setTimeout(() => show(true), Math.min(progressTiming.extra, rest + progressTiming.margin));
      return;
    }
  }
  tick();
  tickTimer = setInterval(tick, progressTiming.tick);
}

// 正在算的换了一个（或者刚有了第一个）：从它轮到的时刻起重新等 showAfter
function arm() {
  hide();
  const job = head();
  if (!job) return;
  showTimer = setTimeout(() => show(false), Math.max(0, progressTiming.showAfter - (now() - job.since)));
}

// 带提示的请求发出去了
export function jobQueued(req: Request): void {
  jobs.push(jobFor(req));
  if (jobs.length === 1) arm();
}

// 它做完了（回复到了、快照也换上了）。ok：照常做完的——记下这一次各步真实的耗时，下一次同一类请求按它估
export function jobDone(req: Request, ok: boolean): void {
  const at = jobs.findIndex((j) => j.req === req);
  if (at < 0) return;
  const [job] = jobs.splice(at, 1);
  const t = now();
  // 只记做了一阵的（短的不显示进度，不用记；也免得每一笔都写一次浏览器的存储）
  if (ok && job.track && t - job.since >= progressTiming.showAfter / 2) theBook().put(keyOf(job), job.track.finish(t));
  if (at > 0) return;
  // 下一个从现在起轮到
  if (jobs[0]) jobs[0].since = t;
  if (!jobs.length) cancelling.value = false;
  arm();
}

// 计算程序说走到哪一步了。req 是那个请求（sandbox.ts 的 EngineHost 给的）；恢复世界时是它自己发的打开
export function noteStage(ping: Ping, req: Request): void {
  const job = jobs.find((j) => j.req === req) ?? (recovery && req.kind === 'load' ? recovery : null);
  if (!job) return;
  trackOf(job).ping(ping, now());
}

// 回复到了，还在等网格、换上快照、画出来（新建、打开）：最后一步
export function jobShowing(req: Request): void {
  noteStage({ step: 'show', k: 1, n: 1 }, req);
}

// 正在恢复世界（卡住、取消了新建或打开之后，另开的计算程序在打开原来的世界）：也有进度，没有“取消”
export function recoveryStarted(doc: Extract<Request, { kind: 'load' }>['doc'] | null): void {
  if (!doc) return;
  recovery = jobFor({ kind: 'load', doc });
  cancelling.value = false;
  if (!jobs.length) arm();
}
export function recoveryEnded(): void {
  if (!recovery) return;
  recovery = null;
  if (!jobs.length) arm();
}
