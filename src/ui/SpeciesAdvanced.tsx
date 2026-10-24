import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SCRIPT_KIND_LABEL } from '../../core/script';
import { type Effects, PATTERNS, PATTERN_LABEL, type Pattern, SPECIES_SCRIPT_KINDS, type Species, type SpeciesFeature, type Visual } from '../../core/species';
import { world, worldEpoch } from '../state';
import { ScriptBox } from './ScriptBox';
import { Slider, linear } from './components/Slider';
import { previewVisual, scriptEditorRequest, showCell } from './editor-hooks';
import { type SpeciesScriptKind, applySpeciesScript, queueSpeciesEdit, settleSpeciesEdits, speciesEditsSettled, speciesIssue } from './species-scripts';

// 生态抽屉里收起来的“高级”（第三批；第十九轮把“更精细的条件”也并进来）：花纹与发光、对周围的影响、侵占、地名、两个脚本框。
// 滑块松手才提交（一步撤销）；拖花纹、发光滑块时地图上立即换上（画面那边装上了 previewVisual 时）；
// 脚本停一下就用到地图上（见 ScriptBox）。
// 每次提交都排进队里、按那时世界上最新的这种生态做出补丁（见 species-scripts.ts）：大星球上连着改几处时不会互相冲掉；
// 只改动这次动了的那一项，资源包里超出滑块范围的值（比如降水 −78%）不会因为改了别的而被改掉

// “对周围的影响”已经接进气候（core/effects.ts）：为 false 时显示“先记下”的说明
const CLIMATE_EFFECTS_LIVE = true;

type Patch = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const hexRgb = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgbHex = (c: number[]) => `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
// 花纹第二种颜色的默认：基础色调暗四成（与画面的默认一致）
const darker = (hex: string) => rgbHex(hexRgb(hex).map((x) => x * 0.6));
// 发光颜色的默认：基础色调亮
const lighter = (hex: string) => rgbHex(hexRgb(hex).map((x) => x + (255 - x) * 0.5));

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number, unit: string) => (x === 0 ? '不变' : `${x > 0 ? '+' : '−'}${Math.abs(x)}${unit}`);

// 松手、点了以后到提交算完之前先显示的值。同一处连着改几次时，最后一次算完才去掉；换了生态就去掉
function useLocal<T>(spId: string): [T | null, (v: T | null) => void, (job: Promise<unknown>, after?: () => void) => void, () => boolean] {
  const [local, setLocal] = useState<T | null>(null);
  const jobs = useRef(0);
  useEffect(() => setLocal(null), [spId]);
  const track = (job: Promise<unknown>, after?: () => void) => {
    jobs.current++;
    void job.finally(() => {
      if (--jobs.current > 0) return;
      setLocal(null);
      after?.();
    });
  };
  return [local, setLocal, track, () => jobs.current > 0];
}

// 滑块（界面上同一种 Slider）：拖动时 onLive，松手时值变了 onDone，最后 onEnd（值没变、取消时只有 onEnd）
function Knob(p: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  text: string;
  onLive?: (v: number) => void;
  onDone: (v: number) => void;
  onEnd?: () => void;
}) {
  // 按下时的值：松手时和它比，没变就不提交
  const start = useRef<number | null>(null);
  const scale = linear(p.min, p.max, p.step);
  return (
    <Slider
      stacked
      label={p.label}
      pos={scale.pos(p.value)}
      text={p.text}
      onDraft={(pos) => {
        start.current ??= p.value;
        p.onLive?.(scale.at(pos));
      }}
      onCommit={(pos) => {
        const v = scale.at(pos);
        const from = start.current ?? p.value;
        start.current = null;
        if (v !== from) p.onDone(v);
        p.onEnd?.();
      }}
      onCancel={() => {
        start.current = null;
        p.onEnd?.();
      }}
    />
  );
}

// 外观：没有花纹也不发光时等于没有
export function cleanVisual(v: Visual): Visual | null {
  if (v.pattern === 'none' && !(v.glow && v.glow > 0)) return null;
  const out: Visual = { pattern: v.pattern };
  for (const k of ['color2', 'amount', 'size', 'glow', 'glowColor'] as const) if (v[k] !== undefined) (out as Record<string, unknown>)[k] = v[k];
  return out;
}

// 外观改一项：在这种生态现在的外观上改（不是界面上可能还没更新的那份）
export function visualPatch(cur: Species, change: Partial<Visual>): Patch | null {
  const c = cleanVisual({ ...(cur.visual ?? { pattern: 'none' }), ...change });
  return same(c, cur.visual) ? null : { visual: c };
}

function LookSection({ sp }: { sp: Species }) {
  // 拖动中、提交还没算完时的外观
  const [local, setLocal, track, saving] = useLocal<Visual>(sp.id);
  const v: Visual = local ?? sp.visual ?? { pattern: 'none' };
  // 拖动了几次：提交算完时又在拖别的滑块了，就不去掉临时的外观（不然正拖着的那个值会闪回去）
  const drags = useRef(0);
  const live = (change: Partial<Visual>) => {
    const next = { ...v, ...change };
    drags.current++;
    setLocal(next);
    previewVisual(sp.id, cleanVisual(next) ?? { pattern: 'none' });
  };
  const save = (change: Partial<Visual>) => {
    setLocal({ ...v, ...change });
    const id = sp.id;
    const at = drags.current;
    // 真的数据到了：去掉临时的外观（结果与临时的一样时，换上快照时画面那边已经去掉了，见 state.ts 的 pruneVisualOverrides）
    track(
      queueSpeciesEdit(id, '正在计算…', (cur) => visualPatch(cur, change)),
      () => {
        if (drags.current === at) previewVisual(id, null);
      },
    );
  };
  // 拖了又拖回原处（没有 change）：去掉临时的外观，免得它一直盖着世界上真的外观（比如之后的撤销）
  const end = () => {
    if (saving()) return;
    setLocal(null);
    previewVisual(sp.id, null);
  };
  const glow = v.glow ?? 0;
  return (
    <>
      <h5>图案</h5>
      <div class="row wrap">
        <select value={v.pattern} onChange={(e) => save({ pattern: (e.target as HTMLSelectElement).value as Pattern })}>
          {PATTERNS.map((p) => (
            <option value={p}>{PATTERN_LABEL[p]}</option>
          ))}
        </select>
        {v.pattern !== 'none' && (
          <label class="inline">
            第二种颜色
            <input
              type="color"
              value={v.color2 ?? darker(sp.color)}
              onInput={(e) => live({ color2: (e.target as HTMLInputElement).value })}
              onChange={(e) => save({ color2: (e.target as HTMLInputElement).value })}
            />
          </label>
        )}
      </div>
      {v.pattern !== 'none' && (
        <>
          <Knob label="明显程度" min={0} max={1} step={0.05} value={v.amount ?? 0.6} text={pct(v.amount ?? 0.6)} onLive={(x) => live({ amount: x })} onDone={(x) => save({ amount: x })} onEnd={end} />
          <Knob label="大小" min={0.1} max={4} step={0.05} value={v.size ?? 0.5} text={`${(v.size ?? 0.5).toFixed(2)} 格`} onLive={(x) => live({ size: x })} onDone={(x) => save({ size: x })} onEnd={end} />
        </>
      )}
      <Knob label="发光" min={0} max={1} step={0.05} value={glow} text={glow > 0 ? pct(glow) : '不发光'} onLive={(x) => live({ glow: x })} onDone={(x) => save({ glow: x })} onEnd={end} />
      {glow > 0 && (
        <label class="inline">
          发光的颜色
          <input
            type="color"
            value={v.glowColor ?? lighter(sp.color)}
            onInput={(e) => live({ glowColor: (e.target as HTMLInputElement).value })}
            onChange={(e) => save({ glowColor: (e.target as HTMLInputElement).value })}
          />
        </label>
      )}
    </>
  );
}

// 对周围的影响里改一项（dP 是降水乘以 e^dP 的那个数）；没改的项照原样留着（资源包里的值可能超出滑块的范围）
export type ClimateChange = { dT?: number; dP?: number; radiusKm?: number };
export const DEFAULT_RADIUS_KM = 300;

export function withClimate(effects: Effects | undefined, change: ClimateChange): Effects | null {
  const old = effects?.climate;
  const dT = change.dT ?? old?.dT ?? 0;
  const dP = change.dP ?? old?.dP ?? 0;
  const radiusKm = change.radiusKm ?? old?.radiusKm ?? DEFAULT_RADIUS_KM;
  const climate = dT || dP ? { ...(dT ? { dT } : {}), ...(dP ? { dP } : {}), radiusKm } : undefined;
  const { climate: _, ...rest } = effects ?? {};
  const out: Effects = { ...rest, ...(climate ? { climate } : {}) };
  return Object.keys(out).length ? out : null;
}

// 降水的百分比（滑块）与 dP 互换
export const percentOfDp = (dP: number) => Math.round((Math.exp(dP) - 1) * 100);
export const dpOfPercent = (p: number) => Math.max(-1.5, Math.min(1.5, Math.round(Math.log(1 + p / 100) * 1e4) / 1e4));

const effectsPatch = (cur: Species, next: Effects | null): Patch | null => (same(next, cur.effects) ? null : { effects: next });

function ClimateSection({ sp }: { sp: Species }) {
  const c = sp.effects?.climate;
  const [local, setLocal, track, saving] = useLocal<ClimateChange>(sp.id);
  // 拖了又拖回原处（没有 change）：不再显示拖动中的值，免得之后撤销时还停在这里
  const end = () => !saving() && setLocal(null);
  const dT = local?.dT ?? c?.dT ?? 0;
  const dP = local?.dP ?? c?.dP ?? 0;
  const r = local?.radiusKm ?? c?.radiusKm ?? DEFAULT_RADIUS_KM;
  const p = percentOfDp(dP);
  const live = (change: ClimateChange) => setLocal({ ...local, ...change });
  const save = (change: ClimateChange) => {
    live(change);
    track(queueSpeciesEdit(sp.id, '正在计算…', (cur) => effectsPatch(cur, withClimate(cur.effects, change))));
  };
  return (
    <>
      <h5>对周围的影响</h5>
      <Knob label="变暖变冷" min={-5} max={5} step={0.5} value={dT} text={signed(dT, ' °C')} onLive={(x) => live({ dT: x })} onDone={(x) => save({ dT: x })} onEnd={end} />
      <Knob
        label="变湿变干"
        min={-50}
        max={100}
        step={5}
        value={p}
        text={p === 0 ? '不变' : `降水 ${signed(p, '%')}`}
        onLive={(x) => live({ dP: dpOfPercent(x) })}
        onDone={(x) => save({ dP: dpOfPercent(x) })}
        onEnd={end}
      />
      {(dT !== 0 || dP !== 0) && (
        <Knob label="范围" min={50} max={1500} step={10} value={r} text={`${r} 千米`} onLive={(x) => live({ radiusKm: x })} onDone={(x) => save({ radiusKm: x })} onEnd={end} />
      )}
      <p class="hint">越远影响越小，到范围边上为零。{CLIMATE_EFFECTS_LIVE ? '' : '暂不改地图上的冷暖干湿。'}</p>
    </>
  );
}

const DEFAULT_INVADE_STRENGTH = 1.5;

// 点了一种：有就去掉，没有就加上（按生态列表的顺序排，已经不在了的目标照旧留在后面）
export function toggleTarget(targets: readonly string[], id: string, order: readonly string[]): string[] {
  if (targets.includes(id)) return targets.filter((t) => t !== id);
  return [...order.filter((o) => o === id || targets.includes(o)), ...targets.filter((t) => !order.includes(t))];
}

// 侵占里改一项：toggle 点了哪一种，strength 强度
export function withInvade(effects: Effects | undefined, change: { toggle?: string; strength?: number }, order: readonly string[]): Effects | null {
  const inv = effects?.invade;
  const targets = change.toggle !== undefined ? toggleTarget(inv?.targets ?? [], change.toggle, order) : (inv?.targets ?? []);
  const strength = change.strength ?? inv?.strength ?? DEFAULT_INVADE_STRENGTH;
  const invade = targets.length ? { targets: targets.slice(0, 48), strength } : undefined;
  const { invade: _, ...rest } = effects ?? {};
  const out: Effects = { ...rest, ...(invade ? { invade } : {}) };
  return Object.keys(out).length ? out : null;
}

// 侵占：在目标生态适宜的地方竞争力更强
function InvadeSection({ sp }: { sp: Species }) {
  const all = world.value!.small.species;
  const order = all.map((o) => o.id);
  const [local, setLocal, track, saving] = useLocal<{ targets: string[]; strength: number }>(sp.id);
  const targets = local?.targets ?? sp.effects?.invade?.targets ?? [];
  const strength = local?.strength ?? sp.effects?.invade?.strength ?? DEFAULT_INVADE_STRENGTH;
  const save = (change: { toggle?: string; strength?: number }) => {
    // 先在界面上显示出来（大星球上算一步要一会儿，连着点几个也都看得到）
    setLocal({ targets: change.toggle !== undefined ? toggleTarget(targets, change.toggle, order) : targets, strength: change.strength ?? strength });
    track(queueSpeciesEdit(sp.id, '正在计算…', (cur) => effectsPatch(cur, withInvade(cur.effects, change, world.value?.small.species.map((o) => o.id) ?? order))));
  };
  const others = all.filter((o) => o.id !== sp.id);
  return (
    <>
      <h5>侵占</h5>
      <p class="hint">在选中生态适宜的地方更容易占上风</p>
      <div class="palette">
        {others.map((o) => (
          <button class={`chip ${targets.includes(o.id) ? 'on' : ''}`} onClick={() => save({ toggle: o.id })}>
            <span class="swatch" style={{ background: o.color }} />
            {o.name || o.id}
          </button>
        ))}
      </div>
      {targets.length > 0 && (
        <Knob
          label="力度"
          min={0}
          max={5}
          step={0.1}
          value={strength}
          text={strength.toFixed(1)}
          onLive={(x) => setLocal({ targets, strength: x })}
          onDone={(x) => save({ strength: x })}
          onEnd={() => !saving() && setLocal(null)}
        />
      )}
    </>
  );
}

// 与 schema 一样按 UTF-16 的长度算（z.string().max）
const MAX_LABEL = 8;
const MAX_TEMPLATE = 40;
const MAX_TEMPLATES = 20;

// 截到不超过 max 个 UTF-16 单位，不截断一个字
function clip(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

// 地名的输入有什么问题（与 featureSchema 的限制一致）；没有为 null
export function namesProblem(label: string, lines: readonly string[]): string | null {
  if (label.trim().length > MAX_LABEL) return `类型名最多 ${MAX_LABEL} 个字`;
  const long = lines.findIndex((s) => s.length > MAX_TEMPLATE);
  if (long >= 0) return `第 ${long + 1} 个模板太长，最多 ${MAX_TEMPLATE} 个字`;
  if (lines.length > MAX_TEMPLATES) return `模板最多 ${MAX_TEMPLATES} 个`;
  return null;
}

// 地名：输入的类型名、模板换成 feature（只写了模板、没写类型名时类型名用生态的名字；没改的模板保留原来的权重）
export function featureOf(cur: Species, label: string, lines: readonly string[]): SpeciesFeature | null {
  const lab = label.trim() || (lines.length ? clip(cur.name || cur.id, MAX_LABEL) : '');
  if (!lab) return null;
  const old = new Map((cur.feature?.names ?? []).map((n) => [n.p, n.w]));
  return { label: lab, ...(lines.length ? { names: lines.map((p) => (old.get(p) !== undefined ? { p, w: old.get(p) } : { p })) } : {}) };
}

// 地名：类型名（“晶林”）与起名模板（每行一个）
function NamesSection({ sp }: { sp: Species }) {
  const f = sp.feature;
  const [label, setLabel] = useState(f?.label ?? '');
  const [names, setNames] = useState((f?.names ?? []).map((n) => n.p).join('\n'));
  useEffect(() => {
    setLabel(f?.label ?? '');
    setNames((f?.names ?? []).map((n) => n.p).join('\n'));
  }, [sp.id, JSON.stringify(f ?? null)]);
  const lines = names
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const problem = namesProblem(label, lines);
  const save = () => {
    if (problem) return;
    // 回车之后又离开框：第二次排到时世界上已经是这个样子，不再提交
    void queueSpeciesEdit(sp.id, '正在起名…', (cur) => {
      const next = featureOf(cur, label, lines);
      return same(next, cur.feature) ? null : { feature: next };
    });
  };
  return (
    <>
      <h5>地名</h5>
      <label>
        <span class="row between">
          <span>类型名</span>
          <span class="hint">如“晶林”</span>
        </span>
        <input
          class="wide-input"
          value={label}
          placeholder={clip(sp.name || '', MAX_LABEL)}
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      </label>
      <label>
        <span>起名模板（每行一个）</span>
        <textarea value={names} placeholder={'{color}晶林\n{myth}晶丛'} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={save} />
      </label>
      <p class="hint">{'花括号里的词换成文字包里的词；不写按生态名起名'}</p>
      {problem && <div class="script-problem small">{problem}</div>}
    </>
  );
}

const SCRIPT_HINT: Record<SpeciesScriptKind, string> = {
  placement: '返回 0 到 1，乘进适宜度；0 就不长',
  color: "返回 [r, g, b] 或 '#rrggbb'",
};

function ScriptsSection({ sp }: { sp: Species }) {
  const w = world.value!;
  const fields = Object.keys(w.causes.fields);
  // 别处要求打开某个脚本框（出错提示的“编辑”）：把光标放进去
  const req = scriptEditorRequest.value;
  const [focus, setFocus] = useState<{ kind: SpeciesScriptKind; n: number } | null>(null);
  useEffect(() => {
    if (req?.species !== sp.id) return;
    setFocus((f) => ({ kind: req.kind, n: (f?.n ?? 0) + 1 }));
    scriptEditorRequest.value = null;
  }, [req, sp.id]);
  return (
    <>
      <h5>脚本</h5>
      <p class="hint">用 JavaScript 决定它长在哪里、什么颜色</p>
      {SPECIES_SCRIPT_KINDS.map((kind) => (
        <ScriptBox
          // 换了世界、换了生态都是新的框（还没提交的不会落到别的世界、别的生态上）
          key={`${worldEpoch.value}:${sp.id}:${kind}`}
          kind={kind}
          label={SCRIPT_KIND_LABEL[kind]}
          hint={SCRIPT_HINT[kind]}
          value={sp.scripts?.[kind]?.src ?? ''}
          issue={() => speciesIssue(sp.id, kind)}
          apply={(src, mode, revert) => applySpeciesScript(sp.id, kind, src, mode, revert)}
          idle={speciesEditsSettled}
          settle={settleSpeciesEdits}
          fields={fields}
          onShowCell={showCell}
          focusSignal={focus?.kind === kind ? focus.n : 0}
        />
      ))}
    </>
  );
}

// children：放在最前面的（生态抽屉的“更精细的条件”）——两个“高级”合成这一个
export function SpeciesAdvanced({ sp, children }: { sp: Species; children?: ComponentChildren }) {
  const req = scriptEditorRequest.value;
  // 收着时里面的东西不画（脚本框要加载 acorn）
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (req?.species === sp.id) setOpen(true);
  }, [req, sp.id]);
  return (
    <details class="species-advanced" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>高级</summary>
      {open && (
        <>
          {children}
          <LookSection sp={sp} />
          <ClimateSection sp={sp} />
          <InvadeSection sp={sp} />
          <NamesSection sp={sp} />
          <ScriptsSection sp={sp} />
        </>
      )}
    </details>
  );
}
