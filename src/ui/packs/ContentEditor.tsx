import { ImageUp, Plus, X } from 'lucide-preact';
import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { iconOf } from '../../render/settle-draw';
import { CityGlyph } from '../panels/settlements';
import { ICON_LABELS, IMAGE_MAX_CHARS, iconChoices, isImageUrl } from '../settlements';
import { showToast } from '../../state';
import type { FieldDesc } from '../../../core/content/registry';
import { Seg } from '../common';
import { RangeSliders } from '../components/RangeSliders';
import { Toggle } from '../components/Toggle';
import { type EditorIssue, type Obj, addedValue, colorHex, isTitleField, plainHex, withHex, defaultValue, isSparse, isObj, issuesAt, moveItem, objectOf, parseTags, setField, shownFields, sparseSplit, tagsText } from './fields';
import { Grip, MapEditor, OneRef, TagRefs, TitleEditor, TitleListEditor, TupleEditor, TuplesEditor, WeightTable, WeightedEditor, useDragSort } from './editors';
import { TendencyEditor } from './TendencyEditor';

// 通用编辑器：按登记表的字段表（FieldDesc）画出来。text / longtext / number / bool / color / enum / tags / weighted /
// list / map / script / json，when 指着的字段换了值时跟着换（fields.ts 的 setField）。
// 一组字、带权重的、键都在框里写完、离开框时才换上（打字时不被重新排版打断）。
// 第四十五轮：写了 ref 的从带搜索的下拉里选（RefPicker），tuple / tuples / title / titleList / tendencies 各有成块的控件
// （editors.tsx、TendencyEditor.tsx），可以不写的对象没写时是一个“添加”，列表能拖动换先后；不再有原样的 JSON 框

export type Path = PropertyKey[];

interface Props {
  fields: readonly FieldDesc[];
  value: Obj;
  onChange: (v: Obj) => void;
  path?: Path;
  issues: readonly EditorIssue[];
}

// 一组字段（一个对象）。倾向（tendencies）与按时代的倾向画在同一张表里
export function FieldsBox({ fields, value, onChange, path = [], issues }: Props) {
  const shown = shownFields(fields, value);
  if (isSparse(shown)) return <SparseBox fields={shown} value={value} onChange={onChange} path={path} issues={issues} />;
  const plainTend = shown.some((f) => f.type === 'tendencies' && !f.byEra);
  const eraTend = shown.some((f) => f.type === 'tendencies' && f.byEra);
  return (
    <div class="ed-fields">
      {shown.map((f) => {
        if (f.type === 'tendencies') {
          if (f.byEra && plainTend) return null;
          return (
            <div key={f.key}>
              <TendencyEditor obj={value} onChange={onChange} byEra={eraTend} label={f.label} hint={f.hint} />
              <Errors issues={issues} path={[...path, f.key]} />
            </div>
          );
        }
        return <Field key={f.key} f={f} value={value[f.key]} path={[...path, f.key]} issues={issues} onChange={(v) => onChange(setField(fields, value, f.key, v))} />;
      })}
    </div>
  );
}

// 全是可以不写的一组（规则的条件）：只列写了的（每项可以删），其余从“添加”里选
function SparseBox({ fields, value, onChange, path = [], issues }: Props) {
  const { present, missing } = sparseSplit(fields, value);
  const drop = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  return (
    <div class="ed-fields">
      {present.map((f) => (
        <div class="ed-sparse" key={f.key}>
          <Field f={f} value={value[f.key]} path={[...path, f.key]} issues={issues} onChange={(v) => onChange(setField(fields, value, f.key, v))} />
          <button class="small icon ghost" title="删除" onClick={() => drop(f.key)}>
            <X />
          </button>
        </div>
      ))}
      {!present.length && <p class="hint">没有条件</p>}
      {missing.length > 0 && (
        <select
          class="ed-add"
          value=""
          onChange={(e) => {
            const f = missing.find((x) => x.key === (e.target as HTMLSelectElement).value);
            if (f) onChange({ ...value, [f.key]: addedValue(f) });
          }}
        >
          <option value="">添加</option>
          {missing.map((f) => (
            <option value={f.key}>{f.label}</option>
          ))}
        </select>
      )}
    </div>
  );
}

// 出错的说明（这一处的，不含下面一层的）
export function Errors({ issues, path }: { issues: readonly EditorIssue[]; path: Path }) {
  const here = issuesAt(issues, path).filter((i) => i.path.length === path.length);
  return here.length ? <p class="warn small">{here.map((i) => i.message).join('；')}</p> : null;
}

const COMPLEX = new Set(['list', 'map', 'weighted', 'json', 'script', 'tuples']);

// 正在编辑的是哪一种内容（第二十四轮：城市等级、地标类型、点的类型的图标选内置的，点的类型能上传小图）
export const EditorKind = createContext<string | null>(null);

// 图标：一组内置的里选一个（旁边画出来）
function IconSelect({ kindId, value, onChange, optional }: { kindId: string; value: unknown; onChange: (v: unknown) => void; optional?: boolean }) {
  const keys = iconChoices(kindId) ?? [];
  const v = typeof value === 'string' ? value : '';
  const I = iconOf(v);
  return (
    <span class="row">
      {kindId === 'cityRank' ? <CityGlyph icon={v} /> : I ? <I /> : null}
      <select value={v} onChange={(e) => onChange((e.target as HTMLSelectElement).value || undefined)}>
        {optional && <option value="">（不写）</option>}
        {v && !keys.includes(v) && <option value={v}>{v}</option>}
        {keys.map((k) => (
          <option value={k}>
            {ICON_LABELS[k] ?? k} · {k}
          </option>
        ))}
      </select>
    </span>
  );
}

// 读一张小图成 data: 地址；太大的位图缩到 64 像素见方再试
async function readImage(file: File): Promise<string | null> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  if (url.length <= IMAGE_MAX_CHARS && isImageUrl(url)) return url;
  if (file.type === 'image/svg+xml') return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = 64 / Math.max(img.naturalWidth, img.naturalHeight, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * Math.min(1, k)));
  c.height = Math.max(1, Math.round(img.naturalHeight * Math.min(1, k)));
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
  const small = c.toDataURL('image/png');
  return small.length <= IMAGE_MAX_CHARS ? small : null;
}

// 点的类型的小图：上传（png、jpeg、webp、svg），删除
function ImageField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const v = typeof value === 'string' && isImageUrl(value) ? value : '';
  return (
    <span class="row">
      {v && <img class="type-img" src={v} alt="" />}
      <label class="file-button small">
        <ImageUp /> {v ? '换一张' : '上传'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={async (e) => {
            const input = e.target as HTMLInputElement;
            const f = input.files?.[0];
            input.value = '';
            if (!f) return;
            const url = await readImage(f).catch(() => null);
            if (url) onChange(url);
            else showToast('图片太大，换一张小的', true);
          }}
        />
      </label>
      {v && (
        <button class="small" onClick={() => onChange(undefined)}>
          删除
        </button>
      )}
    </span>
  );
}

function Field({ f, value, onChange, path, issues }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void; path: Path; issues: readonly EditorIssue[] }) {
  const bad = issuesAt(issues, path).length > 0;
  const kindId = useContext(EditorKind);
  // 图标、小图（第二十四轮）：顶层的 icon、点的类型的 image
  const icon = kindId && path.length === 1 && f.key === 'icon' && iconChoices(kindId);
  const image = kindId === 'pointType' && path.length === 1 && f.key === 'image';
  if (icon || image) {
    return (
      <div class="ed-field">
        <span class="ed-label" title={f.hint}>
          {f.label}
        </span>
        <div class="ed-control">
          {icon ? <IconSelect kindId={kindId!} value={value} onChange={onChange} optional={f.optional} /> : <ImageField value={value} onChange={onChange} />}
          <Errors issues={issues} path={path} />
        </div>
      </div>
    );
  }
  const count = Array.isArray(value) ? value.length : isObj(value) ? Object.keys(value).length : 0;
  // 称号（第二十三轮）：一行一种写法；键从 keyRef 里选（第四十五轮）
  if (isTitleField(f)) {
    return (
      <div class={`ed-group ${bad ? 'bad' : ''}`}>
        <div class="ed-label" title={f.hint}>
          {f.label}
        </div>
        <TitleEditor value={value} onChange={onChange} orig={f.key !== 'rulers'} keyRef={f.keyRef} />
        <Errors issues={issues} path={path} />
      </div>
    );
  }
  // 按引用的比例表（第四十五轮：格局、时代的各等级占多少）
  if (f.type === 'map' && f.keyRef && f.value?.type === 'number') {
    return (
      <div class={`ed-group ${bad ? 'bad' : ''}`}>
        <div class="ed-label" title={f.hint}>
          {f.label}
        </div>
        <WeightTable f={f} value={value} onChange={onChange} />
        <Errors issues={issues} path={path} />
      </div>
    );
  }
  // 可以不写的一组字段（第四十五轮）：没写时只有“添加”，写了的能删掉整个
  if (f.type === 'json' && f.of && f.optional && !isObj(value)) {
    return (
      <div class="ed-field">
        <span class="ed-label" title={f.hint}>
          {f.label}
        </span>
        <div class="ed-control">
          <button class="small" onClick={() => onChange(objectOf(f.of!))}>
            <Plus /> 添加
          </button>
        </div>
      </div>
    );
  }
  if (COMPLEX.has(f.type) && !(f.type === 'json' && f.of)) {
    return (
      <details class={`ed-group ${bad ? 'bad' : ''}`} open={bad || count < 8}>
        <summary title={f.hint}>
          {f.label}
          {f.type !== 'script' && f.type !== 'json' && <span class="hint"> {count}</span>}
        </summary>
        <Control f={f} value={value} onChange={onChange} path={path} issues={issues} />
        <Errors issues={issues} path={path} />
      </details>
    );
  }
  if (f.type === 'range') {
    return (
      <div class={`ed-group ${bad ? 'bad' : ''}`}>
        <div class="ed-label" title={f.hint}>
          {f.label}
        </div>
        <Control f={f} value={value} onChange={onChange} path={path} issues={issues} />
        <Errors issues={issues} path={path} />
      </div>
    );
  }
  if (f.type === 'json' && f.of) {
    return (
      <div class="ed-group">
        <div class="ed-label row between" title={f.hint}>
          {f.label}
          {f.optional && (
            <button class="small icon ghost" title="删除" onClick={() => onChange(undefined)}>
              <X />
            </button>
          )}
        </div>
        <FieldsBox fields={f.of} value={isObj(value) ? value : objectOf(f.of)} path={path} issues={issues} onChange={onChange} />
        <Errors issues={issues} path={path} />
      </div>
    );
  }
  return (
    <div class="ed-field">
      <span class="ed-label" title={f.hint}>
        {f.label}
      </span>
      <div class="ed-control">
        <Control f={f} value={value} onChange={onChange} path={path} issues={issues} />
        <Errors issues={issues} path={path} />
      </div>
    </div>
  );
}

// 框里写完、离开框（或回车）才换上
export function Draft({ text, onCommit, multi, mono, placeholder }: { text: string; onCommit: (t: string) => void; multi?: boolean; mono?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = () => {
    if (draft !== text) onCommit(draft);
  };
  if (multi) {
    return <textarea class={mono ? 'mono' : ''} rows={mono ? 6 : 2} value={draft} placeholder={placeholder} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} onBlur={commit} />;
  }
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// JSON：写坏了不换上，说一句
function JsonInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [err, setErr] = useState('');
  return (
    <>
      <Draft
        multi
        mono
        text={value === undefined ? '' : JSON.stringify(value, null, 1)}
        onCommit={(t) => {
          if (!t.trim()) {
            setErr('');
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(t));
            setErr('');
          } catch (e) {
            setErr(`不是 JSON：${(e as Error).message}`);
          }
        }}
      />
      {err && <p class="warn small">{err}</p>}
    </>
  );
}

export function Control({ f, value, onChange, path, issues }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void; path: Path; issues: readonly EditorIssue[] }) {
  switch (f.type) {
    case 'text':
      if (f.ref) return <OneRef refKind={f.ref} value={value} optional={f.optional} onChange={onChange} />;
      return <Draft text={typeof value === 'string' ? value : ''} onCommit={(t) => onChange(t)} />;
    case 'longtext':
      return <Draft multi text={typeof value === 'string' ? value : ''} onCommit={(t) => onChange(t)} />;
    case 'number':
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={f.min}
          max={f.max}
          step={f.step ?? 'any'}
          onChange={(e) => {
            const t = (e.target as HTMLInputElement).value;
            onChange(t === '' ? undefined : Number(t));
          }}
        />
      );
    case 'bool':
      return (
        <Toggle on={value === true} onChange={(on) => onChange(on)}>
          {''}
        </Toggle>
      );
    case 'color':
      // 画风的颜色可以是 rgb()、rgba()（第三十八轮）：取色器显示最近的颜色、留着不透明度，旁边一个框照字改
      return (
        <span class="row">
          <input type="color" value={colorHex(value)} onChange={(e) => onChange(withHex(value, (e.target as HTMLInputElement).value))} />
          {!plainHex(value) && <Draft text={String(value)} onCommit={(t) => onChange(t.trim() || undefined)} />}
        </span>
      );
    case 'enum': {
      const opts = (f.options ?? []).map((o): [string, string] => [o.value, o.label]);
      if (opts.length <= 4) return <Seg value={typeof value === 'string' ? value : ''} options={opts} onChange={(v) => onChange(v)} />;
      return (
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange((e.target as HTMLSelectElement).value || undefined)}>
          {f.optional && <option value="">（不写）</option>}
          {opts.map(([v, l]) => (
            <option value={v}>{l}</option>
          ))}
        </select>
      );
    }
    case 'tags':
      if (f.ref) return <TagRefs refKind={f.ref} value={value} onChange={onChange} />;
      return <Draft text={tagsText(value)} placeholder="空格隔开" onCommit={(t) => onChange(parseTags(t))} />;
    case 'weighted':
      return <WeightedEditor value={value} onChange={onChange} />;
    case 'list':
      return <ListEditor f={f} value={value} onChange={onChange} path={path} issues={issues} />;
    case 'range': {
      const r = isObj(value) ? value : (defaultValue(f) as Obj);
      const lo = f.min ?? 0;
      const hi = f.max ?? 0;
      // 两头都不限时不写这个字段（和没写过一样）
      return <RangeSliders lo={lo} hi={hi} step={f.step ?? 1} unit={f.unit ?? 'm'} value={{ low: Number(r.low), high: Number(r.high) }} onCommit={(v) => onChange(v.low <= lo && v.high >= hi ? undefined : v)} />;
    }
    case 'tuple':
      return <TupleEditor f={f} value={value} onChange={onChange} />;
    case 'tuples':
      return <TuplesEditor f={f} value={value} onChange={onChange} />;
    case 'title':
      return <TitleEditor value={value} onChange={onChange} orig keyRef={f.keyRef} />;
    case 'titleList':
      return <TitleListEditor value={value} onChange={onChange} />;
    case 'tendencies':
      return null;
    case 'map':
      return <MapEditor f={f} value={value} onChange={onChange} path={path} issues={issues} />;
    case 'script': {
      const s = isObj(value) ? value : (defaultValue(f) as Obj);
      return <Draft multi mono text={typeof s.src === 'string' ? s.src : ''} onCommit={(src) => onChange(src.trim() ? { ...s, src } : undefined)} />;
    }
    case 'json':
      return <JsonInput value={value} onChange={onChange} />;
  }
}

// 一组对象：每一项一块，左边的把手拖动换先后（换说法、限谁用的几条按先后，第一条满足的起作用）
function ListEditor({ f, value, onChange, path, issues }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void; path: Path; issues: readonly EditorIssue[] }) {
  const list = Array.isArray(value) ? value : [];
  const of = f.of ?? [];
  const drag = useDragSort((a, b) => onChange(moveItem(list, a, b)));
  return (
    <div class="ed-list">
      {list.map((item, k) => {
        const it = drag.item(k);
        return (
          <div class={`ed-item ${it.dropClass}`} onDragOver={it.onDragOver} onDrop={it.onDrop}>
            {list.length > 1 && <Grip {...drag.handle(k)} />}
            <FieldsBox fields={of} value={isObj(item) ? item : {}} path={[...path, k]} issues={issues} onChange={(v) => onChange(list.map((x, j) => (j === k ? v : x)))} />
            <button class="small icon ghost" title="删除" onClick={() => onChange(list.filter((_, j) => j !== k))}>
              <X />
            </button>
          </div>
        );
      })}
      <button class="small" onClick={() => onChange([...list, objectOf(of)])}>
        <Plus /> 添加
      </button>
    </div>
  );
}
