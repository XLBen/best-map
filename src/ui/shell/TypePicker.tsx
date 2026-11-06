import { ChevronDown, Library, type LucideIcon, Plus } from 'lucide-preact';
import { library as libraryList } from '../../library';
import { type PanelId, openPanel, togglePanel, world } from '../../state';
import { LIBRARY_ADD_LABEL, LIBRARY_ADD_TIP } from '../copy';
import { type TypeChoice, openLibraryFor, originGroups } from './type-picker';

// 选“哪一种”：底部条上的按钮（“新画的河：血河 ▾”“岛：珊瑚岛 ▾”）和点开的列表（最后一项“新建…”）。
// 河、湖、岛（放岛、岛链）六个弹出的列表都是它，只是种类表不一样。
// 第二十八轮：列表里只有本世界的内容，最后一项“从资源库添加…”打开资源库、筛到这一种不在本世界的（library 是种类的 id）
// 第二十九轮：写了 id 的项按来源的包分段（originGroups），离群的放最后
// 第六十九轮从 components/ 搬来（它打开资源库、读本世界和资源库）；分段、打开资源库在 type-picker.ts

// 不是 TypePicker 的选择（下拉框、档案里的列表）下面的一行“从资源库添加…”
export function LibraryLink({ kind, title }: { kind: string; title?: string }) {
  return (
    <button class="link-btn small" onClick={() => openLibraryFor(kind)} title={title ?? LIBRARY_ADD_TIP}>
      <Library /> {LIBRARY_ADD_LABEL}
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
  const shown = library ? originGroups(items, library, world.value, libraryList.value) : items;
  return (
    <div class="menu">
      {shown.map((it, k) => (
        <>
          {it.group !== undefined && it.group !== shown[k - 1]?.group && <h5 class="menu-group">{it.group}</h5>}
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
        <button class="item" onClick={() => openLibraryFor(library)} title={LIBRARY_ADD_TIP}>
          <Library />
          <span class="grow">{LIBRARY_ADD_LABEL}</span>
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
