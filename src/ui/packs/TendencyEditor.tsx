import { X } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { library } from '../../library';
import { world } from '../../state';
import type { Obj } from './fields';
import { RefPicker, useRefOptions } from './RefPicker';
import { GOVERNMENT_DIM, refItem, refLabel } from './refs';
import { type EraKey, addDim, addValue, erasWritten, removeDim, removeValue, setWeight, shares, tableAt, tendencyRows } from './tendency';

// 倾向的表（第四十五轮）：行是维度（宗教、政体……），每行是几个取值与权重（旁边写占这一维的百分比）。
// 表上面选“不分时代”或某个时代：选了时代改的是按时代的倾向（写了的那几维换掉不分时代的）。
// 文化只写与文化组不同的维度：表下面写沿用文化组的几维

const pct = (x: number) => `${Math.round(x * 100)}%`;

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
        <span class="ed-label" title={hint}>
          {label}
        </span>
        {byEra && (
          <select
            class="tend-era"
            value={era ?? ''}
            title="不分时代的，或某个时代的"
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
      {era !== null && <p class="hint">写了的那几维换掉不分时代的</p>}
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
                      <input
                        type="number"
                        class="ed-weight"
                        value={e.w}
                        min={0}
                        max={1000}
                        step={0.1}
                        title="权重"
                        onChange={(ev) => onChange(setWeight(obj, era, r.dim, e.id, Number((ev.target as HTMLInputElement).value)))}
                      />
                      <span class="hint tend-pct">{pct(share[k])}</span>
                      <button class="small icon ghost" title="删除" onClick={() => onChange(removeValue(obj, era, r.dim, e.id))}>
                        <X />
                      </button>
                    </span>
                  );
                })}
                <RefPicker add options={opts} exclude={ids} onPick={(id) => onChange(addValue(obj, era, r.dim, id))} />
              </div>
              <button class="small icon ghost" title="删除这一维" onClick={() => onChange(removeDim(obj, era, r.dim))}>
                <X />
              </button>
            </div>
          );
        })}
        {!rows.length && <p class="hint">{era === null ? '没有倾向' : '这个时代没有另写'}</p>}
      </div>
      <RefPicker add options={dims} exclude={have} onPick={(dim) => onChange(addDim(obj, era, dim))}>
        添加维度
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
