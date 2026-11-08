import { guideBody, guideLine } from './rivers';
import { biomeGroupOf } from './species';
import type { Derived, Guide, RegionKind, World } from './world';
import { type FeatureType, FEATURE_INFO, REGION_KIND_INFO, type GeoFeature, stableAnchor, unwrapped, wrapX, wrapDelta, axis, tagsOf, type AddInput, areaOf, innermost } from './features-base';
import { memoized, NO_FRAGMENT, terrainInputs, lakeIslandInputs, lakeInputs, riverInputs, terrainSlope, reliefInputs } from './features-terrain';
import { biomesOf, speciesFeature, speciesKey, paintedOf, ownOf, natureInputs } from './features-nature';
import { tagRiverType, tagLakeType, tagIslandType, assignNames } from './features-names';
export { FEATURE_TYPES, FEATURE_INFO, REGION_KIND_INFO, unwrapped, axis } from './features-base';
export type { FeatureType, GeoFeature, FeatureOverride, AddInput } from './features-base';
export { featureMemo, prepareFeatures, ISLET_FRAG, lakeIslandInputs, riverInputs, nearMax } from './features-terrain';
export { namesNaturally } from './features-nature';
export { assignNames, overrideKeyOf, carryNames, applyNameCarry, mergeNameCarry } from './features-names';
export type { KeptName, NameCarry, NameMeta } from './features-names';

// 地理要素识别：在格图上找出大陆、岛、群岛、半岛、海、洋、湾、海峡、湖、大河、山脉、主峰、
// 高原、平原、盆地、荒漠、森林、苔原、冰盖、沼泽湿地、涂出来的生态区，按文字包起名。
// 是推导层：每次地形或气候变化后重算。新地物的名字由“类型 + 锚点格（见 stableAnchor）+ 种子”确定；
// 用户改过的名字先按“同类型、同锚点”、再按“同类型、包含原锚点”匹配到重算后的要素上。
// 编辑之后原有的地物照旧叫原来的名字（锚点挪了、被新地物抢了名字也一样），见 features-names.ts 的“名字跟着地方走”。

// terrain：没挖河床的地形（引擎里自然求解的高程）。山脉、山峰、高原、平原、盆地、湖的高低和“高”这个标签都按它认，
// 所以画一条峡谷不会让山改名；省略时用推导的高程（没有只挖河床的河时两者逐值相同）
export function detectFeatures(world: World, d: Derived, terrain: Float32Array = d.elevation): GeoFeature[] {
  const { mesh, causes, small, kmPerUnit } = world;
  const globe = mesh.kind === 'sphere';
  const out: GeoFeature[] = [];

  const climateTags = (cells: Int32Array) => tagsOf(world, d, cells, terrain);

  const add = (type: FeatureType, cells: Int32Array, importance: number, extraTags: string[] = [], anchor?: number) => {
    if (!cells.length) return;
    const a = anchor ?? stableAnchor(cells);
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    out.push({
      key: `${type}:${a}`,
      type,
      anchor: a,
      cells: cells.slice(),
      areaKm2: areaOf(world, cells),
      x: ax.x,
      y: ax.y,
      angle: ax.angle,
      span: ax.span,
      tags: [...new Set([...climateTags(cells), ...extraTags])],
      importance,
      name: '',
      custom: false,
    });
  };

  // 按记下的输入逐个 add
  const replay = (list: AddInput[]) => {
    for (const a of list) {
      let tags = a.tags;
      if (a.mark === 'islet') {
        let maxH = 0;
        for (const c of a.cells) maxH = Math.max(maxH, terrain[c]);
        if (maxH > 1400) tags = [...tags, 'volcanic'];
      }
      const before = out.length;
      add(a.type, a.cells, a.importance, tags, a.anchor);
      if (out.length === before) continue;
      const f = out[before];
      if (a.species !== undefined) f.species = small.species[a.species].id;
      if (a.labelCell !== undefined) {
        f.x = mesh.x[a.labelCell];
        f.y = mesh.y[a.labelCell];
      }
      if (a.mark === 'peak') {
        f.x = mesh.x[a.cells[0]];
        f.y = mesh.y[a.cells[0]];
      } else if (a.mark === 'river') {
        // 标注沿河中段
        const line = Array.from(a.cells, (s) => [mesh.x[s], mesh.y[s]] as [number, number]).reverse();
        // 整个星球：沿河展开经度，跨过接缝的河也是连续的一条线
        if (globe) for (let k = 1; k < line.length; k++) line[k][0] = line[k - 1][0] + wrapDelta(line[k][0] - line[k - 1][0]);
        f.line = line;
        const mid = Math.floor(line.length / 2);
        f.x = globe ? wrapX(line[mid][0]) : line[mid][0];
        f.y = line[mid][1];
      }
    }
  };

  // 各段按它实际读的数组缓存（数值放进 Float64Array）；段的先后就是地物的先后
  const km = Float64Array.of(kmPerUnit);
  const coast = memoized(mesh, 'terrain', [causes.land, km, causes.fragment ?? NO_FRAGMENT], () => terrainInputs(world));
  replay(coast.list);
  replay(memoized(mesh, 'lake', [d.lake, terrain, km], () => lakeInputs(world, d, terrain)));
  replay(memoized(mesh, 'lake-island', [causes.land, d.lake, km], () => lakeIslandInputs(world, d)));
  const rivers = memoized(mesh, 'river', [causes.land, d.receiver, d.discharge, d.lake, Float64Array.of(small.planet.riverThreshold)], () => riverInputs(world, d));
  // 有名字的画的河占了的自然大河不再单独标（同一条河只标一次）；没有这种河时照旧
  const named = namedGuideCells(world, d);
  replay(named ? rivers.flatMap((a) => uncovered(world, d, a, named)) : rivers);
  // 坡度由地形、陆海算出，所以不进键（只在这一段要重算时才取）
  replay(memoized(mesh, 'relief', [causes.land, d.lake, terrain, km], () => reliefInputs(world, d, coast.dLand, terrain, terrainSlope(world, d, terrain))));
  const biome = biomesOf(world, d);
  // 没涂过生态时只看大类（与原来相同）；涂过时还要看涂了什么、每格的主导生态、陆海与每种生态的样子。
  // 有自带地名设定的生态自然长成的格时（第三批）另走一段、另记缓存：没有这样的格的世界与以前完全一样
  const painted = paintedOf(world, d);
  const own = ownOf(world, d);
  if (own) {
    const paint = painted ? { painted, dominant: d.dominant, land: causes.land } : null;
    const inputs = painted ? [biome, own, painted, d.dominant, causes.land, speciesKey(small.species), km] : [biome, own, speciesKey(small.species), km];
    replay(memoized(mesh, 'nature-own', inputs, () => natureInputs(world, biome, paint, own)));
  } else if (!painted) replay(memoized(mesh, 'nature', [biome, km], () => natureInputs(world, biome, null)));
  else {
    const paint = { painted, dominant: d.dominant, land: causes.land };
    replay(memoized(mesh, 'nature', [biome, painted, d.dominant, causes.land, speciesKey(small.species), km], () => natureInputs(world, biome, paint)));
  }

  // 带类型的自然的河（第三批）：标上是哪一种（没有河流类型时什么都不做）
  if (d.riverType) for (const f of out) if (f.type === 'river') tagRiverType(world, d, f);
  // 带类型的湖（第九轮）：同上（没有湖泊类型时什么都不做）
  if (d.lakeType) for (const f of out) if (f.type === 'lake') tagLakeType(world, d, f);
  // 放的岛（第十四轮）：岛的大半是一种自己的岛时标上它（没有自己的岛的种类时什么都不做）。
  // 有没有起名模板在起名时再看：只改模板的一步只重新起名，不重算地物
  if (world.small.islandTypes?.length) for (const f of out) if (f.type === 'island') tagIslandType(world, f);
  out.push(...regionFeatures(world, d, terrain), ...guideFeatures(world, d, terrain));
  assignNames(world, out);
  return out;
}

// ---------- 画的河 ----------

// 有名字的河道（有 name 或 nameKey）：画的河、固定下来的自然河
const named = (g: Guide) => g.name !== undefined || g.nameKey !== undefined;

// 有名字的画的河自己的格（见 rivers.ts 的 guideBody）；没有这种河时为 null
function namedGuideCells(world: World, d: Derived): Uint8Array | null {
  let mask: Uint8Array | null = null;
  for (const g of world.small.guides) {
    if (!named(g)) continue;
    mask ??= new Uint8Array(world.mesh.n);
    for (const c of guideBody(world, d, g)) mask[c] = 1;
  }
  return mask;
}

// 自然的大河里不是画的河的那部分：河口在画的河里时就是画的那条（不再单独标）；否则从河口往上到碰到画的河为止
// （画的河汇进来、或者固定了它的上游：下游照旧是这条河、叫原来的名字），再从那里沿着它自己最大的、不是画的河的上游
// 接着往上（汇进来的画的河比它大时，它原来的上游照样是它，叫原来的名字；汇合的那一格算在画的河上时跨过它）。
// 剩下太短（不到 3 格）时不标。一格也没碰到画的河时原样留着
function uncovered(world: World, d: Derived, a: AddInput, mask: Uint8Array): AddInput[] {
  if (a.type !== 'river') return [a];
  if (a.anchor !== undefined && mask[a.anchor]) return [];
  const k = a.cells.findIndex((c) => mask[c] === 1);
  if (k < 0) return [a];
  const { mesh, causes } = world;
  const thr = world.small.planet.riverThreshold;
  const cells = Array.from(a.cells.slice(0, k));
  const seen = new Set(cells);
  // 流进 c、够一条河的上游（free：不是画的河的）里水最多的
  const donor = (c: number, free: boolean) => {
    let best = -1;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (d.receiver[j] !== c || !causes.land[j] || d.lake[j] === 1 || d.discharge[j] < thr || seen.has(j) || (free && mask[j])) continue;
      if (best < 0 || d.discharge[j] > d.discharge[best]) best = j;
    }
    return best;
  };
  for (let c = cells[cells.length - 1], guard = 0; c !== undefined && guard < mesh.n; guard++) {
    let j = donor(c, true);
    // 汇合的那一格算在画的河上（画的河比它大，占了它往上的那一格）：它原来的上游在那一格后面，比别的支流大时跨过去
    const m = donor(c, false);
    const jm = m >= 0 && mask[m] ? donor(m, true) : -1;
    if (jm >= 0 && (j < 0 || d.discharge[jm] > d.discharge[j])) {
      cells.push(m);
      seen.add(m);
      j = jm;
    }
    if (j < 0) break;
    cells.push(j);
    seen.add(j);
    c = j;
  }
  return cells.length >= 3 ? [{ ...a, cells: Int32Array.from(cells) }] : [];
}

// 沿折线每隔 step 取一点（含两端）：标注的位置、方向按它（与自然的河按格心一样，点大致均匀）
function alongLine(pts: readonly [number, number][], step: number): [number, number][] {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [[pts[0][0], pts[0][1]]];
  let need = step;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    let t = 0;
    while (len - t >= need) {
      t += need;
      need = step;
      out.push([ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len]);
    }
    need -= len - t;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push([last[0], last[1]]);
  return out;
}

// 有名字的画的河变成地物（键 guide:河道 id，类型是河）：格是这条河自己的格（从河口往上排），标注在画出来的线的中段。
// 标签、大小、重要度与自然的大河同一个算法，所以固定一条自然的河之后名字、先后都不变（见 assignNames）。
// terrain 同 detectFeatures。没有名字的河道（命令里既没有 name 也没有 nameKey）不算
export function guideFeatures(world: World, d: Derived, terrain: Float32Array = d.elevation): GeoFeature[] {
  const { mesh } = world;
  const thr = world.small.planet.riverThreshold;
  const globe = mesh.kind === 'sphere';
  const out: GeoFeature[] = [];
  // 另一个源头（sourceOf）：它汇入的那条有名字的画的河还在时，不单独成一个地物，格并进那条河（同一个名字）
  const byId = new Map(world.small.guides.map((g) => [g.id, g]));
  const rootOf = (g: Guide): Guide => {
    let r = g;
    for (let guard = 0; r.sourceOf !== undefined && guard < 16; guard++) {
      const p = byId.get(r.sourceOf);
      if (!p || p === g || !named(p)) break;
      r = p;
    }
    return r;
  };
  const extra = new Map<string, number[]>();
  for (const g of world.small.guides) {
    if (!named(g) || g.sourceOf === undefined) continue;
    const root = rootOf(g);
    if (root === g) continue;
    const list = extra.get(root.id) ?? [];
    list.push(...guideBody(world, d, g).reverse());
    extra.set(root.id, list);
  }
  for (const g of world.small.guides) {
    if (!named(g) || rootOf(g) !== g) continue;
    const more = extra.get(g.id);
    const cells = Int32Array.from(more ? [...new Set([...guideBody(world, d, g).reverse(), ...more])] : guideBody(world, d, g).reverse());
    if (!cells.length) continue;
    const mouth = cells[0];
    const q = Math.max(d.discharge[mouth], thr);
    const size = q > thr * 40 ? 'big' : q > thr * 6 ? '' : 'small';
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    const line = alongLine(guideLine(world, g).points, mesh.spacing);
    const mid = line[Math.floor(line.length / 2)];
    out.push({
      key: `guide:${g.id}`,
      type: 'river',
      anchor: mouth,
      cells,
      areaKm2: areaOf(world, cells),
      x: globe ? wrapX(mid[0]) : mid[0],
      y: mid[1],
      angle: ax.angle,
      span: ax.span,
      tags: [...new Set([...tagsOf(world, d, cells, terrain), ...(size ? [size] : [])])],
      importance: 6 + Math.log10(q),
      name: '',
      custom: false,
      line,
      guide: g.id,
    });
    if (d.riverType) tagRiverType(world, d, out[out.length - 1], g);
  }
  return out;
}

// ---------- 用户圈的区块 ----------

// 点状地名的情境：海边、河边、山上、海上、寒冷（山上不山上按没挖河床的地形看）
function spotTags(world: World, d: Derived, c: number, terrain: ArrayLike<number>): string[] {
  const { mesh, causes } = world;
  const tags: string[] = [];
  let coast = false;
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (causes.land[mesh.adj[e]] !== causes.land[c]) coast = true;
  if (!causes.land[c]) tags.push('sea');
  else {
    if (coast) tags.push('coastal');
    if (d.lake[c] !== 1 && d.discharge[c] >= world.small.planet.riverThreshold) tags.push('river');
    if (terrain[c] >= 1300) tags.push('mountain');
  }
  if (d.tMean[c] < 0) tags.push('cold');
  return tags;
}

// 用户的区块变成地物：标注在离边界最远的格，狭长的（主轴比次轴长一倍以上）沿主轴写；
// 重要度高于所有自动识别的地物，标注时先放。
// 类型“自动”的区块每次按圈里现在的地形重新判断（涂成荒漠就变成荒漠）；类型变了，自动起的名字也跟着换一套模板
// （改冷暖干湿让它跨过判断的门槛时也一样），用户起的名字不变。terrain 同 detectFeatures
export function regionFeatures(world: World, d: Derived, terrain: Float32Array = d.elevation): GeoFeature[] {
  const { mesh, kmPerUnit } = world;
  return world.small.regions.map((r) => {
    const cells = Int32Array.from(r.cells);
    let areaKm2 = 0;
    for (const c of cells) areaKm2 += mesh.area[c] * kmPerUnit * kmPerUnit;
    const kind = r.auto && r.kind !== 'spot' ? guessRegionKind(world, d, cells, terrain, terrainSlope(world, d, terrain)) : r.kind;
    const type = REGION_KIND_INFO[kind].type;
    const f: GeoFeature = {
      key: `region:${r.id}`,
      type,
      anchor: cells[0],
      cells,
      areaKm2,
      x: mesh.x[cells[0]],
      y: mesh.y[cells[0]],
      angle: 0,
      span: 0,
      tags: [],
      importance: 21,
      name: '',
      custom: false,
      region: r.id,
    };
    if (r.kind === 'spot') {
      if (r.at) [f.x, f.y] = r.at;
      f.tags = spotTags(world, d, cells[0], terrain);
      return f;
    }
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    const c = innermost(mesh, cells, ax.x, ax.y);
    f.x = mesh.x[c];
    f.y = mesh.y[c];
    f.span = ax.span;
    f.angle = ax.elong >= 2 ? ax.angle : 0;
    f.tags = tagsOf(world, d, cells, terrain);
    f.importance = 20 + Math.log10(Math.max(1, areaKm2)) / 10;
    return f;
  });
}

// 区块的地物类型 → 区块类型（自动判断的区块只记了地物类型）
const REGION_KIND_OF_TYPE = new Map((Object.keys(REGION_KIND_INFO) as RegionKind[]).map((k) => [REGION_KIND_INFO[k].type, k]));

// 地名的类型名：自己写过的（第十四轮，“圣山”）最先；用户的区块按它（自动判断后）的类型（山地、地点……），
// 涂出来的生态区是生态的名字，其余按地物类型
export function featureLabel(world: World, f: GeoFeature): string {
  if (f.label) return f.label;
  return defaultFeatureLabel(world, f);
}

// 不算自己写的类型字时的叫法（改类型字的框里留空就换回它）
export function defaultFeatureLabel(world: World, f: GeoFeature): string {
  const kind = f.region ? REGION_KIND_OF_TYPE.get(f.type) : undefined;
  if (kind) return REGION_KIND_INFO[kind].label;
  const sp = f.species ? world.small.species.find((x) => x.id === f.species) : undefined;
  return sp ? speciesFeature(sp).label : FEATURE_INFO[f.type].label;
}

// 圈出来的一块像什么：大半是水 → 海域；陆地里一半以上是山 / 荒漠 / 森林，或大多是低平地 → 平原；否则是地区。
// 高低、坡度按 elevation、slope（引擎里是没挖河床的地形：画一条峡谷不会让“山地”变成“地区”，换掉自动起的名字）
export function guessRegionKind(
  world: World,
  d: Derived,
  cells: ArrayLike<number>,
  elevation: ArrayLike<number> = d.elevation,
  slope: ArrayLike<number> = d.slope,
): Exclude<RegionKind, 'spot'> {
  const { causes, small } = world;
  let water = 0;
  let n = 0;
  let high = 0;
  let desert = 0;
  let forest = 0;
  let flat = 0;
  const groups = small.species.map(biomeGroupOf);
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (!causes.land[c] || d.lake[c] === 1) {
      water++;
      continue;
    }
    n++;
    // 生态的大类（biomeGroupOf；第七十一轮以前这里只看导出用的地形 desert、forest / jungle，内置的生态两种认法相同）
    const group = d.dominant[c] >= 0 ? groups[d.dominant[c]] : '';
    if (group === 'desert') desert++;
    if (group === 'forest') forest++;
    if (elevation[c] >= 1300) high++;
    if (elevation[c] <= 400 && slope[c] <= 2.5) flat++;
  }
  if (water > cells.length * 0.6) return 'sea';
  if (!n) return 'region';
  if (high > n * 0.5) return 'highland';
  if (desert > n * 0.5) return 'desert';
  if (forest > n * 0.5) return 'forest';
  if (flat > n * 0.6) return 'plain';
  return 'region';
}
