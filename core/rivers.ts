import { type DisplayCoast, displayCoast, displayCoastAt, shoreCrossing } from './display';
import { wrapDelta } from './geo';
import { type Mesh, findCell } from './mesh';
import { vnoise } from './subcell';
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
  // 支流的最后一点就落在画出来的中线上
  joins?: number[];
}

// 支流从这一点接着画（画的河流到了别的河都不经过的地方：从它的线上接出去）
interface Lead {
  cell: number;
  p: [number, number];
  flow: number;
  from: number;
}

export function traceRivers(world: World): RiverLine[] {
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
  const shore = (a: [number, number], b: [number, number], c: number, r: number): [number, number] => shoreCrossing(world, a, b, c, [c, r])?.p ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let field: DisplayCoast | null = null;
  const coastField = () => (field ??= displayCoast(world));
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
      // 别的河还没接上来（接到它的线上之前）：最后一段改成沿岸线的法向进海、进湖
      normalMouth(world, coastField(), line, 0);
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
  const tidy = tidyMouths(world, lines);
  if (!course) return tidy;
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
  return all;
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
      line.cells!.forEach((c, k) => take(line, k, c));
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
        const o = owner[cell];
        if (!o || o === line) continue;
        const hit = project(cell, line.points[0][0], line.points[0][1]);
        if (!hit) continue;
        line.points[0] = hit.p;
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
// 终点沿岸线的法向），终点是从岸上沿法向走到岸线的那一点。只改画法（屏幕、导出），水文、流向都不变

// 河口往回多长（格）换成沿法向进海的一段
const MOUTH_LEG = 0.9;
// 量岸线法向的圈的半径（格）与取几个点：海岸细节的小弯不算，量的是约一格见方的岸线走向
const NORMAL_R = 0.4;
const NORMAL_N = 12;

// 一点处岸线朝水面的法向（单位向量）：一圈点的海岸场加权求和（离岸线约半格以内的一圈，近似梯度的反方向）
export function seawardNormal(world: World, f: DisplayCoast, p: readonly [number, number], hint = 0): [number, number] | null {
  const r = NORMAL_R * world.mesh.spacing;
  let gx = 0;
  let gy = 0;
  let h = hint;
  for (let i = 0; i < NORMAL_N; i++) {
    const a = (2 * Math.PI * i) / NORMAL_N;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const v = displayCoastAt(world, f, p[0] + r * c, p[1] + r * s, h);
    h = v.nearest;
    // 海岸场正的是陆地：按它加权的方向指向陆地
    const w = Math.max(-1, Math.min(1, v.v / 50));
    gx += w * c;
    gy += w * s;
  }
  const l = Math.hypot(gx, gy);
  return l > 1e-9 ? [-gx / l, -gy / l] : null;
}

// 从 A（方向 ta）到 B（到 B 时的方向 tb，都是单位向量）的三次 Hermite 曲线，每隔约 step 取一点（不含 A，含 B）
function hermite(A: readonly [number, number], ta: readonly [number, number], B: readonly [number, number], tb: readonly [number, number], step: number): [number, number][] {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const count = Math.max(2, Math.ceil(L / step));
  const out: [number, number][] = [];
  for (let j = 1; j <= count; j++) {
    const u = j / count;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    out.push(j === count ? [B[0], B[1]] : [h00 * A[0] + h10 * L * ta[0] + h01 * B[0] + h11 * L * tb[0], h00 * A[1] + h10 * L * ta[1] + h01 * B[1] + h11 * L * tb[1]]);
  }
  return out;
}

// 海岸边的源头小河：从源头到入海不到这么长（格）的不画（画出来只是岸边一个尖尖的楔子）
const STUB_LEN = 1.5;
// 流进同一格海的几个河口：两个河口相隔这么近（格）以内时，小的画成在岸边汇入大的（接到大的河口往回约 0.45 格的地方）
const MERGE_DIST = 1.6;
// 接在大河河口往回多远、小河从河口往回多远起接（格）：先试最靠近岸边的
const MERGE_TRIES: [number, number][] = [
  [0.45, 0.6],
  [0.9, 1],
  [1.4, 1.5],
];

const lineLength = (P: readonly (readonly [number, number])[]) => {
  let s = 0;
  for (let k = 0; k + 1 < P.length; k++) s += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
  return s;
};

// 从线尾往回量 back 远的那一点：第 k 段上 t 处（k + t），量不到时为线头
function backAlong(P: readonly (readonly [number, number])[], back: number, lim = 0): { k: number; t: number; p: [number, number] } {
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

// 自然的河的河口收拾一下（第十三轮，只改画法）：去掉海岸边不到 1.5 格的源头小河；流进同一格海、河口挨得很近的几条，
// 小的画成在岸边汇入大的（不再是几条河斜着挤到同一格海里、画成一个“V”）。返回留下的线，into 按新的下标
function tidyMouths(world: World, lines: RiverLine[]): RiverLine[] {
  const { mesh, causes, derived: d } = world;
  const sp = mesh.spacing;
  const sphere = mesh.kind === 'sphere';
  const field = displayCoast(world);
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
  const index = new Int32Array(lines.length).fill(-1);
  let n = 0;
  lines.forEach((_, i) => {
    if (keep[i]) index[i] = n++;
  });
  // 汇入的那条按新的下标（去掉的小河连同汇进它的一起去掉了）
  for (const l of lines) if (l.into !== undefined) l.into = index[l.into] >= 0 ? index[l.into] : undefined;
  const groups = new Map<number, number[]>();
  lines.forEach((l, i) => {
    if (!keep[i]) return;
    const r = seaOf(l);
    if (r < 0) return;
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  const endFlow = (l: RiverLine) => l.flow[l.flow.length - 1];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => endFlow(lines[b]) - endFlow(lines[a]) || a - b);
    const main = lines[g[0]];
    const me = main.points[main.points.length - 1];
    for (const i of g.slice(1)) {
      const o = lines[i];
      const oe = o.points[o.points.length - 1];
      const dx = sphere ? oe[0] - me[0] - 2 * Math.round((oe[0] - me[0]) / 2) : oe[0] - me[0];
      if (Math.hypot(dx, oe[1] - me[1]) > MERGE_DIST * sp) continue;
      if (joinNearMouth(world, field, main, o, sphere ? me[0] - oe[0] + dx : 0)) {
        delete o.mouth;
        o.into = index[g[0]];
      }
    }
  }
  return lines.filter((_, i) => keep[i]);
}

// 河口挨得很近的小河 o 在岸边汇入大河 main：o 从河口往回约 0.6 格起接到 main 河口往回约 0.45 格的那一点
// （到那一点时顺着 main 的方向斜着并进去）。接出来的一段有一点在水里时不接，返回 false。
// shift：整个星球上 main 的点挪到 o 那一份要加的（平面上为 0）
function joinNearMouth(world: World, f: DisplayCoast, main: RiverLine, o: RiverLine, shift: number): boolean {
  // 中间隔着一点水（小海湾）时往上游一点再接
  for (const [back, trim] of MERGE_TRIES) if (joinAt(world, f, main, o, shift, back, trim)) return true;
  return false;
}

function joinAt(world: World, f: DisplayCoast, main: RiverLine, o: RiverLine, shift: number, back: number, trim: number): boolean {
  const sp = world.mesh.spacing;
  const M = main.points;
  const O = o.points;
  if (M.length < 2 || O.length < 2) return false;
  const J = backAlong(M, back * sp);
  const Jp: [number, number] = [J.p[0] - shift, J.p[1]];
  let olim = 0;
  for (const pos of o.joins ?? []) olim = Math.max(olim, Math.ceil(pos));
  const A0 = backAlong(O, trim * sp, Math.min(olim, O.length - 2));
  // 接在 A0 所在那段的起点之后（那一点留着）
  const k = A0.k;
  const A = O[k];
  const B = k > 0 ? O[k - 1] : O[k + 1];
  const tl = Math.hypot(A[0] - B[0], A[1] - B[1]) || 1;
  const sgn = k > 0 ? 1 : -1;
  const t0: [number, number] = [(sgn * (A[0] - B[0])) / tl, (sgn * (A[1] - B[1])) / tl];
  const mk = Math.min(M.length - 2, J.k);
  const ml = Math.hypot(M[mk + 1][0] - M[mk][0], M[mk + 1][1] - M[mk][1]) || 1;
  const md: [number, number] = [(M[mk + 1][0] - M[mk][0]) / ml, (M[mk + 1][1] - M[mk][1]) / ml];
  const L = Math.hypot(Jp[0] - A[0], Jp[1] - A[1]);
  if (L < 1e-9) return false;
  const ad: [number, number] = [(Jp[0] - A[0]) / L, (Jp[1] - A[1]) / L];
  let ex = 0.5 * md[0] + ad[0];
  let ey = 0.5 * md[1] + ad[1];
  const el = Math.hypot(ex, ey) || 1;
  ex /= el;
  ey /= el;
  const hint = o.cells?.[k] ?? 0;
  const pts = hermite(A, t0, Jp, [ex, ey], sp / 8);
  for (let j = 0; j + 1 < pts.length; j++) if (displayCoastAt(world, f, pts[j][0], pts[j][1], hint).v <= 0) return false;
  const count = pts.length;
  const keepN = k + 1;
  const q0 = o.flow[k];
  o.points = [...O.slice(0, keepN), ...pts];
  o.flow = [...o.flow.slice(0, keepN), ...pts.map(() => q0)];
  if (o.cells) {
    const own = o.cells[k];
    const at = main.cells?.[Math.min(main.cells.length - 1, J.t > 0.5 ? J.k + 1 : J.k)] ?? own;
    o.cells = [...o.cells.slice(0, keepN), ...pts.map((_, j) => (j === count - 1 ? at : own))];
  }
  if (o.type) {
    const t = o.type[k];
    o.type = [...o.type.slice(0, keepN), ...pts.map(() => t)];
  }
  if (o.mul) {
    const mm = o.mul[k];
    o.mul = [...o.mul.slice(0, keepN), ...pts.map(() => mm)];
  }
  markJoin(main, J.k + J.t);
  return true;
}

// 入海、入湖的线（最后一点在岸线上）：最后约 0.9 格换成沿岸线法向进水的一段（见上）。keep：这一点以前不能动
// （别的河在那里汇进来）。法向量不出来、接出来的一段有一点在水里时不改
function normalMouth(world: World, f: DisplayCoast, line: RiverLine, keep: number): void {
  const { mesh } = world;
  const sp = mesh.spacing;
  const P = line.points;
  const m = P.length;
  if (m < 2) return;
  const hint = line.cells?.[m - 1] ?? 0;
  const land = (q: readonly [number, number]) => displayCoastAt(world, f, q[0], q[1], hint).v > 0;
  // 岸线上沿法向的那一点：从岸上（沿法向往回 0.6 格，不在陆地上时 0.25 格）走到水面；再按那一点的法向重找一次
  let end: readonly [number, number] = P[m - 1];
  let n: [number, number] | null = null;
  let p: [number, number] | null = null;
  for (let it = 0; it < 2; it++) {
    const nn = seawardNormal(world, f, end, hint);
    if (!nn) break;
    let from: [number, number] = [end[0] - nn[0] * 0.6 * sp, end[1] - nn[1] * 0.6 * sp];
    if (!land(from)) from = [end[0] - nn[0] * 0.25 * sp, end[1] - nn[1] * 0.25 * sp];
    if (!land(from)) break;
    const hit = shoreCrossing(world, from, [end[0] + nn[0] * 0.6 * sp, end[1] + nn[1] * 0.6 * sp], hint);
    if (!hit) break;
    n = nn;
    p = hit.p;
    end = p;
  }
  if (!n || !p) return;
  let lim = keep;
  for (const pos of line.joins ?? []) lim = Math.max(lim, Math.ceil(pos));
  let k = m - 1;
  let s = 0;
  while (k > lim && k > 0 && s < MOUTH_LEG * sp) {
    s += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
    k--;
  }
  if (k >= m - 1) return;
  const A = P[k];
  const B = k > 0 ? P[k - 1] : P[k + 1];
  let tx = k > 0 ? A[0] - B[0] : B[0] - A[0];
  let ty = k > 0 ? A[1] - B[1] : B[1] - A[1];
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const L = Math.hypot(p[0] - A[0], p[1] - A[1]);
  if (L < 0.15 * sp) return;
  // 最后一小段（约 0.35 格）是沿法向的直线，之前用曲线从原来的方向弯过来
  const straight = Math.min(0.35 * sp, 0.4 * L);
  const Q: [number, number] = [p[0] - n[0] * straight, p[1] - n[1] * straight];
  const pts = hermite(A, [tx, ty], Q, n, sp / 8);
  const ns = Math.max(1, Math.ceil(straight / (sp / 8)));
  for (let j = 1; j <= ns; j++) pts.push(j === ns ? [p[0], p[1]] : [Q[0] + (p[0] - Q[0]) * (j / ns), Q[1] + (p[1] - Q[1]) * (j / ns)]);
  for (let j = 0; j + 1 < pts.length; j++) if (!land(pts[j])) return;
  const count = pts.length;
  const f0 = line.flow[k];
  const f1 = line.flow[m - 1];
  const keepN = k + 1;
  line.points = [...P.slice(0, keepN), ...pts];
  line.flow = [...line.flow.slice(0, keepN), ...pts.map((_, j) => f0 + ((f1 - f0) * (j + 1)) / count)];
  const halves = <T>(arr: T[]) => [...arr.slice(0, keepN), ...pts.map((_, j) => ((j + 1) / count < 0.5 ? arr[k] : arr[m - 1]))];
  if (line.cells) line.cells = halves(line.cells);
  if (line.type) line.type = halves(line.type);
  if (line.mul) {
    const m0 = line.mul[k];
    const m1 = line.mul[m - 1];
    line.mul = [...line.mul.slice(0, keepN), ...pts.map((_, j) => m0 + ((m1 - m0) * (j + 1)) / count)];
  }
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
    const last = <T>(a: T[]) => [...a, a[a.length - 1]];
    line = { ...line, points: [...Q, more], flow: last(line.flow), ...(line.mul ? { mul: last(line.mul) } : {}), ...(line.type ? { type: last(line.type) } : {}), ...(line.cells ? { cells: last(line.cells) } : {}) };
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
  const mulOf = (k: number) => (line.mul ? line.mul[k] : 1) * (mulAt ? mulAt(k) : 1);
  let o = 0;
  const put = (k: number, t: number) => {
    const k1 = Math.min(m - 1, k + 1);
    x[o] = P[k][0] + (P[k1][0] - P[k][0]) * t;
    y[o] = P[k][1] + (P[k1][1] - P[k][1]) * t;
    w[o] = riverWidth(line.flow[k] + (line.flow[k1] - line.flow[k]) * t, thr);
    mul[o] = mulOf(k) + (mulOf(k1) - mulOf(k)) * t;
    src[o] = Math.min(k, Math.max(0, m - 2));
    o++;
  };
  put(0, 0);
  for (let k = 0; k + 1 < m; k++) for (let j = 1; j <= parts[k]; j++) put(k, j / parts[k]);
  // 2. 沿河的长度
  const s = new Float64Array(count);
  for (let i = 1; i < count; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  const L = s[count - 1];
  // 岸线在哪里（往水里多画的那段之前）
  const Ls = L - under;
  // 3. 宽度：往下游只增不减，再沿河来回各平滑一遍（约半格；只增不减的数列平滑后仍只增不减）
  for (let i = 1; i < count; i++) if (w[i] < w[i - 1]) w[i] = w[i - 1];
  const lam = WIDTH_SMOOTH * spacing;
  for (let i = 1; i < count; i++) {
    const a = 1 - Math.exp(-(s[i] - s[i - 1]) / lam);
    w[i] = w[i - 1] + (w[i] - w[i - 1]) * a;
  }
  for (let i = count - 2; i >= 0; i--) {
    const a = 1 - Math.exp(-(s[i + 1] - s[i]) / lam);
    w[i] = w[i + 1] + (w[i] - w[i + 1]) * a;
  }
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
  const normals = () => {
    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(count - 1, i + 1);
      const tx = x[b] - x[a];
      const ty = y[b] - y[a];
      const l = Math.hypot(tx, ty) || 1;
      nx[i] = -ty / l;
      ny[i] = tx / l;
    }
  };
  normals();
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
        const at = (i: number) => (damp![i] = Math.min(damp![i], smooth01((Math.abs(s[i] - sj) - step) / (0.5 * spacing))));
        for (let i = i0; i >= 0 && sj - s[i] < reach; i--) at(i);
        for (let i = i1; i < count && s[i] - sj < reach; i++) at(i);
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
    normals();
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
