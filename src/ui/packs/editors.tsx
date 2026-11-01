import { GripVertical, Plus, X } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import type { FieldDesc } from '../../../core/content/registry';
import { FEATURE_INFO, type FeatureType } from '../../../core/features';
import { Control, Draft, Errors, FieldsBox, type Path } from './ContentEditor';
import { type EditorIssue, type Obj, type TitleRow, defaultValue, isObj, moveItem, newKey, objectOf, renameKey, titleRows, titleValue, weightedRows, weightedValue } from './fields';
import { RefPicker, useRefOptions } from './RefPicker';
import { DEFAULT_KEY, type RefOption, refLabel } from './refs';

// 通用编辑器里几种成块的控件（第四十五轮从 ContentEditor.tsx 分出来，加了引用的下拉、拖动换先后）：
// 称号、几种称号、带权重的一组、固定几位的数、一组固定几位的数、键 → 值、按引用的比例表、引用的一组

// ---------- 拖动换先后 ----------

// 一列里拖动换先后：把手（handle）拖到另一项（item）上放下
export function useDragSort(onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const end = () => {
    setDrag(null);
    setOver(null);
  };
  const item = (k: number) => ({
    onDragOver: (e: DragEvent) => {
      if (drag === null) return;
      e.preventDefault();
      if (over !== k) setOver(k);
    },
    onDrop: (e: DragEvent) => {
      if (drag === null) return;
      e.preventDefault();
      if (drag !== k) onMove(drag, k);
      end();
    },
    dropClass: drag !== null && over === k && drag !== k ? (drag < k ? 'drop-after' : 'drop-before') : '',
  });
  const handle = (k: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', String(k));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      setDrag(k);
    },
    onDragEnd: end,
  });
  return { item, handle };
}

export function Grip(props: { draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }) {
  return (
    <span class="ed-grip" title="拖动换先后" {...props}>
      <GripVertical />
    </span>
  );
}

// ---------- 称号 ----------

const TIER_EXTRA: readonly RefOption[] = [{ id: DEFAULT_KEY, label: '其余', hint: '没写到的' }];

// 称号：一行一种（键从 keyRef 里选：国家等级、文化、文化组，或“其余”；中文；原文的写法，{name} 换成国名）。
// 只有“其余”一行时存回最简单的写法。空着中文的行先留在框里，不存
export function TitleEditor({ value, onChange, orig, keyRef }: { value: unknown; onChange: (v: unknown) => void; orig: boolean; keyRef?: string | readonly string[] }) {
  const [rows, setRows] = useState<TitleRow[]>(() => titleRows(value));
  const key = JSON.stringify(value ?? null);
  useEffect(() => {
    if (JSON.stringify(titleValue(rows) ?? null) !== key) setRows(titleRows(value));
  }, [key]);
  const keys = useRefOptions(keyRef ?? [], { extra: TIER_EXTRA });
  const put = (next: TitleRow[]) => {
    setRows(next);
    onChange(titleValue(next));
  };
  const edit = (k: number, patch: Partial<TitleRow>) => put(rows.map((r, j) => (j === k ? { ...r, ...patch } : r)));
  const drag = useDragSort((a, b) => put(moveItem(rows, a, b)));
  const used = new Set(rows.map((r) => r.key));
  return (
    <div class="ed-rows">
      {rows.map((r, k) => {
        const it = drag.item(k);
        return (
          <div class={`ed-row ${it.dropClass}`} onDragOver={it.onDragOver} onDrop={it.onDrop}>
            <Grip {...drag.handle(k)} />
            {keyRef ? (
              <span class="ed-title-key">
                <RefPicker options={keys} value={r.key} exclude={used} onPick={(id) => edit(k, { key: id })} placeholder="等级" />
              </span>
            ) : (
              <Draft text={r.key} placeholder={DEFAULT_KEY} onCommit={(t) => edit(k, { key: t.trim() })} />
            )}
            <Draft text={r.zh} placeholder="王国" onCommit={(t) => edit(k, { zh: t })} />
            {orig && <Draft text={r.orig} placeholder="Kingdom of {name}" onCommit={(t) => edit(k, { orig: t })} />}
            <button class="small icon ghost" title="删除" onClick={() => put(rows.filter((_, j) => j !== k))}>
              <X />
            </button>
          </div>
        );
      })}
      <button class="small" onClick={() => setRows([...rows, { key: rows.some((r) => r.key === DEFAULT_KEY) ? '' : DEFAULT_KEY, zh: '', orig: '' }])}>
        <Plus /> 添加
      </button>
    </div>
  );
}

// 几种称号的写法（时代的帝国、联邦、同盟的称号）：一行一种（中文、原文），按种子挑一个
export function TitleListEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const list = Array.isArray(value) ? value : [];
  const rows = list.map((x) => titleRows(x)[0] ?? { key: DEFAULT_KEY, zh: '', orig: '' });
  const one = (r: TitleRow) => titleValue([{ ...r, key: DEFAULT_KEY }]);
  const put = (next: TitleRow[]) => onChange(next.map(one).filter((x) => x !== undefined));
  const drag = useDragSort((a, b) => onChange(moveItem(list, a, b)));
  return (
    <div class="ed-rows">
      {rows.map((r, k) => {
        const it = drag.item(k);
        return (
          <div class={`ed-row ${it.dropClass}`} onDragOver={it.onDragOver} onDrop={it.onDrop}>
            <Grip {...drag.handle(k)} />
            <Draft text={r.zh} placeholder="帝国" onCommit={(t) => put(rows.map((x, j) => (j === k ? { ...x, zh: t } : x)))} />
            <Draft text={r.orig} placeholder="Empire of {name}" onCommit={(t) => put(rows.map((x, j) => (j === k ? { ...x, orig: t } : x)))} />
            <button class="small icon ghost" title="删除" onClick={() => onChange(list.filter((_, j) => j !== k))}>
              <X />
            </button>
          </div>
        );
      })}
      <AddTitle onAdd={(zh) => onChange([...list, zh])} />
    </div>
  );
}

// 新加一种称号：先写中文，写好了才加进去（空的不合格式）
function AddTitle({ onAdd }: { onAdd: (zh: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div class="ed-row">
      <input
        type="text"
        value={text}
        placeholder="添加一种"
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            onAdd(text.trim());
            setText('');
          }
        }}
        onBlur={() => {
          if (text.trim()) {
            onAdd(text.trim());
            setText('');
          }
        }}
      />
    </div>
  );
}

// ---------- 带权重的一组 ----------

// 一行一项（字、权重，权重空着是 1），可以拖动换先后
export function WeightedEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const rows = weightedRows(value);
  const put = (k: number, patch: Partial<(typeof rows)[number]>) => onChange(weightedValue(rows.map((r, j) => (j === k ? { ...r, ...patch } : r))));
  const drag = useDragSort((a, b) => onChange(weightedValue(moveItem(rows, a, b))));
  return (
    <div class="ed-rows">
      {rows.map((r, k) => {
        const it = drag.item(k);
        return (
          <div class={`ed-row ${it.dropClass}`} onDragOver={it.onDragOver} onDrop={it.onDrop}>
            <Grip {...drag.handle(k)} />
            <Draft text={r.text} placeholder="（空）" onCommit={(t) => put(k, { text: t })} />
            <input
              type="number"
              class="ed-weight"
              value={r.w ?? ''}
              min={0}
              step="any"
              placeholder="1"
              title="权重"
              onChange={(e) => {
                const t = (e.target as HTMLInputElement).value;
                put(k, { w: t === '' ? undefined : Number(t) });
              }}
            />
            <button class="small icon ghost" title="删除" onClick={() => onChange(weightedValue(rows.filter((_, j) => j !== k)))}>
              <X />
            </button>
          </div>
        );
      })}
      <button class="small" onClick={() => onChange(weightedValue([...rows, { text: '' }]))}>
        <Plus /> 添加
      </button>
    </div>
  );
}

// ---------- 固定几位的数 ----------

// 一个数的框（空着时 undefined）
function NumberBox({ f, value, onChange }: { f: FieldDesc; value: unknown; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      class="ed-num"
      value={typeof value === 'number' ? value : ''}
      min={f.min}
      max={f.max}
      step={f.step ?? 'any'}
      placeholder={f.label}
      title={f.label}
      onChange={(e) => {
        const t = (e.target as HTMLInputElement).value;
        onChange(t === '' ? undefined : Number(t));
      }}
    />
  );
}

// 一排：每一位一个框（年份的“最早 — 现在”）
export function TupleEditor({ f, value, onChange }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void }) {
  const items = f.items ?? [];
  const cur = Array.isArray(value) ? value : (defaultValue(f) as unknown[]);
  return (
    <span class="row ed-tuple">
      {items.map((it, k) => (
        <>
          {k > 0 && <span class="hint">—</span>}
          <NumberBox f={it} value={cur[k]} onChange={(v) => onChange(cur.map((x, j) => (j === k ? (v ?? defaultValue(it)) : x)))} />
        </>
      ))}
    </span>
  );
}

// 一组：一行一排，可以删、加、拖动换先后（音节数 [[音节数, 权重], …]）
export function TuplesEditor({ f, value, onChange }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void }) {
  const list = Array.isArray(value) ? value : [];
  const items = f.items ?? [];
  const drag = useDragSort((a, b) => onChange(moveItem(list, a, b)));
  return (
    <div class="ed-rows">
      <div class="ed-row hint ed-tuple-head">
        <span class="ed-grip" />
        {items.map((it) => (
          <span class="ed-num">{it.label}</span>
        ))}
      </div>
      {list.map((row, k) => {
        const it = drag.item(k);
        const cur = Array.isArray(row) ? row : [];
        return (
          <div class={`ed-row ${it.dropClass}`} onDragOver={it.onDragOver} onDrop={it.onDrop}>
            <Grip {...drag.handle(k)} />
            {items.map((d, j) => (
              <NumberBox f={d} value={cur[j]} onChange={(v) => onChange(list.map((x, i) => (i === k ? items.map((dd, jj) => (jj === j ? (v ?? defaultValue(dd)) : (cur[jj] ?? defaultValue(dd)))) : x)))} />
            ))}
            <button class="small icon ghost" title="删除" onClick={() => onChange(list.filter((_, j) => j !== k))}>
              <X />
            </button>
          </div>
        );
      })}
      <button class="small" onClick={() => onChange([...list, items.map((d) => defaultValue(d))])}>
        <Plus /> 添加
      </button>
    </div>
  );
}

// ---------- 引用 ----------

// 引用的一组（文化组、取值、生态……）：一项一个小块（名字、删除），最后一个“添加”从下拉里选
export function TagRefs({ refKind, value, onChange }: { refKind: string; value: unknown; onChange: (v: unknown) => void }) {
  const list = Array.isArray(value) ? value.map(String) : [];
  const opts = useRefOptions(refKind);
  const set = new Set(list);
  return (
    <span class="ed-tags">
      {list.map((id) => (
        <span class="ed-tag" title={id}>
          {refLabel(opts, id)}
          <button class="small icon ghost" title="删除" onClick={() => onChange(list.filter((x) => x !== id))}>
            <X />
          </button>
        </span>
      ))}
      <RefPicker add options={opts} exclude={set} onPick={(id) => onChange([...list, id])} />
    </span>
  );
}

// 引用的一个（文化组、地名风格……）
export function OneRef({ refKind, value, optional, onChange }: { refKind: string; value: unknown; optional?: boolean; onChange: (v: unknown) => void }) {
  const opts = useRefOptions(refKind);
  return <RefPicker options={opts} value={typeof value === 'string' ? value : ''} onPick={(id) => onChange(id)} onClear={optional ? () => onChange(undefined) : undefined} />;
}

// 按引用的比例表（格局、时代的各等级占多少，派系的基础）：列出全部能选的（国家等级……），每行一个数，空着的不写
export function WeightTable({ f, value, onChange }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void }) {
  const obj: Obj = isObj(value) ? value : {};
  const opts = useRefOptions(f.keyRef ?? [], f.keyRef === 'govCategory' ? { extra: TIER_EXTRA } : undefined);
  const keys = [...opts.map((o) => o.id), ...Object.keys(obj).filter((k) => !opts.some((o) => o.id === k))];
  const shown = keys.filter((k) => obj[k] !== undefined || opts.length <= 12);
  const missing = opts.filter((o) => obj[o.id] === undefined && !shown.includes(o.id));
  const sum = Object.values(obj).reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0);
  const put = (k: string, v: number | undefined) => {
    const next: Obj = {};
    // 按选项的先后存（表里看到的先后）
    for (const key of keys) {
      const x = key === k ? v : obj[key];
      if (x !== undefined) next[key] = x;
    }
    onChange(next);
  };
  return (
    <div class="ed-rows ed-wtable">
      {shown.map((k) => {
        const v = obj[k];
        const o = opts.find((x) => x.id === k);
        return (
          <div class="ed-row">
            <span class="ed-wkey" title={k}>
              {o?.color && <span class="swatch" style={{ background: o.color }} />}
              {refLabel(opts, k)}
            </span>
            <NumberBox f={f.value ?? f} value={v} onChange={(x) => put(k, x)} />
            <span class="hint ed-wpct">{typeof v === 'number' && sum > 0 ? `${Math.round((v / sum) * 100)}%` : ''}</span>
          </div>
        );
      })}
      {missing.length > 0 && <RefPicker add options={missing} onPick={(id) => put(id, typeof f.value?.default === 'number' ? f.value.default : 1)} />}
    </div>
  );
}

// ---------- 键 → 值 ----------

// map 的键是地物类型时旁边写中文
const keyLabel = (k: string): string | undefined => (k === 'province' ? '省份' : FEATURE_INFO[k as FeatureType]?.label);

// 键在框里改（离开框时换上，已有的键不换），值按 value（或 of 的一组字段）
export function MapEditor({ f, value, onChange, path, issues }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void; path: Path; issues: readonly EditorIssue[] }) {
  const obj = isObj(value) ? value : {};
  const put = (k: string, v: unknown) => onChange({ ...obj, [k]: v });
  const blank = () => (f.of ? objectOf(f.of) : f.value ? defaultValue(f.value) : '');
  return (
    <div class={`ed-map ${f.of ? 'nested' : ''}`}>
      {Object.entries(obj).map(([k, v]) => (
        <div class="ed-entry">
          <div class="ed-key">
            <Draft text={k} onCommit={(t) => onChange(renameKey(obj, k, t.trim()))} />
            {keyLabel(k) && <span class="hint">{keyLabel(k)}</span>}
            <button
              class="small icon ghost"
              title="删除"
              onClick={() => {
                const next = { ...obj };
                delete next[k];
                onChange(next);
              }}
            >
              <X />
            </button>
          </div>
          <div class="ed-value">
            {f.of ? (
              <FieldsBox fields={f.of} value={isObj(v) ? v : {}} path={[...path, k]} issues={issues} onChange={(nv) => put(k, nv)} />
            ) : f.value ? (
              <>
                <Control f={f.value} value={v} onChange={(nv) => put(k, nv)} path={[...path, k]} issues={issues} />
                <Errors issues={issues} path={[...path, k]} />
              </>
            ) : null}
          </div>
        </div>
      ))}
      <button class="small" onClick={() => put(newKey(obj), blank())}>
        <Plus /> 添加
      </button>
    </div>
  );
}
