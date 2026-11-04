import type { World } from '../world';
import type { ContentWorld } from './registry';
import { type ContentRef, unusedPeople } from './unused';

// 生成后没用到的内容（第六十二轮）：面板上变淡的就是这些，“清理没用到的”清的也是这些，两边只调这一个函数。
// 判断本身是 unused.ts 的 unusedPeople（和以前的整理同一份规则），这里只定范围：
//
//   看的种类：时代、取值、取值组、文化、文化组、地名风格，有国家时还有政体、派系。
//   还没生成的不算：没有人文时什么都不算（导入了还没生成的内容不该变淡），没有国家时政体、派系不算。
//   生态、河、湖不算：它们按条件长出来，现在一格都没有（这个世界没有火山口湖），改一笔之后可能就有了；清掉了就再也不会出现。
//   画风不算：不是生成用到的，是“图层”里换的选项。地形类别、资源、城市等级、地标、点、国家等级和格局：unusedPeople 本来就不看。
//   要清这些，到这一项的页面上“移出本世界”。
//
// 列表每次渲染都要用，所以先把人口压小：谁有人只要知道一次。unusedPeople 每一项都要扫一遍人口（4 万格、404 个文化约 6400 万次），
// 这里一个文化、一个取值只留一格，判断不变（测试拿没压的 unusedContent 逐项对照）。国家、省份的格是定位用的，不影响判断，不带

type Tuples = NonNullable<World['small']['popGroups']>;

// 这几个位置上有人的群体，里面有哪些文化、取值
function peopleIn(tuples: Tuples, groups: Uint16Array | undefined, shares: Uint8Array | undefined): { cultures: Set<string>; values: Set<string> } {
  const seen = new Uint8Array(65536);
  if (groups && shares) for (let k = 0; k < groups.length; k++) if (groups[k] && shares[k]) seen[groups[k]] = 1;
  const cultures = new Set<string>();
  const values = new Set<string>();
  for (const key in tuples) {
    if (!seen[Number(key)]) continue;
    const t = tuples[key];
    cultures.add(t.culture);
    for (const v of Object.values(t.values)) values.add(v);
  }
  return { cultures, values };
}

function compactPeople(world: ContentWorld): ContentWorld {
  const { small, causes } = world;
  const tuples = small.popGroups;
  if (!tuples) return { small, causes: { fields: {} } as unknown as World['causes'] };
  const list: Tuples = {};
  const slot = new Map<string, number>();
  let next = 1;
  const add = (key: string, make: () => Tuples[string]): number => {
    let at = slot.get(key);
    if (at === undefined) {
      at = next++;
      slot.set(key, at);
      list[at] = make();
    }
    return at;
  };
  // 一个文化、一个取值一条
  const pressed = ({ cultures, values }: { cultures: Set<string>; values: Set<string> }) => [
    ...[...cultures].map((c) => add(`c:${c}`, () => ({ culture: c, values: {} }))),
    ...[...values].map((v) => add(`v:${v}`, () => ({ culture: '\u0000', values: { v } }))),
  ];
  const live = pressed(peopleIn(tuples, causes.popGroup, causes.popShare));
  const auto = pressed(peopleIn(tuples, causes.popAutoGroup, causes.popAutoShare));
  // 人口一格四个位置，只用第一个
  const popGroup = new Uint16Array(live.length * 4);
  const popShare = new Uint8Array(live.length * 4);
  live.forEach((g, k) => {
    popGroup[k * 4] = g;
    popShare[k * 4] = 1;
  });
  return {
    small: { ...small, popGroups: list },
    causes: { fields: {}, popGroup, popShare, popAutoGroup: Uint16Array.from(auto), popAutoShare: new Uint8Array(auto.length).fill(1) } as unknown as World['causes'],
  };
}

const GOV_KINDS: ReadonlySet<string> = new Set(['government', 'faction']);

export function cleanableContent(world: ContentWorld): ContentRef[] {
  const h = world.small.human;
  if (!h) return [];
  const list = unusedPeople(compactPeople(world));
  return h.countryRules ? list : list.filter((r) => !GOV_KINDS.has(r.kind));
}

// 查“这一项是不是”（列表上一行一行问）：一个世界算一遍
const memo = new WeakMap<object, Set<string>>();
export function cleanableSet(world: ContentWorld): ReadonlySet<string> {
  let s = memo.get(world);
  if (!s) memo.set(world, (s = new Set(cleanableContent(world).map((r) => `${r.kind}\u0000${r.id}`))));
  return s;
}
export const isCleanable = (set: ReadonlySet<string>, kind: string, id: string): boolean => set.has(`${kind}\u0000${id}`);

export type { ContentRef };
