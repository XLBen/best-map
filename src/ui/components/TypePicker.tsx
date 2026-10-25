import { ChevronDown, Library, type LucideIcon, Plus } from 'lucide-preact';
import { type PanelId, openPanel, togglePanel } from '../../state';
import { openRepo } from '../packs/store';

// 选“哪一种”：底部条上的按钮（“新画的河：血河 ▾”“岛：珊瑚岛 ▾”）和点开的列表（最后一项“新建…”）。
// 河、湖、岛（放岛、岛链）六个弹出的列表都是它，只是种类表不一样。
// 第二十八轮：列表里只有本世界的内容，最后一项“从资源库添加…”打开资源库、筛到这一种不在本世界的（library 是种类的 id）

export interface TypeChoice {
  label: string;
  // 色块的颜色（没有时不画：地名风格）
  swatch?: string;
  on: boolean;
  hint?: string;
  // 右边灰色的一小段（画法、形状）
  meta?: string;
  // 分组（第二十二轮：文化按文化组列）：与上一行不同时先写一行小标题
  group?: string;
  // 图标（第二十四轮：地标、自定义点的类型）
  icon?: LucideIcon;
  // 上传的小图（自定义点的类型）
  image?: string;
  onPick: () => void;
}

export const LIBRARY_LABEL = '从资源库添加…';

// 打开资源库，筛到这一种不在本世界的（工具里的“从资源库添加…”）
export function openLibraryFor(kind: string) {
  openPanel.value = null;
  openRepo({ kind, filter: 'off', query: '', entry: undefined, edit: undefined });
}

// 不是 TypePicker 的选择（下拉框、档案里的列表）下面的一行“从资源库添加…”
export function LibraryLink({ kind, title }: { kind: string; title?: string }) {
  return (
    <button class="link-btn small" onClick={() => openLibraryFor(kind)} title={title ?? '资源库里还有的，添加到本世界后就能选'}>
      <Library /> {LIBRARY_LABEL}
    </button>
  );
}

// 弹出的列表：几行选择，最后是新建（新建一种、用上它，并打开它的设置）与“从资源库添加…”
export function TypePicker({
  items,
  onNew,
  newLabel,
  newTitle,
  note,
  library,
}: {
  items: TypeChoice[];
  onNew?: () => void;
  newLabel?: string;
  newTitle?: string;
  note?: string;
  library?: string;
}) {
  return (
    <div class="menu">
      {items.map((it, k) => (
        <>
          {it.group !== undefined && it.group !== items[k - 1]?.group && <h5 class="menu-group">{it.group}</h5>}
          <button key={`${it.group ?? ''}:${it.label}`} class={`item ${it.on ? 'on' : ''}`} title={it.hint} onClick={it.onPick}>
            {it.swatch !== undefined && <span class="swatch" style={{ background: it.swatch }} />}
            {it.image ? <img class="type-img" src={it.image} alt="" /> : it.icon ? <it.icon /> : null}
            <span class="grow">{it.label}</span>
            {it.meta && <span class="hint">{it.meta}</span>}
          </button>
        </>
      ))}
      {onNew && (
        <button class="item" onClick={onNew} title={newTitle}>
          <Plus />
          <span class="grow">{newLabel}</span>
        </button>
      )}
      {library && (
        <button class="item" onClick={() => openLibraryFor(library)} title="资源库里还有的，添加到本世界后就能选">
          <Library />
          <span class="grow">{LIBRARY_LABEL}</span>
        </button>
      )}
      {note && <p class="hint">{note}</p>}
    </div>
  );
}

// 底部条上的按钮：“前缀：色块 名字 ▾”。auto：现在是按规则判断出来的
export function TypePickerButton({ panel, prefix, swatch, icon: I, name, auto, title }: { panel: PanelId; prefix: string; swatch?: string; icon?: LucideIcon; name: string; auto?: boolean; title: string }) {
  return (
    <button class={`bar-btn ${openPanel.value === panel ? 'open' : ''}`} data-panel={panel} onClick={() => togglePanel(panel)} title={title}>
      <span class="muted">{prefix}：</span>
      {swatch !== undefined && <span class="swatch" style={{ background: swatch }} />}
      {I && <I />} {name}
      {auto ? <span class="hint">（自动）</span> : null}
      <ChevronDown />
    </button>
  );
}
