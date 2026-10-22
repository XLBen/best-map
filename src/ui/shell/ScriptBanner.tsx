import { X } from 'lucide-preact';
import type { ScriptIssue } from '../../../core/script';
import { canEditScript, dismissedIssues, editScript, flashCells, retryScripts, safeMode, showScripts, world } from '../../state';
import { focusOn } from '../camera';

// 顶部的横幅（不挡操作，提示条上面）：
// - 安全模式：这个世界里的脚本没有运行（原因），可以“再试一次”（另开一个 Worker，脚本照常运行）、“查看脚本”；
// - 脚本出错：出错的脚本这一次按没有脚本处理，说明第几行，“地图上有一处…（点这里去看）”把镜头移过去，“编辑”打开它

// 一句话：「X」的脚本出错了，暂时按没有脚本处理（第 3 行：…）
export function issueText(issue: ScriptIssue): string {
  return `「${issue.owner}」的脚本出错了，暂时按没有脚本处理（${issue.line ? `第 ${issue.line} 行：` : ''}${issue.text}）`;
}

// 一组问题的键：关掉后同一组不再出现
export const issuesKey = (issues: readonly ScriptIssue[]) => issues.map((i) => i.message).join('\n');

export function ScriptBanner() {
  const w = world.value;
  const safe = safeMode.value;
  if (!w) return null;
  if (safe) {
    return (
      <div class="notice banner">
        <span class="notice-text" title={`安全模式：这个世界里的脚本没有运行（${safe.reason}）。`}>
          安全模式：这个世界里的脚本没有运行（{safe.reason}）。
        </span>
        <button class="pill-btn" onClick={() => void retryScripts()} title="重新打开这个世界，让脚本照常运行">
          再试一次
        </button>
        <button class="pill-btn" onClick={() => void showScripts()}>
          查看脚本
        </button>
      </div>
    );
  }
  const issues = w.derived.scriptIssues;
  if (!issues?.length) return null;
  const key = issuesKey(issues);
  if (dismissedIssues.value === key) return null;
  const first = issues[0];
  const cell = first.cell;
  const more = issues.length > 1 ? `，还有 ${issues.length - 1} 处` : '';
  return (
    <div class="notice banner">
      <span class="notice-text" title={issues.map((i) => i.message).join('\n')}>
        {issueText(first)}
        {more}
      </span>
      {cell !== undefined && cell >= 0 && cell < w.mesh.n && (
        <button
          class="link-btn"
          onClick={() => {
            // 镜头移过去，这一格连同周围一圈亮一下
            const around = [cell];
            for (let e = w.mesh.off[cell]; e < w.mesh.off[cell + 1]; e++) around.push(w.mesh.adj[e]);
            focusOn([cell]);
            flashCells(around);
          }}
        >
          地图上有一处出错（点这里去看）
        </button>
      )}
      {canEditScript(first) && (
        <button class="pill-btn" onClick={() => editScript(first)}>
          编辑
        </button>
      )}
      <button class="pill-btn icon" onClick={() => (dismissedIssues.value = key)} title="关上">
        <X size={14} />
      </button>
    </div>
  );
}
