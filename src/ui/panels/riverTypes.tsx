import { Plus, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { FANTASY_RIVER_TYPES } from '../../../core/packs/fantasy-rivers';
import { PLAIN_RIVER, RIVER_STYLES, RIVER_STYLE_LABEL, type RiverStyle, type RiverType, majorityType, riverTypeOwner } from '../../../core/river-types';
import { SCRIPT_API } from '../../../core/script';
import type { World } from '../../../core/world';
import {
  type RiverRef,
  editsIdle,
  exec,
  openPanel,
  options,
  replaceLast,
  riverTypeEditorRequest,
  trustHandledElsewhere,
  selectedRiver,
  setOptions,
  toast,
  togglePanel,
  whenEditsIdle,
  world,
  worldEpoch,
} from '../../state';
import { Seg } from '../common';
import { noteScriptCommitted, showCell } from '../editor-hooks';
import { ScriptBox } from '../ScriptBox';
import { type ApplyMode, type ApplyResult, type ScriptProblem, normScript, problemOfIssue } from '../script-commit';
import { execAndSelect, guideOf, pinCommand, riverInfo } from '../riverCourse';
import { riverStroke, riverTypeColor } from '../../render/overlay';
import { DragSlider } from './rivers';

// 河流类型（第三批）：画河工具条、选中一条河时的“是哪一种河”，河流列表的色块，“水系 ⋯”里的“河流类型”（列表、新建、编辑）

// ---------- 一条河是哪一种 ----------

export interface RiverTypeOfRiver {
  // 现在画出来是哪一种（普通的河为 null）
  type: RiverType | null;
  // 这条河自己选的：一种类型、“普通的河”；没选（按各类型的规则）为 null
  chosen: 'type' | 'plain' | null;
}

export function riverTypeOfRiver(w: World, ref: RiverRef): RiverTypeOfRiver {
  const types = w.small.riverTypes ?? [];
  if (ref.kind === 'guide') {
    const g = guideOf(w, ref.id);
    if (g?.type === PLAIN_RIVER) return { type: null, chosen: 'plain' };
    const own = g?.type !== undefined ? types.find((t) => t.id === g.type) : undefined;
    if (own) return { type: own, chosen: 'type' };
  }
  const cells = riverInfo(w, ref)?.cells ?? [];
  const k = majorityType(w.derived, cells);
  return { type: k >= 0 ? types[k] : null, chosen: null };
}

// 有没有哪一种带“哪些自然的河是这一种”的规则
export const hasRules = (w: World) => (w.small.riverTypes ?? []).some((t) => !!t.scripts?.match);

// 给一条河选类型（choice：类型 id、'plain' 普通的河、null 按规则）的命令；不用改时为 null。
// 画的河改它自己的 type；自然的河固定下来并带上类型（一步：固定、选类型、名字照旧）
export function riverTypeChoiceCommand(w: World, ref: RiverRef, choice: string | null): Command | null {
  const types = w.small.riverTypes ?? [];
  const cur = riverTypeOfRiver(w, ref);
  // 没有规则时“普通的河”就是不选
  const want = choice === PLAIN_RIVER && !hasRules(w) ? null : choice;
  const name = riverInfo(w, ref)?.name;
  const who = name ? `「${name}」` : '这条河';
  const what = want === null ? '按规则' : want === PLAIN_RIVER ? '普通的河' : (types.find((t) => t.id === want)?.name ?? want);
  const label = want === null ? `${who}的类型改回按规则` : `${who}改成${what}`;
  if (ref.kind === 'guide') {
    const g = guideOf(w, ref.id);
    if (!g || (g.type ?? null) === want) return null;
    return { op: 'update_guide', id: g.id, patch: { type: want }, label };
  }
  if (want === null) return null;
  if (want !== PLAIN_RIVER && cur.type?.id === want) return null;
  const pin = pinCommand(w, ref.cell);
  if (!pin || pin.cmd.op !== 'add_guide') return null;
  return { ...pin.cmd, guide: { ...pin.cmd.guide, type: want }, label };
}

// ---------- 选类型的按钮与弹出的列表 ----------

const PLAIN_COLOR = riverStroke('realistic');

function Swatch({ t }: { t: RiverType | null }) {
  return <span class="swatch" style={{ background: t ? t.color : PLAIN_COLOR }} />;
}

// 底部条上的按钮：“血河”（色块）。点开是 RiverTypeMenu。世界里没有河流类型时不显示
export function RiverTypeButton({ type, auto }: { type: RiverType | null; auto?: boolean }) {
  const w = world.value;
  if (!w?.small.riverTypes?.length) return null;
  return (
    <button
      class={`bar-btn ${openPanel.value === 'rivertype' ? 'on' : ''}`}
      data-panel="rivertype"
      onClick={() => togglePanel('rivertype')}
      title={auto ? '是哪一种河（现在是按规则判断的）' : '是哪一种河'}
    >
      <Swatch t={type} /> {type ? type.name : '普通的河'}
      {auto && type ? <span class="muted small">（按规则）</span> : null}
    </button>
  );
}

// 画河工具条上：新画的河是哪一种
export function NewRiverTypePick() {
  const w = world.value;
  const t = w?.small.riverTypes?.find((x) => x.id === options.value.riverType) ?? null;
  return <RiverTypeButton type={t} />;
}

function MenuRow({ t, label, on, hint, onPick }: { t: RiverType | null; label: string; on: boolean; hint?: string; onPick: () => void }) {
  return (
    <button class={`menu-row ${on ? 'on' : ''}`} title={hint} onClick={onPick}>
      <Swatch t={t} />
      <span>{label}</span>
      {t?.style && t.style !== 'solid' ? <span class="muted small">{RIVER_STYLE_LABEL[t.style]}</span> : null}
    </button>
  );
}

// 弹出的列表：选中了一条河时给它选，否则是新画的河用哪一种
export function RiverTypeMenu() {
  const w = world.value;
  if (!w) return null;
  const types = w.small.riverTypes ?? [];
  const sel = selectedRiver.value;
  if (!sel) {
    const cur = options.value.riverType;
    const pick = (id: string) => {
      setOptions({ riverType: id });
      openPanel.value = null;
    };
    return (
      <div class="menu">
        <MenuRow t={null} label="普通的河" on={!types.some((t) => t.id === cur)} hint="没选类型的河按各类型的规则判断（哪些自然的河是这一种）" onPick={() => pick('')} />
        {types.map((t) => (
          <MenuRow t={t} label={t.name} on={cur === t.id} onPick={() => pick(t.id)} />
        ))}
      </div>
    );
  }
  const cur = riverTypeOfRiver(w, sel);
  const rules = hasRules(w);
  const choose = (choice: string | null) => {
    openPanel.value = null;
    const cmd = riverTypeChoiceCommand(w, sel, choice);
    if (!cmd) return;
    if (sel.kind === 'natural') void execAndSelect(cmd, '正在计算河流…');
    else void exec(cmd, '正在计算河流…');
  };
  return (
    <div class="menu">
      {rules && (
        <MenuRow
          t={cur.chosen === null ? cur.type : null}
          label={`按规则${cur.chosen === null ? `（现在是${cur.type ? cur.type.name : '普通的河'}）` : ''}`}
          on={cur.chosen === null}
          hint="按各类型的“哪些自然的河是这一种”判断"
          onPick={() => choose(null)}
        />
      )}
      <MenuRow t={null} label="普通的河" on={rules ? cur.chosen === 'plain' : !cur.type} onPick={() => choose(PLAIN_RIVER)} />
      {types.map((t) => (
        <MenuRow t={t} label={t.name} on={cur.chosen === 'type' && cur.type?.id === t.id} onPick={() => choose(t.id)} />
      ))}
      {sel.kind === 'natural' && <p class="muted small">给自然的河选类型会把它固定下来（走向不再随地形挪），名字照旧。</p>}
    </div>
  );
}

// ---------- 编辑：排队按最新的样子做出命令 ----------
// 大星球上一步要算一会儿：连着改几项时，后一步按前一步算完之后世界上的这种类型做出整份（set_river_type 是整份换掉）

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;

export const riverTypeEditsSettled = () => queued === 0 && editsIdle();
export async function settleRiverTypeEdits(): Promise<void> {
  while (!riverTypeEditsSettled()) {
    await tail;
    await whenEditsIdle();
  }
}

export function queueRiverTypeEdit(id: string, label: string, make: (t: RiverType) => RiverType | null): Promise<boolean> {
  const epoch = worldEpoch.value;
  queued++;
  const job = tail.then(async () => {
    await whenEditsIdle();
    if (worldEpoch.value !== epoch) return false;
    const t = world.value?.small.riverTypes?.find((x) => x.id === id);
    const next = t ? make(structuredClone(t)) : null;
    return next ? exec({ op: 'set_river_type', type: next }, label) : false;
  });
  tail = job.then(
    () => void queued--,
    () => void queued--,
  );
  return job;
}

// 去掉值为 undefined 的项（存进命令的 JSON 里不留空项）
function clean(t: RiverType): RiverType {
  const out = { ...t } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (t.bank) {
    const b = { ...t.bank } as Record<string, unknown>;
    for (const k of Object.keys(b)) if (b[k] === undefined || b[k] === 0) delete b[k];
    out.bank = b;
  }
  return out as RiverType;
}

// match 脚本换成 src（空的就去掉）
export function riverTypeScriptCommand(t: RiverType, src: string): Command {
  const s = normScript(src);
  const next = { ...t } as RiverType;
  if (s) next.scripts = { match: { api: SCRIPT_API, src: s } };
  else delete next.scripts;
  return { op: 'set_river_type', type: next };
}

// 提交规则脚本。信任与生态的脚本框一样只记框里写的这一段（同一步里被换掉的中间版本会去掉，见 trust.ts 的 trustDraft）；
// revert：出错后换回旧写法，不报给信任列表
async function applyMatch(id: string, src: string, mode: ApplyMode, revert = false): Promise<ApplyResult> {
  const t = world.value?.small.riverTypes?.find((x) => x.id === id);
  if (!t) return { ok: false, error: '这种河已经不在了' };
  const before = t.scripts?.match?.src ?? '';
  const cmd = trustHandledElsewhere(riverTypeScriptCommand(t, src));
  const ok = mode === 'exec' ? await exec(cmd, '正在计算河流…') : await replaceLast(cmd, '正在计算河流…');
  if (ok) {
    if (!revert) noteScriptCommitted({ species: `river:${id}`, kind: 'match', src: normScript(src), before, mode });
    return { ok: true };
  }
  const x = toast.value;
  return { ok: false, error: x?.error ? x.text : '没有改成' };
}

// 世界上这种河的 match 脚本现在出的错
function matchIssue(id: string): ScriptProblem | null {
  const hit = world.value?.derived.scriptIssues?.find((i) => i.kind === 'match' && i.id === id);
  return hit ? problemOfIssue(hit) : null;
}

// 新的一种：id 不与已有的重复；颜色轮着取
const NEW_COLORS = ['#b03a2e', '#2a7fbf', '#7a4fb0', '#c47f17', '#2e8b57', '#d4508a'];
export function newRiverType(w: World): RiverType {
  const ids = new Set((w.small.riverTypes ?? []).map((t) => t.id));
  let k = 1;
  while (ids.has(`river-type-${k}`)) k++;
  return { id: `river-type-${k}`, name: `新的河 ${k}`, color: NEW_COLORS[(k - 1) % NEW_COLORS.length] };
}

// ---------- “水系 ⋯”里的“河流类型” ----------

const WLO = 0.3;
const WHI = 3;
const RLO = 10;
const RHI = 1000;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const logPos = (v: number, lo: number, hi: number) => clamp01(Math.log(v / lo) / Math.log(hi / lo));
const logAt = (p: number, lo: number, hi: number) => lo * Math.pow(hi / lo, p);

// 拖着的滑块：先显示拖到的值，松手提交
function TypeSlider({ label, value, pos, at, text, title, commit }: {
  label: string;
  value: number;
  pos: (v: number) => number;
  at: (p: number) => number;
  text: (v: number) => string;
  title?: string;
  commit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [value]);
  const cur = draft ?? value;
  return (
    <DragSlider
      label={label}
      pos={pos(cur)}
      text={text(cur)}
      title={title}
      onDraft={(p) => setDraft(at(p))}
      onCommit={(p) => {
        const v = at(p);
        setDraft(v);
        if (v !== value) commit(v);
      }}
      onCancel={() => setDraft(null)}
    />
  );
}

const fmtSigned = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

function TypeEditor({ w, t }: { w: World; t: RiverType }) {
  const edit = (label: string, make: (x: RiverType) => RiverType | null) => void queueRiverTypeEdit(t.id, label, (x) => {
    const next = make(x);
    return next ? clean(next) : null;
  });
  const [names, setNames] = useState((t.names ?? []).map((n) => n.p).join('\n'));
  useEffect(() => setNames((t.names ?? []).map((n) => n.p).join('\n')), [t.id, JSON.stringify(t.names ?? null)]);
  const namesBad = names.split('\n').map((x) => x.trim()).filter(Boolean).find((p) => p.length > 40);
  const saveNames = () => {
    const list = names.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20);
    if (namesBad) return;
    const old = (t.names ?? []).map((n) => n.p);
    if (JSON.stringify(old) === JSON.stringify(list)) return;
    edit(`改了「${t.name}」的起名模板`, (x) => {
      const keep = new Map((x.names ?? []).map((n) => [n.p, n]));
      return { ...x, names: list.length ? list.map((p) => keep.get(p) ?? { p }) : undefined };
    });
  };
  const bank = t.bank;
  const dT = bank?.dT ?? 0;
  const dPpct = Math.round((Math.exp(bank?.dP ?? 0) - 1) * 100);
  const setBank = (patch: Partial<NonNullable<RiverType['bank']>>, label: string) =>
    edit(label, (x) => ({ ...x, bank: { radiusKm: x.bank?.radiusKm ?? 200, ...x.bank, ...patch } }));
  return (
    <div class="river-type-editor">
      <div class="row">
        <input type="color" value={t.color} title="颜色" onChange={(e) => edit(`改了「${t.name}」的颜色`, (x) => ({ ...x, color: (e.target as HTMLInputElement).value }))} />
        <NameBox value={t.name} onCommit={(v) => edit(`「${t.name}」改名为「${v}」`, (x) => ({ ...x, name: v }))} />
      </div>
      <div class="row">
        <span class="hs-label">画法</span>
        <Seg<RiverStyle>
          value={t.style ?? 'solid'}
          options={RIVER_STYLES.map((s) => [s, RIVER_STYLE_LABEL[s]])}
          onChange={(v) => edit(`「${t.name}」改成${RIVER_STYLE_LABEL[v]}`, (x) => ({ ...x, style: v === 'solid' ? undefined : v }))}
        />
      </div>
      <div class="row">
        <TypeSlider
          label="粗细"
          value={t.width ?? 1}
          pos={(v) => logPos(v, WLO, WHI)}
          at={(p) => {
            const v = Math.round(logAt(p, WLO, WHI) * 20) / 20;
            return Math.abs(v - 1) < 0.06 ? 1 : v;
          }}
          text={(v) => `${Math.round(v * 100)}%`}
          title="这种河画得比普通的河粗多少（只影响画法）"
          commit={(v) => edit(`「${t.name}」的粗细改成 ${Math.round(v * 100)}%`, (x) => ({ ...x, width: v === 1 ? undefined : v }))}
        />
      </div>
      <h5>两岸</h5>
      <p class="muted small">离这种河越近影响越大，到范围的边上就没有了。生态的条件、脚本里也能用“靠近{t.name}”。</p>
      <div class="row">
        <TypeSlider
          label="范围"
          value={bank?.radiusKm ?? 0}
          pos={(v) => (v ? logPos(v, RLO, RHI) : 0)}
          at={(p) => Math.round(logAt(p, RLO, RHI) / 10) * 10 || 10}
          text={(v) => (v ? `${v} km` : '自动')}
          commit={(v) => setBank({ radiusKm: v }, `改了「${t.name}」两岸的范围`)}
        />
      </div>
      <div class="row">
        <TypeSlider
          label="冷暖"
          value={dT}
          pos={(v) => (v + 10) / 20}
          at={(p) => Math.round((p * 20 - 10) * 2) / 2}
          text={(v) => (v ? `${fmtSigned(v)} °C` : '不变')}
          title="让两岸变暖、变冷"
          commit={(v) => setBank({ dT: v || undefined }, `改了「${t.name}」两岸的冷暖`)}
        />
      </div>
      <div class="row">
        <TypeSlider
          label="干湿"
          value={dPpct}
          pos={(v) => (Math.log(1 + v / 100) + 1.5) / 3}
          at={(p) => Math.round((Math.exp(p * 3 - 1.5) - 1) * 20) * 5}
          text={(v) => (v ? `雨水 ${fmtSigned(v, 0)}%` : '不变')}
          title="让两岸的雨水变多、变少"
          commit={(v) => setBank({ dP: v ? Math.max(-1.5, Math.min(1.5, Math.log(1 + v / 100))) : undefined }, `改了「${t.name}」两岸的干湿`)}
        />
      </div>
      <h5>起名</h5>
      <p class="muted small">每行一个模板，比如 {'{color}血河'}；不写时按普通的河起名。</p>
      <textarea class="names-box" rows={3} value={names} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={saveNames} />
      {namesBad && <p class="small warn-text">“{namesBad.slice(0, 12)}…”太长了，最多 40 个字</p>}
      <ScriptBox
        key={`${worldEpoch.value}:${t.id}:match`}
        kind="match"
        label="哪些自然的河是这一种"
        hint="每条河算一次：海拔、坡度、气温取整条河的平均，流量取最大，位置取源头。返回真就是这一种"
        value={t.scripts?.match?.src ?? ''}
        issue={() => matchIssue(t.id)}
        apply={(src, mode, revert) => applyMatch(t.id, src, mode, revert)}
        idle={riverTypeEditsSettled}
        settle={settleRiverTypeEdits}
        fields={Object.keys(w.causes.fields)}
        onShowCell={showCell}
      />
      <div class="row wrap">
        <button
          class="small danger"
          onClick={() => void exec({ op: 'remove_river_type', id: t.id }, '正在计算河流…')}
          title="删掉这种河：选了它的河变回普通的河"
        >
          <Trash2 size={14} /> 删掉这种河
        </button>
      </div>
    </div>
  );
}

function NameBox({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const x = v.trim().slice(0, 12);
    if (x && x !== value) onCommit(x);
    else setV(value);
  };
  return (
    <input
      class="grow"
      value={v}
      maxLength={12}
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function RiverTypesSection() {
  const w = world.value;
  const [open, setOpen] = useState<string | null>(null);
  // 顶部“脚本出错了”的“编辑”：展开那一种
  const req = riverTypeEditorRequest.value;
  useEffect(() => {
    if (!req) return;
    setOpen(req);
    riverTypeEditorRequest.value = null;
  }, [req]);
  if (!w) return null;
  const types = w.small.riverTypes ?? [];
  const samples = FANTASY_RIVER_TYPES.filter((x) => !types.some((t) => t.id === x.id));
  const add = async (t: RiverType) => {
    const ok = await exec({ op: 'set_river_type', type: t }, '正在计算河流…');
    if (ok) setOpen(t.id);
  };
  return (
    <section>
      <h5>河流类型</h5>
      {types.length === 0 && <p class="muted small">血河、晶川……每种有自己的颜色、画法、两岸的影响和起名的样子。画河时、选中一条河时都能选。</p>}
      {types.length > 0 && (
        <div class="feature-list">
          {types.map((t) => (
            <>
              <div class={`feature-row river-row ${open === t.id ? 'on' : ''}`} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span>
                  <span class="swatch" style={{ background: riverTypeColor(t, 'realistic') }} /> {riverTypeOwner(t)}
                </span>
                <span class="muted small">
                  {RIVER_STYLE_LABEL[t.style ?? 'solid']}
                  {t.scripts?.match ? ' · 有规则' : ''}
                </span>
              </div>
              {open === t.id && <TypeEditor w={w} t={t} />}
            </>
          ))}
        </div>
      )}
      <div class="row wrap">
        <button class="small" onClick={() => void add(newRiverType(w))}>
          <Plus size={14} /> 新建
        </button>
        {samples.map((x) => (
          <button class="small" title={`加上示例里的「${x.name}」`} onClick={() => void add(structuredClone(x))}>
            <span class="swatch" style={{ background: x.color }} /> {x.name}
          </button>
        ))}
      </div>
    </section>
  );
}
