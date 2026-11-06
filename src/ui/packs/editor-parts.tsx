import { useEffect, useState } from 'preact/hooks';
import { type EditorIssue, issuesAt } from './fields';

// 内容编辑器（ContentEditor.tsx）和各种编辑器（editors.tsx）共用的几样（第六十九轮分出来，两边不再互相引用）

// 字段在一项里的位置
export type Path = PropertyKey[];

// 出错的说明（这一处的，不含下面一层的）
export function Errors({ issues, path }: { issues: readonly EditorIssue[]; path: Path }) {
  const here = issuesAt(issues, path).filter((i) => i.path.length === path.length);
  return here.length ? <p class="warn small">{here.map((i) => i.message).join('；')}</p> : null;
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
