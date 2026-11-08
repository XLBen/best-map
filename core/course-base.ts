// 画的河的走向：计划的类型与几样小工具（第八十三轮从 core/select.ts 原样搬出）
import type { World, Derived } from './world';
import { graphDistanceOwner } from './mesh';

// 屏幕上画出来的河：陆地、不是湖、流量不低于门槛
export function isRiverCell(world: World, d: Derived, i: number): boolean {
  return world.causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= world.small.planet.riverThreshold;
}

// 一格的上游（流经它的水从哪些格来），含它自己
export function upstreamOf(world: World, d: Derived, cell: number): Uint8Array {
  const n = world.mesh.n;
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) if (d.receiver[i] >= 0) off[d.receiver[i] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const donors = new Int32Array(off[n]);
  const fill = off.slice(0, n);
  for (let i = 0; i < n; i++) if (d.receiver[i] >= 0) donors[fill[d.receiver[i]]++] = i;
  const up = new Uint8Array(n);
  up[cell] = 1;
  const queue = [cell];
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    for (let k = off[c]; k < off[c + 1]; k++) {
      const j = donors[k];
      if (!up[j]) {
        up[j] = 1;
        queue.push(j);
      }
    }
  }
  return up;
}

// 从一格出发到最近的目标格，避开 avoid 中的格，偏好下坡
export function pathToTarget(world: World, d: Derived, from: number, avoid: (i: number) => boolean, target: (i: number) => boolean): number[] {
  const { mesh } = world;
  const { dist } = graphDistanceOwner(mesh, [from], Infinity, (i, j, e) => {
    if (avoid(j) || (i !== from && target(i))) return Infinity;
    const up = Math.max(0, d.elevation[j] - d.elevation[i]);
    return mesh.dist[e] * (1 + up / 50);
  });
  let to = -1;
  for (let i = 0; i < mesh.n; i++) if (i !== from && target(i) && Number.isFinite(dist[i]) && (to < 0 || dist[i] < dist[to])) to = i;
  if (to < 0) return [from];
  const path = [to];
  let cur = to;
  for (let guard = 0; cur !== from && guard < mesh.n; guard++) {
    let best = -1;
    let bd = dist[cur];
    for (let e = mesh.off[cur]; e < mesh.off[cur + 1]; e++) {
      const j = mesh.adj[e];
      if (dist[j] < bd) {
        bd = dist[j];
        best = j;
      }
    }
    if (best < 0) break;
    path.push(best);
    cur = best;
  }
  return path.reverse();
}

// ---------- 自定义走向（第八轮）：河完全照着画的线走 ----------
//
// 画的线先磨圆、化简成折线（存进命令的就是它），河道是折线经过的格：沿折线每隔四分之一格取一点，
// 每点所在的格依次连起来（跳过了格就用两边都挨着的格补上）。所以屏幕上画的线、存下的折线、河道三者一致。
// 碰到别的河不停，照着画的走（会截走那条河，界面上先问一句）；进海、进湖就结束，多画的丢掉

export type CourseEnd = 'sea' | 'lake' | 'river' | 'edge' | 'sink';

export interface CourseCrossing {
  // 河道上穿过别的河的那一段（cells 的下标，含两端）
  from: number;
  to: number;
  // 穿过的第一格（按它找那条河的名字）
  cell: number;
  // 这一段属于哪条画的河；自然的河为 null
  guide: string | null;
  // 截走以后下游会变干的格（估算，按原来的流向排列）
  dried: number[];
}

export interface CoursePlan {
  // 相邻格组成的河道：画的线经过的格，再加上画完之后顺地势流下去的那段（endOnLand 为 flow 时）
  cells: number[];
  // 画的折线（已化简、取整）：存进命令的是 encodePath(path)。折线上每隔四分之一格取的点都落在 cells 里
  path: [number, number][];
  // 画的线到 cells 的第几格为止（之后是顺地势流下去的那段）
  drawn: number;
  // 流到哪里；画不出时为 null
  end: CourseEnd | null;
  // 汇入的那一格（end 为 river 时），否则 -1
  join: number;
  // 从一条河上开始画：这条河从这里改走画的路线（命令里的 reroute）
  reroute: boolean;
  // 改道从 cells 的第几格起（新画的河是 0；从一条河中间改道、河的上游一起留着时是上游的格数，见 rerouteCourse）
  rerouteAt: number;
  // 终点是一条画的、有泉水的河的源头：接到它前面，成为同一条河（见 mergeCourse）
  merge: string | null;
  crossings: CourseCrossing[];
  // 改道后原来的河道里会变干的格（估算）
  dried: number[];
  // 丢掉的那段线（进了海、湖或出了地图之后画的），灰色显示
  cut: [number, number][] | null;
  // 从海、湖往陆地上画的（从河口往上游画）：已经倒过来了
  reversed: boolean;
  // 估算（按现在的高程，挖法与 bedLevels 相同）：穿山挖出的峡谷最深多少米；有一段要往高处流多少米
  gorge: number;
  uphill: number;
  // 画不出来的原因
  blocked: string | null;
  // 画的线绕回了自己走过的格、剪掉的圈（每个圈是那一段取样点）：预览里黄色标出来，提示一声（第十三轮）
  loops: [number, number][][];
  // 这一笔新画的是 path 的第几个点到第几个点（重画一段、接着画时前后不动的不算；省略为整条）：重叠分析只看这一段
  changed?: [number, number];
  // 贴着别的河画、没有穿过去：在第一次碰到它的地方汇入（不截走它），这是碰到的那一格（第十三轮）
  touch?: number;
}

export interface CourseOptions {
  // 画到的终点还在陆地上时：顺着地势接着流（flow），还是在那里消失（sink）
  endOnLand: 'flow' | 'sink';
  // 画的时候一个屏幕像素合多少地图单位：化简的容差不小于它（缩小时画的手抖不记下来）
  px?: number;
  // 这条画的河自己的格不算交叉、不能汇入（重画它的一段时）
  ignoreGuide?: string;
  // 接着画的那段（base）是一条河从源头到起笔的那一格：从它的最后一格改道（见 rerouteCourse）。
  // own：这条河自己的格（往下的那段不能汇入：画到上面时顺着流下去，还是这一条河）
  reroute?: { own: readonly number[] };
}

export type Pt = [number, number];

export const emptyPlan = (): CoursePlan => ({
  cells: [],
  path: [],
  drawn: 0,
  end: null,
  join: -1,
  reroute: false,
  rerouteAt: 0,
  merge: null,
  crossings: [],
  dried: [],
  cut: null,
  reversed: false,
  gorge: 0,
  uphill: 0,
  blocked: null,
  loops: [],
});
