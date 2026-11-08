import { addNow } from './pick-add';
import type { PageCtx, SourceRef } from './pages';
import { closeSide } from './panel-store';
import { shownPick } from './pick-view';

// 资源库面板里的键盘（第六十七轮）。挂在面板上，焦点在面板里才收到，不抢地图的快捷键（处理了的不再往外传）：
//   上下键   在行间移动（行是 [data-pick-row]；搜索框里按下键到第一行）
//   空格     勾这一行（点它的 .lp-pick）
//   回车     打开这一行（能勾的库里在右栏打开）
//   Esc      先清搜索，再收起右栏（“从别的库加”开着时先收它）；之后照旧一层层返回（shell/keys.ts）
//   ⌘回车    添加（清单上的“添加 N 项”；“从别的库加”的右栏里自己处理，LibOther.tsx）
export function panelKeys(e: KeyboardEvent, body: HTMLElement | null, src: SourceRef, ctx: PageCtx, hasSide: boolean): void {
  const t = e.target as HTMLElement;
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  const search = t instanceof HTMLInputElement && t.type === 'search' ? t : null;
  if (e.key === 'Escape') {
    if (search?.value) {
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return done();
    }
    if (hasSide) {
      closeSide();
      return done();
    }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    const v = shownPick(src, ctx);
    if (!v) return;
    if (v.preview.count) void addNow(v, ctx, false);
    return done();
  }
  if (e.metaKey || e.ctrlKey || e.altKey || !body) return;
  const row = t.closest<HTMLElement>('[data-pick-row]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!row && !search) return;
    // 右栏的页面里（融入的子项）、“从别的库加”里在右栏的行之间走
    const box = t.closest<HTMLElement>('.lp-side-page, .lo-pane') ?? body;
    const rows = [...box.querySelectorAll<HTMLElement>('[data-pick-row]')];
    if (!rows.length) return;
    const at = row ? rows.indexOf(row) : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
    return done();
  }
  // 空格、回车只管停在行上的（勾选框、按钮自己会处理）
  if (!row || t !== row) return;
  if (e.key === ' ') {
    row.querySelector<HTMLElement>('.lp-pick input, button.lp-pick')?.click();
    return done();
  }
  if (e.key === 'Enter') {
    row.querySelector<HTMLElement>('.lp-row-main')?.click();
    return done();
  }
}
