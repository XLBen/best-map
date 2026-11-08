// 地物的名字（第八十三轮从 core/features.ts 原样搬出）：带类型的河、湖、岛，起名，名字跟着地方走
import type { World, Derived, Guide, SmallState } from './world';
import type { GeoFeature, FeatureOverride } from './features-base';
import { PLAIN_RIVER, majorityType, type RiverType } from './river-types';
import { majorityLakeType, type LakeType } from './lake-types';
import { ISLAND_CODE_MASK, islandTypeOfCode, type IslandType } from './island-types';
import { type ResolvedStyle, type GenName, templateOf, chineseTemplate, templateName, styleFor, styleName, hasType } from './name-styles';
import { withOwnNames, hasLists, OWN_TYPE, speciesFeature } from './features-nature';
import { hashString } from './names';
import type { Species } from './species';

// ---------- 带类型的河（第三批） ----------

// 河的地物是哪一种河：标签里写上 rtype:类型 id。自然的河按它的格里多数是哪一种；画的河按它选的类型（没选时同自然的河）；
// 固定下来、没自己起名的自然河自己选了类型时不标：名字照固定之前的（选个类型不会让河改名）。
// 有标签、那种河有起名模板的河用模板起名，种子里带上类型，第二轮起名（见 assignNames）
const RTYPE = 'rtype:';
export function tagRiverType(world: World, d: Derived, f: GeoFeature, g?: Guide): void {
  const types = world.small.riverTypes;
  if (!types?.length || !d.riverType) return;
  let id: string | undefined;
  if (g?.type !== undefined) {
    if (g.type !== PLAIN_RIVER && !inherits(g)) id = types.find((t) => t.id === g.type)?.id;
  } else {
    const k = majorityType(d, f.cells);
    if (k >= 0) id = types[k].id;
  }
  // 标签数组可能是缓存里那一份（memoized 的输入）：换一份新的，不改它
  if (id !== undefined) f.tags = [...f.tags, `${RTYPE}${id}`];
}

// 地物的河流类型（有起名模板的才算）
function namedRiverType(f: GeoFeature, types: ReadonlyMap<string, RiverType>): RiverType | undefined {
  if (f.type !== 'river') return undefined;
  const tag = f.tags.find((t) => t.startsWith(RTYPE));
  const t = tag ? types.get(tag.slice(RTYPE.length)) : undefined;
  return t?.names ? t : undefined;
}

// ---------- 带类型的湖（第九轮） ----------

// 湖的地物是哪一种湖：标签里写上 ltype:类型 id（按它的格里多数是哪一种）。有起名模板的那种按模板起名，第二轮起名
const LTYPE = 'ltype:';
export function tagLakeType(world: World, d: Derived, f: GeoFeature): void {
  const types = world.small.lakeTypes;
  if (!types?.length) return;
  const k = majorityLakeType(d, f.cells);
  if (k >= 0) f.tags = [...f.tags, `${LTYPE}${types[k].id}`];
}

// 地物的湖泊类型（有起名模板的才算）
function namedLakeType(f: GeoFeature, types: ReadonlyMap<string, LakeType>): LakeType | undefined {
  if (f.type !== 'lake') return undefined;
  const tag = f.tags.find((t) => t.startsWith(LTYPE));
  const t = tag ? types.get(tag.slice(LTYPE.length)) : undefined;
  return t?.names ? t : undefined;
}

// ---------- 放的岛（第十四轮） ----------

// 岛的地物是哪一种放的岛：标签里写上 itype:类型 id（岛的格里超过一半是这一种自己的岛）。那种岛有起名模板时按模板起名，第二轮起名
const ITYPE = 'itype:';
export function tagIslandType(world: World, f: GeoFeature): void {
  const codes = world.causes.islandType;
  const count = new Map<number, number>();
  for (const c of f.cells) {
    const k = codes[c] & ISLAND_CODE_MASK;
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  for (const [k, c] of count) {
    if (c * 2 <= f.cells.length) continue;
    // 第三十轮：内置的几种也在世界里了，只给有起名模板的那种打标签（起名只看这个标签；内置的几种没有模板，与以前一样不打）
    const t = islandTypeOfCode(world.small, k);
    if (t?.names) f.tags = [...f.tags, `${ITYPE}${t.id}`];
    return;
  }
}

function namedIslandType(f: GeoFeature, types: ReadonlyMap<string, IslandType>): IslandType | undefined {
  if (f.type !== 'island') return undefined;
  const tag = f.tags.find((t) => t.startsWith(ITYPE));
  const t = tag ? types.get(tag.slice(ITYPE.length)) : undefined;
  return t?.names ? t : undefined;
}

// 固定下来的自然河：沿用那条河的地名键（nameKey）、自己没起名。它不是新的名字，就是原来那条河，
// 照原来的先后起名（名字与固定前一字不差），那条河改过的名字、换过的盐也照旧
const inherits = (g: Guide | undefined) => !!g && g.nameKey !== undefined && !g.name;

// ---------- 名字跟着地方走（第九轮） ----------
//
// 名字由“类型:锚点格”（键）加种子算出，撞名时先起名的拿走。只靠这些，名字会因为别处的改动而跳：
// 锚点格被涂掉、地物长大多出一格优先级更高的格（锚点挪了，键就换了）；新出来的地物排在前面，抢走了原有地物的名字，
// 后面的一串跟着换。所以每一步编辑之后，把这一步之后的地物与之前的配对（键相同的、否则同一种里格子重叠最多的），
// 配上了、起名的办法也没变、名字却变了的，留着原来的名字（keptNames）；用户改过的名字落不到地物上了（原锚点被盖掉），
// 就把那条改名挪到配上的地物的键上。这些记进那一步的命令（见 Engine），重放、重做时照用：名字只取决于原因与命令，
// 从头重放与一步一步编辑一字不差。留着的名字起名时最先占上，新出来的地物只能另起名字

// 留着的名字：ctx 是起名的办法（种子、文字包、换过几次、按哪个模板，见 assignNames）。办法变了（换了文字包、
// 重抽、换了生态或河流类型的模板）就不再用它，照常起名
export interface KeptName {
  name: string;
  ctx: string;
  // 名字的原文（第二十轮）：有原文的名字一起留
  orig?: string;
}

// 一步编辑之后为了名字不乱跳记下的：keep 地物的键 → 留着的名字（null：删掉那一条）；
// move 改过的名字（featureNames 的一条）从哪个键挪到哪个键
export interface NameCarry {
  keep?: Record<string, KeptName | null>;
  move?: Record<string, string>;
}

// 起名时每个地物的情况（区块除外）：key 名字跟着的键（留着的名字按它记；固定下来的自然河是那条河原来的键，
// 别的就是地物的键）；ctx 自动起名的办法（用户起的名字没有）；override 用上的 featureNames 的键
export interface NameMeta {
  key: string;
  ctx?: string;
  override?: string;
}

// 名字与原文写到地物上（没有原文时去掉这一项：同一个地物对象会被重复起名）
function setName(f: GeoFeature, name: string, orig: string | undefined) {
  f.name = name;
  if (orig) f.orig = orig;
  else delete f.orig;
}

// 按地名风格起名（第二十轮：每个地物的风格见 name-styles.ts 的 styleFor）；用户改过的名字优先，其次是留着的名字（keptNames），
// 其余重要的先起名。返回每个地物的情况（见 NameMeta）
export function assignNames(world: World, features: GeoFeature[]): Map<GeoFeature, NameMeta> {
  const overrides = world.small.featureNames;
  const byType = new Map<string, [number, FeatureOverride, string][]>();
  for (const [key, ov] of Object.entries(overrides)) {
    const [type, a] = key.split(':');
    const list = byType.get(type) ?? [];
    list.push([Number(a), ov, key]);
    byType.set(type, list);
  }
  const taken = new Set<string>();
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const regions = new Map(world.small.regions.map((r) => [r.id, r]));
  const species = new Map(world.small.species.map((sp) => [sp.id, sp]));
  const guides = new Map(world.small.guides.map((g) => [g.id, g]));
  // 带类型、有起名模板的河（第三批）
  const riverTypes = new Map((world.small.riverTypes ?? []).map((t) => [t.id, t]));
  // 带类型、有起名模板的湖（第九轮）
  const lakeTypes = new Map((world.small.lakeTypes ?? []).map((t) => [t.id, t]));
  // 放的岛的种类（第十四轮）
  const islandTypes = new Map((world.small.islandTypes ?? []).map((t) => [t.id, t]));
  const typed = (f: GeoFeature): RiverType | LakeType | IslandType | undefined =>
    (riverTypes.size ? namedRiverType(f, riverTypes) : undefined) ??
    (lakeTypes.size ? namedLakeType(f, lakeTypes) : undefined) ??
    (islandTypes.size ? namedIslandType(f, islandTypes) : undefined);
  // 画的河（固定下来的自然河除外）
  const drawn = (f: GeoFeature) => f.guide !== undefined && !inherits(guides.get(f.guide));
  // 新种类的地名：在原有的地名都起好之后第二轮再起，不会抢走原有地物的名字、引起一串换名。
  // 现在是涂出来的生态区、自带地名设定的生态自然长成的一片、画的河（固定下来的自然河除外）、带类型的河
  const secondPass = (f: GeoFeature) => f.species !== undefined || drawn(f) || typed(f) !== undefined;
  // 重要的先起名，同名时让给重要的；新种类的放在第二轮。第二轮里画的河按画的先后起名
  // （排在涂出来的生态区、自然长成的自带地名的一片、带类型的自然河之后）：
  // 自动起的河名只有几百个，常常撞名，按重要度排的话新画了一条大河、或者河的水量变了，先画的河就会换名
  const byImportance = (a: GeoFeature, b: GeoFeature) => b.importance - a.importance || a.key.localeCompare(b.key);
  const drawnAt = new Map(world.small.guides.map((g, k) => [g.id, k]));
  const second = features.filter(secondPass);
  const order = [
    ...features.filter((f) => !secondPass(f)).sort(byImportance),
    ...second.filter((f) => !drawn(f)).sort(byImportance),
    ...second.filter(drawn).sort((a, b) => drawnAt.get(a.guide!)! - drawnAt.get(b.guide!)!),
  ];
  // 按河流类型的模板起名（种子里带上类型：同一条河换成别的类型，名字也换）。模板是中文的：风格是音译式时用内置中文包的词表
  const typedName = (f: GeoFeature, t: RiverType | LakeType | IslandType, key: string, salt: number, rs: ResolvedStyle): GenName => {
    const own = t.names!;
    const pack = templateOf(rs.style, world.small);
    const p = withOwnNames(hasLists(pack, own) ? pack : chineseTemplate(world.small), t.name, own);
    return templateName(p, OWN_TYPE, f.tags, hashString(`${seed}:${key}:${t.id}:${salt}${rs.suffix}`), taken);
  };
  // 改过的名字落到哪个地物上：先找锚点相同的，再按上面的先后找包含原锚点的；每条只用一次
  // （森林被涂出一块别的生态时，名字留在锚点还在的那一边，不会两边都叫这个名字）
  const ovOf = new Map<GeoFeature, [FeatureOverride, string]>();
  // 固定下来的自然河用着的那条改名（不再落到别的地物上）。河道整条成了水、没有地物时不占，
  // 那条自然的河还在的话照旧用它
  const used = new Set<string>();
  for (const f of features) {
    const key = f.guide !== undefined ? guides.get(f.guide)?.nameKey : undefined;
    if (key !== undefined) used.add(key);
  }
  const match = (f: GeoFeature, ok: (a: number) => boolean) => {
    const hit = byType.get(f.type)?.find(([a, , key]) => !used.has(key) && ok(a));
    if (!hit) return;
    ovOf.set(f, [hit[1], hit[2]]);
    used.add(hit[2]);
  };
  for (const f of order) if (!f.region && !f.guide) match(f, (a) => a === f.anchor);
  for (const f of order) if (!f.region && !f.guide && !ovOf.has(f)) match(f, (a) => f.cells.includes(a));

  // 每个地物的地名风格（第二十轮）：自己选的（画的河、圈的地名按自己的键，固定下来的自然河也看原来那条河的；
  // 别的看落到它上面的改名）→ 世界默认 → 内置中文
  const ownOverride = (f: GeoFeature): FeatureOverride | undefined => {
    const g = f.guide !== undefined ? guides.get(f.guide) : undefined;
    if (g) return overrides[f.key] ?? (inherits(g) ? overrides[g.nameKey!] : undefined);
    return f.region ? overrides[f.key] : ovOf.get(f)?.[0];
  };
  const styleOf = (f: GeoFeature): ResolvedStyle => styleFor(world, { feature: f, override: ownOverride(f) ?? {} });
  // 起名的办法：种子、地名风格（内置中文时是旧的文字包）、换过几次（盐）、按哪个模板。哪一样变了，留着的名字就不再用
  const ctxOf = (rs: ResolvedStyle, salt: number, how: string) => hashString(`${seed}|${rs.tag}|${salt}|${how}`).toString(36);
  const typeHow = (t: RiverType | LakeType | IslandType) => `t:${hashString(JSON.stringify([t.id, t.name, t.names]))}`;
  const speciesHow = (sp: Species) => `s:${hashString(JSON.stringify([sp.id, sp.name, sp.terrain, sp.feature ?? null]))}`;
  // 每个地物怎么起名：用户起的名字（fixed），或者自动起名（gen，起名的办法 ctx）。区块没有 ctx（不留名字）
  // auto：改河时记下的自动名字（guide.autoName），照它叫，但不算用户起的名字
  type Plan = { fixed: string; orig?: string; auto?: boolean } | { gen: () => GenName; ctx?: string };
  const plan = (f: GeoFeature): Plan => {
    const g = f.guide !== undefined ? guides.get(f.guide) : undefined;
    if (g) {
      // 画的河：起了名就用；'' 按地名风格自动起（键是这条河道，固定的自然河是那条河原来的键）。
      // 只有 nameKey 的（固定下来、没自己起名的自然河）与原来那条河一样，那条河改过的名字也照旧
      const ov = inherits(g) && g.name === undefined ? overrides[g.nameKey!] : undefined;
      if (g.name) return { fixed: g.name };
      if (ov?.name) return { fixed: ov.name, orig: ov.orig };
      if (g.autoName) return { fixed: g.autoName, orig: g.autoOrig, auto: true };
      const rs = styleOf(f);
      const rt = typed(f);
      const key = g.nameKey ?? f.key;
      const salt = g.salt ?? ov?.salt ?? 0;
      // 起名的办法与自然的河相同：固定一条留着名字的自然河，名字照旧
      if (rt) return { gen: () => typedName(f, rt, key, salt, rs), ctx: ctxOf(rs, salt, typeHow(rt)) };
      return { gen: () => styleName(rs.style, f.type, f.tags, hashString(`${seed}:${key}:${salt}${rs.suffix}`), taken), ctx: ctxOf(rs, salt, `f:${f.type}`) };
    }
    const r = f.region ? regions.get(f.region) : undefined;
    if (r) {
      // 用户的区块：起了名就用，没起名按地名风格自动起（风格里没有这一类时按省份的模板）
      if (r.name) return { fixed: r.name };
      const rs = styleOf(f);
      const type = hasType(rs.style, f.type) ? f.type : 'province';
      return { gen: () => styleName(rs.style, type, f.tags, hashString(`${seed}:${f.key}:${r.salt}${rs.suffix}`), taken) };
    }
    const ov = ovOf.get(f)?.[0];
    if (ov?.name) return { fixed: ov.name, orig: ov.orig };
    const salt = ov?.salt ?? 0;
    const rs = styleOf(f);
    const sp = f.species !== undefined ? species.get(f.species) : undefined;
    const rt = typed(f);
    if (rt) return { gen: () => typedName(f, rt, f.key, salt, rs), ctx: ctxOf(rs, salt, typeHow(rt)) };
    if (sp) {
      // 涂出来的生态区、自然长成的自带地名的一片：模板按生态定，种子里带上生态（同一片格涂成别的生态，名字也换）
      const how = speciesFeature(sp).naming(rs.style, chineseTemplate(world.small));
      return {
        gen: () => styleName(how.pack, how.type, f.tags, hashString(`${seed}:${f.key}:${sp.id}:${salt}${rs.suffix}`), taken, how.species),
        ctx: ctxOf(rs, salt, speciesHow(sp)),
      };
    }
    return { gen: () => styleName(rs.style, f.type, f.tags, hashString(`${seed}:${f.key}:${salt}${rs.suffix}`), taken), ctx: ctxOf(rs, salt, `f:${f.type}`) };
  };
  const plans = order.map(plan);
  // 名字跟着的键：固定下来的自然河跟着那条河原来的键
  const keyOf = (f: GeoFeature) => {
    const g = f.guide !== undefined ? guides.get(f.guide) : undefined;
    return g && inherits(g) ? g.nameKey! : f.key;
  };
  const meta = new Map<GeoFeature, NameMeta>();
  order.forEach((f, k) => {
    if (f.region && regions.has(f.region)) return;
    const p = plans[k];
    const override = ovOf.get(f)?.[1];
    meta.set(f, 'fixed' in p ? { key: keyOf(f), override } : { key: keyOf(f), ctx: p.ctx, override });
  });
  // 改河时记下的名字最先占上：这条河一直叫它，别的地物（比如改道后剩下的旧河道）另起名字
  plans.forEach((p) => {
    if ('fixed' in p && p.auto) taken.add(p.fixed);
  });
  // 留着的名字最先占上（起名的办法没变的才算；同一个名字只给先排到的那个）
  const kept = world.small.keptNames;
  const keptOf = new Map<GeoFeature, KeptName>();
  if (kept) {
    order.forEach((f, k) => {
      const p = plans[k];
      const e = kept[keyOf(f)];
      if (!e || 'fixed' in p || p.ctx === undefined || e.ctx !== p.ctx || taken.has(e.name)) return;
      keptOf.set(f, e);
      taken.add(e.name);
    });
  }
  // 自己写的类型字：画的河写在河道上（固定下来、没自己写过的自然河照旧用那条河改过的），圈的地名写在区块上，别的跟着改过的名字
  order.forEach((f) => {
    const g = f.guide !== undefined ? guides.get(f.guide) : undefined;
    const r = f.region ? regions.get(f.region) : undefined;
    const label = g ? (g.label ?? (inherits(g) ? overrides[g.nameKey!]?.label : undefined)) : r ? r.label : ovOf.get(f)?.[0].label;
    if (label) f.label = label;
    else delete f.label;
    // 删掉的地名同理：画的河写在河道上，别的跟着改过的名字（圈的地名直接删掉区块，没有这一项）
    const hidden = g ? (g.hidden ?? (inherits(g) ? overrides[g.nameKey!]?.hidden : undefined)) : r ? undefined : ovOf.get(f)?.[0].hidden;
    if (hidden) f.hidden = true;
    else delete f.hidden;
    // 自己选的地名风格（不是世界默认、还在世界里的）：界面上的“风格”读它
    const rs = styleOf(f);
    if (rs.suffix) f.style = rs.id;
    else delete f.style;
  });
  order.forEach((f, k) => {
    const p = plans[k];
    if ('fixed' in p) {
      setName(f, p.fixed, p.orig);
      f.custom = !p.auto;
      taken.add(p.fixed);
      return;
    }
    f.custom = false;
    const e = keptOf.get(f);
    if (e) setName(f, e.name, e.orig);
    else {
      const n = p.gen();
      setName(f, n.zh, n.orig);
    }
  });
  return meta;
}

// 改这个地物的类型字（第十四轮）该写在 featureNames 的哪个键上：已经有落到它上面的改动（改过的名字、换过的盐；
// 锚点挪了、按包含原锚点落上来的也算）就写进那一条，免得在它自己的键上另起一条、把原来那条顶掉；没有时是它自己的键。
// 只用于自然形成的地物（画的河、圈的地名写在河道、区块上）
export function overrideKeyOf(world: World, f: GeoFeature): string {
  const list = world.derived.features;
  const at = list.findIndex((x) => x.key === f.key);
  if (at < 0) return f.key;
  const copies = list.map((x) => ({ ...x }));
  return assignNames(world, copies).get(copies[at])?.override ?? f.key;
}

// 配对：这一步之前的地物 prev 与之后的 cur（名字跟着的键见 NameMeta，区块没有）。先配键相同的（同一种），
// 剩下的在同一种里（类型、生态相同；画的河只按键）按重叠的格数从多到少配，重叠要占两者中小的那个的一半以上
// （岛长大了、海被切掉一角、森林中间被涂掉一块都还是原来那个）。每个地物最多配一次。
// 区块不配（名字跟着区块走，本来就不跳）。返回 [prev 的下标, cur 的下标]
function pairFeatures(prev: GeoFeature[], prevKeys: (string | undefined)[], cur: GeoFeature[], curKeys: (string | undefined)[]): [number, number][] {
  // 画的河自成一种（固定下来的自然河与自然的河同一种）
  const kind = (f: GeoFeature, key: string | undefined) => (f.guide !== undefined && key === f.key ? `g:${f.key}` : `${f.type}|${f.species ?? ''}`);
  const pairs: [number, number][] = [];
  const oldAt = new Map<string, number>();
  prev.forEach((_, i) => {
    const key = prevKeys[i];
    if (key !== undefined && !oldAt.has(key)) oldAt.set(key, i);
  });
  const usedOld = new Uint8Array(prev.length);
  const usedNew = new Uint8Array(cur.length);
  cur.forEach((f, j) => {
    const key = curKeys[j];
    if (key === undefined) return;
    const i = oldAt.get(key);
    if (i === undefined || usedOld[i] || kind(prev[i], prevKeys[i]) !== kind(f, key)) return;
    pairs.push([i, j]);
    usedOld[i] = 1;
    usedNew[j] = 1;
  });
  // 没配上的旧地物：每格属于哪几个
  const owners = new Map<number, number[]>();
  prev.forEach((f, i) => {
    if (usedOld[i] || prevKeys[i] === undefined || f.guide !== undefined) return;
    for (const c of f.cells) {
      const list = owners.get(c);
      if (list) list.push(i);
      else owners.set(c, [i]);
    }
  });
  const cand: [number, number, number][] = [];
  cur.forEach((f, j) => {
    if (usedNew[j] || curKeys[j] === undefined || f.guide !== undefined) return;
    const k = kind(f, curKeys[j]);
    const count = new Map<number, number>();
    for (const c of f.cells) for (const i of owners.get(c) ?? []) if (kind(prev[i], prevKeys[i]) === k) count.set(i, (count.get(i) ?? 0) + 1);
    for (const [i, n] of count) if (n * 2 >= Math.min(prev[i].cells.length, f.cells.length)) cand.push([n, i, j]);
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  cand.sort((a, b) => b[0] - a[0] || cmp(prev[a[1]].key, prev[b[1]].key) || cmp(cur[a[2]].key, cur[b[2]].key));
  for (const [, i, j] of cand) {
    if (usedOld[i] || usedNew[j]) continue;
    pairs.push([i, j]);
    usedOld[i] = 1;
    usedNew[j] = 1;
  }
  return pairs;
}

// 留着的名字：原文（第二十轮）一起留，没有原文时不写这一项
const keptName = (f: GeoFeature, ctx: string): KeptName => (f.orig ? { name: f.name, ctx, orig: f.orig } : { name: f.name, ctx });

// 这一步要记下什么才能让名字不乱跳（见本节开头）：world、features 是这一步之后的世界与地物（名字已按 world 起好），
// prevSmall、prev 是这一步之前的小数据与地物。没有要记的时返回 null。只看这些参数，结果是确定的。
// 换了生成的种子（整个世界重新生成）时不留：名字本来就该全换
export function carryNames(world: World, features: GeoFeature[], prevSmall: SmallState, prev: GeoFeature[]): NameCarry | null {
  const seedOf = (s: SmallState) => s.terrain.gen?.seed ?? world.settings.seed;
  if (!prev.length || !features.length || seedOf(prevSmall) !== seedOf(world.small)) return null;
  // 之前的名字与起名的情况（按之前的小数据重新起一遍：与当时起的一字不差）
  const old = prev.map((f) => ({ ...f }));
  const oldMeta = assignNames({ ...world, small: prevSmall }, old);
  const small: SmallState = { ...world.small, featureNames: { ...world.small.featureNames }, keptNames: { ...world.small.keptNames } };
  const kept = small.keptNames!;
  const scratch: World = { ...world, small };
  const first = features.map((f) => ({ ...f }));
  const firstMeta = assignNames(scratch, first);
  const curKeys = first.map((f) => firstMeta.get(f)?.key);
  const pairs = pairFeatures(
    old,
    old.map((f) => oldMeta.get(f)?.key),
    features,
    curKeys,
  );
  const keep: Record<string, KeptName | null> = {};
  const move: Record<string, string> = {};
  // 这一步里没了的自然的河（放了湖、水被引走，水少到不再标，或者挤出了标注的前几十条）：自动起的名字按它的键留着。
  // 以后同一条河（键相同）又出来时照旧叫它，不会因为大小的标签变了换个名字（比如放了湖之后出湖的河不标了，
  // 再画一条河流进湖里，出湖的河又标出来）
  const paired = new Set(pairs.map(([i]) => i));
  const present = new Set(curKeys);
  old.forEach((o, i) => {
    if (o.type !== 'river' || o.guide !== undefined || o.custom || paired.has(i)) return;
    const om = oldMeta.get(o);
    if (!om?.ctx || present.has(om.key)) return;
    const e = kept[om.key];
    if (e && e.name === o.name && e.ctx === om.ctx) return;
    kept[om.key] = keep[om.key] = keptName(o, om.ctx);
  });
  if (!pairs.length) return Object.keys(keep).length ? { keep } : null;
  // 留下一些名字之后，别的地物可能跟着换（原来撞名退到后面的名字现在空出来了）：再看一遍，直到没有新的要留
  for (let round = 0; round < 16; round++) {
    const cur = features.map((f) => ({ ...f }));
    const meta = assignNames(scratch, cur);
    const usedOv = new Set<string>();
    for (const m of meta.values()) if (m.override !== undefined) usedOv.add(m.override);
    let more = false;
    for (const [i, j] of pairs) {
      const o = old[i];
      const f = cur[j];
      if (f.custom || f.name === o.name) continue;
      const om = oldMeta.get(o);
      const fm = meta.get(f);
      // 改过的名字、换过的盐落不到这个地物上了（原锚点被盖掉、挪到了别处）：那一条挪到这个地物的键上
      const from = om?.override;
      if (from !== undefined && fm?.override === undefined && f.guide === undefined && !usedOv.has(from) && small.featureNames[from] && !small.featureNames[f.key] && !(from in move)) {
        small.featureNames[f.key] = small.featureNames[from];
        delete small.featureNames[from];
        move[from] = f.key;
        usedOv.add(from);
        more = true;
        continue;
      }
      // 自动起的名字：起名的办法没变就留着原来的名字（已经留着、但被排在前面的占了的，不再留）
      if (o.custom || om?.ctx === undefined || fm?.ctx !== om.ctx) continue;
      const e = kept[fm.key];
      if (e && e.name === o.name && e.ctx === fm.ctx) continue;
      kept[fm.key] = keep[fm.key] = keptName(o, fm.ctx);
      more = true;
    }
    if (!more) break;
  }
  // 换了键的地物：原来的键上留着的名字不再用（那个键以后又出现时照常起名，不会与这里重名）
  const keys = new Set(curKeys);
  for (const [i, j] of pairs) {
    const k = oldMeta.get(old[i])?.key;
    if (k !== undefined && k !== curKeys[j] && !keys.has(k) && kept[k] && !(k in keep)) keep[k] = null;
  }
  const out: NameCarry = {};
  if (Object.keys(keep).length) out.keep = keep;
  if (Object.keys(move).length) out.move = move;
  return out.keep || out.move ? out : null;
}

// 把记下的（见 carryNames）用到小数据上：先挪改过的名字，再改留着的名字
export function applyNameCarry(small: SmallState, carry: NameCarry) {
  if (carry.move) {
    const names = { ...small.featureNames };
    for (const [from, to] of Object.entries(carry.move)) {
      const ov = names[from];
      if (!ov || names[to]) continue;
      names[to] = ov;
      delete names[from];
    }
    small.featureNames = names;
  }
  if (carry.keep) {
    const kept = { ...small.keptNames };
    for (const [key, e] of Object.entries(carry.keep)) {
      if (e) kept[key] = e;
      else delete kept[key];
    }
    if (Object.keys(kept).length) small.keptNames = kept;
    else delete small.keptNames;
  }
}

// 同一步记了两次（命令里已经记着、执行时又记了一些）：合在一起，后记的说了算
export function mergeNameCarry(a: NameCarry | undefined, b: NameCarry): NameCarry {
  if (!a) return b;
  const out: NameCarry = {};
  if (a.keep || b.keep) out.keep = { ...a.keep, ...b.keep };
  if (a.move || b.move) out.move = { ...a.move, ...b.move };
  return out;
}
