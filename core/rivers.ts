import { MISS, coastReads, keyAdd, keyAddPts, keyStart, memoActive, memoBegin, memoEnd, memoGet, memoMissStart, memoPeek, memoPut } from './coast-memo';
import { DELTA_DRAW, deltaMouths } from './delta';
import { type DisplayCoast, displayCoast, displayCoastAt, shoreCrossing } from './display';
import { wrapDelta, wrapX } from './geo';
import { type Mesh, findCell } from './mesh';
import { locate, vnoise } from './subcell';
import { COURSE_MAX_POINTS, type Derived, type Guide, type World } from './world';

// 河流折线：从源头顺流追到入海口、湖或与已画的河汇合处；加轻微的曲流并做 Chaikin 平滑。
// 屏幕与导出共用，所以导出的 rivers.bmp 与屏幕上的河一致。
// 画的河（有折线的河道）照存下的折线画（再平滑一遍），自然的支流画到它的线上为止。
// 入海、入湖的河画到画面上的岸线为止（core/display.ts 的 shoreCrossing：与地形层画海岸线的是同一个海岸场），
// 从湖里流出来的河从湖岸画起

export interface RiverLine {
  points: [number, number][];
  // 每个点处的流量（m³/s）
  flow: number[];
  // 每个点在哪一格（离它最近的那个沿河的点所在的格）：入海、入湖画到两格之间的那一点算河口那格，
  // 画到别的河上的最后一点算汇合的那格。点一下河选中它、把支流接到画的河上时用
  cells?: number[];
  // 画的河：每个点的粗细倍数（粗细；在终点消失的河最后一格收细）。省略为 1
  mul?: number[];
  // 画的河（有折线的河道）：河道的 id
  guide?: string;
  // 每个点是哪一种河（与 derived.riverType 相同：0 普通，k + 1 是第 k 种河流类型）。只在世界里有河流类型时才有；
  // 画到别的河上的最后一点算这条河自己的类型（带类型的支流画到汇合处为止都是它的样子）
  type?: number[];
  // 起点：'source' 是源头（画的时候收尖），'lake' 是从湖岸流出（不收尖）；省略的（接着画的线、截下的一段）两样都不是
  head?: 'source' | 'lake';
  // 最后一点在海、湖的岸线上（画的时候河口略张开、平头收在岸线上）
  mouth?: boolean;
  // 汇入别的河（最后一点画在那条河的线上）：那条河在 traceRivers 结果里的下标
  into?: number;
  // 别的河汇进来的地方：在这条线上的位置（第 k 段上 t 处记作 k + t）。画带子时这几处前后约半格不加细小的弯曲，
  // 支流的最后一点就落在画出来的中线上（三角洲分出去的一股从哪里分出去也记在这里）
  joins?: number[];
  // 三角洲分出去的一股（第三十三轮，只是画法）：从哪条河（traceRivers 结果里的下标）分出去。
  // 它的格都是那条河的河口那一格：点它选中那条河
  branch?: number;
}

// 支流从这一点接着画（画的河流到了别的河都不经过的地方：从它的线上接出去）
interface Lead {
  cell: number;
  p: [number, number];
  flow: number;
  from: number;
}

const WALK_SHORE = { samples: 12, bisect: 9 };

export function traceRivers(world: World): RiverLine[] {
  // 按画面海岸场的几样查询跨几次描河记下来（core/coast-memo.ts；结果逐位不变）
  memoBegin(world.mesh, world.small.terrain.coastRoughness);
  try {
    return traceRiversRaw(world);
  } finally {
    memoEnd();
  }
}

function traceRiversRaw(world: World): RiverLine[] {
  const { mesh, derived: d, causes, small } = world;
  const n = mesh.n;
  const thr = small.planet.riverThreshold;
  const isRiver = (i: number) => causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= thr;
  // 每格的干流上游：流进来的河里水最多的（一样多时编号小的；与地名、点选一条河认干流的办法相同）。
  // 河在汇合处顺着水多的那条往下画，水少的画到它的线上为止
  const main = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!isRiver(i)) continue;
    const r = d.receiver[i];
    if (r < 0 || !isRiver(r)) continue;
    const o = main[r];
    if (o < 0 || d.discharge[i] > d.discharge[o] || (d.discharge[i] === d.discharge[o] && i < o)) main[r] = i;
  }
  const sources: number[] = [];
  for (let i = 0; i < n; i++) if (isRiver(i) && main[i] < 0) sources.push(i);
  // 源头高的先画（画的先后只影响结果里的顺序）
  sources.sort((a, b) => d.elevation[b] - d.elevation[a]);
  const visited = new Uint8Array(n);
  // 整个星球：沿河展开经度（每一点取离上一点最近的那一份），跨过经度 180° 的河也是连续的一条线；
  // 画的时候每一份平铺的副本各画一遍
  const sphere = mesh.kind === 'sphere';
  const xAt = (c: number, ref: number) => (sphere ? ref + (mesh.x[c] - ref - 2 * Math.round((mesh.x[c] - ref) / 2)) : mesh.x[c]);
  // 画的河先定下来（沿途的格算画过了）；没有画的河时什么都不做
  const course = small.guides.some((g) => g.path) ? courseIndex(world, isRiver, visited) : null;
  // 河流类型（第三批）：每个点带上是哪一种河。没有河流类型时不带（点、流量照旧逐位不变）
  const rt = d.riverType;
  const water = (c: number) => !causes.land[c] || d.lake[c] === 1;
  // 从湖里流出来的河：源头那格的上游是湖（取流量最大的那一格湖），河从这一格湖的岸线画起
  const lakeDonor = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    if (!causes.land[j] || d.lake[j] !== 1) continue;
    const r = d.receiver[j];
    if (r < 0 || !isRiver(r)) continue;
    const o = lakeDonor[r];
    if (o < 0 || d.discharge[j] > d.discharge[o] || (d.discharge[j] === d.discharge[o] && j < o)) lakeDonor[r] = j;
  }
  // 画到岸线：从 a 往 b（水里）走到画面上的岸线，找不到时（a 在画面上已是水面）退回两点的中点
  // 一格长的线：等分 12 个点、二分 9 次（准到千分之一格的六分之一）
  let field: DisplayCoast | null = null;
  const coastField = () => (field ??= displayCoast(world));
  const shore = (a: [number, number], b: [number, number], c: number, r: number): [number, number] => walkShore(world, coastField(), a, b, c, r);
  // 沿河的点（平滑之前）。汇入自然的河的线等那条河画好了再定最后一点（画到它平滑后的线上）、再平滑
  interface Raw {
    pts: [number, number][];
    flow: number[];
    cells: number[];
    tags?: number[];
    head?: 'source' | 'lake';
    mouth: boolean;
    // 汇入的那一格（自然的河的）
    join: number;
    line?: RiverLine;
  }
  const raws: Raw[] = [];
  // 每格是哪一条（raws 的下标）流过的
  const lineAt = new Int32Array(n).fill(-1);
  // 汇入画的河：那条线与汇入的位置
  const courseJoin = new Map<Raw, { line: RiverLine; k: number }>();
  const walk = (s: number, lead?: Lead) => {
    const pts: [number, number][] = [];
    const flow: number[] = [];
    const cells: number[] = [];
    const tags: number[] | undefined = rt ? [] : undefined;
    // 画到别的河上的那一点：算这条河自己的类型（前一点的）
    const own = () => (tags && tags.length ? tags[tags.length - 1] : 0);
    const self = raws.length;
    let c = s;
    let cx = mesh.x[s];
    let mouth = false;
    let join = -1;
    let onCourse: { line: RiverLine; k: number } | null = null;
    // 前面接着画的线已经流过这一格：只画到这一格（与支流画到画过的格一样），不然画的河在这里断开
    const reached = lead !== undefined && visited[s] === 1;
    const fromLake = !lead && lakeDonor[s] >= 0;
    if (fromLake) {
      // 从湖岸画起：源头那格往湖里那一格走到岸线
      const j = lakeDonor[s];
      pts.push(shore([cx, mesh.y[s]], [xAt(j, cx), mesh.y[j]], s, j));
      flow.push(d.discharge[s]);
      cells.push(s);
      tags?.push(rt![s]);
    }
    if (lead) {
      pts.push(lead.p);
      flow.push(lead.flow);
      cells.push(lead.from);
      tags?.push(rt![lead.from]);
      cx = lead.p[0];
      if (reached) {
        pts.push([xAt(s, cx), mesh.y[s]]);
        flow.push(d.discharge[s]);
        cells.push(s);
        tags?.push(own());
        join = s;
      }
    }
    for (let guard = 0; guard < n && !reached; guard++) {
      cx = xAt(c, cx);
      pts.push([cx, mesh.y[c]]);
      flow.push(d.discharge[c]);
      cells.push(c);
      tags?.push(rt![c]);
      visited[c] = 1;
      if (lineAt[c] < 0) lineAt[c] = self;
      const r = d.receiver[c];
      if (r < 0) break;
      if (water(r)) {
        // 入海、入湖：画到画面上的岸线
        pts.push(shore([cx, mesh.y[c]], [xAt(r, cx), mesh.y[r]], c, r));
        flow.push(d.discharge[c]);
        cells.push(c);
        tags?.push(rt![c]);
        mouth = true;
        break;
      }
      if (!isRiver(r)) break;
      if (visited[r] || main[r] !== c) {
        // 汇入别的河（画过的格，或者这里水更多的那条接着往下流）：画到它的线上（不是那一格的格心）。
        // 画的河的线已经定了，现在就画上去；自然的河等它画好了再定（见下面）
        const hit = course?.snap(r, cx, mesh.y[c]) ?? null;
        if (hit) onCourse = hit;
        pts.push(hit ? hit.p : [xAt(r, cx), mesh.y[r]]);
        flow.push(d.discharge[r]);
        cells.push(r);
        tags?.push(own());
        if (!hit) join = r;
        break;
      }
      c = r;
    }
    if (pts.length < 2) return;
    const raw: Raw = { pts, flow, cells, tags, mouth, join };
    if (!lead) raw.head = fromLake ? 'lake' : 'source';
    if (onCourse) courseJoin.set(raw, onCourse);
    raws.push(raw);
  };
  if (course) for (const lead of course.leads) walk(lead.cell, lead);
  for (const s of sources) {
    if (visited[s]) continue;
    walk(s);
  }
  // 平滑成线：汇入自然的河的，先画好那条河，再把最后一点放到它平滑后的线上（离上一格的格心最近的那一点）
  const lines: RiverLine[] = new Array(raws.length);
  const deferred = new Set<RiverLine>();
  const before = new Map<RiverLine, RiverLine>();
  const finish = (i: number, depth: number): RiverLine => {
    const raw = raws[i];
    if (raw.line) return raw.line;
    let into: RiverLine | null = null;
    let at = -1;
    if (raw.join >= 0) {
      const t = lineAt[raw.join];
      if (t >= 0 && t !== i && depth < n) {
        into = finish(t, depth + 1);
        const m = raw.pts.length;
        const [px, py] = raw.pts[m - 2];
        const hit = projectNear(into, raw.join, px, py, mesh.spacing, sphere);
        if (hit) {
          raw.pts[m - 1] = hit.p;
          at = hit.k + hit.t;
        } else into = null;
      }
    }
    const line = smoothCourse(raw.pts, raw.flow, mesh.spacing, raw.cells, raw.tags);
    if (raw.head) line.head = raw.head;
    if (raw.mouth) {
      line.mouth = true;
      // 别的河还没接上来（接到它的线上之前）：最后一段改成沿岸线的法向进海、进湖。
      // 海岸边的源头小河多半不画（见 tidyMouths），留到那时再改
      if (raw.head === 'source' && lineLength(line.points) < STUB_LEN * mesh.spacing) deferred.add(line);
      else {
        // 原来的样子留着（河口挤在一起、挪不开也并不进去时退回去）：normalMouth 换的是新数组
        before.set(line, { ...line });
        normalMouth(world, coastField(), line, 0);
      }
    }
    if (into) {
      markJoin(into, at);
      line.into = lineAt[raw.join];
    }
    const c = courseJoin.get(raw);
    if (c) markJoin(c.line, c.k);
    raw.line = line;
    lines[i] = line;
    return line;
  };
  for (let i = 0; i < raws.length; i++) finish(i, 0);
  const tidy = tidyMouths(world, lines, coastField(), deferred, before);
  if (!course) return withBranches(world, coastField(), tidy);
  lines.length = 0;
  lines.push(...tidy);
  for (const line of lines) course.own(line);
  course.finish();
  if (rt) course.tag(rt);
  // 画的河画在自然的河之后
  // 汇入哪一条（结果里的下标：自然的河在前，下标就是 raws 的下标）
  const all = [...lines, ...course.lines];
  const index = new Map(all.map((l, k) => [l, k]));
  for (const [raw, c] of courseJoin) raw.line!.into = index.get(c.line);
  for (const [line, target] of course.intos) line.into = index.get(target);
  return withBranches(world, coastField(), all);
}

// 画的河在 traceRivers 里的那部分：按存下的折线画成几段（只画看得见是河的格：入海、入湖的那一点也画，
// 水被截走、在海里的那段不画），记下每一格是哪条线画的、在线上的哪几个点之间，
// 自然的支流画到画的河的线上，画的河汇入别的河时也画到那条河的线上
function courseIndex(world: World, isRiver: (i: number) => boolean, visited: Uint8Array) {
  const { mesh, derived: d, causes, small } = world;
  const n = mesh.n;
  const sphere = mesh.kind === 'sphere';
  const water = (c: number) => !causes.land[c] || d.lake[c] === 1;
  // 这一点在画面上是不是陆地（河口退回到画面上的陆地再找岸线）
  const coastField = displayCoast(world);
  const onLand = (pt: readonly [number, number], hint: number) => displayCoastAt(world, coastField, pt[0], pt[1], hint, true).v > 0;
  // 每格由哪条线画（先画的算）、在它的第几个点到第几个点之间
  const owner: (RiverLine | undefined)[] = new Array(n);
  // 每格流过它的自然的河（在这一格汇入别的河、入海的不算）
  const through = new Map<number, RiverLine>();
  const from = new Int32Array(n);
  const to = new Int32Array(n);
  const take = (line: RiverLine, k: number, c: number) => {
    if (owner[c] === undefined) {
      owner[c] = line;
      from[c] = to[c] = k;
    } else if (owner[c] === line) to[c] = k;
  };
  const guides = small.guides.filter((g) => g.path);
  // 每格在哪条画的河的河道上（终点那格除外：那是海、湖或者别的河；在终点消失的含终点）
  const bodyOf = new Int32Array(n).fill(-1);
  guides.forEach((g, gi) => {
    const m = g.end === 'sink' ? g.cells.length : g.cells.length - 1;
    for (let k = g.branch ? 1 : 0; k < m; k++) if (bodyOf[g.cells[k]] < 0) bodyOf[g.cells[k]] = gi;
  });
  const lines: RiverLine[] = [];
  const joins: { line: RiverLine; cell: number }[] = [];
  const splits: { line: RiverLine; cell: number }[] = [];
  // 汇入别的河的画的河（每一段）汇入的那一格
  const joinCell = new Map<RiverLine, number>();
  guides.forEach((g, gi) => {
    const { points, cellIdx } = guideLine(world, g);
    const cells = g.cells;
    const last = cells.length - 1;
    const L = cells[last];
    // 终点那格是别的河的（汇入）：它不算这条河的格，这条河画到那条河的线上为止
    const join = g.end !== 'sink' && !water(L) && ((bodyOf[L] >= 0 && bodyOf[L] !== gi) || joinsRiver(world, d, g));
    const width = g.width ?? 1;
    const runs: RiverLine[] = [];
    let run: RiverLine | null = null;
    // 第 k 个点画在哪一段的第几个点
    const where: ({ run: RiverLine; j: number } | undefined)[] = new Array(points.length);
    for (let k = 0; k < points.length; k++) {
      const i = cellIdx[k];
      const c = cells[i];
      let q = -1;
      let tag = c;
      let mouth = false;
      if (water(c)) {
        // 河口：画到画面上的岸线（从上一点往这一点走到岸线），流量按上一格。
        // 后来海、湖淹到了河道上时，不会一直画进水里
        if (i > 0 && isRiver(cells[i - 1]) && cellIdx[k - 1] !== i) {
          tag = cells[i - 1];
          q = d.discharge[tag];
          mouth = true;
        }
      } else if (isRiver(c)) q = d.discharge[join && i === last ? cells[last - 1] : g.branch && i === 0 && cells.length > 1 ? cells[1] : c];
      if (q < 0) {
        run = null;
        continue;
      }
      let p = points[k];
      if (mouth && run) {
        // 上一两点在画面上已经是水面（岸线的细节伸进了河道）：退回到画面上的陆地，从那里走到岸线
        let b: [number, number] = points[k];
        for (let back = 0; back < 3 && run.points.length > 1 && !onLand(run.points[run.points.length - 1], tag); back++) {
          b = run.points.pop()!;
          run.flow.pop();
          run.cells!.pop();
          run.mul!.pop();
        }
        const a = run.points[run.points.length - 1];
        p = shoreCrossing(world, a, b, tag)?.p ?? points[k];        for (let j = 0; j < k; j++) if (where[j]?.run === run && where[j]!.j >= run.points.length) where[j] = { run, j: run.points.length - 1 };
      }
      if (!run) {
        runs.push((run = { points: [], flow: [], cells: [], mul: [], guide: g.id }));
        // 从湖里流出来：从湖岸画起（从这一点往湖里的上一点走到岸线）
        if (k > 0 && i > 0 && d.lake[cells[cellIdx[k - 1]]] === 1 && causes.land[cells[cellIdx[k - 1]]] && onLand(points[k], c)) {
          const hit = shoreCrossing(world, points[k], points[k - 1], c);
          if (hit) {
            run.points.push(hit.p);
            run.flow.push(q);
            run.cells!.push(tag);
            run.mul!.push(width);
            run.head = 'lake';
          }
        } else if (k === 0 && g.spring) run.head = 'source';
      }
      where[k] = { run, j: run.points.length };
      run.points.push(p);
      run.flow.push(q);
      run.cells!.push(tag);
      run.mul!.push(width);
      if (mouth) run.mouth = true;
    }
    const kept = runs.filter((r) => r.points.length >= 2);
    // 河口：最后一段沿岸线的法向进水（与自然的河相同，见 normalMouth）
    for (const r of kept) {
      if (!r.mouth) continue;
      normalMouth(world, coastField, r, 0);
      for (let j = 0; j < where.length; j++) if (where[j]?.run === r && where[j]!.j >= r.points.length) where[j] = { run: r, j: r.points.length - 1 };
    }
    const tail = kept[kept.length - 1];
    if (tail && g.end === 'sink' && cellIdx[points.length - 1] === last && tail.points[tail.points.length - 1] === points[points.length - 1]) {
      // 在终点消失：最后一格的长度上收细到三成
      const len = mesh.spacing;
      let s = 0;
      for (let k = tail.points.length - 1; k >= 0 && s < len; k--) {
        tail.mul![k] = width * (0.3 + (0.7 * s) / len);
        if (k > 0) s += Math.hypot(tail.points[k][0] - tail.points[k - 1][0], tail.points[k][1] - tail.points[k - 1][1]);
      }
    }
    for (const r of kept) {
      r.cells!.forEach((c, k) => {
        if (join && c === L) return;
        // 分出去的一股：起点那格是干流的（干流照常画过它）
        if (g.branch && c === cells[0]) return;
        if (owner[c] === undefined) visited[c] = 1;
        take(r, k, c);
      });
      lines.push(r);
      if (join) joinCell.set(r, L);
    }
    // 平滑后的线擦过去、一个点也没落进的格（画的线擦过一个角时补上的格）：算在下一个点那里
    for (let i = g.branch ? 1 : 0, k = 0; i < last; i++) {
      const c = cells[i];
      while (k < points.length && cellIdx[k] < i) k++;
      const at = where[k];
      if (owner[c] !== undefined || !isRiver(c) || !at || at.run.points.length < 2) continue;
      visited[c] = 1;
      take(at.run, at.j, c);
    }
    if (join && tail && tail.cells![tail.cells!.length - 1] === L) joins.push({ line: tail, cell: L });
    // 分出去的一股：第一点画到干流的线上（干流画好以后，见 finish）
    const head = kept[0];
    if (g.branch && head && head.cells![0] === cells[0]) splits.push({ line: head, cell: cells[0] });
  });

  // 画的河的水流到了画的河都不经过的格（比它流进的那条自然的河大、终点那格算它的，或者有一段没按画的走）：
  // 从它的线上接着往下画。那一格还有别的支流流进来也接着画（那条支流画到这里为止），不然线会断开一格；
  // 汇入别的河的那一格不接（画到那条河的线上，见 finish）
  const leads: Lead[] = [];
  const led = new Set<number>();
  for (const line of lines) {
    line.cells!.forEach((c, k) => {
      if (owner[c] !== line || to[c] !== k) return;
      const r = d.receiver[c];
      if (r < 0 || !isRiver(r) || visited[r] || led.has(r) || joinCell.get(line) === r) return;
      led.add(r);
      leads.push({ cell: r, p: [line.points[k][0], line.points[k][1]], flow: d.discharge[c], from: c });
    });
  }

  // 点 (x, y) 投影到格 c 所在那条线上 c 附近的几段（只在这几段里找，所以不会接到远处；隔得太远时不接）
  const intos = new Map<RiverLine, RiverLine>();
  const project = (c: number, x: number, y: number) => {
    const o = owner[c];
    if (!o) return null;
    const hit = snapOnto(o.points, x, y, Math.max(0, from[c] - 1), Math.min(o.points.length - 1, to[c] + 1), sphere);
    return hit && hit.d <= 3 * mesh.spacing ? hit : null;
  };
  return {
    lines,
    leads,
    // 自然的河汇入画的河：画到它的线上（p），那条线（line）上第 k 段 t 处记作 k + t
    snap(r: number, x: number, y: number): { p: [number, number]; line: RiverLine; k: number } | null {
      const o = owner[r];
      if (o?.guide === undefined) return null;
      const hit = project(r, x, y);
      return hit ? { p: hit.p, line: o, k: hit.k + hit.t } : null;
    },
    // 画的河汇入别的河：汇入的那一条
    intos,
    own(line: RiverLine) {
      const cs = line.cells!;
      cs.forEach((c, k) => {
        take(line, k, c);
        // 流过这一格（不是在这一格汇入别的河、入海）的那条：分出去的一股顺着它的方向分出来
        if (k < cs.length - 1 && cs[cs.length - 1] !== c && !through.has(c)) through.set(c, line);
      });
    },
    // 河流类型：每个点按它的格；汇入别的河的那一格（那条河的）按这条河自己的
    tag(rt: Uint8Array) {
      for (const line of lines) {
        const L = joinCell.get(line);
        const t: number[] = [];
        for (const c of line.cells!) t.push(c === L && t.length ? t[t.length - 1] : rt[c]);
        line.type = t;
      }
    },
    // 画的河汇入别的河：在汇合的那格里离那条河的线最近的点截住，画到那条线上
    finish() {
      // 分出去的一股从干流画出来的线上起（干流在那里不加细小的弯曲）
      for (const { line, cell } of splits) {
        // 干流：流过分出的那一格的那条（不是在那里汇入的支流），没有时按这一格是哪条线画的
        const t = through.get(cell);
        const o = t && t !== line ? t : owner[cell];
        if (!o || o === line) continue;
        let hit: { p: [number, number]; k: number; t: number; d: number } | null = null;
        if (o === owner[cell]) hit = project(cell, line.points[0][0], line.points[0][1]);
        else {
          const i0 = o.cells!.indexOf(cell);
          const h = snapOnto(o.points, line.points[0][0], line.points[0][1], Math.max(0, i0 - 1), Math.min(o.points.length - 1, o.cells!.lastIndexOf(cell) + 1), sphere);
          hit = h && h.d <= 3 * mesh.spacing ? h : null;
        }
        if (!hit) continue;
        line.points[0] = hit.p;
        const a = o.points[hit.k];
        const b = o.points[Math.min(o.points.length - 1, hit.k + 1)];
        const cells0 = line.cells!;
        const moved = branchStart(line, [b[0] - a[0], b[1] - a[1]], mesh.spacing);
        if (moved) {
          // 这一股上每格的点的范围往后挪（开头那段多了几个点）
          const seen = new Set<number>();
          for (const c of cells0) {
            if (owner[c] !== line || seen.has(c)) continue;
            seen.add(c);
            if (from[c] >= moved.k) from[c] += moved.added;
            if (to[c] >= moved.k) to[c] += moved.added;
          }
        }
        markJoin(o, hit.k + hit.t);
      }
      for (const { line, cell } of joins) {
        if (!cutAtJoin(line, cell, (x, y) => project(cell, x, y))) continue;
        const end = line.points[line.points.length - 1];
        const hit = project(cell, end[0], end[1]);
        if (!hit) continue;
        markJoin(owner[cell]!, hit.k + hit.t);
        intos.set(line, owner[cell]!);
      }
    },
  };
}

// 分出去的一股的开头顺着干流（第十三轮）：第一点在干流的线上，从那里顺着干流往下游的方向 td，用一段三次曲线
// 渐渐离开干流，接到这一股往下约 1.2 格（短的一股不超过它的一半）的第 k 个点上（到那里顺着这一股原来的方向）。
// 第 1 到 k − 1 个点换成曲线上每隔约 1/16 格的点（流量、格、粗细按在这一段里的位置取原来那几个点的）。
// 返回 k 与多出来的点数（按下标记的东西要往后挪）；原来的方向与干流往下游差得超过 100°（往上游分出去）、
// 这一段里有别的河汇进来时不改，返回 null
export function branchStart(line: RiverLine, td: readonly [number, number], spacing: number): { k: number; added: number } | null {
  const P = line.points;
  const tl = Math.hypot(td[0], td[1]);
  if (P.length < 3 || !(tl > 0)) return null;
  const t0: [number, number] = [td[0] / tl, td[1] / tl];
  const L = Math.min(1.2 * spacing, 0.5 * lineLength(P));
  let k = 0;
  for (let s = 0; k + 1 < P.length && s < L; k++) s += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
  if (k < 1 || k >= P.length - 1 || (line.joins ?? []).some((pos) => pos < k)) return null;
  const A = P[0];
  const B = P[k];
  const D = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (!(D > 0) || (t0[0] * (B[0] - A[0]) + t0[1] * (B[1] - A[1])) / D < Math.cos((100 * Math.PI) / 180)) return null;
  // 曲线上的点（不含 A、B）：三次 Bezier，开头的控制点顺着干流伸出半段长（多贴着干流走一会儿再离开）
  const tb = dirAt(P, k);
  const c1: [number, number] = [A[0] + t0[0] * 0.6 * D, A[1] + t0[1] * 0.6 * D];
  const c2: [number, number] = [B[0] - tb[0] * 0.25 * D, B[1] - tb[1] * 0.25 * D];
  const n = Math.max(2, Math.ceil(D / (spacing / 16)));
  const pts: [number, number][] = [];
  for (let j = 1; j < n; j++) {
    const u = j / n;
    const v = 1 - u;
    pts.push([v * v * v * A[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * B[0], v * v * v * A[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * B[1]]);
  }
  const count = pts.length + 1;
  const pick = <T>(arr: T[]) => [arr[0], ...pts.map((_, j) => arr[Math.min(k, Math.max(1, Math.round(((j + 1) / count) * k)))]), ...arr.slice(k)];
  line.points = [[A[0], A[1]], ...pts, ...P.slice(k)];
  line.flow = pick(line.flow);
  if (line.cells) line.cells = pick(line.cells);
  if (line.mul) line.mul = pick(line.mul);
  if (line.type) line.type = pick(line.type);
  const added = pts.length - (k - 1);
  if (line.joins) line.joins = line.joins.map((pos) => pos + added);
  return { k, added };
}

// 汇入别的河的线（每个点带着格）在汇合的那一格里截住：那格里（从线尾往回）离那条河的线最近的点，最后一点画到那条线上。
// project 给出一点投影到那条河的线上的点与距离（离得太远为 null）。地图上画的河与画河时的预览共用（汇入的地方画得一样）
export function cutAtJoin(
  line: { points: [number, number][]; flow: number[]; cells?: number[]; mul?: number[] },
  cell: number,
  project: (x: number, y: number) => { p: [number, number]; d: number } | null,
): boolean {
  let best: { k: number; p: [number, number]; d: number } | null = null;
  for (let k = line.points.length - 1; k >= 0 && line.cells![k] === cell; k--) {
    const hit = project(line.points[k][0], line.points[k][1]);
    if (hit && (!best || hit.d < best.d)) best = { k, p: hit.p, d: hit.d };
  }
  if (!best) return false;
  const keep = best.k + 1;
  line.points.length = keep;
  line.flow.length = keep;
  line.cells!.length = keep;
  if (line.mul) line.mul.length = keep;
  line.points.push(best.p);
  line.flow.push(line.flow[keep - 1]);
  line.cells!.push(cell);
  line.mul?.push(line.mul[keep - 1]);
  return true;
}

// 一点投影到河线 line 上格 cell 附近的几段（cell 在线上的第一个到最后一个点，前后各多一段）；隔得太远（3 格以上）为 null
export function projectNear(line: RiverLine, cell: number, x: number, y: number, spacing: number, sphere: boolean): { p: [number, number]; k: number; t: number; d: number } | null {
  const cells = line.cells;
  if (!cells) return null;
  const from = cells.indexOf(cell);
  if (from < 0) return null;
  const to = cells.lastIndexOf(cell);
  const hit = snapOnto(line.points, x, y, Math.max(0, from - 1), Math.min(line.points.length - 1, to + 1), sphere);
  return hit && hit.d <= 3 * spacing ? hit : null;
}

// 点 (x, y) 到折线 line 第 from 到 to 个点之间那几段上最近的点：p 是那一点，k 是第几段，d 是距离。
// 整个星球（sphere）：每段按经度就近比，p 与 x 在同一份上
export function snapOnto(
  line: readonly (readonly [number, number])[],
  x: number,
  y: number,
  from = 0,
  to = line.length - 1,
  sphere = false,
): { p: [number, number]; k: number; t: number; d: number } | null {
  let best: { p: [number, number]; k: number; t: number; d: number } | null = null;
  for (let k = Math.max(0, from); k < Math.min(to, line.length - 1); k++) {
    const [ax, ay] = line[k];
    const [bx, by] = line[k + 1];
    const shift = sphere ? 2 * Math.round((x - ax) / 2) : 0;
    const r = segProject(x - shift, y, ax, ay, bx, by);
    if (best && r.d >= best.d) continue;
    best = { p: [ax + (bx - ax) * r.t + shift, ay + (by - ay) * r.t], k, t: r.t, d: r.d };
  }
  return best;
}

// 记下别的河在线上第 k 段 t 处（pos = k + t）汇进来（见 RiverLine.joins）
function markJoin(line: RiverLine, pos: number): void {
  (line.joins ??= []).push(pos);
}

// ---------- 河口（第十三轮） ----------
// 河口那一段沿岸线的法向进海、进湖：原来最后一段对着它流进的那格水的格心，斜着碰到岸线（中位数约 22°，一成多超过 45°），
// 平头的末端就跨在岸线上。现在从河口往回约 0.9 格起，用一段三次 Hermite 曲线接到岸线上（起点顺着原来的方向，
// 终点沿岸线的法向），终点是从岸上沿法向走到岸线的那一点。只改画法（屏幕、导出），水文、流向都不变。
// 法向与原来的方向差得太多（超过 70°）时往原来的方向偏回来；接出来的一段在河口附近急转（超过 60°）时换长一点的一段，
// 还不行就照原来的样子画（河口附近从不画出钩子）

// 河口往回多长（格）换成沿法向进海的一段；急转时再试长一点的
const MOUTH_LEGS = [0.9, 1.4, 2];
// 量岸线法向的圈的半径（格）与取几个点：海岸细节的小弯不算，量的是约一格见方的岸线走向
const NORMAL_R = 0.4;
const NORMAL_N = 8;
// 进水的方向与原来的方向最多差多少（度）
const END_TURN = 70;
// 河口附近（最后约 1.5 格）接出来的线上任何地方最多转多少（度）：按相隔 1/4 格的前后两段弦量（见 maxTurn）
export const MOUTH_MAX_TURN = 60;
export const TURN_CHORD = 0.25;
// 沿法向找岸线（线只有一格多长）：等分 6 个点、二分 8 次
const SHORE_STEPS = { samples: 6, bisect: 8 };
// 法向按海岸场 / 50 夹在 ±1 之间加权
const NORMAL_CLAMP = 50;

type Pt = [number, number];

// 画面上的这一点是不是陆地（只要正负）
const landAt = (world: World, f: DisplayCoast, q: readonly [number, number], hint: number) => displayCoastAt(world, f, q[0], q[1], hint, true).v > 0;

// ---- 跨几次描河记下来的查询（core/coast-memo.ts）：键是全部参数，结果复制一份。不在描河里（memoActive 为假）时照常算 ----
const Q_WALK = 1;
const Q_CIRCLE = 2;
const Q_NORMAL = 3;
const Q_LAND = 4;
const Q_MOUTH = 5;
const Q_ALONG = 6;
const Q_CROSS = 7;
const copyPt = (p: readonly [number, number] | null): Pt | null => (p ? [p[0], p[1]] : null);

// walk 里入海、入湖的那一点：从 a 往 b（水里）走到画面上的岸线（a、b 是相邻两格 c、r 的格心），找不到时退回两点的中点
function walkShore(world: World, f: DisplayCoast, a: [number, number], b: [number, number], c: number, r: number): [number, number] {
  if (!memoActive()) return walkShoreRaw(world, a, b, c, r);
  keyStart(Q_WALK);
  keyAddPts([a, b], 0, 2);
  keyAdd(c);
  keyAdd(r);
  const m = memoGet(f);
  if (m !== MISS) return copyPt(m as Pt)!;
  const p = walkShoreRaw(world, a, b, c, r);
  memoPut(f, copyPt(p));
  return p;
}
const walkShoreRaw = (world: World, a: [number, number], b: [number, number], c: number, r: number): [number, number] => shoreCrossing(world, a, b, c, [c, r], WALK_SHORE)?.p ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// pts 的前 n 个点都在画面上的陆地上
function allLand(world: World, f: DisplayCoast, pts: readonly (readonly [number, number])[], n: number, hint: number): boolean {
  if (!memoActive()) return allLandRaw(world, f, pts, n, hint);
  keyStart(Q_LAND);
  keyAdd(hint);
  keyAddPts(pts, 0, n);
  const m = memoGet(f);
  if (m !== MISS) return m as boolean;
  const v = allLandRaw(world, f, pts, n, hint);
  memoPut(f, v);
  return v;
}
function allLandRaw(world: World, f: DisplayCoast, pts: readonly (readonly [number, number])[], n: number, hint: number): boolean {
  for (let j = 0; j < n; j++) if (!landAt(world, f, pts[j], hint)) return false;
  return true;
}

// 从 a 往 b 走到画面上的岸线（shoreCrossing，不沿边）
function shoreCross(world: World, f: DisplayCoast, a: readonly [number, number], b: readonly [number, number], hint: number, steps: { samples: number; bisect: number }): { p: Pt; t: number } | null {
  if (!memoActive()) return shoreCrossing(world, a, b, hint, undefined, steps);
  keyStart(Q_CROSS);
  keyAddPts([a, b], 0, 2);
  keyAdd(hint);
  keyAdd(steps.samples);
  keyAdd(steps.bisect);
  const m = memoGet(f);
  if (m !== MISS) {
    const v = m as { p: Pt; t: number } | null;
    return v && { p: [v.p[0], v.p[1]], t: v.t };
  }
  const v = shoreCrossing(world, a, b, hint, undefined, steps);
  memoPut(f, v && { p: [v.p[0], v.p[1]], t: v.t });
  return v;
}

// 海岸场三角形内插的那部分（不加格以下的海岸细节）：量岸线的法向用（量的是约一格见方的岸线走向，细节的小弯本来就不算）
function coastSmooth(world: World, f: DisplayCoast, x: number, y: number, hint: number): { v: number; nearest: number } {
  const { mesh } = world;
  const loc = locate(mesh, mesh.kind === 'sphere' ? wrapX(x) : x, y, hint);
  const [a, b, c] = loc.i;
  const [wa, wb, wc] = loc.w;
  if (coastReads.on) coastReads.cells.push(a, b, c);
  return { v: f.coast[a] * wa + f.coast[b] * wb + f.coast[c] * wc, nearest: loc.nearest };
}

// 一点处岸线朝水面的法向（单位向量）：一圈点的海岸场（三角形内插的那部分）加权求和（离岸线约半格以内的一圈，近似梯度的反方向）
export function seawardNormal(world: World, f: DisplayCoast, p: readonly [number, number], hint = 0): [number, number] | null {
  if (!memoActive()) return seawardNormalRaw(world, f, p, hint);
  keyStart(Q_NORMAL);
  keyAddPts([p], 0, 1);
  keyAdd(hint);
  const m = memoGet(f);
  if (m !== MISS) return copyPt(m as Pt | null);
  const v = seawardNormalRaw(world, f, p, hint);
  memoPut(f, copyPt(v));
  return v;
}
function seawardNormalRaw(world: World, f: DisplayCoast, p: readonly [number, number], hint: number): [number, number] | null {
  const r = NORMAL_R * world.mesh.spacing;
  let gx = 0;
  let gy = 0;
  let h = hint;
  for (let i = 0; i < NORMAL_N; i++) {
    const a = (2 * Math.PI * i) / NORMAL_N;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const v = coastSmooth(world, f, p[0] + r * c, p[1] + r * s, h);
    h = v.nearest;
    // 海岸场正的是陆地：按它加权的方向指向陆地
    const w = Math.max(-1, Math.min(1, v.v / NORMAL_CLAMP));
    gx += w * c;
    gy += w * s;
  }
  const l = Math.hypot(gx, gy);
  return l > 1e-9 ? [-gx / l, -gy / l] : null;
}

// 从 q 附近沿方向 dir 走到画面上的岸线：从岸上（往回 0.6 格，不在陆地上时 0.25 格）走到水面。找不到时为 null
function shoreAlong(world: World, f: DisplayCoast, q: readonly [number, number], dir: readonly [number, number], hint: number): Pt | null {
  if (!memoActive()) return shoreAlongRaw(world, f, q, dir, hint);
  keyStart(Q_ALONG);
  keyAddPts([q, dir], 0, 2);
  keyAdd(hint);
  const m = memoGet(f);
  if (m !== MISS) return copyPt(m as Pt | null);
  const v = shoreAlongRaw(world, f, q, dir, hint);
  memoPut(f, copyPt(v));
  return v;
}
function shoreAlongRaw(world: World, f: DisplayCoast, q: readonly [number, number], dir: readonly [number, number], hint: number): Pt | null {
  const sp = world.mesh.spacing;
  let from: Pt = [q[0] - dir[0] * 0.6 * sp, q[1] - dir[1] * 0.6 * sp];
  if (!landAt(world, f, from, hint)) from = [q[0] - dir[0] * 0.25 * sp, q[1] - dir[1] * 0.25 * sp];
  if (!landAt(world, f, from, hint)) return null;
  return shoreCrossing(world, from, [q[0] + dir[0] * 0.6 * sp, q[1] + dir[1] * 0.6 * sp], hint, undefined, SHORE_STEPS)?.p ?? null;
}

// 河口那一点的岸线法向与岸线上的那一点（河口本来就在岸线上时就是它）。
// 按画面上的海岸场（同一个 DisplayCoast）记下来：同一个世界再画一遍河（预览、地图、导出）不再重算
interface MouthShore {
  n: Pt;
  p: Pt;
}
const shoreMemo = new WeakMap<DisplayCoast, Map<string, MouthShore | null>>();
function mouthShore(world: World, f: DisplayCoast, end: readonly [number, number], hint: number): MouthShore | null {
  if (memoActive()) {
    keyStart(Q_MOUTH);
    keyAddPts([end], 0, 1);
    keyAdd(hint);
    const m = memoGet(f);
    if (m !== MISS) return copyShore(m as MouthShore | null);
    const v = mouthShoreRaw(world, f, end, hint);
    memoPut(f, copyShore(v));
    return v;
  }
  let memo = shoreMemo.get(f);
  if (!memo) shoreMemo.set(f, (memo = new Map()));
  const key = `${end[0]},${end[1]},${hint}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const res = mouthShoreRaw(world, f, end, hint);
  memo.set(key, res);
  return res;
}
const copyShore = (v: MouthShore | null): MouthShore | null => v && { n: [v.n[0], v.n[1]], p: [v.p[0], v.p[1]] };
function mouthShoreRaw(world: World, f: DisplayCoast, end: readonly [number, number], hint: number): MouthShore | null {
  const sp = world.mesh.spacing;
  let res: MouthShore | null = null;
  const n0 = seawardNormal(world, f, end, hint);
  // 河口那一点本来就在岸线上（walk、courseIndex 找岸线时走到的那一点，刚过岸线在水面一侧）：直接用它，不必再沿法向找一遍
  if (n0 && !landAt(world, f, end, hint) && landAt(world, f, [end[0] - n0[0] * 0.01 * sp, end[1] - n0[1] * 0.01 * sp], hint)) res = { n: n0, p: [end[0], end[1]] };
  else {
    // 不在岸线上（找岸线没找到、退回到两格中点的）：沿法向走到岸线，按那一点的法向再找一次（挪得不多时不必）
    let e: readonly [number, number] = end;
    for (let it = 0; it < 2; it++) {
      const n = it === 0 ? n0 : seawardNormal(world, f, e, hint);
      if (!n) break;
      const p = shoreAlong(world, f, e, n, hint);
      if (!p) break;
      res = { n, p };
      if (Math.hypot(p[0] - e[0], p[1] - e[1]) < 0.15 * sp) break;
      e = p;
    }
  }
  return res;
}

// 折线上转得最急的地方（度）：沿线每隔 chord / 4 取点，量每一点前后各一段弦（长 chord）的方向差。
// from：从线头量起这么远以后的点才算
export function maxTurn(P: readonly (readonly [number, number])[], chord: number, from = 0): number {
  if (P.length < 2 || !(chord > 0)) return 0;
  const h = chord / 4;
  // 取样点放在反复用的数组里（每个河口都要量几次；不在这里新建闭包）
  let n = 0;
  n = pushTurn(n, P[0][0], P[0][1], 0);
  let acc = 0;
  let next = h;
  for (let k = 0; k + 1 < P.length; k++) {
    const dx = P[k + 1][0] - P[k][0];
    const dy = P[k + 1][1] - P[k][1];
    const l = Math.hypot(dx, dy);
    if (l <= 0) continue;
    while (next <= acc + l) {
      const t = (next - acc) / l;
      n = pushTurn(n, P[k][0] + dx * t, P[k][1] + dy * t, next);
      next += h;
    }
    acc += l;
  }
  if (acc - turnS[n - 1] > 1e-3 * h) n = pushTurn(n, P[P.length - 1][0], P[P.length - 1][1], acc);
  let worst = 0;
  for (let i = 4; i + 4 < n; i++) {
    if (turnS[i] < from) continue;
    const ax = turnX[i] - turnX[i - 4];
    const ay = turnY[i] - turnY[i - 4];
    const bx = turnX[i + 4] - turnX[i];
    const by = turnY[i + 4] - turnY[i];
    const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
  }
  return worst;
}
let turnX = new Float64Array(256);
let turnY = new Float64Array(256);
let turnS = new Float64Array(256);

// maxTurn 的取样点放进反复用的数组（不够时加倍），返回新的个数
function pushTurn(n: number, x: number, y: number, s: number): number {
  if (n >= turnX.length) {
    turnX = growF64(turnX);
    turnY = growF64(turnY);
    turnS = growF64(turnS);
  }
  turnX[n] = x;
  turnY[n] = y;
  turnS[n] = s;
  return n + 1;
}

function growF64(a: Float64Array): Float64Array<ArrayBuffer> {
  const b = new Float64Array(a.length * 2);
  b.set(a);
  return b;
}

// 从 A（方向 ta）到 B（到 B 时的方向 tb，都是单位向量）的三次 Hermite 曲线，每隔约 step 取一点（不含 A，含 B）
// sa、sb：两头的切向量再乘的倍数（默认按两点的距离；起点的小一点少鼓出去，终点的大一点早一点顺着终点的方向）
function hermite(A: readonly [number, number], ta: readonly [number, number], B: readonly [number, number], tb: readonly [number, number], step: number, sa = 1, sb = 1): Pt[] {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const count = Math.max(2, Math.ceil(L / step));
  const out: Pt[] = [];
  for (let j = 1; j <= count; j++) {
    const u = j / count;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    out.push(j === count ? [B[0], B[1]] : [h00 * A[0] + h10 * L * sa * ta[0] + h01 * B[0] + h11 * L * sb * tb[0], h00 * A[1] + h10 * L * sa * ta[1] + h01 * B[1] + h11 * L * sb * tb[1]]);
  }
  return out;
}

// 线上第 k 个点处顺流的方向（单位向量）
function dirAt(P: readonly (readonly [number, number])[], k: number): Pt {
  const a = k > 0 ? P[k - 1] : P[k];
  const b = k > 0 ? P[k] : P[Math.min(P.length - 1, k + 1)];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

// 线上第 k 个点往前约 0.3 格的那几个点（量接出来的一段与原来的线接得急不急时带上）
function before(P: readonly (readonly [number, number])[], k: number, sp: number): Pt[] {
  let c = k;
  for (let s = 0; c > 0 && s < 0.3 * sp; c--) s += Math.hypot(P[c][0] - P[c - 1][0], P[c][1] - P[c - 1][1]);
  return P.slice(c, k + 1).map((p) => [p[0], p[1]] as Pt);
}

// 入海、入湖的线的最后一段接到岸线上的 p（那里岸线的法向 n）：从河口往回约 leg 格的那一点（第 k 个点，keep 与别的河汇进来的地方以前不动；
// keep 为负时汇进来的地方也可以动）
// 起一段曲线。返回接出来的点（不含第 k 个点）；有一点在水里、转得太急时为 null
function mouthLeg(world: World, f: DisplayCoast, line: RiverLine, keep: number, n: Pt, p: Pt, leg: number, cap = 0.4, checkTurn = true): { k: number; pts: Pt[] } | null {
  const sp = world.mesh.spacing;
  const P = line.points;
  const m = P.length;
  if (m < 2) return null;
  const hint = line.cells?.[m - 1] ?? 0;
  // keep 为负：别的河汇进来的地方也可以动（调用的一方之后把它们重新接上）
  let lim = Math.max(0, keep);
  if (keep >= 0) for (const pos of line.joins ?? []) lim = Math.max(lim, Math.ceil(pos));
  let k = m - 1;
  let s = 0;
  // 短的线（比如分出去的一小股）最多换掉后四成（cap），前面照原来的走向
  const len = Math.min(leg * sp, cap * lineLength(P));
  while (k > lim && k > 0 && s < len) {
    s += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
    k--;
  }
  if (k >= m - 1) return null;
  const A = P[k];
  const t = dirAt(P, k);
  if (k === 0) {
    const l = Math.hypot(P[1][0] - A[0], P[1][1] - A[1]) || 1;
    t[0] = (P[1][0] - A[0]) / l;
    t[1] = (P[1][1] - A[1]) / l;
  }
  // 进水的方向：岸线的法向；与原来的方向差得超过 70° 时往原来的方向偏回来（贴着岸线走的不改）
  let d: Pt = n;
  let end: Pt = p;
  if (t[0] * n[0] + t[1] * n[1] < Math.cos((END_TURN * Math.PI) / 180)) {
    const a = ((t[0] * n[1] - t[1] * n[0] >= 0 ? 1 : -1) * END_TURN * Math.PI) / 180;
    d = [t[0] * Math.cos(a) - t[1] * Math.sin(a), t[0] * Math.sin(a) + t[1] * Math.cos(a)];
    if (d[0] * n[0] + d[1] * n[1] < 0.34) return null;
    const q = shoreAlong(world, f, p, d, hint);
    if (!q) return null;
    end = q;
  }
  const L = Math.hypot(end[0] - A[0], end[1] - A[1]);
  if (L < 0.15 * sp) return null;
  // 最后一小段（约 0.35 格）是沿进水方向的直线，之前用曲线从原来的方向弯过来
  const straight = Math.min(0.35 * sp, 0.4 * L);
  const Q: Pt = [end[0] - d[0] * straight, end[1] - d[1] * straight];
  const pts = hermite(A, t, Q, d, sp / 8);
  const ns = Math.max(1, Math.ceil(straight / (sp / 8)));
  for (let j = 1; j <= ns; j++) pts.push(j === ns ? [end[0], end[1]] : [Q[0] + (end[0] - Q[0]) * (j / ns), Q[1] + (end[1] - Q[1]) * (j / ns)]);
  if (!allLand(world, f, pts, pts.length - 1, hint)) return null;
  if (checkTurn && maxTurn([...before(P, k, sp), ...pts], TURN_CHORD * sp) > MOUTH_MAX_TURN) return null;
  return { k, pts };
}

// 把线的第 k 个点以后换成 pts（流量从第 k 点的渐变到原来最后一点的；格、类型前一半按第 k 点、后一半按原来最后一点）
function applyLeg(line: RiverLine, k: number, pts: Pt[]): void {
  const P = line.points;
  const m = P.length;
  const count = pts.length;
  const f0 = line.flow[k];
  const f1 = line.flow[m - 1];
  const keepN = k + 1;
  const points = P.slice(0, keepN);
  for (const q of pts) points.push(q);
  line.points = points;
  const flow = line.flow.slice(0, keepN);
  for (let j = 0; j < count; j++) flow.push(f0 + ((f1 - f0) * (j + 1)) / count);
  line.flow = flow;
  const halves = <T>(arr: T[]) => {
    const out = arr.slice(0, keepN);
    for (let j = 0; j < count; j++) out.push((j + 1) / count < 0.5 ? arr[k] : arr[m - 1]);
    return out;
  };
  if (line.cells) line.cells = halves(line.cells);
  if (line.type) line.type = halves(line.type);
  if (line.mul) {
    const m0 = line.mul[k];
    const m1 = line.mul[m - 1];
    const mul = line.mul.slice(0, keepN);
    for (let j = 0; j < count; j++) mul.push(m0 + ((m1 - m0) * (j + 1)) / count);
    line.mul = mul;
  }
}

// 入海、入湖的线（最后一点在岸线上）：最后约 0.9 格换成沿岸线法向进水的一段（见上）。keep：这一点以前不能动
// （别的河在那里汇进来）。法向量不出来、接出来的一段有一点在水里、转得太急时不改
function normalMouth(world: World, f: DisplayCoast, line: RiverLine, keep: number): void {
  const P = line.points;
  const m = P.length;
  if (m < 2) return;
  const ms = mouthShore(world, f, P[m - 1], line.cells?.[m - 1] ?? 0);
  const sp = world.mesh.spacing;
  // 接好以后最后 1.5 格里转得急不急（原来的线在接出来的一段之前就急转时，换长一点的一段把它也磨圆）
  // （接出来的一段与原来的线接上的地方也量：往前带上约 0.3 格）
  const smooth = (r: { k: number; pts: Pt[] }) => {
    const head = P.slice(backAlong(P.slice(0, r.k + 1), Math.max(0.3 * sp, 1.8 * sp - lineLength(r.pts))).k, r.k + 1);
    const Q = [...head, ...r.pts];
    return maxTurn(Q, TURN_CHORD * sp, Math.max(0, Math.min(lineLength(Q) - 1.5 * sp, lineLength(head) - 0.3 * sp))) <= MOUTH_MAX_TURN;
  };
  let first: { k: number; pts: Pt[] } | null = null;
  if (ms) {
    for (const leg of MOUTH_LEGS) {
      const r = mouthLeg(world, f, line, keep, ms.n, ms.p, leg, 0.4, false);
      if (!r) continue;
      if (smooth(r)) return applyLeg(line, r.k, r.pts);
      // 原来的线在更早的地方就急转：接出来的这一段本身不急转的话先留着
      if (!first && maxTurn([...before(P, r.k, sp), ...r.pts], TURN_CHORD * sp) <= MOUTH_MAX_TURN) first = r;
    }
  }
  if (!first) {
    const tail = P.slice(backAlong(P, 1.8 * sp).k);
    if (maxTurn(tail, TURN_CHORD * sp, lineLength(tail) - 1.5 * sp) <= MOUTH_MAX_TURN) return;
  }
  // 沿法向接过去还是（或者接不过去、原来的线）在河口附近急转：照原来的河口那一点，把急转磨圆（进水的方向按原来最后一段，偏得太多时偏回来）
  const e = P[m - 1];
  const t = dirAt(P, m - 1);
  for (const leg of MOUTH_LEGS.slice(1)) {
    const r = mouthLeg(world, f, line, keep, t, [e[0], e[1]], leg, 0.4, false);
    if (r && smooth(r)) return applyLeg(line, r.k, r.pts);
  }
  // 还不行（河顺着岸走到河口，水在身后）：从往回约一格的那一点顺着河的方向（左右各偏到 60°）往前找最近的岸线，在那里入海
  const hint = line.cells?.[m - 1] ?? 0;
  const A = backAlong(P, MOUTH_LEGS[0] * sp);
  const ta = dirAt(P, Math.min(m - 1, A.k + 1));
  if (landAt(world, f, A.p, hint)) {
    let best: Pt | null = null;
    let bd = Infinity;
    for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
      const a = (deg * Math.PI) / 180;
      const dir: Pt = [ta[0] * Math.cos(a) - ta[1] * Math.sin(a), ta[0] * Math.sin(a) + ta[1] * Math.cos(a)];
      const hit = shoreCross(world, f, A.p, [A.p[0] + dir[0] * 2 * sp, A.p[1] + dir[1] * 2 * sp], hint, SHORE_STEPS);
      if (hit && hit.t < bd) {
        bd = hit.t;
        best = hit.p;
      }
    }
    const n = best && seawardNormal(world, f, best, hint);
    if (best && n) {
      for (const leg of MOUTH_LEGS) {
        const r = mouthLeg(world, f, line, keep, n, best, leg, 0.4, false);
        if (r && smooth(r)) return applyLeg(line, r.k, r.pts);
      }
    }
  }
  if (first) applyLeg(line, first.k, first.pts);
}

// 海岸边的源头小河：从源头到入海不到这么长（格）的不画（画出来只是岸边一个尖尖的楔子）
const STUB_LEN = 1.5;
// 两个入海的河口至少相隔这么远（格）：再近就挤在一起，两条河画成一个“V”
const MOUTH_SEP = 0.6;
// 挤在一起时，小河的河口沿岸挪到离大河的河口这么远（格），从河口往回这么远（格）起改
const SHIFT_TRIES = [0.75, 1.1];
const SHIFT_LEGS = [1.2, 1.8, 2.4];
// 挪不开时并进大河（只在接得顺的时候）：接在大河河口往回这么远（离岸线不到 0.3 格），小河从河口往回这么远起改（格）；
// 并进去的角度（小河最后约 0.3 格的方向与大河的方向）最多多少（度）
const JOIN_BACK = [0.2, 0.3, 0.1];
// 并进去的那段曲线两头切向的倍数（见 hermite），依次试
const JOIN_SHAPES: [number, number][] = [
  [1, 1],
  [0.5, 1.5],
  [0, 0],
];
const JOIN_TRIM = [0.6, 0.9, 1.4, 2];
const JOIN_ANGLE = 35;

const lineLength = (P: readonly (readonly [number, number])[]) => {
  let s = 0;
  for (let k = 0; k + 1 < P.length; k++) s += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
  return s;
};

// 从线尾往回量 back 远的那一点：第 k 段上 t 处（k + t），量不到时为线头
function backAlong(P: readonly (readonly [number, number])[], back: number, lim = 0): { k: number; t: number; p: Pt } {
  let s = 0;
  for (let k = P.length - 2; k >= lim; k--) {
    const l = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
    if (s + l >= back) {
      const t = l > 0 ? 1 - (back - s) / l : 0;
      return { k, t, p: [P[k][0] + (P[k + 1][0] - P[k][0]) * t, P[k][1] + (P[k + 1][1] - P[k][1]) * t] };
    }
    s += l;
  }
  return { k: lim, t: 0, p: [P[lim][0], P[lim][1]] };
}

// 自然的河的河口收拾一下（第十三轮，只改画法）：去掉海岸边不到 1.5 格的源头小河；河口挤在一起（不到 0.6 格）的，
// 小的沿岸挪开、各自入海；挪不开时只在接得顺（并进去的角度不到 35°、接在离岸线 0.3 格以内、不往回拐）时画成在岸边汇入大的，
// 再不行把大的河口往另一侧挪开；都不行就照原样。返回留下的线，into 按新的下标。deferred：还没改成沿法向进水的源头小河（留下来的在这里补上）
function tidyMouths(world: World, lines: RiverLine[], field: DisplayCoast, deferred: Set<RiverLine>, orig: Map<RiverLine, RiverLine>): RiverLine[] {
  const { mesh, causes, derived: d } = world;
  const sp = mesh.spacing;
  const sphere = mesh.kind === 'sphere';
  const seaOf = (l: RiverLine) => {
    if (!l.mouth || !l.cells?.length) return -1;
    const r = d.receiver[l.cells[l.cells.length - 1]];
    return r >= 0 && !causes.land[r] ? r : -1;
  };
  // 小河连同汇进它的（也都是不到 1.5 格的源头小河）一起不画；有别的河（比如画的河接出来的）汇进来的照画
  const kids: number[][] = lines.map(() => []);
  lines.forEach((l, i) => {
    if (l.into !== undefined && l.into !== i) kids[l.into]?.push(i);
  });
  const small = (i: number, depth: number): boolean => {
    const l = lines[i];
    if (l.head !== 'source' || lineLength(l.points) >= STUB_LEN * sp || depth > 8) return false;
    if ((l.joins?.length ?? 0) > kids[i].length) return false;
    return kids[i].every((j) => small(j, depth + 1));
  };
  const keep = lines.map(() => true);
  const drop = (i: number) => {
    keep[i] = false;
    for (const j of kids[i]) drop(j);
  };
  lines.forEach((l, i) => {
    if (seaOf(l) >= 0 && small(i, 0)) drop(i);
  });
  // 留下来的短河（流进湖的、有别的河汇进来的）补上沿法向进水
  lines.forEach((l, i) => {
    if (keep[i] && deferred.has(l)) normalMouth(world, field, l, 0);
  });
  const endFlow = (l: RiverLine) => l.flow[l.flow.length - 1];
  const mouths: number[] = [];
  lines.forEach((l, i) => {
    if (keep[i] && seaOf(l) >= 0) mouths.push(i);
  });
  mouths.sort((a, b) => endFlow(lines[b]) - endFlow(lines[a]) || a - b);
  const last = (l: RiverLine) => l.points[l.points.length - 1];
  // 按格距分桶找挨着的河口（大河先，小河挪开、并进去之后河口变了，桶里的位置按原来的就够：挪开的只会更远）
  const X = (x: number) => (sphere ? x - 2 * Math.floor(x / 2) : x);
  const cols = Math.ceil((sphere ? 2 : mesh.width) / sp) + 2;
  const bucket = new Map<number, number[]>();
  const key = (i: number, j: number) => j * (cols + 2) + (sphere ? ((i % cols) + cols) % cols : i);
  for (const i of mouths) {
    const e = last(lines[i]);
    const k = key(Math.floor(X(e[0]) / sp), Math.floor(e[1] / sp));
    const b = bucket.get(k);
    if (b) b.push(i);
    else bucket.set(k, [i]);
  }
  const rank = new Int32Array(lines.length);
  mouths.forEach((i, r) => (rank[i] = r));
  const moved = new Set<number>();
  // 有小河并进来的；并进来的小河
  const hosts = new Set<number>();
  const merged = new Set<RiverLine>();
  // 挨着的河口（5×5 个桶里；挪开的河口离原来的位置不到两格）：e 到比 si 大的、还在入海的河口最近多远（地图单位）
  const around = (e: readonly [number, number], f: (j: number) => boolean) => {
    const gx = Math.floor(X(e[0]) / sp);
    const gy = Math.floor(e[1] / sp);
    const out: number[] = [];
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const j of bucket.get(key(gx + a, gy + b)) ?? []) if (f(j)) out.push(j);
    return out;
  };
  const gap = (e: readonly [number, number], j: number) => {
    const q = last(lines[j]);
    const raw = e[0] - q[0];
    return Math.hypot(sphere ? raw - 2 * Math.round(raw / 2) : raw, e[1] - q[1]);
  };
  const clearance = (e: readonly [number, number], si: number) => {
    let m = Infinity;
    for (const j of around(e, (j) => rank[j] < rank[si] && !!lines[j].mouth)) m = Math.min(m, gap(e, j));
    return m;
  };
  // 线 xi 挪过河口以后（old 是挪之前的样子），在挪动的那一段里汇进来的线（into 是它的）的最后一点重新放到挪过的线上，
  // 记下新的汇合处。有汇合处对不上汇进来的线、离新的线太远（半格以上）时为 false（什么都没改）
  const retie = (xi: number, old: RiverLine): boolean => {
    const X = lines[xi];
    let same = 0;
    while (same < old.points.length && same < X.points.length && old.points[same] === X.points[same]) same++;
    const stay = (old.joins ?? []).filter((pos) => pos < same - 1);
    const moving = (old.joins ?? []).length - stay.length;
    if (!moving) return true;
    const ends: { l: RiverLine; p: [number, number]; pos: number }[] = [];
    for (let ti = 0; ti < lines.length; ti++) {
      const T = lines[ti];
      if (!keep[ti] || T.into !== xi || T.mouth || ti === xi) continue;
      const e = T.points[T.points.length - 1];
      const ho = snapOnto(old.points, e[0], e[1], 0, old.points.length - 1, sphere);
      if (!ho || ho.k + ho.t < same - 1) continue;
      const hn = snapOnto(X.points, e[0], e[1], Math.max(0, same - 2), X.points.length - 1, sphere);
      if (!hn || hn.d > 0.5 * sp) return false;
      // 在岸边并进来的小河（mergeMouth 并的）：挪过以后并进去的角度也不超过 JOIN_ANGLE（第三十三轮）
      if (merged.has(T) && !joinsSmoothly(T.points, hn.p, X.points, sp, sphere)) return false;
      ends.push({ l: T, p: hn.p, pos: hn.k + hn.t });
    }
    if (ends.length !== moving) return false;
    for (const x of ends) x.l.points = [...x.l.points.slice(0, -1), x.p];
    X.joins = [...stay, ...ends.map((x) => x.pos)];
    return true;
  };
  for (const si of mouths) {
    const S = lines[si];
    // 比它大、河口挨着它的河（最大的先）
    const bigger = around(last(S), (j) => rank[j] < rank[si] && !!lines[j].mouth && gap(last(S), j) < MOUTH_SEP * sp).sort((a, b) => rank[a] - rank[b]);
    for (const bi of bigger) {
      if (!S.mouth) break;
      const B = lines[bi];
      const be = last(B);
      const se = last(S);
      const raw = se[0] - be[0];
      const dx = sphere ? raw - 2 * Math.round(raw / 2) : raw;
      if (Math.hypot(dx, se[1] - be[1]) >= MOUTH_SEP * sp) continue;
      // 大河的点挪到小河那一份要加的（平面上为 0）
      const off = raw - dx;
      if (shiftMouth(world, field, B, S, off, (e) => clearance(e, si) >= MOUTH_SEP * sp)) {
        moved.add(si);
        continue;
      }
      if (mergeMouth(world, field, B, S, off)) {
        merged.add(S);
        delete S.mouth;
        S.into = bi;
        hosts.add(bi);
        break;
      }
      // 小河挪不开也接不顺（比如从窄海湾的湾头两边斜着流进来）：大河的河口往离开小河的那一侧挪（挪到的地方离别的河口也要够远）。
      // 在挪动的那一段里汇进大河的支流重新接到挪过的线上；接不上就照原样
      const old = { ...B };
      if (shiftMouth(world, field, S, B, -off, (e) => around(e, (j) => j !== bi && j !== si && !!lines[j].mouth).every((j) => gap(e, j) >= MOUTH_SEP * sp), -1)) {
        if (retie(bi, old)) {
          moved.add(bi);
          continue;
        }
        Object.assign(B, old);
      }
      // 都不行：小河退回原来的河口（对着它流进的那格海，常常离得远一点），离比它大的河口更远的话
      const o = orig.get(S);
      if (!o) continue;
      // 别的河汇进来的地方要在两样都一样的那一段里（normalMouth 只换后面的，前面的点是同一些）
      let same = 0;
      while (same < o.points.length && same < S.points.length && o.points[same] === S.points[same]) same++;
      if ((S.joins ?? []).some((pos) => pos > same - 1)) continue;
      if (clearance(last(o), si) <= clearance(se, si)) continue;
      S.points = o.points;
      S.flow = o.flow;
      if (o.cells) S.cells = o.cells;
      if (o.type) S.type = o.type;
      if (o.mul) S.mul = o.mul;
      moved.add(si);
    }
  }
  // 挪过河口的变成了不到 1.5 格的源头小河：也不画
  for (const i of moved) if (keep[i] && lines[i].mouth && !hosts.has(i) && small(i, 0)) drop(i);
  const index = new Int32Array(lines.length).fill(-1);
  let n = 0;
  lines.forEach((_, i) => {
    if (keep[i]) index[i] = n++;
  });
  // 汇入的那条按新的下标（去掉的小河连同汇进它的一起去掉了）
  for (const l of lines) if (l.into !== undefined) l.into = index[l.into] >= 0 ? index[l.into] : undefined;
  return lines.filter((_, i) => keep[i]);
}

// 从 A（方向 t）到 J（到 J 时顺着 md）、一路沿 md 往前的曲线：沿 md 的位置 s 从 A 的（在 J 之后为负）均匀走到 0，
// 横向的偏移是 s 的三次 Hermite（A 处的斜率按 t，最多 ±3；J 处为 0，顺着 md 接上）。每一小段在 md 上都往前。
// A 不在 J 后面至少 0.2 个 step 时为 null
function forwardJoin(A: readonly [number, number], t: readonly [number, number], J: readonly [number, number], md: readonly [number, number], step: number): Pt[] | null {
  const nx = -md[1];
  const ny = md[0];
  const s0 = (A[0] - J[0]) * md[0] + (A[1] - J[1]) * md[1];
  const y0 = (A[0] - J[0]) * nx + (A[1] - J[1]) * ny;
  if (s0 > -0.2 * step) return null;
  const tm = t[0] * md[0] + t[1] * md[1];
  const tn = t[0] * nx + t[1] * ny;
  const slope = tm > 1e-6 ? Math.max(-3, Math.min(3, tn / tm)) : Math.sign(tn) * 3;
  const L = -s0;
  const count = Math.max(2, Math.ceil(Math.hypot(L, y0) / step));
  const out: Pt[] = [];
  for (let j = 1; j <= count; j++) {
    const u = j / count;
    const u2 = u * u;
    const u3 = u2 * u;
    // y(u)：y(0) = y0、y'(0) = slope·L、y(1) = 0、y'(1) = 0
    const y = (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * slope * L;
    const sx = s0 + L * u;
    out.push(j === count ? [J[0], J[1]] : [J[0] + md[0] * sx + nx * y, J[1] + md[1] * sx + ny * y]);
  }
  return out;
}

// 线段 p1p2 与 q1q2 相交
// （第三十三轮提速：叉积是模块里的函数，不在每次调用里新建闭包；分汊的检查每次描河要调几十万次）
function segCross(p1: readonly [number, number], p2: readonly [number, number], q1: readonly [number, number], q2: readonly [number, number]): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
const orient = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// 以 c 为圆心、半径 R 的圆与画面上的岸线相交的地方（在水面一侧），按方向离 prefer（单位向量）由近到远排，
// 只要相差不到 135° 的（窄海湾里大河的河口在湾头时，那一侧只有往湾里去的两岸）
function shoreOnCircle(world: World, f: DisplayCoast, c: readonly [number, number], R: number, prefer: readonly [number, number], hint: number): Pt[] {
  return byPrefer(circleShores(world, f, c, R, hint), prefer);
}

// 圆与岸线的交点（在水面一侧，按取样的先后）：hi 是交点的角度
function circleShores(world: World, f: DisplayCoast, c: readonly [number, number], R: number, hint: number): { hi: number; p: Pt }[] {
  if (!memoActive()) return circleShoresRaw(world, f, c, R, hint);
  keyStart(Q_CIRCLE);
  keyAddPts([c], 0, 1);
  keyAdd(R);
  keyAdd(hint);
  const m = memoGet(f);
  if (m !== MISS) return copyCircle(m as { hi: number; p: Pt }[]);
  const v = circleShoresRaw(world, f, c, R, hint);
  memoPut(f, copyCircle(v));
  return v;
}
const copyCircle = (v: readonly { hi: number; p: Pt }[]) => v.map((x) => ({ hi: x.hi, p: [x.p[0], x.p[1]] as Pt }));
function circleShoresRaw(world: World, f: DisplayCoast, c: readonly [number, number], R: number, hint: number): { hi: number; p: Pt }[] {
  const N = 32;
  const land: boolean[] = [];
  for (let i = 0; i < N; i++) land.push(landAt(world, f, onCircle(c, R, (2 * Math.PI * i) / N), hint));
  const out: { hi: number; p: Pt }[] = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    if (land[i] === land[j]) continue;
    // 二分到岸线：lo 在陆地一侧
    let lo = (2 * Math.PI * (land[i] ? i : i + 1)) / N;
    let hi = (2 * Math.PI * (land[i] ? i + 1 : i)) / N;
    for (let it = 0; it < 8; it++) {
      const m = (lo + hi) / 2;
      if (landAt(world, f, onCircle(c, R, m), hint)) lo = m;
      else hi = m;
    }
    out.push({ hi, p: onCircle(c, R, hi) });
  }
  return out;
}

const onCircle = (c: readonly [number, number], R: number, a: number): Pt => [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];

// 交点按方向离 prefer 由近到远排，只要相差不到 135° 的
function byPrefer(list: { hi: number; p: Pt }[], prefer: readonly [number, number]): Pt[] {
  const a0 = Math.atan2(prefer[1], prefer[0]);
  const found: { p: Pt; da: number }[] = [];
  for (const x of list) {
    const da = Math.abs(Math.atan2(Math.sin(x.hi - a0), Math.cos(x.hi - a0)));
    if (da < (3 * Math.PI) / 4) found.push({ p: x.p, da });
  }
  return found.sort((a, b) => a.da - b.da).map((x) => x.p);
}

// 两个河口挤在一起：小河 S 的河口沿岸线往离开大河 B 的那一侧挪，挪到离 B 的河口 0.75（不行就 1.1）格的岸线上，
// 从河口往回约 1.2（1.8、2.4）格起接过去。接出来的一段要在陆地上、不急转、不与 B 相交，最后 0.6 格离 B 的线至少 0.25 格。
// off：B 的点挪到 S 那一份要加的；keep：S 上这一点以前不动（为负时别的河汇进 S 的地方也可以动，调用的一方再把它们接上，见 tidyMouths 的 retie）
function shiftMouth(world: World, f: DisplayCoast, B: RiverLine, S: RiverLine, off: number, clear: (e: readonly [number, number]) => boolean, keep = 0): boolean {
  const sp = world.mesh.spacing;
  const BP = B.points.slice(backAlong(B.points, 3 * sp).k).map((p) => [p[0] + off, p[1]] as Pt);
  const be = BP[BP.length - 1];
  const se = S.points[S.points.length - 1];
  const hb = B.cells?.[B.cells.length - 1] ?? 0;
  const hs = S.cells?.[S.cells.length - 1] ?? 0;
  const nB = seawardNormal(world, f, be, hb);
  if (!nB) return false;
  const tB: Pt = [-nB[1], nB[0]];
  let side = (se[0] - be[0]) * tB[0] + (se[1] - be[1]) * tB[1];
  if (Math.abs(side) < 0.05 * sp) {
    const up = backAlong(S.points, sp).p;
    side = (up[0] - be[0]) * tB[0] + (up[1] - be[1]) * tB[1];
  }
  const sg = side < 0 ? -1 : 1;
  const prefer: Pt = [tB[0] * sg, tB[1] * sg];
  const near = (q: readonly [number, number]) => {
    for (let k = 0; k + 1 < BP.length; k++) if (segProject(q[0], q[1], BP[k][0], BP[k][1], BP[k + 1][0], BP[k + 1][1]).d < 0.25 * sp) return true;
    return false;
  };
  // 接出来的一段（从第 k 个点起）能不能用：河口离 B 的河口够远、离别的大河口也够远，最后 0.6 格离 B 远一点（前面原来就挨着 B 的不算），
  // 不与 B 相交（B 的线段先按外接框筛掉）
  const ok = (r: { k: number; pts: Pt[] }) => {
    const e = r.pts[r.pts.length - 1];
    if (Math.hypot(e[0] - be[0], e[1] - be[1]) < MOUTH_SEP * sp || !clear(e)) return false;
    const all = [S.points[r.k], ...r.pts];
    let s = 0;
    for (let j = all.length - 1; j > 0 && s < 0.6 * sp; j--) {
      if (near(all[j])) return false;
      s += Math.hypot(all[j][0] - all[j - 1][0], all[j][1] - all[j - 1][1]);
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of all) {
      x0 = Math.min(x0, q[0]);
      y0 = Math.min(y0, q[1]);
      x1 = Math.max(x1, q[0]);
      y1 = Math.max(y1, q[1]);
    }
    for (let k = 0; k + 1 < BP.length; k++) {
      const [a, b] = [BP[k], BP[k + 1]];
      if (Math.max(a[0], b[0]) < x0 || Math.min(a[0], b[0]) > x1 || Math.max(a[1], b[1]) < y0 || Math.min(a[1], b[1]) > y1) continue;
      for (let j = 0; j + 1 < all.length; j++) if (segCross(all[j], all[j + 1], a, b)) return false;
    }
    return true;
  };
  const tryAt = (n: Pt, p: Pt) => {
    for (const leg of SHIFT_LEGS) {
      const r = mouthLeg(world, f, S, keep, n, p, leg, 0.95);
      if (r && ok(r)) {
        applyLeg(S, r.k, r.pts);
        return true;
      }
    }
    return false;
  };
  for (const dist of SHIFT_TRIES) {
    for (const p of shoreOnCircle(world, f, be, dist * sp, prefer, hs)) {
      const n = seawardNormal(world, f, p, hs);
      if (n && tryAt(n, p)) return true;
    }
  }
  // 挪不开（比如从窄海湾的两岸迎面流进湾头）：从 S 河口往回约一格的那一点顺着 S 的方向（左右各偏到 60°）往前找岸线，
  // 顺着那个方向直直地入海
  const A = backAlong(S.points, sp);
  const ta = dirAt(S.points, Math.min(S.points.length - 1, A.k + 1));
  if (!landAt(world, f, A.p, hs)) return false;
  for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
    const a = (deg * Math.PI) / 180;
    const dir: Pt = [ta[0] * Math.cos(a) - ta[1] * Math.sin(a), ta[0] * Math.sin(a) + ta[1] * Math.cos(a)];
    const hit = shoreCross(world, f, A.p, [A.p[0] + dir[0] * 2 * sp, A.p[1] + dir[1] * 2 * sp], hs, SHORE_STEPS);
    if (hit && tryAt(dir, hit.p)) return true;
  }
  return false;
}

// 挪不开时小河 S 在岸边并进大河 B：从 S 河口往回约 0.9（1.4、2）格起，接到 B 河口往回 0.2（0.3）格的那一点，到那里顺着 B 的方向。
// 只在接得顺时并：并进去的角度（最后约 0.3 格的方向与 B 的方向）不到 35°、一路不往回拐（每一小段都顺着 B 往前）、不急转，
// 接出来的一段在陆地上。
// off：B 的点挪到 S 那一份要加的
// 小河 P 的最后一点换成 e（在大河 M 上）以后，最后一段弦（从末尾往回走到累计 0.3 格以外的那个点）与 M 在那里的方向
// （离 e 最近的点往下的一段）差不到 JOIN_ANGLE。sphere：整个星球（M 的点与 e 可以差整圈）
function joinsSmoothly(P: readonly (readonly [number, number])[], e: readonly [number, number], M: readonly (readonly [number, number])[], sp: number, sphere: boolean): boolean {
  const Q = [...P.slice(0, -1), e];
  let k = Q.length - 1;
  for (let s = 0; k > 0 && s < 0.3 * sp; k--) s += Math.hypot(Q[k][0] - Q[k - 1][0], Q[k][1] - Q[k - 1][1]);
  const cx = e[0] - Q[k][0];
  const cy = e[1] - Q[k][1];
  const zl = Math.hypot(cx, cy);
  if (zl < 1e-9) return false;
  const md = nearestDir(M, e, sphere);
  return (cx * md[0] + cy * md[1]) / zl >= Math.cos((JOIN_ANGLE * Math.PI) / 180);
}

// 线上离 p 最近的那个点往下的一段的方向（单位向量；最后一点取最后一段）。sphere：东西按整圈取最近的一份
function nearestDir(P: readonly (readonly [number, number])[], p: readonly [number, number], sphere: boolean): Pt {
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k + 1 < P.length; k++) {
    const raw = P[k][0] - p[0];
    const d = Math.hypot(sphere ? raw - 2 * Math.round(raw / 2) : raw, P[k][1] - p[1]);
    if (d < bd) [bd, best] = [d, k];
  }
  const l = Math.hypot(P[best + 1][0] - P[best][0], P[best + 1][1] - P[best][1]) || 1;
  return [(P[best + 1][0] - P[best][0]) / l, (P[best + 1][1] - P[best][1]) / l];
}

function mergeMouth(world: World, f: DisplayCoast, B: RiverLine, S: RiverLine, off: number): boolean {
  const sp = world.mesh.spacing;
  const M = B.points;
  const O = S.points;
  if (M.length < 2 || O.length < 2) return false;
  let olim = 0;
  for (const pos of S.joins ?? []) olim = Math.max(olim, Math.ceil(pos));
  const cosJoin = Math.cos((JOIN_ANGLE * Math.PI) / 180);
  for (const back of JOIN_BACK) {
    const J = backAlong(M, back * sp);
    const Jp: Pt = [J.p[0] + off, J.p[1]];
    const mk = Math.min(M.length - 2, J.k);
    const ml = Math.hypot(M[mk + 1][0] - M[mk][0], M[mk + 1][1] - M[mk][1]) || 1;
    const md: Pt = [(M[mk + 1][0] - M[mk][0]) / ml, (M[mk + 1][1] - M[mk][1]) / ml];
    for (const trim of JOIN_TRIM) {
      const A0 = backAlong(O, trim * sp, Math.min(olim, O.length - 2));
      const k = A0.k;
      const A = O[k];
      const t = dirAt(O, k);
      if (k === 0) {
        const l = Math.hypot(O[1][0] - A[0], O[1][1] - A[1]) || 1;
        t[0] = (O[1][0] - A[0]) / l;
        t[1] = (O[1][1] - A[1]) / l;
      }
      if (t[0] * md[0] + t[1] * md[1] <= 0) continue;
      const L = Math.hypot(Jp[0] - A[0], Jp[1] - A[1]);
      if (L < 1e-9 || ((Jp[0] - A[0]) * md[0] + (Jp[1] - A[1]) * md[1]) / L < 0) continue;
      const hint = S.cells?.[k] ?? 0;
      // 曲线的样子：先按两点的距离；小河斜着过来时起点的切向短一点（不往外鼓）、终点的长一点（早一点顺着 B），
      // 再不行用一路往前的曲线
      let pts: Pt[] | null = null;
      for (const [sa, sb] of JOIN_SHAPES) {
        // sa 为 0：按 B 的方向一路往前的曲线（见 forwardJoin），几乎横着过来的小河也不先往后退一点再拐
        const q = sa > 0 ? hermite(A, t, Jp, md, sp / 8, sa, sb) : forwardJoin(A, t, Jp, md, sp / 8);
        if (!q) continue;
        // 并进去的角度：最后约 0.3 格的弦与 B 的方向
        const Z = backAlong([A, ...q], 0.3 * sp).p;
        const zl = Math.hypot(Jp[0] - Z[0], Jp[1] - Z[1]);
        if (zl < 1e-9 || ((Jp[0] - Z[0]) * md[0] + (Jp[1] - Z[1]) * md[1]) / zl < cosJoin) continue;
        // 第三十三轮：也按接好以后的整条线量（往回走到离汇合处 0.3 格以外的那个点，接出来的一段不到 0.3 格时含原来的线），
        // 与 B 上离汇合处最近的那个点往下的一段比（汇合处在 B 的弯点附近时两段的方向差得多）
        if (!joinsSmoothly([...O.slice(0, k + 1), ...q], Jp, M, sp, world.mesh.kind === 'sphere')) continue;
        let ok = true;
        for (let j = 0; j < q.length && ok; j++) {
          const a = j > 0 ? q[j - 1] : A;
          if ((q[j][0] - a[0]) * md[0] + (q[j][1] - a[1]) * md[1] <= 0) ok = false;
          else if (j + 1 < q.length && !landAt(world, f, q[j], hint)) ok = false;
        }
        if (!ok || maxTurn([...before(O, k, sp), ...q], TURN_CHORD * sp) > MOUTH_MAX_TURN) continue;
        pts = q;
        break;
      }
      if (!pts) continue;
      const count = pts.length;
      const keepN = k + 1;
      const q0 = S.flow[k];
      S.points = [...O.slice(0, keepN), ...pts];
      S.flow = [...S.flow.slice(0, keepN), ...pts.map(() => q0)];
      if (S.cells) {
        const own = S.cells[k];
        const at = B.cells?.[Math.min(B.cells.length - 1, J.t > 0.5 ? J.k + 1 : J.k)] ?? own;
        S.cells = [...S.cells.slice(0, keepN), ...pts.map((_, j) => (j === count - 1 ? at : own))];
      }
      if (S.type) {
        const ty = S.type[k];
        S.type = [...S.type.slice(0, keepN), ...pts.map(() => ty)];
      }
      if (S.mul) {
        const mm = S.mul[k];
        S.mul = [...S.mul.slice(0, keepN), ...pts.map(() => mm)];
      }
      markJoin(B, J.k + J.t);
      return true;
    }
  }
  return false;
}

// ---------- 三角洲的分汊（第三十三轮，只改画法） ----------
// 三角洲的河口（core/delta.ts 的 deltaMouths：大河、河口压成了三角洲平原）、流量至少是门槛的 8 倍的自然的河，
// 在河口往回约 1.6–2.4 格处分出 1–4 股（连主流 2–5 股，流量每翻一倍多一股），各自沿岸线的法向入海：
// 河口落在岸线上离主流的河口约 0.8、1.5 格（左右交替）的地方（shoreOnCircle），用三次 Hermite 曲线从分汊处顺着主流的方向弯过去
// （hermite，终点沿 seawardNormal）。每一股都要在陆地上、不急转、不与别的河相交、离别的河口至少 0.6 格，不然不画这一股。
// 主流留 40–60% 的水（按河口那格定），其余的平分给分出去的几股；主流在分汊以后画细一些（粗细倍数）。
// 分出去的线的格都是主流河口那一格（点它选中主流），branch 记着主流的下标，入海（mouth），不是源头
const BRANCH_BACK = [1.6, 2.4];
const BRANCH_RADII = [0.8, 0.8, 1.5, 1.5];
const BRANCH_MAX = 4;
// 分出去的一股最后六成离主流至少这么远（格）：两条带子不贴在一起
const BRANCH_GAP = 0.3;

function withBranches(world: World, f: DisplayCoast, lines: RiverLine[]): RiverLine[] {
  const mouths = deltaMouths(world);
  if (!mouths.length) return lines;
  const at = new Set(mouths);
  const thr = world.small.planet.riverThreshold;
  const out: RiverLine[] = [];
  // 已有的河口（各股的河口离它们至少 MOUTH_SEP 格）
  const ends = new PointGrid(MOUTH_SEP * world.mesh.spacing);
  for (const l of lines) if (l.mouth && l.points.length) ends.add(l.points[l.points.length - 1]);
  // 每条线的外接框（找附近的线、可能相交的线时先按框筛：框不挨着的一定没有点在附近、一定不相交）
  const boxes = lines.map(boxOfPts);
  const made: Box[] = [];
  lines.forEach((M, mi) => {
    if (M.guide !== undefined || !M.mouth || !M.cells?.length || M.points.length < 3) return;
    const c = M.cells[M.cells.length - 1];
    if (!at.has(c)) return;
    const q = M.flow[M.flow.length - 1];
    if (!(q >= DELTA_DRAW.FLOW * thr)) return;
    const want = Math.min(BRANCH_MAX, 1 + Math.floor(Math.log2(q / (DELTA_DRAW.FLOW * thr))));
    const got = branchesOf(world, f, lines, boxes, M, mi, c, want, ends, out, made);
    for (const b of got) {
      out.push(b);
      made.push(boxOfPts(b));
    }
  });
  return out.length ? [...lines, ...out] : lines;
}

type Box = [number, number, number, number];
function boxOfPts(l: { points: readonly (readonly [number, number])[] }): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of l.points) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, x1, y0, y1];
}
const boxesMeet = (a: Box, b: Box) => a[0] <= b[1] && b[0] <= a[1] && a[2] <= b[3] && b[2] <= a[3];

// 一条河的几股：成了的（至少一股）才改主流（分汊处记进 joins，之后变细）
// 分汊的几何（在哪一处分、成了哪几股）跨几次描河记下来（第三十三轮提速）：它只取决于主流的点、河口那格、想分几股、
// 画面上的海岸场（记下读到的格，见 core/coast-memo.ts）与几样“问别处”的答案——已有的河口在不在附近、附近别的河的线与这一股相不相交、
// 这一次已经分出去的几股与它相不相交。问过的都记在 log 里，下一次描河时照样再问一遍（按那时的 ends、lines、made），
// 答得都一样才用记下的（算的过程一样，结果就逐位相同）。流量、粗细、joins 每次照常改
const Q_BRANCH = 8;
interface BranchAsk {
  // 0：ends.near(p[0])；1：附近别的河的线与 p 相交；2：这一次已经分出去的几股与 p 相交
  kind: number;
  p: Pt[];
  r: boolean;
}
interface BranchPlan {
  // 在 BRANCH_BACK 的第几个分汊处分（−1 不分）
  back: number;
  got: { pts: Pt[]; end: Pt }[];
  log: BranchAsk[];
}

function branchesOf(world: World, f: DisplayCoast, lines: RiverLine[], boxes: Box[], M: RiverLine, mi: number, c: number, want: number, ends: PointGrid, made: RiverLine[], madeBoxes: Box[]): RiverLine[] {
  const sp = world.mesh.spacing;
  const P = M.points;
  let plan: BranchPlan;
  if (memoActive()) {
    keyStart(Q_BRANCH);
    keyAdd(c);
    keyAdd(want);
    keyAddPts(P, 0, P.length);
    const m = memoPeek(f);
    if (m !== MISS && planHolds(m as BranchPlan, lines, boxes, M, ends, made, madeBoxes, sp)) plan = m as BranchPlan;
    else {
      memoMissStart();
      plan = planBranches(world, f, lines, boxes, M, c, want, ends, made, madeBoxes, []);
      memoPut(f, plan);
    }
  } else plan = planBranches(world, f, lines, boxes, M, c, want, ends, made, madeBoxes, null);
  if (plan.back < 0) return [];
  const S = backAlong(P, BRANCH_BACK[plan.back] * sp);
  const got = plan.got.map((g) => ({ pts: g.pts.map((p) => [p[0], p[1]] as Pt), end: [g.end[0], g.end[1]] as Pt }));
  // 主流：分汊以后的水只剩 share，画细一些
  const share = 0.4 + 0.2 * unitHash(c);
  const q = M.flow[M.flow.length - 1];
  const each = (1 - share) / got.length;
  const k0 = S.k + 1;
  const ratio = riverWidth(q * share, world.small.planet.riverThreshold) / riverWidth(q, world.small.planet.riverThreshold);
  const mul = M.mul ? M.mul.slice() : M.points.map(() => 1);
  for (let k = k0; k < P.length; k++) {
    M.flow[k] *= share;
    mul[k] *= ratio;
  }
  M.mul = mul;
  markJoin(M, S.k + S.t);
  for (const g of got) ends.add(g.end);
  return got.map((g) => {
    const points: Pt[] = [[S.p[0], S.p[1]], ...g.pts];
    const line: RiverLine = { points, flow: points.map(() => q * each), cells: points.map(() => c), mouth: true, branch: mi };
    if (M.type) {
      const t = M.type[M.type.length - 1];
      line.type = points.map(() => t);
    }
    return line;
  });
}

// 记下的分汊：按现在的已有河口、别的河、已经分出去的几股再问一遍，答得都与记下的一样
function planHolds(plan: BranchPlan, lines: RiverLine[], boxes: Box[], M: RiverLine, ends: PointGrid, made: RiverLine[], madeBoxes: Box[], sp: number): boolean {
  for (const a of plan.log) {
    const r = a.kind === 0 ? ends.near(a.p[0]) : a.kind === 1 ? crossesNearLines(a.p, lines, boxes, M, sp) : crossesMade(a.p, made, madeBoxes);
    if (r !== a.r) return false;
  }
  return true;
}

// 分汊的几何：在哪一处分、成了哪几股（log 不为 null 时记下问别处的答案）
function planBranches(world: World, f: DisplayCoast, lines: RiverLine[], boxes: Box[], M: RiverLine, c: number, want: number, ends: PointGrid, made: RiverLine[], madeBoxes: Box[], log: BranchAsk[] | null): BranchPlan {
  const none: BranchPlan = { back: -1, got: [], log: log ?? [] };
  const sp = world.mesh.spacing;
  const P = M.points;
  const E = P[P.length - 1];
  const nE = seawardNormal(world, f, E, c);
  if (!nE) return none;
  const tangent: Pt = [-nE[1], nE[0]];
  const total = lineLength(P);
  // 各股河口的候选（只取决于主流的河口，两种分汊的位置共用）与那里岸线的法向
  // （同一个半径的圆只找一次交点，左右两侧共用）
  const cands: (Pt | undefined)[] = new Array(BRANCH_RADII.length);
  const circles = new Map<number, { hi: number; p: Pt }[]>();
  const normals = new Map<Pt, Pt | null>();
  for (let bi = 0; bi < BRANCH_BACK.length; bi++) {
    const back = BRANCH_BACK[bi];
    if (back * sp > 0.6 * total) continue;
    const S = backAlong(P, back * sp);
    const tS = dirAt(P, Math.min(P.length - 1, S.k + 1));
    const got: { pts: Pt[]; end: Pt }[] = [];
    const taken: Pt[] = [];
    for (let b = 0; b < BRANCH_RADII.length && got.length < want; b++) {
      const side = b % 2 === 0 ? 1 : -1;
      const prefer: Pt = [tangent[0] * side, tangent[1] * side];
      if (!(b in cands)) {
        const R = BRANCH_RADII[b];
        if (!circles.has(R)) circles.set(R, circleShores(world, f, E, R * sp, c));
        cands[b] = byPrefer(circles.get(R)!, prefer)[0];
      }
      const T = cands[b];
      if (!T) continue;
      // 只要在 prefer 那一侧（与河口的法向夹角不到 100°）
      const vx = T[0] - E[0];
      const vy = T[1] - E[1];
      if (vx * prefer[0] + vy * prefer[1] <= 0.2 * Math.hypot(vx, vy)) continue;
      const near = ends.near(T);
      log?.push({ kind: 0, p: [T], r: near });
      if (near || nearAny(taken, T, MOUTH_SEP * sp)) continue;
      if (!normals.has(T)) normals.set(T, seawardNormal(world, f, T, c));
      const pts = branchPath(world, f, lines, boxes, M, S, tS, T, normals.get(T)!, c, got.map((g) => g.pts), made, madeBoxes, log);
      if (!pts) continue;
      got.push({ pts, end: T });
      taken.push(T);
    }
    if (!got.length) continue;
    return { back: bi, got, log: log ?? [] };
  }
  return none;
}

// 一股的线（不含分汊那一点）：在陆地上、不急转、不与别的线相交、离主流够远，不然 null
function branchPath(
  world: World,
  f: DisplayCoast,
  lines: RiverLine[],
  boxes: Box[],
  M: RiverLine,
  S: { k: number; t: number; p: Pt },
  tS: Pt,
  T: Pt,
  n: Pt | null,
  hint: number,
  others: Pt[][],
  made: RiverLine[],
  madeBoxes: Box[],
  log: BranchAsk[] | null,
): Pt[] | null {
  const sp = world.mesh.spacing;
  if (!n) return null;
  const L = Math.hypot(T[0] - S.p[0], T[1] - S.p[1]);
  if (L < 0.5 * sp) return null;
  // 最后一小段沿法向的直线，之前从主流的方向弯过来（与 mouthLeg 相同）
  const straight = Math.min(0.35 * sp, 0.4 * L);
  const Q: Pt = [T[0] - n[0] * straight, T[1] - n[1] * straight];
  const pts = hermite(S.p, tS, Q, n, sp / 8);
  const ns = Math.max(1, Math.ceil(straight / (sp / 8)));
  for (let j = 1; j <= ns; j++) pts.push(j === ns ? [T[0], T[1]] : [Q[0] + (T[0] - Q[0]) * (j / ns), Q[1] + (T[1] - Q[1]) * (j / ns)]);
  // 几样检查都要过（与先后无关）：先查只算几何的，最后才查每一点在不在陆地上（要找格、插值，最费时）
  const P = M.points;
  if (maxTurn([...before(P, S.k, sp), S.p, ...pts], TURN_CHORD * sp) > MOUTH_MAX_TURN) return null;
  // 最后六成离主流（分汊以后的那段）够远
  const tail: Pt[] = [S.p, ...P.slice(S.k + 1)];
  const from = Math.floor(pts.length * 0.4);
  for (let j = from; j < pts.length; j++) {
    const h = snapOnto(tail, pts[j][0], pts[j][1], 0, tail.length - 1, world.mesh.kind === 'sphere');
    if (h && h.d < BRANCH_GAP * sp) return null;
  }
  // 不与别的线（主流分汊以后的那段、已经分出去的几股、别的河）相交
  const line: Pt[] = [S.p, ...pts];
  if (polylinesCross(line, tail)) return null;
  for (const o of others) if (polylinesCross(line, [S.p, ...o])) return null;
  const crossMade = crossesMade(line, made, madeBoxes);
  log?.push({ kind: 2, p: line, r: crossMade });
  if (crossMade) return null;
  const crossNear = crossesNearLines(line, lines, boxes, M, sp);
  log?.push({ kind: 1, p: line, r: crossNear });
  if (crossNear) return null;
  if (!allLand(world, f, pts, pts.length - 1, hint)) return null;
  return pts;
}

// 一股（line）与这一次已经分出去的几股相不相交
function crossesMade(line: readonly Pt[], made: RiverLine[], madeBoxes: Box[]): boolean {
  const own = boxOfPts({ points: line });
  for (let k = 0; k < made.length; k++) if (boxesMeet(own, madeBoxes[k]) && polylinesCross(line, made[k].points)) return true;
  return false;
}

// 一股（line）与附近别的河（不算主流 M；有一点在这一股外扩一格的框里）的线相不相交：框不挨着的一定没有
function crossesNearLines(line: readonly Pt[], lines: RiverLine[], boxes: Box[], M: RiverLine, sp: number): boolean {
  const own = boxOfPts({ points: line });
  const near: Box = [own[0] - sp, own[1] + sp, own[2] - sp, own[3] + sp];
  for (let k = 0; k < lines.length; k++) {
    const o = lines[k];
    if (o === M || !boxesMeet(near, boxes[k])) continue;
    const Q2 = o.points;
    let hit = false;
    for (const p of Q2) if (p[0] >= near[0] && p[0] <= near[1] && p[1] >= near[2] && p[1] <= near[3]) hit = true;
    if (hit && polylinesCross(line, Q2)) return true;
  }
  return false;
}

// 两条折线有没有相交的段（segCross）：模块里的函数，不是每次新建的闭包。
// B 的一段的外接框不挨着 A 的外接框时一定不相交，跳过（结果与逐段都比相同）
function polylinesCross(A: readonly (readonly [number, number])[], B: readonly (readonly [number, number])[]): boolean {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of A) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  for (let b = 0; b + 1 < B.length; b++) {
    const p = B[b];
    const q = B[b + 1];
    if (Math.max(p[0], q[0]) < x0 || Math.min(p[0], q[0]) > x1 || Math.max(p[1], q[1]) < y0 || Math.min(p[1], q[1]) > y1) continue;
    for (let a = 0; a + 1 < A.length; a++) if (segCross(A[a], A[a + 1], p, q)) return true;
  }
  return false;
}

// 一组点按边长 r 的方格分桶：离 p 不到 r 的点只在 p 所在的格与周围八格里（与逐个比相同）
class PointGrid {
  private cells = new Map<string, Pt[]>();
  constructor(private r: number) {}
  add(p: Pt) {
    const k = `${Math.floor(p[0] / this.r)},${Math.floor(p[1] / this.r)}`;
    const b = this.cells.get(k);
    if (b) b.push(p);
    else this.cells.set(k, [p]);
  }
  near(p: Pt): boolean {
    const gx = Math.floor(p[0] / this.r);
    const gy = Math.floor(p[1] / this.r);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const list = this.cells.get(`${gx + a},${gy + b}`);
        if (list && nearAny(list, p, this.r)) return true;
      }
    return false;
  }
}

// 离 p 不到 r 的点有没有
function nearAny(list: readonly Pt[], p: Pt, r: number): boolean {
  for (const e of list) if (Math.hypot(e[0] - p[0], e[1] - p[1]) < r) return true;
  return false;
}

// 一格编号的 0–1 散列（主流留多少水）
function unitHash(c: number): number {
  let h = Math.imul(c ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 河道的样子：中间点加轻微的曲流，再做三遍 Chaikin 平滑。pts 是沿河的点（格心、入海口），
// flow 是每个点的流量，spacing 是格距；cells（可省略）是每个点所在的格，平滑后每个点取离它最近的原来那点的格。
// 自然的河、画的河、预览都用它，画出来的样子才一致。不改动传进来的数组
// tags（可省略）：每个点是哪一种河，平滑后与 cells 一样取原来那点的（见 RiverLine.type）
export function smoothCourse(pts: readonly [number, number][], flow: number[], spacing: number, cells?: number[], tags?: number[]): RiverLine {
  // 三遍平滑：放大到最大（一格约 64 像素）时也看不出折角
  return chaikin({ points: meander(pts, spacing), flow, cells, ...(tags ? { type: tags } : {}) }, 3);
}

// 画的河（有 path）的样子：存下的折线不再加曲流，只做同样的三遍平滑。固定自然的河时存的是加过曲流的点
// （见 stemPath），所以画出来与原来那条自然的河一模一样。不改动传进来的数组
export function courseLine(pts: readonly [number, number][], flow: number[]): RiverLine {
  return chaikin({ points: pts.slice(), flow }, 3);
}

// 曲流：中间点沿垂直方向错开一点（按位置取噪声，结果确定）。前一点已经错开过，按错开后的位置算。
// 固定一条自然的河时存下的折线就是这一步的结果（再平滑一遍就是原来画出来的样子）。不改动传进来的数组
function meander(pts: readonly [number, number][], spacing: number): [number, number][] {
  const points = pts.slice();
  const amp = 0.22 * spacing;
  for (let k = 1; k < points.length - 1; k++) {
    const [x0, y0] = points[k - 1];
    const [x1, y1] = points[k + 1];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const off = amp * vnoise(points[k][0] / spacing * 0.9 + 11.1, points[k][1] / spacing * 0.9);
    points[k] = [points[k][0] - ((y1 - y0) / len) * off, points[k][1] + ((x1 - x0) / len) * off];
  }
  return points;
}

function chaikin(line: RiverLine, iterations: number): RiverLine {
  let { points, flow, cells, type } = line;
  for (let it = 0; it < iterations; it++) {
    if (points.length < 3) break;
    const p: [number, number][] = [points[0]];
    const f: number[] = [flow[0]];
    const t: number[] | undefined = cells ? [cells[0]] : undefined;
    const g: number[] | undefined = type ? [type[0]] : undefined;
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k];
      const [bx, by] = points[k + 1];
      p.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      f.push(flow[k] * 0.75 + flow[k + 1] * 0.25, flow[k] * 0.25 + flow[k + 1] * 0.75);
      t?.push(cells![k], cells![k + 1]);
      g?.push(type![k], type![k + 1]);
    }
    p.push(points[points.length - 1]);
    f.push(flow[flow.length - 1]);
    t?.push(cells![cells!.length - 1]);
    g?.push(type![type!.length - 1]);
    points = p;
    flow = f;
    cells = t;
    type = g;
  }
  const out: RiverLine = cells ? { points, flow, cells } : { points, flow };
  if (type) out.type = type;
  return out;
}

// 河宽（屏幕像素，未乘缩放系数）
export function riverWidth(flow: number, threshold: number): number {
  return 0.3 + 0.42 * Math.log2(flow / threshold + 1);
}

// ---------- 河画出来的样子：一条连续的带子（屏幕与导出的 rivers.bmp 共用） ----------
// 河线（traceRivers 的折线）加密到约 1/16 格，宽度沿河平滑、往下游只增不减；源头收尖（约 1.25 格里从一成半宽到全宽），
// 从湖里流出来的短河从湖岸起收细（见 OUTLET_MIN），
// 入海、入湖的河口在最后约 0.6 格里略张开、平头收在岸线上；再沿法向加一点细小的弯曲（约 0.08 格、半格一个弯，
// 宽的河弯得少，两头不弯）。弯曲只在画的时候加：存下的折线、点河、量长度都照原来的线

export interface RiverRibbon {
  // 中线（地图单位；整个星球上沿河展开经度，与河线相同）
  x: Float64Array;
  y: Float64Array;
  // 沿河的长度（地图单位）
  s: Float64Array;
  // 左手的单位法向
  nx: Float32Array;
  ny: Float32Array;
  // 半宽（屏幕像素，未乘随缩放变宽的系数）
  hw: Float32Array;
  // 每一点来自河线的第几段（带类型的河按它取类型）
  src: Uint32Array;
  // 外接框（中线）与最宽处的半宽
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  maxHw: number;
}

const RIBBON_STEP = 1 / 16;
const TAPER_LEN = 1.25;
const TAPER_MIN = 0.15;
const FLARE_LEN = 0.6;
const FLARE = 0.3;
// 从湖里流出来的短河（不到 2 格；2–4 格之间渐渐不收）：从湖岸起收细，湖岸处约四成宽，到全长的七成是全宽。
// 不然一个小湖流出来一两格就入海、入别的湖的河画成一块平头的方块
const OUTLET_MIN = 0.4;
const OUTLET_SHORT = 2;
const OUTLET_FADE = 2;
const WIDTH_SMOOTH = 0.5;
const MEANDER_AMP = 0.08;
// 弯曲的噪声频率：格点相隔 1/4 格，约半格一个弯
const MEANDER_FREQ = 4;

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// line：河线；thr：河的门槛；spacing：格距；mulAt（可选）：每个河线点再乘的粗细（拖粗细、河流类型的粗细）
// opts.underShore（格，可选）：入海、入湖的河沿最后一段的方向再往水里多画这么长（河口的平头埋在水面下）。只给按陆地裁掉水面上那部分的画法用
// （地图的河那一层按画面上的陆地遮住：河口正好收在弯弯曲曲的岸线上，不是一个跨在岸线上的平头）
export function riverRibbon(line: RiverLine, thr: number, spacing: number, mulAt?: (k: number) => number, opts?: { underShore?: number }): RiverRibbon {
  const under = line.mouth && opts?.underShore && line.points.length >= 2 ? opts.underShore * spacing : 0;
  if (under > 0) {
    const Q = line.points;
    const [ax, ay] = Q[Q.length - 2];
    const [bx, by] = Q[Q.length - 1];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const more: [number, number] = [bx + ((bx - ax) / l) * under, by + ((by - ay) / l) * under];
    line = { ...line, points: [...Q, more], flow: withLast(line.flow), ...(line.mul ? { mul: withLast(line.mul) } : {}), ...(line.type ? { type: withLast(line.type) } : {}), ...(line.cells ? { cells: withLast(line.cells) } : {}) };
  }
  const P = line.points;
  const m = P.length;
  // 1. 加密：每段等分到不长于 1/16 格
  const step = RIBBON_STEP * spacing;
  let count = 1;
  const parts = new Uint32Array(Math.max(0, m - 1));
  for (let k = 0; k + 1 < m; k++) {
    parts[k] = Math.max(1, Math.ceil(Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) / step));
    count += parts[k];
  }
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const w = new Float64Array(count);
  const mul = new Float64Array(count);
  const src = new Uint32Array(count);
  // 每个河线点的粗细倍数先算好（第三十三轮提速：以前每个加密的点算四遍；值与先后不变）
  const mk = new Float64Array(m);
  for (let k = 0; k < m; k++) mk[k] = (line.mul ? line.mul[k] : 1) * (mulAt ? mulAt(k) : 1);
  densify(P, line.flow, mk, parts, thr, x, y, w, mul, src);
  // 2. 沿河的长度
  const s = new Float64Array(count);
  for (let i = 1; i < count; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  const L = s[count - 1];
  // 岸线在哪里（往水里多画的那段之前）
  const Ls = L - under;
  // 3. 宽度：往下游只增不减，再沿河来回各平滑一遍（约半格；只增不减的数列平滑后仍只增不减）
  smoothWidth(w, s, count, WIDTH_SMOOTH * spacing);
  // 4. 源头收尖、河口张开（从湖里流出来的短河从湖岸起收细），乘上粗细
  const outlet = line.head === 'lake' && L > 0 ? 1 - smooth01((L / spacing - OUTLET_SHORT) / OUTLET_FADE) : 0;
  const hw = new Float32Array(count);
  let maxHw = 0;
  for (let i = 0; i < count; i++) {
    let f = mul[i];
    if (line.head === 'source') f *= TAPER_MIN + (1 - TAPER_MIN) * smooth01(s[i] / (TAPER_LEN * spacing));
    if (outlet > 0) f *= 1 - outlet * (1 - OUTLET_MIN) * (1 - smooth01(s[i] / (0.7 * L)));
    if (line.mouth) f *= 1 + FLARE * smooth01((s[i] - (Ls - FLARE_LEN * spacing)) / (FLARE_LEN * spacing));
    hw[i] = (w[i] * f) / 2;
    if (hw[i] > maxHw) maxHw = hw[i];
  }
  // 5. 细小的弯曲：沿原来那条线的法向错开（按位置取噪声，结果确定）；两头半格之内渐渐不弯，水多（按流量的宽）的河弯得少，
  //    拖粗细不改中线
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  ribbonNormals(x, y, nx, ny, count);
  if (count > 2) {
    const q = MEANDER_FREQ / spacing;
    // 别的河汇进来的地方前后半格也渐渐不弯：支流的最后一点在原来那条线上，也就落在画出来的中线上（见 RiverLine.joins）
    let damp: Float64Array | null = null;
    if (line.joins?.length) {
      damp = new Float64Array(count).fill(1);
      const start = new Uint32Array(Math.max(1, m - 1));
      for (let k = 1; k + 1 < m; k++) start[k] = start[k - 1] + parts[k - 1];
      for (const pos of line.joins) {
        const k = Math.max(0, Math.min(m - 2, Math.floor(pos)));
        // 汇合点在加密后的第 i0、i0 + 1 点之间；前后各一步之内一点也不弯（这一小段就在原来的线上）
        const f = (pos - k) * parts[k];
        const i0 = Math.min(count - 1, start[k] + Math.floor(f));
        const i1 = Math.min(count - 1, i0 + 1);
        const sj = s[i0] + (s[i1] - s[i0]) * (f - Math.floor(f));
        const reach = 0.5 * spacing + step;
        for (let i = i0; i >= 0 && sj - s[i] < reach; i--) damp[i] = Math.min(damp[i], smooth01((Math.abs(s[i] - sj) - step) / (0.5 * spacing)));
        for (let i = i1; i < count && s[i] - sj < reach; i++) damp[i] = Math.min(damp[i], smooth01((Math.abs(s[i] - sj) - step) / (0.5 * spacing)));
      }
    }
    for (let i = 1; i < count - 1; i++) {
      const ends = smooth01(s[i] / (0.5 * spacing)) * smooth01((Ls - s[i]) / (0.5 * spacing)) * (damp ? damp[i] : 1);
      if (ends <= 0) continue;
      const amp = (MEANDER_AMP * spacing * ends) / (1 + 0.5 * Math.max(0, w[i] - 1));
      const off = amp * vnoise(x[i] * q + 5.3, y[i] * q - 7.9);
      x[i] += nx[i] * off;
      y[i] += ny[i] * off;
    }
    ribbonNormals(x, y, nx, ny, count);
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    if (x[i] < x0) x0 = x[i];
    if (x[i] > x1) x1 = x[i];
    if (y[i] < y0) y0 = y[i];
    if (y[i] > y1) y1 = y[i];
  }
  return { x, y, s, nx, ny, hw, src, x0, y0, x1, y1, maxHw };
}

// 带子的左手单位法向：每一点按前后两点的方向（模块里的函数：以前是 riverRibbon 里的闭包，几样数组都成了闭包里的变量，整个函数都慢）
function ribbonNormals(x: Float64Array, y: Float64Array, nx: Float32Array, ny: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    const tx = x[b] - x[a];
    const ty = y[b] - y[a];
    const l = Math.hypot(tx, ty) || 1;
    nx[i] = -ty / l;
    ny[i] = tx / l;
  }
}

const withLast = <T>(a: T[]): T[] => [...a, a[a.length - 1]];

// 带子第 1 步：每段等分 parts[k] 份，逐点插值中线、按流量的宽、粗细倍数（mk：每个河线点的），记下来自第几段。
// 模块里的函数（不是每条河新建的闭包），算式与先后同以前的 put
function densify(P: readonly (readonly [number, number])[], flow: readonly number[], mk: Float64Array, parts: Uint32Array, thr: number, x: Float64Array, y: Float64Array, w: Float64Array, mul: Float64Array, src: Uint32Array): void {
  const m = P.length;
  putAt(P, flow, mk, thr, x, y, w, mul, src, 0, 0, 0);
  let o = 1;
  for (let k = 0; k + 1 < m; k++) for (let j = 1; j <= parts[k]; j++) putAt(P, flow, mk, thr, x, y, w, mul, src, o++, k, j / parts[k]);
}
function putAt(P: readonly (readonly [number, number])[], flow: readonly number[], mk: Float64Array, thr: number, x: Float64Array, y: Float64Array, w: Float64Array, mul: Float64Array, src: Uint32Array, o: number, k: number, t: number): void {
  const m = P.length;
  const k1 = Math.min(m - 1, k + 1);
  x[o] = P[k][0] + (P[k1][0] - P[k][0]) * t;
  y[o] = P[k][1] + (P[k1][1] - P[k][1]) * t;
  w[o] = riverWidth(flow[k] + (flow[k1] - flow[k]) * t, thr);
  mul[o] = mk[k] + (mk[k1] - mk[k]) * t;
  src[o] = Math.min(k, Math.max(0, m - 2));
}

// 带子第 3 步：宽度往下游只增不减，再沿河来回各平滑一遍（lam：平滑的长度）。
// 来回两遍用的是同一对相邻点的 1 − exp(−Δs / lam)，只算一遍（第三十三轮提速，值不变）
function smoothWidth(w: Float64Array, s: Float64Array, count: number, lam: number): void {
  for (let i = 1; i < count; i++) if (w[i] < w[i - 1]) w[i] = w[i - 1];
  const A = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const a = 1 - Math.exp(-(s[i] - s[i - 1]) / lam);
    A[i] = a;
    w[i] = w[i - 1] + (w[i] - w[i - 1]) * a;
  }
  for (let i = count - 2; i >= 0; i--) w[i] = w[i + 1] + (w[i] - w[i + 1]) * A[i + 1];
}

// ---------- 画的河道折线（第八轮：自定义走向） ----------

// 存的是整数：地图单位 × 1e5（约 100–200 m，不到一格的百分之一），JSON 短，存取往返逐位相同
const PATH_SCALE = 1e5;

export const roundPathValue = (v: number) => Math.round(v * PATH_SCALE) / PATH_SCALE;
export const roundPoint = (p: readonly [number, number]): [number, number] => [roundPathValue(p[0]), roundPathValue(p[1])];

export function encodePath(pts: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const [x, y] of pts) out.push(Math.round(x * PATH_SCALE), Math.round(y * PATH_SCALE));
  return out;
}

export function decodePath(path: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < path.length; k += 2) out.push([path[k] / PATH_SCALE, path[k + 1] / PATH_SCALE]);
  return out;
}

// 去掉相邻的重复点
export function dedupePoints(pts: [number, number][]): [number, number][] {
  return pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]);
}

// 点到线段的距离，以及投影点在线段上的位置 t（0–1）
export function segProject(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return { d: Math.hypot(px - ax - t * dx, py - ay - t * dy), t };
}

// Douglas–Peucker 化简：离保留下来的折线不超过 tol
export function douglasPeucker(pts: readonly [number, number][], tol: number): [number, number][] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segProject(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]).d;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) continue;
    keep[best] = 1;
    stack.push([a, best], [best, b]);
  }
  return pts.filter((_, i) => keep[i]);
}

// 沿折线取点的间隔：四分之一格。河道经过哪些格、在哪里截断都按这些点算
export const courseStep = (mesh: Mesh) => mesh.spacing * 0.25;

// 沿折线每隔 step 取一点：每段按段长等分（含两端，相邻两段共用的端点只取一次）。
// seg：点在第几段上。同一条折线在哪里取，点都逐位相同
export function pathSamples(pts: readonly (readonly [number, number])[], step: number): { x: number[]; y: number[]; seg: number[] } {
  const out = { x: [] as number[], y: [] as number[], seg: [] as number[] };
  if (!pts.length) return out;
  out.x.push(pts[0][0]);
  out.y.push(pts[0][1]);
  out.seg.push(0);
  for (let k = 0; k + 1 < pts.length; k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 1; j <= steps; j++) {
      out.x.push(x0 + ((x1 - x0) * j) / steps);
      out.y.push(y0 + ((y1 - y0) * j) / steps);
      out.seg.push(k);
    }
  }
  return out;
}

// 折线在第一次走进这一格的地方截断（截断点是落在这格里的第一个取样点，按存的精度取整后仍在这格里）。
// 折线从来没进过这一格时返回 null（这一格在画完之后顺地势流下去的那段里）
export function cutPathAtCell(mesh: Mesh, path: readonly number[], cell: number): number[] | null {
  const pts = decodePath(path);
  const s = pathSamples(pts, courseStep(mesh));
  let hint = 0;
  for (let k = 0; k < s.x.length; k++) {
    hint = findCell(mesh, s.x[k], s.y[k], hint);
    if (hint !== cell) continue;
    const x = roundPathValue(s.x[k]);
    const y = roundPathValue(s.y[k]);
    if (findCell(mesh, x, y, cell) !== cell) continue;
    const out = pts.slice(0, s.seg[k] + 1);
    const last = out[out.length - 1];
    if (last[0] !== x || last[1] !== y) out.push([x, y]);
    // 截在起点那格：至少留下两个点
    if (out.length < 2) out.push([x, y]);
    return encodePath(out);
  }
  return null;
}

// 一串格的格心（整个星球上沿河连续展开，接在 start 后面）；到了海或湖就画到两格之间为止，与自然的河的画法相同
export function centrePoints(world: World, cells: readonly number[], start?: [number, number]): [number, number][] {
  const { mesh, causes } = world;
  const lake = world.derived.lake;
  const sphere = mesh.kind === 'sphere';
  const pts: [number, number][] = start ? [start] : [];
  for (const c of cells) {
    const prev = pts.length ? pts[pts.length - 1][0] : mesh.x[c];
    const x = sphere ? prev + wrapDelta(mesh.x[c] - prev) : mesh.x[c];
    if (pts.length && (!causes.land[c] || lake[c] === 1)) {
      const [px, py] = pts[pts.length - 1];
      pts.push([(px + x) / 2, (py + mesh.y[c]) / 2]);
      break;
    }
    pts.push([x, mesh.y[c]]);
  }
  return pts;
}

// 固定一条自然的河时存下的折线：与画自然的河同样的点（格心，入海、入湖的画到两格之间）加上同样的曲流，
// 再平滑一遍就是原来屏幕上的样子。点太多时化简
export function stemPath(world: World, cells: readonly number[]): number[] {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const wavy = meander(centrePoints(world, cells), mesh.spacing);
  let out = wavy;
  for (let tol = 0.03 * mesh.spacing; out.length > COURSE_MAX_POINTS; tol *= 1.5) out = douglasPeucker(wavy, tol);
  if (sphere && out.length) {
    const shift = 2 * Math.floor(out[0][0] / 2);
    if (shift) out = out.map(([x, y]) => [x - shift, y]);
  }
  return encodePath(dedupePoints(out.map(roundPoint)));
}

// 一条河道上算作“这条河”的第 i 格：最后一格是它汇入的地方（那条河的）不算；在终点消失的河的终点算（水在那里消失，
// 别的河经过它也会被吞掉，所以截走、改道时要把它的“消失”去掉）
// 分出去的一股（branch）的第一格在干流上，也不是它的
export const ownsCell = (g: Pick<Guide, 'cells' | 'end' | 'branch'>, i: number) => (i < g.cells.length - 1 || g.end === 'sink') && !(i === 0 && g.branch);

// 一条画的河的控制点（courseLine 再平滑一遍就是画出来的样子）：画的折线，再接上画完之后顺地势流下去的那段
// （格心加上与自然的河相同的曲流）；没有折线的河道（顺地势画的）整条按格心（与固定自然的河时存的一样，见 stemPath）。
// 重画一段、接到它前面时都按它算，所以没改的地方画出来一点不动
export function guidePoints(world: World, g: Guide): [number, number][] {
  if (!g.path) return decodePath(stemPath(world, g.cells));
  const pts = decodePath(g.path);
  const last = pts[pts.length - 1];
  const m = g.cells.indexOf(findCell(world.mesh, last[0], last[1]));
  if (m < 0 || m >= g.cells.length - 1 || !world.causes.land[g.cells[m]] || world.derived.lake[g.cells[m]] === 1) return pts;
  const tail = meander(centrePoints(world, g.cells.slice(m + 1), last), world.mesh.spacing).slice(1);
  return dedupePoints([...pts, ...tail.map(roundPoint)]);
}

export interface GuideLine {
  // 画出来的样子（guideShape：控制点 guidePoints 再平滑），再每隔半格加密（形状不变）
  points: [number, number][];
  // 每个点落在河道的第几格（g.cells 的下标，沿河不减；平滑后擦过别的格时留在上一格）
  cellIdx: number[];
}

// 一条河道画出来的线：traceRivers 照它画画的河，河道的标记、点中哪条河、量长度、标地名都用它。
// 整个星球上 x 沿河连续展开（起点在 [0, 2) 里）
export function guideLine(world: World, g: Guide): GuideLine {
  const { mesh } = world;
  const smooth = guideShape(world, g);
  const step = 0.5 * mesh.spacing;
  const points: [number, number][] = smooth.length ? [smooth[0]] : [];
  for (let k = 0; k + 1 < smooth.length; k++) {
    const [ax, ay] = smooth[k];
    const [bx, by] = smooth[k + 1];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let j = 1; j < steps; j++) points.push([ax + ((bx - ax) * j) / steps, ay + ((by - ay) * j) / steps]);
    points.push(smooth[k + 1]);
  }
  const pos = new Map<number, number>();
  g.cells.forEach((c, k) => {
    if (!pos.has(c)) pos.set(c, k);
  });
  const cellIdx: number[] = [];
  let idx = 0;
  let hint = g.cells[0];
  for (const [x, y] of points) {
    hint = findCell(mesh, x, y, hint);
    const i = pos.get(hint);
    // 只往前走、一次最多跳几格：河道绕回自己附近时不会跳到下游去
    if (i !== undefined && i > idx && i <= idx + 6) idx = i;
    cellIdx.push(idx);
  }
  return { points, cellIdx };
}

// 一条河道画出来的线（不加密、不找格；河道的白色虚线标记用）
export function guideShape(world: World, g: Guide): [number, number][] {
  const pts = splitLong(guidePoints(world, g), world.mesh.spacing);
  return courseLine(pts, pts.map(() => 0)).points;
}

// 平滑之前把长于两格的直段等分到不长于一格：拐角只在一格上下磨圆（与自然的河一样）。
// 不然两条长直边夹着的拐角会被平滑切掉好几格，画出来的河离画的线、离水真正流过的格都很远。
// 固定自然的河时存的点本来就相隔一格左右，不受影响（整个星球两极附近拉长的格除外，那里只是稍圆一点）
function splitLong(pts: readonly [number, number][], spacing: number): [number, number][] {
  const out: [number, number][] = pts.length ? [pts[0]] : [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len > 2 * spacing) {
      const steps = Math.ceil(len / spacing);
      for (let j = 1; j < steps; j++) out.push([ax + ((bx - ax) * j) / steps, ay + ((by - ay) * j) / steps]);
    }
    out.push(pts[k + 1]);
  }
  return out;
}

// 河道的内容签名：画河的路径缓存按它认（每次快照的河道数组都是新的，按对象认会每次重画）。
// 只看影响画法的几项：格、折线、粗细、终点、是否锁定、类型；改名字、水量不在里面（水量变了流量数组也变）
export function guidesSignature(guides: readonly Guide[]): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ v, 0x5bd1e995) ^ (b >>> 15);
  };
  const str = (t: string | undefined) => {
    mix(t === undefined ? -1 : t.length);
    if (t) for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i));
  };
  for (const g of guides) {
    str(g.id);
    mix(g.cells.length);
    for (const c of g.cells) mix(c);
    mix(g.path ? g.path.length : -1);
    if (g.path) for (const v of g.path) mix(v);
    mix(Math.round((g.width ?? 1) * 1e4));
    mix(g.end === 'sink' ? 1 : 0);
    mix(g.locked ? 1 : 0);
    str(g.type);
    mix(g.branch ? Math.round(g.branch.share * 1e4) : -1);
  }
  return `${guides.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

// 河道的最后一格是不是汇入了别的河：流进那一格的河里这条河不是最大的（与自然的河认干流的办法相同：
// 一样大时编号小的算干流），那一格算那条更大的河的。比它小的河在那里流进来时，那一格还是这条河的
export function joinsRiver(world: World, d: Derived, g: Guide): boolean {
  const { mesh, causes } = world;
  const thr = world.small.planet.riverThreshold;
  const cells = g.cells;
  const L = cells[cells.length - 1];
  const prev = cells[cells.length - 2];
  if (g.end === 'sink' || !causes.land[L] || d.lake[L] === 1) return false;
  for (let e = mesh.off[L]; e < mesh.off[L + 1]; e++) {
    const j = mesh.adj[e];
    if (j === prev || d.receiver[j] !== L || !causes.land[j] || d.lake[j] === 1 || d.discharge[j] < thr) continue;
    if (d.discharge[j] > d.discharge[prev] || (d.discharge[j] === d.discharge[prev] && j < prev)) return true;
  }
  return false;
}

// 一条画的河自己的格（地名、去掉重复的自然河名用）：河道上的陆地格，湖里的不算；
// 最后一格汇入别的河时那一格是那条河的，也不算。从源头往下排
export function guideBody(world: World, d: Derived, g: Guide): number[] {
  const land = world.causes.land;
  let cells = joinsRiver(world, d, g) ? g.cells.slice(0, -1) : g.cells;
  // 分出去的一股：第一格是干流的
  if (g.branch) cells = cells.slice(1);
  return cells.filter((c) => land[c] && d.lake[c] !== 1);
}
