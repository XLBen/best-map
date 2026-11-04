import { describe, expect, it } from 'vitest';
import { arrangeOf, relationOf } from '../content/arrange';
import { danglingLinks, linkTable, packScope } from '../content/links';
import { itemId, kindOf } from '../content/registry';
import { sameContent } from '../content/refs';
import { type PackNode, type PackWorld, PACK_FORMAT, PACK_VERSION, type ResourcePack, packItems, packSections, parsePack } from '../packs';
import { builtinPacks } from './builtin-tree';
import { type ImportAsk, type ImportTarget, importPreview, importToPack } from './closure';

// 第六十一轮：依赖闭包。内置的数据（社会主义共和国、伊克塔……）和写满引用的小包都试

const LIB = builtinPacks();
const top = (id: string): PackNode => LIB.find((p) => p.id === id)!;
const ref = (kind: string, id: string) => ({ kind, id });

const pack = (id: string, parts: Record<string, unknown> = {}): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, ...parts });
const packTarget = (p: ResourcePack): ImportTarget => ({ t: 'pack', pack: p });
// 一个库的副本当目的地（树是同一份）
const copyOf = (id: string): ResourcePack => ({ ...(top(id) as ResourcePack), format: PACK_FORMAT, version: PACK_VERSION, id: `${id}-mine`, name: `${id}的副本` });
const rowIds = (rows: readonly { kind: string; id: string }[]) => rows.map((r) => `${r.kind}:${r.id}`).sort();

const GOV = { category: ['monarchy'], titles: '王国', size: 1, expansion: 0.3, coastal: 0, urbanization: 1, cohesion: 0.5, vassals: 0.2, nomadic: 0 };
const ERA = { popDensity: 2, sparsity: 1.5, urbanization: 0.1, unclaimed: { minHabitability: 0.05, nomads: 0.3 }, seaClaimKm: 0 };

// 来源：一个政体 g，限 a 组用；换说法写到 b 组；派系 f（来源写 ideo 和 nat 两维，ideo 权重大）
function sourcePack(): ResourcePack {
  return pack('src', {
    eras: [{ id: 'e', name: '时代', dimensions: [{ id: 'religion', label: '宗教' }, { id: 'ideo', label: '意识形态' }, { id: 'nat', label: '民族' }], ...ERA }],
    popValues: [
      { id: 'v1', dimension: 'ideo', name: '左', color: '#111111' },
      { id: 'v2', dimension: 'ideo', name: '右', color: '#222222' },
      { id: 'n1', dimension: 'nat', name: '公民', color: '#333333' },
      { id: 'r1', dimension: 'religion', name: '太阳教', color: '#444444' },
    ],
    nameStyles: [{ id: 's', kind: 'template', name: '风格', lists: {}, types: {} }],
    cultureGroups: [
      { id: 'a', name: '甲组', color: '#555555', weight: 3, nameStyle: 's' },
      { id: 'b', name: '乙组', color: '#666666', weight: 2 },
      { id: 'z', name: '零组', color: '#777777', weight: 0 },
    ],
    cultures: [
      { id: 'a1', group: 'a', name: '甲一', color: '#888888' },
      { id: 'a2', group: 'a', name: '甲二', color: '#999999' },
      { id: 'z1', group: 'z', name: '零一', color: '#aaaaaa' },
    ],
    factions: [{ id: 'f', name: '派系', color: '#bbbbbb', amount: 1, drivers: [{ dimension: 'ideo', value: 'v1', weight: 4 }, { dimension: 'nat', value: 'n1', weight: 1 }, { coastal: true, weight: 0.3 }] }],
    governments: [{ id: 'g', name: '政体', ...GOV, factions: ['f'], only: [{ cultureGroups: ['a'] }], names: [{ cultureGroups: ['b'], titles: '说法' }] }],
  });
}
const dest = (parts: Record<string, unknown> = {}) => pack('dst', { eras: [{ id: 'mine', name: '我的时代', dimensions: [{ id: 'religion', label: '宗教' }], ...ERA }], ...parts });
const ask = (target: ResourcePack, picks: ImportAsk['picks'], more: Partial<ImportAsk> = {}): ImportAsk => ({ source: sourcePack(), target: packTarget(target), picks, ...more });

describe('闭包：还会带上什么，为什么', () => {
  it('政体带上派系、变量、限谁用的组；每一项写为什么', () => {
    const p = importPreview(ask(dest(), [ref('government', 'g')]));
    expect(rowIds(p.picks)).toEqual(['government:g']);
    expect(rowIds(p.bring)).toEqual(['cultureGroup:a', 'dimension:ideo', 'faction:f', 'nameStyle:s'].sort());
    const why = (id: string) => p.bring.find((r) => r.id === id)!.why;
    expect(why('f')).toEqual(['政体 需要 派系']);
    expect(why('ideo')).toEqual(['派系 需要 意识形态']);
    expect(why('a')).toEqual(['政体 需要 甲组']);
    expect(why('s')).toEqual(['甲组 需要 风格']);
    // 变量带上全部取值，不单独列，算一项
    expect(p.bring.find((r) => r.id === 'ideo')).toMatchObject({ kind: 'dimension', count: 2, kindLabel: '变量' });
    expect(p.count).toBe(5);
    expect(p.dims.map((d) => d.id)).toEqual(['ideo']);
    expect(p.dims[0]).toMatchObject({ required: true, added: true });
  });

  it('派系主要靠的变量才跟着来；别的列在可选里，默认不勾，来源去掉', () => {
    const p = importPreview(ask(dest(), [ref('faction', 'f')]));
    expect(rowIds(p.bring)).toEqual(['dimension:ideo']);
    expect(rowIds(p.optional)).toEqual(['dimension:nat']);
    expect(p.optional[0].why).toEqual(['派系 写到 民族']);
    expect(p.stripped.map((s) => [s.label, s.target])).toEqual([['来自人口', '公民']]);
    const r = importToPack(ask(dest(), [ref('faction', 'f')]));
    expect((packItems<{ id: string; drivers: unknown[] }>(r.pack, 'factions')[0]).drivers).toEqual([{ dimension: 'ideo', value: 'v1', weight: 4 }, { coastal: true, weight: 0.3 }]);
    // 勾上可选的：多一个变量，来源留着
    const on = importToPack(ask(dest(), [ref('faction', 'f')], { on: [ref('dimension', 'nat')] }));
    expect(on.preview.dims.map((d) => d.id).sort()).toEqual(['ideo', 'nat']);
    expect((packItems<{ id: string; drivers: unknown[] }>(on.pack, 'factions')[0]).drivers).toHaveLength(3);
  });

  it('真实的数据：社会主义共和国带上革命左翼、自由派和意识形态，不带民族认同', () => {
    const p = importPreview({ source: top('modern'), target: packTarget(copyOf('fantasy')), picks: [ref('government', 'socialist-republic')] });
    expect(rowIds(p.bring.filter((r) => r.state !== 'off'))).toEqual(['dimension:ideology', 'faction:liberals', 'faction:revolutionary-left'].sort());
    expect(rowIds(p.optional)).toEqual(['dimension:nation']);
    expect(p.renamed).toEqual([]);
    expect(p.dims.map((d) => d.id)).toEqual(['ideology']);
    // 称号的键（国家等级）目的地有，没有去掉；一个文化组也没带
    expect(p.bring.some((r) => r.kind === 'cultureGroup')).toBe(false);
  });

  it('names 和称号的键缺了就去掉，不带文化组', () => {
    const src: ResourcePack = pack('s', {
      cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }, { id: 'y', name: '亥', color: '#222222' }],
      countryTiers: [{ id: 't', name: '等级', weight: 1 }],
      governments: [{ id: 'g', name: '政体', ...GOV, titles: { t: '公国', u: '王国' }, names: [{ cultureGroups: ['x'], titles: '说法' }, { cultureGroups: ['y'], titles: '说法二' }] }],
    });
    const p = importPreview({ source: src, target: packTarget(pack('d', { cultureGroups: [{ id: 'y', name: '世界里的亥', color: '#333333' }] })), picks: [ref('government', 'g')] });
    expect(p.bring).toEqual([]);
    const r = importToPack({ source: src, target: packTarget(pack('d', { cultureGroups: [{ id: 'y', name: '世界里的亥', color: '#333333' }] })), picks: [ref('government', 'g')] });
    const g = packItems<{ names: unknown; titles: unknown }>(r.pack, 'governments')[0];
    // x 去掉了（整条规则），y 目的地有同 id 的（留着，指到目的地那一份）；键都没了时称号换成第一种写法
    expect(g.names).toEqual([{ cultureGroups: ['y'], titles: '说法二' }]);
    expect(g.titles).toBe('公国');
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });
});

describe('取消依赖', () => {
  it('only 依赖自动勾上；取消就解除限制（整条规则去掉），界面上有一句话', () => {
    const on = importPreview(ask(dest(), [ref('government', 'g')]));
    expect(on.bring.find((r) => r.id === 'a')).toMatchObject({ cls: 'auto', offNote: '取消后解除这条限制，谁都能用' });
    const r = importToPack(ask(dest(), [ref('government', 'g')], { off: [ref('cultureGroup', 'a')] }));
    const g = packItems<{ only?: unknown }>(r.pack, 'governments')[0];
    expect(g.only).toBeUndefined();
    expect(packItems(r.pack, 'cultureGroups')).toEqual([]);
    // 也不再带它的风格；取消的一行还在，能勾回来
    expect(r.preview.bring.find((x) => x.id === 'a')?.state).toBe('off');
    expect(packItems(r.pack, 'nameStyles')).toEqual([]);
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });

  it('取消派系：政体的名单去掉它；取消变量：来源去掉，取值不带', () => {
    const noF = importToPack(ask(dest(), [ref('government', 'g')], { off: [ref('faction', 'f')] }));
    expect(packItems<{ factions?: string[] }>(noF.pack, 'governments')[0].factions).toBeUndefined();
    expect(noF.preview.dims).toEqual([]);
    const noDim = importToPack(ask(dest(), [ref('government', 'g')], { off: [ref('dimension', 'ideo')] }));
    expect(packItems<{ drivers?: unknown[] }>(noDim.pack, 'factions')[0].drivers).toEqual([{ coastal: true, weight: 0.3 }]);
    expect(packItems(noDim.pack, 'popValues')).toEqual([]);
    expect(noDim.preview.dims).toEqual([]);
    expect(noDim.preview.blocked).toEqual([]);
    expect(danglingLinks(linkTable(packScope(noDim.pack)))).toEqual([]);
  });

  it('去不掉的引用（文化的组）：依赖锁着，不能取消；真的取消了这一项也带不了', () => {
    const p = importPreview(ask(dest(), [ref('culture', 'a1')]));
    expect(p.bring.find((r) => r.id === 'a')).toMatchObject({ cls: 'hard', locked: '少了它“甲一”用不了' });
    const off = importPreview(ask(dest(), [ref('culture', 'a1')], { off: [ref('cultureGroup', 'a')] }));
    expect(off.blocked.map((r) => r.id)).toEqual(['a1']);
    expect(off.count).toBe(0);
    const r = importToPack(ask(dest(), [ref('culture', 'a1')], { off: [ref('cultureGroup', 'a')] }));
    expect(packItems(r.pack, 'cultures')).toEqual([]);
  });

  it('目的地有同 id 的依赖，取消时指到目的地那一份', () => {
    const there = dest({ factions: [{ id: 'f', name: '我的派系', color: '#000000', amount: 2 }] });
    const r = importToPack(ask(there, [ref('government', 'g')], { off: [ref('faction', 'f')] }));
    expect(packItems<{ id: string; factions?: string[] }>(r.pack, 'governments')[0].factions).toEqual(['f']);
    expect(packItems<{ id: string; name: string }>(r.pack, 'factions')).toEqual([{ id: 'f', name: '我的派系', color: '#000000', amount: 2 }]);
  });
});

describe('文化组的比重', () => {
  it('依赖带来的组 weight 是 0；勾的组留着，比重是 0 的去掉这个 0', () => {
    const dep = importToPack(ask(dest(), [ref('government', 'g')]));
    expect(packItems<{ id: string; weight?: number }>(dep.pack, 'cultureGroups').map((g) => [g.id, g.weight])).toEqual([['a', 0]]);
    const picked = importToPack(ask(dest(), [ref('cultureGroup', 'a'), ref('cultureGroup', 'z')]));
    expect(packItems<{ id: string; weight?: number }>(picked.pack, 'cultureGroups').map((g) => [g.id, g.weight])).toEqual([['a', 3], ['z', undefined]]);
  });

  it('勾组带上组里的文化；依赖带来的组不带（否则一个政体拖来一堆）', () => {
    const picked = importPreview(ask(dest(), [ref('cultureGroup', 'a')]));
    expect(rowIds(picked.bring)).toEqual(['culture:a1', 'culture:a2', 'nameStyle:s'].sort());
    expect(picked.bring.find((r) => r.id === 'a1')).toMatchObject({ cls: 'member', why: ['甲组 里的'] });
    const dep = importPreview(ask(dest(), [ref('government', 'g')]));
    expect(dep.bring.some((r) => r.kind === 'culture')).toBe(false);
    // 能单独取消组里的一个
    const off = importToPack(ask(dest(), [ref('cultureGroup', 'a')], { off: [ref('culture', 'a2')] }));
    expect(packItems<{ id: string }>(off.pack, 'cultures').map((c) => c.id)).toEqual(['a1']);
  });

  it('是不是同一项不看 weight：只差比重的组算已经有了，目的地的比重不动', () => {
    const there = dest({ cultureGroups: [{ id: 'b', name: '乙组', color: '#666666', weight: 9 }] });
    const k = kindOf('cultureGroup')!;
    expect(sameContent(k, { id: 'b', weight: 9 }, { id: 'b', weight: 2 })).toBe(true);
    const p = importPreview(ask(there, [ref('cultureGroup', 'b')]));
    expect(p.have.map((r) => r.id)).toEqual(['b']);
    expect(p.renamed).toEqual([]);
    expect(p.count).toBe(0);
    const r = importToPack(ask(there, [ref('cultureGroup', 'b')]));
    expect(packItems<{ weight: number }>(r.pack, 'cultureGroups')[0].weight).toBe(9);
    // 依赖带来的（写了 0）再导入也认得出来
    const once = importToPack(ask(dest(), [ref('government', 'g')]));
    expect(importToPack(ask(once.pack, [ref('government', 'g')])).preview.count).toBe(0);
  });
});

describe('已经有了', () => {
  it('从一个库导入它的副本：一项都不加（文化写着别的时代的倾向，来源那份也写着，不算不同）', () => {
    const med = top('medieval');
    const all = packSections().flatMap((k) => packItems(med, k.pack.key).map((x) => ref(k.id, itemId(k, x))));
    const p = importPreview({ source: med, target: packTarget(copyOf('medieval')), picks: all });
    expect(p.count).toBe(0);
    expect(p.renamed).toEqual([]);
    expect(p.have.length).toBe(all.length);
    expect(p.stripped).toEqual([]);
  });
});

describe('撞名', () => {
  it('内容不同、id 相同时改名，所有引用跟着改；目的地原来的不动', () => {
    const there = dest({
      factions: [{ id: 'f', name: '我的派系', color: '#000000', amount: 2 }],
      cultureGroups: [{ id: 'a', name: '我的组', color: '#000000' }],
    });
    const r = importToPack(ask(there, [ref('government', 'g')]));
    expect(r.preview.renamed.map((x) => [x.id, x.to]).sort()).toEqual([['a', 'a-2'], ['f', 'f-2']]);
    const g = packItems<{ factions: string[]; only: { cultureGroups: string[] }[] }>(r.pack, 'governments')[0];
    expect(g.factions).toEqual(['f-2']);
    expect(g.only).toEqual([{ cultureGroups: ['a-2'] }]);
    expect(packItems<{ id: string; name: string }>(r.pack, 'factions').find((f) => f.id === 'f')!.name).toBe('我的派系');
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
    // 再导入一次全部已经有了
    const again = importPreview(ask(r.pack, [ref('government', 'g')]));
    expect(again.count).toBe(0);
    expect(again.renamed).toEqual([]);
  });

  it('变量里的取值撞名也改名；目的地已有的变量不再加', () => {
    const there = pack('d', {
      eras: [{ id: 'mine', name: '我的', dimensions: [{ id: 'ideo', label: '我的意识形态' }], ...ERA }],
      popValues: [{ id: 'v1', dimension: 'ideo', name: '我的左', color: '#000000' }],
    });
    const p = importPreview(ask(there, [ref('faction', 'f')]));
    expect(p.dims).toEqual([]);
    // 变量目的地有：来源写到的取值单独跟着来
    expect(rowIds(p.bring)).toEqual(['popValue:v1']);
    expect(p.bring[0]).toMatchObject({ state: 'rename', to: 'v1-2' });
    const r = importToPack(ask(there, [ref('faction', 'f')]));
    const f = packItems<{ drivers: { value?: string }[] }>(r.pack, 'factions')[0];
    expect(f.drivers[0].value).toBe('v1-2');
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });
});

describe('写进库', () => {
  it('变量写进目的地的时代（added），取值放进同一维的小包；来源的时代不带', () => {
    const r = importToPack(ask(dest(), [ref('government', 'g')]));
    const eras = packItems<{ id: string; dimensions: unknown[] }>(r.pack, 'eras');
    expect(eras.map((e) => e.id)).toEqual(['mine']);
    expect(eras[0].dimensions).toEqual([{ id: 'religion', label: '宗教' }, { id: 'ideo', label: '意识形态', required: true, added: true }]);
    expect(packItems<{ id: string }>(r.pack, 'popValues').map((v) => v.id).sort()).toEqual(['v1', 'v2']);
    expect(parsePack(r.pack).ok).toBe(true);
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });

  it('目的地没有时代：带上提供这个变量的时代', () => {
    const p = importPreview(ask(pack('empty'), [ref('faction', 'f')]));
    expect(rowIds(p.bring)).toEqual(['dimension:ideo', 'era:e'].sort());
    expect(p.bring.find((r) => r.id === 'e')!.why).toEqual(['意识形态 写在 时代 里']);
    expect(p.dims).toEqual([]);
    const r = importToPack(ask(pack('empty'), [ref('faction', 'f')]));
    expect(packItems<{ id: string }>(r.pack, 'eras').map((e) => e.id)).toEqual(['e']);
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
    // 不要这个时代：变量也不带，来源去掉
    const off = importToPack(ask(pack('empty'), [ref('faction', 'f')], { off: [ref('era', 'e')] }));
    expect(packItems(off.pack, 'eras')).toEqual([]);
    expect(packItems<{ drivers?: unknown[] }>(off.pack, 'factions')[0].drivers).toEqual([{ coastal: true, weight: 0.3 }]);
    expect(danglingLinks(linkTable(packScope(off.pack)))).toEqual([]);
  });

  it('文化组放进“文化”下面自己的小包，文化跟着组（新世界才带得上）', () => {
    const r = importToPack({ source: sourcePack(), target: packTarget(copyOf('medieval')), picks: [ref('cultureGroup', 'a')] });
    const cultures = (r.pack.packs ?? []).find((n) => n.id === 'cultures')!;
    const sub = (cultures.packs ?? []).find((n) => n.id === 'a')!;
    expect(sub).toMatchObject({ weight: 1 });
    expect((sub.cultures as { id: string }[]).map((c) => c.id)).toEqual(['a1', 'a2']);
    // 原来的库不动，没碰的小包是同一个对象
    const before = top('medieval');
    expect((before.packs ?? []).find((n) => n.id === 'cultures')!.packs!.some((n) => n.id === 'a')).toBe(false);
    expect((r.pack.packs ?? []).find((n) => n.id === 'governments')).toBe((before.packs ?? []).find((n) => n.id === 'governments'));
  });

  it('arrange：导入到库时不改目的地的安排，来源的不带', () => {
    const mine = { ...dest(), arrange: { faction: 'government' } } as ResourcePack;
    const src = { ...sourcePack(), arrange: { culture: 'cultureGroup', resource: 'terrainClass' } } as ResourcePack;
    const r = importToPack({ source: src, target: packTarget(mine), picks: [ref('government', 'g')] });
    expect(r.pack.arrange).toEqual({ faction: 'government' });
    expect(arrangeOf(r.pack)).toEqual(mine.arrange);
    const preset = dest();
    expect(importToPack({ source: src, target: packTarget(preset), picks: [ref('government', 'g')] }).pack.arrange).toBeUndefined();
  });

  it('放不下时不写，说明白', () => {
    const there = dest({ governments: Array.from({ length: 128 }, (_, k) => ({ id: `x${k}`, name: `x${k}`, ...GOV })) });
    const p = importToPack(ask(there, [ref('government', 'g')]));
    expect(p.preview.over).toEqual(['政体最多 128 个']);
    expect(p.pack).toBe(there);
  });

  it('上级页面选了别的库里的一项：放到这个上级下面是同一步', () => {
    const there = dest({ governments: [{ id: 'mine-g', name: '我的政体', ...GOV }] });
    const rel = relationOf('faction', 'government')!;
    const r = importToPack(ask(there, [ref('faction', 'f')]), { onto: { relation: rel, parent: 'mine-g', child: ref('faction', 'f') } });
    expect(packItems<{ factions?: string[] }>(r.pack, 'governments')[0].factions).toEqual(['f']);
  });
});

describe('世界', () => {
  it('星球形态不能用到世界，勾了也不算', () => {
    const world = { small: { species: [], featureNames: {}, provinces: {} }, causes: { fields: {} } } as unknown as PackWorld;
    const form = packItems<{ id: string }>(top('medieval'), 'planetForms')[0];
    const p = importPreview({ source: top('medieval'), target: { t: 'world', world }, picks: [ref('planetForm', form.id)] });
    expect(p.count).toBe(0);
    expect(p.picks).toEqual([]);
  });
});
