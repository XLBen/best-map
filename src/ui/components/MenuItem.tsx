import type { ComponentChildren } from 'preact';

// “⋯”里的一行：图标、字；on：正开着（分一股出去、从这里往下去掉这种按一下再在地图上点的）
export function MenuItem({ icon, label, title, run, danger, on, disabled }: { icon: ComponentChildren; label: string; title?: string; run: () => void; danger?: boolean; on?: boolean; disabled?: boolean }) {
  return (
    <button class={`item ${danger ? 'danger' : ''} ${on ? 'on' : ''}`} title={title} onClick={run} disabled={disabled}>
      {icon}
      <span class="grow">{label}</span>
    </button>
  );
}
