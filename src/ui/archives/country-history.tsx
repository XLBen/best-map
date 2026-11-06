import { useEffect, useRef, useState } from 'preact/hooks';
import type { CountryMeta } from '../../../core/world';
import { Toggle } from '../components/Toggle';
import { historyPatch } from '../domain/countries';
import { patch } from '../country-archive';
import { Line } from './fields';

// 国家档案的“历史”一页（第七十轮从 CountryArchive.tsx 按页分出来）

// 年份（第二十七轮）：数字框加“公元前”开关，离开框、回车时提交
export function YearField({ value, onCommit }: { value: number; onCommit: (year: number) => void }) {
  const [v, setV] = useState(String(Math.abs(value)));
  useEffect(() => setV(String(Math.abs(value))), [value]);
  const bc = value < 0;
  const commit = (text: string, before: boolean) => {
    const n = Math.round(Number(text));
    if (!text.trim() || !Number.isFinite(n) || n < 0 || n > 100000) {
      setV(String(Math.abs(value)));
      return;
    }
    onCommit(before ? -n : n);
  };
  return (
    <span class="year-field grow">
      <input
        type="number"
        min={0}
        max={100000}
        value={v}
        onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setV(String(Math.abs(value)));
          }
        }}
        onBlur={() => v !== String(Math.abs(value)) && commit(v, bc)}
      />
      <span class="hint">年</span>
      <Toggle on={bc} onChange={(on) => commit(v, on)}>
        公元前
      </Toggle>
    </span>
  );
}

// 历史：打字停下一秒、离开框时提交（快照：生成时写下，改名不跟着变）
export function HistorySection({ m }: { m: CountryMeta }) {
  const [text, setText] = useState(m.history);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ id: m.id, text, base: m });
  latest.current = { id: m.id, text, base: m };
  useEffect(() => setText(m.history), [m.id, m.history]);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const l = latest.current;
    void patch(l.id, historyPatch(l.base, l.text));
  };
  // 换了国家、关上抽屉之前没提交的写进原来那一国
  useEffect(() => () => (timer.current ? flush() : undefined), [m.id]);
  return (
    <section>
      <h5>建国与历史</h5>
      <Line label="建国">
        <YearField value={m.founded} onCommit={(y) => void patch(m.id, y === m.founded ? null : { founded: y })} />
      </Line>
      <textarea
        class="arch-note-input"
        rows={5}
        maxLength={4000}
        value={text}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, 1000);
        }}
        onBlur={flush}
      />
    </section>
  );
}
