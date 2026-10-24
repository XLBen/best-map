import type { Command } from '../../../core/commands';
import { hexToRgb } from '../../../core/export';
import { type Culture, type PopValue, cultureById, cultureGroupById, dimensionValues, groupInfo, readComp, typicalTuple, valueLayer, worldCultures, worldDimensions } from '../../../core/human';
import type { PopTuple, World } from '../../../core/world';
import { popText } from '../human';
import { exec, options, setOptions, world } from '../../state';
import { type Pointer, type RGB, type ToolHandler, BLOCKED_RGB, EMPTY, WHITE, guard, mapDist } from './api';
import { type Stroke, brushTool } from './brush';
import { dryLand } from './human';

// “文化”一类的工具（第二十二轮）：文化笔刷（paint_culture）、人口笔刷（paint_pop：改成分、改人数、改一个维度）、发源地（move_hearth）。
// 只涂干的陆地；没有人的格只有“改人数”加人时会变

// 生成过人文
export const hasHuman = (w: World) => !!w.small.human && !!w.causes.popTotal;
export const NO_HUMAN = '先生成人文';

const people = (w: World, i: number) => w.causes.popTotal?.[i] ?? 0;

// 笔画的权重（中心 1、边缘 0），取三位小数
const weightsOf = (s: Stroke) => s.weights().map((x) => Math.round(x * 1000) / 1000);

// ---------- 选着的 ----------

// 文化笔刷的文化：选着的那个，没选、停用了时是世界里的第一个
export function chosenCulture(w: World): Culture | undefined {
  return (options.value.culture ? cultureById(w.small, options.value.culture) : undefined) ?? worldCultures(w.small)[0];
}

// 改成分的群体：选着的那个（文化、取值都在世界里），否则第一个文化最典型的群体
export function chosenTuple(w: World): PopTuple | undefined {
  const t = options.value.popTuple;
  if (t && cultureById(w.small, t.culture)) {
    const dims = worldDimensions(w.small);
    const values = Object.fromEntries(dims.flatMap((d) => (t.values[d.id] && dimensionValues(w.small, d.id).some((v) => v.id === t.values[d.id]) ? [[d.id, t.values[d.id]]] : [])));
    return { culture: t.culture, values };
  }
  const c = worldCultures(w.small)[0];
  return c ? typicalTuple(w, c.id) : undefined;
}

// 改一个维度：选着的维度（没有时第一维）与取值（没有时这一维第一个）
export function chosenValue(w: World): { dim: { id: string; label: string }; value: PopValue } | undefined {
  const dims = worldDimensions(w.small);
  const dim = dims.find((d) => d.id === options.value.popDim) ?? dims[0];
  if (!dim) return undefined;
  const list = dimensionValues(w.small, dim.id);
  const value = list.find((v) => v.id === options.value.popValue) ?? list[0];
  return value ? { dim, value } : undefined;
}

// 改人数的倍数（Shift 反过来）
export const factorOf = (shift: boolean) => (shift ? 1 / options.value.popFactor : options.value.popFactor);
export const factorText = (f: number) => `×${Math.round(f * 100) / 100}`;

// ---------- 命令 ----------

export function cultureCommand(cells: number[], t: number[], culture: string, amount: number, typical: boolean): Command {
  return { op: 'paint_culture', cells, t, culture, amount, ...(typical ? { typical: true } : {}) };
}

// 人口笔刷这一笔的命令（按底部条的模式）；选的东西世界里没有时 null
export function popCommand(w: World, cells: number[], t: number[], shift: boolean): Command | null {
  const o = options.value;
  if (o.popMode === 'count') return { op: 'paint_pop', cells, t, mode: 'count', factor: Math.min(100, Math.max(0.01, factorOf(shift))) };
  if (o.popMode === 'share') {
    const g = chosenTuple(w);
    return g ? { op: 'paint_pop', cells, t, mode: 'share', group: g, amount: o.popAmount } : null;
  }
  const v = chosenValue(w);
  return v ? { op: 'paint_pop', cells, t, mode: 'value', dimension: v.dim.id, value: v.value.id, amount: o.popAmount } : null;
}

// 这一笔说的是什么（预览旁的一句话）
function popLabel(w: World, shift: boolean): string {
  const o = options.value;
  if (o.popMode === 'count') return `人数 ${factorText(factorOf(shift))}`;
  if (o.popMode === 'share') {
    const g = chosenTuple(w);
    return g ? `人口“${groupInfo(w, 0, g).label}”` : '';
  }
  const v = chosenValue(w);
  return v ? `${v.dim.label}改为“${v.value.name}”` : '';
}

function popColor(w: World, shift: boolean): RGB {
  const o = options.value;
  if (o.popMode === 'count') return shift ? [120, 160, 230] : [240, 190, 90];
  if (o.popMode === 'share') {
    const g = chosenTuple(w);
    const c = g ? cultureById(w.small, g.culture) : undefined;
    return c ? hexToRgb(c.color) : WHITE;
  }
  const v = chosenValue(w);
  return v ? hexToRgb(v.value.color) : WHITE;
}

// 鼠标下这一格：最多的人、人数
export function popHere(w: World, cell: number): string | null {
  if (cell < 0 || !dryLand(w, cell) || !hasHuman(w)) return null;
  const n = people(w, cell);
  if (!(n > 0)) return '这里：无人';
  const top = readComp(w.causes, cell).find((x) => x.code);
  return `这里：${top ? `${groupInfo(w, top.code).label} · ` : ''}${popText(n)} 人`;
}

// ---------- 两支画笔 ----------

function humanBrush(which: 'culture' | 'pop'): ToolHandler {
  const label = (w: World, shift: boolean) => {
    if (which === 'pop') return popLabel(w, shift);
    const c = chosenCulture(w);
    return c ? `文化“${c.name}”` : '';
  };
  const command = (w: World, s: Stroke, shift: boolean): Command | null => {
    if (!hasHuman(w) || !s.t.size) return null;
    if (which === 'pop') return popCommand(w, s.cells, weightsOf(s), shift);
    const c = chosenCulture(w);
    return c ? cultureCommand(s.cells, weightsOf(s), c.id, options.value.cultureAmount, options.value.cultureMode === 'typical') : null;
  };
  // 这一笔里会变的格：有人的（改人数加人时没人的格也算）
  const reach = (w: World, s: Stroke, shift: boolean) => {
    const grow = which === 'pop' && options.value.popMode === 'count' && factorOf(shift) > 1;
    return grow ? s.t.size : s.cells.filter((i) => people(w, i) > 0).length;
  };
  return brushTool({
    hint: () => {
      const w = world.value;
      if (w && !hasHuman(w)) return { text: NO_HUMAN, warn: true };
      return w && !label(w, false) ? { text: '先选一种', warn: true } : { text: null };
    },
    filter: dryLand,
    here: (w, _cells, p) => popHere(w, p.cell),
    layers(w, s, shift) {
      if (!hasHuman(w)) return { layers: [{ cells: s.cells, color: BLOCKED_RGB, alpha: 0.5 }], hint: NO_HUMAN, warn: true };
      const text = label(w, shift);
      if (!text) return { layers: [], hint: '先选一种', warn: true };
      const k = reach(w, s, shift);
      const color = which === 'pop' ? popColor(w, shift) : hexToRgb(chosenCulture(w)!.color);
      return {
        layers: [{ cells: s.cells, values: s.weights().map((x) => 0.35 + 0.65 * x), color, alpha: 0.75 }],
        hint: k ? `${text} · ${k} 格` : s.t.size ? '这里没有人' : '这里没有陆地',
        warn: !k,
      };
    },
    exact: (w, s, shift) => command(w, s, shift),
    exactHint: (w, s, shift) => `${label(w, shift)} · ${reach(w, s, shift)} 格`,
    async commit(w, s, shift) {
      const cmd = command(w, s, shift);
      if (!cmd || !reach(w, s, shift)) return;
      await exec(cmd, '正在计算…');
    },
  });
}

export const cultureTool = (): ToolHandler => humanBrush('culture');
export const popTool = (): ToolHandler => humanBrush('pop');

// Alt+点：文化笔刷吸这一格占多数的文化；人口笔刷吸这里最多的群体（改一个维度时吸这一维的取值）
export function pickCulture(w: World, cell: number): string | null {
  const code = w.derived.popCulture?.[cell] ?? 0;
  const c = code ? worldCultures(w.small)[code - 1] : undefined;
  if (!c || !dryLand(w, cell)) return null;
  setOptions({ culture: c.id });
  return c.name;
}

export function pickPop(w: World, cell: number): string | null {
  if (!dryLand(w, cell) || !(people(w, cell) > 0)) return null;
  if (options.value.popMode === 'value') {
    const dims = worldDimensions(w.small);
    const k = Math.max(0, dims.findIndex((d) => d.id === options.value.popDim));
    const code = valueLayer(w, k)?.[cell] ?? 0;
    const v = code && dims[k] ? dimensionValues(w.small, dims[k].id)[code - 1] : undefined;
    if (!v) return null;
    setOptions({ popDim: dims[k].id, popValue: v.id });
    return v.name;
  }
  const top = readComp(w.causes, cell).find((x) => x.code);
  const t = top ? w.small.popGroups?.[top.code] : undefined;
  if (!t) return null;
  setOptions({ popTuple: { culture: t.culture, values: { ...t.values } } });
  return groupInfo(w, top!.code).label;
}

// ---------- 发源地 ----------

export interface HearthMark {
  // 列表里唯一的键：组 id（第几个）或文化 id
  key: string;
  group: string;
  culture?: string;
  // 同一组的第几个（文化的发源地为 0）
  index: number;
  cell: number;
  name: string;
  color: string;
  locked: boolean;
}

// 世界里全部的发源地（文化组的、组里文化的）
export function hearthMarks(w: World): HearthMark[] {
  const h = w.small.human;
  if (!h) return [];
  const seen = new Map<string, number>();
  return h.hearths.map((x) => {
    const k = x.culture ? 0 : (seen.get(x.group) ?? 0);
    if (!x.culture) seen.set(x.group, k + 1);
    const item = x.culture ? cultureById(w.small, x.culture) : cultureGroupById(w.small, x.group);
    return {
      key: x.culture ? `c:${x.culture}` : `g:${x.group}:${k}`,
      group: x.group,
      ...(x.culture ? { culture: x.culture } : {}),
      index: k,
      cell: x.cell,
      name: item?.name ?? x.culture ?? x.group,
      color: item?.color ?? '#999999',
      locked: !!x.locked,
    };
  });
}

// 挪一个发源地（cell 为 null 是恢复自动）
export function hearthCommand(m: Pick<HearthMark, 'group' | 'culture' | 'index'>, cell: number | null): Command {
  return m.culture ? { op: 'move_hearth', culture: m.culture, cell } : { op: 'move_hearth', group: m.group, ...(m.index ? { index: m.index } : {}), cell };
}

// 文化组的发源地画大圈，组里文化的画小圈；锁定的外面多一道白圈
const R_GROUP = 9;
const R_CULTURE = 6;
const HIT = 12;

// 鼠标下的发源地（屏幕上 HIT 像素以内最近的一个）
export function hearthAt(w: World, marks: readonly HearthMark[], p: Pick<Pointer, 'x' | 'y'>, zoom: number): HearthMark | null {
  let best: HearthMark | null = null;
  let bd = HIT / zoom;
  for (const m of marks) {
    const d = mapDist(w, p.x, p.y, w.mesh.x[m.cell], w.mesh.y[m.cell]);
    if (d <= bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

export function hearthShapes(w: World, marks: readonly HearthMark[], zoom: number, focus: string | null) {
  return marks.flatMap((m) => {
    const x = w.mesh.x[m.cell];
    const y = w.mesh.y[m.cell];
    const r = (m.culture ? R_CULTURE : R_GROUP) / zoom;
    const on = focus === m.key;
    return [
      { kind: 'circle' as const, x, y, r, color: m.color, fill: true, width: 1 },
      { kind: 'circle' as const, x, y, r, color: on ? 'rgba(255, 225, 77, 0.95)' : 'rgba(20, 20, 24, 0.85)', width: on ? 2.5 : 1.5 },
      ...(m.locked ? [{ kind: 'circle' as const, x, y, r: r + 3.5 / zoom, color: 'rgba(255, 255, 255, 0.95)', width: 1.5 }] : []),
    ];
  });
}

// 发源地工具：圈出全部发源地；拖一个到别的陆地上（挪过的锁定），之后重新生成。
// 停在一个上时说是谁的、锁定没有；Shift+点一个锁定的：恢复自动
export function hearthTool(zoom: () => number): ToolHandler {
  let hover: HearthMark | null = null;
  let drag: HearthMark | null = null;
  let at: Pointer | null = null;
  let cache: { w: World; marks: HearthMark[] } | null = null;
  const marks = (w: World) => {
    if (cache?.w !== w) cache = { w, marks: hearthMarks(w) };
    return cache.marks;
  };
  const describe = (m: HearthMark) => `发源地“${m.name}”${m.locked ? ' · 锁定' : ''}`;
  const target = (w: World, p: Pointer) => p.cell >= 0 && w.causes.land[p.cell] === 1;
  return {
    // 停在发源地上时按住是拖它；别处按住拖动照常平移地图
    get drags() {
      return hover !== null;
    },
    move(p) {
      at = p;
      const w = world.value;
      if (!w || drag) return;
      hover = hearthAt(w, marks(w), p, zoom());
    },
    down(p) {
      const w = world.value;
      if (!w || !hover || guard('refuse')) return;
      if (p.shift) return;
      drag = hover;
      at = p;
    },
    async up(p) {
      const w = world.value;
      const m = drag;
      drag = null;
      if (!w || !m) {
        // Shift+点：锁定的恢复自动
        if (w && hover && p.shift && hover.locked && !guard('refuse')) await exec(hearthCommand(hover, null), '正在生成…');
        return;
      }
      if (!target(w, p) || p.cell === m.cell) return;
      await exec(hearthCommand(m, p.cell), '正在生成…');
    },
    cancel() {
      drag = null;
    },
    leave() {
      at = null;
      if (!drag) hover = null;
    },
    backdrop() {
      const w = world.value;
      if (!w) return null;
      return { layers: [], shapes: hearthShapes(w, marks(w), zoom(), (drag ?? hover)?.key ?? null) };
    },
    preview() {
      const w = world.value;
      if (!w) return EMPTY;
      if (!hasHuman(w)) return { ...EMPTY, hint: NO_HUMAN, warn: true };
      if (drag && at) {
        const ok = target(w, at);
        const z = zoom();
        const from: [number, number] = [w.mesh.x[drag.cell], w.mesh.y[drag.cell]];
        return {
          layers: [],
          shapes: [
            { kind: 'line', points: [from, [at.x, at.y]], color: 'rgba(255, 255, 255, 0.8)', width: 1.5, dashed: true },
            { kind: 'circle', x: at.x, y: at.y, r: (drag.culture ? R_CULTURE : R_GROUP) / z, color: drag.color, fill: true },
          ],
          hint: ok ? `挪动发源地“${drag.name}”` : '发源地要在陆地上',
          warn: !ok,
        };
      }
      if (hover) return { ...EMPTY, hint: hover.locked ? `${describe(hover)} · Shift+点击恢复自动` : describe(hover) };
      return EMPTY;
    },
  };
}
