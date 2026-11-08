import { type Content, withoutContent } from '../core/small-copy';
import type { SmallState } from '../core/world';

// 快照里的 small.content（第四十七轮）：带着一整个库的世界有 300 KB 上下，每发一次快照结构化克隆一遍。内容是不可变的（见 core/small-copy.ts），
// 没换的时候不发：Worker 记着上一次发的对象，主线程记着上一次收到的，快照里只带一个编号。
// 主线程沿用手上同一个对象，按内容对象认的缓存（类别、风格的表，画风的 uniform……）也照样命中。
// 对不上（手上的不是那一份：换了 Worker、某个回复没用上）时拼不起来，和只带变了的数组一样要一份完整的快照。
// 第五十四轮：人口群体（small.popGroups）同样的办法：世界加了几个变量后有上万个群体，也是整个换掉的。
// 第八十轮：小数据的其余各段（城市、地标、省份、集团……；按 JSON 比）也是这样：没变的段写占位 0、列进 sameSmall，主线程沿用手上同一个对象；
// 国家按一国一国比：没变的国家写 0（sameCountries），主线程沿用那一国的对象（只改了一国的名字时，别的国家、它们的旗都是原来的对象）。
// 这几样要主线程用上了上一份（secBase 与手上的 secRev 相同）才拼得起来，对不上时同样要一份完整的。
// 第八十五轮：国家的档案（small.archive）是不可变的，按对象比（不序列化），没换时同样写占位、列进 sameSmall

export interface PostedContent {
  small: SmallState;
  // 这份内容的编号（每个 Worker 不同，再按换内容的先后）
  contentRev?: string;
  // 没带内容：small.content 是占位，沿用主线程手上编号相同的那一份
  sameContent?: true;
  // 人口群体的编号；没带群体：small.popGroups 是占位
  groupsRev?: string;
  sameGroups?: true;
  // 第八十轮：这一份的编号与上一份的编号；没带的段（small 里那一段是占位 0）；带了的国家里没变的（那一国是占位 0）
  secRev?: string;
  secBase?: string;
  sameSmall?: string[];
  sameCountries?: true;
}

// 不按段比的：内容、人口群体另有编号；数、字照发
const OWN_KEYS = new Set(['content', 'popGroups']);

// Worker 这一头
export class ContentSender {
  private sent = 0;
  private last: Content | undefined;
  private sentGroups = 0;
  private lastGroups: SmallState['popGroups'];
  // 各段上一次发的 JSON；国家一国一份、键的先后
  private packs = 0;
  private json = new Map<string, string>();
  private countryJson = new Map<string, string>();
  private countryOrder = '';
  private lastArchive: unknown;
  constructor(private readonly worker: number) {}

  // 小数据的各段：与上一次发的 JSON 相同的写占位 0（full 时都带上）
  private sections(small: SmallState, full: boolean): { small: SmallState; same: string[]; sameCountries: boolean } {
    const first = this.packs === 0;
    const out = { ...small } as unknown as Record<string, unknown>;
    const same: string[] = [];
    let sameCountries = false;
    const seen = new Set<string>();
    for (const [k, v] of Object.entries(small)) {
      if (OWN_KEYS.has(k) || v === null || typeof v !== 'object') continue;
      seen.add(k);
      if (k === 'archive') {
        if (!full && !first && v === this.lastArchive) {
          out[k] = 0;
          same.push(k);
        }
        this.lastArchive = v;
        continue;
      }
      if (k === 'countries') {
        const metas = v as Record<string, unknown>;
        const posted: Record<string, unknown> = {};
        const order = Object.keys(metas).join(',');
        let changed = order !== this.countryOrder;
        const next = new Map<string, string>();
        for (const [id, m] of Object.entries(metas)) {
          const j = JSON.stringify(m);
          next.set(id, j);
          if (!full && !first && this.countryJson.get(id) === j) posted[id] = 0;
          else {
            posted[id] = m;
            changed = true;
          }
        }
        this.countryJson = next;
        this.countryOrder = order;
        if (!changed && !full && !first) {
          out[k] = 0;
          same.push(k);
        } else if (!full && !first && Object.values(posted).some((x) => x === 0)) {
          out[k] = posted;
          sameCountries = true;
        }
        continue;
      }
      const j = JSON.stringify(v);
      if (!full && !first && this.json.get(k) === j) {
        out[k] = 0;
        same.push(k);
      }
      this.json.set(k, j);
    }
    for (const k of [...this.json.keys()]) if (!seen.has(k)) this.json.delete(k);
    if (!seen.has('archive')) this.lastArchive = undefined;
    if (!seen.has('countries')) {
      this.countryJson.clear();
      this.countryOrder = '';
    }
    return { small: out as unknown as SmallState, same, sameCountries };
  }

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
    const secBase = `${this.worker}/${this.packs}`;
    const sec = this.sections(small, full);
    this.packs++;
    const base = noContent ? withoutContent(sec.small) : sec.small;
    return {
      small: noGroups ? { ...base, popGroups: 0 as unknown as SmallState['popGroups'] } : base,
      contentRev,
      groupsRev,
      ...(noContent ? { sameContent: true as const } : {}),
      ...(noGroups ? { sameGroups: true as const } : {}),
      secRev: `${this.worker}/${this.packs}`,
      ...(sec.same.length || sec.sameCountries ? { secBase } : {}),
      ...(sec.same.length ? { sameSmall: sec.same } : {}),
      ...(sec.sameCountries ? { sameCountries: true as const } : {}),
    };
  }
}

// 主线程这一头。收到的每份快照都先过这里：带着内容的记下，没带的补上。补不上时返回 false
export class ContentHolder {
  private rev: string | undefined;
  private content: Content | undefined;
  private groupsRev: string | undefined;
  private groups: SmallState['popGroups'];
  // 上一份收到的小数据（补好了的）与它的编号
  private secRev: string | undefined;
  private last: SmallState | undefined;

  unpack(s: PostedContent): boolean {
    if (s.sameContent && (s.contentRev === undefined || this.rev !== s.contentRev || this.content === undefined)) return false;
    if (s.sameGroups && (s.groupsRev === undefined || this.groupsRev !== s.groupsRev || this.groups === undefined)) return false;
    if (s.secBase !== undefined && (this.secRev !== s.secBase || !this.last || !this.fill(s))) return false;
    this.secRev = s.secRev;
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
    this.last = s.small;
    return true;
  }

  // 没带的段、国家换成手上那一份里的同一个对象；手上没有时补不上（这时 s 已经改了一部分，不能再用）
  private fill(s: PostedContent): boolean {
    const last = this.last as unknown as Record<string, unknown>;
    const small = s.small as unknown as Record<string, unknown>;
    for (const k of s.sameSmall ?? []) {
      if (small[k] !== 0 || last[k] === undefined || last[k] === null || typeof last[k] !== 'object') return false;
      small[k] = last[k];
    }
    if (s.sameCountries) {
      const metas = small.countries as Record<string, unknown> | undefined;
      const held = last.countries as Record<string, unknown> | undefined;
      if (!metas || !held) return false;
      for (const id of Object.keys(metas)) {
        if (metas[id] !== 0) continue;
        if (!held[id]) return false;
        metas[id] = held[id];
      }
    }
    return true;
  }
}
