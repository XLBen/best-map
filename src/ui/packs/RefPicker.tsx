import { ChevronDown, Plus } from 'lucide-preact';
import { type ComponentChildren, createContext } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { library } from '../../library';
import { world } from '../../state';
import { showAllSettings } from './lib-prefs';
import { type RefOption, newRefName, refLabel, refOptionsOf, searchRefs } from './refs';

// 带搜索的下拉（第四十五轮）：编辑器里选文化组、地名风格、维度、取值、政体、国家等级……。
// 点开后先列全部（多了只列前面的），输入几个字筛；方向键挑、回车选、Esc 关。
// 第九十三轮：平时每一行只写名字（不带英文的 id），也不能照写一个列表里没有的 id——那是“更多设置都摊开”（lib-prefs.ts 的 showAllSettings）时才有的。
// 能新加一个的（政体的类别，newFor）：搜索框里写名字，最下面一行“新加‘X’”
// 弹框不超出外面滚动的那一层（第六十八轮）

// 引用点过去（第五十九轮）：资源库面板给这个函数：这个引用点了做什么（这一份里没有它时 null）。别处不给，引用就不能点
export const RefGo = createContext<((ref: string | readonly string[], id: string) => (() => void) | null) | null>(null);

// 编辑器里共用：本世界与资源库里的选项（世界、资源库换了才重算）
export function useRefOptions(ref: string | readonly string[], opts?: { dimension?: string; extra?: readonly RefOption[] }): RefOption[] {
  const w = world.value;
  const lib = library.value;
  const key = typeof ref === 'string' ? ref : ref.join('|');
  return useMemo(() => {
    let list = refOptionsOf(ref, { world: w, lib });
    if (opts?.dimension) list = list.filter((o) => !o.dimension || o.dimension === opts.dimension);
    return opts?.extra?.length ? [...opts.extra, ...list] : list;
  }, [key, w, lib, opts?.dimension, opts?.extra]);
}

interface Props {
  options: readonly RefOption[];
  // 现在选的（单选时按钮上写它的名字）；add 时按钮写“添加”
  value?: string;
  add?: boolean;
  onPick: (id: string) => void;
  // 能不写：列表最后多一行“（不写）”
  onClear?: () => void;
  // 已经选了的（加一项时不再列）
  exclude?: ReadonlySet<string>;
  placeholder?: string;
  title?: string;
  children?: ComponentChildren;
  // 能新加一个的引用（refs.ts 的 refNewMax 认的那几种）：写名字就能加
  newFor?: string;
}

export function RefPicker({ options, value, add, onPick, onClear, exclude, placeholder, title, children, newFor }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, [open]);
  // 弹框不超出外面滚动的那一层（第六十八轮：面板边上的按钮弹出来比面板宽，面板出横向滚动条）：右边放不下时靠右对齐，最宽不超过它
  const pop = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ end: boolean; max: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setFit(null);
      return;
    }
    const el = pop.current;
    if (!el) return;
    let up = el.parentElement?.parentElement ?? null;
    while (up && up !== document.body && getComputedStyle(up).overflowY === 'visible' && getComputedStyle(up).overflowX === 'visible') up = up.parentElement;
    const bound = (up && up !== document.body ? up : document.documentElement).getBoundingClientRect();
    const btn = box.current!.getBoundingClientRect();
    const max = Math.max(160, bound.width - 16);
    const w = Math.min(el.offsetWidth, max);
    setFit({ end: btn.left + w > bound.right - 8 && btn.right - w >= bound.left, max });
  }, [open]);
  const pool = useMemo(() => (exclude?.size ? options.filter((o) => !exclude.has(o.id)) : options), [options, exclude]);
  const { list, more } = useMemo(() => searchRefs(pool, q), [pool, q]);
  const free = q.trim();
  const full = showAllSettings();
  const fresh = newFor ? newRefName(newFor, q, options) : null;
  // 照写一个列表里没有的 id：只在都摊开时
  const canFree = full && !fresh && !!free && /^[\w-]+$/.test(free) && !options.some((o) => o.id === free);
  const pick = (id: string) => {
    setOpen(false);
    setQ('');
    setHi(0);
    onPick(id);
  };
  const shown = value ? refLabel(options, value) : '';
  return (
    <span class="ref-pick" ref={box}>
      <button
        class={`ref-btn ${add ? 'small' : ''} ${open ? 'open' : ''}`}
        title={title ?? (full && value && shown !== value ? value : undefined)}
        onClick={() => {
          setOpen(!open);
          setHi(0);
        }}
      >
        {add ? (
          <>
            <Plus /> {children ?? '添加'}
          </>
        ) : (
          <>
            <span class={`grow ref-value ${value ? '' : 'hint'}`}>{value ? shown : (placeholder ?? '（不写）')}</span>
            <ChevronDown />
          </>
        )}
      </button>
      {open && (
        <div ref={pop} class={`ref-pop ${fit?.end ? 'end' : ''}`} style={fit ? { maxWidth: `${fit.max}px` } : undefined} role="listbox">
          <input
            ref={input}
            type="search"
            placeholder={newFor ? '搜索，或写一个新的名字' : '搜索'}
            value={q}
            onInput={(e) => {
              setQ((e.target as HTMLInputElement).value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHi(Math.min(hi + 1, list.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi(Math.max(hi - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (list[hi]) pick(list[hi].id);
                else if (fresh) pick(fresh);
                else if (canFree) pick(free);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div class="ref-list">
            {list.map((o, k) => (
              <button class={`item ${k === hi ? 'hi' : ''} ${o.id === value ? 'on' : ''}`} onClick={() => pick(o.id)} onPointerEnter={() => setHi(k)}>
                {o.color && <span class="swatch" style={{ background: o.color }} />}
                <span class="grow item-text">
                  {o.label}
                  {(o.hint || full) && <span class="hint">{full ? (o.hint ? `${o.hint} · ${o.id}` : o.id) : o.hint}</span>}
                </span>
              </button>
            ))}
            {!list.length && !canFree && !fresh && <p class="hint">没有对上的</p>}
            {more > 0 && <p class="hint">还有 {more} 个，再输入几个字</p>}
            {fresh && (
              <button class="item" onClick={() => pick(fresh)}>
                <Plus />
                <span class="grow item-text">新加“{fresh}”</span>
              </button>
            )}
            {canFree && (
              <button class="item" onClick={() => pick(free)}>
                <span class="grow item-text">用“{free}”</span>
              </button>
            )}
            {onClear && value && (
              <button
                class="item"
                onClick={() => {
                  setOpen(false);
                  onClear();
                }}
              >
                <span class="grow item-text hint">（不写）</span>
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
