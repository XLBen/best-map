import { ChevronRight } from 'lucide-preact';
import { type ComponentChildren, createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { type EditorIssue, issuesAt } from './fields';
import { moreBrief } from './more-settings';

// 内容编辑器（ContentEditor.tsx）和各种编辑器（editors.tsx）共用的几样（第六十九轮分出来，两边不再互相引用）

// 字段在一项里的位置
export type Path = PropertyKey[];

// 出错的说明（这一处的，不含下面一层的）
export function Errors({ issues, path }: { issues: readonly EditorIssue[]; path: Path }) {
  const here = issuesAt(issues, path).filter((i) => i.path.length === path.length);
  return here.length ? <p class="warn small">{here.map((i) => i.message).join('；')}</p> : null;
}

// 框里写完、离开框（或回车）才换上
// onDraft（第九十一轮）：每打一个字告诉外面（称号旁边的示例跟着正在写的字变）；离开框时给 null
export function Draft({ text, onCommit, multi, mono, placeholder, onDraft }: { text: string; onCommit: (t: string) => void; multi?: boolean; mono?: boolean; placeholder?: string; onDraft?: (t: string | null) => void }) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = () => {
    onDraft?.(null);
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
      onInput={(e) => {
        const t = (e.target as HTMLInputElement).value;
        setDraft(t);
        onDraft?.(t);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ---------- 常用 / 更多设置（第九十三轮，规则在 more-settings.ts） ----------

// 哪几处“更多设置”展开着：一项的页面给（记在 panel-store.ts 的 openSegments 里）；没给时每一处自己记
export interface MoreState {
  isOpen(key: string): boolean;
  toggle(key: string): void;
}
export const MoreCtx = createContext<MoreState | null>(null);

// 折叠着的“更多设置”：收着时旁边写里面是什么。用 div 不用 button：只读的库整个表单是 disabled 的，照样要能点开看。
// open：里面有要改的错时直接展开着
export function MoreBox({ id, labels, open: forced, children }: { id: string; labels: readonly string[]; open?: boolean; children: ComponentChildren }) {
  const st = useContext(MoreCtx);
  const [own, setOwn] = useState(false);
  const open = forced || (st ? st.isOpen(id) : own);
  const toggle = () => (st ? st.toggle(id) : setOwn(!own));
  return (
    <div class={`ed-more ${open ? 'open' : ''}`}>
      <div class="ed-more-head" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => e.key === 'Enter' && toggle()}>
        <ChevronRight class="lp-seg-twist" />
        <span>更多设置</span>
        {!open && <span class="hint ellipsis">{moreBrief(labels)}</span>}
      </div>
      {open && <div class="ed-more-body">{children}</div>}
    </div>
  );
}
