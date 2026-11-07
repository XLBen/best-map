import { Library, Plus, Trash2 } from 'lucide-preact';
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { FALLBACK_MAP_STYLE, type MapStyle } from '../../../core/map-style';
import { type LakeWhenKey, type WaterType, LAKE_WHEN_KEYS, WHEN_KEYS, WHEN_RANGE, bankRadiusKm, hasWhen, perCellRule, waterTypeOwner } from '../../../core/water-types';
import { withWaterBiome } from '../../../core/water-table';
import type { World } from '../../../core/world';
import { type PanelId, exec, waterTypeEditorRequest, world, worldEpoch } from '../../state';
import { Seg } from '../common';
import { Toggle } from '../components/Toggle';
import { TypePicker, TypePickerButton } from '../shell/TypePicker';
import { openLibraryFor } from '../shell/type-picker';
import { LIBRARY_ADD_LABEL } from '../copy';
import { showCell } from '../editor-hooks';
import { ScriptBox } from '../ScriptBox';
import { type WaterKind, KINDS, newWaterType, settleTypeEdits, typeEditsSettled, queueTypeEdit, clean, applyMatch, matchIssue } from './water-types';
import { lakeTypeColor } from '../../render/colors';
import { riverStroke, riverTypeColor } from '../../render/overlay';
import { RangeSliders } from '../components/RangeSliders';
import { Slider } from '../components/Slider';

// 水体类型（河流类型、湖泊类型）共用的界面：底部条上“新画的河：血河 ▾”“这个湖：晶湖 ▾”的按钮、弹出的列表（最后一项“新建类型…”），
// “水系 ⋯”里的“水体类型”（河 / 湖两栏，同一个编辑器）

// 一种画出来的颜色（列表里的色块照旧按默认的画法——写实——画；画风选了另一种颜色时用 atlasColor）
const typeColor = (kind: WaterKind, t: WaterType, style: MapStyle = FALLBACK_MAP_STYLE) =>
  kind === 'lake' ? lakeTypeColor(t, style) : riverTypeColor(t, style);

// 普通的河、湖的颜色（列表里的色块）
const PLAIN_COLOR: Record<WaterKind, string> = { river: riverStroke(FALLBACK_MAP_STYLE), lake: 'rgb(70, 125, 175)' };

export function TypeSwatch({ kind, t }: { kind: WaterKind; t: WaterType | null }) {
  return <span class="swatch" style={{ background: t ? typeColor(kind, t) : PLAIN_COLOR[kind] }} />;
}

// 底部条上的按钮：“新画的河：血河 ▾”“这个湖：普通 ▾”。总是显示（世界里还没有类型时是“普通”，列表里能新建）。
// auto：现在是按各类型的规则判断出来的
// plainText：没有类型时写什么（新画的河、新放的湖按规则时写“按规则”）
export function TypeButton({ kind, prefix, type, auto, panel, plainText = '普通' }: { kind: WaterKind; prefix: string; type: WaterType | null; auto?: boolean; panel: PanelId; plainText?: string }) {
  const noun = KINDS[kind].noun;
  return (
    <TypePickerButton
      panel={panel}
      prefix={prefix}
      swatch={type ? typeColor(kind, type) : PLAIN_COLOR[kind]}
      name={type ? type.name : plainText}
      auto={auto && !!type}
      title={auto ? `${noun}的类型 · 自动` : `${noun}的类型`}
    />
  );
}

export interface MenuItem {
  t: WaterType | null;
  label: string;
  on: boolean;
  hint?: string;
  onPick: () => void;
}

// 弹出的列表：几行选择，最后一项“新建类型…”（新建一种、用上它，并打开它的编辑）
export function TypeMenu({ kind, items, onNew, note }: { kind: WaterKind; items: MenuItem[]; onNew: () => void; note?: string }) {
  const def = KINDS[kind];
  return (
    <TypePicker
      items={items.map((it) => ({
        ...(it.t ? { id: it.t.id } : {}),
        label: it.label,
        on: it.on,
        hint: it.hint,
        onPick: it.onPick,
        swatch: it.t ? typeColor(kind, it.t) : PLAIN_COLOR[kind],
        meta: it.t?.style && it.t.style !== 'solid' ? def.styleLabel[it.t.style] : undefined,
      }))}
      onNew={onNew}
      newLabel="新建类型…"
      newTitle={`新建一种${def.noun}并用上`}
      library={def.library}
      note={note}
    />
  );
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
    <Slider
      stacked
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
    edit(`修改“${t.name}”的起名模板`, (x) => {
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
        <input type="color" value={t.color} title="颜色" onChange={(e) => edit(`修改“${t.name}”的颜色`, (x) => ({ ...x, color: (e.target as HTMLInputElement).value }))} />
        <NameBox value={t.name} onCommit={(v) => edit(`“${t.name}”改名为“${v}”`, (x) => ({ ...x, name: v }))} />
      </div>
      <div class="row">
        <span class="bar-label">画法</span>
        <Seg<string>
          value={t.style ?? 'solid'}
          options={def.styles.map((s) => [s, def.styleLabel[s]])}
          onChange={(v) => edit(`修改“${t.name}”的画法 · ${def.styleLabel[v]}`, (x) => ({ ...x, style: v === 'solid' ? undefined : v }))}
        />
      </div>
      {def.width && (
        <TypeSlider
          label="粗细"
          value={width ?? 1}
          pos={(v) => logPos(v, WLO, WHI)}
          at={(p) => {
            const v = Math.round(logAt(p, WLO, WHI) * 20) / 20;
            return Math.abs(v - 1) < 0.06 ? 1 : v;
          }}
          text={(v) => `${Math.round(v * 100)}%`}
          title="比普通的河粗多少，只影响画法"
          commit={(v) => edit(`修改“${t.name}”的粗细 · ${Math.round(v * 100)}%`, (x) => ({ ...x, width: v === 1 ? undefined : v }) as WaterType)}
        />
      )}
      <h5>{shore}</h5>
      <p class="hint">
        越近影响越大；条件里可用“靠近{t.name}”
      </p>
      <TypeSlider
        label="范围"
        value={bank?.radiusKm ?? 0}
        pos={(v) => logPos(v || autoRadius(t), RLO, RHI)}
        at={(p) => Math.round(logAt(p, RLO, RHI) / 10) * 10 || 10}
        text={(v) => (v ? `${v} km` : `自动 · 约 ${autoRadius(t)} km`)}
        commit={(v) => setBank({ radiusKm: v }, `修改“${t.name}”${shore}的范围`)}
      />
      <TypeSlider
        label="冷暖"
        value={dT}
        pos={(v) => (v + 10) / 20}
        at={(p) => Math.round((p * 20 - 10) * 2) / 2}
        text={(v) => (v ? `${fmtSigned(v)} °C` : '不变')}
        title={`让${shore}变暖、变冷`}
        commit={(v) => setBank({ dT: v || undefined }, `修改“${t.name}”${shore}的冷暖`)}
      />
      <TypeSlider
        label="干湿"
        value={dPpct}
        pos={(v) => (Math.log(1 + v / 100) + 1.5) / 3}
        at={(p) => Math.round((Math.exp(p * 3 - 1.5) - 1) * 20) * 5}
        text={(v) => (v ? `雨水 ${fmtSigned(v, 0)}%` : '不变')}
        title={`让${shore}的雨水变多、变少`}
        commit={(v) => setBank({ dP: v ? Math.max(-1.5, Math.min(1.5, Math.log(1 + v / 100))) : undefined }, `修改“${t.name}”${shore}的干湿`)}
      />
      <h5>起名</h5>
      <p class="hint">
        每行一个模板，如 {def.namesHint}
      </p>
      <textarea rows={3} value={names} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={saveNames} />
      {namesBad && <p class="hint warn">“{namesBad.slice(0, 12)}…”太长，最多 40 字</p>}
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
        <button class="small danger" onClick={() => void exec(def.remove(t.id), def.busy)} title={`选了它的${def.noun}变回普通的${def.noun}`}>
          <Trash2 /> 删除
        </button>
      </div>
    </div>
  );
}

// 流量的滑块按对数走（河的流量从一百到几万），取两位有效数字
const FLOW_LOG_LO = 50;
export const flowScale = {
  pos: (v: number) => (v <= 0 ? 0 : v >= WHEN_RANGE.flow.hi ? 1 : 0.02 + 0.96 * clamp01(logPos(v, FLOW_LOG_LO, WHEN_RANGE.flow.hi))),
  at: (p: number) => {
    if (p <= 0.01) return 0;
    if (p >= 0.99) return WHEN_RANGE.flow.hi;
    return Number(logAt(clamp01((p - 0.02) / 0.96), FLOW_LOG_LO, WHEN_RANGE.flow.hi).toPrecision(2));
  },
};

// 第五十六轮：声明式条件。高度、坡度、气温、流量，到两头是不限
function WhenBox({ kind, t, edit }: { kind: WaterKind; t: WaterType; edit: (label: string, make: (x: WaterType) => WaterType | null) => void }) {
  const keys = kind === 'lake' ? LAKE_WHEN_KEYS : WHEN_KEYS;
  const count = keys.filter((k) => hasWhen({ when: { [k]: t.when?.[k] } })).length;
  const set = (k: LakeWhenKey, r: { low: number; high: number }) =>
    edit(`修改“${t.name}”的条件 · ${WHEN_RANGE[k].label}`, (x) => {
      const when = { ...x.when };
      if (r.low <= WHEN_RANGE[k].lo && r.high >= WHEN_RANGE[k].hi) delete when[k];
      else when[k] = r;
      return { ...x, when: Object.keys(when).length ? when : undefined };
    });
  return (
    <details>
      <summary>条件 · {count ? `${count} 项` : '不限'}</summary>
      <p class="hint">{kind === 'river' ? '按每格看，河可以一段一段不同' : '按整个湖看'}</p>
      {keys.map((k) => {
        const g = WHEN_RANGE[k];
        return (
          <Fragment key={k}>
            <h5>{g.label}</h5>
            <RangeSliders lo={g.lo} hi={g.hi} step={g.step} unit={g.unit} scale={k === 'flow' ? flowScale : undefined} value={t.when?.[k] ?? { low: g.lo, high: g.hi }} onCommit={(r) => set(k, r)} />
          </Fragment>
        );
      })}
    </details>
  );
}

// 第十二轮：自然生成的开关；第五十六轮：出现在这些生态里（允许表的一行，和生态抽屉里的“允许的水系”是同一份）、条件
function NaturalBox({ w, kind, t, edit }: { w: World; kind: WaterKind; t: WaterType; edit: (label: string, make: (x: WaterType) => WaterType | null) => void }) {
  const noun = KINDS[kind].noun;
  const on = t.natural !== false;
  const script = !!t.scripts?.match?.src;
  const ids = w.small.species.map((s) => s.id);
  const has = (id: string) => !t.biomes || t.biomes.includes(id);
  const count = ids.filter(has).length;
  const hint = !on
    ? `只用在${kind === 'river' ? '画的河和选了它的河' : '放的湖和选了它的湖'}上`
    : !script && !perCellRule(t)
      ? '没有条件：选生态、写条件或规则'
      : !script
        ? `符合条件的${kind === 'river' ? '河段' : '湖'}是这一种`
        : perCellRule(t)
          ? `规则说是的${noun}里，符合条件的是这一种`
          : `规则说是的${noun}是这一种`;
  const toggle = (id: string) => {
    const sp = w.small.species.find((s) => s.id === id);
    const next = !has(id);
    edit(`“${t.name}”${next ? '可以' : '不再'}出现在“${sp?.name || id}”里`, (x) => withWaterBiome(x, ids, id, next));
  };
  return (
    <>
      <h5>自然生成</h5>
      <Toggle on={on} onChange={() => edit(on ? `“${t.name}”不再自然生成` : `“${t.name}”自然生成`, (x) => ({ ...x, natural: !on }))}>
        按条件出现在地图上
      </Toggle>
      <p class="hint">{hint}</p>
      <details>
        <summary>
          出现在这些生态里 · {t.biomes ? `${count} 种` : '全部'}
        </summary>
        <div class="biome-picks">
          {w.small.species.map((sp) => (
            <label class="check" key={sp.id}>
              <input type="checkbox" checked={has(sp.id)} onChange={() => toggle(sp.id)} />
              <span class="swatch" style={{ background: sp.color }} /> {sp.name || sp.id}
            </label>
          ))}
        </div>
        <p class="hint">规则里可用 biome('生态 id')、dominantBiome(){kind === 'river' ? '、biomeAtSource()、biomeAtMouth()' : ''}。</p>
      </details>
      <WhenBox kind={kind} t={t} edit={edit} />
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

// 一栏：这一类的列表、新建、从资源库添加（血河这些示例在资源库里）
function TypeList({ w, kind, open, setOpen }: { w: World; kind: WaterKind; open: string | null; setOpen: (id: string | null) => void }) {
  const def = KINDS[kind];
  const types = def.list(w);
  const add = async (t: WaterType) => {
    const ok = await exec(def.set(t), def.busy);
    if (ok) setOpen(t.id);
  };
  return (
    <>
      {types.length === 0 && <p class="hint">{def.intro}</p>}
      {types.length > 0 && (
        <div class="list">
          {types.map((t) => (
            <Fragment key={t.id}>
              <div class={`item ${open === t.id ? 'on' : ''}`} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span class="grow ellipsis">
                  <TypeSwatch kind={kind} t={t} /> {waterTypeOwner(t)}
                </span>
                <span class="hint">
                  {def.styleLabel[t.style ?? 'solid']}
                  {t.natural === false ? ' · 不自然生成' : t.scripts?.match || perCellRule(t) ? ' · 自然生成' : ''}
                </span>
              </div>
              {open === t.id && <TypeEditor w={w} kind={kind} t={t} />}
            </Fragment>
          ))}
        </div>
      )}
      <div class="row wrap">
        <button class="small" onClick={() => void add(newWaterType(w, kind))}>
          <Plus /> 新建
        </button>
        <button class="small" title={`资源库里的${def.title}（奇幻的示例都在那里）`} onClick={() => openLibraryFor(def.library)}>
          <Library /> {LIBRARY_ADD_LABEL}
        </button>
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
