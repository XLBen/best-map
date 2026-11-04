import type { Command } from '../core/commands';
import type { SmallState } from '../core/world';

// 上一次生成时世界里的内容（第六十二轮）：面板顶上的“重新生成”只有确实需要时才出现，所以要知道“生成之后内容改过没有”。
// 世界不记这个（small 在金标准里），这里跟着撤销的先后记：历史里的每个位置对应一份。撤销、重做回到那个位置的那一份，
// 所以撤销掉改动按钮就没了，撤销掉重新生成按钮就回来了。记的只是内容对象的引用（内容不改动），很多步共用同一份。
// 刷新、打开世界文件之后不知道以前改过什么：从那时候的内容算起。
// 不碰界面，测试直接调

export type Content = SmallState['content'];
export type RegenScope = 'human' | 'countries' | 'settlements';
export type RegenBase = Readonly<Record<RegenScope, Content>>;

// 这条命令重新生成了哪几样。重新生成人文时国家的领土不动（写了 countries 才重长）；重新生成国家时人口按新的国家重算；城市跟着人文、国家一起重算
function scopesOf(cmd: Command, out = new Set<RegenScope>()): Set<RegenScope> {
  switch (cmd.op) {
    case 'batch':
      for (const c of cmd.commands) scopesOf(c, out);
      break;
    case 'generate_human':
      out.add('human').add('countries').add('settlements');
      break;
    case 'regenerate_human':
      out.add('human').add('settlements');
      if (cmd.countries) out.add('countries');
      break;
    case 'generate_countries':
    case 'regenerate_countries':
      out.add('human').add('countries').add('settlements');
      break;
    case 'generate_settlements':
    case 'regenerate_settlements':
      out.add('settlements');
      break;
  }
  return out;
}

// 回复到达之前说一声：这一次是一条命令（可能是生成）、撤销或重做
export type RegenPending = Command | 'history' | null;

export class RegenTrack {
  pending: RegenPending = null;
  private steps = new Map<number, RegenBase>();
  private at = 0;

  private fresh(content: Content): RegenBase {
    return { human: content, countries: content, settlements: content };
  }

  // 新建、打开了世界
  reset(position: number, content: Content): void {
    this.pending = null;
    this.steps.clear();
    this.steps.set(position, this.fresh(content));
    this.at = position;
  }

  // 世界换上了一份新的。position：历史里做过的步数
  step(position: number, content: Content): void {
    const p = this.pending;
    this.pending = null;
    const prev = this.steps.get(position - 1) ?? this.steps.get(this.at) ?? this.fresh(content);
    if (p === 'history') {
      // 不知道的位置（打开世界以前的步骤）：从现在的内容算起
      if (!this.steps.has(position)) this.steps.set(position, this.fresh(content));
    } else if (p || position > this.at) {
      // 新的一步：后面的（撤销掉的）不要了
      for (const k of [...this.steps.keys()]) if (k > position) this.steps.delete(k);
      const redone = p ? scopesOf(p) : null;
      const next = { ...prev };
      for (const s of redone ?? []) next[s] = content;
      this.steps.set(position, next);
    } else if (!this.steps.has(position)) this.steps.set(position, this.fresh(content));
    this.at = position;
  }

  base(): RegenBase | null {
    return this.steps.get(this.at) ?? null;
  }
}
