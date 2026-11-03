import type { LibraryEntry } from '../../library';
import { type LibraryOption, libraryOptions, packLabel } from '../packChoice';

// 选一个库（第五十二轮）：新建向导里是一排卡片；弹出面板里窄，是下拉。内置的在前，我的库另成一段。
// 最后的面板在第五十九轮

const firstSentence = (s: string | undefined) => (s ? s.split('。')[0] : '');

export function LibraryPick({
  value,
  onChange,
  lib,
  newWorld,
  compact,
  disabled,
}: {
  value: string | null;
  onChange: (key: string) => void;
  lib: readonly LibraryEntry[];
  newWorld?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  const options = libraryOptions(lib, newWorld);
  // 世界用的库已经不在资源库里（删掉了）：也列着
  const gone = value && !options.some((o) => o.key === value) ? [{ key: value, name: packLabel(lib, [value]), builtin: false }] : [];
  const builtin = options.filter((o) => o.builtin);
  const mine = [...options.filter((o) => !o.builtin), ...gone];
  if (compact) {
    return (
      <select class="library-pick" value={value ?? ''} disabled={disabled} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <optgroup label="内置的库">
          {builtin.map((o) => (
            <option value={o.key}>{o.name}</option>
          ))}
        </optgroup>
        {mine.length > 0 && (
          <optgroup label="我的库">
            {mine.map((o) => (
              <option value={o.key}>{o.name}</option>
            ))}
          </optgroup>
        )}
      </select>
    );
  }
  const card = (o: LibraryOption) => (
    <button class={`card ${value === o.key ? 'on' : ''}`} onClick={() => onChange(o.key)} disabled={disabled} title={o.description}>
      <b>{o.name}</b>
      {o.description && <span class="hint">{firstSentence(o.description)}</span>}
    </button>
  );
  return (
    <>
      <div class="cards three">{builtin.map(card)}</div>
      {mine.length > 0 && (
        <>
          <h6 class="choice-group">我的库</h6>
          <div class="cards three">{mine.map(card)}</div>
        </>
      )}
    </>
  );
}
