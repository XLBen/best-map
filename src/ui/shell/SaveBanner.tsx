import { X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { fileStatus, saveProblem } from '../../state';
import { FILE_TEXT as F, SAVE_TEXT as T } from '../copy';
import { exportCurrent } from '../maps/store';
import { reloadSaved, resumeFileHere, takeOverHere } from './save-note';

// 这个世界已在另一个页面打开（第九十四轮）：这个页面不写自动保存，顶上一直有这一条，直到点“在这里接着做”或者那个页面关了。
// 第九十五轮：那一页关了、而它存下的比这个页面里的新——换一种说法（这个页面里的是旧的），主要的按钮是“重新载入”。
// 没存成的别的原因（存储满了……）不在这里：顶上说一次，之后看顶栏“世界”旁的记号
export function SaveBanner() {
  const p = saveProblem.value;
  if (p !== 'other-page' && p !== 'stale-page') return null;
  return (
    <div class="notice banner">
      <span class="notice-text">{p === 'stale-page' ? T.stalePage : T.otherPage}</span>
      {p === 'stale-page' && (
        <button class="pill-btn primary" onClick={() => void reloadSaved()} title={T.reloadTip}>
          {T.reload}
        </button>
      )}
      <button class="pill-btn" onClick={() => void takeOverHere()} title={T.takeOverTip}>
        {T.takeOver}
      </button>
      <button class="pill-btn" onClick={() => void exportCurrent()} title={T.exportTip}>
        {T.export}
      </button>
    </div>
  );
}

// 第九十五轮：这张地图也存在电脑上的一个文件里，但这次打开页面浏览器还没重新给写的权限——没在写。
// 一直有这一条，点“接着存到 xxx.json”才写；× 关掉这一条（“世界”菜单里照样写着“没在写文件”）
export function FileBanner() {
  const s = fileStatus.value;
  const [closed, setClosed] = useState<string | null>(null);
  if (s.mode !== 'paused' || !s.name || closed === s.name) return null;
  return (
    <div class="notice banner">
      <span class="notice-text">{F.pausedBanner(s.name)}</span>
      <button class="pill-btn primary" onClick={() => void resumeFileHere()} title={F.resumeTip}>
        {F.resume(s.name)}
      </button>
      <button class="pill-btn icon" onClick={() => setClosed(s.name)} title="关闭" aria-label="关闭">
        <X />
      </button>
    </div>
  );
}
