// 更强的哈希：按字节、两条独立的通道（FNV-1a 与乘法混合），64 位十六进制。类型数组按原生字节，
// 其他值先 JSON 序列化（双精度数的 JSON 是精确的往返表示）
export function digest(v: unknown): string {
  let bytes: Uint8Array;
  if (ArrayBuffer.isView(v)) bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  else bytes = new TextEncoder().encode(JSON.stringify(v) ?? 'undefined');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ bytes.length;
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}


// 一个世界的全部状态（第二十九轮，压缩世界文件时核对用）：原因、推导的每一个类型数组（含人文的几层）、自定义场与修正、地物、小数据。
// 与 tools/hash.ts 的 digestWorld 不同，人文的推导也算在里面（压缩前后整个世界要一模一样）。
// 小数据里顶层空的列表、空的表按没有算（删光了河的种类留下的 riverTypes: [] 与从来没加过一样）
export function worldDigest(w: { causes: object; derived: object; small: unknown }): string {
  const parts: string[] = [];
  const add = (prefix: string, o: object) => {
    for (const [k, v] of Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (ArrayBuffer.isView(v)) parts.push(`${prefix}.${k}=${digest(v)}`);
      else if (v && typeof v === 'object' && !Array.isArray(v) && (k === 'fields' || k === 'corrF')) add(`${prefix}.${k}`, v);
    }
  };
  add('causes', w.causes);
  add('derived', w.derived);
  const d = w.derived as { features?: { cells: number[] }[]; conflicts?: unknown; scriptIssues?: unknown };
  parts.push(`features=${digest((d.features ?? []).map((f) => ({ ...f, cells: digest(Int32Array.from(f.cells)) })))}`);
  parts.push(`conflicts=${digest(d.conflicts ?? null)}`);
  const small = Object.fromEntries(Object.entries(w.small as Record<string, unknown>).filter(([, v]) => !(v && typeof v === 'object' && !ArrayBuffer.isView(v) && Object.keys(v).length === 0)));
  parts.push(`small=${digest(small)}`);
  return digest(parts.join('\n'));
}
