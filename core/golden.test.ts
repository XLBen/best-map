import { describe, expect, it } from 'vitest';
import { referenceHashes } from '../tools/hash';
import golden from './golden-hashes.json';

// 一块地区的世界：固定的一组操作后各层数据的哈希。加“整个星球”时平面的代码不能有一点变化，
// 所以这里的值一旦记下就不再改（除非有意改变平面世界的结果，并在提交说明里写明原因）
describe('一块地区的世界逐值不变', () => {
  it('参考操作后的各层哈希与记录一致', () => {
    expect(referenceHashes()).toEqual(golden);
  });
});
