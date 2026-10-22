import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { Checkpoint, WorldDoc } from '../core/engine';
import type { CheckpointData, MirrorLog, Request, Response, Snapshot } from './protocol';

// 计算 Worker 本身（隔离那一步的约定）：先自查、打招呼，之后才处理请求；版本号由主线程给，没有就不写检查点；
// 检查点发给主线程（带纪元，步号与回复里的命令记录一样，数组转移）；打开时从主线程给的端口收检查点，
// 对得上就直接恢复（与重放逐值一致），收到 null、安全模式时照旧重放。这里没有真的 Worker：全局的 self 是假的

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
const checkpoints = () => posted.map((p) => p.msg as CheckpointData).filter((m) => m.kind === 'checkpointData');

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
  let written: CheckpointData | null = null;
  let doc: WorldDoc | null = null;
  let replayed: Snapshot | null = null;

  it('先自查、打招呼，之后才处理请求（同源的普通 Worker 说没隔离）', async () => {
    const r = await send({ kind: 'init', settings, commands });
    expect(posted[0].msg).toEqual({ kind: 'hello', isolated: false });
    expect(posted.findIndex((p) => p.msg === r)).toBeGreaterThan(0);
    // 没有版本号（开发时）：不写检查点
    await send({ kind: 'checkpoint' });
    expect(checkpoints()).toEqual([]);
  });

  it('有版本号：检查点发给主线程，带纪元，步号与回复里的命令记录一样，数组是转移的', async () => {
    const r = await send({ kind: 'init', settings, commands, build: 'b1' });
    const log = r.log as MirrorLog;
    await send({ kind: 'checkpoint' });
    const cps = checkpoints();
    expect(cps).toHaveLength(1);
    const cp = cps[0];
    expect(cp.build).toBe('b1');
    expect(cp.epoch).toBe(log.epoch);
    expect(cp.cp.done.map((h) => h.id)).toEqual(log.ids);
    const transfer = posted.find((p) => p.msg === cp)!.transfer!;
    expect(transfer.length).toBeGreaterThan(5);
    expect(transfer.every((b) => b instanceof ArrayBuffer)).toBe(true);
    expect(transfer).toContain(cp.cp.causes.land.buffer);
    // 没变就不再写
    await send({ kind: 'checkpoint' });
    expect(checkpoints()).toHaveLength(1);
    written = cp;
    doc = (await send({ kind: 'doc' })).doc!;
    replayed = r.snapshot as Snapshot;
  });

  it('打开时从端口收检查点：对得上就直接恢复，与重放逐值一致', async () => {
    const ch = new MessageChannel();
    // 存储 Worker 那一头：发一条检查点（结构化克隆一份，就像从 IndexedDB 读出来的）
    ch.port1.postMessage({ cp: structuredClone(written!.cp) });
    const r = await send({ kind: 'load', doc: doc!, build: 'b1', checkpoint: ch.port2 });
    ch.port1.close();
    const snap = r.snapshot as Snapshot;
    expect(snap.history.map((h) => h.summary)).toEqual(replayed!.history.map((h) => h.summary));
    const views = Object.entries(replayed!.derived).filter(([, v]) => ArrayBuffer.isView(v));
    expect(views.length).toBeGreaterThan(20);
    for (const [k, v] of views) {
      expect(Array.from(snap.derived[k as keyof Snapshot['derived']] as ArrayLike<number>), k).toEqual(Array.from(v as ArrayLike<number>));
    }
    // 恢复出来的就是检查点里的那一步：页面要隐藏时不必再写
    const before = checkpoints().length;
    await send({ kind: 'checkpoint' });
    expect(checkpoints()).toHaveLength(before);
  });

  it('收到 null、安全模式：照旧重放（安全模式下也不写检查点）', async () => {
    const ch = new MessageChannel();
    ch.port1.postMessage({ cp: null });
    const before = checkpoints().length;
    await send({ kind: 'load', doc: doc!, build: 'b1', checkpoint: ch.port2 });
    ch.port1.close();
    // 重放出来的新引擎：要隐藏时写一次
    await send({ kind: 'checkpoint' });
    expect(checkpoints()).toHaveLength(before + 1);
    // 安全模式：端口里有检查点也不用（检查点里的推导运行过脚本），也不写
    const safe = new MessageChannel();
    safe.port1.postMessage({ cp: structuredClone(written!.cp) as Checkpoint });
    const r = await send({ kind: 'load', doc: doc!, build: 'b1', safe: true, checkpoint: safe.port2 });
    safe.port1.close();
    expect(r.safe).toBe(true);
    await send({ kind: 'checkpoint' });
    expect(checkpoints()).toHaveLength(before + 1);
  });
});
