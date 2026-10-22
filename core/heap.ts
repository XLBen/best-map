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

  // 清空后重新使用（缓冲区留着）
  clear() {
    this.size = 0;
    this.counter = 0;
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
    const items = this.items;
    const keys = this.keys;
    const order = this.order;
    // 上浮（空位法，与逐层交换的结果相同）。新元素的入堆序号最大，优先级相同时不会排到父节点前面
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!(key < keys[p])) break;
      items[i] = items[p];
      keys[i] = keys[p];
      order[i] = order[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
    order[i] = this.counter++;
  }

  // 返回堆顶元素；调用前需保证 size > 0
  pop(): number {
    const items = this.items;
    const keys = this.keys;
    const order = this.order;
    const top = items[0];
    this.lastKey = keys[0];
    const size = --this.size;
    if (size > 0) {
      // 末尾元素从堆顶下沉（空位法）：每层换上更小的子节点（优先级小的在前，相同时先入堆的在前）
      const item = items[size];
      const key = keys[size];
      const ord = order[size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let km = key;
        let om = ord;
        if (l < size && (keys[l] < km || (keys[l] === km && order[l] < om))) {
          m = l;
          km = keys[l];
          om = order[l];
        }
        if (r < size && (keys[r] < km || (keys[r] === km && order[r] < om))) {
          m = r;
          km = keys[r];
          om = order[r];
        }
        if (m === i) break;
        items[i] = items[m];
        keys[i] = km;
        order[i] = om;
        i = m;
      }
      items[i] = item;
      keys[i] = key;
      order[i] = ord;
    }
    return top;
  }

  // 最近一次 pop 出的元素的优先级
  lastKey = 0;
}
