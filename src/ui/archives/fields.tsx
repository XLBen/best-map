import type { ComponentChildren } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { CountryMeta } from '../../../core/world';
import { shareText } from '../domain/human';

// 国家档案的几样小部件（第七十轮从 CountryArchive.tsx 分出来）：一行、离开框才提交的字、占比的一行、名字和原文；城市、集团的档案也用

// 下拉框里的一串国家（第八十轮）：按编号作 key，国家的列表逐个是同一批对象时不重画
const CountryOptions = memo(
  function CountryOptions({ list }: { list: readonly CountryMeta[] }) {
    return (
      <>
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </>
    );
  },
  (a, b) => a.list === b.list || (a.list.length === b.list.length && a.list.every((x, i) => x === b.list[i])),
);

// 选一国的下拉框（第八十轮）：几百上千个国家的选项只在要选时（按下、得到焦点、按键）才放进去，平时只有第一项与选着的那一国。
// 以前每个下拉框总是带着全部的国家，档案换一国时（列表少一个、多一个）按下标比，后面的选项一个个改字、整个下拉框重新排版。
// owner：档案是哪一国的（换了一国就又只放两项）
export function CountrySelect(p: { owner: number; list: readonly CountryMeta[]; value: number | ''; first: string; class?: string; title?: string; onChange: (e: Event) => void }) {
  const [openFor, setOpenFor] = useState<number | null>(null);
  const open = openFor === p.owner;
  const cur = p.value === '' ? undefined : p.list.find((x) => x.id === p.value);
  const wake = () => {
    if (!open) setOpenFor(p.owner);
  };
  return (
    <select class={p.class} value={String(p.value)} title={p.title} onChange={p.onChange} onMouseDown={wake} onFocus={wake} onKeyDown={wake} onTouchStart={wake}>
      <option value="">{p.first}</option>
      {open ? (
        <CountryOptions list={p.list} />
      ) : (
        cur && (
          <option key={cur.id} value={cur.id}>
            {cur.name}
          </option>
        )
      )}
    </select>
  );
}

export function Line({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="arch-line">
      <span class="arch-label">{label}</span>
      {children}
    </div>
  );
}

// 一个字的框：离开框、回车时提交；Esc 回到原来的
export function TextField({ value, onCommit, placeholder, maxLength = 40, class: cls = 'grow', title }: { value: string; onCommit: (v: string) => void; placeholder?: string; maxLength?: number; class?: string; title?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      class={cls}
      value={v}
      maxLength={maxLength}
      placeholder={placeholder}
      title={title}
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setV(value);
        }
      }}
      onBlur={() => {
        if (v !== value) onCommit(v);
      }}
    />
  );
}

// 占比的一行（同格的档案里人口的样子）
export function ShareRow({ color, label, share, title, children }: { color: string; label: string; share: number; title?: string; children?: ComponentChildren }) {
  return (
    <div class="share-row" title={title}>
      <span class="swatch" style={{ background: color }} />
      <span class="share-name">{label}</span>
      <span class="share-bar">
        <span style={{ width: `${Math.round(share * 100)}%`, background: color }} />
      </span>
      {children ?? <span class="hint">{shareText(share)}</span>}
    </div>
  );
}


// 名字与原文一起改（第二十七轮）：两个框是一组，焦点离开这一组（或回车）时一起提交，先改名字再改原文也不会丢；Esc 两个都回到原来的
export function NamePair({ name, orig, onCommit, placeholder = '空着恢复自动' }: { name: string; orig: string; onCommit: (name: string, orig: string) => void; placeholder?: string }) {
  const [n, setN] = useState(name);
  const [o, setO] = useState(orig);
  useEffect(() => setN(name), [name]);
  useEffect(() => setO(orig), [orig]);
  const commit = () => {
    if (n !== name || o !== orig) onCommit(n, o);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      commit();
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      setN(name);
      setO(orig);
    }
  };
  return (
    <div
      class="name-pair"
      onFocusOut={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !(e.currentTarget as HTMLElement).contains(to)) commit();
      }}
    >
      <Line label="名字">
        <input class="grow" value={n} maxLength={40} placeholder={placeholder} onInput={(e) => setN((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
      </Line>
      <Line label="原文">
        <input class="grow" value={o} maxLength={80} placeholder="原文" onInput={(e) => setO((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
      </Line>
    </div>
  );
}
