import { SIMPLE_TEXT } from '../copy';
import { fullUi, restOpen, setRestOpen } from '../ui-prefs';
import type { SimpleView } from '../defs/simple-ui';

// 简单界面里藏了东西的地方末尾的那一行（第九十九轮，全应用同一种）：“还有 N 种底图”，点了只在这一处展开；
// 展开着时是“只留常用的”，旁边一句怎么一直露着。完整界面、没有藏着的时什么都不画。
// 底部条上工具那一排是同一件事的窄的样子（shell/ContextBar.tsx 的 .bb-rest）

// 这一处现在怎么看：给 defs/simple-ui.ts 的 splitSimple
export const simpleView = (place: string): SimpleView => ({ full: fullUi(), open: restOpen(place) });

export function RestLine({ place, hidden, foldable, unit, names }: { place: string; hidden: number; foldable: number; unit: string; names: readonly string[] }) {
  if (hidden > 0)
    return (
      <button class="link-btn rest-line" data-rest={hidden} title={SIMPLE_TEXT.restTip(names)} onClick={() => setRestOpen(place, true)}>
        {SIMPLE_TEXT.rest(hidden, unit)}
      </button>
    );
  if (foldable > 0)
    return (
      <p class="rest-line open">
        <button class="link-btn" onClick={() => setRestOpen(place, false)}>
          {SIMPLE_TEXT.fold}
        </button>
        <span class="hint">{SIMPLE_TEXT.always}</span>
      </p>
    );
  return null;
}
