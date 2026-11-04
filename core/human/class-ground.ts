import { ensureBase, reliefStroke, restoreKeep } from '../terrain';
import type { World } from '../world';

// 涂地形类别时地面跟着变（第五十八轮，设计见 docs/dev/history/第58轮.md）。
// 高度只有“堆山”那一层（causes.upliftDelta）：这里只算这一笔要把抬升改成多少，别的都和堆山一样。
// 只动抬升，不碰 landDelta：陆海、海岸线不会因为涂类别而变。
//
// 一笔读两样：这一笔下面现在平均多高（ground：加权平均，权重就是笔刷的软边），每格现在的抬升。
//   低于典型高度：整笔加同一条软边的抬升（和堆山一样，山谷、山脊由河流下切自己长出来，所以不是平顶）；
//     加多少按“缺的高度 × 力度”反推，离得越近加得越少，到了就不再加，所以越涂越接近，不会越涂越高。
//   抬升高过这种类别该有的上限：往上限拉（平原的上限很低，所以涂几笔就真的平了；山地的上限很高，起伏不动）；
//     平均已经高过典型高度时上限按比例再低一些，地面也就降下来。
//
// ground 要读推导里的高程，第一次执行时算好记进命令（RunResult 的 recorded），重放、重做照用，不用先算推导。

// 抬升多少撑得起 1 m 的“典型高度”：上限 = 典型高度 × 这个数（平原 150 m → 0.075，山地 2400 m → 1.2）
export const CEILING_PER_M = 1 / 2000;
// 反推抬升量的经验式（和 src/ui/tools/terrain.ts 的 reliefEstimateM 同一个形状）：
// 笔下平均升高 ≈ GAIN × 最高的山 × 抬升量^0.9 × 画笔半径（格）^0.75
const GAIN = 0.1;
// 一笔最多加这么多抬升（堆山滑块的上限）
const MAX_STEP = 1.6;
const UPLIFT_MAX = 2;

const clampUplift = (v: number) => (v < 0 ? 0 : v > UPLIFT_MAX ? UPLIFT_MAX : v);

// 这一笔下面的平均高度（m）：笔刷中心算得重，边上算得轻。elevation 是推导里的高程
export function groundUnder(cells: readonly number[], t: readonly number[], elevation: ArrayLike<number>): number {
  let sum = 0;
  let wsum = 0;
  for (let k = 0; k < cells.length; k++) {
    const v = t[k];
    const w = (1 - v * v) * (1 - v * v);
    sum += w * elevation[cells[k]];
    wsum += w;
  }
  // 存进命令：两位小数够了，文件短一点。第一次执行用的也是这个值，所以与重放逐值相同
  return wsum > 0 ? Math.round((sum / wsum) * 100) / 100 : 0;
}

// 这一笔每格抬升的变化（只算不写）：cells 要都是陆地
export function classLift(world: Pick<World, 'causes' | 'small'>, cells: number[], t: number[], height: number, strength: number, ground: number): number[] {
  const up = world.causes.uplift;
  const w = reliefStroke(cells, t, 1).delta;
  // 画笔半径（格）：按涂到的格算（拖成一长条时算大了，抬得少一点，再涂一笔就够了）
  let weight = 0;
  for (let k = 0; k < w.length; k++) weight += w[k];
  const rc = Math.max(0.5, Math.sqrt(weight / Math.PI));
  const gap = height - Math.max(0, ground);
  const scale = world.small.planet.mountainScale;
  const step = gap > 0 ? Math.min(MAX_STEP, Math.pow((strength * gap) / (GAIN * scale * Math.pow(rc, 0.75)), 1 / 0.9)) : 0;
  const ceiling = height * CEILING_PER_M * (ground > height ? height / ground : 1);
  return cells.map((i, k) => {
    const u = up[i];
    let v = u;
    if (v > ceiling) v -= strength * w[k] * (v - ceiling);
    // 加抬升不越过上限（已经高过上限的上面已经往回拉了）
    else v = Math.min(ceiling, v + step * w[k]);
    return clampUplift(v) - u;
  });
}

// 写进原因：抬升的增量按“改之后的抬升 − 生成时的抬升”写（堆到头又继续堆留下的余量顺带去掉），每格的抬升和 resolveTerrain 算的相同。
// 只改涂到的格，陆海不用重新组合。返回改了几格
export function putLift(world: World, cells: readonly number[], delta: readonly number[]): number {
  const base = ensureBase(world).uplift;
  const { upliftDelta, uplift } = world.causes;
  let n = 0;
  for (let k = 0; k < cells.length; k++) {
    if (delta[k] === 0) continue;
    const i = cells[k];
    upliftDelta[i] = uplift[i] + delta[k] - base[i];
    uplift[i] = clampUplift(base[i] + upliftDelta[i]);
    n++;
  }
  return n;
}

// 擦掉类别时地面回去：和堆山的橡皮同一条软边（restoreKeep），零头归零。只擦抬升；返回改了几格
export function restoreLift(world: World, cells: readonly number[], t: readonly number[]): number {
  const base = ensureBase(world).uplift;
  const { upliftDelta, uplift } = world.causes;
  let n = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const old = upliftDelta[i];
    if (old === 0) continue;
    const kept = old * restoreKeep(t[k]);
    upliftDelta[i] = Math.abs(kept) < 1e-3 ? 0 : kept;
    if (upliftDelta[i] !== old) n++;
    uplift[i] = clampUplift(base[i] + upliftDelta[i]);
  }
  return n;
}
