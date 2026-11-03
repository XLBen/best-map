import { describe, expect, it } from 'vitest';
import type { SmallState } from '../core/world';
import { ContentHolder, ContentSender } from './content-post';

// 第四十七轮：快照里内容没换时不发，主线程补上手上那一份。过一遍结构化克隆（像真的 postMessage），补上之后逐字节相同

const small = (content?: object) => ({ terrain: { a: 1 }, ...(content ? { content } : {}), provinces: { 1: { name: '甲' } }, nextId: 3 }) as unknown as SmallState;
const post = <T>(x: T) => structuredClone(x);

describe('快照里的内容', () => {
  it('没换时不带内容，主线程补上同一个对象，键的先后不变', () => {
    const tx = new ContentSender(1);
    const rx = new ContentHolder();
    const content = { culture: { a: { id: 'a' } } };
    const live = small(content);
    const first = post(tx.pack(live));
    expect(first.sameContent).toBeUndefined();
    expect(rx.unpack(first)).toBe(true);
    const held = first.small.content;
    expect(JSON.stringify(first.small)).toBe(JSON.stringify(live));

    const second = post(tx.pack(live));
    expect(second.sameContent).toBe(true);
    expect(second.small.content).toBe(0);
    expect(rx.unpack(second)).toBe(true);
    expect(second.small.content).toBe(held);
    expect(JSON.stringify(second.small)).toBe(JSON.stringify(live));
    expect(Object.keys(second.small)).toEqual(Object.keys(live));
    // 世界本身不动
    expect(live.content).toBe(content);
  });

  it('换了内容（撤销回旧的也算）、完整的快照：整份带上', () => {
    const tx = new ContentSender(1);
    const rx = new ContentHolder();
    const a = { culture: {} };
    const b = { culture: { x: {} } };
    for (const [content, full, whole] of [[a, false, true], [a, false, false], [b, false, true], [a, false, true], [a, true, true], [a, false, false]] as const) {
      const s = post(tx.pack(small(content), full));
      expect(!s.sameContent).toBe(whole);
      expect(rx.unpack(s)).toBe(true);
      expect(JSON.stringify(s.small.content)).toBe(JSON.stringify(content));
    }
  });

  it('人口群体（第五十四轮）：没换时不带，补上同一个对象；换了时整份带上；手上没有时补不上', () => {
    const tx = new ContentSender(1);
    const rx = new ContentHolder();
    const popGroups = { 1: { culture: 'a', values: {} } };
    const live = { ...small({ culture: {} }), popGroups } as unknown as SmallState;
    const first = post(tx.pack(live));
    expect(first.sameGroups).toBeUndefined();
    expect(rx.unpack(first)).toBe(true);
    const held = first.small.popGroups;
    const second = post(tx.pack(live));
    expect(second.sameGroups).toBe(true);
    expect(second.small.popGroups).toBe(0);
    expect(rx.unpack(second)).toBe(true);
    expect(second.small.popGroups).toBe(held);
    expect(JSON.stringify(second.small)).toBe(JSON.stringify(live));
    expect(Object.keys(second.small)).toEqual(Object.keys(live));
    expect(live.popGroups).toBe(popGroups);
    // 换了（内容没换）
    const changed = { ...live, popGroups: { ...popGroups, 2: { culture: 'b', values: {} } } } as unknown as SmallState;
    const third = post(tx.pack(changed));
    expect(third.sameGroups).toBeUndefined();
    expect(third.sameContent).toBe(true);
    expect(rx.unpack(third)).toBe(true);
    expect(JSON.stringify(third.small)).toBe(JSON.stringify(changed));
    // 手上的不是那一份
    const lost = new ContentHolder();
    const again = post(tx.pack(changed));
    expect(again.sameGroups).toBe(true);
    expect(lost.unpack(again)).toBe(false);
    // 完整的之后接得上
    expect(lost.unpack(post(tx.pack(changed, true)))).toBe(true);
    expect(lost.unpack(post(tx.pack(changed)))).toBe(true);
  });

  it('世界没有内容：没有占位，也不算补不上', () => {
    const tx = new ContentSender(1);
    const rx = new ContentHolder();
    for (let k = 0; k < 2; k++) {
      const s = post(tx.pack(small()));
      expect(s.sameContent).toBeUndefined();
      expect(rx.unpack(s)).toBe(true);
      expect('content' in s.small).toBe(false);
    }
  });

  it('手上的不是那一份：补不上（要一份完整的）；完整的之后接得上', () => {
    const tx = new ContentSender(1);
    const rx = new ContentHolder();
    const live = small({ culture: {} });
    // 第一份主线程没用上（比如回复丢了）
    tx.pack(live);
    const s = post(tx.pack(live));
    expect(s.sameContent).toBe(true);
    expect(rx.unpack(s)).toBe(false);
    expect(rx.unpack(post(tx.pack(live, true)))).toBe(true);
    const next = post(tx.pack(live));
    expect(next.sameContent).toBe(true);
    expect(rx.unpack(next)).toBe(true);
    expect(JSON.stringify(next.small)).toBe(JSON.stringify(live));
  });

  it('换了 Worker：碰巧同样的序号也不会用上一个世界的内容', () => {
    const rx = new ContentHolder();
    const old = new ContentSender(1);
    expect(rx.unpack(post(old.pack(small({ culture: { old: {} } }))))).toBe(true);
    const fresh = new ContentSender(2);
    const live = small({ culture: { fresh: {} } });
    // 新 Worker 的第一份主线程没收到
    fresh.pack(live);
    expect(rx.unpack(post(fresh.pack(live)))).toBe(false);
  });
});
