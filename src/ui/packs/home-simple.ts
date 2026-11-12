import { type SimpleView, splitSimple } from '../defs/simple-ui';
import { HOME_MORE_CARDS } from './page-layout';
import type { Card, HomeSection } from './pages';

// 简单界面里资源库的首页露哪些卡片（第九十九轮，纯函数）：page-layout.ts 的 HOME_MORE_CARDS 里的只在完整界面里露，
// 别的是常用的。kept：不常用、但现在也该露着的（挑选时勾了东西的那一种）。一段的卡片都藏着时这一段不画。
// hidden 是首页最下面“还有 N 类”数的

export const HOME_PLACE = 'lib-home';

const isMore = (c: Pick<Card, 'id'>) => HOME_MORE_CARDS.includes(c.id);

export interface SimpleHome {
  sections: HomeSection[];
  hidden: Card[];
  foldable: number;
}

export function simpleHome(sections: readonly HomeSection[], view: SimpleView, kept: (c: Card) => boolean = () => false): SimpleHome {
  const all = sections.flatMap((s) => s.cards);
  const split = splitSimple(all, view, isMore, kept);
  const on = new Set(split.shown);
  return {
    sections: sections.map((s) => ({ ...s, cards: s.cards.filter((c) => on.has(c)) })).filter((s) => s.cards.length > 0),
    hidden: split.hidden,
    foldable: split.foldable,
  };
}
