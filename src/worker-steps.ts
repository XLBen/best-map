// 计算 Worker 里久的一步怎么走（第九十七轮）：执行、撤销、重做、换一个都是分阶段的（core/engine.ts 的 execSteps……）。
//   - 短的（YIELD_AFTER_MS 以内做完的，平常的每一笔）：一口气走完，中间不让出线程——和以前走的是同一条同步的路；
//   - 久的：过了 YIELD_AFTER_MS 以后，每到一个阶段的边界让出一次线程（这时收得到主线程的“取消”），不要了就往分阶段的计算里抛一个错：
//     引擎照“中途出错”的路把世界原样退回（历史、重做记录都与这一步之前相同），再把这个错抛出来。
// 让出期间别的请求插不进来：计算 Worker 的请求一个接一个处理（worker.ts 的 queue），这一个没回复，后面的都排着。
// 不碰 self、不碰引擎：时钟、怎么让出都可以换（见 worker-steps.test.ts）

// 用户不要这一步了（不是出错）
export class Stopped extends Error {
  constructor() {
    super('已取消');
  }
}

// 多久以后才开始在阶段之间让出线程。界面上 1 秒以后才出现“取消”（src/progress.ts 的 SHOW_AFTER_MS），这里取它的一半：
// 按钮出现时计算程序早已在每个边界上听着；而半秒以内做完的编辑（量到的最慢的一步是 0.6 秒上下的描河，其余几十到三四百毫秒）一次都不让出
export const YIELD_AFTER_MS = 500;
// 测试里改成 0（小世界的一步几十毫秒，不改就一次都不让出）
export const pacing = { yieldAfter: YIELD_AFTER_MS };

export interface Pace {
  now(): number;
  // 让出线程一次（回来时主线程发来的消息已经处理过了）
  rest(): Promise<void>;
}

// 走完一串分阶段的计算。cancelled：这一步是不是不要了（每次让出回来问一次；还没开始就不要了的不开始）
export async function runSteps<R>(steps: Generator<void, R>, cancelled: () => boolean, pace: Pace, after = pacing.yieldAfter): Promise<R> {
  if (cancelled()) throw new Stopped();
  const t0 = pace.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (pace.now() - t0 < after) continue;
    await pace.rest();
    if (!cancelled()) continue;
    // 往里抛：引擎把世界退回这一步之前，再把这个错抛出来（从这里直接出去）。引擎不吞错；万一没抛出来，就当它照常接着算
    const thrown = steps.throw(new Stopped());
    if (thrown.done) return thrown.value;
  }
}

// 让出线程：用一条 MessageChannel 给自己发一条消息（一来一回约 0.1 毫秒）。不用 setTimeout(0)：连着几次以后浏览器把它拖到 4 毫秒一次，
// 一步里二十来个边界就多出近 0.1 秒。没有 MessageChannel 时才用它
export function channelRest(): () => Promise<void> {
  if (typeof MessageChannel === 'undefined') return () => new Promise<void>((r) => setTimeout(r, 0));
  let port: MessagePort | null = null;
  let wake: (() => void) | null = null;
  return () =>
    new Promise<void>((resolve) => {
      if (!port) {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          const w = wake;
          wake = null;
          w?.();
        };
        // Node（测试）里开着的端口会拖住进程不退出
        (ch.port1 as unknown as { unref?: () => void }).unref?.();
        port = ch.port2;
      }
      wake = resolve;
      port.postMessage(0);
    });
}

// 重放命令时最多多久说一次“第几条”（几千条的世界不发几千条消息）
export const REPLAY_PING_MS = 100;
