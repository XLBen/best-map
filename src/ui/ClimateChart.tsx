import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { TERRAIN_COLORS } from '../../core/export';
import {
  BUILTIN_FIELDS,
  CONDITIONS,
  type ConditionId,
  M_RANGE,
  type Rect,
  type Species,
  T_RANGE,
  type Tolerance,
  advancedTolerances,
  speciesConditions,
  speciesRect,
  withCondition,
  withRect,
} from '../../core/species';
import { isVegetated } from '../../core/vegetation';
import type { World } from '../../core/world';
import type { Command } from '../../core/commands';
import { adjustPreviewNote, confirmImport, download, exec, execAdjust, focusSpecies, hoverCell, options, previewAdjust, showToast, tool, world } from '../state';
import { paintWith } from './defs/tools';
import { readPack } from '../../core/packs';
import { FANTASY_PACK } from '../../core/packs/fantasy';
import { fileLabel, openPackApply, openPackImport } from './packs/store';
import { SpeciesAdvanced } from './SpeciesAdvanced';

// 生态类型编辑器：横轴年均温、纵轴“干 ←→ 湿”的气候图。每种生态是一个可拖动、拉伸的色块，
// 底图是世界上所有陆地格的分布。色块重叠的地方由“强势程度”决定谁占上风。
// 拖色块时手停一下，地图上就是松手后的样子（在世界的副本上算好，松手时直接采用）

const W = 340;
const H = 250;
const PAD = { l: 30, r: 8, t: 8, b: 28 };
const T_MIN = T_RANGE[0];
const T_MAX = T_RANGE[1];
const M_MIN = 0.03;
const M_MAX = 8;
const LM0 = Math.log(M_MIN);
const LM1 = Math.log(M_MAX);
const PW = W - PAD.l - PAD.r;
const PH = H - PAD.t - PAD.b;

const xOf = (t: number) => PAD.l + ((Math.max(T_MIN, Math.min(T_MAX, t)) - T_MIN) / (T_MAX - T_MIN)) * PW;
const tOf = (px: number) => T_MIN + ((px - PAD.l) / PW) * (T_MAX - T_MIN);
const yOf = (m: number) => PAD.t + (1 - (Math.log(Math.max(M_MIN, Math.min(M_MAX, m))) - LM0) / (LM1 - LM0)) * PH;
const mOf = (py: number) => Math.exp(LM0 + (1 - (py - PAD.t) / PH) * (LM1 - LM0));

// 色块在图上的像素范围；碰到图边表示“不限”
function rectPx(r: Rect) {
  return {
    x0: r.t0 <= T_RANGE[0] ? xOf(T_MIN) : xOf(r.t0),
    x1: r.t1 >= T_RANGE[1] ? xOf(T_MAX) : xOf(r.t1),
    y0: r.m1 >= M_RANGE[1] ? yOf(M_MAX) : yOf(r.m1),
    y1: r.m0 <= M_RANGE[0] ? yOf(M_MIN) : yOf(r.m0),
  };
}

const SNAP = 5;
function rectFromPx(x0: number, x1: number, y0: number, y1: number): Rect {
  const round = (v: number, k: number) => Math.round(v * k) / k;
  const t0 = x0 <= PAD.l + SNAP ? T_RANGE[0] : round(tOf(x0), 2);
  const t1 = x1 >= W - PAD.r - SNAP ? T_RANGE[1] : round(tOf(x1), 2);
  const m1 = y0 <= PAD.t + SNAP ? M_RANGE[1] : round(mOf(y0), 100);
  const m0 = y1 >= H - PAD.b - SNAP ? M_RANGE[0] : round(mOf(y1), 100);
  return { t0: Math.min(t0, t1 - 0.5), t1, m0: Math.min(m0, m1 * 0.95), m1 };
}

const fmtT = (t: number, edge: number) => (t === edge ? '不限' : `${Math.round(t)} °C`);
const fmtM = (m: number, edge: number) => (m === edge ? '不限' : m.toFixed(2));
// 占比：有但不到 1% 时写“<1%”，不写成看起来像没长出来的 0%
const fmtShare = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

// 世界上陆地格在图上的分布（底图），按世界缓存
const densityCache = new WeakMap<World, ImageData>();
function densityImage(w: World): ImageData {
  let img = densityCache.get(w);
  if (img) return img;
  const counts = new Float32Array(W * H);
  let max = 0;
  const d = w.derived;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!isVegetated(w, d, i)) continue;
    const px = Math.round(xOf(d.tMean[i]));
    const py = Math.round(yOf(d.moisture[i]));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = (py + dy) * W + px + dx;
        if (k < 0 || k >= counts.length) continue;
        counts[k] += dx === 0 && dy === 0 ? 1 : 0.4;
        max = Math.max(max, counts[k]);
      }
    }
  }
  img = new ImageData(W, H);
  for (let k = 0; k < counts.length; k++) {
    if (!counts[k]) continue;
    img.data[k * 4] = 230;
    img.data[k * 4 + 1] = 230;
    img.data[k * 4 + 2] = 230;
    img.data[k * 4 + 3] = Math.round(200 * Math.sqrt(counts[k] / max));
  }
  densityCache.set(w, img);
  return img;
}

type Drag = { id: string; mode: 'move' | 'resize'; edges: { l: boolean; r: boolean; t: boolean; b: boolean }; startX: number; startY: number; px: { x0: number; x1: number; y0: number; y1: number } };

function Chart({ w, selected, onSelect }: { w: World; selected: Species | null; onSelect: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draftRect, setDraftRect] = useState<{ id: string; rect: Rect } | null>(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (c) c.getContext('2d')!.putImageData(densityImage(w), 0, 0);
  }, [w]);
  useEffect(() => setDraftRect(null), [w]);

  const local = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H] as const;
  };
  const rectOf = (sp: Species) => (draftRect?.id === sp.id ? draftRect.rect : speciesRect(sp));
  // 松手时执行的命令（拖动中预览的也是它）
  const commandFor = (id: string, rect: Rect): Command | null => {
    const sp = w.small.species.find((s) => s.id === id);
    return sp ? { op: 'update_species', id: sp.id, patch: { tolerances: withRect(sp, rect).tolerances } } : null;
  };

  const onDown = (e: PointerEvent, sp: Species) => {
    e.stopPropagation();
    const [x, y] = local(e);
    if (selected?.id !== sp.id) onSelect(sp.id);
    const px = rectPx(rectOf(sp));
    const near = (a: number, b: number) => Math.abs(a - b) < 6;
    const edges = { l: near(x, px.x0), r: near(x, px.x1), t: near(y, px.y0), b: near(y, px.y1) };
    const resize = edges.l || edges.r || edges.t || edges.b;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id: sp.id, mode: resize ? 'resize' : 'move', edges, startX: x, startY: y, px });
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const [x, y] = local(e);
    const dx = x - drag.startX;
    const dy = y - drag.startY;
    let { x0, x1, y0, y1 } = drag.px;
    if (drag.mode === 'move') {
      const sx = Math.max(PAD.l - x0, Math.min(W - PAD.r - x1, dx));
      const sy = Math.max(PAD.t - y0, Math.min(H - PAD.b - y1, dy));
      x0 += sx;
      x1 += sx;
      y0 += sy;
      y1 += sy;
    } else {
      if (drag.edges.l) x0 = Math.max(PAD.l, Math.min(x1 - 4, x0 + dx));
      if (drag.edges.r) x1 = Math.min(W - PAD.r, Math.max(x0 + 4, x1 + dx));
      if (drag.edges.t) y0 = Math.max(PAD.t, Math.min(y1 - 4, y0 + dy));
      if (drag.edges.b) y1 = Math.min(H - PAD.b, Math.max(y0 + 4, y1 + dy));
    }
    const rect = rectFromPx(x0, x1, y0, y1);
    setDraftRect({ id: drag.id, rect });
    // 手停下 200 毫秒：地图上画出松手后的世界
    previewAdjust(commandFor(drag.id, rect));
  };
  const onUp = () => {
    const d = drag;
    setDrag(null);
    if (!d || !draftRect || draftRect.id !== d.id) {
      if (d) previewAdjust(null);
      return;
    }
    const cmd = commandFor(d.id, draftRect.rect);
    // 预览过的就是它：结果直接采用，预览的世界留到结果换上
    if (cmd) void execAdjust(cmd, '正在计算生态…');
    else previewAdjust(null);
  };

  const hover = hoverCell.value;
  const here = hover >= 0 && isVegetated(w, w.derived, hover) ? { x: xOf(w.derived.tMean[hover]), y: yOf(w.derived.moisture[hover]) } : null;
  // 拖着色块时：预览算到哪一步了（正在算预览 / 地图上是松手后的样子 / 松手后约 N 秒出结果）
  const note = adjustPreviewNote.value;
  const dragged = drag && draftRect?.id === drag.id ? commandFor(drag.id, draftRect.rect) : null;
  const previewNote = dragged && note?.key === JSON.stringify(dragged) ? note.text : null;
  // 选中的画在最上面
  const order = [...w.small.species].sort((a, b) => (a.id === selected?.id ? 1 : 0) - (b.id === selected?.id ? 1 : 0));
  const sel = selected ? rectPx(rectOf(selected)) : null;
  const tTicks = [-30, -20, -10, 0, 10, 20, 30];
  const mTicks: [number, string][] = [
    [0.1, '0.1'],
    [0.3, '0.3'],
    [1, '1'],
    [3, '3'],
  ];
  return (
    <div class="chart" style={{ aspectRatio: `${W} / ${H}` }}>
      <canvas ref={canvasRef} width={W} height={H} />
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        <rect x={PAD.l} y={PAD.t} width={PW} height={PH} fill="none" stroke="currentColor" stroke-opacity={0.25} />
        {tTicks.map((t) => (
          <g>
            <line x1={xOf(t)} x2={xOf(t)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" stroke-opacity={0.08} />
            <text x={xOf(t)} y={H - PAD.b + 12} text-anchor="middle" class="tick">
              {t}
            </text>
          </g>
        ))}
        {mTicks.map(([m, label]) => (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={yOf(m)} y2={yOf(m)} stroke="currentColor" stroke-opacity={0.08} />
            <text x={PAD.l - 4} y={yOf(m) + 3} text-anchor="end" class="tick">
              {label}
            </text>
          </g>
        ))}
        <text x={PAD.l + PW / 2} y={H - 3} text-anchor="middle" class="axis">
          冷 ← 年均温（°C）→ 热
        </text>
        <text x={10} y={PAD.t + PH / 2} text-anchor="middle" class="axis" transform={`rotate(-90 10 ${PAD.t + PH / 2})`}>
          干 ← 湿润程度 → 湿
        </text>
        {order.map((sp) => {
          const r = rectPx(rectOf(sp));
          const on = sp.id === selected?.id;
          return (
            <rect
              x={r.x0}
              y={r.y0}
              width={Math.max(2, r.x1 - r.x0)}
              height={Math.max(2, r.y1 - r.y0)}
              fill={sp.color}
              fill-opacity={on ? 0.45 : 0.18}
              stroke={sp.color}
              stroke-width={on ? 2.5 : 1}
              class={on ? 'rect on' : 'rect'}
              onPointerDown={(e) => onDown(e as unknown as PointerEvent, sp)}
            >
              <title>{sp.name}</title>
            </rect>
          );
        })}
        {sel &&
          [
            [sel.x0, sel.y0],
            [sel.x1, sel.y0],
            [sel.x0, sel.y1],
            [sel.x1, sel.y1],
          ].map(([x, y]) => <rect x={x - 3} y={y - 3} width={6} height={6} fill="#fff" stroke="#000" stroke-width={0.8} pointer-events="none" />)}
        {here && (
          <g pointer-events="none">
            <circle cx={here.x} cy={here.y} r={5} fill="none" stroke="#ff5" stroke-width={2} />
            <text x={here.x + 7} y={here.y - 6} class="here">
              这里
            </text>
          </g>
        )}
        {previewNote && (
          <text x={W - PAD.r - 4} y={PAD.t + 12} text-anchor="end" class="axis" pointer-events="none">
            {previewNote}
          </text>
        )}
      </svg>
    </div>
  );
}

function AdvancedTolerances({ sp }: { sp: Species }) {
  const w = world.value!;
  const tols = advancedTolerances(sp);
  const fields = [...BUILTIN_FIELDS, ...Object.keys(w.causes.fields).map((f) => ({ id: `field:${f}`, label: `自定义：${f}`, unit: '' }))];
  const others = sp.tolerances.filter((t) => !tols.includes(t));
  const save = (next: Tolerance[]) => void exec({ op: 'update_species', id: sp.id, patch: { tolerances: [...others, ...next] } }, '正在计算生态…');
  return (
    <div>
      <p class="muted small">更精细的条件：对任意一项（海拔、坡度、河流流量、纬度、自定义场……）给出“最小 · 最适下限 · 最适上限 · 最大”。最适区间里最适合，向两端渐渐变差。</p>
      {tols.map((t, k) => (
        <div class="tol">
          <select
            value={t.field}
            onChange={(e) => save(tols.map((x, i) => (i === k ? { ...x, field: (e.target as HTMLSelectElement).value } : x)))}
          >
            {fields.map((f) => (
              <option value={f.id}>{f.label}</option>
            ))}
          </select>
          <div class="row nums">
            {(['min', 'optLow', 'optHigh', 'max'] as const).map((key) => (
              <input
                type="number"
                step="any"
                value={t[key]}
                title={{ min: '最小', optLow: '最适下限', optHigh: '最适上限', max: '最大' }[key]}
                onChange={(e) => save(tols.map((x, i) => (i === k ? { ...x, [key]: Number((e.target as HTMLInputElement).value) } : x)))}
              />
            ))}
            <button class="small" onClick={() => save(tols.filter((_, i) => i !== k))}>
              ✕
            </button>
          </div>
        </div>
      ))}
      <button onClick={() => save([...tols, { field: 'elevation', min: 0, optLow: 0, optHigh: 2000, max: 3000 }])}>添加条件</button>
      <h5>导出到游戏时的地形类别</h5>
      <select value={sp.terrain} onChange={(e) => void exec({ op: 'update_species', id: sp.id, patch: { terrain: (e.target as HTMLSelectElement).value } })}>
        {Object.keys(TERRAIN_COLORS)
          .filter((t) => t !== 'ocean' && t !== 'lake')
          .map((t) => (
            <option value={t}>{t}</option>
          ))}
      </select>
    </div>
  );
}

const RAIN: [string, ConditionId | null][] = [
  ['不限', null],
  ['夏季多雨', 'summerRain'],
  ['冬季多雨', 'winterRain'],
];
const PLACES: ConditionId[] = ['coast', 'river', 'mountain', 'flat', 'wetland'];

function SpeciesDetails({ sp, share }: { sp: Species; share: number }) {
  const [name, setName] = useState(sp.name);
  useEffect(() => setName(sp.name), [sp.id, sp.name]);
  const conds = speciesConditions(sp);
  const rect = speciesRect(sp);
  const setCond = (id: ConditionId, on: boolean) => void exec({ op: 'update_species', id: sp.id, patch: { tolerances: withCondition(sp, id, on).tolerances } }, '正在计算生态…');
  const rain = conds.has('summerRain') ? 'summerRain' : conds.has('winterRain') ? 'winterRain' : null;
  const rename = () => name.trim() && name.trim() !== sp.name && void exec({ op: 'update_species', id: sp.id, patch: { name: name.trim() } });
  return (
    <div class="box">
      <div class="row">
        <input type="color" value={sp.color} onChange={(e) => void exec({ op: 'update_species', id: sp.id, patch: { color: (e.target as HTMLInputElement).value } })} />
        <input class="grow" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && rename()} />
      </div>
      <p class="muted small">
        最适合：年均 {fmtT(rect.t0, T_RANGE[0])} ～ {fmtT(rect.t1, T_RANGE[1])}，湿润程度 {fmtM(rect.m0, M_RANGE[0])} ～ {fmtM(rect.m1, M_RANGE[1])}
        。现在占陆地 {fmtShare(share)}。
      </p>
      <label>
        <span class="row between">
          <span>强势程度</span>
          <span class="muted">{sp.competition.toFixed(1)}</span>
        </span>
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.1}
          value={sp.competition}
          onChange={(e) => void exec({ op: 'update_species', id: sp.id, patch: { competition: Number((e.target as HTMLInputElement).value) } }, '正在计算生态…')}
        />
        <span class="muted small">两种生态都能长的地方，强势的那种占上风</span>
      </label>
      <h5>只长在……</h5>
      {PLACES.map((id) => (
        <label class="check">
          <input type="checkbox" checked={conds.has(id)} onChange={() => setCond(id, !conds.has(id))} />
          {CONDITIONS[id].label}
        </label>
      ))}
      <h5>雨季</h5>
      <div class="seg wide">
        {RAIN.map(([label, id]) => (
          <button
            class={rain === id ? 'on' : ''}
            onClick={() => {
              if (id) setCond(id, true);
              else if (rain) setCond(rain, false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {sp.dispersal && (
        <p class="muted small">
          只在起源地附近、能扩散到的地方出现（{sp.dispersal.seaCost >= 1e5 ? '不能跨海' : '可以跨海'}）。
          <button class="small" onClick={() => void exec({ op: 'update_species', id: sp.id, patch: { dispersal: null } }, '正在计算生态…')}>
            取消这个限制
          </button>
        </p>
      )}
      <details>
        <summary>高级</summary>
        <AdvancedTolerances sp={sp} />
      </details>
      <SpeciesAdvanced sp={sp} />
      <div class="row wrap">
        <button onClick={() => paintWith(sp.id)} disabled={options.value.biome === sp.id && tool.value === 'biome'}>
          {options.value.biome === sp.id && tool.value === 'biome' ? '画笔正在用它' : '用它涂'}
        </button>
        <button
          onClick={async () => {
            const w = world.value!;
            let id = `${sp.id}_copy`;
            for (let k = 2; w.small.species.some((s) => s.id === id); k++) id = `${sp.id}_copy${k}`;
            if (await exec({ op: 'add_species', species: { ...structuredClone(sp), id, name: `${sp.name}（副本）` } })) focusSpecies.value = id;
          }}
        >
          复制
        </button>
        <button
          class="danger"
          onClick={() => {
            if (confirm(`删除生态“${sp.name}”？原来长它的地方会换成别的生态。`)) void exec({ op: 'remove_species', id: sp.id }, '正在计算生态…');
          }}
        >
          删除
        </button>
      </div>
    </div>
  );
}

const PALETTE = ['#8a6fb0', '#c0607a', '#4f9fb0', '#b08a3a', '#6aa050', '#d07a40', '#5a70c0', '#a05a9a'];

export function SpeciesPanel() {
  const w = world.value;
  const shares = useMemo(() => {
    const m = new Map<number, number>();
    if (!w) return m;
    let total = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!isVegetated(w, w.derived, i)) continue;
      total++;
      const s = w.derived.dominant[i];
      if (s >= 0) m.set(s, (m.get(s) ?? 0) + 1);
    }
    for (const [k, v] of m) m.set(k, v / Math.max(1, total));
    return m;
  }, [w]);
  if (!w) return null;
  const selected = w.small.species.find((s) => s.id === focusSpecies.value) ?? null;
  const addNew = async () => {
    let k = w.small.species.length + 1;
    let id = `custom_${k}`;
    while (w.small.species.some((s) => s.id === id)) id = `custom_${++k}`;
    const base: Species = { id, name: `新生态 ${k}`, color: PALETTE[k % PALETTE.length], terrain: 'plains', competition: 3, tolerances: [] };
    const sp = withRect(base, { t0: 5, t1: 18, m0: 0.6, m1: 1.6 });
    if (await exec({ op: 'add_species', species: sp })) focusSpecies.value = id;
  };
  // 导入：和资源包走同一条路（只解析、检查，带脚本的先问信任）。以前导出的生态文件照旧是整套换掉；
  // 选的是资源包（或文字包）时打开资源包的导入
  const importJson = (file: File) => {
    void file.text().then(async (text) => {
      const read = readPack(text, fileLabel(file.name));
      if (!read.ok) {
        showToast(`导入失败：${read.errors.slice(0, 2).join('；')}`, true);
        return;
      }
      if (read.legacy !== 'biomes') {
        openPackImport(read, file.name);
        return;
      }
      const list = read.pack.biomes ?? [];
      // 带着没见过的脚本：先问（信任了才导入；安全模式下脚本不运行，不问）
      if (!(await confirmImport(read.pack))) return;
      await exec({
        op: 'batch',
        label: `导入 ${list.length} 种生态`,
        commands: [...w.small.species.map((s) => ({ op: 'remove_species' as const, id: s.id })), ...list.map((s) => ({ op: 'add_species' as const, species: s }))],
      });
    });
  };
  return (
    <div class="species">
      <p class="muted small">每个色块是一种生态最适合的冷暖干湿范围：拖动色块移动，拖边或角改大小，拖到图边表示“不限”。灰色的点是这个世界上所有陆地的分布，黄圈是鼠标所指的地方。</p>
      <Chart w={w} selected={selected} onSelect={(id) => (focusSpecies.value = id)} />
      <div class="palette">
        {w.small.species.map((s, k) => (
          <button class={`chip ${s.id === focusSpecies.value ? 'on' : ''}`} onClick={() => (focusSpecies.value = s.id)}>
            <span class="swatch" style={{ background: s.color }} />
            {s.name || s.id}
            <span class="muted small"> {fmtShare(shares.get(k) ?? 0)}</span>
          </button>
        ))}
      </div>
      <div class="row wrap">
        <button onClick={addNew}>新建生态</button>
        <button onClick={() => openPackApply(FANTASY_PACK, { biomes: (FANTASY_PACK.biomes ?? []).map((b) => b.id) }, 'biomes')} title="水晶丛林、死亡森林……先在地图上看看加了之后的样子">
          添加示例生态…
        </button>
        <button onClick={() => download('species.json', JSON.stringify(w.small.species, null, 2), 'application/json')}>导出</button>
        <label class="file-button">
          导入…
          <input
            type="file"
            accept="application/json"
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) importJson(f);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </label>
      </div>
      {selected ? <SpeciesDetails sp={selected} share={shares.get(w.small.species.indexOf(selected)) ?? 0} /> : <p class="muted small">点一个色块或下面的名字来编辑。</p>}
    </div>
  );
}
