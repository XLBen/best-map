import { describe, expect, it } from 'vitest';
import { arrangeOf, relationOf } from '../content/arrange';
import { danglingLinks, linkTable, packScope } from '../content/links';
import { itemId, kindOf } from '../content/registry';
import { sameContent } from '../content/refs';
import { type PackNode, type PackWorld, PACK_FORMAT, PACK_VERSION, type ResourcePack, packItems, packSections, parsePack } from '../packs';
import { builtinPacks } from './builtin-tree';
import { engineFor } from '../testing/fixtures';
import { type ImportAsk, type ImportRow, type ImportTarget, importCommand, importGates, importPreview, importToPack } from './closure';
import { packImportCommands } from './import';

// 第六十一轮：导入的闭包；第六十四轮改成“能选的才让选，勾什么进什么”。内置的数据（社会主义共和国、伊克塔……）和写满引用的小包都试

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
    valueGroups: [{ id: 'vg', dimension: 'ideo', name: '值组', color: '#101010' }],
    popValues: [
      { id: 'v1', dimension: 'ideo', group: 'vg', name: '左', color: '#111111' },
      { id: 'v2', dimension: 'ideo', group: 'vg', name: '右', color: '#222222' },
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
const row = (rows: readonly ImportRow[], id: string) => rows.find((r) => r.id === id)!;
// 目的地已经有 ideo 变量（政体、派系才能选）
const withIdeo = (parts: Record<string, unknown> = {}) => pack('dst', { eras: [{ id: 'mine', name: '我的时代', dimensions: [{ id: 'religion', label: '宗教' }, { id: 'ideo', label: '意识形态' }], ...ERA }], ...parts });

describe('能不能选', () => {
  it('派系主要靠的变量没有：灰，写明要什么；勾上这个变量马上能选', () => {
    const g = importGates(sourcePack(), packTarget(dest()));
    expect(g.of(ref('faction', 'f'))).toMatchObject({ t: 'gated', reason: '需要意识形态', needs: [{ kind: 'dimension', id: 'ideo', name: '意识形态' }] });
    // 民族认同不是它主要靠的，不要
    expect(importGates(sourcePack(), packTarget(withIdeo())).of(ref('faction', 'f')).t).toBe('free');
    const on = importGates(sourcePack(), packTarget(dest()), [ref('dimension', 'ideo')]);
    expect(on.of(ref('faction', 'f')).t).toBe('free');
    // 勾一个取值也会加这个变量
    expect(importGates(sourcePack(), packTarget(dest()), [ref('popValue', 'v2')]).of(ref('faction', 'f')).t).toBe('free');
  });

  // 第六十六轮：点灰的行把要的一起勾上。要的东西在这个来源里勾得到才行
  it('灰的写明能不能把要的一起勾上（resolvable）；几选一时 choices 是勾得到的那几个', () => {
    const g = importGates(sourcePack(), packTarget(dest()));
    expect(g.of(ref('faction', 'f'))).toMatchObject({ t: 'gated', resolvable: true, choices: [{ kind: 'dimension', id: 'ideo' }] });
    expect(g.of(ref('government', 'g'))).toMatchObject({ t: 'gated', resolvable: true });
    // 限谁用：戌在来源里、亥不在（写到别的库的组）
    const src = pack('s', { cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }], governments: [{ id: 'g', name: '政体', ...GOV, only: [{ cultureGroups: ['x'] }, { cultureGroups: ['y'] }] }, { id: 'n', name: '没有', ...GOV, only: [{ cultureGroups: ['y'] }] }] });
    const gates = importGates(src, packTarget(dest()));
    expect(gates.of(ref('government', 'g'))).toMatchObject({ t: 'gated', any: true, resolvable: true, choices: [{ kind: 'cultureGroup', id: 'x' }] });
    // 要的东西来源里没有：勾不到
    expect(gates.of(ref('government', 'n'))).toMatchObject({ t: 'gated', resolvable: false, choices: [] });
    // 来源里没有这一项、这一种不能用：needs 是空的，勾不到
    expect(gates.of(ref('government', 'nope'))).toMatchObject({ t: 'gated', resolvable: false });
    // 目的地没有时代、来源的变量也不写在时代里：要时代，勾不到
    const loose = pack('l', { popValues: [{ id: 'v', dimension: 'd', name: '甲', color: '#111111' }] });
    expect(importGates(loose, packTarget(pack('empty'))).of(ref('dimension', 'd'))).toMatchObject({ t: 'gated', reason: '需要时代', resolvable: false });
  });

  it('政体列的派系有一个灰，政体灰；目的地有同 id 的派系时看目的地那一份', () => {
    expect(importGates(sourcePack(), packTarget(dest())).of(ref('government', 'g'))).toMatchObject({ t: 'gated', reason: '需要意识形态' });
    const there = dest({ cultureGroups: [{ id: 'a', name: '甲组', color: '#555555' }], factions: [{ id: 'f', name: '我的派系', color: '#000000', amount: 2 }] });
    expect(importGates(sourcePack(), packTarget(there)).of(ref('government', 'g')).t).toBe('free');
  });

  it('限谁用全部落空：灰；部分还在：能选，只留还在的；勾上目标解开', () => {
    const src = pack('s', { cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }, { id: 'y', name: '亥', color: '#222222' }], governments: [{ id: 'g', name: '政体', ...GOV, only: [{ cultureGroups: ['x'] }, { cultureGroups: ['y'] }] }, { id: 'h', name: '另一个', ...GOV, only: [{ cultureGroups: ['x', 'y'] }] }] });
    const empty = dest();
    const gate = importGates(src, packTarget(empty));
    expect(gate.of(ref('government', 'g'))).toMatchObject({ t: 'gated', any: true, reason: '需要戌或亥' });
    expect(importGates(src, packTarget(empty), [ref('cultureGroup', 'x')]).of(ref('government', 'g')).t).toBe('free');
    const there = dest({ cultureGroups: [{ id: 'y', name: '世界里的亥', color: '#333333' }] });
    expect(importGates(src, packTarget(there)).of(ref('government', 'g')).t).toBe('free');
    const r = importToPack({ source: src, target: packTarget(there), picks: [ref('government', 'g'), ref('government', 'h')] });
    const gs = packItems<{ id: string; only: unknown }>(r.pack, 'governments');
    expect(gs.find((x) => x.id === 'g')!.only).toEqual([{ cultureGroups: ['y'] }]);
    expect(gs.find((x) => x.id === 'h')!.only).toEqual([{ cultureGroups: ['y'] }]);
    expect(r.preview.stripCount).toBe(2);
  });

  it('地标的文化组、地形类别和资源的规则也是这样；没有引用的规则不灰', () => {
    const LM = { category: 'manmade', icon: 'monument', place: 'capital', per: 'country', count: 1, chance: 1, label: '{city}碑' };
    const src = pack('s', {
      cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }],
      biomes: [{ id: 'bog', name: '沼泽', color: '#000000' }],
      landmarkTypes: [{ id: 'lm', name: '碑', ...LM, cultureGroups: ['x'] }],
      terrainClasses: [{ id: 'tc', name: '类', color: '#111111', priority: 1, rules: [{ biomes: ['bog'] }] }, { id: 'tc2', name: '二', color: '#111111', priority: 1, rules: [{ biomes: ['bog'] }, { elevMin: 5 }] }],
      resources: [{ id: 'res', name: '矿', color: '#111111', category: 'mineral', rules: [{ biomes: ['bog'] }], rarity: 0.1, weight: 1, cluster: 50 }],
    });
    const g = importGates(src, packTarget(dest()));
    expect(g.of(ref('landmarkType', 'lm'))).toMatchObject({ t: 'gated', reason: '需要戌' });
    expect(g.of(ref('terrainClass', 'tc'))).toMatchObject({ t: 'gated', reason: '需要沼泽' });
    expect(g.of(ref('resource', 'res'))).toMatchObject({ t: 'gated', reason: '需要沼泽' });
    expect(g.of(ref('terrainClass', 'tc2')).t).toBe('free');
    const r = importToPack({ source: src, target: packTarget(dest()), picks: [ref('terrainClass', 'tc2')] });
    expect(packItems<{ rules: unknown[] }>(r.pack, 'terrainClasses')[0].rules).toEqual([{ elevMin: 5 }]);
  });

  it('灰的勾选自动拿掉，写进 dropped；别的照常', () => {
    const p = importPreview(ask(dest(), [ref('government', 'g'), ref('cultureGroup', 'b')]));
    expect(p.dropped).toEqual([{ kind: 'government', id: 'g', name: '政体', kindLabel: '政体', reason: '需要意识形态' }]);
    expect(rowIds(p.rows)).toEqual(['cultureGroup:b']);
    expect(p.count).toBe(1);
  });

  it('已经有了、同 id 不同内容', () => {
    const there = withIdeo({ cultureGroups: [{ id: 'b', name: '乙组', color: '#666666', weight: 9 }, { id: 'a', name: '我的组', color: '#000000' }] });
    const g = importGates(sourcePack(), packTarget(there));
    expect(g.of(ref('cultureGroup', 'b')).t).toBe('have');
    expect(g.of(ref('cultureGroup', 'a'))).toEqual({ t: 'free', differs: true });
    expect(g.of(ref('dimension', 'ideo')).t).toBe('have');
    expect(g.of(ref('dimension', 'nat')).t).toBe('free');
  });

  it('all 列来源里每一项和每个变量', () => {
    const src = sourcePack();
    const all = importGates(src, packTarget(dest()), [ref('dimension', 'ideo')]).all();
    // 3 个变量；时代 1、取值组 1、取值 4、风格 1、文化组 3、文化 3、派系 1、政体 1
    expect(all.size).toBe(3 + 15);
    expect(all.get('faction\u0000f')?.t).toBe('free');
    expect(all.get('dimension\u0000religion')?.t).toBe('have');
  });
});

describe('勾什么进什么', () => {
  it('变量带全部取值和取值组，算在项数里；只勾取值时只加变量和这个取值', () => {
    const all = importPreview(ask(dest(), [ref('dimension', 'ideo')]));
    expect(rowIds(all.rows)).toEqual(['dimension:ideo', 'popValue:v1', 'popValue:v2', 'valueGroup:vg'].sort());
    expect(all.count).toBe(4);
    expect(all.dims).toEqual([{ id: 'ideo', label: '意识形态', required: true, added: true }]);
    // 取值收在变量下面
    expect(all.list.map((r) => r.id)).toEqual(['ideo']);
    expect(all.list[0]).toMatchObject({ kindLabel: '变量', count: 2 });
    expect(rowIds(all.list[0].children)).toEqual(['popValue:v1', 'popValue:v2', 'valueGroup:vg'].sort());
    expect(row(all.rows, 'v1').under).toBe('ideo');
    const one = importPreview(ask(dest(), [ref('popValue', 'v2')]));
    expect(rowIds(one.rows)).toEqual(['dimension:ideo', 'popValue:v2'].sort());
    expect(row(one.rows, 'ideo')).toMatchObject({ role: 'follow', because: ['右 要它'] });
    // 取值的组去掉了（去得掉的引用）
    expect(one.stripCount).toBe(1);
    const r = importToPack(ask(dest(), [ref('popValue', 'v2')]));
    expect(packItems<{ group?: string }>(r.pack, 'popValues')[0].group).toBeUndefined();
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });

  it('去掉变量里的一个取值：不带这一个；勾变量时取值组也可以去掉', () => {
    const r = importToPack(ask(dest(), [ref('dimension', 'ideo')], { off: [ref('popValue', 'v1'), ref('valueGroup', 'vg')] }));
    expect(packItems<{ id: string; group?: string }>(r.pack, 'popValues')).toMatchObject([{ id: 'v2' }]);
    expect(packItems(r.pack, 'valueGroups')).toEqual([]);
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });

  it('政体带派系（子项），派系顺带写到的变量、取值去掉，不再带', () => {
    const there = withIdeo({ cultureGroups: [{ id: 'a', name: '甲组', color: '#555555', weight: 3 }], popValues: [{ id: 'v1', dimension: 'ideo', name: '左', color: '#111111' }] });
    const p = importPreview(ask(there, [ref('government', 'g')]));
    expect(rowIds(p.rows)).toEqual(['faction:f', 'government:g']);
    expect(p.list.map((r) => r.id)).toEqual(['g']);
    expect(p.list[0].children.map((r) => r.id)).toEqual(['f']);
    expect(row(p.rows, 'f')).toMatchObject({ role: 'child', because: ['政体 里的'] });
    expect(p.dims).toEqual([]);
    const r = importToPack(ask(there, [ref('government', 'g')]));
    // n1 那一条去掉了，v1 那一条留着（目的地有）
    expect(packItems<{ drivers: unknown[] }>(r.pack, 'factions')[0].drivers).toEqual([{ dimension: 'ideo', value: 'v1', weight: 4 }, { coastal: true, weight: 0.3 }]);
    expect(p.stripped.map((s) => [s.label, s.target]).sort()).toEqual([['换说法', '乙组'], ['来自人口', '公民']].sort());
    expect(p.stripCount).toBe(2);
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });

  it('去掉一个派系：政体的名单少这一个；目的地有同 id 的指到目的地那一份', () => {
    const there = withIdeo({ cultureGroups: [{ id: 'a', name: '甲组', color: '#555555' }] });
    const noF = importToPack(ask(there, [ref('government', 'g')], { off: [ref('faction', 'f')] }));
    expect(packItems<{ factions?: string[] }>(noF.pack, 'governments')[0].factions).toBeUndefined();
    expect(noF.preview.count).toBe(1);
    const has = dest({ cultureGroups: [{ id: 'a', name: '甲组', color: '#555555' }], factions: [{ id: 'f', name: '我的派系', color: '#000000', amount: 2 }] });
    const r = importToPack(ask(has, [ref('government', 'g')], { off: [ref('faction', 'f')] }));
    expect(packItems<{ factions?: string[] }>(r.pack, 'governments')[0].factions).toEqual(['f']);
    expect(packItems<{ id: string; name: string }>(r.pack, 'factions')).toEqual([{ id: 'f', name: '我的派系', color: '#000000', amount: 2 }]);
  });

  it('真实的数据：社会主义共和国灰，勾意识形态后能选；项数等于真的写入的', () => {
    const fantasy = copyOf('fantasy');
    const gov = ref('government', 'socialist-republic');
    const source = top('modern');
    expect(importGates(source, packTarget(fantasy)).of(gov)).toMatchObject({ t: 'gated', reason: '需要意识形态' });
    const none = importPreview({ source, target: packTarget(fantasy), picks: [gov] });
    expect(none.count).toBe(0);
    expect(none.dropped.map((d) => d.reason)).toEqual(['需要意识形态']);
    const p = importPreview({ source, target: packTarget(fantasy), picks: [gov, ref('dimension', 'ideology')] });
    expect(p.dims.map((d) => d.id)).toEqual(['ideology']);
    expect(p.dropped).toEqual([]);
    expect(rowIds(p.rows.filter((r) => r.kind === 'government' || r.kind === 'faction'))).toEqual(['faction:liberals', 'faction:revolutionary-left', 'government:socialist-republic']);
    expect(p.rows.some((r) => r.kind === 'cultureGroup')).toBe(false);
    expect(p.rows.some((r) => r.state === 'rename')).toBe(false);
    expect(p.count).toBe(p.rows.length);
    const r = importToPack({ source, target: packTarget(fantasy), picks: [gov, ref('dimension', 'ideology')] });
    expect(r.added.length + r.preview.dims.length).toBe(p.count);
    expect(packItems<{ id: string; drivers?: { dimension?: string }[] }>(r.pack, 'factions').find((f) => f.id === 'revolutionary-left')!.drivers!.some((d) => d.dimension === 'ideology')).toBe(true);
  });

  it('量到的数：现代到奇幻 12 个政体灰 11 个，派系 14 个灰 10 个，文化全部能选', () => {
    const source = top('modern');
    const g = importGates(source, packTarget(copyOf('fantasy')));
    const grey = (key: string, kind: string) => {
      const list = packItems<{ id: string }>(source, key);
      return [list.length, list.filter((x) => g.of(ref(kind, x.id)).t === 'gated').length];
    };
    expect(grey('governments', 'government')).toEqual([12, 11]);
    expect(grey('factions', 'faction')).toEqual([14, 10]);
    expect(grey('cultures', 'culture')[1]).toBe(0);
  });

  it('names 和称号的键缺了就去掉，不带文化组', () => {
    const src: ResourcePack = pack('s', {
      cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }, { id: 'y', name: '亥', color: '#222222' }],
      countryTiers: [{ id: 't', name: '等级', weight: 1 }],
      governments: [{ id: 'g', name: '政体', ...GOV, titles: { t: '公国', u: '王国' }, names: [{ cultureGroups: ['x'], titles: '说法' }, { cultureGroups: ['y'], titles: '说法二' }] }],
    });
    const there = () => pack('d', { cultureGroups: [{ id: 'y', name: '世界里的亥', color: '#333333' }] });
    expect(rowIds(importPreview({ source: src, target: packTarget(there()), picks: [ref('government', 'g')] }).rows)).toEqual(['government:g']);
    const r = importToPack({ source: src, target: packTarget(there()), picks: [ref('government', 'g')] });
    const g = packItems<{ names: unknown; titles: unknown }>(r.pack, 'governments')[0];
    // x 去掉了（整条规则），y 目的地有同 id 的（留着，指到目的地那一份）；键都没了时称号换成第一种写法
    expect(g.names).toEqual([{ cultureGroups: ['y'], titles: '说法二' }]);
    expect(g.titles).toBe('公国');
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });

  it('子项按库的安排：没融入的不跟着，散的上级不带', () => {
    const unmerged = { ...sourcePack(), arrange: { popValue: 'valueGroup' } } as ResourcePack;
    const there = withIdeo({ cultureGroups: [{ id: 'a', name: '甲组', color: '#555555' }] });
    const p = importPreview({ source: unmerged, target: packTarget(there), picks: [ref('government', 'g'), ref('cultureGroup', 'b')] });
    expect(rowIds(p.rows)).toEqual(['cultureGroup:b', 'government:g']);
    // 政体的派系没带：写到它的引用去掉
    const r = importToPack({ source: unmerged, target: packTarget(there), picks: [ref('government', 'g')] });
    expect(packItems<{ factions?: string[] }>(r.pack, 'governments')[0].factions).toBeUndefined();
    // 地标融入文化组：勾组带上写着这个组的地标
    const src = pack('s', { cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }], landmarkTypes: [{ id: 'lm', name: '碑', category: 'manmade', icon: 'monument', place: 'capital', per: 'country', count: 1, chance: 1, label: '{city}碑', cultureGroups: ['x'] }] });
    expect(rowIds(importPreview({ source: src, target: packTarget(dest()), picks: [ref('cultureGroup', 'x')] }).rows)).toEqual(['cultureGroup:x', 'landmarkType:lm']);
  });
});

describe('跟着勾上', () => {
  // 第六十六轮以前跟着来的组比重都写 0（只勾一个文化，重新生成后看不到）；现在勾的文化带来的组比重和勾的组一样
  it('文化要它的组：只带这一项本身，比重用来源的（是 0 时去掉），不带组里别的文化', () => {
    const p = importPreview(ask(dest(), [ref('culture', 'a1')]));
    expect(rowIds(p.rows)).toEqual(['culture:a1', 'cultureGroup:a']);
    expect(row(p.rows, 'a')).toMatchObject({ role: 'follow', because: ['甲一 要它'] });
    const r = importToPack(ask(dest(), [ref('culture', 'a1')]));
    expect(packItems<{ weight?: number; nameStyle?: string }>(r.pack, 'cultureGroups')).toMatchObject([{ id: 'a', weight: 3 }]);
    const zero = importToPack(ask(dest(), [ref('culture', 'z1')]));
    expect(packItems<{ id: string; weight?: number }>(zero.pack, 'cultureGroups').map((g) => [g.id, g.weight])).toEqual([['z', undefined]]);
    expect(packItems<{ nameStyle?: string }>(r.pack, 'cultureGroups')[0].nameStyle).toBeUndefined();
    expect(packItems<{ id: string }>(r.pack, 'cultures').map((c) => c.id)).toEqual(['a1']);
  });

  it('去掉要的组：这一项也进不来，写明原因', () => {
    const off = importPreview(ask(dest(), [ref('culture', 'a1')], { off: [ref('cultureGroup', 'a')] }));
    expect(off.count).toBe(0);
    expect(off.dropped).toEqual([{ kind: 'culture', id: 'a1', name: '甲一', kindLabel: '文化', reason: '需要甲组' }]);
    expect(importToPack(ask(dest(), [ref('culture', 'a1')], { off: [ref('cultureGroup', 'a')] })).pack.cultures).toBeUndefined();
  });

  it('脚本互相写到的跟着来，成环也走得完；哪里都没有的灰', () => {
    const script = (src: string) => ({ placement: { src } });
    const src = pack('s', {
      biomes: [{ id: 'b1', name: '甲', color: '#111111', scripts: script("return river('r1') ? 1 : 0;") }],
      riverTypes: [{ id: 'r1', name: '河', color: '#111111', scripts: { match: { src: "return dominantBiome() === 'b1' ? 1 : 0;" } } }, { id: 'r2', name: '没有', color: '#111111', scripts: { match: { src: "return dominantBiome() === 'nope' ? 1 : 0;" } } }],
    });
    const p = importPreview({ source: src, target: packTarget(dest()), picks: [ref('riverType', 'r1')] });
    expect(rowIds(p.rows)).toEqual(['biome:b1', 'riverType:r1']);
    expect(row(p.rows, 'b1').role).toBe('follow');
    expect(importGates(src, packTarget(dest())).of(ref('riverType', 'r2'))).toMatchObject({ t: 'gated', reason: '需要nope' });
  });
});

describe('文化组', () => {
  it('勾组带文化、地名风格（子项）；可以单独去掉一个', () => {
    const picked = importPreview(ask(dest(), [ref('cultureGroup', 'a')]));
    expect(rowIds(picked.rows)).toEqual(['culture:a1', 'culture:a2', 'cultureGroup:a', 'nameStyle:s'].sort());
    expect(row(picked.rows, 'a1')).toMatchObject({ role: 'child', because: ['甲组 里的'] });
    const off = importToPack(ask(dest(), [ref('cultureGroup', 'a')], { off: [ref('culture', 'a2')] }));
    expect(packItems<{ id: string }>(off.pack, 'cultures').map((c) => c.id)).toEqual(['a1']);
    // 去掉地名风格：组写的引用去掉
    const noStyle = importToPack(ask(dest(), [ref('cultureGroup', 'a')], { off: [ref('nameStyle', 's')] }));
    expect(packItems<{ nameStyle?: string }>(noStyle.pack, 'cultureGroups')[0].nameStyle).toBeUndefined();
  });

  it('勾的组留着比重，比重是 0 的去掉这个 0', () => {
    const picked = importToPack(ask(dest(), [ref('cultureGroup', 'a'), ref('cultureGroup', 'z')]));
    expect(packItems<{ id: string; weight?: number }>(picked.pack, 'cultureGroups').map((g) => [g.id, g.weight])).toEqual([['a', 3], ['z', undefined]]);
  });

  it('是不是同一项不看 weight：只差比重的组算已经有了，目的地的比重不动', () => {
    const there = dest({ cultureGroups: [{ id: 'b', name: '乙组', color: '#666666', weight: 9 }] });
    const k = kindOf('cultureGroup')!;
    expect(sameContent(k, { id: 'b', weight: 9 }, { id: 'b', weight: 2 })).toBe(true);
    const p = importPreview(ask(there, [ref('cultureGroup', 'b')]));
    expect(p.gates.of(ref('cultureGroup', 'b')).t).toBe('have');
    expect(p.count).toBe(0);
    const r = importToPack(ask(there, [ref('cultureGroup', 'b')]));
    expect(packItems<{ weight: number }>(r.pack, 'cultureGroups')[0].weight).toBe(9);
    // 跟着文化来的（写了 0）再导入也认得出来
    const once = importToPack(ask(dest(), [ref('culture', 'a1')]));
    expect(importToPack(ask(once.pack, [ref('culture', 'a1')])).preview.count).toBe(0);
  });

  // 第六十五轮导入的样子：组跟着文化来，比重写了 0，地名风格去掉了
  const zeroed = () => dest({ cultureGroups: [{ id: 'a', name: '甲组', color: '#555555', weight: 0 }], cultures: [{ id: 'a1', group: 'a', name: '甲一', color: '#888888' }] });

  it('目的地的组比重是 0；后来勾整组：不改名，比重回来，引用补上，才参与生成', () => {
    const once = { pack: zeroed() };
    const p = importPreview(ask(once.pack, [ref('cultureGroup', 'a')]));
    expect(p.gates.of(ref('cultureGroup', 'a')).t).toBe('fixable');
    expect(row(p.rows, 'a').state).toBe('fix');
    const r = importToPack(ask(once.pack, [ref('cultureGroup', 'a')]));
    const groups = packItems<{ id: string; weight?: number; nameStyle?: string }>(r.pack, 'cultureGroups');
    expect(groups.map((g) => [g.id, g.weight, g.nameStyle])).toEqual([['a', 3, 's']]);
    expect(importPreview(ask(r.pack, [ref('cultureGroup', 'a')])).count).toBe(0);
  });

  it('目的地的组比重是 0；勾组里另一个文化：比重回来（只回比重，地名风格不补），第六十六轮', () => {
    const p = importPreview(ask(zeroed(), [ref('culture', 'a2')]));
    expect(row(p.rows, 'a')).toMatchObject({ role: 'follow', state: 'fix' });
    const r = importToPack(ask(zeroed(), [ref('culture', 'a2')]));
    const groups = packItems<{ id: string; weight?: number; nameStyle?: string }>(r.pack, 'cultureGroups');
    expect(groups.map((g) => [g.id, g.weight, g.nameStyle])).toEqual([['a', 3, undefined]]);
    expect(packItems<{ id: string }>(r.pack, 'cultures').map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(importPreview(ask(r.pack, [ref('culture', 'a2')])).count).toBe(0);
  });
});

describe('补回', () => {
  it('先导入宗教，再导入它的组：不产生 -2，引用补上；再导入一次 0 项', () => {
    const first = importToPack(ask(withIdeo(), [ref('popValue', 'v1')]));
    expect(packItems<{ group?: string }>(first.pack, 'popValues')[0].group).toBeUndefined();
    // 组还没勾：已经有了
    expect(importGates(sourcePack(), packTarget(first.pack)).of(ref('popValue', 'v1')).t).toBe('have');
    // 目的地有组：能补回
    const withGroup = importToPack(ask(first.pack, [ref('valueGroup', 'vg')], { off: [ref('popValue', 'v2')] }));
    const p = withGroup.preview;
    expect(rowIds(p.rows)).toEqual(['popValue:v1', 'valueGroup:vg']);
    expect(row(p.rows, 'v1').state).toBe('fix');
    const values = packItems<{ id: string; group?: string }>(withGroup.pack, 'popValues');
    expect(values.map((v) => [v.id, v.group])).toEqual([['v1', 'vg']]);
    expect(danglingLinks(linkTable(packScope(withGroup.pack)))).toEqual([]);
    expect(importPreview(ask(withGroup.pack, [ref('valueGroup', 'vg')], { off: [ref('popValue', 'v2')] })).count).toBe(0);
    // 只有组、没勾取值：灰字写能补回
    const onlyGroup = pack('dst', { eras: [{ id: 'mine', name: '我的时代', dimensions: [{ id: 'ideo', label: '意识形态' }], ...ERA }], valueGroups: [{ id: 'vg', dimension: 'ideo', name: '值组', color: '#101010' }], popValues: [{ id: 'v1', dimension: 'ideo', name: '左', color: '#111111' }] });
    expect(importGates(sourcePack(), packTarget(onlyGroup)).of(ref('popValue', 'v1'))).toEqual({ t: 'fixable', restores: ['值组'] });
    const fixed = importToPack(ask(onlyGroup, [ref('popValue', 'v1')]));
    expect(fixed.preview.count).toBe(1);
    expect(packItems<{ id: string; group?: string }>(fixed.pack, 'popValues').map((v) => [v.id, v.group])).toEqual([['v1', 'vg']]);
  });

  it('目的地改过的不算：内容不同时还是并存', () => {
    const changed = pack('dst', { eras: [{ id: 'mine', name: '我的时代', dimensions: [{ id: 'ideo', label: '意识形态' }], ...ERA }], valueGroups: [{ id: 'vg', dimension: 'ideo', name: '值组', color: '#101010' }], popValues: [{ id: 'v1', dimension: 'ideo', name: '我改过的左', color: '#111111' }] });
    expect(importGates(sourcePack(), packTarget(changed)).of(ref('popValue', 'v1'))).toEqual({ t: 'free', differs: true });
    expect(row(importPreview(ask(changed, [ref('popValue', 'v1')])).rows, 'v1')).toMatchObject({ state: 'rename', to: 'v1-2' });
  });

  it('真实的数据：中世纪的天主教，先单独导入，再勾基督教组，一个 -2 也没有', () => {
    const source = top('medieval');
    const target = packTarget(copyOf('scifi'));
    const cat = ref('popValue', 'catholic');
    const once = importToPack({ source, target, picks: [cat] });
    expect(once.preview.count).toBe(2);
    expect(rowIds(once.preview.rows)).toEqual(['dimension:religion', 'popValue:catholic']);
    const group = packItems<{ id: string; group?: string }>(source, 'popValues').find((v) => v.id === 'catholic')!.group!;
    const again = importPreview({ source, target: packTarget(once.pack), picks: [ref('valueGroup', group), cat] });
    expect(row(again.rows, 'catholic').state).toBe('fix');
    const r = importToPack({ source, target: packTarget(once.pack), picks: [ref('valueGroup', group), cat] });
    const ids = packItems<{ id: string; group?: string }>(r.pack, 'popValues');
    expect(ids.some((v) => v.id.startsWith('catholic-'))).toBe(false);
    expect(ids.find((v) => v.id === 'catholic')!.group).toBe(group);
    expect(importPreview({ source, target: packTarget(r.pack), picks: [ref('valueGroup', group), cat] }).count).toBe(0);
  });
});

describe('已经有了', () => {
  it('从一个库导入它的副本：一项都不加（文化写着别的时代的倾向，来源那份也写着，不算不同）', () => {
    const med = top('medieval');
    const all = packSections().flatMap((k) => packItems(med, k.pack.key).map((x) => ref(k.id, itemId(k, x))));
    const p = importPreview({ source: med, target: packTarget(copyOf('medieval')), picks: all });
    expect(p.count).toBe(0);
    expect(p.rows).toEqual([]);
    expect(p.dropped).toEqual([]);
    expect(p.stripped).toEqual([]);
    for (const r of all) expect(p.gates.of(r).t, `${r.kind}:${r.id}`).toBe('have');
  });
});

describe('撞名', () => {
  it('内容不同、id 相同时并存，所有引用跟着改；目的地原来的不动', () => {
    const there = withIdeo({
      factions: [{ id: 'f', name: '我的派系', color: '#000000', amount: 2 }],
      cultureGroups: [{ id: 'a', name: '我的组', color: '#000000' }],
    });
    const r = importToPack(ask(there, [ref('government', 'g'), ref('cultureGroup', 'a')]));
    expect(r.preview.rows.filter((x) => x.state === 'rename').map((x) => [x.id, x.to]).sort()).toEqual([['a', 'a-2'], ['f', 'f-2']]);
    const g = packItems<{ factions: string[]; only: { cultureGroups: string[] }[] }>(r.pack, 'governments')[0];
    expect(g.factions).toEqual(['f-2']);
    expect(g.only).toEqual([{ cultureGroups: ['a-2'] }]);
    expect(packItems<{ id: string; name: string }>(r.pack, 'factions').find((f) => f.id === 'f')!.name).toBe('我的派系');
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
    // 再导入一次全部已经有了
    const again = importPreview(ask(r.pack, [ref('government', 'g'), ref('cultureGroup', 'a')]));
    expect(again.count).toBe(0);
    expect(again.rows).toEqual([]);
  });

  it('勾变量时取值撞名也改名；目的地已有的变量不再加，来源写到的取值去掉', () => {
    const there = pack('d', {
      eras: [{ id: 'mine', name: '我的', dimensions: [{ id: 'ideo', label: '我的意识形态' }], ...ERA }],
      popValues: [{ id: 'v1', dimension: 'ideo', name: '我的左', color: '#000000' }],
    });
    const p = importPreview(ask(there, [ref('faction', 'f')]));
    expect(p.dims).toEqual([]);
    expect(rowIds(p.rows)).toEqual(['faction:f']);
    const r = importToPack(ask(there, [ref('faction', 'f')]));
    // 同 id 的取值在目的地：写到它的来源留着，指到目的地那一份
    expect(packItems<{ drivers: { value?: string }[] }>(r.pack, 'factions')[0].drivers[0].value).toBe('v1');
    const both = importToPack(ask(there, [ref('faction', 'f'), ref('popValue', 'v1')]));
    expect(row(both.preview.rows, 'v1')).toMatchObject({ state: 'rename', to: 'v1-2' });
    expect(packItems<{ drivers: { value?: string }[] }>(both.pack, 'factions')[0].drivers[0].value).toBe('v1-2');
    expect(danglingLinks(linkTable(packScope(both.pack)))).toEqual([]);
  });
});

describe('写进库', () => {
  it('变量写进目的地的时代（added），取值放进同一维的小包；来源的时代不带', () => {
    const r = importToPack(ask(dest(), [ref('dimension', 'ideo')]));
    const eras = packItems<{ id: string; dimensions: unknown[] }>(r.pack, 'eras');
    expect(eras.map((e) => e.id)).toEqual(['mine']);
    expect(eras[0].dimensions).toEqual([{ id: 'religion', label: '宗教' }, { id: 'ideo', label: '意识形态', required: true, added: true }]);
    expect(packItems<{ id: string }>(r.pack, 'popValues').map((v) => v.id).sort()).toEqual(['v1', 'v2']);
    expect(parsePack(r.pack).ok).toBe(true);
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
  });

  it('目的地没有时代：全部变量算没有；勾取值跟着带时代；勾变量解开政体', () => {
    const empty = pack('empty');
    expect(importGates(sourcePack(), packTarget(empty)).of(ref('faction', 'f'))).toMatchObject({ t: 'gated', reason: '需要意识形态' });
    const p = importPreview(ask(empty, [ref('popValue', 'v2')]));
    expect(rowIds(p.rows)).toEqual(['era:e', 'popValue:v2']);
    expect(row(p.rows, 'e')).toMatchObject({ role: 'follow', because: ['意识形态 写在这个时代里'] });
    expect(p.dims).toEqual([]);
    expect(p.count).toBe(2);
    const r = importToPack(ask(empty, [ref('popValue', 'v2')]));
    expect(packItems<{ id: string }>(r.pack, 'eras').map((e) => e.id)).toEqual(['e']);
    expect(danglingLinks(linkTable(packScope(r.pack)))).toEqual([]);
    const f = importToPack(ask(empty, [ref('faction', 'f'), ref('dimension', 'ideo')]));
    expect(packItems<{ id: string }>(f.pack, 'factions').map((x) => x.id)).toEqual(['f']);
    expect(danglingLinks(linkTable(packScope(f.pack)))).toEqual([]);
    expect(importPreview(ask(f.pack, [ref('faction', 'f'), ref('dimension', 'ideo')])).count).toBe(0);
    // 不要这个时代：取值也进不来
    const off = importPreview(ask(empty, [ref('popValue', 'v2')], { off: [ref('era', 'e')] }));
    expect(off.count).toBe(0);
    expect(off.dropped.map((d) => d.id)).toEqual(['v2']);
  });

  it('勾时代：带它的变量（子项）；可以去掉一个变量', () => {
    const p = importPreview(ask(dest(), [ref('era', 'e')], { off: [ref('dimension', 'nat')] }));
    expect(rowIds(p.rows.filter((r) => r.kind !== 'popValue' && r.kind !== 'valueGroup'))).toEqual(['dimension:ideo', 'era:e']);
    expect(p.list.map((r) => r.id)).toEqual(['e']);
    expect(p.list[0].children.map((r) => r.id)).toEqual(['ideo']);
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
    const r = importToPack({ source: src, target: packTarget(mine), picks: [ref('cultureGroup', 'a')] });
    expect(r.pack.arrange).toEqual({ faction: 'government' });
    expect(arrangeOf(r.pack)).toEqual(mine.arrange);
    const preset = dest();
    expect(importToPack({ source: src, target: packTarget(preset), picks: [ref('cultureGroup', 'a')] }).pack.arrange).toBeUndefined();
  });

  it('放不下时跳过多出来的，写明原因，其余照常', () => {
    const govs = (n: number) => Array.from({ length: n }, (_, k) => ({ id: `x${k}`, name: `x${k}`, ...GOV }));
    const there = withIdeo({ cultureGroups: [{ id: 'a', name: '甲组', color: '#555555' }], governments: govs(128) });
    expect(importGates(sourcePack(), packTarget(there)).of(ref('government', 'g'))).toEqual({ t: 'full', reason: '政体最多 128 个' });
    const p = importToPack(ask(there, [ref('government', 'g'), ref('cultureGroup', 'b')]));
    expect(p.preview.dropped).toEqual([{ kind: 'government', id: 'g', name: '政体', kindLabel: '政体', reason: '政体最多 128 个' }]);
    expect(rowIds(p.preview.rows)).toEqual(['cultureGroup:b']);
    expect(packItems<{ id: string }>(p.pack, 'cultureGroups').map((g) => g.id)).toContain('b');
    expect(packItems(p.pack, 'governments')).toHaveLength(128);
    // 还差一个位子：勾两个时第一个进来，第二个跳过；窗口里没勾的已经灰了
    const src = pack('s', { governments: [{ id: 'p', name: '甲', ...GOV }, { id: 'q', name: '乙', ...GOV }, { id: 'r', name: '丙', ...GOV }] });
    const almost = pack('d', { governments: govs(127) });
    const two = importToPack({ source: src, target: packTarget(almost), picks: [ref('government', 'p'), ref('government', 'q')] });
    expect(rowIds(two.preview.rows)).toEqual(['government:p']);
    expect(two.preview.dropped.map((d) => d.id)).toEqual(['q']);
    expect(two.preview.gates.of(ref('government', 'r')).t).toBe('full');
    expect(packItems(two.pack, 'governments')).toHaveLength(128);
  });

  it('放不下的目标：去得掉的引用去掉；去不掉的连要它的一起跳过；限谁用落空的也跳过', () => {
    const src = pack('s', {
      cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }],
      cultures: [{ id: 'c', group: 'x', name: '文化', color: '#111111' }],
      governments: [{ id: 'g', name: '政体', ...GOV, only: [{ cultureGroups: ['x'] }] }],
    });
    const groups = Array.from({ length: 128 }, (_, k) => ({ id: `y${k}`, name: `y${k}`, color: '#000000' }));
    const there = pack('d', { cultureGroups: groups });
    const g = importGates(src, packTarget(there));
    expect(g.of(ref('cultureGroup', 'x'))).toEqual({ t: 'full', reason: '文化组最多 128 个' });
    expect(g.of(ref('culture', 'c'))).toEqual({ t: 'full', reason: '文化组最多 128 个' });
    const p = importPreview({ source: src, target: packTarget(there), picks: [ref('culture', 'c'), ref('government', 'g'), ref('cultureGroup', 'x')] });
    expect(p.count).toBe(0);
    expect(p.dropped.map((d) => d.id).sort()).toEqual(['c', 'g', 'x']);
    for (const d of p.dropped) expect(d.reason).not.toBe('');
  });

  it('变量满了：灰，取值也灰；已经满了不再加', () => {
    const many = Array.from({ length: 8 }, (_, k) => ({ id: `d${k}`, label: `d${k}` }));
    const there = pack('d', { eras: [{ id: 'mine', name: '我的', dimensions: many, ...ERA }] });
    const g = importGates(sourcePack(), packTarget(there));
    expect(g.of(ref('dimension', 'ideo'))).toEqual({ t: 'full', reason: '一个时代最多 8 个变量' });
    expect(g.of(ref('popValue', 'v1'))).toEqual({ t: 'full', reason: '一个时代最多 8 个变量' });
    const p = importPreview(ask(there, [ref('dimension', 'ideo'), ref('cultureGroup', 'b')]));
    expect(rowIds(p.rows)).toEqual(['cultureGroup:b']);
    expect(p.dropped.map((d) => d.id)).toEqual(['ideo']);
    const v = importPreview(ask(there, [ref('popValue', 'v1')]));
    expect(v.count).toBe(0);
    expect(v.dropped.some((d) => d.id === 'v1' && d.reason === '一个时代最多 8 个变量')).toBe(true);
  });

  it('有问题的地名风格：灰着写问题', () => {
    const src = pack('s', { nameStyles: [{ id: 'bad', kind: 'template', name: '坏', lists: { a: ['x'] }, types: { island: { patterns: [{ p: '{nope}岛' }] } } }] });
    const g = importGates(src, packTarget(dest())).of(ref('nameStyle', 'bad'));
    expect(g.t).toBe('full');
    expect(g.t === 'full' && g.reason).toContain('地名风格有问题');
    expect(importPreview({ source: src, target: packTarget(dest()), picks: [ref('nameStyle', 'bad')] }).count).toBe(0);
  });

  it('上级页面选了别的库里的一项：放到这个上级下面是同一步', () => {
    const there = withIdeo({ governments: [{ id: 'mine-g', name: '我的政体', ...GOV }] });
    const rel = relationOf('faction', 'government')!;
    const r = importToPack(ask(there, [ref('faction', 'f')]), { onto: { relation: rel, parent: 'mine-g', children: [ref('faction', 'f')] } });
    expect(packItems<{ factions?: string[] }>(r.pack, 'governments')[0].factions).toEqual(['f']);
  });

  it('上级页面一次勾了几项（第六十八轮）：都放到这个上级下面，加到库、加到世界都是同一步', () => {
    const two = { ...sourcePack(), factions: [...packItems(sourcePack(), 'factions'), { id: 'f2', name: '派系二', color: '#cccccc', amount: 1, drivers: [{ dimension: 'ideo', value: 'v2', weight: 2 }] }] } as ResourcePack;
    const rel = relationOf('faction', 'government')!;
    const picks = [ref('faction', 'f'), ref('faction', 'f2')];
    const onto = { relation: rel, parent: 'mine-g', children: picks };
    const there = withIdeo({ governments: [{ id: 'mine-g', name: '我的政体', ...GOV, factions: ['old'] }], factions: [{ id: 'old', name: '旧的', color: '#000000', amount: 1, drivers: [] }] });
    const r = importToPack({ source: two, target: packTarget(there), picks }, { onto });
    expect(packItems<{ factions?: string[] }>(r.pack, 'governments')[0].factions).toEqual(['old', 'f', 'f2']);
    // 世界：一个 batch，上级只写一条（两项都链上）
    const eng = engineFor({ cells: 1000, seed: 2 }, { bare: true });
    for (const c of packImportCommands([there], { packs: [['dst']], groups: [] }, eng.world)) eng.exec(c);
    const w = importCommand({ source: two, target: { t: 'world', world: eng.world }, picks }, { onto });
    const govEdits = w.command!.commands.filter((c) => c.op === 'set_content' && c.kind === 'government');
    expect(govEdits.length).toBe(1);
    const before = eng.toDoc().commands.length;
    eng.exec(w.command!);
    expect((eng.world.small.content!.government!['mine-g'] as { factions: string[] }).factions).toEqual(['old', 'f', 'f2']);
    expect(Object.keys(eng.world.small.content!.faction!)).toEqual(expect.arrayContaining(['f', 'f2']));
    eng.undo();
    expect(eng.toDoc().commands.length).toBe(before);
    expect((eng.world.small.content!.government!['mine-g'] as { factions: string[] }).factions).toEqual(['old']);
  });
});

describe('世界', () => {
  it('星球形态不能用到世界，勾了也不算，写明原因', () => {
    const world = { small: { species: [], featureNames: {}, provinces: {} }, causes: { fields: {} } } as unknown as PackWorld;
    const form = packItems<{ id: string }>(top('medieval'), 'planetForms')[0];
    const p = importPreview({ source: top('medieval'), target: { t: 'world', world }, picks: [ref('planetForm', form.id)] });
    expect(p.count).toBe(0);
    expect(p.rows).toEqual([]);
    expect(p.dropped.map((d) => d.reason)).toEqual(['这一种不能用到世界']);
    expect(p.gates.of(ref('planetForm', form.id)).t).toBe('gated');
  });
});
