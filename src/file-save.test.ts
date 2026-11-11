import { describe, expect, it } from 'vitest';
import { FILE_OFF, FILE_SAVE_MS, FileSaver, type FileStatus, fileFailOf, handleTarget, memoryFile, memoryFileIo } from './file-save';

// 第九十五轮：存到电脑上的文件——选一次、之后跟着写（节流）、下次打开页面要重新给权限、写不成一直说着。
// 文件和存储换成内存里的；钟和定时器是手拨的

function setup() {
  const io = memoryFileIo();
  let now = 1_000_000;
  let world = { text: '{"v":1}', mark: '0:1' } as { text: string; mark: string } | null;
  const seen: FileStatus[] = [];
  const timers: { fn: () => void; at: number }[] = [];
  const saver = new FileSaver(io, {
    text: async () => world,
    changed: (s) => seen.push(s),
    now: () => now,
    timer: {
      set: (fn, ms) => {
        const t = { fn, at: now + ms };
        timers.push(t);
        return t;
      },
      clear: (h) => void timers.splice(timers.indexOf(h as (typeof timers)[number]), 1),
    },
  });
  return {
    io,
    saver,
    seen,
    timers,
    // 世界变了
    edit(k: number) {
      world = { text: `{"v":${k}}`, mark: `0:${k}` };
    },
    noWorld: () => (world = null),
    // 时间往前走，到点的定时器响
    async tick(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await saver.flush();
    },
    now: () => now,
  };
}

describe('选一个文件', () => {
  it('选好马上写一次，记下来；状态是在写、写着名字和时间', async () => {
    const t = setup();
    await t.saver.load('w:a');
    expect(t.saver.status).toEqual(FILE_OFF);
    const f = memoryFile('赤原.json');
    t.io.next = f;
    expect(await t.saver.attach('赤原.json')).toBe(true);
    expect(f.content).toBe('{"v":1}');
    expect(t.io.remembered.get('w:a')).toBe(f);
    expect(t.saver.status).toEqual({ mode: 'on', name: '赤原.json', savedAt: t.now(), fail: null });
  });

  it('取消了：什么都没变；浏览器不支持、还没有世界：选不了', async () => {
    const t = setup();
    await t.saver.load('w:a');
    t.io.next = null;
    expect(await t.saver.attach('x.json')).toBe(false);
    expect(t.saver.status).toEqual(FILE_OFF);
    t.io.support = false;
    t.io.next = memoryFile('x.json');
    expect(await t.saver.attach('x.json')).toBe(false);
    const none = setup();
    none.io.next = memoryFile('x.json');
    expect(await none.saver.attach('x.json')).toBe(false);
  });

  it('记不下来（浏览器存储不可用）：这次打开页面照样写', async () => {
    const t = setup();
    await t.saver.load('w:a');
    t.io.down = true;
    const f = memoryFile('a.json');
    t.io.next = f;
    expect(await t.saver.attach('a.json')).toBe(true);
    expect(f.content).toBe('{"v":1}');
    expect(t.saver.status.mode).toBe('on');
  });
});

describe('跟着自动保存写：节流', () => {
  it(`刚写过：${FILE_SAVE_MS / 1000} 秒以内再来的不马上写，到时间写一次（写的是那时最新的）；世界没变不重写`, async () => {
    expect(FILE_SAVE_MS).toBe(10_000);
    const u = setup();
    await u.saver.load('w:a');
    const g = memoryFile('a.json');
    u.io.next = g;
    await u.saver.attach('a.json');
    u.edit(2);
    u.saver.noteSaved();
    u.edit(3);
    u.saver.noteSaved();
    expect(g.writes).toBe(1);
    expect(u.timers.length).toBe(1);
    expect(u.timers[0].at).toBe(u.now() + FILE_SAVE_MS);
    await u.tick(FILE_SAVE_MS);
    expect(g.writes).toBe(2);
    expect(g.content).toBe('{"v":3}');
    // 世界没变：到时间也不重写
    await u.tick(FILE_SAVE_MS);
    u.saver.noteSaved();
    await u.saver.flush();
    expect(g.writes).toBe(2);
    // 隔了很久再改：马上写
    u.edit(4);
    u.saver.noteSaved();
    await u.saver.flush();
    expect(g.writes).toBe(3);
    expect(g.content).toBe('{"v":4}');
  });

  it('⌘S：不等，马上写；排着的定时取消', async () => {
    const t = setup();
    await t.saver.load('w:a');
    const f = memoryFile('a.json');
    t.io.next = f;
    await t.saver.attach('a.json');
    t.edit(2);
    t.saver.noteSaved();
    expect(t.timers.length).toBe(1);
    await t.saver.flush();
    expect(f.content).toBe('{"v":2}');
    expect(t.timers.length).toBe(0);
  });

  it('没有文件、没在写的时候：不写', async () => {
    const t = setup();
    await t.saver.load('w:a');
    t.saver.noteSaved();
    await t.saver.flush();
    expect(t.timers.length).toBe(0);
    expect(t.seen.every((s) => s.mode === 'off')).toBe(true);
  });
});

describe('下次打开页面', () => {
  it('浏览器要重新给权限：没在写（看得出来），不写；点“接着存到”给了才写', async () => {
    const first = setup();
    await first.saver.load('m:1');
    const f = memoryFile('a.json');
    first.io.next = f;
    await first.saver.attach('a.json');
    // 另一次打开页面：同一份存储，权限要重新问
    const t = setup();
    t.io.remembered = first.io.remembered;
    f.perm = 'prompt';
    await t.saver.load('m:1');
    expect(t.saver.status).toEqual({ mode: 'paused', name: 'a.json', savedAt: null, fail: null });
    expect(f.asked).toBe(0);
    t.edit(5);
    t.saver.noteSaved();
    await t.saver.flush();
    expect(f.content).toBe('{"v":1}');
    expect(f.writes).toBe(1);
    // 点了
    expect(await t.saver.resume()).toBe(true);
    expect(f.asked).toBe(1);
    expect(t.saver.status.mode).toBe('on');
    expect(f.content).toBe('{"v":5}');
  });

  it('浏览器记着权限（不用再问）：直接接着写', async () => {
    const t = setup();
    const f = memoryFile('a.json');
    t.io.remembered.set('m:1', f);
    await t.saver.load('m:1');
    expect(t.saver.status.mode).toBe('on');
    t.saver.noteSaved();
    await t.saver.flush();
    expect(f.content).toBe('{"v":1}');
  });

  it('点了“接着存到”但没给：还是没在写，说不能写', async () => {
    const t = setup();
    const f = memoryFile('a.json');
    f.perm = 'prompt';
    f.grant = false;
    t.io.remembered.set('m:1', f);
    await t.saver.load('m:1');
    expect(await t.saver.resume()).toBe(false);
    expect(t.saver.status).toMatchObject({ mode: 'paused', fail: 'denied' });
    expect(f.writes).toBe(0);
  });

  it('换了世界：别的世界不写进这个文件；换回来还在', async () => {
    const t = setup();
    await t.saver.load('m:1');
    const f = memoryFile('a.json');
    t.io.next = f;
    await t.saver.attach('a.json');
    await t.saver.load('w:other');
    expect(t.saver.status).toEqual(FILE_OFF);
    t.edit(9);
    t.saver.noteSaved();
    await t.saver.flush();
    expect(f.content).toBe('{"v":1}');
    await t.saver.load('m:1');
    expect(t.saver.status.mode).toBe('on');
    await t.saver.flush();
    expect(f.content).toBe('{"v":9}');
    // 没有世界
    await t.saver.load(null);
    expect(t.saver.status).toEqual(FILE_OFF);
  });

  it('第一次存进“我的地图”（键换了）：文件跟着走', async () => {
    const t = setup();
    await t.saver.load('w:a');
    const f = memoryFile('a.json');
    t.io.next = f;
    await t.saver.attach('a.json');
    await t.saver.rekey('w:a', 'm:9');
    expect([...t.io.remembered.keys()]).toEqual(['m:9']);
    await t.saver.load('m:9');
    expect(t.saver.status.mode).toBe('on');
    t.edit(2);
    await t.saver.flush();
    expect(f.content).toBe('{"v":2}');
  });
});

describe('“不再存到这个文件”', () => {
  it('忘掉它，文件本身不动；之后不写', async () => {
    const t = setup();
    await t.saver.load('w:a');
    const f = memoryFile('a.json');
    t.io.next = f;
    await t.saver.attach('a.json');
    await t.saver.detach();
    expect(t.saver.status).toEqual(FILE_OFF);
    expect(t.io.remembered.size).toBe(0);
    t.edit(2);
    t.saver.noteSaved();
    await t.saver.flush();
    expect(f.content).toBe('{"v":1}');
  });
});

describe('写不成', () => {
  it('原因一直留着，下一次写成了才清；文件里原来的内容不坏', async () => {
    const t = setup();
    await t.saver.load('w:a');
    const f = memoryFile('a.json');
    t.io.next = f;
    await t.saver.attach('a.json');
    for (const [name, fail] of [
      ['NotFoundError', 'gone'],
      ['QuotaExceededError', 'full'],
      ['InvalidStateError', 'failed'],
    ] as const) {
      f.failWith = name;
      t.edit(t.now());
      await t.tick(FILE_SAVE_MS);
      t.saver.noteSaved();
      await t.saver.flush();
      expect(t.saver.status.fail).toBe(fail);
      expect(t.saver.status.mode).toBe('on');
      expect(f.content).toBe('{"v":1}');
    }
    // 世界没变也再试（上一次没写成）
    f.failWith = null;
    await t.tick(FILE_SAVE_MS);
    t.saver.noteSaved();
    await t.saver.flush();
    expect(t.saver.status.fail).toBeNull();
    expect(f.content).not.toBe('{"v":1}');
    expect(t.saver.status.savedAt).toBe(t.now());
  });

  it('权限没了：回到没在写，等用户再点', async () => {
    const t = setup();
    await t.saver.load('w:a');
    const f = memoryFile('a.json');
    t.io.next = f;
    await t.saver.attach('a.json');
    f.perm = 'prompt';
    t.edit(2);
    await t.saver.flush();
    expect(t.saver.status).toMatchObject({ mode: 'paused', fail: 'denied' });
    expect(await t.saver.resume()).toBe(true);
    expect(t.saver.status).toMatchObject({ mode: 'on', fail: null });
    expect(f.content).toBe('{"v":2}');
  });

  it('错的种类', () => {
    const err = (name: string) => Object.assign(new Error(name), { name });
    expect(fileFailOf(err('NotFoundError'))).toBe('gone');
    expect(fileFailOf(err('NotAllowedError'))).toBe('denied');
    expect(fileFailOf(err('SecurityError'))).toBe('denied');
    expect(fileFailOf(err('QuotaExceededError'))).toBe('full');
    expect(fileFailOf(new Error('别的'))).toBe('failed');
    expect(fileFailOf(null)).toBe('failed');
  });

  it('写到一半换了世界：这一次的结果不算到新的世界头上', async () => {
    const t = setup();
    await t.saver.load('w:a');
    const f = memoryFile('a.json');
    t.io.next = f;
    await t.saver.attach('a.json');
    f.failWith = 'NotFoundError';
    t.edit(2);
    const p = t.saver.flush();
    await t.saver.load('w:b');
    await p;
    expect(t.saver.status).toEqual(FILE_OFF);
  });
});

describe('浏览器的文件句柄', () => {
  // 假的句柄：照 File System Access API 的样子——写的东西 close 了才换掉文件里的
  function fakeHandle() {
    const h = {
      name: 'a.json',
      content: 'old',
      perm: 'prompt' as 'granted' | 'prompt' | 'denied',
      failAt: null as 'write' | 'close' | null,
      aborted: 0,
      async createWritable() {
        let draft = '';
        return {
          write: async (data: string) => {
            if (h.failAt === 'write') throw Object.assign(new Error('x'), { name: 'QuotaExceededError' });
            draft += data;
          },
          close: async () => {
            if (h.failAt === 'close') throw Object.assign(new Error('x'), { name: 'NotFoundError' });
            h.content = draft;
          },
          abort: async () => {
            h.aborted++;
          },
        };
      },
      queryPermission: async () => h.perm,
      requestPermission: async (): Promise<'granted' | 'prompt' | 'denied'> => {
        h.perm = 'granted';
        return h.perm;
      },
    };
    return h;
  }

  it('写：close 了才换掉；写到一半、close 出错都不动原来的，并且放弃这一次', async () => {
    const h = fakeHandle();
    const t = handleTarget(h);
    expect(t.name).toBe('a.json');
    await t.write('new');
    expect(h.content).toBe('new');
    h.failAt = 'write';
    await expect(t.write('x')).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(h.content).toBe('new');
    h.failAt = 'close';
    await expect(t.write('y')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(h.content).toBe('new');
    expect(h.aborted).toBe(2);
  });

  it('权限：不问时只看现在的；问了才去要', async () => {
    const h = fakeHandle();
    const t = handleTarget(h);
    expect(await t.permission(false)).toBe('prompt');
    expect(h.perm).toBe('prompt');
    expect(await t.permission(true)).toBe('granted');
    expect(await t.permission(false)).toBe('granted');
    // 没有这两个方法的句柄：一直能写
    const plain = handleTarget({ name: 'b.json', createWritable: h.createWritable });
    expect(await plain.permission(false)).toBe('granted');
  });
});
