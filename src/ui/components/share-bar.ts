// 一条分成几段的色条（第八十一轮，ShareBar.tsx）的算法：几样各占多少，拖两段之间的分界只动这两段，总数不变。
// 拖的时候只是草稿，松手才交出去一次（shareDrag）。不认识世界，测试直接调

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// 各占多少（任意的数）→ 各占几成（和是 1）；都是 0 时平分
export function sharesOf(values: readonly number[]): number[] {
  const sum = values.reduce((a, v) => a + Math.max(0, v), 0);
  if (!(sum > 0)) return values.map(() => 1 / Math.max(1, values.length));
  return values.map((v) => Math.max(0, v) / sum);
}

// 分界的位置（0–1）：第 k 个是第 k 段的右边
export function dividersOf(shares: readonly number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (let k = 0; k < shares.length - 1; k++) {
    at += shares[k];
    out.push(at);
  }
  return out;
}

// 把第 k 个分界拖到 pos：只改第 k、k+1 两段，夹在左右两个分界之间
export function moveDivider(shares: readonly number[], k: number, pos: number): number[] {
  const d = dividersOf(shares);
  if (k < 0 || k >= d.length) return [...shares];
  const left = k > 0 ? d[k - 1] : 0;
  const right = k + 1 < d.length ? d[k + 1] : 1;
  const at = Math.max(left, Math.min(right, clamp01(pos)));
  const out = [...shares];
  out[k] = at - left;
  out[k + 1] = right - at;
  return out;
}

// 交出去的数：百分之几，按 step 取整，和正好是 total（差的补在最大的一段上）
export function valuesOf(shares: readonly number[], total = 100, step = 0.1): number[] {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const round = (v: number) => Number((Math.round(v / step) * step).toFixed(digits));
  const out = shares.map((s) => round(s * total));
  const diff = round(total - out.reduce((a, v) => a + v, 0));
  if (diff !== 0 && out.length) {
    let big = 0;
    for (let k = 1; k < out.length; k++) if (out[k] > out[big]) big = k;
    out[big] = round(out[big] + diff);
  }
  return out;
}

// 一次拖动：start 记下开始的样子，move 只改草稿，end 交出去（没变时 null）；cancel 丢掉
export function shareDrag(values: readonly number[], k: number) {
  const start = sharesOf(values);
  let draft = start;
  return {
    move(pos: number): number[] {
      draft = moveDivider(start, k, pos);
      return draft;
    },
    end(total = 100, step = 0.1): number[] | null {
      const next = valuesOf(draft, total, step);
      const before = valuesOf(start, total, step);
      return next.every((v, j) => v === before[j]) ? null : next;
    },
  };
}

export const percentText = (share: number): string => `${Math.round(share * 100)}%`;
