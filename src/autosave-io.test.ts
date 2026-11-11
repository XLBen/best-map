import { describe, expect, it } from 'vitest';
import { DOC_VERSION } from '../core/doc-version';
import type { DocTail } from '../core/engine';
import { type AutosaveHead, AutosaveWriter, type FullDoc, type MemoryDisk, continues, diskRaw, memoryAutosaveIo, memoryDisk, wholeDoc } from './autosave-io';
import { damaged, staleWhy } from './backups';

// 第九十四轮：两个页面开着同一个地址、各做各的世界。
// 前半是复现：第九十三轮的“写什么”原样搬到假的存储上，两页交替写，读出来的不是任何一页的世界。
// 后半是现在的写法（AutosaveWriter）：同样的交替，存着的总是某一页完整的世界；被盖掉的不一样的世界先留着

const settings = (seed: number) => ({ seed, cells: 3000, aspect: 2, latNorth: 60, latSouth: 20 }) as unknown as DocTail['settings'];

// 引擎的替身：只有命令记录和 docTail（core/engine.ts 的 docTail 原样）
class FakeEngine {
  done: { id: number; cmd: { op: string; who: string; n: number } }[] = [];
  private seq = 0;
  constructor(
    readonly who: string,
    readonly seed: number,
    steps: number,
  ) {
    for (let k = 0; k < steps; k++) this.exec();
  }
  exec(who = this.who) {
    this.done.push({ id: ++this.seq, cmd: { op: 'set_name', who, n: this.done.length } });
  }
  undo() {
    this.done.pop();
  }
  toDoc() {
    return { format: 'map2-world' as const, version: DOC_VERSION as typeof DOC_VERSION, settings: settings(this.seed), commands: this.done.map((h) => h.cmd) };
  }
  docTail(savedIds: readonly number[]): DocTail {
    let from = 0;
    while (from < savedIds.length && from < this.done.length && savedIds[from] === this.done[from].id) from++;
    const { commands: _, ...head } = this.toDoc();
    return { ...head, from, commands: this.done.slice(from).map((h) => h.cmd), ids: this.done.map((h) => h.id) } as unknown as DocTail;
  }
  full(key = this.who): FullDoc {
    return { ...this.toDoc(), ids: this.done.map((h) => h.id), key };
  }
}

// 读：readAutosave 的读法（头里写的条数那一段；条数对不上、不是这一版时不能打开）
function readBack(disk: MemoryDisk): { doc: unknown; ok: boolean } | null {
  const raw = diskRaw(disk);
  if (!raw || !disk.head) return null;
  return { doc: raw.doc, ok: wholeDoc(disk.head, (raw.doc as { commands: unknown[] }).commands) };
}

// ---------- 复现：第九十三轮的写法 ----------

// src/state/autosave.ts（f52d981）第 92–119 行“写什么”的那一段，原样搬到假的存储上：
// 每个页面各自的 savedIds / savedCount，只把变了的命令按下标写，头整个换成自己的
class OldPage {
  savedIds: number[] = [];
  savedCount = -1;
  constructor(
    readonly disk: MemoryDisk,
    readonly engine: FakeEngine,
  ) {}
  autosave(now = 1) {
    const { from, commands, ids, ...head } = this.engine.docTail(this.savedIds);
    const meta = { ...head, savedAt: now, count: ids.length } as AutosaveHead;
    if (this.savedCount < 0) this.savedCount = this.disk.head?.count ?? 0;
    const stale = this.savedCount;
    // 一个事务
    commands.forEach((c, k) => this.disk.rows.set(from + k, c));
    if (stale > meta.count) for (let k = meta.count; k <= stale - 1; k++) this.disk.rows.delete(k);
    this.disk.head = meta;
    this.savedIds = ids;
    this.savedCount = meta.count;
  }
}

describe('复现：第九十三轮的写法，两个页面交替写', () => {
  it('两个不同的世界（后开的那个步数多）：读出来是甲的头配上乙的命令再接甲的一步——谁的世界都不是', () => {
    const disk = memoryDisk();
    const a = new OldPage(disk, new FakeEngine('甲', 1, 5));
    const b = new OldPage(disk, new FakeEngine('乙', 2, 8));
    a.autosave();
    b.autosave();
    // 到这里还是乙完整的世界
    expect(readBack(disk)!.doc).toEqual(b.engine.toDoc());
    // 甲再画一笔
    a.engine.exec();
    a.autosave();
    const got = readBack(disk)!;
    // 条数对得上，读的时候看不出来：照样会被打开
    expect(got.ok).toBe(true);
    expect(got.doc).not.toEqual(a.engine.toDoc());
    expect(got.doc).not.toEqual(b.engine.toDoc());
    const doc = got.doc as { settings: { seed: number }; commands: { who: string }[] };
    expect(doc.settings.seed).toBe(1);
    expect(doc.commands.map((c) => c.who).join('')).toBe('乙乙乙乙乙甲');
  });

  it('两个不同的世界（后开的那个步数少）：条数对不上，下次打开当作没有——两边都丢了', () => {
    const disk = memoryDisk();
    const a = new OldPage(disk, new FakeEngine('甲', 1, 8));
    const b = new OldPage(disk, new FakeEngine('乙', 2, 3));
    a.autosave();
    b.autosave();
    a.engine.exec();
    a.autosave();
    const got = readBack(disk)!;
    expect(disk.head!.count).toBe(9);
    expect((got.doc as { commands: unknown[] }).commands.length).toBe(4);
    expect(got.ok).toBe(false);
  });

  it('同一个世界在两个页面里各自接着做：各画几笔以后也是拼出来的', () => {
    const disk = memoryDisk();
    const first = new OldPage(disk, new FakeEngine('原', 1, 4));
    first.autosave();
    // 两个页面都打开了这一份（各自的引擎重放出同样的 4 步），各做各的
    const a = new OldPage(disk, new FakeEngine('原', 1, 4));
    const b = new OldPage(disk, new FakeEngine('原', 1, 4));
    a.autosave();
    b.autosave();
    for (const [page, who] of [
      [a, '甲'],
      [a, '甲'],
      [b, '乙'],
      [a, '甲'],
    ] as const) {
      page.engine.done.push({ id: page.engine.done.length + 1, cmd: { op: 'set_name', who, n: page.engine.done.length } });
      page.autosave();
    }
    const got = readBack(disk)!;
    expect(got.ok).toBe(true);
    const who = (got.doc as { commands: { who: string }[] }).commands.map((c) => c.who).join('');
    // 甲的世界是 原原原原甲甲甲，乙的是 原原原原乙
    expect(who).toBe('原原原原乙甲甲');
  });
});

// ---------- 现在的写法 ----------

class Page {
  writer: AutosaveWriter;
  lost = 0;
  constructor(
    readonly disk: MemoryDisk,
    public engine: FakeEngine,
    opts: { id?: string; lockless?: boolean; holder?: boolean } = {},
  ) {
    this.writer = new AutosaveWriter(memoryAutosaveIo(disk), opts.id ?? engine.who, opts.lockless ?? false, { lost: () => this.lost++ });
    this.writer.holder = opts.holder ?? true;
  }
  // 照 state/autosave.ts：要整份时再取一次
  async autosave(now = 1) {
    const once = () => {
      const base = this.writer.savedIds;
      return this.writer.write(this.engine.docTail(base), {}, { base, key: this.engine.who, now });
    };
    const out = await once();
    return out.kind === 'again' ? once() : out;
  }
  // 打开了存着的那一份
  open() {
    const raw = diskRaw(this.disk)!;
    this.writer.opened = { writer: raw.writer ?? null, gen: raw.gen ?? null, savedAt: raw.savedAt, count: raw.count ?? -1 };
    const doc = raw.doc as { commands: { op: string; who: string; n: number }[] };
    this.engine = new FakeEngine(this.engine.who, this.engine.seed, 0);
    for (const cmd of doc.commands) this.engine.exec(cmd.who);
  }
}

const stored = (disk: MemoryDisk) => readBack(disk)!.doc;

describe('一个页面：只写变了的', () => {
  it('第一次整份写，之后只写新的几步；撤销以后多出来的删掉；头里记着谁写的、第几代', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 5));
    expect(await p.autosave(10)).toMatchObject({ kind: 'saved', kept: null });
    expect(disk.head).toMatchObject({ writer: '甲', gen: 1, count: 5, savedAt: 10 });
    expect(stored(disk)).toEqual(p.engine.toDoc());
    p.engine.exec();
    const before = new Map(disk.rows);
    await p.autosave(20);
    // 前面的 5 条没有重写（还是同一个对象）
    for (let k = 0; k < 5; k++) expect(disk.rows.get(k)).toBe(before.get(k));
    expect(disk.head).toMatchObject({ gen: 2, count: 6 });
    p.engine.undo();
    p.engine.undo();
    await p.autosave(30);
    expect(disk.rows.size).toBe(4);
    expect(stored(disk)).toEqual(p.engine.toDoc());
    expect(readBack(disk)!.ok).toBe(true);
  });

  it('世界文件的头里不带谁写的、第几代、条数这些', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 2));
    await p.writer.write(p.engine.docTail([]), { safe: '原因', mapId: 'm1', mapSynced: true }, { base: p.writer.savedIds, now: 5 });
    expect(disk.head).toMatchObject({ safe: '原因', mapId: 'm1', mapSynced: true });
    expect(Object.keys(stored(disk) as object).sort()).toEqual(['commands', 'format', 'settings', 'version']);
    expect(diskRaw(disk)).toMatchObject({ savedAt: 5, count: 2, writer: '甲', gen: 1, safe: '原因', mapId: 'm1' });
  });

  it('换了一个世界（同一个页面）：从头写，原来那一份是自己写的，不用留', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 6));
    await p.autosave();
    const next = new FakeEngine('甲', 7, 3);
    p.writer.forget();
    const out = await p.writer.write(next.docTail(p.writer.savedIds), {}, { base: p.writer.savedIds, key: 'k2', now: 2 });
    expect(out).toMatchObject({ kind: 'saved', kept: null });
    expect(stored(disk)).toEqual(next.toDoc());
    expect(disk.rows.size).toBe(3);
    expect(disk.backups.size).toBe(0);
  });
});

describe('两个页面：不再写混', () => {
  it('没拿到锁的页面不写：存着的一直是拿着锁的那一页完整的世界', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('甲', 1, 5));
    const b = new Page(disk, new FakeEngine('乙', 2, 8), { holder: false });
    await a.autosave();
    expect(await b.autosave()).toEqual({ kind: 'other' });
    a.engine.exec();
    await a.autosave();
    b.engine.exec();
    expect(await b.autosave()).toEqual({ kind: 'other' });
    expect(stored(disk)).toEqual(a.engine.toDoc());
    expect(disk.backups.size).toBe(0);
  });

  it('“在这里接着做”：整份重写成这一页的世界；那一页存着的不一样的世界先原样留着；那一页不再写', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('甲', 1, 5));
    const b = new Page(disk, new FakeEngine('乙', 2, 8), { holder: false });
    await a.autosave(100);
    const was = structuredClone(stored(disk));
    // 乙把写的权利拿过来，甲让出
    b.writer.claim();
    a.writer.yield();
    const out = await b.autosave(200);
    expect(out.kind).toBe('saved');
    expect(stored(disk)).toEqual(b.engine.toDoc());
    expect(disk.head).toMatchObject({ writer: '乙', count: 8 });
    // 甲的那一份留着，一字不差
    const kept = [...disk.backups.values()];
    expect(kept.length).toBe(1);
    expect(kept[0]).toMatchObject({ age: 'current', why: 'other-page', savedAt: 100, steps: 5 });
    expect(kept[0].doc).toEqual(was);
    // 甲接着画：不写（头不是它的了，它也没有写的权利）
    a.engine.exec();
    expect(await a.autosave(300)).toEqual({ kind: 'other' });
    expect(stored(disk)).toEqual(b.engine.toDoc());
    // 乙接着画：按下标只写新的
    b.engine.exec();
    await b.autosave(400);
    expect(stored(disk)).toEqual(b.engine.toDoc());
    expect(disk.backups.size).toBe(1);
  });

  it('两个页面打开的是同一份、第二个页面接过去：存着的就是它的开头，不用留', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('原', 1, 4), { id: '甲' });
    await a.autosave();
    const b = new Page(disk, new FakeEngine('原', 1, 0), { id: '乙', holder: false });
    b.open();
    b.engine.exec('乙');
    b.writer.claim();
    a.writer.yield();
    expect(await b.autosave()).toMatchObject({ kind: 'saved', kept: null });
    expect(stored(disk)).toEqual(b.engine.toDoc());
    expect(disk.backups.size).toBe(0);
  });

  it('第一个页面后来又做了几步、第二个页面才接过去：那几步不在第二个页面里，先留着', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('原', 1, 4), { id: '甲' });
    await a.autosave();
    const b = new Page(disk, new FakeEngine('原', 1, 0), { id: '乙', holder: false });
    b.open();
    a.engine.exec('甲');
    a.engine.exec('甲');
    await a.autosave(50);
    const was = structuredClone(stored(disk));
    b.engine.exec('乙');
    b.writer.claim();
    a.writer.yield();
    const out = await b.autosave(60);
    expect(out).toMatchObject({ kind: 'saved' });
    expect([...disk.backups.values()].map((x) => x.doc)).toEqual([was]);
    expect(stored(disk)).toEqual(b.engine.toDoc());
  });

  it('那一页关了、锁空出来：存着的是这一页的开头才接着写；那一页后来又做过就不接', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('原', 1, 4), { id: '甲' });
    await a.autosave();
    const b = new Page(disk, new FakeEngine('原', 1, 0), { id: '乙', holder: false });
    b.open();
    b.engine.exec('乙');
    expect(await b.writer.canPromote(b.engine.full())).toBe(true);
    a.engine.exec('甲');
    await a.autosave();
    expect(await b.writer.canPromote(b.engine.full())).toBe(false);
    // 还没有世界的页面（停在向导上）：没有什么会被盖掉
    expect(await b.writer.canPromote(null)).toBe(true);
    disk.down = true;
    expect(await b.writer.canPromote(b.engine.full())).toBe(false);
  });

  it('新的一页打开了存着的那一份：第一次写不用读一遍来比（头就是它打开的那一份）', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('原', 1, 4), { id: '甲' });
    await a.autosave();
    const io = memoryAutosaveIo(disk);
    let raws = 0;
    const b = new Page(disk, new FakeEngine('原', 1, 0), { id: '乙' });
    b.writer = new AutosaveWriter({ ...io, raw: () => (raws++, io.raw()) }, '乙', false);
    b.open();
    b.engine.exec();
    expect(await b.autosave()).toMatchObject({ kind: 'saved', kept: null });
    expect(raws).toBe(0);
    expect(disk.head).toMatchObject({ writer: '乙', gen: 2, count: 5 });
  });

  it('上次的世界没打开就新建了：第一次写之前把它原样留着，写着为什么', async () => {
    const disk = memoryDisk();
    const old = new Page(disk, new FakeEngine('旧', 1, 6), { id: '上一次' });
    await old.autosave(77);
    const was = structuredClone(stored(disk));
    const p = new Page(disk, new FakeEngine('新', 9, 2), { id: '这一次' });
    p.writer.keepWhy = { why: 'failed', error: '重放第 3 步出错' };
    const out = await p.autosave(88);
    expect(out.kind).toBe('saved');
    expect(out.kind === 'saved' && out.kept).toMatchObject({ why: 'failed', error: '重放第 3 步出错', savedAt: 77, keptAt: 88, version: DOC_VERSION });
    expect([...disk.backups.values()][0].doc).toEqual(was);
    expect(stored(disk)).toEqual(p.engine.toDoc());
  });

  it('要留的那一份留不下来（存储满了）：不写，原来的还在', async () => {
    const disk = memoryDisk();
    const old = new Page(disk, new FakeEngine('旧', 1, 6), { id: '上一次' });
    await old.autosave();
    const was = structuredClone(stored(disk));
    const p = new Page(disk, new FakeEngine('新', 9, 2), { id: '这一次' });
    disk.full = true;
    expect((await p.autosave()).kind).toBe('keep-failed');
    expect(stored(disk)).toEqual(was);
    // 腾出地方以后再写：留下、写成
    disk.full = false;
    expect((await p.autosave()).kind).toBe('saved');
    expect(disk.backups.size).toBe(1);
  });

  it('存储满了、用不了：抛错（调用方分原因），存着的不变', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 3));
    await p.autosave();
    const was = structuredClone(stored(disk));
    p.engine.exec();
    disk.full = true;
    await expect(p.autosave()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    disk.full = false;
    disk.down = true;
    await expect(p.autosave()).rejects.toThrow();
    disk.down = false;
    expect(stored(disk)).toEqual(was);
    await p.autosave();
    expect(stored(disk)).toEqual(p.engine.toDoc());
  });
});

describe('没有锁可用：靠头里的“谁写的”', () => {
  it('后开的页面第一次写就接过去（整份）；先开的那一页下一次写时发现头不是自己的，不写、告诉界面', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('甲', 1, 5), { lockless: true });
    await a.autosave();
    const b = new Page(disk, new FakeEngine('乙', 2, 8), { lockless: true });
    expect((await b.autosave()).kind).toBe('saved');
    expect(disk.backups.size).toBe(1);
    a.engine.exec();
    expect(await a.autosave()).toEqual({ kind: 'other' });
    expect(a.lost).toBe(1);
    expect(a.writer.holder).toBe(false);
    expect(stored(disk)).toEqual(b.engine.toDoc());
    // 之后一直不写
    a.engine.exec();
    expect(await a.autosave()).toEqual({ kind: 'other' });
    expect(a.lost).toBe(1);
    // 甲点“在这里接着做”：整份重写，乙的留着；乙下一次写时让出
    a.writer.claim();
    expect((await a.autosave()).kind).toBe('saved');
    expect(stored(disk)).toEqual(a.engine.toDoc());
    expect(disk.backups.size).toBe(2);
    b.engine.exec();
    expect(await b.autosave()).toEqual({ kind: 'other' });
    expect(b.lost).toBe(1);
  });

  it('怎么交替都不会写混：存着的总是某一页那时完整的世界', async () => {
    const disk = memoryDisk();
    const pages = [new Page(disk, new FakeEngine('甲', 1, 5), { lockless: true }), new Page(disk, new FakeEngine('乙', 2, 8), { lockless: true }), new Page(disk, new FakeEngine('丙', 3, 2), { lockless: true })];
    // 固定的一串“谁做什么”：画、撤销、存、接过去
    let x = 12345;
    const rnd = (n: number) => ((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 8) % n;
    for (let step = 0; step < 400; step++) {
      const p = pages[rnd(3)];
      const what = rnd(10);
      if (what < 4) p.engine.exec();
      else if (what < 5 && p.engine.done.length > 1) p.engine.undo();
      else if (what < 9) await p.autosave(step);
      else p.writer.claim();
      const got = readBack(disk);
      if (!got) continue;
      expect(got.ok).toBe(true);
      const who = new Set((got.doc as { commands: { who: string }[] }).commands.map((c) => c.who));
      expect(who.size).toBe(1);
      const owner = pages.find((q) => q.engine.who === [...who][0])!;
      expect((got.doc as { settings: { seed: number } }).settings.seed).toBe(owner.engine.seed);
    }
  });
});

describe('关页面的那一下：不读头，同步发出去', () => {
  it('拿着锁、写成过：没写的尾巴发出去；没有新的就不发', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 5));
    await p.autosave();
    expect(p.writer.blind(p.engine.full(), {})).toBe('nothing');
    p.engine.exec();
    p.engine.exec();
    const commits = disk.commits;
    expect(p.writer.blind(p.engine.full(), {}, 9)).toBe('sent');
    expect(disk.commits).toBe(commits + 1);
    expect(stored(disk)).toEqual(p.engine.toDoc());
    expect(disk.head).toMatchObject({ writer: '甲', gen: 2, count: 7, savedAt: 9 });
    // 页面还活着（只是切走了）：之后照常只写变了的
    p.engine.undo();
    expect((await p.autosave()).kind).toBe('saved');
    expect(stored(disk)).toEqual(p.engine.toDoc());
    expect(disk.rows.size).toBe(6);
  });

  it('撤销过：多出来的删掉', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 5));
    await p.autosave();
    p.engine.undo();
    p.engine.undo();
    p.engine.exec();
    expect(p.writer.blind(p.engine.full(), {})).toBe('sent');
    expect(stored(disk)).toEqual(p.engine.toDoc());
    expect(disk.rows.size).toBe(4);
  });

  it('换了引擎（步号对不上了）：整份发', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 5));
    await p.autosave();
    const next = new FakeEngine('甲', 4, 3);
    expect(p.writer.blind(next.full('另一个引擎'), {})).toBe('sent');
    expect(stored(disk)).toEqual(next.toDoc());
    expect(disk.rows.size).toBe(3);
  });

  it('不是写的那一方、还没写成过、没有锁可用、发不出去：都不这样写', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('甲', 1, 5));
    expect(a.writer.blind(a.engine.full(), {})).toBe('cannot');
    await a.autosave();
    a.engine.exec();
    a.writer.yield();
    expect(a.writer.blind(a.engine.full(), {})).toBe('cannot');
    a.writer.holder = true;
    disk.noNow = true;
    expect(a.writer.blind(a.engine.full(), {})).toBe('cannot');
    const l = new Page(memoryDisk(), new FakeEngine('乙', 2, 5), { lockless: true });
    await l.autosave();
    l.engine.exec();
    expect(l.writer.blind(l.engine.full(), {})).toBe('cannot');
    expect(stored(disk)).not.toEqual(a.engine.toDoc());
  });

  it('让出过又轮到自己（那一页关了）：头是那一页的，不能不读头就写——先整份重写一次', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('原', 1, 4), { id: '甲' });
    await a.autosave();
    // 乙接过去写了几步
    const b = new Page(disk, new FakeEngine('原', 1, 0), { id: '乙', holder: false });
    b.open();
    a.engine.exec('原');
    b.engine.exec('原');
    b.writer.claim();
    a.writer.yield();
    await b.autosave();
    // 乙关了，甲的世界正好是接着乙存的那一份做的：甲又有了写的权利
    a.engine.exec('甲');
    expect(await a.writer.canPromote(a.engine.full())).toBe(true);
    a.writer.holder = true;
    expect(a.writer.blind(a.engine.full(), {})).toBe('cannot');
    expect(stored(disk)).toEqual(b.engine.toDoc());
    expect((await a.autosave()).kind).toBe('saved');
    expect(stored(disk)).toEqual(a.engine.toDoc());
    expect(disk.head).toMatchObject({ writer: '甲' });
    // 写成过一次以后才行
    a.engine.exec('甲');
    expect(a.writer.blind(a.engine.full(), {})).toBe('sent');
    expect(stored(disk)).toEqual(a.engine.toDoc());
    expect(readBack(disk)!.ok).toBe(true);
  });

  it('让出以后正在路上的那一次写也不写了', async () => {
    const disk = memoryDisk();
    const a = new Page(disk, new FakeEngine('甲', 1, 4));
    await a.autosave();
    a.engine.exec();
    const base = a.writer.savedIds;
    const tail = a.engine.docTail(base);
    a.writer.yield();
    expect(await a.writer.write(tail, {}, { base, key: '甲' })).toEqual({ kind: 'other' });
    expect(disk.head).toMatchObject({ count: 4 });
  });

  it('发出去了却没提交（存储满了）：下一次写时头不是这一代，整份重写', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 5));
    await p.autosave();
    p.engine.exec();
    disk.full = true;
    expect(p.writer.blind(p.engine.full(), {})).toBe('sent');
    disk.full = false;
    expect(disk.head).toMatchObject({ gen: 1, count: 5 });
    p.engine.exec();
    expect((await p.autosave()).kind).toBe('saved');
    expect(stored(disk)).toEqual(p.engine.toDoc());
    expect(readBack(disk)!.ok).toBe(true);
  });

  it('平常那一次写到一半时发了这一下：平常那一次不按旧的下标写', async () => {
    const disk = memoryDisk();
    const p = new Page(disk, new FakeEngine('甲', 1, 5));
    await p.autosave();
    p.engine.exec();
    // 平常那一次：命令已经取好（按旧的 savedIds），事务还没开
    const base = p.writer.savedIds;
    const tail = p.engine.docTail(base);
    p.engine.exec();
    expect(p.writer.blind(p.engine.full(), {})).toBe('sent');
    const out = await p.writer.write(tail, {}, { base, key: '甲' });
    expect(out.kind).toBe('again');
    expect(stored(disk)).toEqual(p.engine.toDoc());
    expect((await p.autosave()).kind).toBe('saved');
    expect(stored(disk)).toEqual(p.engine.toDoc());
  });
});

describe('存着的是不是我的世界的开头', () => {
  const doc = (seed: number, n: number) => new FakeEngine('甲', seed, n).toDoc();
  it('一样的、短一些的算；长一些的、哪一步不一样的、设置不一样的不算；空的、不是世界的没有什么可丢', () => {
    expect(continues(doc(1, 4), doc(1, 4))).toBe(true);
    expect(continues(doc(1, 3), doc(1, 4))).toBe(true);
    expect(continues(doc(1, 5), doc(1, 4))).toBe(false);
    expect(continues(doc(2, 3), doc(1, 4))).toBe(false);
    const other = doc(1, 3);
    other.commands[1] = { ...other.commands[1], who: '乙' };
    expect(continues(other, doc(1, 4))).toBe(false);
    expect(continues({ ...doc(1, 3), version: DOC_VERSION - 1 }, doc(1, 4))).toBe(false);
    expect(continues(doc(1, 0), doc(2, 4))).toBe(true);
    expect(continues(null, doc(1, 4))).toBe(true);
  });
});

describe('读出来的是不是完整的一份', () => {
  it('条数对不上、有哪一条不是命令：没存完整', () => {
    const disk = memoryDisk();
    const a = new OldPage(disk, new FakeEngine('甲', 1, 8));
    const b = new OldPage(disk, new FakeEngine('乙', 2, 3));
    a.autosave();
    b.autosave();
    a.engine.exec();
    a.autosave();
    const raw = diskRaw(disk)!;
    expect(damaged(raw)).toBe(true);
    expect(staleWhy(raw)).toEqual({ age: 'current', why: 'damaged' });
    // 完整的不算
    const ok = memoryDisk();
    new OldPage(ok, new FakeEngine('甲', 1, 8)).autosave();
    expect(staleWhy(diskRaw(ok)!)).toBeNull();
    expect(damaged({ savedAt: 1, doc: { ...new FakeEngine('甲', 1, 2).toDoc(), commands: [{ op: 'x' }, null] }, count: 2 })).toBe(true);
    // 别的版本的照旧按版本说
    expect(staleWhy({ savedAt: 1, doc: { ...new FakeEngine('甲', 1, 2).toDoc(), version: DOC_VERSION - 1 }, count: 9 })).toEqual({ age: 'older' });
  });
});
