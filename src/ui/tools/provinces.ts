import { type DisplayCell, displayCellAt } from '../../../core/display';
import { classOfKind, regenTargets } from '../../../core/provinces';
import { type ProvinceSeam, scissors } from '../../../core/seams';
import { type CutResult, provinceCells } from '../../../core/select';
import { type World, provinceColor, provinceDisplayColor } from '../../../core/world';
import type { HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { exec, previewProvinces, selectedProvince, showToast, sliderActive, world } from '../../state';
import { Settle } from '../exact';
import { BLOCKED_RGB, EMPTY, type Pointer, type Preview, type ProvincePreview, type ToolHandler, isBusy, worldId } from './api';
import { type Stroke, brushTool } from './brush';
import { groupCount } from './gestures';

// 省份：选省、涂省、剪刀、合并、重新划分

const provinceName = (w: World, id: number) => w.small.provinces[id]?.name || `省份 ${id}`;

// 屏幕上这一点画的是哪一格（见 core/display.ts）：MapView 算好放在指针上，没有时（比如测试里）当场算
export function shownAt(w: World, p: Pointer): DisplayCell | null {
  if (p.cell < 0) return null;
  return p.shown ?? displayCellAt(w, p.x, p.y, p.cell);
}

// 鼠标下算哪一格的省（选省、合并、吸取省份用）：地图上这一点画成哪个省就是哪个
// （扭曲后的格、剪刀切线两边按显示出来的那一边，与着色器同一条规则）
// 画成水面（海、湖）的点只取水面格（海上的点永远不算陆上的省）；附近没有水面格时为 −1
export function provinceCellAt(w: World, p: Pointer): number {
  return shownAt(w, p)?.province ?? -1;
}
// 鼠标下画出来的省（省份编号；没有时 −1）
const provinceIdAt = (w: World, p: Pointer): number => {
  const c = provinceCellAt(w, p);
  return c >= 0 ? w.causes.province[c] : -1;
};

export function provinceSelectTool(): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    click(p) {
      const w = world.value;
      if (!w || p.cell < 0) return;
      const id = provinceIdAt(w, p);
      selectedProvince.value = id >= 0 ? id : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      const id = provinceIdAt(w, pointer);
      if (id < 0) return EMPTY;
      return { layers: [], shapes: [], hint: provinceName(w, id) };
    },
  };
}

// 每个省的格与原来就有几块（按世界缓存：涂省时每动一下都要看被涂到的省还连不连着）
const provinceListCache = new WeakMap<World, { cells: Map<number, number[]>; pieces: Map<number, number> }>();
function provincesNow(w: World) {
  let m = provinceListCache.get(w);
  if (!m) {
    m = { cells: new Map(), pieces: new Map() };
    for (let i = 0; i < w.mesh.n; i++) {
      const p = w.causes.province[i];
      if (p < 0) continue;
      let l = m.cells.get(p);
      if (!l) m.cells.set(p, (l = []));
      l.push(i);
    }
    provinceListCache.set(w, m);
  }
  return m;
}

export function provinceBrushTool(): ToolHandler {
  const target = () => selectedProvince.value;
  // 涂到的格换成选中的省：地图上省界当场跟着变（按笔画、省缓存，同一个对象不必重新上传）。
  // 被涂掉一部分的省剩下的格比原来多断成了几块（会变成一省几块）：黄色提醒，照样能涂
  let prov: { key: string; s: Stroke; value: ProvincePreview; split: { id: number; parts: number } | null } | null = null;
  const provincesOf = (w: World, s: Stroke, id: number) => {
    const key = `${worldId(w)}|${id}|${s.t.size}`;
    if (prov?.s !== s || prov.key !== key) {
      const cells = s.cells;
      const taken = new Set(cells);
      const losers = new Set<number>();
      for (const c of cells) if (w.causes.province[c] >= 0 && w.causes.province[c] !== id) losers.add(w.causes.province[c]);
      let split: { id: number; parts: number } | null = null;
      const now = provincesNow(w);
      for (const p of losers) {
        const all = now.cells.get(p) ?? [];
        const rest = all.filter((c) => !taken.has(c));
        const parts = rest.length ? groupCount(w, rest) : 0;
        if (parts < 2 || (split && parts <= split.parts)) continue;
        // 原来就是几块的（比如一省几个岛）：多断出来才提醒
        let before = now.pieces.get(p);
        if (before === undefined) now.pieces.set(p, (before = groupCount(w, all)));
        if (parts > before) split = { id: p, parts };
      }
      prov = { key, s, value: { cells, ids: cells.map(() => id) }, split };
    }
    return prov;
  };
  return brushTool({
    hint: () => {
      const w = world.value;
      const id = target();
      if (!w || id === null || !w.small.provinces[id]) return { text: '先按住 Alt 点一个省份', warn: true };
      return { text: null };
    },
    filter: (w, i) => {
      const id = target();
      const meta = id !== null ? w.small.provinces[id] : null;
      if (!meta) return false;
      const other = w.causes.province[i];
      const om = other >= 0 ? w.small.provinces[other] : undefined;
      // 湖省与陆地省之间不换格（湖单独成省时，见 assign_province）
      if (om && om.land && classOfKind(om.kind) !== classOfKind(meta.kind)) return false;
      return (w.causes.land[i] === 1) === meta.land && other !== id && !om?.locked;
    },
    layers(w, s) {
      const id = target()!;
      const { value, split } = provincesOf(w, s, id);
      return {
        layers: [{ cells: s.cells, color: provinceDisplayColor(w, id), alpha: 0.8 }],
        hint: split ? `会把“${provinceName(w, split.id)}”分成 ${split.parts} 块` : `${provinceName(w, id)} +${s.t.size} 格`,
        caution: !!split,
        provinces: value,
      };
    },
    async commit(_w, s) {
      const id = target();
      if (id === null || !s.t.size) return;
      await exec({ op: 'assign_province', cells: s.cells, province: id }, '正在计算…');
    },
  });
}

// 剪刀：沿画的线切开省份（线是墙，两端自动延长到省界）。切成几块就是几个省，切开的两省之间的边界就是画的线。
// 拖动时地图上直接画出切开后真实的省界（与结果同一套编码、扭曲和切线规则），新的几块用它们将来的颜色；
// 切出几块之后原来的红线隐去，只留两端的小点和自动延长的虚线。松手后预览一直留到结果回来。
// 预览与命令用同一条线（延长、化简之后的，见 core/seams.ts 的 scissors），所以切出来的块、新省的编号都一样
const CUT_RED = 'rgba(255, 90, 70, 0.95)';

export function provinceCutTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let line: [number, number][] | null = null;
  let lastScreen: [number, number] = [0, 0];
  let committing = false;
  let cache: { key: string; cut: CutResult; line: [number, number][]; view: Preview } | null = null;
  const cutNow = (w: World, pts: [number, number][]) => {
    const key = `${worldId(w)}|${pts.length}|${pts[pts.length - 1].join(',')}`;
    if (cache?.key !== key) {
      const { ext, line: sent, cut, seams } = scissors(w, pts);
      cache = { key, cut, line: sent, view: viewOf(pts, ext, seams, cut) };
    }
    return cache;
  };
  // 新的几块：编号按命令里的顺序（与执行时新建省份的顺序相同，见 core/seams.ts 的 cutSeams），颜色就是将来的颜色
  const viewOf = (pts: [number, number][], ext: CutResult, seams: Omit<ProvinceSeam, 'id'>[], cut: CutResult): Preview => {
    const layers: HighlightLayer[] = [];
    const cells: number[] = [];
    const ids: number[] = [];
    cut.plans.forEach((pl, k) => {
      pl.parts.forEach((part, j) => {
        if (!j) return;
        const id = seams[k].provinces[j];
        layers.push({ cells: part, color: provinceColor(id), alpha: 0.45 });
        for (const c of part) {
          cells.push(c);
          ids.push(id);
        }
      });
    });
    const shapes: Shape[] = [];
    if (!cut.plans.length) shapes.push({ kind: 'line', points: pts, color: CUT_RED, width: 2.5 });
    else {
      const dot = 2.5 / zoom();
      for (const [x, y] of [pts[0], pts[pts.length - 1]]) shapes.push({ kind: 'circle', x, y, r: dot, color: CUT_RED, width: 2 });
    }
    if (ext.before) shapes.push({ kind: 'line', points: ext.line.slice(0, ext.before + 1), color: 'rgba(255, 90, 70, 0.8)', width: 2, dashed: true });
    if (ext.after) shapes.push({ kind: 'line', points: ext.line.slice(ext.line.length - 1 - ext.after), color: 'rgba(255, 90, 70, 0.8)', width: 2, dashed: true });
    const pieces = cut.plans.reduce((n, pl) => n + pl.parts.length, 0);
    return { layers, shapes, hint: cut.plans.length ? `切成 ${pieces} 块` : '线还没把省份分开', provinces: cells.length ? { cells, ids, seams } : null };
  };
  return {
    drags: true,
    down(p) {
      if (isBusy() || committing) return;
      line = [[p.x, p.y]];
      lastScreen = [p.sx, p.sy];
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      if (pressed && line && !committing && Math.hypot(p.sx - lastScreen[0], p.sy - lastScreen[1]) > 6) {
        line.push([p.x, p.y]);
        lastScreen = [p.sx, p.sy];
      }
    },
    async up(p) {
      const w = world.value;
      if (!w || !line || committing) return;
      line.push([p.x, p.y]);
      const { cut, line: sent } = cutNow(w, line);
      if (!cut.plans.length) {
        line = null;
        showToast('线没有把省份分开', true);
        return;
      }
      committing = true;
      try {
        await exec({ op: 'cut_province', line: sent }, '正在计算…');
      } finally {
        committing = false;
        line = null;
      }
    },
    cancel() {
      if (!committing) line = null;
    },
    preview() {
      // 松手后（正在计算）：停在松手时的样子。新世界先到时也不重新算（线在新世界里已经切不开什么了）
      if (committing && cache) return { ...cache.view, hint: '正在计算…' };
      const w = world.value;
      if (!w || !pointer || !line || line.length < 2) return EMPTY;
      return cutNow(w, [...line, [pointer.x, pointer.y]]).view;
    },
  };
}

// 合并：悬停在邻省上时，两省之间的省界当场消失（省份预览），点了以后一直留到结果回来。
// 锁定的省标红、点了也不合并；不相邻的两省照样能合并（黄色提醒：合并后是一省两块）
export function provinceMergeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let cache: { key: string; view: Preview } | null = null;
  let committing: Preview | null = null;
  const view = (): Preview => {
    const w = world.value;
    if (!w || !pointer || pointer.cell < 0) return EMPTY;
    const id = provinceIdAt(w, pointer);
    const sel = selectedProvince.value;
    if (id < 0) return EMPTY;
    if (sel === null || sel === id || !w.small.provinces[sel]) return { layers: [], shapes: [], hint: provinceName(w, id) };
    const meta = w.small.provinces[id];
    const other = w.small.provinces[sel];
    if (meta.land !== other.land) return { layers: [], shapes: [], hint: '陆地省份和海省不能合并', warn: true };
    const key = `${worldId(w)}|${id}|${sel}`;
    if (cache?.key !== key) {
      const cells = provinceCells(w, id);
      const locked = meta.locked ? id : other.locked ? sel : null;
      if (locked !== null) {
        // 合并不了的不画将来的省界（省界当场消失却并不成，就不是所见即所得）：这个省标红
        cache = { key, view: { layers: [{ cells, color: BLOCKED_RGB, alpha: 0.45 }], shapes: [], hint: `“${provinceName(w, locked)}”已锁定`, warn: true } };
      } else {
        const apart = !cells.some((c) => {
          for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (w.causes.province[w.mesh.adj[e]] === sel) return true;
          return false;
        });
        cache = {
          key,
          view: {
            layers: [{ cells, color: provinceDisplayColor(w, sel), alpha: 0.7 }],
            shapes: [],
            hint: apart ? '不相邻：合并后分成两块' : `并进“${provinceName(w, sel)}”`,
            caution: apart,
            provinces: { cells, ids: cells.map(() => sel) },
          },
        };
      }
    }
    return cache.view;
  };
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    async click(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy()) return;
      const id = provinceIdAt(w, p);
      const sel = selectedProvince.value;
      if (id < 0) return;
      if (sel === null || sel === id || !w.small.provinces[sel]) {
        selectedProvince.value = id;
        return;
      }
      // 留住的预览就是点下去的这一处（与命令合并的是同一个省）；合并不了的（锁定、陆海不同）点了只说一声
      pointer = p;
      const v = view();
      if (v.warn) {
        showToast(v.hint ?? '不能合并', true);
        return;
      }
      committing = v;
      try {
        if (await exec({ op: 'merge_province', from: id, into: sel }, '正在计算…')) selectedProvince.value = sel;
      } finally {
        committing = null;
      }
    },
    preview() {
      return committing ?? view();
    },
  };
}

// 重划：涂到一大半的省重新划分。会重划哪几个省定下来 150 毫秒后在 Worker 里算确切的结果（与执行同一个算法、
// 同样的省名），地图上直接画出新的省界和省名；算好之前先把会重划的省涂黄。
// 结果只取决于重划哪几个省（不看具体涂了哪几格），所以接着在这几个省里涂时新省界一直留着，不重算、不闪回
export function provinceRegenTool(): ToolHandler {
  let cache: { key: string; s: Stroke; ids: string; cells: number[]; count: number; rough: HighlightLayer[]; framed: HighlightLayer[] } | null = null;
  // 确切的结果：按“这个世界上重划哪几个省 + 这一笔”认
  const exact = new Settle<{ prov: ProvincePreview; fresh: number }>();
  // 会被重新划分的省份：被涂到一半以上的（与命令用同一个判断）
  const targets = (w: World, s: Stroke) => {
    const key = `${worldId(w)}|${s.t.size}|${s.cells[s.cells.length - 1]}`;
    if (cache?.s !== s || cache.key !== key) {
      const list = regenTargets(w, s.cells);
      const ids = new Set(list);
      const cells: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) if (ids.has(w.causes.province[i])) cells.push(i);
      const stroke: HighlightLayer = { cells: s.cells, color: [255, 255, 255], alpha: 0.25 };
      // 确切的新省界画出来以后，会重划的范围只描边（不盖住新的省界）
      cache = { key, s, ids: `${worldId(w)}|${list.join(',')}`, cells, count: ids.size, rough: [stroke, { cells, color: [255, 220, 90], alpha: 0.6 }], framed: [stroke, { cells, color: [255, 220, 90], pattern: 'outline' }] };
    }
    return cache;
  };
  const want = (w: World, s: Stroke, key: string) => {
    const cells = s.cells;
    exact.want(
      key,
      async () => {
        const r = await previewProvinces({ op: 'regenerate_provinces', cells });
        if (!r || world.value !== w) return null;
        const fresh = Object.keys(r.provinces).filter((id) => !w.small.provinces[Number(id)]).length;
        return { fresh, prov: { cells: [], ids: [], province: r.province, seamList: r.seams, metas: r.provinces } };
      },
      150,
    );
  };
  return brushTool({
    hint: () => ({ text: null }),
    layers(w, s) {
      const t = targets(w, s);
      const key = `${t.ids}|${s.id}`;
      // 拖滑块时预览的单点一笔不去 Worker 里算（地图上只画涂黄的范围）
      if (t.count && !sliderActive.value) want(w, s, key);
      const x = exact.get(key);
      return {
        layers: x ? t.framed : t.rough,
        hint: !t.count ? '再多涂一些' : x ? `重划 ${t.count} 个省份 → ${x.fresh} 个` : `重划 ${t.count} 个省份`,
        provinces: x?.prov ?? null,
      };
    },
    async commit(w, s) {
      // 松手了：还没到时候的预览不必再算（Worker 先算这一步）
      exact.hold();
      if (!targets(w, s).count) {
        showToast('要盖住省份的一大半才会重划', true);
        return;
      }
      await exec({ op: 'regenerate_provinces', cells: s.cells }, '正在计算…');
    },
  });
}
