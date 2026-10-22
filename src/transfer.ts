// 检查点（星球约 34 MB）从存储 Worker 发给计算 Worker 时用：找出里面全部的 ArrayBuffer 作为转移列表，
// postMessage 时把数据“搬过去”而不是再复制一份（刚从 IndexedDB 读出来的，存储 Worker 自己不再用）。
// 值可能来自运行过脚本的 Worker（它写的检查点）：不递归（用自己的栈），看过的对象不再看，数组里的数不进栈；
// 对象太多（limit）时放弃，返回空列表（照常复制，只是慢一点）

export function collectBuffers(root: unknown, limit = 2_000_000): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (++visited > limit) return [];
    if (v instanceof ArrayBuffer) {
      out.add(v);
      continue;
    }
    if (ArrayBuffer.isView(v)) {
      // SharedArrayBuffer 不能转移（也用不着）
      if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
      continue;
    }
    if (Array.isArray(v)) {
      for (let k = 0; k < v.length; k++) {
        const x = v[k];
        if (x !== null && typeof x === 'object') stack.push(x);
      }
    } else if (v instanceof Map) {
      for (const [k, x] of v) stack.push(k, x);
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x);
    } else {
      for (const k in v) stack.push((v as Record<string, unknown>)[k]);
    }
  }
  return [...out];
}
