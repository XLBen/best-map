import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { Checkpoint, WorldDoc } from '../core/engine';
import { newWorldContentCommands } from '../core/packs/import';
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
// 第三十轮：新世界默认加的内容（生态、基础、中文地名）由主线程给，与 set_worldgen 在同一步里
const commands: Command[] = [
  {
    op: 'batch',
    commands: [
      ...newWorldContentCommands().flatMap((c) => (c.op === 'batch' ? c.commands : [c])),
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

  it('打开以后空闲时预热（第三十一轮），收到请求就停下、做完再接着：之后执行的结果与重放的逐值相同', async () => {
    const st = storeEnd();
    st.ch.port1.postMessage({ cp: structuredClone(written!.cp) });
    await send({ kind: 'load', doc: doc!, build: 'b1', store: st.port });
    // 紧接着来的请求：预热还没开始或做到一半，停下
    const land = Array.from((replayed!.causes.land as Uint8Array).entries())
      .filter(([, v]) => v)
      .map(([i]) => i);
    const hill = land.slice(100, 130);
    const relief: Command = { op: 'paint_relief', cells: hill, t: hill.map(() => 0), strength: 0.5 };
    await send({ kind: 'exec', cmd: relief });
    // 空闲一会儿（预热一段一段地做完）
    await new Promise((r) => setTimeout(r, 400));
    const more: Command = { op: 'paint', field: 'erodDelta', cells: land.slice(300, 330), value: 0.3, mode: 'add' };
    await send({ kind: 'exec', cmd: more });
    const snap = (await send({ kind: 'snapshot' })).snapshot as Snapshot;
    const { Engine } = await import('../core/engine');
    const ref = Engine.fromDoc({ ...doc!, commands: [...doc!.commands, relief, more] });
    for (const [k, v] of Object.entries(ref.world.derived)) {
      if (!ArrayBuffer.isView(v)) continue;
      expect(Array.from(snap.derived[k as keyof Snapshot['derived']] as ArrayLike<number>), k).toEqual(Array.from(v as unknown as ArrayLike<number>));
    }
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

// 河流类型（第三批）也在这个 Worker 里算：一遍“气候 → 水文 → 河的类型 → 植被”是引擎里的一个函数，
// match 脚本与生态的脚本一样在这里（隔离的环境里）跑；检查点带着每格的河的类型、两岸的影响，恢复出来与重放逐值一致
describe('计算 Worker 里的河流类型', () => {
  const typed: Command[] = [
    ...commands,
    {
      op: 'set_river_type',
      type: { id: 'blood', name: '血河', color: '#8f1414', bank: { radiusKm: 200, dT: 3 }, scripts: { match: { api: 1, src: 'return 流量 > 0;' } } },
    },
  ];
  const views = (s: Snapshot) => Object.entries(s.derived).filter(([, v]) => ArrayBuffer.isView(v)) as [string, ArrayLike<number>][];

  // 上面最后打开过安全模式：一个 Worker 进了安全模式就一直是（主线程要另开一个）。这里也换一个新的
  beforeAll(async () => {
    vi.resetModules();
    await import('./worker');
  });

  it('match 脚本在这里跑：河格带上类型、两岸变暖；检查点恢复出来与重放逐值一致；安全模式下不运行', async () => {
    const st = storeEnd();
    const r = await send({ kind: 'init', settings, commands: typed, build: 'b2', store: st.port });
    const snap = r.snapshot as Snapshot;
    expect(snap.derived.scriptIssues ?? []).toEqual([]);
    expect(snap.derived.riverType).toBeInstanceOf(Uint8Array);
    expect(Array.from(snap.derived.riverType!).some((v) => v === 1)).toBe(true);
    expect(Array.from(snap.derived.effT!).some((v) => v > 0)).toBe(true);
    await send({ kind: 'checkpoint' });
    await until(() => st.got.length === 1);
    const cp = st.got[0].cp;
    expect(cp.derived.riverType).toEqual(snap.derived.riverType);
    const typedDoc = (await send({ kind: 'doc' })).doc!;
    st.close();
    // 打开：端口里的检查点直接恢复，与刚才算出来的逐值一致
    const back = storeEnd();
    back.ch.port1.postMessage({ cp: structuredClone(cp) });
    const restored = (await send({ kind: 'load', doc: typedDoc, build: 'b2', store: back.port })).snapshot as Snapshot;
    const all = views(snap);
    expect(all.map(([k]) => k)).toEqual(expect.arrayContaining(['riverType', 'effT', 'effP']));
    for (const [k, v] of all) expect(Array.from(restored.derived[k as keyof Snapshot['derived']] as ArrayLike<number>), k).toEqual(Array.from(v));
    back.close();
    // 安全模式：match 脚本不运行，没有河带上类型，也就没有两岸的影响
    const safe = (await send({ kind: 'load', doc: typedDoc, safe: true })).snapshot as Snapshot;
    expect(Array.from(safe.derived.riverType!).every((v) => v === 0)).toBe(true);
    expect(safe.derived.effT).toBeUndefined();
  });
});

// 确切预览分阶段算、阶段之间让出线程：松手执行别的命令、新的一笔（取消）时它在下一个阶段之间停下（回 cancelled），
// 执行不必等它算完；执行同一条命令时不停，执行直接采用它。停下的预览不影响世界
describe('确切预览可以中途停下', () => {
  beforeAll(async () => {
    vi.resetModules();
    await import('./worker');
  });
  // 不等回复地发
  const fire = (req: Request) => {
    const id = nextId++;
    scope.onmessage!({ data: { id, req } });
    return async () => {
      await until(() => posted.some((p) => (p.msg as { id?: number }).id === id));
      return posted.find((p) => (p.msg as { id?: number }).id === id)!.msg as Extract<Response, { ok: true }>;
    };
  };
  const warm: Command = { op: 'set_planet', patch: { humidity: 1.3 } };
  const cold: Command = { op: 'set_planet', patch: { humidity: 0.7 } };

  it('执行别的命令时停下，执行的结果与没有预览时相同', async () => {
    await send({ kind: 'init', settings, commands });
    const preview = fire({ kind: 'previewWorld', cmd: warm });
    const exec = fire({ kind: 'exec', cmd: cold });
    const p = await preview();
    expect(p.cancelled).toBe(true);
    expect(p.preview).toBeUndefined();
    const e = (await exec()).snapshot as Snapshot;
    // 对照：一个新的引擎直接执行
    const plain = (await send({ kind: 'init', settings, commands: [...commands, cold] })).snapshot as Snapshot;
    expect(Array.from(e.derived.precip)).toEqual(Array.from(plain.derived.precip));
    expect(Array.from(e.derived.dominant)).toEqual(Array.from(plain.derived.dominant));
  });

  it('取消：停下，之后照常预览；已经发了同一条命令的执行时不停（执行直接采用）', async () => {
    await send({ kind: 'init', settings, commands });
    const preview = fire({ kind: 'previewWorld', cmd: warm });
    await send({ kind: 'cancelPreview' });
    expect((await preview()).cancelled).toBe(true);
    const again = fire({ kind: 'previewWorld', cmd: warm });
    const exec = fire({ kind: 'exec', cmd: warm });
    fire({ kind: 'cancelPreview' });
    const p = await again();
    expect(p.cancelled).toBeUndefined();
    expect(p.preview).toBeDefined();
    const e = (await exec()).snapshot as Snapshot;
    const plain = (await send({ kind: 'init', settings, commands: [...commands, warm] })).snapshot as Snapshot;
    expect(Array.from(e.derived.precip)).toEqual(Array.from(plain.derived.precip));
  });
});

// 快照只带变了的推导数组：没变的写 null、列进 same（主线程沿用自己的）；拼起来与完整的快照逐值相同。
// 新建、打开、要完整的快照时是完整的
describe('快照只带变了的数组', () => {
  beforeAll(async () => {
    vi.resetModules();
    await import('./worker');
  });
  const filled = (s: Snapshot, prev: Snapshot) => {
    const d = { ...s.derived } as unknown as Record<string, unknown>;
    const p = prev.derived as unknown as Record<string, Float32Array>;
    for (const k of s.same!.derived) d[k] = p[k];
    for (const [k, part] of Object.entries(s.same!.rows)) {
      const out = p[k].slice();
      const width = out.length / s.causes.land.length;
      const rows = part.rows as Float32Array;
      part.idx.forEach((i, q) => out.set(rows.subarray(q * width, (q + 1) * width), i * width));
      d[k] = out;
    }
    return d;
  };

  it('只改冷暖：高程、汇流等没变的不发；拼起来与完整的相同', async () => {
    const first = (await send({ kind: 'init', settings, commands })).snapshot as Snapshot;
    expect(first.same).toBeUndefined();
    const land = [...first.causes.land.keys()].filter((i) => first.causes.land[i]).slice(0, 80);
    const r = (await send({ kind: 'exec', cmd: { op: 'paint', field: 'tempOffset', cells: land, value: -3, mode: 'add' } })).snapshot as Snapshot;
    expect(r.same?.base).toBe(first.stateId);
    expect(r.same?.derived).toEqual(expect.arrayContaining(['elevation', 'receiver']));
    expect(r.derived.elevation).toBeNull();
    // 冷暖只动了一片：份额只带变了的格
    expect(Object.keys(r.same!.rows).length).toBeGreaterThan(0);
    const full = (await send({ kind: 'snapshot' })).snapshot as Snapshot;
    expect(full.same).toBeUndefined();
    const d = filled(r, first);
    for (const [k, v] of Object.entries(full.derived)) if (ArrayBuffer.isView(v)) expect(Array.from(d[k] as ArrayLike<number>), k).toEqual(Array.from(v as unknown as ArrayLike<number>));
    // 撤销：换回存着的推导，相对上一份（完整的）只带变了的
    const u = (await send({ kind: 'undo' })).snapshot as Snapshot;
    expect(u.same?.base).toBe(full.stateId);
    const du = filled(u, full);
    for (const [k, v] of Object.entries(first.derived)) if (ArrayBuffer.isView(v)) expect(Array.from(du[k] as ArrayLike<number>), k).toEqual(Array.from(v as unknown as ArrayLike<number>));
  });

  // 第十三轮：地图上的河在 Worker 里描好随快照转交（主线程不再描）：拆开的与主线程按快照拼出的世界描的逐位相同，
  // 只带变了的数组的快照也一样；预览世界的河随预览的回复送来
  it('快照带着描好的河：与按快照拼出的世界描的逐位相同；预览世界的河也送来', async () => {
    const { traceRivers } = await import('../core/rivers');
    const { unpackRivers } = await import('../core/river-pack');
    const { buildMeshFor, kmPerUnit } = await import('../core/world');
    const worldOf = (snap: Snapshot, derived: unknown) => ({ settings: snap.settings, mesh: buildMeshFor(snap.settings), kmPerUnit: kmPerUnit(snap.settings), causes: snap.causes, small: snap.small, derived }) as never;
    type L = ReturnType<typeof traceRivers>;
    const json = (ls: L) => JSON.stringify(ls.map((l) => [l.points, l.flow, l.cells ?? null, l.mul ?? null, l.type ?? null, l.head ?? null, l.mouth ?? null, l.into ?? null, l.guide ?? null, l.joins ?? null]));
    const first = (await send({ kind: 'init', settings, commands })).snapshot as Snapshot;
    expect(first.rivers).toBeDefined();
    const w0 = worldOf(first, first.derived);
    const here = traceRivers(w0);
    expect(here.length).toBeGreaterThan(3);
    expect(json(unpackRivers(first.rivers!).lines)).toBe(json(here));
    const r = (await send({ kind: 'exec', cmd: { op: 'set_planet', patch: { humidity: 1.2 } } })).snapshot as Snapshot;
    expect(r.same).toBeDefined();
    const w1 = worldOf(r, filled(r, first));
    expect(json(unpackRivers(r.rivers!).lines)).toBe(json(traceRivers(w1)));
    const pv = await send({ kind: 'previewWorld', cmd: { op: 'set_planet', patch: { humidity: 1.3 } } });
    expect(pv.rivers).toBeDefined();
    expect(unpackRivers(pv.rivers!).draws).not.toBeNull();
  });
});

describe('整理本世界的计划、移出的内容（第二十九轮）', () => {
  it('planTidy 在副本上算，世界不变；only 只看那几项；exec 的回复带着这一步移出的内容', async () => {
    await send({ kind: 'init', settings, commands });
    const before = (await send({ kind: 'doc' })).doc!.commands.length;
    const all = await send({ kind: 'planTidy' });
    expect(all.tidy).toMatchObject({ removed: expect.any(Array), kept: expect.any(Array) });
    expect((await send({ kind: 'planTidy', only: [] })).tidy!.command).toBeNull();
    expect((await send({ kind: 'doc' })).doc!.commands.length).toBe(before);
    const sp = { id: 'mine', name: '我的', color: '#123456', terrain: 'plains', competition: 3, tolerances: [], natural: false };
    await send({ kind: 'exec', cmd: { op: 'add_species', species: sp } as Command });
    const r = await send({ kind: 'exec', cmd: { op: 'remove_species', id: 'mine' } });
    expect(r.removed?.map((x) => [x.kind, x.id])).toEqual([['biome', 'mine']]);
  });
});
