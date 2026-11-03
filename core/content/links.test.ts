import { afterEach, describe, expect, it } from 'vitest';
import { type PackNode, type ResourcePack, addToPack, defaultPicks, ownItems, packItems, planPack, renamedItem } from '../packs';
import { BUILTIN_GOVERNMENTS } from '../packs/governments';
import { builtinPacks } from '../packs/builtin-tree';
import { importIntoPack, packImportPlan } from '../packs/import';
import { engineFor } from '../testing/fixtures';
import { KIND_LINKS } from './link-rules';
import { FIELD_WALKERS, type Link, danglingLinks, dependencyClosure, linkIds, linkProblems, linkTable, linksOf, packScope, referencesOf, referrersOf, renameLinks, stripLinks, worldScope } from './links';
import { originSourceId, recordedOrigin } from './origin';
import { sameContent, scriptRefs } from './refs';
import { type ContentKind, type FieldType, type Renames, allKinds, itemId, kindByPackKey, kindOf, registerKind, unregisterKind } from './registry';
import { unusedContent } from './unused';

// 第四十九轮：内容之间的引用表。覆盖（内置的每一项、以后加的种类和字段）、查询、闭包、去掉引用、撞名导入。

const SRC = "return river('r1') + nearLake('l1') + field('mana');";

// 每一种有引用的内容都写满引用，目标也都在包里。parse 过，和文件读进来的一样
function fullPack(id = 'src', tweak: (key: string, x: Record<string, unknown>) => Record<string, unknown> = (_, x) => x): ResourcePack {
  const raw: Record<string, Record<string, unknown>[]> = {
    riverTypes: [{ id: 'r1', name: '红河', color: '#aa0000', biomes: ['b2'], scripts: { match: { api: 1, src: "return biome('b2') > 0.5 && field('mana') > 0;" } } }],
    lakeTypes: [{ id: 'l1', name: '红湖', color: '#aa0011', biomes: ['b2'] }],
    islandTypes: [{ id: 'i1', name: '岛', shape: 'round', height: 'flat', province: 'land' }],
    biomes: [
      { id: 'b1', name: '甲', tolerances: [{ field: 'tMean', min: 0, optLow: 1, optHigh: 2, max: 3 }, { field: 'river:r1', min: 0, optLow: 0.5, optHigh: 1, max: 1 }, { field: 'lake:l1', min: 0, optLow: 0.5, optHigh: 1, max: 1 }, { field: 'field:mana', min: 0, optLow: 0.5, optHigh: 1, max: 1 }], effects: { invade: { targets: ['b2'], strength: 1 } }, scripts: { placement: { api: 1, src: SRC } } },
      { id: 'b2', name: '乙', tolerances: [] },
    ],
    nameStyles: [{ id: 's1', name: '风格', kind: 'template', lists: { a: ['青', '白'] }, types: { island: { patterns: [{ p: '{a}岛' }] } } }],
    terrainClasses: [{ id: 'tc1', name: '类别', color: '#999999', priority: 1, rules: [{ biomes: ['b2'] }] }],
    resources: [{ id: 'res1', name: '资源', color: '#999999', category: 'ore', rules: [{ biomes: ['b2'], classes: ['tc1'] }], rarity: 0.1, weight: 1, cluster: 300 }],
    eras: [{ id: 'e1', name: '时代', dimensions: [{ id: 'religion', label: '宗教' }], popDensity: 2, tiers: { t1: 1, t2: 2 } }],
    valueGroups: [{ id: 'vg1', dimension: 'religion', name: '教', color: '#999999' }],
    popValues: [{ id: 'v1', dimension: 'religion', name: '派', color: '#999999', group: 'vg1', prefs: [{ factor: 2, biomes: ['b2'], classes: ['tc1'] }] }],
    cultureGroups: [{ id: 'g1', name: '组', color: '#999999', nameStyle: 's1', tendencies: { religion: [['v1', 3]], government: ['gov1'] }, eraTendencies: { e1: { religion: ['v1'] } }, prefs: [{ factor: 2, biomes: ['b2'] }] }],
    cultures: [{ id: 'c1', group: 'g1', name: '文化', color: '#999999', nameStyle: 's1', tendencies: { religion: ['v1'] }, eraTendencies: { e1: { government: [['gov1', 2]] } }, prefs: [{ factor: 2, classes: ['tc1'] }] }],
    governments: [
      {
        id: 'gov1',
        name: '政体',
        category: ['monarchy'],
        titles: { t1: '王国', default: '公国' },
        rulers: { t2: { zh: '国王', orig: 'King' } },
        names: [{ cultures: ['c1'], cultureGroups: ['g1'], values: ['v1'], valueGroups: ['vg1'], titles: { t1: '大王国' }, rulers: { t2: '大王' } }],
        only: [{ cultures: ['c1'], cultureGroups: ['g1'], values: ['v1'], valueGroups: ['vg1'] }],
        size: 1,
      },
    ],
    factions: [{ id: 'f1', name: '派系', color: '#999999', base: { monarchy: 1, default: 1 }, drivers: [{ dimension: 'religion', value: 'v1', culture: 'c1', cultureGroup: 'g1', weight: 1 }, { faith: 'heretic', weight: 1 }] }],
    countryTiers: [{ id: 't1', name: '大', order: 1, area: 2, govSize: 1 }, { id: 't2', name: '小', order: 0, area: 1, govSize: 1 }],
    countryLayouts: [{ id: 'lay1', name: '格局', weights: { t1: 1, t2: 2 } }],
    cityRanks: [{ id: 'cr1', name: '城', icon: 'dot', level: 1, minShare: 0.1, label: 1 }],
    landmarkTypes: [{ id: 'lm1', name: '地标', category: 'manmade', icon: 'temple', cultureGroups: ['g1'], governments: ['monarchy'], label: { c1: '文化碑', g1: '组碑', default: '{city}碑' } }],
    pointTypes: [{ id: 'pt1', name: '点', color: '#999999', actsAsCity: { rank: 'cr1' } }],
    mapStyles: [{ id: 'm1', name: '画风' }],
  };
  const pack: ResourcePack = { format: 'map2-pack', version: 1, id, name: id, fields: ['mana'] };
  for (const [key, list] of Object.entries(raw)) pack[key] = list.map((x) => kindByPackKey(key)!.schema.parse(tweak(key, x)));
  return pack;
}

// 世界（或目的地的包）里同样的 id、不同的内容：撞名
const collidingPack = () =>
  fullPack('there', (key, x) => {
    if (x.color) return { ...x, color: '#123456' };
    if (key === 'islandTypes') return { ...x, rock: 1 };
    if (key === 'countryTiers') return { ...x, area: 9 };
    if (key === 'cityRanks') return { ...x, level: 9 };
    if (key === 'biomes') return { ...x, competition: 9 };
    return { ...x, description: '世界里的' };
  });

const bareEngine = () => engineFor({ cells: 1500, seed: 3 }, { bare: true });

// 第四十九轮之前按种类手写的改名（拷贝，不要改它）：对照用，看旧的写法漏了多少
function oldRewrite(kind: string, x: Record<string, any>, r: Renames): Record<string, any> {
  const get = (key: string, id: string) => r[key]?.get(id) ?? id;
  if (kind === 'popValue') return x.group ? { ...x, group: get('valueGroups', x.group) } : x;
  if (kind === 'culture') return { ...x, group: get('cultureGroups', x.group) };
  if (kind === 'riverType' || kind === 'lakeType') return x.biomes ? { ...x, biomes: x.biomes.map((b: string) => get('biomes', b)) } : x;
  if (kind !== 'biome') return x;
  const tol = x.tolerances.map((t: { field: string }) => (t.field.startsWith('river:') ? { ...t, field: `river:${get('riverTypes', t.field.slice(6))}` } : t.field.startsWith('lake:') ? { ...t, field: `lake:${get('lakeTypes', t.field.slice(5))}` } : t));
  const inv = x.effects?.invade;
  const scripts = x.scripts && Object.fromEntries(Object.entries(x.scripts as Record<string, { src: string }>).map(([k, s]) => {
    let src = s.src;
    for (const f of scriptRefs(s.src).reverse()) {
      const to = f.fn === 'river' || f.fn === 'hasRiver' ? get('riverTypes', f.name) : f.fn === 'nearLake' || f.fn === 'hasLake' ? get('lakeTypes', f.name) : f.name;
      src = src.slice(0, f.start) + to + src.slice(f.end);
    }
    return [k, { ...s, src }];
  }));
  return { ...x, tolerances: tol, ...(inv ? { effects: { ...x.effects, invade: { ...inv, targets: inv.targets.map((t: string) => get('biomes', t)) } } } : {}), ...(scripts ? { scripts } : {}) };
}

// 一项里的引用有多少没有指到改名后的目标（改名前后两边的引用一条条对）
function misPointed(kind: ContentKind, before: unknown, after: unknown, r: Renames): Link[] {
  const was = linksOf(kind, before);
  const now = linksOf(kind, after);
  expect(now.length).toBe(was.length);
  const wanted = (l: Link) => {
    for (const k of l.kinds) {
      const to = r[kindOf(k)?.pack.key ?? '']?.get(l.id);
      if (to !== undefined) return to;
    }
    return l.id;
  };
  return now.filter((l, i) => l.id !== wanted(was[i]));
}

describe('覆盖：引用表管到了所有种类和字段', () => {
  afterEach(() => unregisterKind('linkTestThing'));

  it('现在登记的种类、字段都管到了', () => {
    expect(linkProblems()).toEqual([]);
    expect(Object.keys(KIND_LINKS).sort()).toEqual(allKinds().map((k) => k.id).sort());
    // 字段类型的表和 FieldType 一一对应（少一种 tsc 不过，多一种这里写上）
    const types: FieldType[] = ['text', 'longtext', 'number', 'bool', 'color', 'enum', 'tags', 'weighted', 'list', 'map', 'script', 'json', 'tuple', 'tuples', 'title', 'titleList', 'tendencies'];
    expect(Object.keys(FIELD_WALKERS).sort()).toEqual([...types].sort());
  });

  it('新登记一种内容、新的 ref、新的字段类型，没有写引用的处理就报出来', () => {
    registerKind<{ id: string }>({
      id: 'linkTestThing',
      label: '测试',
      short: '测',
      order: 99,
      store: 'content',
      schema: kindOf('countryTier')!.schema as never,
      inWorld: () => [],
      fields: [
        { key: 'a', label: 'a', type: 'text', ref: 'noSuchThing' },
        { key: 'b', label: 'b', type: 'map', keyRef: ['culture', 'alsoNotThere'] },
        { key: 'c', label: 'c', type: 'number', ref: 'culture' },
        { key: 'd', label: 'd', type: 'tags', keyRef: 'culture' },
        { key: 'e', label: 'e', type: 'newType' as FieldType },
        { key: 'f', label: 'f', type: 'list', of: [{ key: 'g', label: 'g', type: 'tags', ref: 'nested' }] },
      ],
      pack: { key: 'linkTestThings', max: 2, listed: false, checked: false },
    });
    const got = linkProblems();
    expect(got).toEqual([
      'linkTestThing：还没有写进 link-rules.ts 的 KIND_LINKS',
      'linkTestThing.a：引用表不认识 ref noSuchThing',
      'linkTestThing.b：引用表不认识 keyRef alsoNotThere',
      'linkTestThing.c：number 字段上的 ref 走不到',
      'linkTestThing.d：tags 字段上的 keyRef 走不到',
      'linkTestThing.e：引用表不认识字段类型 newType',
      'linkTestThing.f.g：引用表不认识 ref nested',
    ]);
  });

  it('内置的全部内容：引用都找得到（整个资源库一起看）', () => {
    const table = linkTable(packScope(...builtinPacks()));
    expect(danglingLinks(table).map((b) => `${b.from.kind}:${b.from.id} → ${b.link.kinds}:${b.link.id}`)).toEqual([]);
    // 每种有引用的都走到了
    const kinds = new Set([...table.out].filter(([, l]) => l.length).map(([k]) => k.split('\u0000')[0]));
    expect([...kinds].sort()).toEqual(['biome', 'countryLayout', 'culture', 'cultureGroup', 'era', 'faction', 'government', 'landmarkType', 'popValue', 'resource', 'valueGroup'].sort());
  });

  it('内置的每个大包单独看：找不到的 hard 类只有写明的那几条，其余找不到的都是能取消、能去掉的', () => {
    const lib = linkTable(packScope(...builtinPacks()));
    const hard: string[] = [];
    for (const p of builtinPacks()) {
      for (const b of danglingLinks(linkTable(packScope(p)))) {
        // 换到整个资源库里都找得到（上一个测试查了）
        expect(referencesOf(lib, b.from).length).toBeGreaterThan(0);
        if (b.link.cls === 'hard') hard.push(`${p.id} ${b.from.kind}:${b.from.id} → ${b.link.id}`);
      }
    }
    // 奇幻的生态侵占“通用 ▸ 自然”里的生态：第五十一轮各库完整以后这几条就没有了
    expect(hard).toEqual([
      'fantasy biome:swarm_zone → taiga',
      'fantasy biome:swarm_zone → temperate_forest',
      'fantasy biome:swarm_zone → subtropical_forest',
      'fantasy biome:swarm_zone → dry_forest',
      'fantasy biome:swarm_zone → monsoon_forest',
      'fantasy biome:swarm_zone → rainforest',
    ]);
  });

  it('数据里看着像 id、表里没有的字：都写明了不是引用（新的引用写漏了这里会报）', () => {
    // 种类:位置 → 为什么不算
    const NOT_REFS: Readonly<Record<string, string>> = {
      'biome:KEY ': 'natural 是开关，碰巧有个取值组也叫它',
      'biome:KEY tolerances.#': 'min 是数的下限，碰巧有个文化叫它',
      'biome:terrain': '导出用的地形标签',
      'biome:group': '固定的大类',
      'riverType:KEY ': 'natural 是开关',
      'lakeType:KEY ': 'natural 是开关',
      'islandType:color': '固定的几种样子',
      'planetForm:base': '固定的六种星球',
      'terrainClass:terrain': '导出给游戏的名字',
      'terrainClass:KEY ': 'peaks 是开关',
      'resource:icon': '图标名',
      'resource:category': '固定的类别',
      'resource:rules.#.terrain.#': '生态的地形标签',
      'era:dimensions.#.id': '时代定义的维度',
      'era:KEY relations.titles': '帝国的称号，不是等级',
      'popValue:prefs.#.terrain.#': '生态的地形标签',
      'cultureGroup:prefs.#.terrain.#': '生态的地形标签',
      'culture:prefs.#.terrain.#': '生态的地形标签',
      'government:category.#': '政体的类别（标签）',
      'faction:KEY base': '政体的类别（标签）',
      'cityRank:KEY ': 'capital 是开关',
      'landmarkType:category': '固定的类别',
      'landmarkType:icon': '图标名',
      'landmarkType:detector': '固定的检测器',
      'landmarkType:place': '固定的放法',
      'landmarkType:governments.#': '政体的类别（标签）',
      'pointType:KEY actsAsCity': 'capital 是开关',
      'pointType:icon': '图标名',
    };
    const table = linkTable(packScope(...builtinPacks()));
    const ids = new Set([...table.nodes.values()].map((n) => n.id));
    const found = new Set<string>();
    const shape = (path: readonly (string | number)[]) => path.map((x) => (typeof x === 'number' ? '#' : x)).join('.');
    for (const n of table.nodes.values()) {
      // 地名风格的词表、读音里全是字（碰巧和 id 一样），没有引用
      if (n.owners || n.kind === 'nameStyle' || n.kind === 'field') continue;
      const known = new Set(linksOf(n.kind, n.item).map((l) => JSON.stringify(l.path)));
      const walk = (v: unknown, path: (string | number)[]) => {
        if (typeof v === 'string') {
          if (ids.has(v) && path[0] !== 'id' && !known.has(JSON.stringify(path))) found.add(`${n.kind}:${shape(path)}`);
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (ids.has(k) && !known.has(JSON.stringify([...path, k]))) found.add(`${n.kind}:KEY ${shape(path)}`);
            walk(x, [...path, k]);
          }
        }
      };
      walk(n.item, []);
    }
    expect([...found].filter((x) => !NOT_REFS[x])).toEqual([]);
  });
});

describe('一项里的引用', () => {
  const p = fullPack();
  const table = linkTable(packScope(p));
  const of = (kind: string, id: string) => linksOf(kind, packItems(p, kindOf(kind)!.pack.key).find((x) => itemId(kindOf(kind)!, x) === id));
  const brief = (l: Link) => `${l.path.join('.')}→${l.kinds.join('|')}:${l.id}:${l.cls}`;

  it('表的键、限谁用、维度、倾向、隐含的维度都有，default 不算', () => {
    expect(of('government', 'gov1').map(brief)).toEqual([
      'titles.t1→countryTier:t1:strip',
      'rulers.t2→countryTier:t2:strip',
      'names.0.cultureGroups.0→cultureGroup:g1:strip',
      'names.0.cultures.0→culture:c1:strip',
      'names.0.valueGroups.0→valueGroup:vg1:strip',
      'names.0.values.0→popValue:v1:strip',
      'names.0.titles.t1→countryTier:t1:strip',
      'names.0.rulers.t2→countryTier:t2:strip',
      'only.0.cultureGroups.0→cultureGroup:g1:auto',
      'only.0.cultures.0→culture:c1:auto',
      'only.0.valueGroups.0→valueGroup:vg1:auto',
      'only.0.values.0→popValue:v1:auto',
    ]);
    expect(of('culture', 'c1').map(brief)).toEqual([
      'group→cultureGroup:g1:hard',
      'nameStyle→nameStyle:s1:auto',
      'tendencies.religion→dimension:religion:strip',
      'tendencies.religion.0→popValue:v1:strip',
      'eraTendencies.e1→era:e1:strip',
      'eraTendencies.e1.government.0.0→government:gov1:strip',
      'prefs.0.classes.0→terrainClass:tc1:strip',
    ]);
    expect(of('popValue', 'v1').map((l) => `${l.path.join('.')}:${l.cls}`)).toEqual(['dimension:hard', 'group:hard', 'prefs.0.classes.0:strip', 'prefs.0.biomes.0:strip']);
    expect(of('landmarkType', 'lm1').map(brief)).toEqual(['cultureGroups.0→cultureGroup:g1:auto', 'label.c1→culture|cultureGroup:c1:strip', 'label.g1→culture|cultureGroup:g1:strip']);
    expect(of('faction', 'f1').map(brief)).toEqual([
      'drivers.0.dimension→dimension:religion:strip',
      'drivers.0.value→popValue:v1:strip',
      'drivers.0.culture→culture:c1:strip',
      'drivers.0.cultureGroup→cultureGroup:g1:strip',
      'drivers.1.faith→dimension:religion:strip',
    ]);
    expect(of('era', 'e1').map(brief)).toEqual(['tiers.t1→countryTier:t1:strip', 'tiers.t2→countryTier:t2:strip']);
    expect(of('pointType', 'pt1').map(brief)).toEqual(['actsAsCity.rank→cityRank:cr1:auto']);
    expect(of('countryLayout', 'lay1').map((l) => l.cls)).toEqual(['auto', 'auto']);
  });

  it('条件和脚本里的：river:、lake:、field:，field() 不算内置变量，biome() 和比较的字面量', () => {
    expect(of('biome', 'b1').map(brief)).toEqual([
      'tolerances.1.field→riverType:r1:hard',
      'tolerances.2.field→lakeType:l1:hard',
      'tolerances.3.field→field:mana:hard',
      'effects.invade.targets.0→biome:b2:hard',
      'scripts.placement.src→riverType:r1:hard',
      'scripts.placement.src→lakeType:l1:hard',
      'scripts.placement.src→field:mana:hard',
    ]);
    expect(linksOf('riverType', { id: 'x', scripts: { match: { src: "return field('tMean') + field('mana') + (dominantBiome() === 'bog' ? 1 : 0) + (biomeAtSource() != \"fen\" ? 1 : 0); // biome('note')" } } }).map((l) => `${l.kinds}:${l.id}`)).toEqual(['field:mana', 'biome:bog', 'biome:fen']);
    expect(linkIds('biome', { id: 'x', tolerances: [{ field: 'river:a' }, { field: 'river:a' }] }, 'riverType')).toEqual(['a']);
  });

  it('谁引用它、引用了什么', () => {
    expect(referrersOf(table, { kind: 'cultureGroup', id: 'g1' }).map((r) => `${r.from.kind}:${r.from.id}:${r.link.cls}`)).toEqual(['culture:c1:hard', 'government:gov1:strip', 'government:gov1:auto', 'faction:f1:strip', 'landmarkType:lm1:auto', 'landmarkType:lm1:strip']);
    expect(referrersOf(table, { kind: 'dimension', id: 'religion' }).map((r) => r.from.id)).toContain('v1');
    expect(table.nodes.get('dimension\u0000religion')?.owners).toEqual(['e1']);
    const refs = referencesOf(table, { kind: 'landmarkType', id: 'lm1' });
    // 键先按文化找，文化没有时按文化组
    expect(refs.map((r) => r.target)).toEqual([{ kind: 'cultureGroup', id: 'g1' }, { kind: 'culture', id: 'c1' }, { kind: 'cultureGroup', id: 'g1' }]);
    expect(danglingLinks(table)).toEqual([]);
  });

  it('依赖的闭包：hard、auto 跟着走，strip 不走只列出来', () => {
    const c = dependencyClosure(table, [{ kind: 'culture', id: 'c1' }]);
    expect(c.hard).toEqual([{ kind: 'cultureGroup', id: 'g1' }]);
    expect(c.auto).toEqual([{ kind: 'nameStyle', id: 's1' }]);
    expect(c.strip.map((x) => x.id).sort()).toEqual(['b2', 'e1', 'gov1', 'religion', 'tc1', 'v1']);
    expect(c.missing).toEqual([]);
    // 政体：限谁用默认跟着走（组、文化、取值、取值组），取值的维度、取值组是 hard 的一路走到；等级只列出来
    const g = dependencyClosure(table, [{ kind: 'government', id: 'gov1' }]);
    expect(g.hard).toEqual([]);
    expect(g.auto.map((x) => `${x.kind}:${x.id}`).sort()).toEqual(['culture:c1', 'cultureGroup:g1', 'dimension:religion', 'nameStyle:s1', 'popValue:v1', 'valueGroup:vg1'].sort());
    expect(g.strip.map((x) => x.id).sort()).toEqual(['b2', 'e1', 't1', 't2', 'tc1']);
    // 种子不算在里面，两条路的算 hard
    const both = dependencyClosure(table, [{ kind: 'culture', id: 'c1' }, { kind: 'landmarkType', id: 'lm1' }]);
    expect(both.hard).toEqual([{ kind: 'cultureGroup', id: 'g1' }]);
    expect(both.auto).toEqual([{ kind: 'nameStyle', id: 's1' }]);
    // 找不到的列在 missing
    const alone = linkTable(packScope({ id: 'a', name: 'a', cultures: [{ id: 'x', group: 'nope', name: 'x', color: '#000000' }] } as PackNode));
    const m = dependencyClosure(alone, [{ kind: 'culture', id: 'x' }]);
    expect(m.missing.map((b) => `${b.link.id}:${b.link.cls}`)).toEqual(['nope:hard']);
  });

  it('内置的政体：一个政体不会因为换说法把很多文化组拖进来（strip），限谁用才跟着（auto）', () => {
    const lib = linkTable(packScope(...builtinPacks()));
    const wordy = BUILTIN_GOVERNMENTS.filter((g) => (g.names ?? []).flatMap((n) => n.cultureGroups ?? []).length >= 3 && !g.only);
    expect(wordy.length).toBeGreaterThan(0);
    for (const g of wordy) {
      const c = dependencyClosure(lib, [{ kind: 'government', id: g.id }]);
      expect(c.hard, g.id).toEqual([]);
      expect(c.auto, g.id).toEqual([]);
      expect(c.strip.filter((x) => x.kind === 'cultureGroup').length, g.id).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('去掉引用', () => {
  const kind = kindOf('government')!;
  const gov = (extra: object) => kind.schema.parse({ id: 'g', name: 'g', category: ['monarchy'], titles: '王国', size: 1, ...extra }) as Record<string, any>;

  it('换说法：列表里去掉一个；条件没了时整条规则去掉（只留另外几项规则就放宽了）', () => {
    const g = gov({ names: [{ cultureGroups: ['a', 'b'], titles: '甲' }, { cultureGroups: ['c'], values: ['v'], titles: '乙' }] });
    const a = stripLinks(kind, g, (l) => l.id === 'b');
    expect(a.names).toEqual([{ cultureGroups: ['a'], titles: '甲' }, { cultureGroups: ['c'], values: ['v'], titles: '乙' }]);
    const c = stripLinks(kind, g, (l) => l.id === 'c');
    expect(c.names).toEqual([{ cultureGroups: ['a', 'b'], titles: '甲' }]);
    const all = stripLinks(kind, g, (l) => ['a', 'b', 'c'].includes(l.id));
    expect('names' in all).toBe(false);
    // 原来的不动，什么都没去掉时给回原来的
    expect(g.names.length).toBe(2);
    expect(stripLinks(kind, g, () => false)).toBe(g);
  });

  it('限谁用：条件没了时整条去掉，全去掉就是谁都能用（放开限制）', () => {
    const g = gov({ only: [{ cultureGroups: ['a'] }] });
    expect('only' in stripLinks(kind, g, (l) => l.id === 'a')).toBe(false);
  });

  it('称号的键：去掉几个；全去掉时留第一种写法，称号不会没有', () => {
    const g = gov({ titles: { t1: '王国', t2: { zh: '公国', orig: 'Duchy' }, default: '邦' }, rulers: { t1: '王', t2: '公' } });
    expect(stripLinks(kind, g, (l) => l.id === 't1').titles).toEqual({ t2: { zh: '公国', orig: 'Duchy' }, default: '邦' });
    const all = stripLinks(kind, g, () => true);
    expect(all.titles).toEqual({ default: '邦' });
    expect(all.rulers).toBe('王');
  });

  it('倾向：取值、维度一层层空了就去掉；侵占的目标没了去掉侵占；来源的条件没了整条去掉', () => {
    const c = kindOf('culture')!;
    const x = c.schema.parse({ id: 'c', group: 'g', name: 'c', color: '#000000', tendencies: { religion: [['a', 2], 'b'], ideology: ['c'] }, eraTendencies: { e: { religion: ['a'] } } }) as Record<string, any>;
    expect(stripLinks(c, x, (l) => l.id === 'a').tendencies).toEqual({ religion: ['b'], ideology: ['c'] });
    expect(stripLinks(c, x, (l) => l.id === 'a').eraTendencies).toBeUndefined();
    expect(stripLinks(c, x, (l) => l.id === 'ideology').tendencies).toEqual({ religion: [['a', 2], 'b'] });
    const noRel = stripLinks(c, x, (l) => l.cls === 'strip');
    expect(noRel.tendencies).toBeUndefined();
    expect(noRel.eraTendencies).toBeUndefined();
    // 文化的组是必须有的：去不掉，留着
    expect(stripLinks(c, x, (l) => l.cls === 'hard')).toBe(x);
    const b = kindOf('biome')!;
    const inv = b.schema.parse({ id: 'b', effects: { invade: { targets: ['a'], strength: 1 }, climate: { radiusKm: 100 } } }) as Record<string, any>;
    expect(stripLinks(b, inv, () => true).effects).toEqual({ climate: { radiusKm: 100 } });
    const f = kindOf('faction')!;
    const fx = f.schema.parse({ id: 'f', name: 'f', color: '#000000', base: {}, drivers: [{ dimension: 'religion', value: 'v', weight: 1 }, { primary: true, weight: 1 }] }) as Record<string, any>;
    expect(stripLinks(f, fx, (l) => l.id === 'v').drivers).toEqual([{ primary: true, weight: 1 }]);
  });

  it('内置的每一项：去掉全部 strip、auto 类引用后格式还是对的，也不再有这两类引用（去不掉的除外）', () => {
    const table = linkTable(packScope(...builtinPacks()));
    for (const n of table.nodes.values()) {
      if (n.owners) continue;
      const k = kindOf(n.kind)!;
      const out = stripLinks(k, n.item, (l) => l.cls !== 'hard');
      const parsed = k.schema.safeParse(out);
      expect(parsed.success, `${n.kind}:${n.id}`).toBe(true);
      expect(linksOf(k, out).filter((l) => l.cls !== 'hard' && l.drop), `${n.kind}:${n.id}`).toEqual([]);
    }
  });
});

describe('故意撞名的导入：引用跟着改名，不留下找不到的', () => {
  // 第一次用包：世界里全是同 id、不同内容的项
  function collided() {
    const eng = bareEngine();
    eng.exec(planPack(eng.world, collidingPack(), defaultPicks(collidingPack())).command);
    const src = fullPack();
    const plan = planPack(eng.world, src, defaultPicks(src));
    return { eng, src, plan };
  }

  it('导入世界：每种都改了名，引用全部指到改名后的那一项，世界里原来的不动', () => {
    const { eng, src, plan } = collided();
    const before = structuredClone(eng.world.small.content);
    expect(plan.skipped).toEqual([]);
    const renames = new Map(plan.added.map((a) => [`${a.section}:${a.from}`, a.id]));
    const allKeys = Object.keys(src).filter((k) => Array.isArray(src[k]) && k !== 'fields');
    for (const key of allKeys) for (const x of src[key] as { id: string }[]) if (key !== 'planetForms') expect(renames.get(`${key}:${x.id}`), `${key}:${x.id}`).toBe(`${x.id}-2`);
    eng.exec(plan.command);
    const table = linkTable(worldScope(eng.world));
    expect(danglingLinks(table).map((b) => `${b.from.id} → ${b.link.id}`)).toEqual([]);
    // 新加的项引用的全是 -2（维度、自定义场不改名）
    for (const a of plan.added) {
      for (const r of referencesOf(table, { kind: kindByPackKey(a.section)!.id, id: a.id })) {
        if (r.target!.kind === 'dimension' || r.target!.kind === 'field') continue;
        expect(r.target!.id, `${a.id}.${r.link.path.join('.')}`).toMatch(/-2$/);
      }
    }
    // 世界里原来的那份的引用还是原来的 id
    for (const [kind, items] of Object.entries(before!)) for (const [id, item] of Object.entries(items ?? {})) expect(eng.world.small.content![kind]![id], `${kind}:${id}`).toEqual(item);
    // 脚本、条件、键都换了
    const b1 = eng.world.small.species.find((s) => s.id === 'b1-2')!;
    expect(b1.scripts!.placement!.src).toBe("return river('r1-2') + nearLake('l1-2') + field('mana');");
    expect(b1.tolerances.map((t) => t.field)).toEqual(['tMean', 'river:r1-2', 'lake:l1-2', 'field:mana']);
    expect(b1.seedKey).toBe('b1');
    const lm = eng.world.small.content!.landmarkType!['lm1-2'] as { label: Record<string, string> };
    expect(Object.keys(lm.label)).toEqual(['c1-2', 'g1-2', 'default']);
    const g = eng.world.small.content!.cultureGroup!['g1-2'] as { eraTendencies: Record<string, unknown>; tendencies: Record<string, unknown> };
    expect(Object.keys(g.eraTendencies)).toEqual(['e1-2']);
    expect(g.tendencies).toEqual({ religion: [['v1-2', 3]], government: ['gov1-2'] });
  });

  it('和以前对照：按种类手写的改名漏掉一大半（指到世界里原来的那一项），引用表一条不漏', () => {
    const { src, plan } = collided();
    const renames: Renames = { biomes: new Map(), riverTypes: new Map(), lakeTypes: new Map() };
    for (const a of plan.added) renames[a.section] = new Map([...(renames[a.section] ?? []), [a.from, a.id]]);
    let total = 0;
    const oldWrong: Record<string, number> = {};
    const nowWrong: string[] = [];
    for (const k of allKinds()) {
      for (const x of ownItems<Record<string, any>>(src, k.pack.key)) {
        if (k.id === 'field' || k.id === 'planetForm') continue;
        total += linksOf(k, x).length;
        const old = misPointed(k, x, oldRewrite(k.id, x, renames), renames);
        if (old.length) oldWrong[k.id] = (oldWrong[k.id] ?? 0) + old.length;
        for (const l of misPointed(k, x, renameLinks(k, x, renames), renames)) nowWrong.push(`${k.id}.${l.path.join('.')}`);
      }
    }
    expect(nowWrong).toEqual([]);
    // 这几个数记在 docs/dev/history/第49轮.md：以前 59 条引用里有 40 条没跟着改
    expect({ total, wrong: Object.values(oldWrong).reduce((a, b) => a + b, 0), oldWrong }).toEqual({
      total: 59,
      wrong: 40,
      oldWrong: { riverType: 1, cultureGroup: 6, culture: 5, popValue: 2, government: 12, faction: 3, era: 2, countryLayout: 2, landmarkType: 3, terrainClass: 1, resource: 2, pointType: 1 },
    });
  });

  it('再用一次全部跳过：改过名的那一份认得出来', () => {
    const { eng, src, plan } = collided();
    eng.exec(plan.command);
    const again = planPack(eng.world, src, defaultPicks(src));
    expect(again.added).toEqual([]);
    expect(again.command.commands).toEqual([]);
  });

  it('来源记着改名前的 id，撤销、移出时一起去掉；没改名的不记', () => {
    const { eng, plan } = collided();
    expect(eng.world.small.originId).toBeUndefined();
    eng.exec(plan.command);
    const small = eng.world.small;
    expect(originSourceId(small, 'culture', 'c1-2')).toBe('c1');
    expect(originSourceId(small, 'biome', 'b1-2')).toBe('b1');
    expect(originSourceId(small, 'culture', 'c1')).toBe('c1');
    expect(recordedOrigin(small, 'culture', 'c1-2')).toEqual(['src']);
    expect(small.originId!.culture).toEqual({ 'c1-2': 'c1' });
    // 移出后不留
    eng.exec({ op: 'set_content', kind: 'pointType', id: 'pt1-2', item: null });
    expect(eng.world.small.originId!.pointType).toBeUndefined();
    // 撤销回到没有这一项
    eng.undo();
    expect(eng.world.small.originId!.pointType).toEqual({ 'pt1-2': 'pt1' });
    eng.undo();
    expect(eng.world.small.originId).toBeUndefined();
  });

  it('只差 auto、strip 类的目标改了名不算不一样：不把写到它的政体全复制一遍；hard 类跟着改名', () => {
    const eng = bareEngine();
    const src = fullPack();
    eng.exec(planPack(eng.world, src, defaultPicks(src)).command);
    // 世界里改了文化组 g1、地名风格 s1、等级 t1：别的项和包里的一模一样
    for (const [kind, id] of [['cultureGroup', 'g1'], ['nameStyle', 's1'], ['countryTier', 't1']] as const) {
      eng.exec({ op: 'set_content', kind, id, item: { ...(eng.world.small.content![kind]![id] as object), description: '世界里改过' } });
    }
    const plan = planPack(eng.world, src, defaultPicks(src));
    expect(plan.added.map((a) => a.id).sort()).toEqual(['c1-2', 'g1-2', 's1-2', 't1-2'].sort());
    // 政体、派系、地标、时代留着世界里那份，引用世界里的 g1、t1；只有文化（组是 hard）跟着 -2
    eng.exec(plan.command);
    const w = eng.world.small.content!;
    expect((w.culture!['c1-2'] as { group: string }).group).toBe('g1-2');
    expect((w.government!.gov1 as { titles: Record<string, unknown> }).titles).toHaveProperty('t1');
    expect(danglingLinks(linkTable(worldScope(eng.world)))).toEqual([]);
  });

  it('导入另一个包：同样改名，目的地原来的项不动；以前的 addToPack 会把它们换掉', () => {
    const target = collidingPack();
    const src = fullPack();
    const { pack, added, skipped, full } = importIntoPack(target, src);
    expect(full).toEqual([]);
    expect(skipped).toEqual([]);
    expect(added.length).toBeGreaterThan(20);
    const table = linkTable(packScope(pack));
    expect(danglingLinks(table).map((b) => `${b.from.id} → ${b.link.id}`)).toEqual([]);
    for (const a of added) {
      expect(a.id).toBe(`${a.from}-2`);
      for (const r of referencesOf(table, { kind: kindByPackKey(a.section)!.id, id: a.id })) {
        if (r.target!.kind === 'dimension' || r.target!.kind === 'field') continue;
        expect(r.target!.id, `${a.id}.${r.link.path.join('.')}`).toMatch(/-2$/);
      }
    }
    for (const k of allKinds()) {
      const mine = ownItems(target, k.pack.key);
      const after = packItems(pack, k.pack.key);
      for (const x of mine) expect(after.find((y) => itemId(k, y) === itemId(k, x)), `${k.id}`).toEqual(x);
    }
    // 再导入一次全部跳过；一模一样的包导入也全部跳过
    const twice = importIntoPack(pack, src);
    expect(twice.added).toEqual([]);
    expect(importIntoPack(src, fullPack()).added).toEqual([]);
    // 对照：以前存进包的写法是整个换掉同 id 的
    const items = allKinds().filter((k) => k.pack.listed).flatMap((k) => ownItems(src, k.pack.key).map((item) => ({ kind: k.id, item })));
    const old = addToPack(target, items);
    expect(old.added).toBe(0);
    expect(old.replaced).toBeGreaterThan(20);
    // 只勾了几项：只加这几项和改名表，一个 hard 类的目标没勾时留给闭包（第六十一轮）
    const some = importIntoPack(target, src, { cultureGroups: ['g1'], cultures: ['c1'] });
    expect(some.added.map((a) => a.id)).toEqual(['g1-2', 'c1-2']);
    const c1 = packItems<{ id: string; group: string }>(some.pack, 'cultures').find((c) => c.id === 'c1-2')!;
    expect(c1.group).toBe('g1-2');
  });

  it('生成要用的内容（packImportPlan）：时代、文化组按世界里的 id 说，来源路径不变', () => {
    const eng = bareEngine();
    eng.exec(planPack(eng.world, collidingPack(), defaultPicks(collidingPack())).command);
    const src = fullPack();
    const plan = packImportPlan([{ key: 'src', pack: src }], { packs: [['src']] }, eng.world);
    expect(plan.era).toEqual({ id: 'e1-2', path: ['src'] });
    expect(plan.groups).toEqual(['g1-2']);
    eng.exec(plan.commands[0]);
    expect(recordedOrigin(eng.world.small, 'era', 'e1-2')).toEqual(['src']);
    expect(originSourceId(eng.world.small, 'era', 'e1-2')).toBe('e1');
    // 排先后的命令没有把 -2 弄丢
    expect(danglingLinks(linkTable(worldScope(eng.world)))).toEqual([]);
  });
});

describe('是不是同一项', () => {
  it('sameIgnore 写了的键不比（第五十轮的 cultureGroup.weight 写在那里）；别的种类的同名键照旧比', () => {
    const a = { id: 'g', name: '组', weight: 3 };
    const b = { id: 'g', name: '组', weight: 0 };
    const k = kindOf('cultureGroup')!;
    expect(sameContent(k, a, b)).toBe(true);
    expect(sameContent(k, a, { ...b, name: '别的' })).toBe(false);
    expect(sameContent(kindOf('culture')!, { id: 'c', weight: 1 }, { id: 'c', weight: 2 })).toBe(false);
    // 导入时算同一项：跳过，不改名
    const eng = bareEngine();
    const item = { id: 'g', name: '组', color: '#999999' };
    eng.exec({ op: 'set_content', kind: 'cultureGroup', id: 'g', item });
    const p: ResourcePack = { format: 'map2-pack', version: 1, id: 'p', name: 'p', cultureGroups: [{ ...item, weight: 3 }] };
    const plan = planPack(eng.world, p, { cultureGroups: ['g'] });
    expect(plan.skipped.map((s) => s.id)).toEqual(['g']);
    expect(plan.added).toEqual([]);
    // 导入到包也一样
    const there: ResourcePack = { format: 'map2-pack', version: 1, id: 't', name: 't', cultureGroups: [{ ...item, weight: 0 }] };
    expect(importIntoPack(there, p, { cultureGroups: ['g'] }).skipped.map((s) => s.id)).toEqual(['g']);
  });
});

describe('别的地方也用这张表', () => {
  it('renameLinks：没有真的改名时给回原来的对象；only 只换这一类', () => {
    const p = fullPack();
    const c = ownItems<Record<string, any>>(p, 'cultures')[0];
    const same: Renames = { biomes: new Map(), riverTypes: new Map(), lakeTypes: new Map(), cultureGroups: new Map([['g1', 'g1']]) };
    expect(renameLinks('culture', c, same)).toBe(c);
    const r: Renames = { biomes: new Map(), riverTypes: new Map(), lakeTypes: new Map(), cultureGroups: new Map([['g1', 'g9']]), nameStyles: new Map([['s1', 's9']]) };
    expect(renameLinks('culture', c, r).nameStyle).toBe('s9');
    expect(renameLinks('culture', c, r, 'hard').nameStyle).toBe('s1');
    expect(renameLinks('culture', c, r, 'hard').group).toBe('g9');
    expect(c.group).toBe('g1');
    // 键的先后不变
    const lm = ownItems<Record<string, any>>(p, 'landmarkTypes')[0];
    const m = renameLinks('landmarkType', lm, { biomes: new Map(), riverTypes: new Map(), lakeTypes: new Map(), cultures: new Map([['c1', 'c9']]) });
    expect(Object.keys(m.label)).toEqual(['c9', 'g1', 'default']);
    // renamedItem：换 id 按种类自己的写法，名字带编号
    expect(renamedItem(kindOf('culture')!, c, 'c1-2', r)).toMatchObject({ id: 'c1-2', group: 'g9', nameStyle: 's9' });
  });

  it('整理本世界：自定义场有没有内容写到，按引用表（注释、说明里的不算）', () => {
    const eng = bareEngine();
    eng.exec({ op: 'add_field', name: 'used' });
    eng.exec({ op: 'add_field', name: 'idle' });
    eng.exec({ op: 'set_river_type', type: kindOf('riverType')!.schema.parse({ id: 'r', name: '河', color: '#aa0000', scripts: { match: { api: 1, src: "// field('idle')\nreturn field('used') > 0;" } } }) as never });
    // 这种河在地图上有（推导里第 0 种的编号是 1）：写到的场才算还有内容用着
    const unused = unusedContent({ small: eng.world.small, causes: eng.world.causes, derived: { ...eng.world.derived, riverType: Uint8Array.of(1) } }).filter((x) => x.kind === 'field').map((x) => x.id);
    expect(unused).toEqual(['idle']);
  });
});
