import { useEffect, useState } from 'preact/hooks';
import { SCRIPT_KIND_LABEL } from '../../core/script';
import { PATTERNS, PATTERN_LABEL, type Pattern, SPECIES_SCRIPT_KINDS, type Species, type Visual } from '../../core/species';
import { exec, world } from '../state';
import { ScriptBox } from './ScriptBox';
import { previewVisual, scriptEditorRequest, showCell } from './editor-hooks';
import { type SpeciesScriptKind, applySpeciesScript, speciesIssue } from './species-scripts';

// 生态抽屉里收起来的“高级：图案、效果与脚本”（第三批）：花纹与发光、对周围的影响、侵占、地名、两个脚本框。
// 滑块松手才提交（一步撤销）；拖花纹、发光滑块时地图上立即换上（画面那边装上了 previewVisual 时）；
// 脚本停一下就用到地图上（见 ScriptBox）

// “对周围的影响”接进气候以后改成 true（那时去掉“先记下”的说明）
export const CLIMATE_EFFECTS_LIVE = false;

type Patch = Record<string, unknown>;
const update = (sp: Species, patch: Patch, label: string) => exec({ op: 'update_species', id: sp.id, patch }, label);
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

// 滑块：拖动时 onLive，松手时 onDone
function Slider(p: { label: string; min: number; max: number; step: number; value: number; text: string; onLive?: (v: number) => void; onDone: (v: number) => void }) {
  return (
    <label>
      <span class="row between">
        <span>{p.label}</span>
        <span class="muted">{p.text}</span>
      </span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        onInput={(e) => p.onLive?.(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => p.onDone(Number((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

// 外观：没有花纹也不发光时等于没有
export function cleanVisual(v: Visual): Visual | null {
  if (v.pattern === 'none' && !(v.glow && v.glow > 0)) return null;
  const out: Visual = { pattern: v.pattern };
  for (const k of ['color2', 'amount', 'size', 'glow', 'glowColor'] as const) if (v[k] !== undefined) (out as Record<string, unknown>)[k] = v[k];
  return out;
}

function LookSection({ sp }: { sp: Species }) {
  // 拖动中的外观（松手提交后去掉）
  const [drag, setDrag] = useState<Visual | null>(null);
  useEffect(() => setDrag(null), [sp.id, JSON.stringify(sp.visual ?? null)]);
  const v: Visual = drag ?? sp.visual ?? { pattern: 'none' };
  const live = (next: Visual) => {
    setDrag(next);
    previewVisual(sp.id, cleanVisual(next) ?? { pattern: 'none' });
  };
  const save = async (next: Visual) => {
    setDrag(next);
    const c = cleanVisual(next);
    if (!same(c, sp.visual)) await update(sp, { visual: c }, '正在换外观…');
    // 真的数据到了：去掉临时的外观
    previewVisual(sp.id, null);
    setDrag(null);
  };
  const glow = v.glow ?? 0;
  return (
    <>
      <h5>图案</h5>
      <div class="row wrap">
        <select value={v.pattern} onChange={(e) => void save({ ...v, pattern: (e.target as HTMLSelectElement).value as Pattern })}>
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
              onInput={(e) => live({ ...v, color2: (e.target as HTMLInputElement).value })}
              onChange={(e) => void save({ ...v, color2: (e.target as HTMLInputElement).value })}
            />
          </label>
        )}
      </div>
      {v.pattern !== 'none' && (
        <>
          <Slider label="明显程度" min={0} max={1} step={0.05} value={v.amount ?? 0.6} text={pct(v.amount ?? 0.6)} onLive={(x) => live({ ...v, amount: x })} onDone={(x) => void save({ ...v, amount: x })} />
          <Slider label="大小" min={0.1} max={4} step={0.05} value={v.size ?? 0.5} text={`${(v.size ?? 0.5).toFixed(2)} 格`} onLive={(x) => live({ ...v, size: x })} onDone={(x) => void save({ ...v, size: x })} />
        </>
      )}
      <Slider label="发光" min={0} max={1} step={0.05} value={glow} text={glow > 0 ? pct(glow) : '不发光'} onLive={(x) => live({ ...v, glow: x })} onDone={(x) => void save({ ...v, glow: x })} />
      {glow > 0 && (
        <label class="inline">
          发光的颜色
          <input
            type="color"
            value={v.glowColor ?? lighter(sp.color)}
            onInput={(e) => live({ ...v, glowColor: (e.target as HTMLInputElement).value })}
            onChange={(e) => void save({ ...v, glowColor: (e.target as HTMLInputElement).value })}
          />
        </label>
      )}
    </>
  );
}

// 对周围的影响：变暖变冷（°C）、变湿变干（降水乘以 e^dP，界面上按百分比）、范围
function ClimateSection({ sp }: { sp: Species }) {
  const c = sp.effects?.climate;
  const [drag, setDrag] = useState<{ dT: number; pct: number; r: number } | null>(null);
  useEffect(() => setDrag(null), [sp.id, JSON.stringify(c ?? null)]);
  const cur = drag ?? { dT: c?.dT ?? 0, pct: Math.round((Math.exp(c?.dP ?? 0) - 1) * 100), r: c?.radiusKm ?? 300 };
  const save = async (next: typeof cur) => {
    setDrag(next);
    const climate =
      next.dT || next.pct
        ? { ...(next.dT ? { dT: next.dT } : {}), ...(next.pct ? { dP: Math.round(Math.log(1 + next.pct / 100) * 1e4) / 1e4 } : {}), radiusKm: next.r }
        : undefined;
    const effects = { ...(climate ? { climate } : {}), ...(sp.effects?.invade ? { invade: sp.effects.invade } : {}) };
    const value = Object.keys(effects).length ? effects : null;
    if (!same(value, sp.effects)) await update(sp, { effects: value }, '正在计算生态…');
    setDrag(null);
  };
  return (
    <>
      <h5>对周围的影响</h5>
      <Slider label="变暖变冷" min={-5} max={5} step={0.5} value={cur.dT} text={signed(cur.dT, ' °C')} onLive={(x) => setDrag({ ...cur, dT: x })} onDone={(x) => void save({ ...cur, dT: x })} />
      <Slider label="变湿变干" min={-50} max={100} step={5} value={cur.pct} text={cur.pct === 0 ? '不变' : `降水 ${signed(cur.pct, '%')}`} onLive={(x) => setDrag({ ...cur, pct: x })} onDone={(x) => void save({ ...cur, pct: x })} />
      {(cur.dT !== 0 || cur.pct !== 0) && (
        <Slider label="范围" min={50} max={1500} step={10} value={cur.r} text={`${cur.r} 千米`} onLive={(x) => setDrag({ ...cur, r: x })} onDone={(x) => void save({ ...cur, r: x })} />
      )}
      <p class="muted small">离它越远影响越小，到范围的边上就没有了。{CLIMATE_EFFECTS_LIVE ? '' : '这一项先记下，现在还不改地图上的冷暖干湿。'}</p>
    </>
  );
}

// 侵占：在目标生态适宜的地方竞争力更强
function InvadeSection({ sp }: { sp: Species }) {
  const all = world.value!.small.species;
  const inv = sp.effects?.invade;
  const targets = inv?.targets ?? [];
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => setDrag(null), [sp.id, inv?.strength]);
  const strength = drag ?? inv?.strength ?? 1.5;
  const save = async (nextTargets: string[], nextStrength: number) => {
    const invade = nextTargets.length ? { targets: nextTargets, strength: nextStrength } : undefined;
    const effects = { ...(sp.effects?.climate ? { climate: sp.effects.climate } : {}), ...(invade ? { invade } : {}) };
    const value = Object.keys(effects).length ? effects : null;
    if (!same(value, sp.effects)) await update(sp, { effects: value }, '正在计算生态…');
    setDrag(null);
  };
  const toggle = (id: string) => {
    const on = targets.includes(id);
    // 按生态列表的顺序；已经不在了的目标照旧留着
    const next = on ? targets.filter((t) => t !== id) : [...all.filter((o) => o.id === id || targets.includes(o.id)).map((o) => o.id), ...targets.filter((t) => !all.some((o) => o.id === t))];
    void save(next.slice(0, 48), strength);
  };
  const others = all.filter((o) => o.id !== sp.id);
  return (
    <>
      <h5>侵占</h5>
      <p class="muted small">在选中的这些生态适宜的地方，它更容易占上风。</p>
      <div class="palette">
        {others.map((o) => (
          <button class={`chip ${targets.includes(o.id) ? 'on' : ''}`} onClick={() => toggle(o.id)}>
            <span class="swatch" style={{ background: o.color }} />
            {o.name || o.id}
          </button>
        ))}
      </div>
      {targets.length > 0 && (
        <Slider label="强度" min={0} max={5} step={0.1} value={strength} text={strength.toFixed(1)} onLive={setDrag} onDone={(x) => void save(targets, x)} />
      )}
    </>
  );
}

const MAX_LABEL = 8;
const MAX_TEMPLATE = 40;
const MAX_TEMPLATES = 20;

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
  const long = lines.findIndex((s) => Array.from(s).length > MAX_TEMPLATE);
  const problem =
    Array.from(label.trim()).length > MAX_LABEL
      ? `类型名最多 ${MAX_LABEL} 个字`
      : long >= 0
        ? `第 ${long + 1} 个模板太长了（最多 ${MAX_TEMPLATE} 个字）`
        : lines.length > MAX_TEMPLATES
          ? `模板最多 ${MAX_TEMPLATES} 个`
          : null;
  const save = () => {
    if (problem) return;
    // 只写了模板、没写类型名：类型名用生态的名字
    const lab = label.trim() || (lines.length ? Array.from(sp.name || sp.id).slice(0, MAX_LABEL).join('') : '');
    // 没改的模板保留原来的权重
    const old = new Map((f?.names ?? []).map((n) => [n.p, n.w]));
    const next = lab ? { label: lab, ...(lines.length ? { names: lines.map((p) => (old.get(p) !== undefined ? { p, w: old.get(p) } : { p })) } : {}) } : null;
    if (!same(next, f)) void update(sp, { feature: next }, '正在起名…');
  };
  return (
    <>
      <h5>地名</h5>
      <label>
        <span class="row between">
          <span>类型名</span>
          <span class="muted small">地图上这一片是什么，比如“晶林”</span>
        </span>
        <input
          class="wide-input"
          value={label}
          placeholder={Array.from(sp.name || '').slice(0, MAX_LABEL).join('')}
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
      </label>
      <label>
        <span>起名模板（每行一个）</span>
        <textarea class="names" value={names} placeholder={'{color}晶林\n{myth}晶丛'} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={save} />
      </label>
      <p class="muted small">{'花括号里的词会换成文字包里的词，比如 {color}晶林、{myth}晶丛。不写就按生态的名字起。'}</p>
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
      <p class="muted small">用一小段 JavaScript 更自由地决定它长在哪里、是什么颜色。停一下就用到地图上；一次修改只算一步撤销。</p>
      {SPECIES_SCRIPT_KINDS.map((kind) => (
        <ScriptBox
          key={`${sp.id}:${kind}`}
          kind={kind}
          label={SCRIPT_KIND_LABEL[kind]}
          hint={SCRIPT_HINT[kind]}
          value={sp.scripts?.[kind]?.src ?? ''}
          issue={() => speciesIssue(sp.id, kind)}
          apply={(src, mode) => applySpeciesScript(sp.id, kind, src, mode)}
          fields={fields}
          onShowCell={showCell}
          focusSignal={focus?.kind === kind ? focus.n : 0}
        />
      ))}
    </>
  );
}

export function SpeciesAdvanced({ sp }: { sp: Species }) {
  const req = scriptEditorRequest.value;
  // 收着时里面的东西不画（脚本框要加载 acorn）
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (req?.species === sp.id) setOpen(true);
  }, [req, sp.id]);
  return (
    <details class="species-advanced" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>高级：图案、效果与脚本</summary>
      {open && (
        <>
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
