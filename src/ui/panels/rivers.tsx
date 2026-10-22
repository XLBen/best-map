import { effect } from '@preact/signals';
import { Dices, Ellipsis, LockOpen, Pin, ScanSearch, Scissors, Trash2, TriangleAlert, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command, GuidePatch } from '../../../core/commands';
import { findCell } from '../../../core/mesh';
import { decodePath } from '../../../core/rivers';
import { continueCourse, guideFlow, isRiverCell } from '../../../core/select';
import { roundKm as km } from '../../../core/terrain';
import type { Guide, World } from '../../../core/world';
import { type RiverRef, cancelPreviews, exec, hoverRiver, openPanel, riverPending, riverStyleOverride, selectedRiver, showToast, togglePanel, world } from '../../state';
import { focusOn } from '../camera';
import { Seg } from '../common';
import {
  applyPatch,
  clearRiverBarPreview,
  execAndSelect,
  flowEstimate,
  guideFeature,
  guideName,
  guideOf,
  holdRiverBarPreview,
  pinCommand,
  previewRiverBar,
  riverInfo,
  selectRiver,
} from '../riverCourse';
import { fmtFlow, riverSizeName } from '../tools';
import { NameInput } from './names';

// 河：选中一条河后的底部条（名字、大小、⋯ 里的粗细、终点、删除）、穿过别的河时的确认条、“水系 ⋯”里的河流列表

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const quoted = (name: string | null) => (name ? `「${name}」` : '这条河');

// 底部条上的滑块：拖动时 onDraft（地图上先画出估计的样子），松手 onCommit；左右方向键走一小步
function DragSlider({ label, pos, text, title, detent, onDraft, onCommit, onCancel }: {
  label: string;
  pos: number;
  text: string;
  title?: string;
  // 最左边这一段是一个单独的选择（“顺其自然”），滑轨上淡淡地标出来
  detent?: number;
  onDraft: (p: number) => void;
  onCommit: (p: number) => void;
  onCancel: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef(pos);
  const [drag, setDrag] = useState(false);
  const at = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    return clamp01((e.clientX - r.left) / r.width);
  };
  const stop = (commit: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    setDrag(false);
    if (commit) onCommit(last.current);
    else onCancel();
  };
  // 拖着的时候底部条收起来了（Esc 取消了选择、按数字键换了工具）：当作取消，地图上不留着拖到一半的样子
  useEffect(
    () => () => {
      if (dragging.current) onCancel();
    },
    [],
  );
  return (
    <div class={`hs ${drag ? 'drag' : ''}`} title={title}>
      <span class="hs-label">{label}</span>
      <div
        class="hs-track"
        ref={track}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = true;
          setDrag(true);
          last.current = at(e);
          onDraft(last.current);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          last.current = at(e);
          onDraft(last.current);
        }}
        onPointerUp={() => stop(true)}
        onPointerCancel={() => stop(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            onCommit(clamp01(pos + (e.key === 'ArrowRight' ? 0.06 : -0.06)));
          }
        }}
      >
        {detent !== undefined && <div class="hs-detent" style={{ width: `${detent * 100}%` }} />}
        <div class="hs-fill" style={{ width: `${pos * 100}%` }} />
        <div class="hs-thumb" style={{ left: `calc((100% - 12px) * ${pos})` }} />
      </div>
      <span class="hs-value">{text}</span>
    </div>
  );
}

// “大小”：这条河的总水量（本来的水加上画的时候加进来的），最左边是“顺其自然”（不另外加水）。
// 拖动时地图上先按估计画，停一下换成确切的；松手执行（直接用算好的预览）
const DETENT = 0.08;
const snapFlow = (v: number) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v));

function FlowSlider({ w, g }: { w: World; g: Guide }) {
  const thr = w.small.planet.riverThreshold;
  const { total, natural } = guideFlow(w, w.derived, g);
  const lo = natural + 1.2;
  const hi = Math.min(natural + 200, Math.max(80, lo * 6));
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  useEffect(() => setDraft(undefined), [g]);
  const valueAt = (p: number): number | null => (p < DETENT * 0.75 ? null : Math.min(hi, Math.max(lo, snapFlow(lo * Math.pow(hi / lo, clamp01((p - DETENT) / (1 - DETENT)))))));
  const posOf = (v: number | null) => (v === null ? 0 : DETENT + (1 - DETENT) * clamp01(Math.log(v / lo) / Math.log(hi / lo)));
  const cur = draft !== undefined ? draft : g.spring ? total : null;
  const name = guideName(w, g);
  // 定大小时存的是加进来的水：flow = 目标 − 本来的（至少 1.2，源头的泉水）
  const patchFor = (v: number | null): GuidePatch | null => {
    if (v === null) return g.spring ? { spring: false, flow: null } : null;
    const flow = Math.min(200, Math.max(1.2, Math.round((v - natural) * 100) / 100));
    if (g.spring && Math.abs((g.flow ?? 1.2) - flow) < 0.01) return null;
    return { spring: true, flow };
  };
  const cmdFor = (v: number | null, patch: GuidePatch): Command => ({
    op: 'update_guide',
    id: g.id,
    patch,
    label: v === null ? `${quoted(name)}的大小改回顺其自然` : `${quoted(name)}改成${riverSizeName(v)}（${fmtFlow(v * thr)} m³/s）`,
  });
  const draftTo = (p: number) => {
    const v = valueAt(p);
    setDraft(v);
    const patch = patchFor(v);
    if (!patch) {
      // 拖回了原来的大小：照原样画
      riverStyleOverride.value = null;
      clearRiverBarPreview();
      return;
    }
    riverStyleOverride.value = { id: g.id, hide: true };
    previewRiverBar(cmdFor(v, patch), applyPatch(g, patch), flowEstimate(w, g, v !== null, v === null ? undefined : (patch.flow ?? undefined)));
  };
  const done = () => {
    riverStyleOverride.value = null;
    clearRiverBarPreview();
    setDraft(undefined);
  };
  const commit = async (p: number) => {
    const v = valueAt(p);
    const patch = patchFor(v);
    if (!patch) return done();
    setDraft(v);
    // 停下来时算好的预览直接采用；排着队还没发出去的不要了（还在等计时器的也不必再算）
    holdRiverBarPreview();
    cancelPreviews();
    try {
      await exec(cmdFor(v, patch), '正在计算河流…');
    } finally {
      done();
    }
  };
  return (
    <DragSlider
      label="大小"
      pos={posOf(cur)}
      text={cur === null ? '顺其自然' : `${riverSizeName(cur)} ${fmtFlow(cur * thr)} m³/s`}
      title="这条河一共多少水；最左边是顺其自然（不另外加水，只有流进来的水）"
      detent={DETENT}
      onDraft={draftTo}
      onCommit={(p) => void commit(p)}
      onCancel={done}
    />
  );
}

// “粗细”：只影响画法和导出（不重算），拖动时地图上立即变
const WLO = 0.4;
const WHI = 3;
const snapWidth = (v: number) => {
  const r = Math.round(v * 20) / 20;
  return Math.abs(r - 1) < 0.06 ? 1 : r;
};

function WidthSlider({ w, g }: { w: World; g: Guide }) {
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [g]);
  const cur = draft ?? g.width ?? 1;
  const valueAt = (p: number) => snapWidth(WLO * Math.pow(WHI / WLO, p));
  const done = () => {
    riverStyleOverride.value = null;
    setDraft(null);
  };
  const commit = async (p: number) => {
    const v = valueAt(p);
    if (v === (g.width ?? 1)) return done();
    setDraft(v);
    try {
      await exec({ op: 'update_guide', id: g.id, patch: { width: v === 1 ? null : v }, label: `${quoted(guideName(w, g))}的粗细改成 ${Math.round(v * 100)}%` }, '正在修改…');
    } finally {
      done();
    }
  };
  return (
    <DragSlider
      label="粗细"
      pos={clamp01(Math.log(cur / WLO) / Math.log(WHI / WLO))}
      text={`${Math.round(cur * 100)}%`}
      title="只改画出来的粗细（屏幕、图片、导出的 rivers.bmp），水量不变"
      onDraft={(p) => {
        const v = valueAt(p);
        setDraft(v);
        riverStyleOverride.value = { id: g.id, width: v };
      }}
      onCommit={(p) => void commit(p)}
      onCancel={done}
    />
  );
}

// 画的线画到的那一格（之后是顺地势流下去的那段）；不是画的河时为 -1
function drawnEnd(w: World, g: Guide): number {
  if (!g.path) return -1;
  const pts = decodePath(g.path);
  const [x, y] = pts[pts.length - 1];
  return g.cells.indexOf(findCell(w.mesh, x, y, g.cells[g.cells.length - 1]));
}

// “终点：接着流 | 消失”只在画到的那一格在陆地上、不是别的河时有：在别的河上消失会把那条河的水也吞掉
function endChoice(w: World, g: Guide): number {
  const m = drawnEnd(w, g);
  if (m < 0) return -1;
  const { mesh, causes, derived: d } = w;
  const c = g.cells[m];
  if (!causes.land[c] || d.lake[c] === 1) return -1;
  if (g.end === 'sink') return m;
  // 画到的地方就是终点、在地图边上：流出地图，不必消失
  if (m === g.cells.length - 1 && mesh.boundary[c] === 1) return -1;
  // 画到的那格（之后顺地势流下去的那段里也一样）有别的河流进来
  const prev = g.cells[m - 1];
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
    const j = mesh.adj[e];
    if (j !== prev && d.receiver[j] === c && isRiverCell(w, d, j)) return -1;
  }
  return m;
}

// 选中的画的河：名字、换一个、大小、⋯、取消选择
function GuideRiverBar({ w, g }: { w: World; g: Guide }) {
  const f = guideFeature(w, g.id);
  // 固定下来的自然河没自己换过名字时，用那条河原来的盐
  const salt = g.salt ?? (g.nameKey ? w.small.featureNames[g.nameKey]?.salt : undefined) ?? 0;
  const update = (patch: GuidePatch, label: string, busy = '正在起名…') => void exec({ op: 'update_guide', id: g.id, patch, label }, busy);
  const warnings = riverInfo(w, { kind: 'guide', id: g.id })?.warnings ?? [];
  return (
    <>
      <NameInput fkey={`guide:${g.id}`} value={f?.name ?? ''} placeholder="起个名字" onCommit={(v) => update({ name: v }, `改名为“${v}”`, '正在改名…')} />
      {f && (
        <button class="bar-btn" onClick={() => update({ name: '', salt: salt + 1 }, '换了个名字')} title="自动换一个名字">
          <Dices size={15} /> 换一个
        </button>
      )}
      {f?.custom && (
        <button class="bar-btn" onClick={() => update({ name: '', salt }, '恢复自动命名')} title="不用自己起的名字，按文字包自动起">
          <LockOpen size={15} /> 恢复自动
        </button>
      )}
      <FlowSlider w={w} g={g} />
      {warnings.length > 0 && (
        <span class="bar-chip warn" title={warnings.join('；')}>
          <TriangleAlert size={13} /> {warnings[0]}
        </span>
      )}
      <button class={`bar-btn icon ${openPanel.value === 'river' ? 'on' : ''}`} data-panel="river" onClick={() => togglePanel('river')} title="粗细、终点、删掉这条河">
        <Ellipsis size={15} />
      </button>
      <button class="bar-btn icon" onClick={() => (selectedRiver.value = null)} title="取消选择（Esc）">
        <X size={15} />
      </button>
    </>
  );
}

// 选中的自然的河：名字（有地名的大河）、它是什么样的河、固定这条河、从这里往下去掉
function NaturalRiverBar({ w, cell }: { w: World; cell: number }) {
  const info = riverInfo(w, { kind: 'natural', cell });
  if (!info) return null;
  const f = info.feature;
  const cut = pinCommand(w, cell, true);
  return (
    <>
      {f ? (
        <NameInput fkey={f.key} value={f.name} onCommit={(v) => void exec({ op: 'rename_feature', key: f.key, name: v }, '正在改名…')} />
      ) : (
        <span class="bar-label" title="小河没有地名；固定下来之后可以起名">
          无名的河
        </span>
      )}
      {f && (
        <button class="bar-btn" onClick={() => void exec({ op: 'reroll_feature', key: f.key }, '正在起名…')} title="自动换一个名字">
          <Dices size={15} /> 换一个
        </button>
      )}
      <span class="bar-label">
        {info.size} · {fmtFlow(info.flow)} m³/s · {info.dest}
      </span>
      <button
        class="bar-btn"
        onClick={() => {
          const c = pinCommand(w, cell);
          if (c) void execAndSelect(c.cmd, '正在固定…');
        }}
        title="把这条河的走向固定下来，之后改地形它也不会挪；可以改名、改大小、重画"
      >
        <Pin size={15} /> 固定这条河
      </button>
      <button
        class="bar-btn"
        disabled={!cut}
        onMouseEnter={() => cut && previewRiverBar(cut.cmd, cut.after, cut.estimate, 0)}
        onMouseLeave={clearRiverBarPreview}
        onClick={() => {
          if (!cut) return;
          clearRiverBarPreview();
          void execAndSelect(cut.cmd, '正在计算河流…');
        }}
        title={cut ? '这里往下的河没了（水在这里渗进地下），上游照旧；红色是会变干的河段' : '这里是源头'}
      >
        <Scissors size={15} /> 从这里往下去掉
      </button>
      <button class="bar-btn icon" onClick={() => focusOn(info.cells)} title="在地图上看">
        <ScanSearch size={15} />
      </button>
      <button class="bar-btn icon" onClick={() => (selectedRiver.value = null)} title="取消选择（Esc）">
        <X size={15} />
      </button>
    </>
  );
}

export function RiverBar() {
  const w = world.value;
  const sel = selectedRiver.value;
  // 换了选中的河、底部条收起来了（换了工具、按了数字键）：底部条上的预览不要了。
  // 不然鼠标停在“从这里往下去掉”上时换走，回到画河时地图上还画着那个预览
  useEffect(() => () => clearRiverBarPreview(), [sel]);
  if (!w || !sel) return null;
  if (sel.kind === 'natural') return <NaturalRiverBar w={w} cell={sel.cell} />;
  const g = guideOf(w, sel.id);
  return g ? <GuideRiverBar w={w} g={g} /> : null;
}

// 穿过别的河：截走它 / 到这里汇入 / 取消（回车 = 截走它，Esc = 取消）
export function RiverPendingBar() {
  const p = riverPending.value;
  if (!p) return null;
  return (
    <>
      <span class="bar-value warn-text">{p.text}</span>
      <button class="bar-btn primary" onClick={() => void p.capture()} title="回车">
        截走它
      </button>
      {p.join && (
        <button class="bar-btn" onMouseEnter={() => p.showJoin(true)} onMouseLeave={() => p.showJoin(false)} onClick={() => void p.join!()} title="画的河在碰到那条河的地方汇进去，后面画的不要了">
          到这里汇入
        </button>
      )}
      <button class="bar-btn" onClick={() => p.cancel()} title="Esc">
        取消
      </button>
    </>
  );
}

// 选中的河没了（撤销、删掉）：它的“⋯”也关上
effect(() => {
  if (!selectedRiver.value && openPanel.value === 'river') openPanel.value = null;
});

// “⋯”：这条河的说明与提醒、粗细、终点、在地图上看、删掉
export function RiverMore() {
  const w = world.value;
  const sel = selectedRiver.value;
  const g = w && sel?.kind === 'guide' ? guideOf(w, sel.id) : undefined;
  if (!w || !g || !sel) return null;
  const info = riverInfo(w, sel);
  const m = endChoice(w, g);
  const name = guideName(w, g);
  const setEnd = (sink: boolean) => {
    if (sink === (g.end === 'sink')) return;
    // 消失：只留到画到的那格；接着流：从那格起顺着地势流下去的那段也算这条河的（与画的时候选“画完接着流”一样）
    const r = sink ? null : continueCourse(w, w.derived, g);
    if (r && 'blocked' in r) return showToast(r.blocked, true);
    const patch: GuidePatch = r ? r.patch : { ...(m < g.cells.length - 1 ? { cells: g.cells.slice(0, m + 1) } : {}), end: 'sink' };
    void exec({ op: 'update_guide', id: g.id, patch, label: sink ? `${quoted(name)}在画到的地方消失` : `${quoted(name)}画完接着流` }, '正在计算河流…');
  };
  return (
    <div class="river-more">
      {info && (
        <p class="small">
          {info.size} · {fmtFlow(info.flow)} m³/s · 约 {km(info.km).toLocaleString()} km · {info.dest}
        </p>
      )}
      {info?.warnings.map((x) => (
        <p class="small warn-text">
          <TriangleAlert size={13} /> {x}
        </p>
      ))}
      {g.path && (
        <div class="row">
          <WidthSlider w={w} g={g} />
        </div>
      )}
      {m >= 0 && (
        <div class="row">
          <span class="hs-label">终点</span>
          <Seg
            value={g.end === 'sink' ? 'sink' : 'flow'}
            options={[
              ['flow', '接着流'],
              ['sink', '消失'],
            ]}
            titles={{ flow: '画到的地方之后顺着地势接着流', sink: '河在画到的地方渗进地下' }}
            onChange={(v) => setEnd(v === 'sink')}
          />
        </div>
      )}
      <div class="row wrap">
        <button class="small" onClick={() => focusOn(g.cells)}>
          <ScanSearch size={14} /> 在地图上看
        </button>
        <button
          class="small danger"
          onClick={() => {
            openPanel.value = null;
            selectedRiver.value = null;
            void exec({ op: 'remove_guide', id: g.id }, '正在计算…');
          }}
        >
          <Trash2 size={14} /> 删掉这条河
        </button>
      </div>
    </div>
  );
}

// ---------- 河流列表（“水系 ⋯”，不会自己弹出来） ----------

function RiverRow({ w, river: ref, children }: { w: World; river: RiverRef; children?: ComponentChildren }) {
  const info = riverInfo(w, ref);
  if (!info) return null;
  const sel = selectedRiver.value;
  const on = !!sel && sel.kind === ref.kind && (sel.kind === 'guide' ? sel.id === (ref as { id: string }).id : sel.cell === (ref as { cell: number }).cell);
  const g = ref.kind === 'guide' ? guideOf(w, ref.id) : undefined;
  return (
    <div
      class={`feature-row river-row ${on ? 'on' : ''}`}
      onClick={() => {
        selectRiver(ref);
        focusOn(info.cells);
        openPanel.value = null;
      }}
      onMouseEnter={() => (hoverRiver.value = ref)}
      onMouseLeave={() => (hoverRiver.value = null)}
    >
      <span class={info.feature?.custom ? 'custom' : ''}>
        {/* 第三批：河流类型的色块放在这里 */}
        {g?.type !== undefined && <span class="swatch" />}
        {info.name ?? (ref.kind === 'guide' ? '（还没名字）' : '无名的河')}
      </span>
      <span class="muted small">
        {info.size} · {km(info.km).toLocaleString()} km · {info.dest}
        {info.warnings.length > 0 && (
          <span class="warn-text" title={info.warnings.join('；')}>
            {' '}
            <TriangleAlert size={12} /> {info.warnings.length}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

export function RiverExtras() {
  const w = world.value;
  // 关上列表时鼠标停着的那条不再亮
  useEffect(() => () => void (hoverRiver.value = null), []);
  if (!w) return null;
  const guides = w.small.guides;
  const warned = guides.filter((g) => (riverInfo(w, { kind: 'guide', id: g.id })?.warnings.length ?? 0) > 0).length;
  // 有地名的自然大河：按重要度，最多 40 条；点一下选中，“固定”把它固定下来
  const natural = w.derived.features
    .filter((f) => f.type === 'river' && f.guide === undefined && f.name)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 40)
    .map((f) => ({ f, cell: Array.from(f.cells).reverse().find((c) => isRiverCell(w, w.derived, c)) ?? -1 }))
    .filter((x) => x.cell >= 0);
  return (
    <>
      {warned > 0 && <p class="small warn-text">有 {warned} 条河要看一下</p>}
      <section>
        <h5>画的河（{guides.length}）</h5>
        {guides.length === 0 ? (
          <p class="muted small">还没有画过河。用“画河”在陆地上点一下，或者选“自定义走向”按住画出河道。</p>
        ) : (
          <div class="feature-list">
            {guides.map((g) => (
              <RiverRow w={w} river={{ kind: 'guide', id: g.id }} />
            ))}
          </div>
        )}
      </section>
      {natural.length > 0 && (
        <section>
          <h5>自然的河</h5>
          <div class="feature-list">
            {natural.map(({ cell }) => (
              <RiverRow w={w} river={{ kind: 'natural', cell }}>
                <button
                  class="small"
                  title="把这条河的走向固定下来，之后改地形它也不会挪；可以改名、改大小、重画"
                  onClick={(e) => {
                    e.stopPropagation();
                    const c = pinCommand(w, cell);
                    if (!c) return;
                    selectRiver({ kind: 'natural', cell });
                    void execAndSelect(c.cmd, '正在固定…');
                  }}
                >
                  固定
                </button>
              </RiverRow>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
