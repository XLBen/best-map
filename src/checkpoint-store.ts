import type { Checkpoint, WorldDoc } from '../core/engine';
import { collectBuffers } from './transfer';

// 检查点的存取（隔离那一步）：计算 Worker 在隔离的环境里打不开 IndexedDB，检查点改由一个与页面同源、
// 只做存储、从不运行脚本的 Worker（storage-worker.ts）读写。
//   写：计算 Worker → 主线程（核对步号，见 sandbox.ts）→ 存储 Worker，数组一路转移，主线程不复制；
//   读：打开世界时主线程开一条 MessageChannel，一头交给存储 Worker、一头随“打开”交给计算 Worker；
//       存储 Worker 只把对得上这个世界的检查点从这条通道发过去（否则发 null），检查点不经过主线程。
// “对得上”：版本号相同、设置相同、检查点里的每一步都是这个世界开头的那几步（多出来的步可能是别的世界的，不发）。
// 这样运行脚本的计算 Worker 拿不到你保存的其他世界

export interface SavedCheckpoint {
  build: string;
  cp: Checkpoint;
}

// 主线程发给存储 Worker 的
export type StorageRequest =
  | { kind: 'put'; build: string; cp: Checkpoint }
  // port：交给计算 Worker 的那条通道的这一头（只发一条 {cp}，发完就关）
  | { kind: 'take'; build: string; doc: WorldDoc; port: MessagePort };

// 存储 Worker 经通道发给计算 Worker 的
export interface TakeReply {
  cp: Checkpoint | null;
}

// 存着的检查点能不能交给打开 doc 的计算 Worker
export function checkpointFits(saved: unknown, build: string, doc: WorldDoc): saved is SavedCheckpoint {
  if (!build || saved === null || typeof saved !== 'object') return false;
  const s = saved as { build?: unknown; cp?: unknown };
  if (s.build !== build || s.cp === null || typeof s.cp !== 'object') return false;
  const cp = s.cp as { settings?: unknown; done?: unknown };
  const done = cp.done;
  if (!Array.isArray(done) || done.length === 0 || !Array.isArray(doc.commands) || done.length > doc.commands.length) return false;
  if (JSON.stringify(cp.settings) !== JSON.stringify(doc.settings)) return false;
  for (let k = 0; k < done.length; k++) {
    const h = done[k] as { cmd?: unknown } | null;
    if (h === null || typeof h !== 'object' || JSON.stringify(h.cmd) !== JSON.stringify(doc.commands[k])) return false;
  }
  return true;
}

// 存储 Worker 用到的部分（真的 Worker 或测试里的假的）
export interface StorageWorkerLike {
  onerror: ((ev: unknown) => void) | null;
  postMessage(msg: StorageRequest, transfer: Transferable[]): void;
}

export interface ChannelLike {
  port1: MessagePort;
  port2: MessagePort;
}

// 主线程这边：第一次用到时才开存储 Worker；它出了事（开不起来）就不再用，检查点照旧重放
export class CheckpointStore {
  private worker: StorageWorkerLike | null = null;
  private broken = false;

  constructor(
    private readonly spawn: () => StorageWorkerLike,
    private readonly channel: () => ChannelLike = () => new MessageChannel(),
  ) {}

  private get(): StorageWorkerLike | null {
    if (this.broken) return null;
    if (!this.worker) {
      try {
        const w = this.spawn();
        w.onerror = () => {
          this.broken = true;
        };
        this.worker = w;
      } catch {
        this.broken = true;
        return null;
      }
    }
    return this.worker;
  }

  // 写：数组转移过去（调用方之后不再用 cp）
  put(build: string, cp: Checkpoint): void {
    const w = this.get();
    if (!w) return;
    try {
      w.postMessage({ kind: 'put', build, cp }, collectBuffers(cp));
    } catch {
      // 发不过去（数据不能克隆）：这一次不写
    }
  }

  // 读：返回交给计算 Worker 的通道的一头；存储 Worker 用不了时为 null（计算 Worker 照旧重放）
  take(build: string, doc: WorldDoc): MessagePort | null {
    const w = this.get();
    if (!w) return null;
    try {
      const ch = this.channel();
      w.postMessage({ kind: 'take', build, doc, port: ch.port1 }, [ch.port1]);
      return ch.port2;
    } catch {
      return null;
    }
  }
}
