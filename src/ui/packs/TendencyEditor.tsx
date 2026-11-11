import { X } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Slider } from '../components/Slider';
import { library } from '../../library';
import { world } from '../../state';
import { type Obj, logScale } from './fields';
import { RefPicker, useRefOptions } from './RefPicker';
import { GOVERNMENT_DIM, refItem, refLabel } from './refs';
import { type EraKey, addDim, addValue, erasWritten, removeDim, removeValue, setWeight, shares, tableAt, tendencyRows } from './tendency';

// 倾向的表（第四十五轮）：行是维度（宗教、政体……），每行是几个取值与“多少”（第八十一轮是滑块）（旁边写占这一维的百分比）。
// 表上面选“不分时代”或某个时代：选了时代改的是按时代的倾向（写了的那几维换掉不分时代的）。
// 文化只写与文化组不同的维度：表下面写沿用文化组的几维

const pct = (x: number) => `${Math.round(x * 100)}%`;

// 这张表怎么读（每张倾向的表上面都写；各处自己的一句在它下面）
const TENDENCY_HELP = '一行一个变量；拖滑块改每种的多少，右边是占比';

// 一个取值的“多少”（第八十一轮：以前是数字框）：0–1000 按对数的滑块，松手才换上
const WEIGHT = logScale(0, 1000, 0.1);
function WeightSlider({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [value]);
  const cur = draft ?? value;
  return (
    <span class="ed-number ed-weight">
      <Slider
        label={`${label}的多少`}
        pos={WEIGHT.pos(cur)}
        text={String(cur)}
        textAt={(p) => String(WEIGHT.at(p))}
        onDraft={(p) => setDraft(WEIGHT.at(p))}
        onCommit={(p) => {
          const v = WEIGHT.at(p);
          setDraft(v);
          if (v !== value) onCommit(v);
        }}
        onCancel={() => setDraft(null)}
      />
    </span>
  );
}

export function TendencyEditor({ obj, onChange, byEra, label, hint }: { obj: Obj; onChange: (v: Obj) => void; byEra: boolean; label: string; hint?: string }) {
  const [era, setEra] = useState<EraKey>(null);
  const eras = useRefOptions('era');
  const dims = useRefOptions('dimension');
  const values = useRefOptions('popValue');
  const govs = useRefOptions('government');
  const written = erasWritten(obj);
  const rows = tendencyRows(tableAt(obj, era));
  const have = useMemo(() => new Set(rows.map((r) => r.dim)), [rows.map((r) => r.dim).join('|')]);
  const eraChoices = [...eras.map((e) => e.id), ...written.filter((id) => !eras.some((e) => e.id === id))];
  // 文化：沿用文化组的几维（这一份没写的）
  const group = typeof obj.group === 'string' ? refItem('cultureGroup', obj.group, { world: world.value, lib: library.value }) : undefined;
  const inherited = group ? tendencyRows(era !== null && tableAt(group, era) && Object.keys(tableAt(group, era)).length ? tableAt(group, era) : tableAt(group, null)).filter((r) => !have.has(r.dim)) : [];
  const valueOpts = (dim: string) => (dim === GOVERNMENT_DIM ? govs : values.filter((v) => v.dimension === dim));
  return (
    <div class="ed-group tend">
      <div class="row between tend-head">
        <span class="ed-label">{label}</span>
        {byEra && (
          <select
            class="tend-era"
            value={era ?? ''}
            aria-label="不分时代的，或某个时代的"
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setEra(v || null);
            }}
          >
            <option value="">不分时代</option>
            {eraChoices.map((id) => (
              <option value={id}>
                {refLabel(eras, id)}
                {written.includes(id) ? ' · 写了' : ''}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* 第九十三轮：说明直接写在表上面（以前在悬停里，触摸屏看不到） */}
      <p class="hint ed-hint">{TENDENCY_HELP}</p>
      {hint && <p class="hint ed-hint">{hint}</p>}
      {era !== null && <p class="hint">写了的那几个变量换掉不分时代的</p>}
      <div class="tend-rows">
        {rows.map((r) => {
          const opts = valueOpts(r.dim);
          const share = shares(r);
          const ids = new Set(r.entries.map((e) => e.id));
          return (
            <div class="tend-row">
              <span class="tend-dim" title={r.dim}>
                {refLabel(dims, r.dim)}
              </span>
              <div class="tend-values">
                {r.entries.map((e, k) => {
                  const o = opts.find((x) => x.id === e.id);
                  return (
                    <span class="tend-chip" title={e.id}>
                      {o?.color && <span class="swatch" style={{ background: o.color }} />}
                      <span class="tend-name">{o?.label ?? e.id}</span>
                      <WeightSlider label={o?.label ?? e.id} value={e.w} onCommit={(v) => onChange(setWeight(obj, era, r.dim, e.id, v))} />
                      <span class="hint tend-pct">{pct(share[k])}</span>
                      <button class="small icon ghost" title="删除" aria-label="删除" onClick={() => onChange(removeValue(obj, era, r.dim, e.id))}>
                        <X />
                      </button>
                    </span>
                  );
                })}
                <RefPicker add options={opts} exclude={ids} onPick={(id) => onChange(addValue(obj, era, r.dim, id))} />
              </div>
              <button class="small icon ghost" title="删除这个变量" aria-label="删除这个变量" onClick={() => onChange(removeDim(obj, era, r.dim))}>
                <X />
              </button>
            </div>
          );
        })}
        {!rows.length && <p class="hint">{era === null ? '没有倾向' : '这个时代没有另写'}</p>}
      </div>
      <RefPicker add options={dims} exclude={have} onPick={(dim) => onChange(addDim(obj, era, dim))}>
        添加变量
      </RefPicker>
      {inherited.length > 0 && (
        <p class="hint tend-inherit">
          沿用文化组：
          {inherited.map((r) => `${refLabel(dims, r.dim)}（${r.entries.slice(0, 3).map((e) => refLabel(valueOpts(r.dim), e.id)).join('、')}${r.entries.length > 3 ? '…' : ''}）`).join('；')}
        </p>
      )}
    </div>
  );
}
