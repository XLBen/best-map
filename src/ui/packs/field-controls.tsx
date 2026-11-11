import { Plus, X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { FieldDesc } from '../../../core/content/registry';
import { ISLAND_LOOK_INFO } from '../../../core/island-types';
import { Seg } from '../common';
import { Flag } from '../panels/countries';
import { type Obj, keyProblem } from './fields';
import { type FlagPart, flagChoices, toggleFlagWord, unknownFlagWords } from './previews';
import { RefPicker, useRefOptions } from './RefPicker';

// 通用编辑器里几样“从现成的里面选”的控件（第九十三轮：以前要手打英文的记号）：
// 旗的纹章与样式（带小图）、岛的颜色（和周围一样 / 白沙 / 沙洲 / 自选）、键 → 值的表里新加一项（先写名字，或从列表里选）

// ---------- 旗的纹章、样式 ----------

// 一格一个：小图、中文名，点一下选上，再点一下去掉。写了表里没有的（以前手打错的）照旧列在后面，能点掉
export function FlagPick({ part, value, onChange }: { part: FlagPart; value: unknown; onChange: (v: unknown) => void }) {
  const on = new Set(Array.isArray(value) ? value.map(String) : []);
  const unknown = unknownFlagWords(part, value);
  return (
    <div class="lp-flag-pick">
      {flagChoices(part).map((c) => (
        <button key={c.id} class={`lp-flag-choice ${on.has(c.id) ? 'on' : ''}`} aria-pressed={on.has(c.id)} onClick={() => onChange(toggleFlagWord(part, value, c.id))}>
          <Flag m={{ flag: c.flag }} w={36} h={24} />
          <span class="ellipsis">{c.label}</span>
        </button>
      ))}
      {unknown.map((id) => (
        <button key={id} class="lp-flag-choice on unknown" title="不认识，不起作用；点一下去掉" onClick={() => onChange(toggleFlagWord(part, value, id))}>
          <X />
          <span class="ellipsis">{id}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- 岛的颜色 ----------

type IslandColorChoice = 'same' | 'coral' | 'marsh' | 'own';
const OWN_DEFAULT = '#3d3a38';
const choiceOf = (v: unknown): IslandColorChoice => (typeof v !== 'string' || !v ? 'same' : v === 'coral' || v === 'marsh' ? v : 'own');

// 和周围一样（不写）、两种现成的样子、自己选的颜色
export function IslandColor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const cc = choiceOf(value);
  return (
    <span class="row wrap">
      <Seg<IslandColorChoice>
        value={cc}
        options={[
          ['same', '和周围一样'],
          ['coral', ISLAND_LOOK_INFO.coral.name],
          ['marsh', ISLAND_LOOK_INFO.marsh.name],
          ['own', '自选'],
        ]}
        titles={{ coral: ISLAND_LOOK_INFO.coral.hint, marsh: ISLAND_LOOK_INFO.marsh.hint }}
        onChange={(v) => onChange(v === 'same' ? undefined : v === 'own' ? (cc === 'own' ? value : OWN_DEFAULT) : v)}
      />
      {cc === 'own' && <input type="color" value={String(value)} title="岛的颜色" onChange={(e) => onChange((e.target as HTMLInputElement).value)} />}
    </span>
  );
}

// ---------- 键 → 值的表里新加一项 ----------

// 键从现成的表里选的（各类地物，字段表的 keyPick）、从内容里选的（keyRef）：从列表里选一个还没有的；
// 别的：先写名字（词表的名字、汉字……），回车或点“添加”
export function MapAdd({ f, obj, onAdd }: { f: FieldDesc; obj: Obj; onAdd: (key: string) => void }) {
  const from = f.keyPick ?? f.keyRef;
  return from ? <MapAddPick keyRef={from} obj={obj} onAdd={onAdd} /> : <MapAddName label={f.keyLabel ?? '名字'} obj={obj} onAdd={onAdd} />;
}

function MapAddPick({ keyRef, obj, onAdd }: { keyRef: string | readonly string[]; obj: Obj; onAdd: (key: string) => void }) {
  const opts = useRefOptions(keyRef);
  return <RefPicker add options={opts} exclude={new Set(Object.keys(obj))} onPick={onAdd} />;
}

function MapAddName({ label, obj, onAdd }: { label: string; obj: Obj; onAdd: (key: string) => void }) {
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const problem = keyProblem(obj, text);
  const add = () => {
    if (problem) return setTried(true);
    onAdd(text.trim());
    setText('');
    setTried(false);
  };
  return (
    <div class="ed-map-add">
      <div class="row">
        <input
          type="text"
          class="grow"
          value={text}
          placeholder={label}
          aria-label={label}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add();
          }}
        />
        <button class="small" onClick={add}>
          <Plus /> 添加
        </button>
      </div>
      {tried && problem && <p class="warn small">{problem}</p>}
    </div>
  );
}
