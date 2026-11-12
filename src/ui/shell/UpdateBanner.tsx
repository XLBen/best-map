import { X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { offlineReady, reloadForUpdate, updateReady } from '../../state';
import { OFFLINE_TEXT as T } from '../copy';

// 离线（第一百零一轮）：新版本在后台装好了，等着——不在用的时候换掉程序，点“重新载入”才用上。
// 顶上一条，能关；关了以后“更多”最下面还有一行

export function UpdateBanner() {
  const [closed, setClosed] = useState(false);
  if (!updateReady.value || closed) return null;
  return (
    <div class="notice banner update-note">
      <span class="notice-text">{T.update}</span>
      <button class="pill-btn primary" onClick={() => void reloadForUpdate()} title={T.reloadTip}>
        {T.reload}
      </button>
      <button class="pill-btn icon" onClick={() => setClosed(true)} title="关闭" aria-label="关闭">
        <X />
      </button>
    </div>
  );
}

// “更多”最下面的一行：有新版本时是那一句和“重新载入”；没有、已经能离线用时一行灰字；都不是时没有这一行
export function OfflineLine() {
  if (updateReady.value) {
    return (
      <p class="hint offline-line">
        {T.update}{' '}
        <button class="link-btn" onClick={() => void reloadForUpdate()} title={T.reloadTip}>
          {T.reload}
        </button>
      </p>
    );
  }
  if (!offlineReady.value) return null;
  return <p class="hint offline-line">{T.ready}</p>;
}
