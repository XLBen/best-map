import { useEffect, useRef } from 'preact/hooks';
import { SCRIPT_KIND_LABEL } from '../../../core/script';
import { ask } from '../../state';
import { isolationNote } from '../packs/Scripts';

// 问一句的对话框：信任这个世界里的脚本吗、用安全模式打开吗、查看脚本、先保存吗、起个名字（带输入框，回车 = 主要的按钮）。列出的脚本写明是谁的、哪一种，源码用等宽字。
// 问要不要信任时（有“信任并…”）与资源包的信任问话一样，老实写脚本在不在隔离的环境里跑。
// 点空白处、按 Esc 等于取消；主要的按钮在最右边

export function AskDialog() {
  const a = ask.value;
  const input = useRef<HTMLInputElement>(null);
  const primary = a?.choices.find((c) => c.primary)?.value;
  useEffect(() => {
    if (!a) return;
    // 对话框开着时地图的快捷键（撤销、换工具……）都不起作用；⌘S 也不弹出浏览器的“存储网页”
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') a.resolve('cancel');
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') e.preventDefault();
      else if (e.key === 'Enter' && a.input !== undefined && primary && !e.isComposing) {
        e.preventDefault();
        a.resolve(primary, input.current?.value ?? a.input);
      }
    };
    window.addEventListener('keydown', onKey, true);
    if (input.current) {
      input.current.value = a.input ?? '';
      input.current.focus();
      input.current.select();
    }
    return () => window.removeEventListener('keydown', onKey, true);
  }, [a]);
  if (!a) return null;
  return (
    <div class="modal-backdrop" onClick={() => a.resolve('cancel')}>
      <div class="modal ask" onClick={(e) => e.stopPropagation()}>
        <h3>{a.title}</h3>
        {a.text && <p class="muted">{a.text}</p>}
        {a.input !== undefined && <input ref={input} class="ask-input" type="text" maxLength={60} />}
        {!!a.scripts?.length && a.choices.some((c) => c.value === 'run') && <p class="muted small">{isolationNote()}</p>}
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
            <button key={c.value} class={c.primary ? 'primary' : ''} onClick={() => a.resolve(c.value, input.current?.value)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
