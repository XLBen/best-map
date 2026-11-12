import type { Command } from '../../../core/commands';
import type { World } from '../../../core/world';

// 简单界面里露什么（第九十九轮，纯函数；偏好和“这一处展开着没有”在 ui-prefs.ts，这里不读它们）。
// 一项（工具、底图、图层里的开关、“调整”里的一项、资源库首页的卡片）在声明里写 more 就是“只在完整界面里露”，不写就是常用。
// 简单界面里一项露着，当且仅当下面有一条成立：
//   1. 它是常用的（没写 more）；
//   2. 世界里已经有它对应的东西（声明里的 when：下面 WORLD_SIGNS 的一个键；“调整”里是它不在默认值上）；
//   3. 它正在用（正拿着的工具、正看着的底图、开着的开关）；
//   4. 这一处点过“还有 N 个”展开着。
// 完整界面里都露着。先后永远是声明里的先后。

// ---------- 世界里已经有什么 ----------

type Sign = (w: World, commands: () => readonly Command[] | null) => boolean;

const any = (o: object | undefined): boolean => {
  if (o) for (const _ in o) return true;
  return false;
};
// 一个数组里有没有不是 0 的（画过的地形类别、资源：0 是自动）。按数组对象记着，数组没换不重扫
const painted = new WeakMap<Uint8Array, boolean>();
function anySet(a: Uint8Array | undefined): boolean {
  if (!a) return false;
  let v = painted.get(a);
  if (v === undefined) {
    v = false;
    for (let i = 0; i < a.length; i++)
      if (a[i]) {
        v = true;
        break;
      }
    painted.set(a, v);
  }
  return v;
}
// 命令记录里有没有这一种命令（batch 里的也算）
function hasOp(commands: readonly Command[] | null, op: string): boolean {
  if (!commands) return false;
  return commands.some((c) => c.op === op || (c.op === 'batch' && hasOp(c.commands, op)));
}

export const WORLD_SIGNS = {
  // 划分过省份。生成过地形的世界都划分过（生成时自动划一次）；只有还没生成地形的空白世界没有
  provinces: (w) => any(w.small.provinces),
  // 有自定义场
  fields: (w) => any(w.causes.fields),
  // 画过岛链（世界里没有记号，只在命令记录里）
  chains: (_w, commands) => hasOp(commands(), 'add_island_chain'),
  // 有画的河、定住的河，或放的湖
  drawnWater: (w) => w.small.guides.length > 0 || w.small.lakes.length > 0,
  // 手画过地形类别
  classPainted: (w) => anySet(w.causes.terrainClass),
  // 手画过资源
  resourcePainted: (w) => anySet(w.causes.resource),
  // 拖过发源地
  hearthMoved: (w) => !!w.small.human?.hearths.some((h) => h.locked),
  // 有自定义点
  points: (w) => any(w.small.points),
} satisfies Record<string, Sign>;

export type WorldSign = keyof typeof WORLD_SIGNS;

// 给人看的说法（帮助、文档里“世界里有……时自己露出来”）
export const SIGN_TEXT: Record<WorldSign, string> = {
  provinces: '划分过省份',
  fields: '有自定义场',
  chains: '画过岛链',
  drawnWater: '有画的河或放的湖',
  classPainted: '手画过地形类别',
  resourcePainted: '手画过资源',
  hearthMoved: '拖过发源地',
  points: '有自定义点',
};

export type Has = (sign: WorldSign) => boolean;

// 这个世界里有哪几样（没有世界时都没有）。commands：要看命令记录时才去拿（主线程手上的那一份；还没有时 null）。
// 看命令记录的那一问（岛链）按世界对象记着——界面上世界每变一步换一个对象，一个世界只扫一遍命令；
// 拿不到命令记录时不记，下次再问。别的几问都是看一眼就知道的，不记
const scanned = new WeakMap<World, Partial<Record<WorldSign, boolean>>>();
const FROM_LOG: ReadonlySet<WorldSign> = new Set<WorldSign>(['chains']);
export function signsOf(w: World | null, commands: () => readonly Command[] | null = () => null): Has {
  if (!w) return () => false;
  return (sign) => {
    if (!FROM_LOG.has(sign)) return WORLD_SIGNS[sign](w, commands);
    let memo = scanned.get(w);
    if (!memo) scanned.set(w, (memo = {}));
    const known = memo[sign];
    if (known !== undefined) return known;
    let list: readonly Command[] | null | undefined;
    const v = WORLD_SIGNS[sign](w, () => (list === undefined ? (list = commands()) : list));
    if (list !== null) memo[sign] = v;
    return v;
  };
}

// ---------- 露哪些 ----------

export interface MoreMark {
  // 只在完整界面里露（省略就是常用）
  more?: true;
  // 世界里已经有它对应的东西时自己露出来
  when?: WorldSign;
}

export interface SimpleView {
  // 是不是完整界面
  full: boolean;
  // 这一处点过“还有 N 个”展开着
  open: boolean;
}

export interface Split<T> {
  // 现在露着的（声明里的先后）
  shown: T[];
  // 现在藏着的：末尾的“还有 N 个”数的是它
  hidden: T[];
  // 展开着时：点“只留常用的”会藏起几个（0：没有可收的，不画那个按钮）
  foldable: number;
}

// 一排东西分成露着的和藏着的。kept：不是常用的，但现在也该露着（世界里有它的东西、正在用）
export function splitSimple<T>(items: readonly T[], view: SimpleView, isMore: (t: T) => boolean, kept: (t: T) => boolean = () => false): Split<T> {
  if (view.full) return { shown: [...items], hidden: [], foldable: 0 };
  const folded = items.filter((t) => isMore(t) && !kept(t));
  if (view.open) return { shown: [...items], hidden: [], foldable: folded.length };
  const drop = new Set(folded);
  return { shown: items.filter((t) => !drop.has(t)), hidden: folded, foldable: 0 };
}

// 带 more / when 的一项现在是不是“不常用、世界里也没有它的东西”
export const foldedBy = (m: MoreMark, has: Has): boolean => !!m.more && !(m.when && has(m.when));

// 一类工具在底部条上露哪些。list：这一类在这个世界里的全部工具（工具表里的先后，世界里用不上的已经去掉）；
// current：正拿着的工具（不常用也照常露着）
export function shownTools<T extends string>(list: readonly T[], mark: (id: T) => MoreMark, view: SimpleView, has: Has, current: T | null): Split<T> {
  return splitSimple(
    list,
    view,
    (id) => !!mark(id).more,
    (id) => id === current || !foldedBy(mark(id), has),
  );
}
