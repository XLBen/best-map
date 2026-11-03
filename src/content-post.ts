import { type Content, postedSmall } from '../core/small-copy';
import type { SmallState } from '../core/world';

// 快照里的 small.content（第四十七轮）：带着一整个库的世界有 300 KB 上下，每发一次快照结构化克隆一遍。内容是不可变的（见 core/small-copy.ts），
// 没换的时候不发：Worker 记着上一次发的对象，主线程记着上一次收到的，快照里只带一个编号。
// 主线程沿用手上同一个对象，按内容对象认的缓存（类别、风格的表，画风的 uniform……）也照样命中。
// 对不上（手上的不是那一份：换了 Worker、某个回复没用上）时拼不起来，和只带变了的数组一样要一份完整的快照。
// 第五十四轮：人口群体（small.popGroups）同样的办法：世界加了几个变量后有上万个群体，也是整个换掉的。

export interface PostedContent {
  small: SmallState;
  // 这份内容的编号（每个 Worker 不同，再按换内容的先后）
  contentRev?: string;
  // 没带内容：small.content 是占位，沿用主线程手上编号相同的那一份
  sameContent?: true;
  // 人口群体的编号；没带群体：small.popGroups 是占位
  groupsRev?: string;
  sameGroups?: true;
}

// Worker 这一头
export class ContentSender {
  private sent = 0;
  private last: Content | undefined;
  private sentGroups = 0;
  private lastGroups: SmallState['popGroups'];
  constructor(private readonly worker: number) {}

  // full：完整的快照（总是带上内容）
  pack(small: SmallState, full = false): PostedContent {
    const same = !full && this.sent > 0 && small.content === this.last;
    if (!same) {
      this.last = small.content;
      this.sent++;
    }
    const sameGroups = !full && this.sentGroups > 0 && small.popGroups === this.lastGroups;
    if (!sameGroups) {
      this.lastGroups = small.popGroups;
      this.sentGroups++;
    }
    const contentRev = `${this.worker}/${this.sent}`;
    const groupsRev = `${this.worker}/${this.sentGroups}`;
    const noContent = same && small.content !== undefined;
    const noGroups = sameGroups && small.popGroups !== undefined;
    const base = noContent ? postedSmall(small) : small;
    return {
      small: noGroups ? { ...base, popGroups: 0 as unknown as SmallState['popGroups'] } : base,
      contentRev,
      groupsRev,
      ...(noContent ? { sameContent: true as const } : {}),
      ...(noGroups ? { sameGroups: true as const } : {}),
    };
  }
}

// 主线程这一头。收到的每份快照都先过这里：带着内容的记下，没带的补上。补不上时返回 false
export class ContentHolder {
  private rev: string | undefined;
  private content: Content | undefined;
  private groupsRev: string | undefined;
  private groups: SmallState['popGroups'];

  unpack(s: PostedContent): boolean {
    if (s.sameContent && (s.contentRev === undefined || this.rev !== s.contentRev || this.content === undefined)) return false;
    if (s.sameGroups && (s.groupsRev === undefined || this.groupsRev !== s.groupsRev || this.groups === undefined)) return false;
    // 赋给占位的键，键的先后不变
    if (s.sameContent) s.small.content = this.content;
    else {
      this.rev = s.contentRev;
      this.content = s.small.content;
    }
    if (s.sameGroups) s.small.popGroups = this.groups;
    else {
      this.groupsRev = s.groupsRev;
      this.groups = s.small.popGroups;
    }
    return true;
  }
}
