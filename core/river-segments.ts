// 河按段定类型（第五十六轮）：一条河沿途每格有一个标签（第几种河），短于 RIVER_SEGMENT_MIN 格的段并进相邻的段，不一格一变。
// 只看这条河从源头往下的先后，和格的编号、别的河无关（core/water-rules.test.ts 把格的编号打乱对照）

// 一段至少这么多格：按格不按 km，地区和星球上看起来都不碎。整条河都没这么长时并成一段
export const RIVER_SEGMENT_MIN = 4;

// labels：每格的标签（下标是格的编号），只改 cells 里的格。fixed：定下来的格（选了类型的河道），所在的段不会并进别的段，别的段可以并进它。
// 一遍一遍取最短的段（一样短取靠上游的），并进较长的邻居（一样长取上游的），并完相同的连起来，直到没有太短的段。
// 一段都没有变化的河（绝大多数）只看一遍
export function mergeShortRuns(labels: Uint8Array, cells: ArrayLike<number>, fixed: Uint8Array | null, min: number = RIVER_SEGMENT_MIN): void {
  const m = cells.length;
  if (m < 2) return;
  // 一段一段：标签、格数、是不是定下来的
  let single = true;
  const first = labels[cells[0]];
  for (let q = 1; q < m; q++) {
    if (labels[cells[q]] !== first) {
      single = false;
      break;
    }
  }
  if (single) return;
  const tag: number[] = [];
  const len: number[] = [];
  const hard: boolean[] = [];
  for (let q = 0; q < m; q++) {
    const c = cells[q];
    const v = labels[c];
    const f = fixed !== null && fixed[c] !== 0;
    const r = tag.length - 1;
    if (r >= 0 && tag[r] === v && hard[r] === f) len[r]++;
    else {
      tag.push(v);
      len.push(1);
      hard.push(f);
    }
  }
  let dirty = false;
  while (tag.length > 1) {
    let at = -1;
    for (let r = 0; r < tag.length; r++) if (!hard[r] && len[r] < min && (at < 0 || len[r] < len[at])) at = r;
    if (at < 0) break;
    dirty = true;
    // 并进较长的邻居，一样长取上游的
    const up = at - 1;
    const down = at + 1;
    const into = up < 0 ? down : down >= tag.length ? up : len[down] > len[up] ? down : up;
    len[into] += len[at];
    tag.splice(at, 1);
    len.splice(at, 1);
    hard.splice(at, 1);
    // 并完以后，相同标签的邻段连起来（定下来的不和别的连：它不能再被并走，别的段还可以）
    for (let r = Math.max(0, at - 1); r + 1 < tag.length && r <= at; ) {
      if (tag[r] === tag[r + 1] && hard[r] === hard[r + 1]) {
        len[r] += len[r + 1];
        tag.splice(r + 1, 1);
        len.splice(r + 1, 1);
        hard.splice(r + 1, 1);
      } else r++;
    }
  }
  if (!dirty) return;
  let q = 0;
  for (let r = 0; r < tag.length; r++) for (let e = q + len[r]; q < e; q++) labels[cells[q]] = tag[r];
}
