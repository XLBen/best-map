import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import { worldDigest } from '../core/digest';
import { Engine, type WorldDoc } from '../core/engine';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { meshFor } from '../core/testing/fixtures';
import type { Request, Response, StagePing } from './protocol';
import { pacing } from './worker-steps';

// 第九十七轮：计算 Worker 本身——带提示的一步在每一步开头说走到哪了；久的一步在阶段之间让出线程、听得到“取消”，
// 取消了世界原样退回（和从来没做过这一步一样），不带提示的（预览）不说。
// 这里没有真的 Worker：全局的 self 是假的（和 worker.test.ts 一样）

const posted: unknown[] = [];
// 每发出一条消息时叫一声（测试在计算正做到某一步的时候塞进一条“取消”）
let onPost: ((msg: unknown) => void) | null = null;
const scope: { origin: string; onmessage: ((ev: { data: unknown }) => void) | null; postMessage(msg: unknown): void } = {
  origin: 'http://localhost:5191',
  onmessage: null,
  postMessage: (msg) => {
    posted.push(msg);
    onPost?.(msg);
  },
};
vi.stubGlobal('self', scope);
await import('./worker');

let nextId = 1;
function post(req: Request): number {
  const id = nextId++;
  scope.onmessage!({ data: { id, req } });
  return id;
}
async function replyTo(id: number): Promise<Response> {
  for (let k = 0; k < 5000; k++) {
    const hit = posted.find((m) => (m as { id?: number }).id === id);
    if (hit) return hit as Response;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('等不到回复');
}
async function send(req: Request): Promise<Extract<Response, { ok: true }>> {
  const r = await replyTo(post(req));
  if (!r.ok) throw new Error(r.error);
  return r;
}
const stagesOf = (id: number) => posted.filter((m): m is StagePing => (m as StagePing).kind === 'stage' && (m as StagePing).req === id);

const settings = { cells: 2000, seed: 4 };
const groups = ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => n.id);
// 新建时的命令和向导发的一样排：先加内容、造陆地（一步），生成人文，划省份。时代的内容在本地的一个引擎上算好
const first: Command = { op: 'batch', commands: [...newWorldContentCommands().flatMap((c) => (c.op === 'batch' ? c.commands : [c])), { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true }] };
const local = new Engine(settings, meshFor(settings));
local.exec(first);
const imports = packImportCommands(builtinPacks(), { packs: [['medieval']], groups }, local.world);
const human: Command = { op: 'generate_human', packs: [['medieval']], groups, countries: {}, settlements: {} };
const commands: Command[] = [first, ...imports, human, { op: 'generate_provinces', seed: 4 }];
for (const c of commands.slice(1)) local.exec(c);

const docNow = async (): Promise<WorldDoc> => (await send({ kind: 'doc' })).doc!;
const regen: Command = { op: 'regenerate_human', keepManual: false, countries: {} };

describe('计算 Worker 说走到哪一步了', () => {
  it('新建：建网格、造陆地、流水线的各步、生成人文的各步、城市、省份——都带着这个请求的编号；结果和不说时一样', async () => {
    const id = post({ kind: 'init', settings, commands });
    const r = await replyTo(id);
    expect(r.ok).toBe(true);
    const steps = stagesOf(id).map((s) => s.step);
    expect(steps[0]).toBe('mesh');
    const order = ['mesh', 'terrain', 'elevation', 'climate', 'water', 'habitat', 'features', 'human.cultures', 'human.population', 'human.countries', 'human.claims', 'human.blocs', 'human.capitals', 'human.country-mix', 'settlements', 'provinces'];
    let at = -1;
    for (const step of order) {
      const next = steps.indexOf(step, at + 1);
      expect(next, `${step} 在 ${steps.join(' ')} 里、按先后`).toBeGreaterThan(at);
      at = next;
    }
    for (const s of stagesOf(id)) {
      expect(s.inner).toBeUndefined();
      expect(s.k >= 1 && s.k <= s.n, JSON.stringify(s)).toBe(true);
    }
    // 一次新建说的不多：几十条以内
    expect(steps.length).toBeLessThan(60);
    // 世界文件和本地照样做的一字不差
    expect(await docNow()).toEqual(local.toDoc());
  });

  it('不带提示的（预览、要世界文件）不说', async () => {
    const before = posted.filter((m) => (m as StagePing).kind === 'stage').length;
    await send({ kind: 'preview', cmd: { op: 'set_planet', patch: { humidity: 1.2 } } });
    await send({ kind: 'previewWorld', cmd: { op: 'set_planet', patch: { humidity: 1.3 } } });
    await send({ kind: 'cancelPreview' });
    await docNow();
    expect(posted.filter((m) => (m as StagePing).kind === 'stage').length).toBe(before);
  });
});

describe('久的一步：阶段之间让出线程，能取消', () => {
  it('让出着走完的一步，结果和一口气走完的一样', async () => {
    pacing.yieldAfter = 0;
    try {
      const id = post({ kind: 'exec', cmd: regen });
      const r = await replyTo(id);
      expect(r.ok).toBe(true);
      expect(stagesOf(id).map((s) => s.step)).toEqual(['human.cultures', 'human.population', 'human.countries', 'human.claims', 'human.blocs', 'human.capitals', 'human.country-mix', 'settlements']);
      local.exec(regen);
      expect(await docNow()).toEqual(local.toDoc());
      const again = Engine.fromDoc(await docNow(), meshFor(settings));
      expect(worldDigest(again.world)).toBe(worldDigest(local.world));
    } finally {
      pacing.yieldAfter = 500;
    }
  });

  it('做到一半取消：回 soft，世界文件、历史和这一步之前一样；重做记录还在；之后照常', async () => {
    // 先撤销一步：重做记录要原样回来
    await send({ kind: 'undo' });
    local.undo();
    const before = await docNow();
    expect(before).toEqual(local.toDoc());
    pacing.yieldAfter = 0;
    let id = 0;
    let cancelId = 0;
    // 计算正做到“分人口”的时候，主线程的“取消”到了
    onPost = (msg) => {
      const m = msg as StagePing;
      if (m.kind !== 'stage' || m.req !== id || m.step !== 'human.population' || cancelId) return;
      cancelId = nextId++;
      scope.onmessage!({ data: { id: cancelId, req: { kind: 'cancel', upTo: id } } });
    };
    try {
      id = post({ kind: 'exec', cmd: { op: 'regenerate_countries' } });
      const r = await replyTo(id);
      expect(r).toEqual({ id, ok: false, error: '已取消', soft: true });
      // 取消本身马上回了（在那一步的回复之前）
      const order = posted.map((m) => (m as { id?: number }).id);
      expect(order.indexOf(cancelId)).toBeGreaterThan(-1);
      expect(order.indexOf(cancelId)).toBeLessThan(order.indexOf(id));
      // 停在“分人口”之后的那个边界：后面的几步没有做
      expect(stagesOf(id).map((s) => s.step)).toEqual(['human.cultures', 'human.population']);
    } finally {
      onPost = null;
      pacing.yieldAfter = 500;
    }
    expect(await docNow()).toEqual(before);
    // 重做记录还在
    const redone = await send({ kind: 'redo' });
    expect(redone.snapshot && 'canRedo' in redone.snapshot && redone.snapshot.canRedo).toBe(false);
    local.redo();
    expect(await docNow()).toEqual(local.toDoc());
    // 再做同一步：和从来没取消过的一样
    await send({ kind: 'exec', cmd: { op: 'regenerate_countries' } });
    local.exec({ op: 'regenerate_countries' });
    expect(await docNow()).toEqual(local.toDoc());
    expect(worldDigest(Engine.fromDoc(await docNow(), meshFor(settings)).world)).toBe(worldDigest(local.world));
  });

  it('排着还没轮到就取消了的：不算，回 soft；取消之后才发的照常算', async () => {
    const before = await docNow();
    const a = post({ kind: 'exec', cmd: { op: 'set_planet', patch: { humidity: 1.3 } } });
    const b = post({ kind: 'exec', cmd: { op: 'set_planet', patch: { humidity: 1.4 } } });
    const c = post({ kind: 'cancel', upTo: b });
    const d = post({ kind: 'exec', cmd: { op: 'set_planet', patch: { humidity: 1.5 } } });
    expect(await replyTo(c)).toEqual({ id: c, ok: true });
    expect(await replyTo(a)).toEqual({ id: a, ok: false, error: '已取消', soft: true });
    expect(await replyTo(b)).toEqual({ id: b, ok: false, error: '已取消', soft: true });
    expect((await replyTo(d)).ok).toBe(true);
    expect(stagesOf(a)).toEqual([]);
    // 只多了取消之后发的那一步（和本地照样做的一字不差：这一步记进命令的名字、人口的修补也一样）
    local.exec({ op: 'set_planet', patch: { humidity: 1.5 } });
    const now = await docNow();
    expect(now.commands.length).toBe(before.commands.length + 1);
    expect(now).toEqual(local.toDoc());
  });

  it('撤销做到一半取消：那一步放回去，世界文件不变', async () => {
    // 新开的引擎里没有存着的推导时撤销才重算：先打开同一份世界文件（重放），再撤销
    await send({ kind: 'load', doc: await docNow() });
    const before = await docNow();
    pacing.yieldAfter = 0;
    let id = 0;
    let sent = false;
    onPost = (msg) => {
      const m = msg as StagePing;
      if (m.kind !== 'stage' || m.req !== id || m.step !== 'climate' || sent) return;
      sent = true;
      scope.onmessage!({ data: { id: nextId++, req: { kind: 'cancel', upTo: id } } });
    };
    try {
      id = post({ kind: 'undo' });
      const r = await replyTo(id);
      expect(sent, '撤销重算到了气候那一步').toBe(true);
      expect(r).toEqual({ id, ok: false, error: '已取消', soft: true });
    } finally {
      onPost = null;
      pacing.yieldAfter = 500;
    }
    expect(await docNow()).toEqual(before);
    // 之后照常撤销
    await send({ kind: 'undo' });
    expect((await docNow()).commands).toEqual(before.commands.slice(0, -1));
  });
});

describe('打开世界（重放命令）', () => {
  it('说“第几条 / 共几条”，从 0 到最后一条，只增不减；里面的小步标着 inner；最后一次重算是照常的几步', async () => {
    const doc = local.toDoc();
    const id = post({ kind: 'load', doc });
    const r = await replyTo(id);
    expect(r.ok).toBe(true);
    const all = stagesOf(id);
    expect(all[0].step).toBe('mesh');
    const replay = all.filter((s) => s.step === 'replay');
    expect(replay[0]).toMatchObject({ k: 0, n: doc.commands.length });
    expect(replay.at(-1)).toMatchObject({ k: doc.commands.length, n: doc.commands.length });
    for (let k = 1; k < replay.length; k++) expect(replay[k].k).toBeGreaterThan(replay[k - 1].k);
    for (const s of replay) expect(s.inner).toBeUndefined();
    // 重放中间的小步（生成人文要先算推导、生成的各步）只当名字
    const lastReplay = all.lastIndexOf(replay.at(-1)!);
    const during = all.slice(all.indexOf(replay[0]) + 1, lastReplay).filter((s) => s.step !== 'replay');
    expect(during.length).toBeGreaterThan(0);
    for (const s of during) expect(s.inner, s.step).toBe(true);
    for (const s of all.slice(lastReplay + 1)) expect(s.inner, s.step).toBeUndefined();
  });
});
