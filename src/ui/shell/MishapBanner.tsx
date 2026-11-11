import { X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { closeMishap, mishap, toggleMishapReason } from '../../state';
import { MISHAP_TEXT as T } from '../copy';

// 不致命的错（第九十六轮）：顶上的一条。说一句人话（刚才那一步可能没做成 / 哪一块已经关闭，世界还在），不打断；
// “原因”展开是原话，能选中、能复制（问别人时用）；× 关闭。不展开时过一阵自己消失（state/mishap.ts）
export function MishapBanner() {
  const m = mishap.value;
  const [copied, setCopied] = useState(false);
  if (!m) return null;
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    try {
      void navigator.clipboard.writeText(m.detail).then(done, () => {});
    } catch {
      // 没有剪贴板：那一段能选中，自己复制
    }
  };
  return (
    <div class="notice banner mishap" data-mishap={m.id}>
      <div class="mishap-head">
        <span class="notice-text">{m.text}</span>
        <button class={`pill-btn ${m.open ? 'open' : ''}`} onClick={toggleMishapReason} title={T.reasonTip} aria-expanded={m.open}>
          {T.reason}
        </button>
        <button class="pill-btn icon" onClick={closeMishap} title="关闭" aria-label="关闭">
          <X />
        </button>
      </div>
      {m.open && (
        <div class="mishap-reason">
          <pre>{m.detail}</pre>
          <div class="mishap-foot">
            {m.count > 1 && <span class="hint">{T.times(m.count)}</span>}
            <button class="pill-btn" onClick={copy}>
              {copied ? T.copied : T.copy}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
