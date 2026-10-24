import { effect } from '@preact/signals';
import { Pin, Scissors, Split, Sprout, TriangleAlert } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Command, GuidePatch } from '../../../core/commands';
import { findCell } from '../../../core/mesh';
import { decodePath } from '../../../core/rivers';
import { type GuideIssue, continueCourse, guideFlow, isRiverCell } from '../../../core/select';
import { roundKm as km } from '../../../core/terrain';
import type { Guide, World } from '../../../core/world';
import { type RiverRef, cancelPreviews, exec, flashCells, hoverRiver, openPanel, riverStyleOverride, selectedRiver, showToast, tool, world } from '../../state';
import { clearBarPreview } from '../barPreview';
import { focusOn } from '../camera';
import { Seg } from '../common';
import { MenuItem, SelectionActions } from '../components/SelectionActions';
import { Slider } from '../components/Slider';
import {
  RIVER_END_HINTS,
  applyPatch,
  execAndSelect,
  flowEstimate,
  guideFeature,
  guideName,
  guideOf,
  holdRiverBarPreview,
  pinCommand,
  previewRiverBar,
  riverAddMode,
  riverCutPick,
  riverInfo,
  selectRiver,
} from '../riverCourse';
import { fmtFlow, riverSizeName } from '../tools';
import { PIN_RIVER_TIP } from '../copy';
import { NameInput } from './names';
import { RiverTypeButton, riverTypeOfRiver } from './riverTypes';
import { LakeList } from './lakes';
import { type WaterKind, WaterTypesSection } from './waterTypes';

// 河：选中一条河后的底部条（名字、大小、⋯ 里的粗细、终点、删除）、穿过别的河时的确认条、“水系 ⋯”里的河流列表

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const quoted = (name: string | null) => (name ? `“${name}”` : '河');

// “大小”：这条河的总水量（本来的水加上画的时候加进来的），最左边是“顺其自然”（不另外加水）。
// 拖动时地图上先按估计画，停一下换成确切的；松手执行（直接用算好的预览）
const DETENT = 0.08;
const snapFlow = (v: number) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v));

function FlowSlider({ w, g }: { w: World; g: Guide }) {
  const thr = w.small.planet.riverThreshold;
  const { total, natural, split } = guideFlow(w, w.derived, g);
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
    label: `修改${quoted(name)}的大小 · ${v === null ? '顺其自然' : `${riverSizeName(v)} ${fmtFlow(v * thr)} m³/s`}`,
  });
  const draftTo = (p: number) => {
    const v = valueAt(p);
    setDraft(v);
    const patch = patchFor(v);
    if (!patch) {
      // 拖回了原来的大小：照原样画
      riverStyleOverride.value = null;
      clearBarPreview();
      return;
    }
    riverStyleOverride.value = { id: g.id, hide: true };
    previewRiverBar(cmdFor(v, patch), applyPatch(g, patch), flowEstimate(w, g, v !== null, v === null ? undefined : (patch.flow ?? undefined)));
  };
  const done = () => {
    riverStyleOverride.value = null;
    clearBarPreview();
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
      await exec(cmdFor(v, patch), '正在计算…');
    } finally {
      done();
    }
  };
  return (
    <Slider
      label="大小"
      pos={posOf(cur)}
      text={`${cur === null ? '顺其自然' : `${riverSizeName(cur)} ${fmtFlow(cur * thr)} m³/s`}${split > 0 ? ` · 分出 ${Math.round(split * 100)}%` : ''}`}
      title={`河的总水量，最左是顺其自然${split > 0 ? `；按分出 ${Math.round(split * 100)}% 之前算` : ''}`}
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
      await exec({ op: 'update_guide', id: g.id, patch: { width: v === 1 ? null : v }, label: `修改${quoted(guideName(w, g))}的粗细 · ${Math.round(v * 100)}%` }, '正在计算…');
    } finally {
      done();
    }
  };
  return (
    <Slider
      stacked
      label="粗细"
      pos={clamp01(Math.log(cur / WLO) / Math.log(WHI / WLO))}
      text={`${Math.round(cur * 100)}%`}
      title="只改画出来的粗细，水量不变"
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

// “终点：流下去 | 停在这”只在画到的那一格在陆地上、不是别的河时有：停在别的河上会把那条河的水也吞掉
function endChoice(w: World, g: Guide): number {
  const m = drawnEnd(w, g);
  if (m < 0) return -1;
  const { mesh, causes, derived: d } = w;
  const c = g.cells[m];
  if (!causes.land[c] || d.lake[c] === 1) return -1;
  if (g.end === 'sink') return m;
  // 画到的地方就是终点、在地图边上：流出地图，不必停
  if (m === g.cells.length - 1 && mesh.boundary[c] === 1) return -1;
  // 画到的那格（之后顺地势流下去的那段里也一样）有别的河流进来
  const prev = g.cells[m - 1];
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
    const j = mesh.adj[e];
    if (j !== prev && d.receiver[j] === c && isRiverCell(w, d, j)) return -1;
  }
  return m;
}

// “分一股出去”“加一个源头”（第十三轮）：按一下，再从这条河上起笔画（不用同时按键；再按一下或 Esc 不画了）。收在“⋯”里，按了就关上面板去画
function AddItems() {
  const m = riverAddMode.value;
  const toggle = (k: 'branch' | 'source') => {
    riverAddMode.value = m === k ? null : k;
    if (riverAddMode.value) openPanel.value = null;
  };
  return (
    <>
      <MenuItem
        icon={<Split />}
        label="分出一股"
        on={m === 'branch'}
        run={() => toggle('branch')}
        title="再从河上起笔往外画，分出约三成的水"
      />
      <MenuItem
        icon={<Sprout />}
        label="加源头"
        on={m === 'source'}
        run={() => toggle('source')}
        title="再从河上起笔往外画，画出新的源头"
      />
    </>
  );
}

// 正在“分一股出去”“加一个源头”时底部条上写着，点一下不画了
function AddModeChip() {
  const m = riverAddMode.value;
  if (!m) return null;
  return (
    <button class="bar-btn open" onClick={() => (riverAddMode.value = null)} title="点击取消">
      {m === 'branch' ? <Split /> : <Sprout />} {m === 'branch' ? '分出一股' : '加源头'}
    </button>
  );
}

// 分出去的一股分多少水（5%–50%）：拖动时地图上先按估计画，停一下换成确切的；松手执行
const SLO = 0.05;
const SHI = 0.5;
function ShareSlider({ w, g }: { w: World; g: Guide }) {
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [g]);
  const share = g.branch?.share ?? 0.3;
  const cur = draft ?? share;
  const valueAt = (p: number) => Math.round((SLO + (SHI - SLO) * p) * 100) / 100;
  const name = guideName(w, g);
  const cmdFor = (v: number): Command => ({ op: 'update_guide', id: g.id, patch: { branch: { share: v } }, label: `修改${quoted(name)}的分水 · ${Math.round(v * 100)}%` });
  const done = () => {
    riverStyleOverride.value = null;
    clearBarPreview();
    setDraft(null);
  };
  return (
    <Slider
      label="分水"
      pos={clamp01((cur - SLO) / (SHI - SLO))}
      text={`${Math.round(cur * 100)}%`}
      title="从干流分出多少水"
      onDraft={(p) => {
        const v = valueAt(p);
        setDraft(v);
        if (v === share) {
          riverStyleOverride.value = null;
          clearBarPreview();
          return;
        }
        riverStyleOverride.value = { id: g.id, hide: true };
        const s0 = w.derived.discharge[g.cells[0]];
        const est = g.cells.map((c, k) => (k === 0 ? v * s0 : Math.max(0, w.derived.discharge[c] + (v - share) * s0)));
        previewRiverBar(cmdFor(v), applyPatch(g, { branch: { share: v } }), est);
      }}
      onCommit={(p) => {
        const v = valueAt(p);
        if (v === share) return done();
        setDraft(v);
        holdRiverBarPreview();
        cancelPreviews();
        void exec(cmdFor(v), '正在计算…').finally(done);
      }}
      onCancel={done}
    />
  );
}

// 底部条上的提醒（第十三轮）：一句短话，悬停说原因，点一下在地图上标出出问题的那一段（不止一处时点一下换下一处）
function IssueChip({ issues }: { issues: GuideIssue[] }) {
  const [k, setK] = useState(0);
  const x = issues[k % issues.length];
  return (
    <button
      class="bar-chip warn"
      title={`${x.why} · 点击定位`}
      onClick={() => {
        focusOn(x.cells);
        flashCells(x.cells);
        if (issues.length > 1) setK(k + 1);
      }}
    >
      <TriangleAlert /> {x.text}
      {issues.length > 1 ? ` 等 ${issues.length} 处` : ''}
    </button>
  );
}

// 画的河的名字：换一个、恢复自动（另一个源头 sourceOf 的名字是它汇入的那条河的：改名、换一个都改那条河）
function guideNaming(w: World, own: Guide) {
  const parent = own.sourceOf !== undefined ? guideOf(w, own.sourceOf) : undefined;
  const g = parent ?? own;
  const f = guideFeature(w, g.id);
  // 固定下来的自然河没自己换过名字时，用那条河原来的盐
  const salt = g.salt ?? (g.nameKey ? w.small.featureNames[g.nameKey]?.salt : undefined) ?? 0;
  const update = (patch: GuidePatch, label: string, busy = '正在起名…') => void exec({ op: 'update_guide', id: g.id, patch, label }, busy);
  return {
    parent,
    g,
    f,
    update,
    reroll: f ? () => update({ name: '', salt: salt + 1, autoName: null }, '换名字') : undefined,
    unlock: f?.custom ? () => update({ name: '', salt, autoName: null }, '名字恢复自动') : undefined,
  };
}

// 选中的画的河：名字、是哪一种、大小，别的在“⋯”里
function GuideRiverBar({ w, g: own }: { w: World; g: Guide }) {
  const { parent, g, f, update } = guideNaming(w, own);
  const issues = riverInfo(w, { kind: 'guide', id: own.id })?.issues ?? [];
  const rt = riverTypeOfRiver(w, { kind: 'guide', id: own.id });
  return (
    <>
      <NameInput fkey={`guide:${g.id}`} value={f?.name ?? ''} placeholder="起个名字" onCommit={(v) => update({ name: v }, `改名为“${v}”`, '正在改名…')} />
      {parent && <span class="bar-label" title="同一条河的源头">源头</span>}
      <RiverTypeButton type={rt.type} auto={rt.chosen === null} />
      {own.branch ? <ShareSlider w={w} g={own} /> : <FlowSlider w={w} g={own} />}
      <AddModeChip />
      {issues.length > 0 && <IssueChip issues={issues} />}
      <SelectionActions more="river" deselect={() => (selectedRiver.value = null)} />
    </>
  );
}

// 选中的自然的河：名字（有地名的大河）、它是什么样的河、是哪一种、固定这条河，别的在“⋯”里
function NaturalRiverBar({ w, cell }: { w: World; cell: number }) {
  const info = riverInfo(w, { kind: 'natural', cell });
  if (!info) return null;
  const f = info.feature;
  const rt = riverTypeOfRiver(w, { kind: 'natural', cell });
  return (
    <>
      {f ? (
        <NameInput fkey={f.key} value={f.name} onCommit={(v) => void exec({ op: 'rename_feature', key: f.key, name: v }, '正在改名…')} />
      ) : (
        // 小河没有地名：起个名字就把它固定下来（一步），叫这个名字；留空按文字包自动起
        <NameInput
          fkey={`natural:${cell}`}
          value=""
          placeholder="起名并锁定"
          onCommit={(v) => {
            const c = pinCommand(w, cell);
            if (!c || c.cmd.op !== 'add_guide') return;
            const { nameKey: _, autoName: __, ...rest } = c.cmd.guide;
            void execAndSelect({ ...c.cmd, guide: { ...rest, name: v } }, '正在锁定…');
          }}
        />
      )}
      <span class="bar-label" title={info.split > 0 ? `按分出 ${Math.round(info.split * 100)}% 之前的水算` : undefined}>
        {info.size} · {fmtFlow(info.flow)} m³/s{info.split > 0 ? ` · 分出 ${Math.round(info.split * 100)}%` : ''} · {info.dest}
      </span>
      <RiverTypeButton type={rt.type} auto={rt.chosen === null} />
      <button
        class="bar-btn"
        onClick={() => {
          const c = pinCommand(w, cell);
          if (c) void execAndSelect(c.cmd, '正在锁定…');
        }}
        title={PIN_RIVER_TIP}
      >
        <Pin /> 锁定
      </button>
      <AddModeChip />
      {riverCutPick.value && (
        <button class="bar-btn open" onClick={() => setCutPick(false)} title="在河上点选位置；点击取消">
          <Scissors /> 从这里往下删除
        </button>
      )}
      <SelectionActions more="river" deselect={() => (selectedRiver.value = null)} />
    </>
  );
}

function setCutPick(on: boolean) {
  riverCutPick.value = on;
  if (!on) clearBarPreview();
}

export function RiverBar() {
  const w = world.value;
  const sel = selectedRiver.value;
  // 换了选中的河、底部条收起来了（换了工具、按了数字键）：底部条上的预览不要了。
  // 不然鼠标停在“从这里往下去掉”上时换走，回到画河时地图上还画着那个预览
  useEffect(
    () => () => {
      clearBarPreview();
      riverCutPick.value = false;
      riverAddMode.value = null;
    },
    [sel],
  );
  if (!w || !sel) return null;
  if (sel.kind === 'natural') return <NaturalRiverBar w={w} cell={sel.cell} />;
  const g = guideOf(w, sel.id);
  return g ? <GuideRiverBar w={w} g={g} /> : null;
}

// 选中的河没了（撤销、删掉）：它的“⋯”也关上
effect(() => {
  if (!selectedRiver.value && (openPanel.value === 'river' || openPanel.value === 'rivertype')) openPanel.value = null;
});

// “⋯”：这条河的说明与提醒、粗细、终点、换名字、分一股出去、加一个源头、在地图上看、删掉（自然的河：从这里往下去掉）
export function RiverMore() {
  const w = world.value;
  const sel = selectedRiver.value;
  if (!w || !sel) return null;
  if (sel.kind === 'natural') return <NaturalRiverMore w={w} cell={sel.cell} />;
  const g = guideOf(w, sel.id);
  if (!g) return null;
  const info = riverInfo(w, sel);
  const m = endChoice(w, g);
  const name = guideName(w, g);
  const naming = guideNaming(w, g);
  const setEnd = (sink: boolean) => {
    if (sink === (g.end === 'sink')) return;
    // 停在这：只留到画到的那格；流下去：从那格起顺着地势流下去的那段也算这条河的（与画的时候选“流下去”一样）
    const r = sink ? null : continueCourse(w, w.derived, g);
    if (r && 'blocked' in r) return showToast(r.blocked, true);
    const patch: GuidePatch = r ? r.patch : { ...(m < g.cells.length - 1 ? { cells: g.cells.slice(0, m + 1) } : {}), end: 'sink' };
    void exec({ op: 'update_guide', id: g.id, patch, label: `修改${quoted(name)}的终点 · ${sink ? '停在这' : '流下去'}` }, '正在计算…');
  };
  return (
    <div class="river-more">
      {info && (
        <p class="hint">
          {info.size} · {fmtFlow(info.flow)} m³/s · 约 {km(info.km).toLocaleString()} km · {info.dest}
        </p>
      )}
      {info?.issues.map((x) => (
        <p class="hint warn" title={x.why}>
          <TriangleAlert /> {x.text}：{x.why}
        </p>
      ))}
      {g.path && <WidthSlider w={w} g={g} />}
      {m >= 0 && (
        <div class="row">
          <span class="bar-label">终点</span>
          <Seg
            value={g.end === 'sink' ? 'sink' : 'flow'}
            options={[
              ['flow', '流下去'],
              ['sink', '停在这'],
            ]}
            titles={RIVER_END_HINTS}
            onChange={(v) => setEnd(v === 'sink')}
          />
        </div>
      )}
      <SelectionActions
        menu
        reroll={naming.reroll}
        unlock={naming.unlock}
        locate={() => focusOn(g.cells)}
        removeLabel="删除"
        remove={() => {
          openPanel.value = null;
          selectedRiver.value = null;
          void exec({ op: 'remove_guide', id: g.id, label: `删除${quoted(name)}` }, '正在计算…');
        }}
      >
        <AddItems />
      </SelectionActions>
    </div>
  );
}

function NaturalRiverMore({ w, cell }: { w: World; cell: number }) {
  const info = riverInfo(w, { kind: 'natural', cell });
  if (!info) return null;
  const f = info.feature;
  return (
    <SelectionActions menu reroll={f ? () => void exec({ op: 'reroll_feature', key: f.key }, '正在起名…') : undefined} locate={() => focusOn(info.cells)}>
      <MenuItem
        icon={<Scissors />}
        label="从这里往下删除"
        on={riverCutPick.value}
        run={() => {
          setCutPick(!riverCutPick.value);
          if (riverCutPick.value) openPanel.value = null;
        }}
        title="在河上点选位置，删除那里往下的河"
      />
      <AddItems />
    </SelectionActions>
  );
}

// ---------- 河流列表（“水系 ⋯”，不会自己弹出来） ----------

function RiverRow({ w, river: ref, children }: { w: World; river: RiverRef; children?: ComponentChildren }) {
  const info = riverInfo(w, ref);
  if (!info) return null;
  const sel = selectedRiver.value;
  const on = !!sel && sel.kind === ref.kind && (sel.kind === 'guide' ? sel.id === (ref as { id: string }).id : sel.cell === (ref as { cell: number }).cell);
  // 是哪一种河（世界里有河流类型时）：色块
  const rt = w.small.riverTypes?.length ? riverTypeOfRiver(w, ref).type : null;
  return (
    <div
      class={`item ${on ? 'on' : ''}`}
      onClick={() => {
        selectRiver(ref);
        focusOn(info.cells);
        openPanel.value = null;
      }}
      onMouseEnter={() => (hoverRiver.value = ref)}
      onMouseLeave={() => (hoverRiver.value = null)}
    >
      <span class={`grow ellipsis ${info.feature?.custom ? 'custom' : ''}`}>
        {rt && <span class="swatch" style={{ background: rt.color }} title={rt.name} />}
        {info.name ?? '未命名'}
      </span>
      <span class="hint">
        {info.size} · {km(info.km).toLocaleString()} km · {info.dest}
        {info.warnings.length > 0 && (
          <span class="warn" title={info.warnings.join('；')}>
            {' '}
            <TriangleAlert /> {info.warnings.length}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

export function RiverExtras() {
  const w = world.value;
  // “水体类型”的河 / 湖两栏：湖那一栏下面列出全部的湖，河那一栏列出河
  const [tab, setTab] = useState<WaterKind>(tool.value === 'lake' ? 'lake' : 'river');
  // 关上列表时鼠标停着的那条不再亮
  useEffect(() => () => void (hoverRiver.value = null), []);
  if (!w) return null;
  if (tab === 'lake') {
    return (
      <>
        <WaterTypesSection tab={tab} onTab={setTab} />
        <LakeList />
      </>
    );
  }
  const guides = w.small.guides;
  // 固定下来（或改过）的自然河沿用那条河的地名键，与自己画的河分开列
  const drawn = guides.filter((g) => g.nameKey === undefined);
  const pinned = guides.filter((g) => g.nameKey !== undefined);
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
      <WaterTypesSection tab={tab} onTab={setTab} />
      {warned > 0 && <p class="hint warn">{warned} 条河有提醒</p>}
      <section>
        <h5>画的河（{drawn.length}）</h5>
        {drawn.length === 0 ? (
          <p class="hint">没有画的河</p>
        ) : (
          <div class="list">
            {drawn.map((g) => (
              <RiverRow w={w} river={{ kind: 'guide', id: g.id }} />
            ))}
          </div>
        )}
      </section>
      {pinned.length > 0 && (
        <section>
          <h5>锁定的自然河（{pinned.length}）</h5>
          <div class="list">
            {pinned.map((g) => (
              <RiverRow w={w} river={{ kind: 'guide', id: g.id }} />
            ))}
          </div>
        </section>
      )}
      {natural.length > 0 && (
        <section>
          <h5>自然的河</h5>
          <div class="list">
            {natural.map(({ cell }) => (
              <RiverRow w={w} river={{ kind: 'natural', cell }}>
                <button
                  class="bar-btn"
                  title={PIN_RIVER_TIP}
                  onClick={(e) => {
                    e.stopPropagation();
                    const c = pinCommand(w, cell);
                    if (!c) return;
                    selectRiver({ kind: 'natural', cell });
                    void execAndSelect(c.cmd, '正在锁定…');
                  }}
                >
                  锁定
                </button>
              </RiverRow>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
