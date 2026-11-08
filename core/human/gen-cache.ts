// 生成人文时跨几次生成共用的缓存（第八十四轮）：重新生成国家时文化圈、地形、河都没变，宗教的传播、过河翻山的倍数照用上一次的。
// 键按内容比（撤销、重做以后推导的数组是新的对象，内容一样）：数组算两份 32 位的哈希，连同长度。
// clearGenCaches 清掉全部（测试拿它比“有缓存”和“没缓存”逐位相同）

const clears: (() => void)[] = [];
export function registerGenCache(clear: () => void) {
  clears.push(clear);
}
export function clearGenCaches() {
  for (const c of clears) c();
}

// 一个数组按字节的指纹（两份 FNV 式的 32 位哈希 + 长度）
export function viewKey(a: ArrayBufferView): string {
  const len = a.byteLength;
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  if ((a.byteOffset & 3) === 0 && (len & 3) === 0) {
    const u = new Uint32Array(a.buffer, a.byteOffset, len >> 2);
    for (let i = 0; i < u.length; i++) {
      const v = u[i];
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul(h2 ^ v, 0x5bd1e995) ^ (h2 >>> 15);
    }
  } else {
    const u = new Uint8Array(a.buffer, a.byteOffset, len);
    for (let i = 0; i < u.length; i++) {
      const v = u[i];
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul(h2 ^ v, 0x5bd1e995) ^ (h2 >>> 15);
    }
  }
  return `${len}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}
