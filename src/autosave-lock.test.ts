import { describe, expect, it } from 'vitest';
import { type LockIo, type Role, SaveRole, memoryLocks } from './autosave-lock';

// 第九十四轮：哪个页面写自动保存——一把锁，拿到的写；“在这里接着做”抢过来；写的那一页关了，能接才接

const tick = async () => {
  for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
};

function page(lock: LockIo | null, id: string, canPromote: () => Promise<boolean> = async () => true, channel?: Pick<LockIo, 'post' | 'listen'> | null) {
  const seen: Role[] = [];
  const role = channel === undefined ? new SaveRole(lock, id, { changed: (r) => seen.push(r), canPromote }) : new SaveRole(lock, id, { changed: (r) => seen.push(r), canPromote }, channel);
  return { role, seen };
}

describe('一把锁', () => {
  it('先开的页面写，后开的不写', async () => {
    const locks = memoryLocks();
    const a = page(locks.page(), '甲');
    const b = page(locks.page(), '乙');
    await a.role.start();
    await b.role.start();
    expect(a.role.role).toBe('writer');
    expect(b.role.role).toBe('other');
    expect(locks.holder()).toBe(0);
    // 再调一次不重来
    await a.role.start();
    expect(a.seen).toEqual(['writer']);
  });

  it('“在这里接着做”：抢过来，原来写的那一页变成不写的那一方；再抢回去也一样', async () => {
    const locks = memoryLocks();
    const a = page(locks.page(), '甲');
    const b = page(locks.page(), '乙');
    await a.role.start();
    await b.role.start();
    await b.role.take();
    await tick();
    expect(b.role.role).toBe('writer');
    expect(a.role.role).toBe('other');
    expect(locks.holder()).toBe(1);
    await a.role.take();
    await tick();
    expect(a.role.role).toBe('writer');
    expect(b.role.role).toBe('other');
    expect(locks.holder()).toBe(0);
    expect(a.seen).toEqual(['writer', 'other', 'writer']);
    expect(b.seen).toEqual(['other', 'writer', 'other']);
  });

  it('写的那一页关了：等着的页面能接（存着的是它的开头）就接着写', async () => {
    const locks = memoryLocks();
    const al = locks.page();
    const a = page(al, '甲');
    const b = page(locks.page(), '乙');
    await a.role.start();
    await b.role.start();
    al.close();
    await tick();
    expect(b.role.role).toBe('writer');
    expect(locks.holder()).toBe(1);
  });

  // 第九十五轮：这时那一页已经关了，不再是“已在另一个页面打开”（other），是另一种状态 stale（这个页面里的是旧的）
  it('不能接（那一页后来又做过）：不写、放开锁，等用户点；点了就写', async () => {
    const locks = memoryLocks();
    const al = locks.page();
    const a = page(al, '甲');
    let can = false;
    const b = page(locks.page(), '乙', async () => can);
    await a.role.start();
    await b.role.start();
    al.close();
    await tick();
    expect(b.role.role).toBe('stale');
    expect(b.seen).toEqual(['other', 'stale']);
    expect(locks.holder()).toBe(-1);
    // 第三个页面这时打开：它写
    const c = page(locks.page(), '丙');
    await c.role.start();
    expect(c.role.role).toBe('writer');
    can = true;
    await b.role.take();
    await tick();
    expect(b.role.role).toBe('writer');
    expect(c.role.role).toBe('other');
  });

  it('被抢走以后排着队：抢的那一页关了，能接就接回来', async () => {
    const locks = memoryLocks();
    const a = page(locks.page(), '甲');
    const bl = locks.page();
    const b = page(bl, '乙');
    await a.role.start();
    await b.role.start();
    await b.role.take();
    await tick();
    expect(a.role.role).toBe('other');
    bl.close();
    await tick();
    expect(a.role.role).toBe('writer');
    expect(locks.holder()).toBe(0);
  });

  it('三个页面：始终只有一个在写', async () => {
    const locks = memoryLocks();
    const ps = ['甲', '乙', '丙'].map((id) => page(locks.page(), id));
    for (const p of ps) await p.role.start();
    const writers = () => ps.filter((p) => p.role.role === 'writer').length;
    expect(writers()).toBe(1);
    for (const k of [2, 1, 0, 2, 2, 1]) {
      await ps[k].role.take();
      await tick();
      expect(writers()).toBe(1);
      expect(ps[k].role.role).toBe('writer');
    }
  });

  it('锁用不了（抛错）：当没有锁，照样能写', async () => {
    const broken: LockIo = {
      acquire: () => Promise.reject(new Error('不让用')),
      release: () => {},
      post: () => {},
      listen: () => {},
    };
    const a = page(broken, '甲');
    await a.role.start();
    expect(a.role.role).toBe('writer');
    await a.role.take();
    expect(a.role.role).toBe('writer');
  });
});

describe('那一页关了、这个页面里的是旧的（stale，第九十五轮）', () => {
  async function stale() {
    const locks = memoryLocks();
    const al = locks.page();
    const a = page(al, '甲');
    const b = page(locks.page(), '乙', async () => false);
    await a.role.start();
    await b.role.start();
    expect(b.role.role).toBe('other');
    al.close();
    await tick();
    expect(b.role.role).toBe('stale');
    return { locks, b };
  }

  it('写的那一页还开着时是 other，关了才是 stale；能接的（存着的是它的开头）直接写，不经过 stale', async () => {
    const locks = memoryLocks();
    const al = locks.page();
    const a = page(al, '甲');
    const b = page(locks.page(), '乙', async () => true);
    await a.role.start();
    await b.role.start();
    al.close();
    await tick();
    expect(b.seen).toEqual(['other', 'writer']);
  });

  it('“在这里接着做”：从 stale 也能把写的权利拿过来', async () => {
    const { locks, b } = await stale();
    await b.role.take();
    await tick();
    expect(b.role.role).toBe('writer');
    expect(locks.holder()).toBe(1);
    expect(b.seen).toEqual(['other', 'stale', 'writer']);
  });

  it('又有一个页面打开（它拿到锁、它写）：这个页面还是 stale，不抢', async () => {
    const { locks, b } = await stale();
    const c = page(locks.page(), '丙');
    await c.role.start();
    await tick();
    expect(c.role.role).toBe('writer');
    expect(b.role.role).toBe('stale');
    expect(locks.holder()).toBe(2);
  });

  it('别的页面说它接过去了：回到 other，重新排队；那一页再关，再看能不能接', async () => {
    const { locks, b } = await stale();
    const cl = locks.page();
    const c = page(cl, '丙');
    await c.role.start();
    await c.role.take();
    await tick();
    expect(b.role.role).toBe('other');
    cl.close();
    await tick();
    // 还是不能接（存着的不是它的开头）：又是 stale，锁放开着
    expect(b.role.role).toBe('stale');
    expect(locks.holder()).toBe(-1);
    expect(b.seen).toEqual(['other', 'stale', 'other', 'stale']);
  });
});

describe('没有锁可用：只有频道', () => {
  it('都当自己能写（写的时候靠头里的核对）；别的页面说它接过去了就让出；点了再接回来', async () => {
    const locks = memoryLocks();
    const a = page(null, '甲', undefined, locks.page());
    const b = page(null, '乙', undefined, locks.page());
    await a.role.start();
    await b.role.start();
    expect(a.role.lockless).toBe(true);
    expect([a.role.role, b.role.role]).toEqual(['writer', 'writer']);
    await b.role.take();
    await tick();
    expect([a.role.role, b.role.role]).toEqual(['other', 'writer']);
    // 写的时候发现头成了别人的（autosave-io 的 lost）
    b.role.giveUp();
    expect(b.role.role).toBe('other');
    await a.role.take();
    await tick();
    expect([a.role.role, b.role.role]).toEqual(['writer', 'other']);
  });

  it('连频道也没有：一直当自己能写', async () => {
    const a = page(null, '甲', undefined, null);
    await a.role.start();
    expect(a.role.role).toBe('writer');
    await a.role.take();
    expect(a.role.role).toBe('writer');
  });
});
