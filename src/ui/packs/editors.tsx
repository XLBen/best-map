import { ChevronRight, GripVertical, Plus, X } from 'lucide-preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { FieldDesc } from '../../../core/content/registry';
import { Draft } from './editor-parts';
import { type Obj, type TitleRow, defaultValue, isObj, moveItem, titleRows, titleValue, weightedRows, weightedValue } from './fields';
import { RefGo, RefPicker, useRefOptions } from './RefPicker';
import { DEFAULT_KEY, type RefOption, refItem, refLabel } from './refs';
import { ShareBar } from '../components/ShareBar';
import { library } from '../../library';
import { world } from '../../state';

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
            <button class="small icon ghost" title="删除" aria-label="删除" onClick={() => put(rows.filter((_, j) => j !== k))}>
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
            <button class="small icon ghost" title="删除" aria-label="删除" onClick={() => onChange(list.filter((_, j) => j !== k))}>
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
              title="多少"
              onChange={(e) => {
                const t = (e.target as HTMLInputElement).value;
                put(k, { w: t === '' ? undefined : Number(t) });
              }}
            />
            <button class="small icon ghost" title="删除" aria-label="删除" onClick={() => onChange(weightedValue(rows.filter((_, j) => j !== k)))}>
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
            <button class="small icon ghost" title="删除" aria-label="删除" onClick={() => onChange(list.filter((_, j) => j !== k))}>
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
  const go = useContext(RefGo);
  return (
    <span class="ed-tags">
      {list.map((id) => (
        <span class="ed-tag" title={id}>
          <RefText go={go?.(refKind, id) ?? null} text={refLabel(opts, id)} />
          <button class="small icon ghost" title="删除" aria-label="删除" onClick={() => onChange(list.filter((x) => x !== id))}>
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
  const go = useContext(RefGo)?.(refKind, typeof value === 'string' ? value : '') ?? null;
  return (
    <span class="ref-one">
      <RefPicker options={opts} value={typeof value === 'string' ? value : ''} onPick={(id) => onChange(id)} onClear={optional ? () => onChange(undefined) : undefined} />
      {go && (
        <a class="ref-go" role="button" title="打开这一项" aria-label="打开这一项" onClick={go}>
          <ChevronRight />
        </a>
      )}
    </span>
  );
}

// 引用的名字：能点过去时是链接（用 a：只读的表单里 button 都不能点）
function RefText({ go, text }: { go: (() => void) | null; text: string }) {
  return go ? (
    <a class="ref-link" role="button" title="打开这一项" onClick={go}>
      {text}
    </a>
  ) : (
    <>{text}</>
  );
}

// 按引用的比例表（第四十五轮；第八十一轮：时代的国家等级的比例）：一条分段的色条，拖分界改两段（ShareBar），松手存一次，存的是百分之几。
// 整个不写时按各等级自己的“多少”（weight，省略为 1）画；拖到 0 的那一级不出现
export function WeightTable({ f, value, onChange }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void }) {
  const obj: Obj = isObj(value) ? value : {};
  const opts = useRefOptions(f.keyRef ?? []);
  const w = world.value;
  const lib = library.value;
  const keys = [...opts.map((o) => o.id), ...Object.keys(obj).filter((k) => !opts.some((o) => o.id === k))];
  const written = Object.keys(obj).length > 0;
  const ref = typeof f.keyRef === 'string' ? f.keyRef : '';
  const values = keys.map((k) => {
    const v = obj[k];
    if (typeof v === 'number') return v;
    if (written) return 0;
    const own = ref ? refItem(ref, k, { world: w, lib })?.weight : undefined;
    return typeof own === 'number' ? own : 1;
  });
  if (!keys.length) return <p class="hint">没有{f.label}</p>;
  return <ShareBar parts={keys.map((k) => ({ key: k, label: refLabel(opts, k) }))} values={values} onCommit={(v) => onChange(Object.fromEntries(keys.map((k, j) => [k, v[j]])))} />;
}
