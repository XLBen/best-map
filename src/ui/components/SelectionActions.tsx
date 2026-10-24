import { Dices, Ellipsis, EyeOff, Lock, LockOpen, ScanSearch, Trash2, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { type PanelId, openPanel, togglePanel } from '../../state';
import { NAME_TIPS } from '../copy';

// 选中了一样东西（河、湖、省、地名）时的那几个按钮：换一个、恢复自动、锁定、定位、删除或隐藏、取消选择。
// 四处共用一份。底部条上放常用的；河、省把不常用的收进“⋯”（more：弹出哪个面板），
// 弹出的面板里用 menu 布局再放一遍同一个组件（一行一个，带字）

export interface SelectionHandlers {
  // 换一个：自动换一个名字
  reroll?: () => void;
  rerollTitle?: string;
  // 恢复自动：不用自己起的名字
  unlock?: () => void;
  unlockTitle?: string;
  // 锁定：名字不再跟着变
  lock?: () => void;
  lockTitle?: string;
  locate?: () => void;
  remove?: () => void;
  removeTitle?: string;
  removeLabel?: string;
  // 隐藏（地名）：能再显示，图标用闭眼而不是垃圾桶
  hide?: boolean;
}

export function SelectionActions({
  menu = false,
  more,
  moreTitle,
  deselect,
  children,
  ...h
}: SelectionHandlers & { menu?: boolean; more?: PanelId; moreTitle?: string; deselect?: () => void; children?: ComponentChildren }) {
  if (menu) {
    return (
      <div class="menu">
        {h.reroll && <MenuItem icon={<Dices />} label="换名字" title={h.rerollTitle ?? NAME_TIPS.reroll} run={h.reroll} />}
        {h.unlock && <MenuItem icon={<LockOpen />} label="恢复自动" title={h.unlockTitle ?? NAME_TIPS.unlock} run={h.unlock} />}
        {h.lock && <MenuItem icon={<Lock />} label="锁定名字" title={h.lockTitle ?? NAME_TIPS.lock} run={h.lock} />}
        {children}
        {h.locate && <MenuItem icon={<ScanSearch />} label="定位" run={h.locate} />}
        {h.remove && <MenuItem icon={h.hide ? <EyeOff /> : <Trash2 />} label={h.removeLabel ?? (h.hide ? '隐藏' : '删除')} title={h.removeTitle} run={h.remove} danger={!h.hide} />}
      </div>
    );
  }
  return (
    <>
      {h.reroll && (
        <button class="bar-btn" onClick={h.reroll} title={h.rerollTitle ?? NAME_TIPS.reroll}>
          <Dices /> 换一个
        </button>
      )}
      {h.unlock && (
        <button class="bar-btn" onClick={h.unlock} title={h.unlockTitle ?? NAME_TIPS.unlock}>
          <LockOpen /> 恢复自动
        </button>
      )}
      {h.lock && (
        <button class="bar-btn" onClick={h.lock} title={h.lockTitle ?? NAME_TIPS.lock}>
          <Lock /> 锁定
        </button>
      )}
      {children}
      {h.locate && (
        <button class="bar-btn icon" onClick={h.locate} title="定位">
          <ScanSearch />
        </button>
      )}
      {h.remove && (
        <button class="bar-btn icon" onClick={h.remove} title={h.removeTitle ?? h.removeLabel ?? (h.hide ? '隐藏' : '删除')}>
          {h.hide ? <EyeOff /> : <Trash2 />}
        </button>
      )}
      {more && (
        <button class={`bar-btn icon ${openPanel.value === more ? 'open' : ''}`} data-panel={more} onClick={() => togglePanel(more)} title={moreTitle ?? '更多'}>
          <Ellipsis />
        </button>
      )}
      {deselect && (
        <button class="bar-btn icon" onClick={deselect} title="取消选择">
          <X />
        </button>
      )}
    </>
  );
}

// “⋯”里的一行：图标、字；on：正开着（分一股出去、从这里往下去掉这种按一下再在地图上点的）
export function MenuItem({ icon, label, title, run, danger, on, disabled }: { icon: ComponentChildren; label: string; title?: string; run: () => void; danger?: boolean; on?: boolean; disabled?: boolean }) {
  return (
    <button class={`item ${danger ? 'danger' : ''} ${on ? 'on' : ''}`} title={title} onClick={run} disabled={disabled}>
      {icon}
      <span class="grow">{label}</span>
    </button>
  );
}
