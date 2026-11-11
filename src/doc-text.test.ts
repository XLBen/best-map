import { describe, expect, it } from 'vitest';
import { docText } from './doc-text';

// 第九十五轮：世界文件的字——和 JSON.stringify 一字不差，每条命令只转一次

const doc = (commands: unknown[]) => ({ format: 'map2-world', version: 22, settings: { seed: 1, name: '赤原', nested: { a: [1, 2, { b: null }] } }, commands });

describe('世界文件的字', () => {
  it('和 JSON.stringify 一字不差：空的、一条、很多条、带中文和转义的', () => {
    const cmds = [
      { op: 'paint', cells: [1, 2, 3], value: 0.5, mode: 'add' },
      { op: 'rename_feature', key: 'k"1', name: '赤原\n“二”\\' },
      { op: 'batch', commands: [{ op: 'x', t: [0.1, 1e-7, -0] }], extra: undefined, list: [undefined, null] },
    ];
    for (const list of [[], cmds.slice(0, 1), cmds, [...cmds, ...cmds.map((c) => ({ ...c }))]]) {
      const d = doc(list);
      expect(docText(d)).toBe(JSON.stringify(d));
      // 再来一次（这回都是记着的）
      expect(docText(d)).toBe(JSON.stringify(d));
    }
  });

  it('只转新加的命令：记着的那几条不再转', () => {
    let calls = 0;
    const counted = (k: number) => ({
      op: 'x',
      k,
      toJSON() {
        calls++;
        return { op: 'x', k };
      },
    });
    const a = counted(1);
    const b = counted(2);
    const d1 = doc([a, b]);
    expect(docText(d1)).toBe('{"format":"map2-world","version":22,"settings":{"seed":1,"name":"赤原","nested":{"a":[1,2,{"b":null}]}},"commands":[{"op":"x","k":1},{"op":"x","k":2}]}');
    expect(calls).toBe(2);
    const c = counted(3);
    // 撤销了一步、又做了一步：前面那条还是同一个对象
    const d2 = doc([a, c]);
    expect(docText(d2)).toBe(JSON.stringify(doc([{ op: 'x', k: 1 }, { op: 'x', k: 3 }])));
    expect(calls).toBe(3);
  });

  it('不是“命令在最后”的样子：照普通的办法转，结果一样', () => {
    const odd = [
      { commands: [{ op: 'a' }], format: 'map2-world' },
      { format: 'map2-world', commands: 'not-array' },
      { commands: [{ op: 'a' }] },
      { format: undefined, commands: [{ op: 'a' }] },
      [1, 2],
      null,
      'x',
    ];
    for (const d of odd) expect(docText(d)).toBe(JSON.stringify(d));
  });

  it('命令不是对象（坏了的文件）：也一样', () => {
    const d = doc([1, 'a', null, { op: 'b' }]);
    expect(docText(d)).toBe(JSON.stringify(d));
  });
});
