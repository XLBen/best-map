import { X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { skippedNote, world } from '../../state';
import { openRepo } from '../packs/store';
import { skippedSummary } from '../skipped';

// 缺了内容跳过的步骤（第三十轮）：提示条上面的一条横幅，说一次。几条时点“详情”在下面列出来；
// “从资源库添加…”打开资源库（缺的只有一种时筛成那一种，只列不在本世界的）
export function SkippedBanner() {
  const n = skippedNote.value;
  const [open, setOpen] = useState<number | null>(null);
  if (!n || !world.value) return null;
  const { head, kind } = skippedSummary(n.notes);
  const shown = open === n.id;
  return (
    <div class="notice banner skipped-note">
      <div class="skipped-head">
        <span class="notice-text" title={n.notes.join('\n')}>
          {head}
        </span>
        {n.notes.length > 1 && (
          <button class="link-btn" onClick={() => setOpen(shown ? null : n.id)}>
            {shown ? '收起' : '详情'}
          </button>
        )}
        <button
          class="pill-btn"
          onClick={() => {
            skippedNote.value = null;
            openRepo({ kind, filter: 'off', edit: undefined });
          }}
        >
          从资源库添加…
        </button>
        <button class="pill-btn icon" onClick={() => (skippedNote.value = null)} title="关闭">
          <X />
        </button>
      </div>
      {shown && (
        <ul class="skipped-list">
          {n.notes.map((x) => (
            <li>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
