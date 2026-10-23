import type { Checkpoint, WorldDoc } from '../core/engine';
import type { PackedMesh } from '../core/mesh-pack';
import { collectBuffers } from './transfer';

// 检查点的存取（隔离那一步）：计算 Worker 在隔离的环境里打不开 IndexedDB，检查点改由一个与页面同源、
// 只做存储、从不运行脚本的 Worker（storage-worker.ts）读写。检查点（星球约 34 MB，连同几千步的命令）都不经过主线程：
//   新建、打开世界（不是安全模式）时，主线程开一条 MessageChannel，一头交给存储 Worker（open）、一头随新建、打开交给计算 Worker；
//   读：打开时存储 Worker 只把对得上这个世界的检查点从这条通道发过去（否则发 null）；
//   写：计算 Worker 把写好的检查点从这条通道直接发给存储 Worker（发的时候复制一次，在计算 Worker 里），另给主线程发一条纪元和步号的通知；
//       主线程核对步号与命令记录一模一样（见 sandbox.ts），再告诉存储 Worker 可以写（commit）。存储 Worker 收到的那一份
//       纪元、步号与主线程说的相同才写下（两条消息走不同的路，谁先到都行）。
// “对得上”：版本号相同、设置相同、检查点里的每一步都是这个世界开头的那几步（多出来的步可能是别的世界的，不发）。
// 这样运行脚本的计算 Worker 拿不到你保存的其他世界；主线程也不必为几十 MB 的检查点停顿

export interface SavedCheckpoint {
  build: string;
  cp: Checkpoint;
}

// 主线程发给存储 Worker 的
export type StorageRequest =
  // 一条新的通道（新建、打开时各一条，之前的作废）：token 是主线程给的编号；doc：打开的世界（新建时为 null，不发检查点）
  // meshKey：打开的世界的网格存在浏览器里时的键（见 mesh-worker.ts）；对得上时连同网格一起发过去，计算 Worker 不必再建
  | { kind: 'open'; token: number; build: string; doc: WorldDoc | null; port: MessagePort; meshKey?: string | null }
  // 主线程核对过：这条通道上纪元、步号与命令记录一模一样的那一份可以写下
  | { kind: 'commit'; token: number; epoch: number; ids: number[] };

// 存储 Worker 经通道发给计算 Worker 的（只在打开时发一条）
export interface TakeReply {
  cp: Checkpoint | null;
  // 存着的这个世界的网格（打包的样子，见 core/mesh-pack.ts）；没有、对不上时不带
  mesh?: PackedMesh;
}

// 计算 Worker 经通道发给存储 Worker 的：写好的检查点和写的时候引擎的纪元
export interface CheckpointPut {
  epoch: number;
  cp: Checkpoint;
}

// 检查点里每一步的编号；样子不对时为 null
function checkpointIds(cp: unknown): number[] | null {
  if (cp === null || typeof cp !== 'object') return null;
  const done = (cp as { done?: unknown }).done;
  if (!Array.isArray(done)) return null;
  const ids: number[] = [];
  for (const h of done) {
    const id = h !== null && typeof h === 'object' ? (h as { id?: unknown }).id : undefined;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
    ids.push(id);
  }
  return ids;
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, k) => x === b[k]);

// 现在的世界文件版本（core/doc-version.ts 的 DOC_VERSION；存储 Worker 只按类型引用 core，所以写成字面量，
// satisfies 保证与那边一致）
const CURRENT_VERSION = 5 satisfies WorldDoc['version'];

// 存着的检查点能不能交给打开 doc 的计算 Worker（旧版本的世界一律不用：第九轮起不再兼容旧存档）
export function checkpointFits(saved: unknown, build: string, doc: WorldDoc): saved is SavedCheckpoint {
  if (!build || saved === null || typeof saved !== 'object' || doc.version !== CURRENT_VERSION) return false;
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

// ---------- 主线程这边 ----------

// 存储 Worker 用到的部分（真的 Worker 或测试里的假的）
export interface StorageWorkerLike {
  onerror: ((ev: unknown) => void) | null;
  postMessage(msg: StorageRequest, transfer: Transferable[]): void;
}

export interface ChannelLike {
  port1: MessagePort;
  port2: MessagePort;
}

// 第一次用到时才开存储 Worker；它出了事（开不起来）就不再用，计算 Worker 照旧重放、不写检查点。
// 只给一个 EngineHost 用：存储 Worker 只认最新的一条通道
export class CheckpointStore {
  private worker: StorageWorkerLike | null = null;
  private broken = false;
  private token = 0;

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

  // 新建（doc 为 null）、打开时：开一条新的通道，返回交给计算 Worker 的那一头和编号；存储 Worker 用不了时为 null
  open(build: string, doc: WorldDoc | null, meshKey: string | null = null): { port: MessagePort; token: number } | null {
    const w = this.get();
    if (!w) return null;
    try {
      const ch = this.channel();
      const token = ++this.token;
      w.postMessage({ kind: 'open', token, build, doc, port: ch.port1, ...(meshKey ? { meshKey } : {}) }, [ch.port1]);
      return { port: ch.port2, token };
    } catch {
      return null;
    }
  }

  // 主线程核对过的那一份：让存储 Worker 写下（只有编号、纪元和步号，检查点本身不经过这里）
  commit(token: number, epoch: number, ids: number[]): void {
    const w = this.get();
    if (!w) return;
    try {
      w.postMessage({ kind: 'commit', token, epoch, ids }, []);
    } catch {
      // 发不过去：这一次不写
    }
  }
}

// ---------- 存储 Worker 这边 ----------

export interface KeeperDb {
  get(): Promise<unknown>;
  put(saved: SavedCheckpoint): Promise<void>;
  // 存着的网格（meshes 表的 'current'：{key, mesh}）；没有这一项时不发网格
  mesh?(): Promise<unknown>;
}

interface Writer {
  token: number;
  build: string;
  port: MessagePort;
  // 计算 Worker 发来、还没写的那一份
  pending: { epoch: number; ids: number[]; cp: Checkpoint } | null;
  // 主线程说可以写的纪元、步号（检查点还没到时先记着）
  approved: { epoch: number; ids: number[] } | null;
}

// 存储 Worker 里的逻辑（storage-worker.ts 接上真的 IndexedDB；测试里换成假的）。只认最新的一条通道：
// 新的通道来了，旧的不再收，它上面还没写的作废（换了世界或者换了 Worker）；旧的打开时要发的那一条照样发完再关
// （计算 Worker 可能正等着它，不然要白等 5 秒）
export class CheckpointKeeper {
  private writer: Writer | null = null;
  // 一件一件做：写完再读，读到的是刚写的
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly db: KeeperDb) {}

  private queue(run: () => Promise<void>) {
    this.chain = this.chain.then(run).catch(() => undefined);
  }

  // 等排着的都做完（测试用）
  idle(): Promise<void> {
    return this.chain;
  }

  handle(data: unknown): void {
    if (data === null || typeof data !== 'object') return;
    const m = data as StorageRequest;
    if (m.kind === 'open' && Number.isSafeInteger(m.token) && typeof m.build === 'string' && m.build && m.port) this.open(m);
    else if (m.kind === 'commit') this.commit(m);
  }

  private open(m: Extract<StorageRequest, { kind: 'open' }>) {
    const old = this.writer;
    if (old) {
      old.port.onmessage = null;
      this.queue(async () => old.port.close());
    }
    const w: Writer = { token: m.token, build: m.build, port: m.port, pending: null, approved: null };
    this.writer = w;
    w.port.onmessage = (ev: MessageEvent) => this.received(w, ev.data);
    const doc = m.doc;
    const meshKey = typeof m.meshKey === 'string' && m.meshKey ? m.meshKey : null;
    if (doc) this.queue(() => this.take(w, doc, meshKey));
  }

  // 打开时：对得上这个世界的检查点（否则 null）从通道发给计算 Worker，数组转移
  private async take(w: Writer, doc: WorldDoc, meshKey: string | null) {
    let cp: Checkpoint | null = null;
    try {
      const saved = await this.db.get();
      if (checkpointFits(saved, w.build, doc)) cp = saved.cp;
    } catch {
      // 读不了：照旧重放
    }
    // 网格：键对得上（同一个版本、同一个网格）才发
    let mesh: PackedMesh | null = null;
    if (meshKey && this.db.mesh) {
      try {
        const m = (await this.db.mesh()) as { key?: unknown; mesh?: unknown } | null | undefined;
        if (m && m.key === meshKey && m.mesh && typeof m.mesh === 'object') mesh = m.mesh as PackedMesh;
      } catch {
        // 读不了：计算 Worker 自己建
      }
    }
    try {
      const reply: TakeReply = mesh ? { cp, mesh } : { cp };
      w.port.postMessage(reply, [...new Set([...(cp ? collectBuffers(cp) : []), ...(mesh ? collectBuffers(mesh) : [])])]);
    } catch {
      w.port.postMessage({ cp: null } satisfies TakeReply);
    }
  }

  private received(w: Writer, data: unknown) {
    if (this.writer !== w || data === null || typeof data !== 'object') return;
    const { epoch, cp } = data as Partial<CheckpointPut>;
    const ids = checkpointIds(cp);
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || !ids) return;
    w.pending = { epoch, ids, cp: cp as Checkpoint };
    this.tryWrite(w);
  }

  private commit(m: Extract<StorageRequest, { kind: 'commit' }>) {
    const w = this.writer;
    if (!w || m.token !== w.token || !Number.isSafeInteger(m.epoch) || !Array.isArray(m.ids) || !m.ids.every((x) => Number.isSafeInteger(x))) return;
    w.approved = { epoch: m.epoch, ids: m.ids.slice() };
    this.tryWrite(w);
  }

  // 收到的那一份与主线程说的纪元、步号相同才写（同一个纪元里步号相同就是同一个状态：改过的步都换了新编号）
  private tryWrite(w: Writer) {
    const p = w.pending;
    const a = w.approved;
    if (!p || !a || p.epoch !== a.epoch || !sameIds(p.ids, a.ids)) return;
    w.pending = null;
    w.approved = null;
    const saved: SavedCheckpoint = { build: w.build, cp: p.cp };
    this.queue(() => this.db.put(saved));
  }
}
