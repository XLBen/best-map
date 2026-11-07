import { X } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { kindOf } from '../../../core/content/registry';
import { BIOME_TERRAINS } from '../../../core/export-terrain';
import { SCRIPT_KIND_LABEL } from '../../../core/script';
import { BUILTIN_FIELDS, PATTERNS, PATTERN_LABEL, type Pattern, SPECIES_SCRIPT_KINDS, type Species, type Tolerance, type Visual } from '../../../core/species';
import { world, worldEpoch } from '../../state';
import { ScriptBox } from '../ScriptBox';
import { Slider, linear } from '../components/Slider';
import { previewVisual, scriptEditorRequest, showCell } from '../editor-hooks';
import { FieldsBox } from '../packs/ContentEditor';
import type { Obj } from '../packs/fields';
import { type PageCtx, waterLists } from '../packs/pages';
import { type ClimateChange, DEFAULT_INVADE_STRENGTH, DEFAULT_RADIUS_KM, MAX_LABEL, clip, cleanVisual, darker, dpOfPercent, effectsPatch, featurePatch, lighter, namesProblem, pct, percentOfDp, signed, toggleTarget, visualPatch, withClimate, withInvade } from './advanced';
import { shownTolerances, tolerancesPatch } from './biome-edit';
import type { BiomeTarget } from './biome-target';
import { type SpeciesScriptKind, applySpeciesScript, settleSpeciesEdits, speciesEditsSettled, speciesIssue } from './species-scripts';

// 生态编辑器里收起来的“高级”（第七十二轮从 SpeciesAdvanced.tsx、ClimateChart.tsx 的“更精细的条件”合来）：
// 更精细的条件、导出用的地形、图案与发光、对周围的影响、侵占、地名、脚本。
// 滑块松手才提交（一步撤销）；本世界里拖图案、发光的滑块时地图上立即换上（画面那边装上了 previewVisual 时）；
// 脚本停一下就用到地图上（见 ScriptBox）。本世界里每次提交都排进队里、按那时世界上最新的这种生态做补丁（species-scripts.ts）

type Props = { sp: Species; t: BiomeTarget };

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
function Knob(p: { label: string; min: number; max: number; step: number; value: number; text: string; onLive?: (v: number) => void; onDone: (v: number) => void; onEnd?: () => void }) {
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

// 更精细的条件：海拔不在这里（只在高度范围里设）
function TolerancesSection({ sp, t, ctx }: Props & { ctx: PageCtx }) {
  const w = world.value;
  const tols = shownTolerances(sp);
  const lists = waterLists(t.src, ctx);
  // 河流类型的河岸场：离这种河多近，0–1
  const fields = [
    ...BUILTIN_FIELDS.filter((f) => f.id !== 'elevation'),
    ...Object.keys(w?.causes.fields ?? {}).map((f) => ({ id: `field:${f}`, label: `自定义：${f}`, unit: '' })),
    ...lists.riverTypes.map((x) => ({ id: `river:${x.id}`, label: `靠近${x.name}（0–1）`, unit: '' })),
    ...lists.lakeTypes.map((x) => ({ id: `lake:${x.id}`, label: `靠近${x.name}（0–1）`, unit: '' })),
  ];
  const save = (next: Tolerance[]) => void t.edit(sp.id, tolerancesPatch(sp, next), '正在计算…');
  const near = (f: string) => f.startsWith('river:') || f.startsWith('lake:');
  return (
    <div>
      <h5>更精细的条件</h5>
      <p class="hint">给任一项设“最小 · 最适下限 · 最适上限 · 最大”</p>
      {tols.map((x, k) => (
        <div class="tol">
          <select
            value={x.field}
            onChange={(e) => {
              const field = (e.target as HTMLSelectElement).value;
              // 换成“靠近某种河”（0–1）：原来的数在这里没有意义，换成“离河近的地方最适合”
              const to = near(field) && !near(x.field) ? { min: 0.1, optLow: 0.5, optHigh: 1, max: 1 } : {};
              save(tols.map((y, i) => (i === k ? { ...y, field, ...to } : y)));
            }}
          >
            {!fields.some((f) => f.id === x.field) && <option value={x.field}>{x.field}</option>}
            {fields.map((f) => (
              <option value={f.id}>{f.label}</option>
            ))}
          </select>
          <div class="row nums">
            {(['min', 'optLow', 'optHigh', 'max'] as const).map((key) => (
              <input
                type="number"
                step="any"
                value={x[key]}
                title={{ min: '最小', optLow: '最适下限', optHigh: '最适上限', max: '最大' }[key]}
                onChange={(e) => save(tols.map((y, i) => (i === k ? { ...y, [key]: Number((e.target as HTMLInputElement).value) } : y)))}
              />
            ))}
            <button class="small icon" onClick={() => save(tols.filter((_, i) => i !== k))} title="删除条件">
              <X />
            </button>
          </div>
        </div>
      ))}
      <button onClick={() => save([...tols, { field: 'precip', min: 0, optLow: 0, optHigh: 2000, max: 3000 }])}>添加条件</button>
      <h5>导出用的地形</h5>
      <select value={sp.terrain} onChange={(e) => void t.edit(sp.id, { terrain: (e.target as HTMLSelectElement).value })}>
        {BIOME_TERRAINS.map((x) => (
          <option value={x.id}>{x.label}</option>
        ))}
      </select>
      <p class="hint">导出的地形图按它着色</p>
    </div>
  );
}

function LookSection({ sp, t }: Props) {
  // 拖动中、提交还没算完时的外观
  const [local, setLocal, track, saving] = useLocal<Visual>(sp.id);
  const v: Visual = local ?? sp.visual ?? { pattern: 'none' };
  // 拖动了几次：提交算完时又在拖别的滑块了，就不去掉临时的外观（不然正拖着的那个值会闪回去）
  const drags = useRef(0);
  const live = (change: Partial<Visual>) => {
    const next = { ...v, ...change };
    drags.current++;
    setLocal(next);
    if (t.inWorld) previewVisual(sp.id, cleanVisual(next) ?? { pattern: 'none' });
  };
  const save = (change: Partial<Visual>) => {
    setLocal({ ...v, ...change });
    const id = sp.id;
    const at = drags.current;
    // 真的数据到了：去掉临时的外观（结果与临时的一样时，换上快照时画面那边已经去掉了，见 state.ts 的 pruneVisualOverrides）
    track(
      t.queue(id, '正在计算…', (cur) => visualPatch(cur, change)),
      () => {
        if (t.inWorld && drags.current === at) previewVisual(id, null);
      },
    );
  };
  // 拖了又拖回原处（没有 change）：去掉临时的外观，免得它一直盖着世界上真的外观（比如之后的撤销）
  const end = () => {
    if (saving()) return;
    setLocal(null);
    if (t.inWorld) previewVisual(sp.id, null);
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
            <input type="color" value={v.color2 ?? darker(sp.color)} onInput={(e) => live({ color2: (e.target as HTMLInputElement).value })} onChange={(e) => save({ color2: (e.target as HTMLInputElement).value })} />
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
          <input type="color" value={v.glowColor ?? lighter(sp.color)} onInput={(e) => live({ glowColor: (e.target as HTMLInputElement).value })} onChange={(e) => save({ glowColor: (e.target as HTMLInputElement).value })} />
        </label>
      )}
    </>
  );
}

function ClimateSection({ sp, t }: Props) {
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
    track(t.queue(sp.id, '正在计算…', (cur) => effectsPatch(cur, withClimate(cur.effects, change))));
  };
  return (
    <>
      <h5>对周围的影响</h5>
      <Knob label="变暖变冷" min={-5} max={5} step={0.5} value={dT} text={signed(dT, ' °C')} onLive={(x) => live({ dT: x })} onDone={(x) => save({ dT: x })} onEnd={end} />
      <Knob label="变湿变干" min={-50} max={100} step={5} value={p} text={p === 0 ? '不变' : `降水 ${signed(p, '%')}`} onLive={(x) => live({ dP: dpOfPercent(x) })} onDone={(x) => save({ dP: dpOfPercent(x) })} onEnd={end} />
      {(dT !== 0 || dP !== 0) && <Knob label="范围" min={50} max={1500} step={10} value={r} text={`${r} 千米`} onLive={(x) => live({ radiusKm: x })} onDone={(x) => save({ radiusKm: x })} onEnd={end} />}
      <p class="hint">越远影响越小，到范围边上为零。</p>
    </>
  );
}

// 侵占：在目标生态适宜的地方竞争力更强
function InvadeSection({ sp, t }: Props) {
  const order = t.all.map((o) => o.id);
  const [local, setLocal, track, saving] = useLocal<{ targets: string[]; strength: number }>(sp.id);
  const targets = local?.targets ?? sp.effects?.invade?.targets ?? [];
  const strength = local?.strength ?? sp.effects?.invade?.strength ?? DEFAULT_INVADE_STRENGTH;
  const save = (change: { toggle?: string; strength?: number }) => {
    // 先在界面上显示出来（大星球上算一步要一会儿，连着点几个也都看得到）
    setLocal({ targets: change.toggle !== undefined ? toggleTarget(targets, change.toggle, order) : targets, strength: change.strength ?? strength });
    // 本世界里按轮到时世界上的生态列表排
    const now = () => (t.inWorld ? (world.value?.small.species.map((o) => o.id) ?? order) : order);
    track(t.queue(sp.id, '正在计算…', (cur) => effectsPatch(cur, withInvade(cur.effects, change, now()))));
  };
  const others = t.all.filter((o) => o.id !== sp.id);
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
        <Knob label="力度" min={0} max={5} step={0.1} value={strength} text={strength.toFixed(1)} onLive={(x) => setLocal({ targets, strength: x })} onDone={(x) => save({ strength: x })} onEnd={() => !saving() && setLocal(null)} />
      )}
    </>
  );
}

// 地名：类型名（“晶林”）与起名模板（每行一个）
function NamesSection({ sp, t }: Props) {
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
    void t.queue(sp.id, '正在起名…', (cur) => featurePatch(cur, label, lines));
  };
  return (
    <>
      <h5>地名</h5>
      <label>
        <span class="row between">
          <span>类型名</span>
          <span class="hint">如“晶林”</span>
        </span>
        <input class="wide-input" value={label} placeholder={clip(sp.name || '', MAX_LABEL)} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      <label>
        <span>起名模板（每行一个）</span>
        <textarea value={names} placeholder={'{color}晶林\n{myth}晶丛'} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} onBlur={save} />
      </label>
      <p class="hint">{'花括号里的词换成地名风格的词表里的词；不写按生态名起名'}</p>
      {problem && <div class="script-problem small">{problem}</div>}
    </>
  );
}

const SCRIPT_HINT: Record<SpeciesScriptKind, string> = {
  placement: '返回 0 到 1，乘进适宜度；0 就不长',
  color: "返回 [r, g, b] 或 '#rrggbb'",
};

// 本世界：两个脚本框（停一下就用到地图上，出错写在框下面）；库里：和以前的表单一样的脚本字段（整项换掉）
function ScriptsSection({ sp, t }: Props) {
  const w = world.value;
  const fields = Object.keys(w?.causes.fields ?? {});
  // 别处要求打开某个脚本框（出错提示的“编辑”）：把光标放进去
  const req = scriptEditorRequest.value;
  const [focus, setFocus] = useState<{ kind: SpeciesScriptKind; n: number } | null>(null);
  useEffect(() => {
    if (req?.species !== sp.id || !t.inWorld) return;
    setFocus((f) => ({ kind: req.kind, n: (f?.n ?? 0) + 1 }));
    scriptEditorRequest.value = null;
  }, [req, sp.id]);
  const scriptField = kindOf('biome')!.fields.filter((f) => f.key === 'scripts');
  return (
    <>
      <h5>脚本</h5>
      <p class="hint">用 JavaScript 决定它长在哪里、什么颜色</p>
      {t.inWorld ? (
        SPECIES_SCRIPT_KINDS.map((kind) => (
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
        ))
      ) : (
        <FieldsBox fields={scriptField} value={sp as unknown as Obj} onChange={(next) => void t.replace(sp.id, next)} issues={[]} />
      )}
    </>
  );
}

// 收着时里面的东西不画（脚本框要加载 acorn）。别处要求打开脚本框时自己展开
export function BiomeAdvanced({ sp, t, ctx }: Props & { ctx: PageCtx }) {
  const req = scriptEditorRequest.value;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (req?.species === sp.id && t.inWorld) setOpen(true);
  }, [req, sp.id]);
  return (
    <details class="species-advanced" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>高级</summary>
      {open && (
        <>
          <TolerancesSection sp={sp} t={t} ctx={ctx} />
          <LookSection sp={sp} t={t} />
          <ClimateSection sp={sp} t={t} />
          <InvadeSection sp={sp} t={t} />
          <NamesSection sp={sp} t={t} />
          <ScriptsSection sp={sp} t={t} />
        </>
      )}
    </details>
  );
}
