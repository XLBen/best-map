import type { Command } from './commands/schema';
import type { SmallState } from './world';

// 上一次生成时世界里的内容，从命令记录里算（第九十轮）。
// 资源库面板的“改了 N 项 · 重新生成”要知道“生成之后内容改过没有”。以前只在主线程上跟着这一次打开页面的每一步记（src/regen-track.ts），
// 刷新页面、重新打开世界就不知道了。其实历史里的每一步都留着它之前的内容（撤销记录按引用共用，见 small-copy.ts），
// 所以“最后一次生成这一样的那一步之后的内容”就是那一步后面第一步的撤销记录里的那一份（它是最后一步时就是现在的内容）：不用另存，世界文件的格式不变。
// 打开世界（重放或从检查点恢复）时历史是从命令记录来的，所以刷新、重新打开以后还在。
// 这里只有规则（哪条命令重新生成了哪一样、哪条是手改），引擎和主线程共用；不碰推导，不改世界

export type RegenContent = SmallState['content'];
export type RegenScope = 'human' | 'countries' | 'settlements' | 'provinces';
export const REGEN_SCOPES: readonly RegenScope[] = ['human', 'countries', 'settlements', 'provinces'];

// 每一样生成时读哪几种内容（改了它们要重新生成那一样才用上）。界面的“改了 N 项”、每一段的“要重新生成”都从这张表来（src/ui/packs/timing.ts）。
// 派系不在里面：生成国家不读它，影响力是用到时现算的（human/country-layers.ts 的 countryFactions）
export const SCOPE_KINDS: Readonly<Record<RegenScope, readonly string[]>> = {
  human: ['era', 'popValue', 'valueGroup', 'cultureGroup', 'culture'],
  countries: ['government', 'countryTier', 'countryPattern'],
  settlements: ['cityRank', 'landmarkType', 'pointType'],
  provinces: ['provinceRules'],
};

// 手改的命令改的是哪一样（重新生成时会被换掉的：锁定的、自己放的城市不算；人文的重新生成留着手改过的格，不算）
const HAND: Partial<Record<Command['op'], RegenScope>> = {
  paint_country: 'countries',
  restore_country: 'countries',
  new_country: 'countries',
  merge_countries: 'countries',
  split_country: 'countries',
  set_country: 'countries',
  remove_country: 'countries',
  set_bloc: 'countries',
  move_capital: 'countries',
  assign_province: 'provinces',
  merge_province: 'provinces',
  split_province: 'provinces',
  cut_province: 'provinces',
  set_province: 'provinces',
  regenerate_provinces: 'provinces',
};
export function handOf(cmd: Command, out = new Set<RegenScope>()): Set<RegenScope> {
  if (cmd.op === 'batch') for (const c of cmd.commands) handOf(c, out);
  else if (HAND[cmd.op]) out.add(HAND[cmd.op]!);
  return out;
}

// 这条命令重新生成了哪几样。重新生成人文时国家的领土不动（写了 countries 才重长）；重新生成国家时人口按新的国家重算；城市跟着人文、国家一起重算
export function scopesOf(cmd: Command, out = new Set<RegenScope>()): Set<RegenScope> {
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
    // 第八十一轮：整张图重新划分省份（重新划分一片是手改）
    case 'generate_provinces':
      out.add('provinces');
      break;
  }
  return out;
}

const GEN_OPS: ReadonlySet<string> = new Set(['generate_human', 'regenerate_human', 'generate_countries', 'regenerate_countries', 'generate_settlements', 'regenerate_settlements', 'generate_provinces']);

// 历史里的一步：命令，和这一步之前的内容（撤销记录里的那一份）
export interface RegenStep {
  cmd: Command;
  undo: { content?: RegenContent };
}

export interface RegenBaseOf {
  human: RegenContent;
  countries: RegenContent;
  settlements: RegenContent;
  provinces: RegenContent;
  // 最后一次生成之后手改过的几样
  hand: RegenScope[];
}

// 做过的各步（先后）和现在的内容 → 每一样上一次生成时的内容。从来没有生成过的那一样按现在的算（没有要重新生成的）。
// 从后往前走一遍，四样都找到就停；只看命令是哪一种，一步几十纳秒
export function regenBaseOf(done: readonly RegenStep[], now: RegenContent): RegenBaseOf {
  const out: RegenBaseOf = { human: now, countries: now, settlements: now, provinces: now, hand: [] };
  const left = new Set<RegenScope>(REGEN_SCOPES);
  const hand = new Set<RegenScope>();
  for (let k = done.length - 1; k >= 0 && left.size; k--) {
    const cmd = done[k].cmd;
    // 绝大多数步（画笔、改内容）和生成、手改都无关：只看一眼是哪种命令
    if (cmd.op !== 'batch' && !GEN_OPS.has(cmd.op) && HAND[cmd.op] === undefined) continue;
    const after = k + 1 < done.length ? done[k + 1].undo.content : now;
    // 这一步的手改只算给生成在它之前的那几样（这一步自己又生成又手改的，算手改过：和 regen-track.ts 一步里的先后一样）
    const open = new Set(left);
    for (const s of scopesOf(cmd)) {
      if (!left.delete(s)) continue;
      out[s] = after;
    }
    for (const s of handOf(cmd)) if (open.has(s)) hand.add(s);
  }
  out.hand = REGEN_SCOPES.filter((s) => hand.has(s));
  return out;
}

// ---------- 发给主线程：只带和现在不一样的项 ----------
// 内容有 300 KB 上下，整份发四遍太多。四样和现在的内容几乎都是同一批对象，只发换过的项：主线程在自己手上的内容上拼回去，
// 没换的种类、项还是同一个对象（regen.ts 按对象比，一比就过）。每一样只带它生成时读的那几种（SCOPE_KINDS）：别的种类主线程不比，
// 拼回来的那一份里它们就是现在的

export interface KindDiff {
  // 那时候是这样的项（现在换了、或者现在没有了）
  set: Record<string, unknown>;
  // 那时候没有、现在有的 id
  drop: string[];
}
export type ContentDiff = Record<string, KindDiff>;
export interface PostedRegenBase {
  // 和现在的内容一样的那一样不写
  diff: Partial<Record<RegenScope, ContentDiff>>;
  hand?: RegenScope[];
}

type Store = Record<string, Record<string, unknown>>;
const EMPTY: Record<string, unknown> = {};

// kinds：只比这几种
export function contentDiff(then: RegenContent, now: RegenContent, kinds: readonly string[]): ContentDiff | null {
  if (then === now) return null;
  const a = (then ?? {}) as Store;
  const b = (now ?? {}) as Store;
  const out: ContentDiff = {};
  for (const kind of kinds) {
    const x = a[kind] ?? EMPTY;
    const y = b[kind] ?? EMPTY;
    if (x === y) continue;
    const set: Record<string, unknown> = {};
    const drop: string[] = [];
    for (const id of Object.keys(x)) if (x[id] !== y[id]) set[id] = x[id];
    for (const id of Object.keys(y)) if (!(id in x)) drop.push(id);
    if (Object.keys(set).length || drop.length) out[kind] = { set, drop };
  }
  return Object.keys(out).length ? out : null;
}

export function postRegenBase(base: RegenBaseOf, now: RegenContent): PostedRegenBase {
  const diff: PostedRegenBase['diff'] = {};
  for (const s of REGEN_SCOPES) {
    const d = contentDiff(base[s], now, SCOPE_KINDS[s]);
    if (d) diff[s] = d;
  }
  return { diff, ...(base.hand.length ? { hand: base.hand } : {}) };
}

// 主线程：在手上的内容上拼回那时候的。项的先后：现在还有的照现在的先后，现在没有了的排在后面（比的时候不看先后）
export function applyContentDiff(now: RegenContent, diff: ContentDiff | undefined): RegenContent {
  if (!diff) return now;
  const out: Store = { ...((now ?? {}) as Store) };
  for (const [kind, d] of Object.entries(diff)) {
    const items: Record<string, unknown> = { ...(out[kind] ?? {}) };
    for (const id of d.drop) delete items[id];
    for (const [id, x] of Object.entries(d.set)) items[id] = x;
    out[kind] = items;
  }
  return out as RegenContent;
}

export function unpostRegenBase(posted: PostedRegenBase, now: RegenContent): RegenBaseOf {
  return {
    human: applyContentDiff(now, posted.diff.human),
    countries: applyContentDiff(now, posted.diff.countries),
    settlements: applyContentDiff(now, posted.diff.settlements),
    provinces: applyContentDiff(now, posted.diff.provinces),
    hand: [...(posted.hand ?? [])],
  };
}
