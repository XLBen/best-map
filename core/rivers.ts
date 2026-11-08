import { memoBegin, memoEnd } from './coast-memo';
import { type DisplayCoast, displayCoast, displayCoastAt, riverQueries, shoreCrossing } from './display';
import { coastStyle } from './coast-style';
import { riversStop } from './water-types';
import { type World } from './world';
import { type RiverLine, snapOnto, markJoin, dirAt, lineLength, smoothCourse, guideLine, joinsRiver } from './rivers-line';
import { walkShore } from './rivers-shore';
import { normalMouth, STUB_LEN, tidyMouths } from './rivers-mouth';
import { withBranches } from './rivers-branch';
export { snapOnto, MOUTH_MAX_TURN, TURN_CHORD, maxTurn, smoothCourse, courseLine, riverWidth, roundPathValue, roundPoint, encodePath, decodePath, dedupePoints, segProject, douglasPeucker, courseStep, pathSamples, cutPathAtCell, centrePoints, stemPath, ownsCell, guidePoints, guideLine, guideShape, guidesSignature, joinsRiver, guideBody } from './rivers-line';
export type { RiverLine, GuideLine } from './rivers-line';
export { seawardNormal } from './rivers-shore';
export { riverRibbon } from './rivers-ribbon';
export type { RiverRibbon } from './rivers-ribbon';

// 河流折线：从源头顺流追到入海口、湖或与已画的河汇合处；加轻微的曲流并做 Chaikin 平滑。
// 屏幕与导出共用，所以导出的 rivers.bmp 与屏幕上的河一致。
// 画的河（有折线的河道）照存下的折线画（再平滑一遍），自然的支流画到它的线上为止。
// 入海、入湖的河画到画面上的岸线为止（core/display.ts 的 shoreCrossing：与地形层画海岸线的是同一个海岸场），
// 从湖里流出来的河从湖岸画起

// 支流从这一点接着画（画的河流到了别的河都不经过的地方：从它的线上接出去）
interface Lead {
  cell: number;
  p: [number, number];
  flow: number;
  from: number;
}

// 溺谷（第三十四轮）：入海的自然的河（不是三角洲分出去的一股），河口那一格的溺谷权重过半的，标上 ria（画的时候喇叭口更宽、更长）
function markRias(world: World, lines: RiverLine[]): RiverLine[] {
  const style = coastStyle(world);
  if (!style) return lines;
  const { causes, derived: d } = world;
  for (const l of lines) {
    if (!l.mouth || l.branch !== undefined || l.guide !== undefined || !l.cells?.length) continue;
    const c = l.cells[l.cells.length - 1];
    const r = d.receiver[c];
    const toSea = !causes.land[c] || (d.lake[c] !== 1 && r >= 0 && !causes.land[r]);
    if (toSea && style.ria[c] >= 0.5) l.ria = true;
  }
  return lines;
}

export function traceRivers(world: World): RiverLine[] {
  // 按画面海岸场的几样查询跨几次描河记下来（core/coast-memo.ts；结果逐位不变）
  memoBegin(world.mesh, world.small.terrain.coastRoughness);
  // 描河不画小湖群（第三十四轮，见 core/display.ts 的 riverQueries）
  const was = riverQueries.on;
  riverQueries.on = true;
  try {
    return markRias(world, traceRiversRaw(world));
  } finally {
    riverQueries.on = was;
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
  // 断流的世界（第五十七轮）：河走到没水的格就停了，尾巴收尖。别的世界里不看（分流后不够河的一小股照旧）
  const stops = riversStop(small.species);
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
    tail?: boolean;
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
    let tail = false;
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
      if (!isRiver(r)) {
        tail = stops;
        break;
      }
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
    if (tail) raw.tail = true;
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
    if (raw.tail) line.tail = true;
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
