import type { ComponentChildren } from 'preact';

// 开关：全界面的“开 / 关”只有这一种（底部条上的无人区、锁定、省份着色，面板里的显示什么、自然生成……）。
// 从一组里挑几样（资源包挑哪些、只长在哪些地方）照旧是勾选框 label.check
export function Toggle({ on, onChange, title, disabled, children }: { on: boolean; onChange: (on: boolean) => void; title?: string; disabled?: boolean; children: ComponentChildren }) {
  return (
    <button type="button" role="switch" aria-checked={on} class={`toggle ${on ? 'on' : ''}`} title={title} disabled={disabled} onClick={() => onChange(!on)}>
      <span class="toggle-track" aria-hidden="true">
        <span class="toggle-knob" />
      </span>
      <span class="toggle-text">{children}</span>
    </button>
  );
}
