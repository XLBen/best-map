// 以浮点优先级排序的整数最小堆；优先级相同时先进先出，保证平地上的处理顺序可复现
export class MinHeap {
  private items: Int32Array;
  private keys: Float64Array;
  private order: Float64Array;
  private counter = 0;
  size = 0;

  constructor(capacity = 1024) {
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.order = new Float64Array(capacity);
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a];
    const kb = this.keys[b];
    return ka < kb || (ka === kb && this.order[a] < this.order[b]);
  }

  private swap(a: number, b: number) {
    const i = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = i;
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const o = this.order[a];
    this.order[a] = this.order[b];
    this.order[b] = o;
  }

  push(item: number, key: number) {
    if (this.size === this.items.length) {
      const grow = (arr: Int32Array | Float64Array) => {
        const next = new (arr.constructor as Int32ArrayConstructor | Float64ArrayConstructor)(arr.length * 2);
        next.set(arr);
        return next;
      };
      this.items = grow(this.items) as Int32Array;
      this.keys = grow(this.keys) as Float64Array;
      this.order = grow(this.order) as Float64Array;
    }
    let i = this.size++;
    this.items[i] = item;
    this.keys[i] = key;
    this.order[i] = this.counter++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  // 返回堆顶元素；调用前需保证 size > 0
  pop(): number {
    const top = this.items[0];
    this.lastKey = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      this.keys[0] = this.keys[this.size];
      this.order[0] = this.order[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  // 最近一次 pop 出的元素的优先级
  lastKey = 0;
}
