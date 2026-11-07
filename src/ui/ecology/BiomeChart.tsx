import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { type Rect, type Species, speciesRect } from '../../../core/species';
import { isVegetated } from '../../../core/vegetation';
import type { World } from '../../../core/world';
import { adjustPreviewNote, execAdjust, hoverCell, previewAdjust } from '../../state';
import { rectPatch } from './biome-edit';
import { type DragMode, H, M_TICKS, PAD, PH, PW, type Px, T_TICKS, W, densityPixels, dragModeAt, dragPx, rectFromPx, rectPx, xOf, yOf } from './chart';

// 生态编辑器上面的气候图（第七十二轮从 ClimateChart.tsx 搬来）：每种生态是一个可拖动、拉伸的色块，
// 底图是世界上所有陆地格的分布。点别的色块换到那一种的页面（以前的抽屉里点了就能接着拖）。
// 本世界里拖色块时手停一下，地图上就是松手后的样子（在世界的副本上算好，松手时直接采用）；库里松手才存

type Drag = DragMode & { id: string; startX: number; startY: number; px: Px };

export interface ChartProps {
  // 陆地的分布、“这里”按这个世界画（库里看时也是本世界的；没有世界时不画）
  w: World | null;
  all: readonly Species[];
  selected: Species;
  onSelect: (id: string) => void;
  // 本世界：拖的时候预览，松手执行（和以前的生态抽屉同一条命令）。否则 onCommit
  live: boolean;
  onCommit: (id: string, r: Rect) => void;
  readonly: boolean;
}

export function BiomeChart({ w, all, selected, onSelect, live, onCommit, readonly }: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draftRect, setDraftRect] = useState<{ id: string; rect: Rect } | null>(null);
  // 底图按像素的那一份重画（第七十九轮：数组没变时是同一份，换了世界对象也不重画）
  const density = w ? densityPixels(w) : null;
  useEffect(() => {
    const c = canvasRef.current?.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, W, H);
    if (density) c.putImageData(new ImageData(density, W, H), 0, 0);
  }, [density]);
  useEffect(() => setDraftRect(null), [w, all]);

  const local = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H] as const;
  };
  const rectOf = (sp: Species) => (draftRect?.id === sp.id ? draftRect.rect : speciesRect(sp));
  // 本世界里松手时执行的命令（拖动中预览的也是它）
  const commandFor = (id: string, rect: Rect): Command | null => {
    const sp = all.find((s) => s.id === id);
    return sp ? { op: 'update_species', id: sp.id, patch: rectPatch(sp, rect) } : null;
  };

  const onDown = (e: PointerEvent, sp: Species) => {
    e.stopPropagation();
    // 点别的色块：换到那一种的页面（换了页，再按才拖）
    if (selected.id !== sp.id) return onSelect(sp.id);
    if (readonly) return;
    const [x, y] = local(e);
    const px = rectPx(rectOf(sp));
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id: sp.id, ...dragModeAt(px, x, y), startX: x, startY: y, px });
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const [x, y] = local(e);
    const p = dragPx(drag.px, drag, x - drag.startX, y - drag.startY);
    const rect = rectFromPx(p.x0, p.x1, p.y0, p.y1);
    setDraftRect({ id: drag.id, rect });
    // 手停下 200 毫秒：地图上画出松手后的世界
    if (live) previewAdjust(commandFor(drag.id, rect));
  };
  const onUp = () => {
    const d = drag;
    setDrag(null);
    if (!d || !draftRect || draftRect.id !== d.id) {
      if (d && live) previewAdjust(null);
      return;
    }
    if (!live) {
      onCommit(d.id, draftRect.rect);
      return;
    }
    const cmd = commandFor(d.id, draftRect.rect);
    // 预览过的就是它：结果直接采用，预览的世界留到结果换上
    if (cmd) void execAdjust(cmd, '正在计算…');
    else previewAdjust(null);
  };

  const hover = hoverCell.value;
  const here = w && hover >= 0 && hover < w.mesh.n && isVegetated(w, w.derived, hover) ? { x: xOf(w.derived.tMean[hover]), y: yOf(w.derived.moisture[hover]) } : null;
  // 拖着色块时：预览算到哪一步了（正在算预览 / 地图上是松手后的样子 / 松手后约 N 秒出结果）
  const note = adjustPreviewNote.value;
  const dragged = live && drag && draftRect?.id === drag.id ? commandFor(drag.id, draftRect.rect) : null;
  const previewNote = dragged && note?.key === JSON.stringify(dragged) ? note.text : null;
  // 选中的画在最上面
  const order = [...all].sort((a, b) => (a.id === selected.id ? 1 : 0) - (b.id === selected.id ? 1 : 0));
  const sel = rectPx(rectOf(selected));
  return (
    <div class="chart" style={{ aspectRatio: `${W} / ${H}` }}>
      <canvas ref={canvasRef} width={W} height={H} />
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        <rect x={PAD.l} y={PAD.t} width={PW} height={PH} fill="none" stroke="currentColor" stroke-opacity={0.25} />
        {T_TICKS.map((t) => (
          <g>
            <line x1={xOf(t)} x2={xOf(t)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" stroke-opacity={0.08} />
            <text x={xOf(t)} y={H - PAD.b + 12} text-anchor="middle" class="tick">
              {t}
            </text>
          </g>
        ))}
        {M_TICKS.map(([m, label]) => (
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
          const on = sp.id === selected.id;
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
        {!readonly &&
          [
            [sel.x0, sel.y0],
            [sel.x1, sel.y0],
            [sel.x0, sel.y1],
            [sel.x1, sel.y1],
          ].map(([x, y]) => <rect x={x - 3} y={y - 3} width={6} height={6} fill="#fff" stroke="#000" stroke-width={0.8} pointer-events="none" />)}
        {here && (
          <g pointer-events="none">
            <circle cx={here.x} cy={here.y} r={5} class="cursor-mark" />
            <text x={here.x + 7} y={here.y - 6} class="cursor-mark">
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
