import { describe, expect, it } from 'vitest';
import { GL_RESTORE_MS, GlRecovery, type GlState } from './gl-recover';

// 第九十六轮：WebGL 的上下文丢了——等着恢复、恢复时重建、等不到时请用户重新载入

function setup(opts: { fail?: () => boolean; lost?: () => boolean } = {}) {
  const seen: [GlState, string?][] = [];
  let rebuilt = 0;
  let timer: { f: () => void; ms: number } | null = null;
  const r = new GlRecovery({
    rebuild: () => {
      if (opts.fail?.()) throw new Error('浏览器不支持 WebGL2');
      rebuilt++;
    },
    isLost: () => opts.lost?.() ?? false,
    changed: (s, reason) => seen.push(reason ? [s, reason] : [s]),
    setTimer: (f, ms) => (timer = { f, ms }),
    clearTimer: () => (timer = null),
  });
  return {
    r,
    seen,
    rebuilt: () => rebuilt,
    // 到点
    fire: () => {
      const t = timer;
      timer = null;
      t?.f();
    },
    waiting: () => timer?.ms ?? null,
  };
}

describe('上下文丢了', () => {
  it('丢了：不画，等着；恢复了：重建一次，回到正常', () => {
    const t = setup();
    expect(t.r.drawable).toBe(true);
    t.r.lost();
    expect(t.r.drawable).toBe(false);
    expect(t.seen).toEqual([['lost']]);
    expect(t.waiting()).toBe(GL_RESTORE_MS);
    // 同一次丢的事件来两遍：不重复
    t.r.lost();
    expect(t.seen).toEqual([['lost']]);
    t.r.restored();
    expect(t.rebuilt()).toBe(1);
    expect(t.seen).toEqual([['lost'], ['ok']]);
    expect(t.r.drawable).toBe(true);
    // 不再计时
    expect(t.waiting()).toBeNull();
  });

  it('等了一阵没恢复：请用户重新载入；之后浏览器还了上下文，照样恢复', () => {
    const t = setup();
    t.r.lost();
    t.fire();
    expect(t.seen).toEqual([['lost'], ['stuck']]);
    expect(t.r.drawable).toBe(false);
    t.r.restored();
    expect(t.rebuilt()).toBe(1);
    expect(t.seen.at(-1)).toEqual(['ok']);
  });

  it('重建时出错（显卡不行了）：坏了，带着原话；不再画', () => {
    let fail = true;
    const t = setup({ fail: () => fail });
    t.r.lost();
    t.r.restored();
    expect(t.seen).toEqual([['lost'], ['broken', '浏览器不支持 WebGL2']]);
    expect(t.r.drawable).toBe(false);
    // 之后又丢、又恢复（这次建得起来）：回到正常
    fail = false;
    t.r.lost();
    t.r.restored();
    expect(t.seen.at(-1)).toEqual(['ok']);
    expect(t.rebuilt()).toBe(1);
  });

  it('刚说恢复又丢了：不去重建，接着等', () => {
    let lost = true;
    const t = setup({ lost: () => lost });
    t.r.lost();
    t.r.restored();
    expect(t.rebuilt()).toBe(0);
    expect(t.r.state).toBe('lost');
    expect(t.waiting()).toBe(GL_RESTORE_MS);
    lost = false;
    t.r.restored();
    expect(t.rebuilt()).toBe(1);
    expect(t.r.state).toBe('ok');
  });

  it('连着几帧画不出来：坏了', () => {
    const t = setup();
    t.r.broke('TypeError: x');
    expect(t.seen).toEqual([['broken', 'TypeError: x']]);
    expect(t.r.drawable).toBe(false);
  });

  it('恢复了两次（丢、恢复、再丢、再恢复）：每次都重建', () => {
    const t = setup();
    for (let k = 0; k < 3; k++) {
      t.r.lost();
      t.r.restored();
    }
    expect(t.rebuilt()).toBe(3);
    expect(t.seen.map((s) => s[0])).toEqual(['lost', 'ok', 'lost', 'ok', 'lost', 'ok']);
  });
});
