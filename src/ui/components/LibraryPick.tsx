import type { LibraryOption } from '../domain/packChoice';

// 选一个库（第五十二轮）：新建向导里是一排卡片；弹出面板里窄，是下拉。内置的在前，我的库另成一段。
// 最后的面板在第五十九轮。第六十九轮：能选的库（domain/packChoice.ts 的 libraryOptions）、库的名字由用的地方给

const firstSentence = (s: string | undefined) => (s ? s.split('。')[0] : '');

export function LibraryPick({
  value,
  onChange,
  options,
  labelOf,
  compact,
  disabled,
}: {
  value: string | null;
  onChange: (key: string) => void;
  // 能选的库（内置的在前）
  options: readonly LibraryOption[];
  // 不在 options 里的库（世界用的库删掉了）写什么
  labelOf: (key: string) => string;
  compact?: boolean;
  disabled?: boolean;
}) {
  // 世界用的库已经不在资源库里（删掉了）：也列着
  const gone = value && !options.some((o) => o.key === value) ? [{ key: value, name: labelOf(value), builtin: false }] : [];
  const builtin = options.filter((o) => o.builtin);
  const mine = [...options.filter((o) => !o.builtin), ...gone];
  if (compact) {
    return (
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
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
