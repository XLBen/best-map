import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { danglingLinks, linkTable, worldScope } from '../content/links';
import { digest } from '../digest';
import { Engine } from '../engine';
import { worldCultureGroups, worldCultures } from '../human/era';
import { countryFactions } from '../human/country-layers';
import { governmentById, governmentFactions, worldGovernments } from '../human/government';
import type { PackNode, ResourcePack } from '../packs';
import { NO_CURRENTS, engineFor, humanDigest } from '../testing/fixtures';
import { builtinPacks, worldPartsOf } from './builtin-tree';
import { ERA_PACKS } from './eras';
import { type PackRoot, packImportCommands } from './import';
import { librarySwitchPlan, worldLibrary } from './switch';

// 第五十二轮：已有的世界换一个库。门槛：换库的结果和用新库新建逐值相同（省份除外，见下）；从别的库单独加的、自己做的留着并参与生成；
// 撤销回到原样。
//
// 省份不算内容，换库不动它：旧国家切出来的省份留着（“只切不并”，用户可能改过）。所以 provinces 这一项和直接新建的不同；
// 有联邦的时代（近现代、现代、科幻）联邦分邦时看省份（blocs.ts “整省归格数最多的那一邦”），分邦的结果也跟着不同（人口、国家、城市差一点）。
// 这里分两种比：一种比直接新建的世界（十三项，有联邦的时代比不了）；一种让新建的世界先有同样的省份，划分和十三项逐值相同
// （切出来的新省的名字看生成前的推导，旧文化还在里面，所以省名那一项还是不同）：这就是说，除了省份，旧库什么都没留下。

const LIB = builtinPacks();
const ROOTS: PackRoot[] = LIB.map((p) => ({ key: p.id, pack: p }));
// 库默认带的文化组（第七十七轮：命令只写 id，各组占多少是组的比重，库里的组带着它）
const defaultsOf = (id: string) => ERA_PACKS.get(id)!.cultures.map(([g]) => g);
const allButProvinces = (d: Record<string, string>) => {
  const { provinces: _, ...rest } = d;
  return rest;
};

// 地形和世界的底子。世界的底子来自第一个库（和向导一样）。
// 第五十七轮：奇幻库新建时另带奇幻的生态、河、湖，但换库不带（它们改的是地图），所以这里对照的新建不要那三个小包，“换库 = 新建”比的是人文。
const FANTASY_EXTRAS = ['biomes', 'rivers', 'lakes'];
function terrain(from: string): Engine {
  const eng = engineFor({ cells: 6000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
  for (const c of packImportCommands(LIB, { packs: worldPartsOf(from).filter((p) => !FANTASY_EXTRAS.includes(p[1])), groups: [] }, eng.world)) eng.exec(c);
  eng.exec(NO_CURRENTS);
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
  return eng;
}
function generate(eng: Engine, id: string): Engine {
  const groups = defaultsOf(id);
  for (const c of packImportCommands(LIB, { packs: [[id]], groups }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [[id]], groups, countries: {}, settlements: {} });
  return eng;
}
const fresh = (id: string): Engine => generate(terrain(id), id);

// 换库的命令（界面发的那一条，见 src/ui/human.ts）
function switchCommand(eng: Engine, to: string, extraGroups: readonly string[] = []): { cmd: Command; plan: ReturnType<typeof librarySwitchPlan> } {
  const groups = [...defaultsOf(to), ...extraGroups];
  const plan = librarySwitchPlan(ROOTS, eng.world.small, worldLibrary(eng.world.small), to, groups);
  return { plan, cmd: { op: 'batch', label: '换库', commands: [...plan.imports, { op: 'regenerate_human', packs: [[to]], groups, keepManual: false, countries: {}, switchLibrary: { drop: plan.drop, rehome: plan.rehome } }] } };
}
function switched(from: string, to: string): Engine {
  const eng = fresh(from);
  eng.exec(switchCommand(eng, to).cmd);
  return eng;
}

// 直接用 to 新建，但省份和 from 的世界一样（from 的国家切出来的都在）
function freshOnProvincesOf(from: string, to: string): Engine {
  const a = fresh(from);
  const eng = terrain(to);
  eng.world.causes.province.set(a.world.causes.province);
  eng.world.small.provinces = structuredClone(a.world.small.provinces);
  eng.world.small.nextProvince = a.world.small.nextProvince;
  return generate(eng, to);
}

const contentDigest = (e: Engine) => Object.fromEntries(Object.entries(e.world.small.content ?? {}).map(([k, v]) => [k, digest(v)]));
const GEN_KINDS = ['era', 'valueGroup', 'popValue', 'government', 'faction', 'resource', 'cultureGroup', 'culture', 'nameStyle', 'landmarkType', 'cityRank', 'pointType'];
const genContent = (e: Engine) => Object.fromEntries(GEN_KINDS.map((k) => [k, contentDigest(e)[k] ?? null]));

describe('换库 = 用新库新建', () => {
  for (const [a, b] of [['medieval', 'fantasy'], ['fantasy', 'medieval'], ['antiquity', 'medieval'], ['modern', 'medieval']] as const) {
    it(`${a} → ${b}：除了省份，十三项摘要和直接新建逐值相同；世界里的内容（含先后）也相同`, () => {
      const x = switched(a, b);
      const y = fresh(b);
      expect(allButProvinces(humanDigest(x.world))).toEqual(allButProvinces(humanDigest(y.world)));
      expect(genContent(x)).toEqual(genContent(y));
      expect(worldGovernments(x.world.small).map((g) => g.id)).toEqual(worldGovernments(y.world.small).map((g) => g.id));
      expect(x.world.small.genStamp).toEqual({ packs: [[b]] });
      expect(danglingLinks(linkTable(worldScope(x.world))).filter((l) => l.link.cls === 'hard')).toEqual([]);
    });
  }

  for (const [a, b] of [['medieval', 'modern'], ['medieval', 'fantasy'], ['medieval', 'industrial'], ['modern', 'scifi']] as const) {
    it(`${a} → ${b}：新建的世界先有同样的省份时，省份的划分和十三项摘要全部相同（联邦分邦看省份，别的不看）；内容也相同`, () => {
      const x = switched(a, b);
      const y = freshOnProvincesOf(a, b);
      expect(allButProvinces(humanDigest(x.world))).toEqual(allButProvinces(humanDigest(y.world)));
      expect(digest(x.world.causes.province)).toBe(digest(y.world.causes.province));
      expect(genContent(x)).toEqual(genContent(y));
    });
  }

  // 差的是新建的那一边：生成人文之前起名时这条河用的办法和生成之后一样，它留着生成之前的名字（core/features.ts 的 keptNames）
  it('到青铜与古典（medieval、modern → antiquity）：只有一条河的名字和新建的不同（新建的世界留着生成之前的名字），别的相同', () => {
    for (const a of ['medieval', 'modern']) {
      const x = switched(a, 'antiquity');
      const y = fresh('antiquity');
      const { features: _x, ...dx } = allButProvinces(humanDigest(x.world));
      const { features: _y, ...dy } = allButProvinces(humanDigest(y.world));
      expect(dx).toEqual(dy);
      expect(genContent(x)).toEqual(genContent(y));
      const names = (e: Engine) => e.world.derived.features.map((f) => `${f.key}=${f.name}`);
      const other = new Set(names(y));
      expect(names(x).filter((n) => !other.has(n)).length).toBeLessThanOrEqual(1);
    }
  });

  it('medieval → modern：和直接新建比，内容逐值相同；只有省份和跟着省份的联邦有差别，差别很小', () => {
    const x = switched('medieval', 'modern');
    const y = fresh('modern');
    expect(genContent(x)).toEqual(genContent(y));
    const a = humanDigest(x.world);
    const b = humanDigest(y.world);
    const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
    expect(diff).toContain('provinces');
    for (const k of ['popGroups', 'blocs', 'features', 'habitability', 'terrainClass', 'resource']) expect(a[k], k).toBe(b[k]);
    // 国家的个数相同，文化、政体一样；不同的是联邦里的几个成员
    const ca = Object.values(x.world.small.countries!);
    const cb = Object.values(y.world.small.countries!);
    expect(ca.map((c) => [c.primaryCulture, c.government])).toEqual(cb.map((c) => [c.primaryCulture, c.government]));
    const owner = x.world.causes.country!;
    const other = y.world.causes.country!;
    let moved = 0;
    for (let i = 0; i < owner.length; i++) if (owner[i] !== other[i]) moved++;
    expect(moved / owner.length).toBeLessThan(0.02);
  });

  it('连着换（中世纪 → 现代 → 奇幻 → 中世纪）：两边都有的项来源改写了，下一次照样认得；内容和直接新建相同', () => {
    const x = switched('medieval', 'modern');
    expect(x.world.small.origin!.government[worldGovernments(x.world.small)[0].id][0]).toBe('modern');
    x.exec(switchCommand(x, 'fantasy').cmd);
    expect(genContent(x)).toEqual(genContent(fresh('fantasy')));
    x.exec(switchCommand(x, 'medieval').cmd);
    expect(genContent(x)).toEqual(genContent(fresh('medieval')));
  });

  it('移出的数目：中世纪 → 现代、奇幻，政体不再混在一起', () => {
    const eng = fresh('medieval');
    const m = switchCommand(eng, 'modern').plan;
    const f = switchCommand(eng, 'fantasy').plan;
    expect(m.kept).toEqual([]);
    expect(f.kept).toEqual([]);
    expect(m.drop.length).toBeGreaterThan(50);
    expect(f.drop.length).toBeGreaterThan(m.drop.length);
    expect(new Set(m.drop.map((r) => r.kind))).toContain('government');
    expect(m.rehome.length).toBeGreaterThan(0);
    // 世界的底子不移不加，来源改写到新库
    expect(m.drop.filter((r) => ['biome', 'terrainClass', 'mapStyle', 'countryTier', 'islandType'].includes(r.kind))).toEqual([]);
    eng.exec(switchCommand(eng, 'modern').cmd);
    for (const [kind, id] of [['biome', 'taiga'], ['terrainClass', 'plains'], ['nameStyle', 'zh-default'], ['mapStyle', 'realistic'], ['countryTier', 'city']] as const) expect(eng.world.small.origin?.[kind]?.[id]?.[0], `${kind}:${id}`).toBe('modern');
  });

  it('奇幻可选的生态、河、湖不跟着来去：换到奇幻不带，手动加过的换走时也留着（它们改的是地图，不是人文）', () => {
    const x = switched('medieval', 'fantasy');
    expect((x.world.small.riverTypes ?? []).map((t) => t.id)).toEqual(fresh('medieval').world.small.riverTypes!.map((t) => t.id));
    expect(x.world.small.species.map((s) => s.id)).toEqual(fresh('medieval').world.small.species.map((s) => s.id));
    const y = fresh('fantasy');
    const before = y.world.small.species.length;
    for (const c of packImportCommands(LIB, { packs: [['fantasy', 'biomes'], ['fantasy', 'rivers'], ['fantasy', 'lakes']] }, y.world)) y.exec(c);
    const rivers = y.world.small.riverTypes!.length;
    expect(y.world.small.species.length).toBeGreaterThan(before);
    y.exec(switchCommand(y, 'medieval').cmd);
    expect(y.world.small.species.length).toBeGreaterThan(before);
    expect(y.world.small.riverTypes!.length).toBe(rivers);
    expect(y.world.small.human!.era).toBe('medieval');
  });
});

describe('别的来源的内容留着', () => {
  // 从第三个库加一个政体（中世纪、奇幻都没有），再自己做一个政体、文化组和文化（没有来源）；两个政体都很多见，好在生成里看到
  function withImports(): { eng: Engine; gov: string; own: string; ownGroup: string } {
    const eng = fresh('medieval');
    const medieval = new Set(worldGovernments(eng.world.small).map((g) => g.id));
    const fantasy = new Set(worldGovernments(fresh('fantasy').world.small).map((g) => g.id));
    const gov = worldGovernments(fresh('modern').world.small).find((g) => !medieval.has(g.id) && !fantasy.has(g.id) && !g.only)!;
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id, item: { ...gov, weight: 100 } as unknown as Record<string, unknown>, from: ['modern', 'governments'] });
    const own = 'my-gov';
    eng.exec({ op: 'set_content', kind: 'government', id: own, item: { ...gov, id: own, name: '我的政体', weight: 100 } as unknown as Record<string, unknown> });
    const ownGroup = 'my-group';
    const like = worldCultureGroups(eng.world.small).find((g) => g.nameStyle && g.nameStyle !== 'zh-default')!;
    eng.exec({ op: 'set_content', kind: 'cultureGroup', id: ownGroup, item: { ...like, id: ownGroup, name: '我的组' } as unknown as Record<string, unknown> });
    const { nameStyle: _, ...people } = worldCultures(eng.world.small).find((c) => c.group === like.id)!;
    eng.exec({ op: 'set_content', kind: 'culture', id: 'my-people', item: { ...people, id: 'my-people', group: ownGroup, name: '我的人' } as unknown as Record<string, unknown> });
    return { eng, gov: gov.id, own, ownGroup };
  }

  it('中世纪 → 奇幻：第三个库来的政体、自己做的政体和文化组都留着，来源不动，参与生成', () => {
    const { eng, gov, own, ownGroup } = withImports();
    const { cmd, plan } = switchCommand(eng, 'fantasy', [ownGroup]);
    expect(plan.drop.some((r) => r.id === gov || r.id === own || r.id === ownGroup || r.id === 'my-people')).toBe(false);
    eng.exec(cmd);
    const small = eng.world.small;
    expect(small.origin!.government[gov][0]).toBe('modern');
    expect(small.content!.government![own]).toBeDefined();
    expect(small.origin?.government?.[own]).toBeUndefined();
    expect(small.human!.groups.includes(ownGroup)).toBe(true);
    // 手动加的政体在国家里出现了
    const used = new Set(Object.values(small.countries!).map((c) => c.government));
    expect(used.has(gov)).toBe(true);
    expect(used.has(own)).toBe(true);
    // 自己的文化组有人
    expect(Object.values(small.popGroups!).some((t) => t.culture === 'my-people')).toBe(true);
  });

  it('中世纪 → 现代：第三个库正好是新库的，算两边都有，也留着', () => {
    const { eng, gov, own } = withImports();
    eng.exec(switchCommand(eng, 'modern').cmd);
    const small = eng.world.small;
    expect(small.content!.government![gov]).toBeDefined();
    expect(small.content!.government![own]).toBeDefined();
    const used = new Set(Object.values(small.countries!).map((c) => c.government));
    expect(used.has(gov) || used.has(own)).toBe(true);
  });

  it('自己的文化写着旧库的地名风格：风格留下，别的没人用的风格移出', () => {
    const { eng, ownGroup } = withImports();
    const style = worldCultureGroups(eng.world.small).find((g) => g.id === ownGroup)!.nameStyle!;
    const { plan } = switchCommand(eng, 'fantasy', [ownGroup]);
    expect(plan.drop.some((r) => r.kind === 'nameStyle' && r.id === style)).toBe(false);
    expect(plan.kept.some((r) => r.kind === 'nameStyle' && r.id === style)).toBe(true);
    expect(plan.drop.some((r) => r.kind === 'nameStyle')).toBe(true);
  });

  it('锁定的国家：政体、文化留下，国家还在', () => {
    const eng = fresh('medieval');
    const m = Object.values(eng.world.small.countries!)[0];
    eng.exec({ op: 'set_country', id: m.id, patch: { locked: true } });
    const { cmd, plan } = switchCommand(eng, 'fantasy');
    expect(plan.drop.some((r) => r.kind === 'government' && r.id === m.government)).toBe(false);
    expect(plan.drop.some((r) => r.kind === 'culture' && r.id === m.primaryCulture)).toBe(false);
    expect(plan.kept.some((r) => r.kind === 'culture' && r.id === m.primaryCulture)).toBe(true);
    eng.exec(cmd);
    const after = eng.world.small.countries![m.id];
    expect(after.locked).toBe(true);
    expect(after.government).toBe(m.government);
    expect(eng.world.small.content!.culture![m.primaryCulture]).toBeDefined();
  });

  // 第五十三轮：政体列的派系
  const danglingFactions = (eng: Engine) => danglingLinks(linkTable(worldScope(eng.world))).filter((d) => d.link.kinds.includes('faction'));
  it('换库后政体的派系都找得到，每个国家都有派系；没有政体列的旧派系都走了', () => {
    for (const [from, to] of [['medieval', 'modern'], ['medieval', 'fantasy'], ['modern', 'scifi'], ['scifi', 'antiquity']]) {
      const eng = switched(from, to);
      expect(danglingFactions(eng), `${from}→${to}`).toEqual([]);
      const small = eng.world.small;
      for (const m of Object.values(small.countries!)) expect(governmentFactions(small, governmentById(small, m.government)).length, `${from}→${to}: ${m.government}`).toBeGreaterThanOrEqual(2);
      const brought = new Set(ERA_PACKS.get(to)!.factions);
      expect(Object.keys(small.content!.faction!).sort()).toEqual([...brought].sort());
    }
  });
  it('锁定的国家：政体留下时它列的派系也留下，不留悬空；撤销回到原样', () => {
    const eng = fresh('medieval');
    const m = Object.values(eng.world.small.countries!).find((c) => !ERA_PACKS.get('fantasy')!.governments.includes(c.government))!;
    eng.exec({ op: 'set_country', id: m.id, patch: { locked: true } });
    const listed = governmentById(eng.world.small, m.government)!.factions!;
    const { cmd, plan } = switchCommand(eng, 'fantasy');
    // 奇幻只有贵族，别的留下
    for (const id of listed) expect(plan.drop.some((r) => r.kind === 'faction' && r.id === id), id).toBe(false);
    expect(plan.kept.some((r) => r.kind === 'faction')).toBe(true);
    eng.exec(cmd);
    expect(danglingFactions(eng)).toEqual([]);
    expect(governmentFactions(eng.world.small, governmentById(eng.world.small, m.government)).map((f) => f.id)).toEqual(listed);
    expect(countryFactions(eng.world, m.id).length).toBe(listed.length);
    // 没有政体列的旧派系走了
    const small = eng.world.small;
    const held = new Set(Object.values(small.content!.government as Record<string, { factions?: string[] }>).flatMap((g) => g.factions ?? []));
    for (const id of Object.keys(small.content!.faction!)) expect(held.has(id), id).toBe(true);
  });

  it('省份自己选的地名风格留下', () => {
    const eng = fresh('medieval');
    const style = Object.keys(eng.world.small.content!.nameStyle!).find((id) => id !== 'zh-default')!;
    const province = Number(Object.keys(eng.world.small.provinces)[0]);
    eng.exec({ op: 'set_province', id: province, style });
    const { plan } = switchCommand(eng, 'fantasy');
    expect(plan.kept.some((r) => r.kind === 'nameStyle' && r.id === style)).toBe(true);
  });
});

describe('撤销', () => {
  const state = (eng: Engine) => ({ ...humanDigest(eng.world), ...contentDigest(eng), origin: digest(eng.world.small.origin ?? null), stamp: digest(eng.world.small.genStamp ?? null), next: digest([eng.world.small.nextSettlement ?? null, eng.world.small.nextProvince ?? null, eng.world.small.nextCountry ?? null]) });
  for (const to of ['modern', 'fantasy']) {
    it(`中世纪 → ${to}：撤销回到原样，内容、来源、摘要逐值相同，重做又是换库后的`, () => {
      const eng = fresh('medieval');
      const before = state(eng);
      eng.exec(switchCommand(eng, to).cmd);
      const after = state(eng);
      expect(eng.lastRemoved.length).toBeGreaterThan(0);
      eng.undo();
      eng.update();
      expect(state(eng)).toEqual(before);
      eng.redo();
      eng.update();
      expect(state(eng)).toEqual(after);
    });
  }

  it('存成世界文件再打开：重放的结果相同（名单在命令里）', () => {
    const eng = switched('medieval', 'modern');
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(humanDigest(again.world)).toEqual(humanDigest(eng.world));
    expect(contentDigest(again)).toEqual(contentDigest(eng));
    expect(digest(again.world.small.origin ?? null)).toBe(digest(eng.world.small.origin ?? null));
  });
});

describe('我的库', () => {
  it('同一个 id 内容不同：世界里和旧库一样的换成新库的，世界里改过的不动', () => {
    const med = LIB.find((p) => p.id === 'medieval')!;
    const packs = med.packs as PackNode[];
    const govNode = packs.find((n) => n.id === 'governments')!;
    const list = govNode.governments as unknown as { id: string; name: string }[];
    const [a, b] = list;
    const mine: ResourcePack = { ...med, id: 'mine', name: '我的库', packs: packs.map((n) => (n === govNode ? { ...n, governments: list.map((g) => (g.id === a.id || g.id === b.id ? { ...g, name: `新${g.name}` } : g)) as unknown as PackNode['governments'] } : n)) };
    const roots = [...ROOTS, { key: 'mine', pack: mine }];
    const eng = fresh('medieval');
    eng.exec({ op: 'set_content', kind: 'government', id: b.id, item: { ...(eng.world.small.content!.government![b.id] as object), name: '世界里改过' } as Record<string, unknown> });
    const groups = defaultsOf('medieval');
    const plan = librarySwitchPlan(roots, eng.world.small, 'medieval', 'mine', groups);
    eng.exec({ op: 'batch', commands: [...plan.imports, { op: 'regenerate_human', packs: [['mine']], groups, keepManual: false, countries: {}, switchLibrary: { drop: plan.drop, rehome: plan.rehome } }] });
    const govs = eng.world.small.content!.government as Record<string, { name: string }>;
    expect(govs[a.id].name).toBe(`新${a.name}`);
    expect(govs[b.id].name).toBe('世界里改过');
    expect(eng.world.small.origin!.government[a.id][0]).toBe('mine');
    expect(worldLibrary(eng.world.small)).toBe('mine');
  });
});

describe('世界现在用的库', () => {
  it('有人文时是时代的来源；没有人文时是世界的底子的来源；都没有时没有', () => {
    expect(worldLibrary(fresh('fantasy').world.small)).toBe('fantasy');
    expect(worldLibrary(terrain('modern').world.small)).toBe('modern');
    expect(worldLibrary(new Engine({ cells: 2000, seed: 1 }).world.small)).toBeUndefined();
  });

  it('没有人文时换库（第一次生成）：generate_human 带着名单，和新建相同', () => {
    const eng = terrain('medieval');
    const groups = defaultsOf('fantasy');
    const plan = librarySwitchPlan(ROOTS, eng.world.small, worldLibrary(eng.world.small), 'fantasy', groups);
    eng.exec({ op: 'batch', commands: [...plan.imports, { op: 'generate_human', packs: [['fantasy']], groups, countries: {}, settlements: {}, switchLibrary: { drop: plan.drop, rehome: plan.rehome } }] });
    expect(humanDigest(eng.world)).toEqual(humanDigest(fresh('fantasy').world));
    expect(genContent(eng)).toEqual(genContent(fresh('fantasy')));
  });
});
