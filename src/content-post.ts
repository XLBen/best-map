import { type Content, postedSmall } from '../core/small-copy';
import type { SmallState } from '../core/world';

// 快照里的 small.content（第四十七轮）：带着一整个库的世界有 300 KB 上下，每发一次快照结构化克隆一遍。内容是不可变的（见 core/small-copy.ts），
// 没换的时候不发：Worker 记着上一次发的对象，主线程记着上一次收到的，快照里只带一个编号。
// 主线程沿用手上同一个对象，按内容对象认的缓存（类别、风格的表，画风的 uniform……）也照样命中。
// 对不上（手上的不是那一份：换了 Worker、某个回复没用上）时拼不起来，和只带变了的数组一样要一份完整的快照。

export interface PostedContent {
  small: SmallState;
  // 这份内容的编号（每个 Worker 不同，再按换内容的先后）
  contentRev?: string;
  // 没带内容：small.content 是占位，沿用主线程手上编号相同的那一份
  sameContent?: true;
}

// Worker 这一头
export class ContentSender {
  private sent = 0;
  private last: Content | undefined;
  constructor(private readonly worker: number) {}

  // full：完整的快照（总是带上内容）
  pack(small: SmallState, full = false): PostedContent {
    const same = !full && this.sent > 0 && small.content === this.last;
    if (!same) {
      this.last = small.content;
      this.sent++;
    }
    const contentRev = `${this.worker}/${this.sent}`;
    return same && small.content !== undefined ? { small: postedSmall(small), contentRev, sameContent: true } : { small, contentRev };
  }
}

// 主线程这一头。收到的每份快照都先过这里：带着内容的记下，没带的补上。补不上时返回 false
export class ContentHolder {
  private rev: string | undefined;
  private content: Content | undefined;

  unpack(s: PostedContent): boolean {
    if (!s.sameContent) {
      this.rev = s.contentRev;
      this.content = s.small.content;
      return true;
    }
    if (s.contentRev === undefined || this.rev !== s.contentRev || this.content === undefined) return false;
    // 赋给占位的键，键的先后不变
    s.small.content = this.content;
    return true;
  }
}
