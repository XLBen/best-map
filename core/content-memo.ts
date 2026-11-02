import type { Mesh } from './mesh';

// 按内容做键的缓存（第四十六轮从 climate.ts 原样搬来，climate.ts 照旧导出 ContentMemo）

// ---------- 按内容做键的缓存 ----------

// 每个网格留两份（预览用的副本不会把正在用的挤掉），命中的挪到最前；格数超过 bigMesh 的网格只留一份。
// 键里的数组按字节比较（-0 与 0、不同的 NaN 都算不同），参数按 Object.is；存进去的数组都是私有的副本，取出后只读。
// on = false 时既不用也不存（测试里用来得到从头算的结果）
export class ContentMemo<T> {
  on = true;
  hit = 0;
  miss = 0;
  private store = new WeakMap<Mesh, { arrays: ArrayBufferView[]; params: unknown[]; value: T }[]>();
  private readonly bigMesh: number;

  constructor(bigMesh = Infinity) {
    this.bigMesh = bigMesh;
  }

  find(mesh: Mesh, arrays: ArrayBufferView[], params: unknown[]): T | null {
    if (!this.on) return null;
    const list = this.store.get(mesh) ?? [];
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (!c.params.every((v, j) => Object.is(v, params[j])) || !c.arrays.every((a, j) => sameBytes(a, arrays[j]))) continue;
      list.splice(k, 1);
      list.unshift(c);
      this.hit++;
      return c.value;
    }
    this.miss++;
    return null;
  }

  // 有没有这一份（不计入命中、不调整先后）
  peek(mesh: Mesh, arrays: ArrayBufferView[], params: unknown[]): boolean {
    if (!this.on) return false;
    const list = this.store.get(mesh) ?? [];
    return list.some((c) => c.params.every((v, j) => Object.is(v, params[j])) && c.arrays.every((a, j) => sameBytes(a, arrays[j])));
  }

  // arrays：键里的数组，给私有的副本
  keep(mesh: Mesh, arrays: ArrayBufferView[], params: unknown[], value: T) {
    if (!this.on) return;
    const list = this.store.get(mesh) ?? [];
    list.unshift({ arrays, params, value });
    this.store.set(mesh, list.slice(0, mesh.n > this.bigMesh ? 1 : 2));
  }

  clear() {
    this.store = new WeakMap();
  }
}

export function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  // 长度、起点都是 4 的倍数时 4 字节一组比
  const wide = a.byteLength % 4 === 0 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0;
  const x = wide ? new Int32Array(a.buffer, a.byteOffset, a.byteLength / 4) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = wide ? new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
