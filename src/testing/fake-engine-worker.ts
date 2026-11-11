import type { Command } from '../../core/commands';
import { DOC_VERSION } from '../../core/doc-version';
import type { WorldDoc } from '../../core/engine';
import { engineFor } from '../../core/testing/fixtures';
import type { Request, Snapshot } from '../protocol';

// 测试用的假计算 Worker（第九十四轮，自动保存、继续上次的世界的测试共用）：按请求回复，带命令记录（log）——
// 主线程的命令记录（sandbox.ts 的 Mirror）、自动保存要的 docTail 都和真的一样接得上。
// 世界的样子用同一个小世界的快照（只有 stateId 每一步不同）；命令不真的执行，只记下来。
//   vi.stubGlobal('Worker', FakeEngineWorker)

const eng = engineFor({ cells: 1500, seed: 4 });
eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
export const baseSettings = eng.world.settings;
export const baseCommands = (): Command[] => eng.toDoc().commands;
export const docOf = (extra: Command[] = []): WorldDoc => ({ format: 'map2-world', version: DOC_VERSION, settings: baseSettings, commands: [...baseCommands(), ...extra] });
export const nameCmd = (k: number | string): Command => ({ op: 'rename_feature', key: `k${k}`, name: `名字${k}` });

let stateSeq = 100;
const snap = (stateId: number): Snapshot => {
  const w = eng.world;
  return { settings: w.settings, causes: w.causes, small: w.small, derived: w.derived, history: eng.history, canUndo: eng.canUndo, canRedo: eng.canRedo, timings: eng.lastTimings, stateId };
};

export const workerControl = {
  // 打开世界时回这个错（null：照常打开）；只错几次（之后照常）
  loadError: null as string | null,
  loadErrorTimes: Infinity,
  // 执行的回复先压着（还在算），放出来：release()
  holdExec: false,
  held: [] as (() => void)[],
  release() {
    for (const send of this.held.splice(0)) send();
  },
  reset() {
    this.loadError = null;
    this.loadErrorTimes = Infinity;
    this.holdExec = false;
    this.held.length = 0;
  },
};

export class FakeEngineWorker {
  static all: FakeEngineWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Request[] = [];
  terminated = false;
  // 这个 Worker 里的“引擎”：做了的每一步
  done: { id: number; cmd: Command }[] = [];
  private seq = 0;
  private epoch = 0;
  private reported: number[] = [];
  private head: Omit<WorldDoc, 'commands'> = { format: 'map2-world', version: DOC_VERSION, settings: baseSettings };
  constructor() {
    FakeEngineWorker.all.push(this);
  }
  static get last(): FakeEngineWorker {
    return FakeEngineWorker.all[FakeEngineWorker.all.length - 1];
  }
  static kinds(): string[] {
    return FakeEngineWorker.all.flatMap((w) => w.sent.map((r) => (r.kind === 'load' && r.safe ? 'load(safe)' : r.kind)));
  }
  private tail(savedIds: readonly number[]) {
    let from = 0;
    while (from < savedIds.length && from < this.done.length && savedIds[from] === this.done[from].id) from++;
    return { ...this.head, from, commands: this.done.slice(from).map((h) => h.cmd), ids: this.done.map((h) => h.id) };
  }
  private changed(summary: string, more: Record<string, unknown> = {}) {
    const log = { ...this.tail(this.reported), epoch: this.epoch };
    this.reported = log.ids;
    return { summary, snapshot: snap(++stateSeq), log, ...more };
  }
  private respond(req: Request): Record<string, unknown> | { error: string } {
    switch (req.kind) {
      case 'init':
      case 'load': {
        if (req.kind === 'load' && workerControl.loadError !== null && workerControl.loadErrorTimes > 0) {
          workerControl.loadErrorTimes--;
          return { error: workerControl.loadError };
        }
        const commands = req.kind === 'load' ? req.doc.commands : (req.commands ?? []);
        this.head = { format: 'map2-world', version: DOC_VERSION, settings: (req.kind === 'load' ? req.doc.settings : baseSettings) as WorldDoc['settings'] };
        this.seq = 0;
        this.done = commands.map((cmd) => ({ id: ++this.seq, cmd }));
        this.epoch++;
        this.reported = [];
        return this.changed(req.kind === 'load' ? '已打开世界文件' : '新世界', { safe: req.safe === true });
      }
      case 'exec':
        this.done.push({ id: ++this.seq, cmd: req.cmd });
        return this.changed('完成');
      case 'undo':
        this.done.pop();
        return this.changed('撤销');
      case 'docTail':
        return { tail: this.tail(req.ids) };
      case 'doc':
        return { doc: { ...this.head, commands: this.done.map((h) => h.cmd) } };
      default:
        return {};
    }
  }
  postMessage(m: { id: number; req: Request }) {
    this.sent.push(m.req);
    const send = () => {
      if (this.terminated) return;
      const out = this.respond(m.req);
      this.onmessage?.({ data: 'error' in out ? { id: m.id, ok: false, error: out.error } : { id: m.id, ok: true, ...out } });
    };
    if (workerControl.holdExec && m.req.kind === 'exec') workerControl.held.push(send);
    else queueMicrotask(send);
  }
  terminate() {
    this.terminated = true;
  }
}

export const tick = async (n = 10) => {
  for (let k = 0; k < n; k++) await new Promise((r) => setTimeout(r, 0));
};
