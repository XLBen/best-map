import type { Command } from '../core/commands';
import { type RegenBaseOf, type RegenScope, handOf, scopesOf } from '../core/regen-base';
import type { SmallState } from '../core/world';

// 上一次生成时世界里的内容（第六十二轮）：面板底下的“重新生成”只有确实需要时才出现，所以要知道“生成之后内容改过没有”。
// 世界不记这个（small 在金标准里），这里跟着撤销的先后记：历史里的每个位置对应一份。撤销、重做回到那个位置的那一份，
// 所以撤销掉改动按钮就没了，撤销掉重新生成按钮就回来了。记的只是内容对象的引用（内容不改动），很多步共用同一份。
// 第九十轮：刷新、打开世界文件之后也知道——打开时引擎从命令记录里算出那一份（core/regen-base.ts：历史里每一步都留着它之前的内容），
// 随打开的回复发来（reset 的 given）；撤销到这次打开页面之前的步骤时也是引擎给的（step 的 given）。
// 执行的每一步照旧在这里跟着记，引擎不多做事（编辑不变慢）。哪条命令重新生成哪一样、哪条是手改，两边用同一份规则。
// 不碰界面，测试直接调

export type Content = SmallState['content'];
export type { RegenScope };
// hand：上次生成之后手改过的几样（第八十一轮：重新生成的条上写“手改过的国家会被换掉”）
export type RegenBase = Readonly<Record<RegenScope, Content>> & { readonly hand?: readonly RegenScope[] };

// 回复到达之前说一声：这一次是一条命令（可能是生成）、撤销或重做
export type RegenPending = Command | 'history' | null;

// 引擎给的那一份 → 这里记的样子（没有手改时不写 hand）
function given(b: RegenBaseOf): RegenBase {
  const { hand, ...rest } = b;
  return hand.length ? { ...rest, hand } : rest;
}

export class RegenTrack {
  pending: RegenPending = null;
  private steps = new Map<number, RegenBase>();
  private at = 0;

  private fresh(content: Content): RegenBase {
    return { human: content, countries: content, settlements: content, provinces: content };
  }

  // 新建、打开了世界。base：引擎从命令记录里算的（没给时从现在的内容算起）
  reset(position: number, content: Content, base?: RegenBaseOf | null): void {
    this.pending = null;
    this.steps.clear();
    this.steps.set(position, base ? given(base) : this.fresh(content));
    this.at = position;
  }

  // 世界换上了一份新的。position：历史里做过的步数。base：撤销、重做时引擎给的那个位置的那一份
  step(position: number, content: Content, base?: RegenBaseOf | null): void {
    const p = this.pending;
    this.pending = null;
    const prev = this.steps.get(position - 1) ?? this.steps.get(this.at) ?? this.fresh(content);
    if (p === 'history') {
      // 不知道的位置（这次打开页面以前的步骤）：引擎给的；没给时从现在的内容算起
      if (!this.steps.has(position)) this.steps.set(position, base ? given(base) : this.fresh(content));
    } else if (p || position > this.at) {
      // 新的一步：后面的（撤销掉的）不要了
      for (const k of [...this.steps.keys()]) if (k > position) this.steps.delete(k);
      const redone = p ? scopesOf(p) : null;
      const next: { -readonly [K in RegenScope]: Content } & { hand?: readonly RegenScope[] } = { ...prev };
      for (const s of redone ?? []) next[s] = content;
      if (p) {
        const hand = new Set(prev.hand ?? []);
        for (const s of redone ?? []) hand.delete(s);
        for (const s of handOf(p)) hand.add(s);
        if (hand.size) next.hand = [...hand];
        else delete next.hand;
      }
      this.steps.set(position, next);
    } else if (!this.steps.has(position)) this.steps.set(position, base ? given(base) : this.fresh(content));
    this.at = position;
  }

  base(): RegenBase | null {
    return this.steps.get(this.at) ?? null;
  }
}
