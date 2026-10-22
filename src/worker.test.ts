import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { Checkpoint, WorldDoc } from '../core/engine';
import type { CheckpointPut } from './checkpoint-store';
import type { CheckpointReady, MirrorLog, Request, Response, Snapshot } from './protocol';

// 计算 Worker 本身（隔离那一步的约定）：先自查、打招呼，之后才处理请求；版本号、存储的端口由主线程给，没有就不写检查点；
// 写好的检查点从存储的端口直接发出去（带纪元；发的时候复制一份，引擎的数组照常用），另给主线程一条纪元和步号（与回复里的命令记录一样）的通知；
// 打开时从存储的端口收第一条，对得上就直接恢复（与重放逐值一致），收到 null、安全模式时照旧重放。
// 这里没有真的 Worker：全局的 self 是假的，存储 Worker 那一头是真的 MessageChannel 的另一头

const posted: { msg: unknown; transfer?: Transferable[] }[] = [];
const scope: { origin: string; onmessage: ((ev: { data: unknown }) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void } = {
  origin: 'http://localhost:5191',
  onmessage: null,
  postMessage: (msg, transfer) => void posted.push({ msg, transfer }),
};
vi.stubGlobal('self', scope);
await import('./worker');

let nextId = 1;
async function send(req: Request): Promise<Extract<Response, { ok: true }>> {
  const id = nextId++;
  scope.onmessage!({ data: { id, req } });
  for (let k = 0; k < 2000; k++) {
    const hit = posted.find((p) => (p.msg as { id?: number }).id === id);
    if (hit) {
      const r = hit.msg as Response;
      if (!r.ok) throw new Error(r.error);
      return r;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('等不到回复');
}
const notices = () => posted.map((p) => p.msg as CheckpointReady).filter((m) => m.kind === 'checkpointReady');

// 存储 Worker 那一头：收到的检查点；计算 Worker 这一头发的时候的转移列表
function storeEnd() {
  const ch = new MessageChannel();
  const got: CheckpointPut[] = [];
  const transfers: Transferable[][] = [];
  ch.port1.onmessage = (ev) => got.push(ev.data as CheckpointPut);
  const send = ch.port2.postMessage.bind(ch.port2) as (m: unknown, t?: Transferable[]) => void;
  ch.port2.postMessage = ((m: unknown, t?: Transferable[]) => {
    transfers.push(t ?? []);
    send(m, t);
  }) as typeof ch.port2.postMessage;
  return { ch, got, transfers, port: ch.port2, close: () => (ch.port1.close(), ch.port2.close()) };
}
const until = async (ok: () => boolean) => {
  for (let k = 0; k < 500 && !ok(); k++) await new Promise((r) => setTimeout(r, 2));
  expect(ok()).toBe(true);
};

const settings = { cells: 1500, seed: 4 };
const commands: Command[] = [
  {
    op: 'batch',
    commands: [
      { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true },
      { op: 'set_planet', patch: { terrainWind: 1 } },
    ],
  },
  { op: 'set_planet', patch: { humidity: 1.1 } },
];

describe('计算 Worker 的约定', () => {
  let written: CheckpointPut | null = null;
  let doc: WorldDoc | null = null;
  let replayed: Snapshot | null = null;

  it('先自查、打招呼，之后才处理请求（同源的普通 Worker 说没隔离）', async () => {
    const r = await send({ kind: 'init', settings, commands });
    expect(posted[0].msg).toEqual({ kind: 'hello', isolated: false });
    expect(posted.findIndex((p) => p.msg === r)).toBeGreaterThan(0);
    // 没有版本号、端口（开发时）：不写检查点
    await send({ kind: 'checkpoint' });
    expect(notices()).toEqual([]);
  });

  it('有版本号和端口：检查点从端口直接发给存储 Worker（带纪元，引擎的数组不转移），主线程只收到纪元和步号，步号与命令记录一样', async () => {
    const st = storeEnd();
    const r = await send({ kind: 'init', settings, commands, build: 'b1', store: st.port });
    const log = r.log as MirrorLog;
    await send({ kind: 'checkpoint' });
    await until(() => st.got.length === 1);
    const put = st.got[0];
    expect(put.epoch).toBe(log.epoch);
    expect(put.cp.done.map((h) => h.id)).toEqual(log.ids);
    expect(put.cp.causes.land).toBeInstanceOf(Uint8Array);
    // 发的时候复制一份（只复制一次），引擎里的数组不转移：之后照常用
    expect(st.transfers[0]).toEqual([]);
    // 主线程那边：只有编号，没有检查点，也没有转移的数组
    expect(notices()).toEqual([{ kind: 'checkpointReady', epoch: log.epoch, ids: log.ids }]);
    const notice = posted.find((p) => (p.msg as CheckpointReady).kind === 'checkpointReady')!;
    expect(notice.transfer ?? []).toEqual([]);
    // 没变就不再写
    await send({ kind: 'checkpoint' });
    await new Promise((r) => setTimeout(r, 10));
    expect(st.got).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    written = put;
    doc = (await send({ kind: 'doc' })).doc!;
    replayed = r.snapshot as Snapshot;
    // 新建、打开换了端口：旧的关掉
    const next = storeEnd();
    await send({ kind: 'init', settings, commands, build: 'b1', store: next.port });
    await send({ kind: 'checkpoint' });
    await until(() => next.got.length === 1);
    expect(st.got).toHaveLength(1);
    st.close();
    next.close();
  });

  it('打开时从端口收检查点：对得上就直接恢复，与重放逐值一致；之后的检查点从同一个端口发', async () => {
    const st = storeEnd();
    // 存储 Worker 那一头：发一条检查点（结构化克隆一份，就像从 IndexedDB 读出来的）
    st.ch.port1.postMessage({ cp: structuredClone(written!.cp) });
    const r = await send({ kind: 'load', doc: doc!, build: 'b1', store: st.port });
    const snap = r.snapshot as Snapshot;
    expect(snap.history.map((h) => h.summary)).toEqual(replayed!.history.map((h) => h.summary));
    const views = Object.entries(replayed!.derived).filter(([, v]) => ArrayBuffer.isView(v));
    expect(views.length).toBeGreaterThan(20);
    for (const [k, v] of views) {
      expect(Array.from(snap.derived[k as keyof Snapshot['derived']] as ArrayLike<number>), k).toEqual(Array.from(v as ArrayLike<number>));
    }
    // 恢复出来的就是检查点里的那一步：页面要隐藏时不必再写
    const before = notices().length;
    await send({ kind: 'checkpoint' });
    expect(notices()).toHaveLength(before);
    // 改一步：从同一个端口写
    await send({ kind: 'exec', cmd: { op: 'set_planet', patch: { humidity: 1.2 } } });
    await send({ kind: 'checkpoint' });
    await until(() => st.got.length === 1);
    expect(st.got[0].cp.done).toHaveLength(commands.length + 1);
    expect(notices()).toHaveLength(before + 1);
    st.close();
  });

  it('收到 null、安全模式：照旧重放（安全模式下也不写检查点）', async () => {
    const st = storeEnd();
    st.ch.port1.postMessage({ cp: null });
    const before = notices().length;
    await send({ kind: 'load', doc: doc!, build: 'b1', store: st.port });
    // 重放出来的新引擎：要隐藏时写一次
    await send({ kind: 'checkpoint' });
    await until(() => st.got.length === 1);
    expect(notices()).toHaveLength(before + 1);
    st.close();
    // 安全模式：端口里有检查点也不用（检查点里的推导运行过脚本），也不写
    const safe = storeEnd();
    safe.ch.port1.postMessage({ cp: structuredClone(written!.cp) as Checkpoint });
    const r = await send({ kind: 'load', doc: doc!, build: 'b1', safe: true, store: safe.port });
    expect(r.safe).toBe(true);
    await send({ kind: 'checkpoint' });
    await new Promise((r) => setTimeout(r, 10));
    expect(safe.got).toHaveLength(0);
    expect(notices()).toHaveLength(before + 1);
    safe.close();
  });
});
