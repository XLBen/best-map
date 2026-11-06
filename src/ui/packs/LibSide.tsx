import { ChevronLeft, X } from 'lucide-preact';
import { LibBasket } from './LibBasket';
import { PageItem } from './PageItem';
import type { PageCtx, Route, SourceRef } from './pages';
import { closeSide } from './panel-store';
import { pickView } from './pick-view';

// 资源库面板的右栏（第六十七轮）：能勾的库里勾了东西、点了一项时滑出来。上面是点开的那一项的完整页面（内置的库只读，我的库能改），
// 下面是清单（LibBasket）。窄窗口（约 900 px 以下）里盖在左栏上，左上角返回

export function LibSide({ src, side, ctx, over }: { src: SourceRef; side: Extract<Route, { p: 'item' }> | null; ctx: PageCtx; over: boolean }) {
  const v = pickView(src, ctx);
  return (
    <aside class={`lp-side ${side ? 'with-page' : ''}`}>
      {over && (
        <div class="lp-nav">
          <button class="lp-back" onClick={closeSide} title="返回（Esc）">
            <ChevronLeft />
            <span class="ellipsis">返回</span>
          </button>
        </div>
      )}
      {side && (
        <div class="lp-side-page">
          {!over && (
            <button class="icon-btn lp-side-close" onClick={closeSide} title="收起（Esc）">
              <X />
            </button>
          )}
          <PageItem key={`${side.kind}|${side.id}`} route={side} src={src} ctx={ctx} side />
        </div>
      )}
      {v && <LibBasket v={v} ctx={ctx} />}
    </aside>
  );
}
