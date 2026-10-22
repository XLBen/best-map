import { useEffect } from 'preact/hooks';
import { SCRIPT_KIND_LABEL } from '../../../core/script';
import { ask } from '../../state';

// 问一句的对话框：信任这个世界里的脚本吗、用安全模式打开吗、查看脚本。列出的脚本写明是谁的、哪一种，源码用等宽字。
// 点空白处、按 Esc 等于取消；主要的按钮在最右边

export function AskDialog() {
  const a = ask.value;
  useEffect(() => {
    if (!a) return;
    // 对话框开着时地图的快捷键（撤销、换工具……）都不起作用
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') a.resolve('cancel');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [a]);
  if (!a) return null;
  return (
    <div class="modal-backdrop" onClick={() => a.resolve('cancel')}>
      <div class="modal ask" onClick={(e) => e.stopPropagation()}>
        <h3>{a.title}</h3>
        {a.text && <p class="muted">{a.text}</p>}
        {a.scripts && a.scripts.length > 0 && (
          <div class="ask-scripts">
            {a.scripts.map((s) => (
              <div key={s.path}>
                <b>{s.owner}</b>
                <span class="muted small"> · {SCRIPT_KIND_LABEL[s.kind]}的脚本</span>
                <pre>{s.src}</pre>
              </div>
            ))}
          </div>
        )}
        <div class="ask-actions">
          {[...a.choices].reverse().map((c) => (
            <button key={c.value} class={c.primary ? 'primary' : ''} onClick={() => a.resolve(c.value)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
