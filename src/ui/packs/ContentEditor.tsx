import { ImageUp, Plus, X } from 'lucide-preact';
import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { iconOf } from '../../render/settle-draw';
import { CityGlyph } from '../panels/settlements';
import { ICON_LABELS, IMAGE_MAX_CHARS, iconChoices, isImageUrl } from '../settlements';
import { showToast } from '../../state';
import type { FieldDesc } from '../../../core/content/registry';
import { FEATURE_INFO, type FeatureType } from '../../../core/features';
import { Seg } from '../common';
import { Toggle } from '../components/Toggle';
import {
  type EditorIssue,
  type Obj,
  type TitleRow,
  addedValue,
  isTitleField,
  titleRows,
  titleValue,
  defaultValue,
  isSparse,
  isObj,
  issuesAt,
  newKey,
  objectOf,
  parseTags,
  renameKey,
  setField,
  shownFields,
  sparseSplit,
  tagsText,
  weightedRows,
  weightedValue,
} from './fields';

// 通用编辑器：按登记表的字段表（FieldDesc）画出来。text / longtext / number / bool / color / enum / tags / weighted /
// list / map / script / json，when 指着的字段换了值时跟着换（fields.ts 的 setField）。
// 一组字、带权重的、键都在框里写完、离开框时才换上（打字时不被重新排版打断）

type Path = PropertyKey[];

interface Props {
  fields: readonly FieldDesc[];
  value: Obj;
  onChange: (v: Obj) => void;
  path?: Path;
  issues: readonly EditorIssue[];
}

// map 的键是地物类型时旁边写中文
const keyLabel = (k: string): string | undefined => (k === 'province' ? '省份' : FEATURE_INFO[k as FeatureType]?.label);

// 一组字段（一个对象）
export function FieldsBox({ fields, value, onChange, path = [], issues }: Props) {
  if (isSparse(shownFields(fields, value))) return <SparseBox fields={shownFields(fields, value)} value={value} onChange={onChange} path={path} issues={issues} />;
  return (
    <div class="ed-fields">
      {shownFields(fields, value).map((f) => (
        <Field key={f.key} f={f} value={value[f.key]} path={[...path, f.key]} issues={issues} onChange={(v) => onChange(setField(fields, value, f.key, v))} />
      ))}
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
function Errors({ issues, path }: { issues: readonly EditorIssue[]; path: Path }) {
  const here = issuesAt(issues, path).filter((i) => i.path.length === path.length);
  return here.length ? <p class="warn small">{here.map((i) => i.message).join('；')}</p> : null;
}

const COMPLEX = new Set(['list', 'map', 'weighted', 'json', 'script']);

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
  // 称号（第二十三轮）：一行一种写法
  if (isTitleField(f)) {
    return (
      <div class={`ed-group ${bad ? 'bad' : ''}`}>
        <div class="ed-label" title={f.hint}>
          {f.label}
        </div>
        <TitleEditor value={value} onChange={onChange} orig={f.key === 'title'} />
        <Errors issues={issues} path={path} />
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
  if (f.type === 'json' && f.of) {
    return (
      <div class="ed-group">
        <div class="ed-label" title={f.hint}>
          {f.label}
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
function Draft({ text, onCommit, multi, mono, placeholder }: { text: string; onCommit: (t: string) => void; multi?: boolean; mono?: boolean; placeholder?: string }) {
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

function Control({ f, value, onChange, path, issues }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void; path: Path; issues: readonly EditorIssue[] }) {
  switch (f.type) {
    case 'text':
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
      return <input type="color" value={typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#888888'} onChange={(e) => onChange((e.target as HTMLInputElement).value)} />;
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
      return <Draft text={tagsText(value)} placeholder="空格隔开" onCommit={(t) => onChange(parseTags(t))} />;
    case 'weighted':
      return <WeightedEditor value={value} onChange={onChange} />;
    case 'list': {
      const list = Array.isArray(value) ? value : [];
      const of = f.of ?? [];
      return (
        <div class="ed-list">
          {list.map((item, k) => (
            <div class="ed-item">
              <FieldsBox fields={of} value={isObj(item) ? item : {}} path={[...path, k]} issues={issues} onChange={(v) => onChange(list.map((x, j) => (j === k ? v : x)))} />
              <button class="small icon ghost" title="删除" onClick={() => onChange(list.filter((_, j) => j !== k))}>
                <X />
              </button>
            </div>
          ))}
          <button class="small" onClick={() => onChange([...list, objectOf(of)])}>
            <Plus /> 添加
          </button>
        </div>
      );
    }
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

// 称号：一行一种（键：default、文化 id、文化组 id；中文；原文的写法，{name} 换成国名）。空着中文的行先留在框里，不存
function TitleEditor({ value, onChange, orig }: { value: unknown; onChange: (v: unknown) => void; orig: boolean }) {
  const [rows, setRows] = useState<TitleRow[]>(() => titleRows(value));
  const key = JSON.stringify(value ?? null);
  useEffect(() => {
    if (JSON.stringify(titleValue(rows) ?? null) !== key) setRows(titleRows(value));
  }, [key]);
  const put = (next: TitleRow[]) => {
    setRows(next);
    onChange(titleValue(next));
  };
  const edit = (k: number, patch: Partial<TitleRow>) => put(rows.map((r, j) => (j === k ? { ...r, ...patch } : r)));
  return (
    <div class="ed-rows">
      {rows.map((r, k) => (
        <div class="ed-row">
          <Draft text={r.key} placeholder="default" onCommit={(t) => edit(k, { key: t.trim() })} />
          <Draft text={r.zh} placeholder="王国" onCommit={(t) => edit(k, { zh: t })} />
          {orig && <Draft text={r.orig} placeholder="Kingdom of {name}" onCommit={(t) => edit(k, { orig: t })} />}
          <button class="small icon ghost" title="删除" onClick={() => put(rows.filter((_, j) => j !== k))}>
            <X />
          </button>
        </div>
      ))}
      <p class="hint">键写 default、文化或文化组的 id</p>
      <button class="small" onClick={() => setRows([...rows, { key: rows.length ? '' : 'default', zh: '', orig: '' }])}>
        <Plus /> 添加
      </button>
    </div>
  );
}

// 带权重的一组：一行一项（字、权重，权重空着是 1）
function WeightedEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const rows = weightedRows(value);
  const put = (k: number, patch: Partial<(typeof rows)[number]>) => onChange(weightedValue(rows.map((r, j) => (j === k ? { ...r, ...patch } : r))));
  return (
    <div class="ed-rows">
      {rows.map((r, k) => (
        <div class="ed-row">
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
      ))}
      <button class="small" onClick={() => onChange(weightedValue([...rows, { text: '' }]))}>
        <Plus /> 添加
      </button>
    </div>
  );
}

// 键 → 值：键在框里改（离开框时换上，已有的键不换），值按 value（或 of 的一组字段）
function MapEditor({ f, value, onChange, path, issues }: { f: FieldDesc; value: unknown; onChange: (v: unknown) => void; path: Path; issues: readonly EditorIssue[] }) {
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
