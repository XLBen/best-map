// 从生态认出来的地物（第八十三轮从 core/features.ts 原样搬出）：生态区、物种的地名、涂出来的生态区
import { BIOME_GROUPS, biomeGroupOf, type Species } from './species';
import type { World, Derived } from './world';
import type { Mesh } from './mesh';
import { type FeatureType, FEATURE_INFO, FEATURE_TYPES, type AddInput, stableAnchor, freeAnchor, put, areaOf, withLabels } from './features-base';
import { type StyleBody, isPhonetic } from './name-styles';
import { type WordPack, hashString } from './names';

const BIOMES = BIOME_GROUPS;

// 每格属于哪一大类（BIOMES 里的下标 + 1，0 为都不是）。一种生态算哪一类见 species.ts 的 biomeGroupOf
export function biomesOf(world: World, d: Derived): Uint8Array {
  const n = world.mesh.n;
  const land = world.causes.land;
  const kindOf = world.small.species.map((sp) => (BIOMES as readonly string[]).indexOf(biomeGroupOf(sp)) + 1);
  const biome = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (land[i] && d.dominant[i] >= 0) biome[i] = kindOf[d.dominant[i]];
  return biome;
}

// 每个大类（1..K）的连通块：大类在前、同一类里按块里编号最小的格（就是以前每类一遍 components 的先后），
// 块里的格按宽度优先走到的先后（只走同一类的格，与按那一类的格表走的相同）
function biomeGroups(mesh: Mesh, biome: Uint8Array, K: number): { k: number; cells: number[] }[] {
  const n = mesh.n;
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);
  const byK: { k: number; cells: number[] }[][] = [];
  for (let k = 0; k < K; k++) byK.push([]);
  for (let i = 0; i < n; i++) {
    const b = biome[i];
    if (b < 1 || b > K || seen[i]) continue;
    const len = floodSame(mesh.off, mesh.adj, biome, b, seen, q, i);
    byK[b - 1].push({ k: b - 1, cells: Array.from(q.subarray(0, len)) });
  }
  const out: { k: number; cells: number[] }[] = [];
  for (let k = 0; k < K; k++) for (const g of byK[k]) out.push(g);
  return out;
}

// 从 s 起走同一类（biome 为 b）的连通块（宽度优先，格写进 q），返回格数
function floodSame(off: Int32Array, adj: Int32Array, biome: Uint8Array, b: number, seen: Uint8Array, q: Int32Array, s: number): number {
  let t = 0;
  q[t++] = s;
  seen[s] = 1;
  for (let h = 0; h < t; h++) {
    const c = q[h];
    for (let e = off[c]; e < off[c + 1]; e++) {
      const j = adj[e];
      if (biome[j] === b && !seen[j]) {
        seen[j] = 1;
        q[t++] = j;
      }
    }
  }
  return t;
}

// 涂出来的一片生态按哪种地物识别、叫什么、怎么起名，只在这里定（生态以后自带地名设定时也接在这里）：
// - 写了大类（group）的生态（内置的针叶林、热带雨林、荒漠……）：沿用大类的类型和模板，热带的（jungle）带“热”，模板里有雨林；
// - 其余（温带草原、稀树草原、地中海灌木、自定义的生态）：类型是“生态区”，
//   模板先找文字包里的 biome.<id>，再找 biome，文字包里都没有（导入的旧文字包）时用内置包的模板和词表。
// 类型名（地名表、底部条）就是生态的名字；模板里的 {__species} 换成它。
// 生态自带地名设定（第三批的 feature）时：类型名用它的 label，起名模板用它的 names（词表仍用文字包的；
// 文字包里没有模板用到的词表时用内置包的）。地物的种类、锚点不看这些，所以只改地名设定时只要重新起名
// 地名风格是音译式时（第二十轮）：生态自带的模板是中文的，用内置中文包；别的按风格里的 biome.<id>、大类、biome 起名，
// 生态的名字由 species 带进去（中文的写法里写 {__species}）
export function speciesFeature(sp: Species): { type: FeatureType; label: string; tags: string[]; naming: (style: StyleBody, zh: WordPack) => { pack: StyleBody; type: string; species?: string } } {
  const type: FeatureType = sp.group ?? 'biome';
  const label = sp.feature?.label ?? (sp.name || FEATURE_INFO[type].label);
  const own = sp.feature?.names;
  // zh：世界里的中文模板（name-styles.ts 的 chineseTemplate；风格是音译式、模板里缺词表时用它）
  const naming = (style: StyleBody, zh: WordPack): { pack: StyleBody; type: string; species?: string } => {
    const pack = isPhonetic(style) ? zh : style;
    if (own) return { pack: withOwnNames(hasLists(pack, own) ? pack : zh, label, own), type: OWN_TYPE };
    if (isPhonetic(style)) {
      const t = style.types[`biome.${sp.id}`] ? `biome.${sp.id}` : type !== 'biome' && style.types[type] ? type : 'biome';
      return { pack: style, type: t, species: label };
    }
    if (type !== 'biome') return { pack: withSpecies(pack, label), type };
    for (const p of [pack, zh]) {
      const t = p.types[`biome.${sp.id}`] ? `biome.${sp.id}` : p.types.biome ? 'biome' : '';
      if (t) return { pack: withSpecies(p, label), type: t };
    }
    return { pack: withSpecies(zh, label), type: 'biome' };
  };
  return { type, label, tags: sp.terrain === 'jungle' ? ['hot'] : [], naming };
}

// 文字包加上只有一项的词表 __species（生态的名字）；按文字包、名字各留一份
const speciesPacks = new WeakMap<WordPack, Map<string, WordPack>>();
function withSpecies(pack: WordPack, name: string): WordPack {
  let byName = speciesPacks.get(pack);
  if (!byName) speciesPacks.set(pack, (byName = new Map()));
  let p = byName.get(name);
  if (!p) byName.set(name, (p = { ...pack, lists: { ...pack.lists, __species: [name] } }));
  return p;
}

// 生态自带的起名模板放在文字包里的这个类型下
export const OWN_TYPE = '__own';
type OwnNames = NonNullable<NonNullable<Species['feature']>['names']>;

// 模板用到的词表文字包里都有（{__species} 起名时才放进去）
export function hasLists(pack: WordPack, names: OwnNames): boolean {
  return names.every((n) => [...n.p.matchAll(/\{([^{}]+)\}/g)].every((m) => m[1] === '__species' || !!pack.lists[m[1]]));
}

// 文字包加上生态的名字（__species）和它自带的模板（__own）；按文字包、名字和模板各留一份
const ownPacks = new WeakMap<WordPack, Map<string, WordPack>>();
export function withOwnNames(pack: WordPack, name: string, names: OwnNames): WordPack {
  let byKey = ownPacks.get(pack);
  if (!byKey) ownPacks.set(pack, (byKey = new Map()));
  const key = JSON.stringify([name, names]);
  let p = byKey.get(key);
  if (!p) byKey.set(key, (p = { ...pack, lists: { ...pack.lists, __species: [name] }, types: { ...pack.types, [OWN_TYPE]: { patterns: names } } }));
  return p;
}

// 生态区这一段的缓存键里每种生态的样子（speciesFeature 给出的类型、标签，以及 id：锚点按 id 加盐）
export function speciesKey(species: Species[]): Int32Array {
  const out = new Int32Array(species.length * 3);
  species.forEach((sp, s) => {
    const f = speciesFeature(sp);
    out[s * 3] = FEATURE_TYPES.indexOf(f.type);
    out[s * 3 + 1] = f.tags.length;
    out[s * 3 + 2] = hashString(sp.id);
  });
  return out;
}

// 涂上去、并且涂成了的格：每格是涂的生态的下标（后涂的盖住先涂的），没涂或没涂成为 -1。一格都没有时为 null
export function paintedOf(world: World, d: Derived): Int16Array | null {
  const n = world.mesh.n;
  const land = world.causes.land;
  const species = world.small.species;
  let out: Int16Array | null = null;
  for (const c of world.small.constraints) {
    const s = species.findIndex((sp) => sp.id === c.species);
    if (s < 0) continue;
    for (const i of c.cells) {
      if (i >= n || !land[i] || d.dominant[i] !== s) continue;
      if (!out) out = new Int16Array(n).fill(-1);
      out[i] = s;
    }
  }
  return out;
}

// 自然长成的一片也有自己的名字的生态：自带地名设定（第三批的 feature：类型名、起名模板），而且不是写了大类的生态
// （针叶林、荒漠……自然长成的本来就是大类的地物：森林、荒漠……；给它们加上地名设定也不另算）。内置的生态都没有 feature，
// 所以没有这样的生态的世界（以前的、只用内置生态的），地物与以前完全一样
export function namesNaturally(sp: Species): boolean {
  return !!sp.feature && speciesFeature(sp).type === 'biome';
}

// 自带地名设定的生态自然长成的格：每格是主导生态的下标（只看 namesNaturally 的生态），别的为 -1。一格都没有时为 null
export function ownOf(world: World, d: Derived): Int16Array | null {
  const species = world.small.species;
  const own = species.map(namesNaturally);
  if (!own.some(Boolean)) return null;
  const n = world.mesh.n;
  const land = world.causes.land;
  let out: Int16Array | null = null;
  for (let i = 0; i < n; i++) {
    const s = d.dominant[i];
    if (s < 0 || !land[i] || !own[s]) continue;
    if (!out) out = new Int16Array(n).fill(-1);
    out[i] = s;
  }
  return out;
}

// 涂过的世界里，生态区还要看的几样（都在缓存的键里）
interface Paint {
  // 每格涂的生态（paintedOf）
  painted: Int16Array;
  // 每格的主导生态、陆海
  dominant: Int16Array;
  land: Uint8Array;
}

// 大片生态区：只取决于每格的大类。涂过生态时：
// - 每个大类的连通块 G 里，没涂的格最多的那种生态是“周围自然的生态”（没涂的格太少时不认）；
// - 涂的生态与它不同的格（不在任何大类里的也算）按生态连成块，8 格以上的成为自己的地物（涂出来的生态区），
//   锚点按生态加盐、名字种子里带上生态，第二轮起名（不抢原有地物的名字）；
// - G 去掉这些块剩下的仍是原来的地物，锚点只在“没涂的格 + 被 G 包住的涂抹洞”里取：
//   在森林中间涂别的生态、在森林里补涂同一种，锚点都不动；往外涂出去的部分不算，森林往外长名字也不变。
//   涂抹连着森林外面、又盖住了原来锚点的（在森林边上涂一片），没涂的部分换一个锚点、换名字；
//   改气候（温度画笔、自然融入的影响范围）让锚点那一格不再是森林时也一样（用户起的名字只要原锚点还在这片地物里就留得住）
// 自带地名设定的生态（namesNaturally）自然长成的一片（own：每格的这种生态，ownOf）：除去上面涂出来的生态区，
// 同一种生态连成的块 8 格以上的，每种取最大的 10 块，成为自己的地物（与涂出来的一样带上生态、第二轮起名，
// 锚点按生态加盐）；它们占的格从大类的地物里去掉。大类地物的锚点仍按整块（没涂过时）取：
// 森林里长出、消失一片水晶丛林，森林的名字不变
export function natureInputs(world: World, biome: Uint8Array, paint: Paint | null, own: Int16Array | null = null): AddInput[] {
  const { mesh } = world;
  const n = mesh.n;
  const list: AddInput[] = [];
  // 各大类的连通块；gOf：每格属于第几块（第三十五轮提速：各大类一遍走完，再按大类排好；
  // 每一类的块与块里格的先后与以前一类一遍 components 的相同）
  const groups = biomeGroups(mesh, biome, BIOMES.length);
  const gOf = new Int32Array(n).fill(-1);
  for (let g = 0; g < groups.length; g++) for (const c of groups[g].cells) gOf[c] = g;
  const painted = paint?.painted;
  // 涂出来的生态区（下标 → 格）与它们占的格；每块的锚点取值范围（没涂过的块就是它自己）
  const regions: { s: number; cells: number[] }[] = [];
  const kept = new Uint8Array(n);
  const domain: (number[] | null)[] = groups.map(() => null);
  if (paint && painted) {
    const S = world.small.species.length;
    // 周围自然的生态：没涂的格里最多的那种（并列取下标小的）；没涂的格不到 max(8, 1/4) 时不认（-1），
    // 免得一两格自然长出的同种生态让涂的块在“生态区”和“原来的地物”之间来回跳
    const nat = new Int32Array(groups.length).fill(-1);
    const count = new Int32Array(Math.max(1, S));
    groups.forEach((g, gi) => {
      count.fill(0);
      let unpainted = 0;
      for (const c of g.cells) {
        if (painted[c] >= 0) continue;
        unpainted++;
        if (paint.dominant[c] >= 0) count[paint.dominant[c]]++;
      }
      if (unpainted === g.cells.length || unpainted < Math.max(8, g.cells.length * 0.25)) return;
      let best = -1;
      for (let s = 0; s < S; s++) if (count[s] > (best < 0 ? 0 : count[best])) best = s;
      nat[gi] = best;
    });
    // 外来的格：涂的生态与周围自然的不同
    const foreign = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (painted[i] >= 0 && (gOf[i] < 0 || nat[gOf[i]] !== painted[i])) foreign[i] = 1;
    // 同一种生态连成的块：8 格以上，每种取最大的 10 块
    const seen = new Uint8Array(n);
    const bySpecies = new Map<number, number[][]>();
    for (let i = 0; i < n; i++) {
      if (!foreign[i] || seen[i]) continue;
      const s = painted[i];
      const q = [i];
      seen[i] = 1;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (foreign[j] && !seen[j] && painted[j] === s) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
      const l = bySpecies.get(s) ?? [];
      l.push(q);
      bySpecies.set(s, l);
    }
    for (const s of [...bySpecies.keys()].sort((a, b) => a - b)) {
      const comps = bySpecies
        .get(s)!
        .filter((c) => c.length >= 8)
        .sort((a, b) => b.length - a.length)
        .slice(0, 10);
      for (const cells of comps) {
        regions.push({ s, cells });
        for (const c of cells) kept[c] = 1;
      }
    }
    // 锚点的取值范围：没涂的格，加上被它包住的涂抹洞（涂过的格连成的块，挨着的没涂的陆地全属于这一块；
    // 湖不算外面，海、地图边算外面）。往外涂出去的块挨着别的陆地，不算
    groups.forEach((g, gi) => {
      if (g.cells.some((c) => painted[c] >= 0)) domain[gi] = g.cells.filter((c) => painted[c] < 0);
    });
    const seenP = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (painted[i] < 0 || seenP[i]) continue;
      const q = [i];
      seenP[i] = 1;
      let owner = -1;
      let enclosed = true;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        if (mesh.boundary[c]) enclosed = false;
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (painted[j] >= 0) {
            if (!seenP[j]) {
              seenP[j] = 1;
              q.push(j);
            }
            continue;
          }
          // 湖（陆上主导生态为 -1 的只有湖；什么都长不了的格是 -2，算外面）
          if (paint.land[j] && paint.dominant[j] === -1) continue;
          const gj = gOf[j];
          if (gj < 0 || (owner >= 0 && owner !== gj)) enclosed = false;
          else owner = gj;
        }
      }
      if (!enclosed || owner < 0) continue;
      // 逐格加（大星球上一个洞可能有几万格，展开成参数会超出调用栈）
      const dom = (domain[owner] ??= groups[owner].cells.filter((c) => painted[c] < 0));
      for (const c of q) dom.push(c);
    }
  }
  // 自带地名设定的生态自然长成的一片（涂出来的生态区占的格不算）：每种取最大的 10 块，8 格以上
  const naturals: { s: number; cells: number[] }[] = [];
  if (own) {
    const seen = new Uint8Array(n);
    const bySpecies = new Map<number, number[][]>();
    for (let i = 0; i < n; i++) {
      const s = own[i];
      if (s < 0 || kept[i] || seen[i]) continue;
      const q = [i];
      seen[i] = 1;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (own[j] === s && !kept[j] && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
      const l = bySpecies.get(s) ?? [];
      l.push(q);
      bySpecies.set(s, l);
    }
    for (const s of [...bySpecies.keys()].sort((a, b) => a - b)) {
      const comps = bySpecies
        .get(s)!
        .filter((c) => c.length >= 8)
        .sort((a, b) => b.length - a.length)
        .slice(0, 10);
      for (const cells of comps) naturals.push({ s, cells });
    }
    for (const { cells } of naturals) for (const c of cells) kept[c] = 1;
  }
  // 原来的地物：每个大类按剩下的格数取最大的 10 块（没涂过时与原来完全相同）
  const usedBy = new Map<FeatureType, Set<number>>();
  const usedOf = (t: FeatureType) => {
    let u = usedBy.get(t);
    if (!u) usedBy.set(t, (u = new Set()));
    return u;
  };
  for (let k = 0; k < BIOMES.length; k++) {
    const g = BIOMES[k];
    const min = g === 'wetland' ? 12 : 30;
    const rests: { gi: number; cells: number[] }[] = [];
    groups.forEach((G, gi) => {
      if (G.k !== k) return;
      const cells = regions.length || naturals.length ? G.cells.filter((c) => !kept[c]) : G.cells;
      if (cells.length >= min) rests.push({ gi, cells });
    });
    rests.sort((a, b) => b.cells.length - a.cells.length);
    const used = usedOf(g);
    for (const { gi, cells } of rests.slice(0, 10)) {
      const dom = domain[gi];
      // 没涂过的块按整块取锚点：去掉的只有自然长成的、自带地名的生态（没有它们时就是 cells，与以前相同）
      const whole = dom === null && naturals.length ? groups[gi].cells : cells;
      let anchor = stableAnchor(dom?.length ? dom : whole);
      if (used.has(anchor)) anchor = freeAnchor(cells, used);
      if (anchor < 0) continue;
      used.add(anchor);
      put(list, g, cells, 5 + Math.log10(areaOf(world, cells)), [], anchor);
    }
  }
  // 涂出来的生态区：重要度比同样大的自然地物高一点（刚涂的标注优先放上）
  for (const { s, cells } of regions) {
    const sp = world.small.species[s];
    const info = speciesFeature(sp);
    const used = usedOf(info.type);
    const anchor = freeAnchor(cells, used, hashString(sp.id));
    if (anchor < 0) continue;
    used.add(anchor);
    list.push({ type: info.type, cells: Int32Array.from(cells), importance: 6 + Math.log10(areaOf(world, cells)), tags: info.tags, anchor, species: s });
  }
  // 自带地名设定的生态自然长成的一片：重要度与同样大的自然地物相同；锚点与涂出来的一样按生态加盐
  // （涂出来的一片后来自然长成了同样的格，名字不变）
  for (const { s, cells } of naturals) {
    const sp = world.small.species[s];
    const info = speciesFeature(sp);
    const used = usedOf(info.type);
    const anchor = freeAnchor(cells, used, hashString(sp.id));
    if (anchor < 0) continue;
    used.add(anchor);
    list.push({ type: info.type, cells: Int32Array.from(cells), importance: 5 + Math.log10(areaOf(world, cells)), tags: info.tags, anchor, species: s });
  }
  return withLabels(mesh, list);
}
