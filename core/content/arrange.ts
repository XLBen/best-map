// 融入（第六十轮）：一个库里“这种内容融入哪种”。只改资源库面板怎么显示，不改生成：运行时的数据还是平的，
// 谁属于谁一直由内容自己写着（文化的 group、政体的 factions、地标的 cultureGroups……），这里只是把它们读出来。
//
//   arrange = { 下级: 上级 }，写了就是完整的一张（没写到的种类单独成卡）；库里没有这个字段时用内置的预设。
//   下级是内容种类的 id；变量不是一种内容（写在时代里），用 'variables'。
//
// 哪些组合讲得通写在 RELATIONS：每一条说明怎么读出“这一项下面有哪些”、怎么加、怎么移出。没写的组合不接受。
// 只有一层（上级不能再融入别的），所以不会绕成圈。这里不引用登记表：parsePack 用它查格式，界面用它算下面有哪些

export type Arrange = Readonly<Record<string, string>>;

type Obj = Record<string, unknown>;
export type ItemsOf = (kindId: string) => readonly unknown[];

// 加、移出要改的那一项（parent 改上级自己，child 改下级自己）
export interface LinkEdit {
  side: 'parent' | 'child';
  next: Obj;
}

export interface ArrangeRelation {
  child: string;
  parent: string;
  // [上级 id, 下级 id]，按读到的先后
  links(items: ItemsOf): (readonly [string, string])[];
  // 把这一项加到上级下面（改的是内容本身）。null：不能在这里加
  link?(parent: Obj, child: Obj): LinkEdit;
  // 移出。null：不能移出（比如这个地名风格是某个文化写的，不是组写的）
  unlink?(parent: Obj, child: Obj): LinkEdit | null;
  // 这一项能不能加到这个上级下面（取值要同一维）
  fits?(parent: Obj, child: Obj): boolean;
  // 新建时从什么样子开始（省略时就是 link 之后的样子）
  fresh?(parent: Obj, blank: Obj): Obj;
  // 上级自己有一个字段写着它：融入后页面上不再列这个字段，由“下面的”这一段代替
  parentField?: string;
  // 只能换上级，不能没有上级（文化必须有组）
  moveOnly?: boolean;
  // 不属于任何上级的还留一张卡片（地标：不属于任何组的在“城市与地标”）；别的在上级的列表最后一段
  looseCard?: boolean;
  // 移出后会怎样（写在悬停里）
  unlinkNote?: string;
}

const idOf = (x: unknown): string => String((x as { id?: unknown }).id);
const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

function withList(item: Obj, key: string, next: readonly string[]): Obj {
  const out = { ...item };
  if (next.length) out[key] = [...next];
  else delete out[key];
  return out;
}

export const RELATIONS: readonly ArrangeRelation[] = [
  {
    child: 'culture',
    parent: 'cultureGroup',
    moveOnly: true,
    links: (items) => items('culture').map((c) => [String((c as Obj).group), idOf(c)] as const),
    link: (p, c) => ({ side: 'child', next: { ...c, group: p.id } }),
  },
  {
    child: 'nameStyle',
    parent: 'cultureGroup',
    parentField: 'nameStyle',
    // 组写的在前，组里的文化写的在后
    links: (items) => [
      ...items('cultureGroup').flatMap((g) => ((g as Obj).nameStyle ? [[idOf(g), String((g as Obj).nameStyle)] as const] : [])),
      ...items('culture').flatMap((c) => ((c as Obj).nameStyle ? [[String((c as Obj).group), String((c as Obj).nameStyle)] as const] : [])),
    ],
    link: (p, c) => ({ side: 'parent', next: { ...p, nameStyle: c.id } }),
    unlink: (p, c) => {
      if (p.nameStyle !== c.id) return null;
      const { nameStyle: _, ...rest } = p;
      return { side: 'parent', next: rest };
    },
  },
  {
    child: 'landmarkType',
    parent: 'cultureGroup',
    looseCard: true,
    unlinkNote: '一个组也不写时，每个组都能有',
    links: (items) => items('landmarkType').flatMap((l) => list((l as Obj).cultureGroups).map((g) => [g, idOf(l)] as const)),
    link: (p, c) => ({ side: 'child', next: { ...c, cultureGroups: [...list(c.cultureGroups), String(p.id)] } }),
    unlink: (p, c) => ({ side: 'child', next: withList(c, 'cultureGroups', list(c.cultureGroups).filter((g) => g !== p.id)) }),
  },
  {
    child: 'landmarkType',
    parent: 'government',
    looseCard: true,
    unlinkNote: '写的是政体的类别：同一类的政体一起变',
    links: (items) => {
      const out: (readonly [string, string])[] = [];
      for (const g of items('government')) for (const l of items('landmarkType')) if (list((l as Obj).governments).includes(String((g as Obj).category))) out.push([idOf(g), idOf(l)]);
      return out;
    },
    link: (p, c) => ({ side: 'child', next: { ...c, governments: [...list(c.governments), String(p.category)] } }),
    unlink: (p, c) => ({ side: 'child', next: withList(c, 'governments', list(c.governments).filter((g) => g !== p.category)) }),
  },
  {
    child: 'popValue',
    parent: 'valueGroup',
    links: (items) => items('popValue').flatMap((v) => ((v as Obj).group ? [[String((v as Obj).group), idOf(v)] as const] : [])),
    fits: (p, c) => p.dimension === c.dimension,
    fresh: (p, blank) => ({ ...blank, dimension: p.dimension, group: p.id }),
    link: (p, c) => ({ side: 'child', next: { ...c, group: p.id } }),
    unlink: (_, c) => {
      const { group: __, ...rest } = c;
      return { side: 'child', next: rest };
    },
  },
  {
    child: 'variables',
    parent: 'era',
    links: (items) => items('era').flatMap((e) => ((e as { dimensions?: { id: string }[] }).dimensions ?? []).map((d) => [idOf(e), d.id] as const)),
  },
  {
    child: 'faction',
    parent: 'government',
    parentField: 'factions',
    links: (items) => items('government').flatMap((g) => list((g as Obj).factions).map((f) => [idOf(g), f] as const)),
    link: (p, c) => ({ side: 'parent', next: { ...p, factions: [...list(p.factions), String(c.id)] } }),
    unlink: (p, c) => ({ side: 'parent', next: withList(p, 'factions', list(p.factions).filter((f) => f !== c.id)) }),
  },
  {
    child: 'resource',
    parent: 'terrainClass',
    // 长在哪里是几条规则，在资源自己的页面上改：这里只列
    links: (items) => items('resource').flatMap((r) => ((r as Obj).rules as { classes?: string[] }[] | undefined ?? []).flatMap((rule) => (rule.classes ?? []).map((t) => [t, idOf(r)] as const))),
  },
];

// 内置的库都用这一张（内置的包里不写，所以金标准、库的摘要都不变）
export const PRESET_ARRANGE: Arrange = {
  culture: 'cultureGroup',
  nameStyle: 'cultureGroup',
  landmarkType: 'cultureGroup',
  popValue: 'valueGroup',
  variables: 'era',
  faction: 'government',
};

export const relationOf = (child: string, parent: string): ArrangeRelation | undefined => RELATIONS.find((r) => r.child === child && r.parent === parent);
export const canMerge = (child: string, parent: string): boolean => !!relationOf(child, parent);
// 这一种能融入哪几种
export const parentsFor = (child: string): string[] => RELATIONS.filter((r) => r.child === child).map((r) => r.parent);

// 库的安排（没写时预设）
export const arrangeOf = (pack: { arrange?: Arrange } | null | undefined): Arrange => pack?.arrange ?? PRESET_ARRANGE;

// 按表的先后写，文件里的样子不随点的先后变
function ordered(a: Arrange): Arrange {
  const out: Record<string, string> = {};
  for (const r of RELATIONS) if (a[r.child] === r.parent) out[r.child] = r.parent;
  return out;
}

export const sameArrange = (a: Arrange, b: Arrange): boolean => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

export const mergeInto = (a: Arrange, child: string, parent: string): Arrange => (canMerge(child, parent) ? ordered({ ...a, [child]: parent }) : a);

export function splitOut(a: Arrange, child: string): Arrange {
  const { [child]: _, ...rest } = a;
  return ordered(rest);
}

// 换了安排的库。和预设一样时不写这个字段，别的字段一个不动
export function withArrange<T extends object>(pack: T, a: Arrange): T {
  const { arrange: _, ...rest } = pack as T & { arrange?: Arrange };
  return (sameArrange(a, PRESET_ARRANGE) ? rest : { ...rest, arrange: ordered(a) }) as T;
}

// 文件里写错的组合（parsePack 严格检查，出错时整个文件读不进来，和别的不认识的部分一样）
export function arrangeProblems(a: Arrange): string[] {
  return Object.entries(a).flatMap(([child, parent]) => (canMerge(child, parent) ? [] : [`融入的安排：${child} 不能融入 ${parent}`]));
}

// ---------- 这一项下面有哪些 ----------

export interface LinkTable {
  byParent: Map<string, string[]>;
  byChild: Map<string, string[]>;
}

export function linkTable(rel: ArrangeRelation, items: ItemsOf): LinkTable {
  const byParent = new Map<string, string[]>();
  const byChild = new Map<string, string[]>();
  for (const [p, c] of rel.links(items)) {
    const a = byParent.get(p);
    if (!a) byParent.set(p, [c]);
    else if (!a.includes(c)) a.push(c);
    const b = byChild.get(c);
    if (!b) byChild.set(c, [p]);
    else if (!b.includes(p)) b.push(p);
  }
  return { byParent, byChild };
}

// 下级的种类里有哪些（变量写在时代里）
function pool(child: string, items: ItemsOf): readonly unknown[] {
  return child === 'variables' ? items('era').flatMap((e) => (e as { dimensions?: unknown[] }).dimensions ?? []) : items(child);
}

export interface Children {
  relation: ArrangeRelation;
  items: unknown[];
}

// 这一项下面有哪些：融入到这种内容的每一种下级一段。多个上级的项（地标）每个上级下面都有；写到了但这一份里没有的不列
export function childrenOf(arrange: Arrange, parentKind: string, parent: unknown, items: ItemsOf, table: (r: ArrangeRelation) => LinkTable = (r) => linkTable(r, items)): Children[] {
  const out: Children[] = [];
  for (const relation of RELATIONS) {
    if (relation.parent !== parentKind || arrange[relation.child] !== parentKind) continue;
    const ids = table(relation).byParent.get(idOf(parent));
    const byId = new Map(pool(relation.child, items).map((x) => [idOf(x), x]));
    out.push({ relation, items: (ids ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)] : [])) });
  }
  return out;
}

// 这一项在哪几个上级下面（上级要在这一份里）
export function parentsOf(rel: ArrangeRelation, child: unknown, items: ItemsOf, table: LinkTable = linkTable(rel, items)): unknown[] {
  const ids = table.byChild.get(idOf(child));
  if (!ids) return [];
  const byId = new Map(items(rel.parent).map((x) => [idOf(x), x]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
}

// 不属于这一份里任何上级的项
export function looseItems(rel: ArrangeRelation, items: ItemsOf, table: LinkTable = linkTable(rel, items)): unknown[] {
  const parents = new Set(items(rel.parent).map(idOf));
  return pool(rel.child, items).filter((x) => !table.byChild.get(idOf(x))?.some((p) => parents.has(p)));
}
