import { ChevronDown, Plus, Trash2 } from 'lucide-preact';
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Command } from '../../../core/commands';
import { LAKE_STYLES, LAKE_STYLE_LABEL } from '../../../core/lake-types';
import { FANTASY_LAKE_TYPES } from '../../../core/packs/fantasy-lakes';
import { FANTASY_RIVER_TYPES } from '../../../core/packs/fantasy-rivers';
import { RIVER_STYLES, RIVER_STYLE_LABEL } from '../../../core/river-types';
import { SCRIPT_API } from '../../../core/script';
import { type WaterType, bankRadiusKm, waterTypeOwner } from '../../../core/water-types';
import type { World } from '../../../core/world';
import {
  type PanelId,
  editsIdle,
  exec,
  openPanel,
  replaceLast,
  toast,
  togglePanel,
  trustHandledElsewhere,
  waterTypeEditorRequest,
  whenEditsIdle,
  world,
  worldEpoch,
} from '../../state';
import { Seg } from '../common';
import { noteScriptCommitted, showCell } from '../editor-hooks';
import { ScriptBox } from '../ScriptBox';
import { type ApplyMode, type ApplyResult, type ScriptProblem, normScript, problemOfIssue } from '../script-commit';
import { lakeTypeColor } from '../../render/colors';
import { riverStroke, riverTypeColor } from '../../render/overlay';
import { DragSlider } from './rivers';

// 水体类型（河流类型、湖泊类型）共用的界面：底部条上“新画的河：血河 ▾”“这个湖：晶湖 ▾”的按钮、弹出的列表（最后一项“新建类型…”），
// “水系 ⋯”里的“水体类型”（河 / 湖两栏，同一个编辑器）

export type WaterKind = 'river' | 'lake';

interface KindDef {
  kind: WaterKind;
  noun: '河' | '湖';
  // “河流类型”“湖泊类型”
  title: string;
  styles: readonly string[];
  styleLabel: Record<string, string>;
  // 有没有“粗细”（只有河有）
  width: boolean;
  list(w: World): readonly WaterType[];
  set(t: WaterType): Command;
  remove(id: string): Command;
  busy: string;
  samples: readonly WaterType[];
  idPrefix: string;
  matchLabel: string;
  matchHint: string;
  intro: string;
  namesHint: string;
}

const KINDS: Record<WaterKind, KindDef> = {
  river: {
    kind: 'river',
    noun: '河',
    title: '河流类型',
    styles: RIVER_STYLES,
    styleLabel: RIVER_STYLE_LABEL,
    width: true,
    list: (w) => w.small.riverTypes ?? [],
    set: (t) => ({ op: 'set_river_type', type: t as never }),
    remove: (id) => ({ op: 'remove_river_type', id }),
    busy: '正在计算河流…',
    samples: FANTASY_RIVER_TYPES,
    idPrefix: 'river-type',
    matchLabel: '哪些自然的河是这一种',
    matchHint: '每条河算一次：海拔、坡度、气温取整条河的平均，流量取最大，位置取源头。返回真就是这一种',
    intro: '血河、晶川……每种有自己的颜色、画法、两岸的影响和起名的样子。画河时、选中一条河时都能选。',
    namesHint: '{color}血河',
  },
  lake: {
    kind: 'lake',
    noun: '湖',
    title: '湖泊类型',
    styles: LAKE_STYLES,
    styleLabel: LAKE_STYLE_LABEL,
    width: false,
    list: (w) => w.small.lakeTypes ?? [],
    set: (t) => ({ op: 'set_lake_type', type: t as never }),
    remove: (id) => ({ op: 'remove_lake_type', id }),
    busy: '正在计算湖泊…',
    samples: FANTASY_LAKE_TYPES,
    idPrefix: 'lake-type',
    matchLabel: '哪些自然的湖是这一种',
    matchHint: '每个湖算一次：海拔、气温取整个湖的平均，另有湖面积、入湖水量、干湖、放的湖。返回真就是这一种',
    intro: '血池、晶湖……每种有自己的颜色、画法、岸边的影响和起名的样子。放湖时、选中一个湖时都能选。',
    namesHint: '{color}血池',
  },
};

// 一种画出来的颜色（地图集风格用 atlasColor）
const typeColor = (kind: WaterKind, t: WaterType, style: 'realistic' | 'atlas' = 'realistic') =>
  kind === 'lake' ? lakeTypeColor(t, style) : riverTypeColor(t, style);

// 普通的河、湖的颜色（列表里的色块）
const PLAIN_COLOR: Record<WaterKind, string> = { river: riverStroke('realistic'), lake: 'rgb(70, 125, 175)' };

function TypeSwatch({ kind, t }: { kind: WaterKind; t: WaterType | null }) {
  return <span class="swatch" style={{ background: t ? typeColor(kind, t) : PLAIN_COLOR[kind] }} />;
}

// 底部条上的按钮：“新画的河：血河 ▾”“这个湖：普通 ▾”。总是显示（世界里还没有类型时是“普通”，列表里能新建）。
// auto：现在是按各类型的规则判断出来的
// plainText：没有类型时写什么（新画的河、新放的湖按规则时写“按规则”）
export function TypeButton({ kind, prefix, type, auto, panel, plainText = '普通' }: { kind: WaterKind; prefix: string; type: WaterType | null; auto?: boolean; panel: PanelId; plainText?: string }) {
  const noun = KINDS[kind].noun;
  return (
    <button
      class={`bar-btn ${openPanel.value === panel ? 'on' : ''}`}
      data-panel={panel}
      onClick={() => togglePanel(panel)}
      title={auto ? `是哪一种${noun}（现在是按规则判断的）` : `是哪一种${noun}`}
    >
      <span class="muted">{prefix}：</span>
      <TypeSwatch kind={kind} t={type} /> {type ? type.name : plainText}
      {auto && type ? <span class="muted small">（按规则）</span> : null}
      <ChevronDown size={13} />
    </button>
  );
}

export interface MenuItem {
  t: WaterType | null;
  label: string;
  on: boolean;
  hint?: string;
  onPick: () => void;
}

function MenuRow({ kind, item }: { kind: WaterKind; item: MenuItem }) {
  const t = item.t;
  return (
    <button class={`menu-row ${item.on ? 'on' : ''}`} title={item.hint} onClick={item.onPick}>
      <TypeSwatch kind={kind} t={t} />
      <span>{item.label}</span>
      {t?.style && t.style !== 'solid' ? <span class="muted small">{KINDS[kind].styleLabel[t.style]}</span> : null}
    </button>
  );
}

// 弹出的列表：几行选择，最后一项“新建类型…”（新建一种、用上它，并打开它的编辑）
export function TypeMenu({ kind, items, onNew, note }: { kind: WaterKind; items: MenuItem[]; onNew: () => void; note?: string }) {
  return (
    <div class="menu">
      {items.map((it) => (
        <MenuRow key={it.label} kind={kind} item={it} />
      ))}
      <button class="menu-row" onClick={onNew} title={`新建一种${KINDS[kind].noun}，用上它，并打开它的设置`}>
        <Plus size={14} />
        <span>新建类型…</span>
      </button>
      {note && <p class="muted small">{note}</p>}
    </div>
  );
}

// 新的一种：id 不与已有的重复；颜色轮着取
const NEW_COLORS = ['#b03a2e', '#2a7fbf', '#7a4fb0', '#c47f17', '#2e8b57', '#d4508a'];
export function newWaterType(w: World, kind: WaterKind): WaterType {
  const def = KINDS[kind];
  const ids = new Set(def.list(w).map((t) => t.id));
  let k = 1;
  while (ids.has(`${def.idPrefix}-${k}`)) k++;
  // 新建的默认不自然生成（第十二轮）：只用在画的河、选了它的河（湖）上，打开“自然生成”才按条件自己出现
  return { id: `${def.idPrefix}-${k}`, name: `新的${def.noun} ${k}`, color: NEW_COLORS[(k - 1) % NEW_COLORS.length], natural: false };
}

// 新建一种并用上：then 是用上它的命令（新画的河、新放的湖只改选项，没有命令）。一整步，然后打开它的编辑
export async function createAndUse(kind: WaterKind, use: ((id: string) => Command | null) | null, after?: (id: string) => void): Promise<void> {
  const w = world.value;
  if (!w) return;
  openPanel.value = null;
  const t = newWaterType(w, kind);
  const def = KINDS[kind];
  const then = use?.(t.id) ?? null;
  const cmd: Command = then ? { op: 'batch', label: `新建了${def.title}「${t.name}」并用上`, commands: [def.set(t), then] } : def.set(t);
  const ok = await exec(cmd, def.busy);
  if (!ok) return;
  after?.(t.id);
  waterTypeEditorRequest.value = { kind, id: t.id };
  openPanel.value = 'cat:water';
}

// ---------- 编辑：排队按最新的样子做出命令 ----------
// 大星球上一步要算一会儿：连着改几项时，后一步按前一步算完之后世界上的这种类型做出整份（set_*_type 是整份换掉）

let tail: Promise<unknown> = Promise.resolve();
let queued = 0;

const typeEditsSettled = () => queued === 0 && editsIdle();
async function settleTypeEdits(): Promise<void> {
  while (!typeEditsSettled()) {
    await tail;
    await whenEditsIdle();
  }
}

function queueTypeEdit(kind: WaterKind, id: string, label: string, make: (t: WaterType) => WaterType | null): Promise<boolean> {
  const epoch = worldEpoch.value;
  queued++;
  const job = tail.then(async () => {
    await whenEditsIdle();
    const w = world.value;
    if (worldEpoch.value !== epoch || !w) return false;
    const t = KINDS[kind].list(w).find((x) => x.id === id);
    const next = t ? make(structuredClone(t)) : null;
    return next ? exec(KINDS[kind].set(next), label) : false;
  });
  tail = job.then(
    () => void queued--,
    () => void queued--,
  );
  return job;
}

// 去掉值为 undefined 的项（存进命令的 JSON 里不留空项）
function clean(t: WaterType): WaterType {
  const out = { ...t } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (t.bank) {
    const b = { ...t.bank } as Record<string, unknown>;
    for (const k of Object.keys(b)) if (b[k] === undefined || b[k] === 0) delete b[k];
    out.bank = b;
  }
  return out as unknown as WaterType;
}

// match 脚本换成 src（空的就去掉）
export function typeScriptCommand(kind: WaterKind, t: WaterType, src: string): Command {
  const s = normScript(src);
  const next = { ...t } as WaterType;
  if (s) next.scripts = { match: { api: SCRIPT_API, src: s } };
  else delete next.scripts;
  return KINDS[kind].set(next);
}

// 提交规则脚本。信任与生态的脚本框一样只记框里写的这一段（同一步里被换掉的中间版本会去掉，见 trust.ts 的 trustDraft）；
// revert：出错后换回旧写法，不报给信任列表
async function applyMatch(kind: WaterKind, id: string, src: string, mode: ApplyMode, revert = false): Promise<ApplyResult> {
  const w = world.value;
  const def = KINDS[kind];
  const t = w ? def.list(w).find((x) => x.id === id) : undefined;
  if (!t) return { ok: false, error: `这种${def.noun}已经不在了` };
  const before = t.scripts?.match?.src ?? '';
  const cmd = trustHandledElsewhere(typeScriptCommand(kind, t, src));
  const ok = mode === 'exec' ? await exec(cmd, def.busy) : await replaceLast(cmd, def.busy);
  if (ok) {
    if (!revert) noteScriptCommitted({ species: `${kind}:${id}`, kind: 'match', src: normScript(src), before, mode });
    return { ok: true };
  }
  const x = toast.value;
  return { ok: false, error: x?.error ? x.text : '没有改成' };
}

// 世界上这种的 match 脚本现在出的错
function matchIssue(id: string, name: string): ScriptProblem | null {
  const list = world.value?.derived.scriptIssues?.filter((i) => i.kind === 'match' && i.id === id) ?? [];
  const hit = list.find((i) => i.owner === name) ?? list[0];
  return hit ? problemOfIssue(hit) : null;
}

// ---------- “水系 ⋯”里的“水体类型” ----------

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

function TypeEditor({ w, kind, t }: { w: World; kind: WaterKind; t: WaterType }) {
  const def = KINDS[kind];
  const shore = kind === 'river' ? '两岸' : '湖岸';
  const edit = (label: string, make: (x: WaterType) => WaterType | null) => void queueTypeEdit(kind, t.id, label, (x) => {
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
  const width = (t as { width?: number }).width;
  // 第一次设岸边的冷暖、干湿时，范围取现在“自动”的那么大（靠近这种河、湖的远近不跟着变）
  const autoRadius = (x: WaterType) => Math.max(RLO, Math.min(RHI, Math.round(bankRadiusKm(w, x) / 10) * 10));
  const setBank = (patch: Partial<NonNullable<WaterType['bank']>>, label: string) =>
    edit(label, (x) => ({ ...x, bank: { radiusKm: x.bank?.radiusKm ?? autoRadius(x), ...x.bank, ...patch } }));
  return (
    <div class="river-type-editor">
      <div class="row">
        <input type="color" value={t.color} title="颜色" onChange={(e) => edit(`改了「${t.name}」的颜色`, (x) => ({ ...x, color: (e.target as HTMLInputElement).value }))} />
        <NameBox value={t.name} onCommit={(v) => edit(`「${t.name}」改名为「${v}」`, (x) => ({ ...x, name: v }))} />
      </div>
      <div class="row">
        <span class="hs-label">画法</span>
        <Seg<string>
          value={t.style ?? 'solid'}
          options={def.styles.map((s) => [s, def.styleLabel[s]])}
          onChange={(v) => edit(`「${t.name}」改成${def.styleLabel[v]}`, (x) => ({ ...x, style: v === 'solid' ? undefined : v }))}
        />
      </div>
      {def.width && (
        <div class="row">
          <TypeSlider
            label="粗细"
            value={width ?? 1}
            pos={(v) => logPos(v, WLO, WHI)}
            at={(p) => {
              const v = Math.round(logAt(p, WLO, WHI) * 20) / 20;
              return Math.abs(v - 1) < 0.06 ? 1 : v;
            }}
            text={(v) => `${Math.round(v * 100)}%`}
            title="这种河画得比普通的河粗多少（只影响画法）"
            commit={(v) => edit(`「${t.name}」的粗细改成 ${Math.round(v * 100)}%`, (x) => ({ ...x, width: v === 1 ? undefined : v }) as WaterType)}
          />
        </div>
      )}
      <h5>{shore}</h5>
      <p class="muted small">
        离这种{def.noun}越近影响越大，到范围的边上就没有了。生态的条件、脚本里也能用“靠近{t.name}”。
      </p>
      <div class="row">
        <TypeSlider
          label="范围"
          value={bank?.radiusKm ?? 0}
          pos={(v) => logPos(v || autoRadius(t), RLO, RHI)}
          at={(p) => Math.round(logAt(p, RLO, RHI) / 10) * 10 || 10}
          text={(v) => (v ? `${v} km` : `自动（约 ${autoRadius(t)} km）`)}
          commit={(v) => setBank({ radiusKm: v }, `改了「${t.name}」${shore}的范围`)}
        />
      </div>
      <div class="row">
        <TypeSlider
          label="冷暖"
          value={dT}
          pos={(v) => (v + 10) / 20}
          at={(p) => Math.round((p * 20 - 10) * 2) / 2}
          text={(v) => (v ? `${fmtSigned(v)} °C` : '不变')}
          title={`让${shore}变暖、变冷`}
          commit={(v) => setBank({ dT: v || undefined }, `改了「${t.name}」${shore}的冷暖`)}
        />
      </div>
      <div class="row">
        <TypeSlider
          label="干湿"
          value={dPpct}
          pos={(v) => (Math.log(1 + v / 100) + 1.5) / 3}
          at={(p) => Math.round((Math.exp(p * 3 - 1.5) - 1) * 20) * 5}
          text={(v) => (v ? `雨水 ${fmtSigned(v, 0)}%` : '不变')}
          title={`让${shore}的雨水变多、变少`}
          commit={(v) => setBank({ dP: v ? Math.max(-1.5, Math.min(1.5, Math.log(1 + v / 100))) : undefined }, `改了「${t.name}」${shore}的干湿`)}
        />
      </div>
      <h5>起名</h5>
      <p class="muted small">
        每行一个模板，比如 {def.namesHint}；不写时按普通的{def.noun}起名。
      </p>
      <textarea class="names-box" rows={3} value={names} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={saveNames} />
      {namesBad && <p class="small warn-text">“{namesBad.slice(0, 12)}…”太长了，最多 40 个字</p>}
      <NaturalBox w={w} kind={kind} t={t} edit={edit} />
      <ScriptBox
        key={`${worldEpoch.value}:${kind}:${t.id}:match`}
        kind="match"
        scope={kind}
        label={def.matchLabel}
        hint={def.matchHint}
        value={t.scripts?.match?.src ?? ''}
        issue={() => matchIssue(t.id, t.name)}
        apply={(src, mode, revert) => applyMatch(kind, t.id, src, mode, revert)}
        idle={typeEditsSettled}
        settle={settleTypeEdits}
        fields={Object.keys(w.causes.fields)}
        onShowCell={showCell}
      />
      <div class="row wrap">
        <button class="small danger" onClick={() => void exec(def.remove(t.id), def.busy)} title={`删掉这种${def.noun}：选了它的${def.noun}变回普通的${def.noun}`}>
          <Trash2 size={14} /> 删掉这种{def.noun}
        </button>
      </div>
    </div>
  );
}

// 第十二轮：自然生成的开关、只在这些生态里出现
function NaturalBox({ w, kind, t, edit }: { w: World; kind: WaterKind; t: WaterType; edit: (label: string, make: (x: WaterType) => WaterType | null) => void }) {
  const noun = KINDS[kind].noun;
  const on = t.natural !== false;
  const picked = new Set(t.biomes ?? []);
  const script = !!t.scripts?.match?.src;
  const where = kind === 'river' ? '流经的格' : '湖岸一圈';
  const hint = !on
    ? `关着：只用在${kind === 'river' ? '画的河、选了它的河' : '放的湖、选了它的湖'}上。`
    : !script && !picked.size
      ? `还没有条件：选下面“只在这些生态里”，或者写规则，${noun}才会自己变成这一种。`
      : !script
        ? `选的生态里的${noun}都是这一种（${where}至少一半是这些生态）。`
        : picked.size
          ? `规则说是、并且${where}至少一半是选的生态的${noun}是这一种。`
          : `规则说是的${noun}是这一种。`;
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // 按生态的先后存（结果与点的先后无关）
    const list = w.small.species.map((s) => s.id).filter((x) => next.has(x));
    const sp = w.small.species.find((s) => s.id === id);
    edit(`「${t.name}」${next.has(id) ? '可以' : '不再'}出现在${sp?.name || id}里`, (x) => ({ ...x, biomes: list.length ? list : undefined }));
  };
  return (
    <>
      <h5>自己出现</h5>
      <label class="check">
        <input type="checkbox" checked={on} onChange={() => edit(on ? `「${t.name}」不再自然生成` : `「${t.name}」自然生成`, (x) => ({ ...x, natural: !on }))} />
        自然生成：在地图上按条件自己出现
      </label>
      <p class="muted small">{hint}</p>
      <details>
        <summary>
          只在这些生态里出现（{picked.size ? `${picked.size} 种` : '不限'}）
        </summary>
        <div class="biome-picks">
          {w.small.species.map((sp) => (
            <label class="check" key={sp.id}>
              <input type="checkbox" checked={picked.has(sp.id)} onChange={() => toggle(sp.id)} />
              <span class="swatch" style={{ background: sp.color }} /> {sp.name || sp.id}
            </label>
          ))}
        </div>
        <p class="muted small">规则里也能用 biome('生态 id')（{where}里这种生态占多少）、dominantBiome(){kind === 'river' ? '、biomeAtSource()、biomeAtMouth()' : ''}。</p>
      </details>
    </>
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

// 一栏：这一类的列表、新建、示例
function TypeList({ w, kind, open, setOpen }: { w: World; kind: WaterKind; open: string | null; setOpen: (id: string | null) => void }) {
  const def = KINDS[kind];
  const types = def.list(w);
  const samples = def.samples.filter((x) => !types.some((t) => t.id === x.id));
  const add = async (t: WaterType) => {
    const ok = await exec(def.set(t), def.busy);
    if (ok) setOpen(t.id);
  };
  return (
    <>
      {types.length === 0 && <p class="muted small">{def.intro}</p>}
      {types.length > 0 && (
        <div class="feature-list">
          {types.map((t) => (
            <Fragment key={t.id}>
              <div class={`feature-row river-row ${open === t.id ? 'on' : ''}`} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span>
                  <TypeSwatch kind={kind} t={t} /> {waterTypeOwner(t)}
                </span>
                <span class="muted small">
                  {def.styleLabel[t.style ?? 'solid']}
                  {t.natural === false ? ' · 不自然生成' : t.scripts?.match || t.biomes?.length ? ' · 自己出现' : ''}
                </span>
              </div>
              {open === t.id && <TypeEditor w={w} kind={kind} t={t} />}
            </Fragment>
          ))}
        </div>
      )}
      <div class="row wrap">
        <button class="small" onClick={() => void add(newWaterType(w, kind))}>
          <Plus size={14} /> 新建
        </button>
        {samples.map((x) => (
          <button key={x.id} class="small" title={`加上示例里的「${x.name}」`} onClick={() => void add(structuredClone(x))}>
            <TypeSwatch kind={kind} t={x} /> {x.name}
          </button>
        ))}
      </div>
    </>
  );
}

// “水体类型”：河 / 湖两栏，同一个编辑器。打开时在用着放湖工具就先看湖那一栏
// tab、onTab（可选）：哪一栏由外面管（“水系 ⋯”在“湖”那一栏下面列出全部的湖）
export function WaterTypesSection({ initial, tab: outer, onTab }: { initial?: WaterKind; tab?: WaterKind; onTab?: (k: WaterKind) => void }) {
  const w = world.value;
  const [own, setOwn] = useState<WaterKind>(initial ?? 'river');
  const tab = outer ?? own;
  const setTab = (k: WaterKind) => {
    setOwn(k);
    onTab?.(k);
  };
  const [open, setOpen] = useState<string | null>(null);
  // 顶部“脚本出错了”的“编辑”、“新建类型…”：换到那一栏、展开那一种
  const req = waterTypeEditorRequest.value;
  useEffect(() => {
    if (!req) return;
    setTab(req.kind);
    setOpen(req.id);
    waterTypeEditorRequest.value = null;
  }, [req]);
  if (!w) return null;
  const count = (k: WaterKind) => KINDS[k].list(w).length;
  return (
    <section>
      <div class="row">
        <h5 class="grow">水体类型</h5>
        <Seg<WaterKind>
          value={tab}
          options={[
            ['river', `河${count('river') ? ` ${count('river')}` : ''}`],
            ['lake', `湖${count('lake') ? ` ${count('lake')}` : ''}`],
          ]}
          onChange={(v) => {
            setTab(v);
            setOpen(null);
          }}
        />
      </div>
      <TypeList w={w} kind={tab} open={open} setOpen={setOpen} />
    </section>
  );
}
