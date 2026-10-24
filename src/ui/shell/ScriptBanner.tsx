import { X } from 'lucide-preact';
import type { ScriptIssue } from '../../../core/script';
import { canEditScript, dismissedIssues, editScript, retryScripts, safeMode, showScripts, world } from '../../state';
import { showCell } from '../editor-hooks';

// 顶部的横幅（不挡操作，提示条上面）：
// - 安全模式：这个世界里的脚本没有运行（原因），可以“再试一次”（另开一个 Worker，脚本照常运行）、“查看脚本”；
// - 脚本出错（星球形态的布局与地形脚本、河流类型的规则、生态的脚本，按这个先后都在 d.scriptIssues 里）：出错的脚本这一次
//   按没有脚本处理，说明第几行，“地图上有一处…（点这里去看）”把镜头移过去，“编辑”打开生态抽屉里的那个脚本框、
//   “水系 ⋯”里那种河（星球形态的脚本没有）

// 一句话：「X」的脚本出错了，暂时按没有脚本处理（第 3 行：…）
function issueText(issue: ScriptIssue): string {
  return `「${issue.owner}」的脚本出错了，暂时按没有脚本处理（${issue.line ? `第 ${issue.line} 行：` : ''}${issue.text}）`;
}

// 一组问题的键：关掉后同一组不再出现
const issuesKey = (issues: readonly ScriptIssue[]) => issues.map((i) => i.message).join('\n');

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
        // 镜头移过去，这一格连同周围一圈亮一下
        <button class="link-btn" onClick={() => showCell(cell)}>
          地图上有一处出错（点这里去看）
        </button>
      )}
      {canEditScript(first) && (
        <button class="pill-btn" onClick={() => editScript(first)}>
          编辑
        </button>
      )}
      <button class="pill-btn icon" onClick={() => (dismissedIssues.value = key)} title="关上">
        <X />
      </button>
    </div>
  );
}
