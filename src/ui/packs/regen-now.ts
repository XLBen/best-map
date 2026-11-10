import type { SmallState } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import type { RegenBase } from '../../regen-track';
import { regenTrack } from '../../state';
import { type RegenNeed, regenNeed } from './regen';

// 现在有没有改了还没用上的（第九十轮）：面板底下的那一条和顶栏“资源库”按钮上的小标记看的是同一个数。
// 顶栏一直在，世界每换一份（画一笔也是）都会问一次：按用到的几样记着，它们没换就不重算
// （内容、人文、城市的规则、省份都是按对象沿用的，见 src/content-post.ts）

type Small = Pick<SmallState, 'content' | 'human' | 'settlementRules' | 'provinces'>;
interface Memo {
  content: unknown;
  human: unknown;
  settle: unknown;
  provinces: unknown;
  base: RegenBase | null;
  lib: readonly LibraryEntry[];
  need: RegenNeed | null;
}
let memo: Memo | null = null;

export function regenNow(small: Small, lib: readonly LibraryEntry[], base: RegenBase | null = regenTrack.base()): RegenNeed | null {
  const m = memo;
  if (m && m.content === small.content && m.human === small.human && m.settle === small.settlementRules && m.provinces === small.provinces && m.base === base && m.lib === lib) return m.need;
  const need = regenNeed(small, base, lib);
  memo = { content: small.content, human: small.human, settle: small.settlementRules, provinces: small.provinces, base, lib, need };
  return need;
}
