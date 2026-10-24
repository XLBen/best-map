import type { Command } from '../../../core/commands';
import type { PreviewResult } from '../../../core/engine';
import { brushCells } from '../../../core/select';
import type { World } from '../../../core/world';
import type { GhostEdit, HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { type ToolOptions, options, redrawTick, showToast, sliderActive, world } from '../../state';
import { Covered, Exact, type ExactView, slowTail } from '../exact';
import { queueHint, queuedCount, trackEdit } from '../pending';
import { type Backdrop, EMPTY, type Pointer, type Preview, type ProvincePreview, type ToolHandler, WHITE, guard, mapDist } from './api';

// 画笔：按住拖动涂一片。所有画笔共用一个大小（底部条上的“直径”，options.brushKm 存的是半径）

// 画笔半径（地图单位）
export const brushR = (w: World, km: number) => km / w.kmPerUnit;

// 一笔：经过的格与到笔画中心线的最近归一化距离 t（0 中心，1 边缘）
let strokeIds = 0;
// 一格的画笔拖线时，格心离笔画不到这么多格的邻格也涂上（见 Stroke.add）
export const LINE_CELL = 0.5;
export class Stroke {
  t = new Map<number, number>();
  id = ++strokeIds;
  // 改过几次（涂到新的格、离中心线更近）：确切预览、幽灵海岸按它判断还是不是同一笔（笔没变就沿用同一个结果）
  rev = 0;
  private last: [number, number] | null = null;

  // km：画笔半径（km）
  add(w: World, x: number, y: number, km: number, filter?: (i: number) => boolean) {
    const r = brushR(w, km);
    const last = this.last;
    const sp = w.mesh.spacing;
    // 只涂一格的画笔（半径不到半格）：沿着这一段每 1/4 格取一点
    const tiny = r < sp * 0.5;
    const step = tiny ? Math.min(r * 0.4, sp * 0.25) : r * 0.4;
    const steps = last ? Math.max(1, Math.ceil(Math.hypot(x - last[0], y - last[1]) / step)) : 1;
    const samples: [number, number][] = [];
    const centers = new Set<number>();
    for (let k = 1; k <= steps; k++) {
      const px = last ? last[0] + ((x - last[0]) * k) / steps : x;
      const py = last ? last[1] + ((y - last[1]) * k) / steps : y;
      samples.push([px, py]);
      const b = brushCells(w, px, py, km);
      b.cells.forEach((c, j) => {
        if (tiny) centers.add(c);
        if (filter && !filter(c)) return;
        const prev = this.t.get(c);
        if (prev === undefined || b.t[j] < prev) {
          this.t.set(c, b.t[j]);
          this.rev++;
        }
      });
    }
    // 一格的画笔拖出一条线（第十三轮修）：只取每一点所在的格时，格心左右交替，涂出来是锯齿。
    // 再加上格心离这一段不到 LINE_CELL 格的邻格，一条线连续、两边整齐（约一格多宽）
    if (tiny && last) {
      const { mesh } = w;
      const lim = sp * LINE_CELL;
      for (const c of centers) {
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (this.t.get(j) === 0 || (filter && !filter(j))) continue;
          if (samples.some(([px, py]) => mapDist(w, mesh.x[j], mesh.y[j], px, py) <= lim)) {
            this.t.set(j, 0);
            this.rev++;
          }
        }
      }
    }
    this.last = [x, y];
  }
  get cells() {
    return [...this.t.keys()];
  }
  get ts() {
    return [...this.t.values()];
  }
  weights() {
    return this.ts.map((u) => 1 - u * u * (3 - 2 * u));
  }
}

// ---------- 通用的画笔工具 ----------

export interface BrushConfig {
  // 鼠标悬停时的一句话：只在现在不能用时说（warn）；能用时一般不说（怎么用在工具的悬停提示里）
  hint: (shift: boolean) => { text: string | null; warn?: boolean };
  // 哪些格能被这一笔涂到
  filter?: (w: World, i: number) => boolean;
  layers: (w: World, s: Stroke, shift: boolean) => BrushLayers;
  // 松手后排在队里、前面的编辑换上了新世界时，按新世界重算这一笔的幽灵海岸。在松手时调用：用到的选项（画陆地还是画海……）
  // 按松手时的定下来，与 commit 发出的命令相同（之后在底部条上换了也不跟着变）。省略时用 layers 重算（只看笔画、不看选项的画笔）
  ghostAt?: (s: Stroke, shift: boolean) => (w: World) => GhostEdit | null;
  commit: (w: World, s: Stroke, shift: boolean) => Promise<unknown>;
  // 画笔圈画在半径的几倍处：最后一个是主圈（悬停时虚线、按住时实线），前面的是细实线。省略时只在半径处画一圈
  rings?: number[];
  // 确切预览：松手时会执行的命令（commit 执行的就是它）。有这一项的画笔，按住停顿 250 毫秒时在世界的副本上
  // 算一遍，地图画出将来的世界、变了的格描边；拖底部条的滑块时在鼠标最后停的地方确切地预览涂一下
  exact?: (w: World, s: Stroke, shift: boolean) => Command | null;
  // 确切的结果到了以后鼠标旁的那句话（如“森林 · 38 格会变 · 6 格没涂成”）
  exactHint?: (w: World, s: Stroke, shift: boolean, r: PreviewResult) => string;
  // 画笔圈外再画一道淡淡的虚线圈：周围跟着变的范围（自然融入的过渡，地图单位）；null 不画
  reach?: (w: World) => number | null;
  // 工具选中时一直画着的东西（橡皮擦：能擦的格）
  backdrop?: (w: World) => Backdrop | null;
  // 空闲悬停时鼠标旁的一句话：画笔圈住的格里有什么（橡皮擦：“这里：画过陆地、堆过山”）。p：鼠标
  here?: (w: World, cells: number[], p: Pointer) => string | null;
}

export type BrushLayers = { layers: HighlightLayer[]; hint?: string; warn?: boolean; caution?: boolean; provinces?: ProvincePreview | null; ghost?: GhostEdit | null };

// 一笔涂多重的预览深浅：变化量占滑块最大值的比例，最淡也有 0.35（力度很小时也看得见涂到了哪里）
export const strengthValues = (deltas: number[], max: number) => deltas.map((d) => 0.35 + 0.65 * Math.min(1, Math.abs(d) / max));

// 选项的编号：确切预览的 key 用它（换了生态、力度、过渡，就不是同一个预览）
const optionIds = new WeakMap<ToolOptions, number>();
let nextOptionId = 1;
export const optionsId = () => {
  let id = optionIds.get(options.value);
  if (!id) optionIds.set(options.value, (id = nextOptionId++));
  return id;
};

// 确切预览的说法：几格会变、这一笔里几格没涂成
export function exactCounts(r: PreviewResult, cells: Iterable<number>): { changed: number; failing: number } {
  const mine = new Set(cells);
  return { changed: r.changedCells.length, failing: r.failing.filter((c) => mine.has(c)).length };
}

// 画笔可以排队：前面的笔画还在算时照样能画，松手后按顺序执行，各自是一步（结果与一笔一笔等着画相同）。
// 排队中的笔画一直显示松手时的预览（高亮、省界、幽灵海岸，见 pending.ts），直到结果换上（不先跳回原样，也不变成白色的“等待”）。
// 有确切预览的画笔（cfg.exact）：按住停顿时地图画出将来的世界；之后接着画也不跳回原样（一直显示上一个确切预览，
// 新涂的格淡淡地涂上估计的颜色），直到新的确切预览换上。松手执行的是同一条命令，Worker 直接采用算好的结果
export function brushTool(cfg: BrushConfig): ToolHandler {
  let stroke: Stroke | null = null;
  let pointer: Pointer | null = null;
  // 鼠标在不在地图上：离开后只留排队中的笔画（拖滑块时照样在最后停的地方预览）
  let inside = false;
  // 本工具排队中的笔画（画在地图上的是 pending.ts 里的那一份）：有确切预览的带着它（key：松手时这一笔的确切预览的 key）
  type Queued = { s: Stroke; shift: boolean; key: string; view: ExactView | null };
  let queued: Queued[] = [];
  const ex = new Exact();
  // 每个确切预览算的时候这一笔已经涂到了哪些格：之后新涂的格另外淡淡地涂上估计的颜色
  const covered = new Covered();
  const filterOf = (w: World) => cfg.filter && ((i: number) => cfg.filter!(w, i));
  // 不带世界：这一笔的格松手前不再变，命令也就不变；排在前面的笔画算完、世界换了，按新世界算的预览照样是它的结果
  const keyOf = (s: Stroke, shift: boolean) => `${s.id}|${s.rev}|${shift}|${optionsId()}`;
  const wantExact = (s: Stroke, shift: boolean, pause?: number) => {
    const key = keyOf(s, shift);
    ex.want(
      key,
      () => {
        // 停顿期间又涂了几格（还没来得及重画）：等下一次
        const w = world.value;
        if (!w || keyOf(s, shift) !== key || !s.t.size) return null;
        const cmd = cfg.exact!(w, s, shift);
        if (cmd) covered.note(key, s.t.keys());
        return cmd;
      },
      pause,
    );
    return key;
  };
  // 确切预览到了：变了的格描边，之后新涂的格淡淡地涂上估计的颜色。按预览与这一笔缓存
  const exactCache = new WeakMap<Stroke, { v: ExactView; rev: number; o: ToolOptions; layers: HighlightLayer[] }>();
  const exactLayers = (v: ExactView, s: Stroke, est: HighlightLayer[]): HighlightLayer[] => {
    const c = exactCache.get(s);
    if (c?.v === v && c.rev === s.rev && c.o === options.value) return c.layers;
    const layers = covered.layers(v, est);
    exactCache.set(s, { v, rev: s.rev, o: options.value, layers });
    return layers;
  };
  // 排队中的笔画能显示的确切预览：松手后才算好的（还在 ex 里）优先；世界换了就没有
  const viewOf = (q: Queued, now: World): ExactView | null => {
    const v = ex.view?.key === q.key ? ex.view : q.view;
    return v && v.base === now ? v : null;
  };
  // 新的一笔、换工具之前：松手后才算好的确切预览交给它的排队项（ex 马上要清掉）
  const handOver = () => {
    for (const q of queued) if (ex.view?.key === q.key) q.view = ex.view;
  };
  // 排队中的一笔现在画成什么样（地图每帧问一次，见 pending.ts）：世界换了（排在前面的编辑算完换上了）就按新世界
  // 重算它的幽灵海岸，排在最前的那一笔的增量因此与执行时相同；松手后才算好的确切预览到了，画出将来的世界、
  // 变了的格描边。输入没变就给同一个对象（地图不必重新上传）
  const liveOf = (q: Queued, at: Preview, w0: World, ghostAt: (w: World) => GhostEdit | null) => {
    let memo: { w: World; v: ExactView | null; out: Preview } | null = null;
    let ghost: { w: World; g: GhostEdit | null } = { w: w0, g: at.ghost ?? null };
    return (now: World): Preview => {
      const v = viewOf(q, now);
      if (memo?.w === now && memo.v === v) return memo.out;
      if (at.ghost && ghost.w !== now) ghost = { w: now, g: ghostAt(now) };
      let out: Preview = ghost.g === at.ghost ? at : { ...at, ghost: ghost.g };
      if (v) out = { ...out, layers: exactLayers(v, q.s, at.layers), world: v.world };
      memo = { w: now, v, out };
      return out;
    };
  };
  // 空闲悬停只显示圈，不显示涂了会怎样。只有很小的画笔（半径不到 2 格，圈里看不出会碰到哪几格）
  // 另外描出一笔会涂到的格（只描边、不填色）；格没变就沿用同一个图层，不必重新上传
  let foot: { cells: number[]; layer: HighlightLayer } | null = null;
  const footprint = (w: World, p: Pointer): HighlightLayer[] => {
    const km = options.value.brushKm;
    if (brushR(w, km) > w.mesh.spacing * 2 || p.cell < 0) return [];
    const cells = brushCells(w, p.x, p.y, km).cells.filter((i) => !cfg.filter || cfg.filter(w, i));
    if (!foot || foot.cells.length !== cells.length || foot.cells.some((c, k) => c !== cells[k])) foot = { cells, layer: { cells, color: WHITE, pattern: 'outline' } };
    return [foot.layer];
  };
  // 拖底部条上的滑块（半径、力度、过渡……）时：在鼠标最后停的地方预览涂一下会怎样，大小、深浅跟着滑块变，
  // 旁边写出这一下的变化量（如“堆山 约 +600 m”）
  let dab: { w: World; o: ToolOptions; p: Pointer; s: Stroke; layers: HighlightLayer[]; hint: string | null; warn?: boolean; ghost: GhostEdit | null } | null = null;
  const dabAt = (w: World, p: Pointer) => {
    if (dab?.w !== w || dab.o !== options.value || dab.p !== p) {
      const s = new Stroke();
      if (p.cell >= 0) s.add(w, p.x, p.y, options.value.brushKm, filterOf(w));
      // 特别大的画笔（两万格以上）不预览，免得拖滑块卡顿
      const r = s.t.size && s.t.size <= 20000 ? cfg.layers(w, s, p.shift) : null;
      dab = { w, o: options.value, p, s, layers: r?.layers ?? [], hint: r?.hint ?? null, warn: r?.warn, ghost: r?.ghost ?? null };
    }
    return dab;
  };
  // 空闲悬停时画笔圈住的格（橡皮擦说这里改过什么）：鼠标、世界、半径没变就沿用
  let hereMemo: { w: World; p: Pointer; km: number; text: string | null } | null = null;
  const hereAt = (w: World, p: Pointer): string | null => {
    if (!cfg.here || p.cell < 0) return null;
    const km = options.value.brushKm;
    if (hereMemo?.w !== w || hereMemo.p !== p || hereMemo.km !== km) {
      // 很大的画笔只看鼠标下面那一格（每次移动都搜整个画笔圈太费：最大的画笔有几万格）
      const big = brushR(w, km) > 60 * w.mesh.spacing;
      const cells = big ? [p.cell] : brushCells(w, p.x, p.y, km).cells;
      hereMemo = { w, p, km, text: cfg.here(w, cells, p) };
    }
    return hereMemo.text;
  };
  const ringsAt = (w: World, p: Pointer): Shape[] => {
    const r = brushR(w, options.value.brushKm);
    const ks = cfg.rings ?? [1];
    const shapes = ks.map((k, j): Shape =>
      j === ks.length - 1
        ? { kind: 'circle', x: p.x, y: p.y, r: r * k, dashed: !stroke, geodesic: true }
        : { kind: 'circle', x: p.x, y: p.y, r: r * k, color: 'rgba(255, 255, 255, 0.6)', width: 1, geodesic: true },
    );
    const reach = cfg.reach?.(w);
    if (reach) shapes.unshift({ kind: 'circle', x: p.x, y: p.y, r: r + reach, dashed: true, color: 'rgba(255, 255, 255, 0.35)', width: 1, geodesic: true });
    return shapes;
  };
  return {
    drags: true,
    down(p) {
      const w = world.value;
      inside = true;
      if (!w || p.cell < 0 || stroke) return;
      // 正在新建、打开、导出时不能画（世界可能马上换掉）；只是在算前面的编辑时可以排队
      if (guard('queue')) return;
      const h = cfg.hint(p.shift);
      if (h.warn) {
        showToast(h.text ?? '现在不能用', true);
        return;
      }
      // 新的一笔：上一笔松手后才算好的确切预览交给它的排队项，拖滑块时预览的那一下不要了
      handOver();
      ex.clear();
      // 排队中的笔画用得到的留着：已经交过去的，和松手时还在算、回来才交过去的（见 up）
      covered.keep(new Set(queued.flatMap((q) => [q.key, q.view?.key])));
      stroke = new Stroke();
      stroke.add(w, p.x, p.y, options.value.brushKm, filterOf(w));
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      inside = true;
      const w = world.value;
      if (pressed && stroke && w) stroke.add(w, p.x, p.y, options.value.brushKm, filterOf(w));
    },
    async up(p) {
      const w = world.value;
      const s = stroke;
      stroke = null;
      if (!w || !s || !s.t.size) {
        ex.clear();
        return;
      }
      // 不再算新的确切预览（已经发出去的照算：它就是这一笔的结果，执行时直接采用）
      const key = cfg.exact ? keyOf(s, p.shift) : '';
      ex.stop();
      // 松手时的预览（高亮、省界、幽灵海岸）留在图上，直到这一笔的结果换上；之后算好的确切预览也画在它上面
      const r = cfg.layers(w, s, p.shift);
      const q: Queued = { s, shift: p.shift, key, view: ex.view };
      const at: Preview = { layers: r.layers, shapes: [], hint: null, provinces: r.provinces ?? null, ghost: r.ghost ?? null };
      // 松手时还在算的就是这一笔的确切预览：回来时直接交给它。接着画下一笔、换了工具（ex 清掉了）也不丢，
      // 回来就画出将来的世界，不等到结果换上时才跳过去
      void (key ? ex.late(key) : null)?.then((v) => {
        if (!v) return;
        q.view = v;
        redrawTick.value++;
      });
      const ghostAt = cfg.ghostAt?.(s, p.shift) ?? ((now: World) => cfg.layers(now, s, p.shift).ghost ?? null);
      queued.push(q);
      try {
        await trackEdit(at, cfg.commit(w, s, p.shift), liveOf(q, at, w, ghostAt));
      } finally {
        queued = queued.filter((x) => x !== q);
      }
    },
    cancel() {
      stroke = null;
      handOver();
      ex.clear();
    },
    leave() {
      inside = false;
    },
    backdrop() {
      const w = world.value;
      return w && cfg.backdrop ? cfg.backdrop(w) : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      // 排队时（前面的编辑还没算完）：排队中的笔画由地图照旧画出松手时的预览（见 pending.ts），鼠标旁说一声
      const inLine = queuedCount() ? `正在计算…（${queuedCount()} 步）` : null;
      if (!stroke) {
        // 松开了滑块：不再预览涂一下（空闲悬停只有圈）
        if (!sliderActive.value) ex.stop();
        if (!inside && !sliderActive.value) return EMPTY;
        const h = cfg.hint(pointer.shift);
        if (sliderActive.value && !h.warn) {
          const d = dabAt(w, pointer);
          // 拖滑块：在这里确切地涂一下会怎样（只在拖滑块、没有排队时；空闲悬停只有圈）
          if (cfg.exact && d.s.t.size && d.s.t.size <= 20000 && !queuedCount()) {
            const key = wantExact(d.s, pointer.shift, 200);
            const v = ex.view?.key === key ? ex.view : null;
            if (v) return { layers: exactLayers(v, d.s, d.layers), shapes: ringsAt(w, pointer), hint: '在这里涂会这样', sliderHint: true, world: v.world };
          }
          return { layers: d.layers, shapes: ringsAt(w, pointer), hint: inLine ?? d.hint, warn: d.warn, sliderHint: true, ghost: d.ghost };
        }
        return { layers: h.warn ? [] : footprint(w, pointer), shapes: ringsAt(w, pointer), hint: h.warn ? h.text : (inLine ?? hereAt(w, pointer) ?? h.text), warn: h.warn };
      }
      const r = cfg.layers(w, stroke, pointer.shift);
      // 做不了、要留意的话比排队要紧
      const head = r.warn || r.caution ? null : queueHint();
      const own = { shapes: ringsAt(w, pointer), warn: r.warn, caution: r.caution, provinces: r.provinces ?? null, ghost: r.ghost ?? null };
      if (cfg.exact) {
        // 按住停顿 250 毫秒：确切预览；接着画时一直显示上一个，直到新的换上（不跳回原样）
        const key = wantExact(stroke, pointer.shift);
        const v = ex.view;
        // 太慢不再自动预览：说松手后大约几秒（留着的上一个确切预览不会再被换掉，不写“…”）
        const slow = slowTail(ex.slow);
        if (v) {
          const s = stroke;
          const hint = v.key === key && cfg.exactHint ? cfg.exactHint(w, s, pointer.shift, v.result) : `${r.hint ?? ''}${slow || '…'}`;
          return { ...own, layers: exactLayers(v, s, r.layers), hint: head ?? hint, world: v.world };
        }
        return { ...own, layers: r.layers, hint: head ?? `${r.hint ?? ''}${slow}` };
      }
      return { ...own, layers: r.layers, hint: head ?? r.hint ?? null };
    },
  };
}

// 只有一个图层的背景：同一个图层给同一个对象
const oneBacks = new WeakMap<HighlightLayer, Backdrop>();
export function oneLayer(layer: HighlightLayer | null): Backdrop | null {
  if (!layer) return null;
  let b = oneBacks.get(layer);
  if (!b) oneBacks.set(layer, (b = { layers: [layer], shapes: [] }));
  return b;
}
