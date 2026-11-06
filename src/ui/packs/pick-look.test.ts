import { afterEach, describe, expect, it } from 'vitest';
import { packItems } from '../../../core/packs';
import { type ResourcePack } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { importCommand, importGates, importPreview } from '../../../core/packs/closure';
import { continents } from '../../../core/testing/fixtures';
import type { LibraryEntry } from '../../library';
import { worldEpoch } from '../../state';
import type { PageCtx } from './page-source';
import { doneHead, skippedLine } from './pick-add';
import { allLook, basketGroups, foldText, hasZeroWeightGroup, rowLook, soleValue, whyText } from './pick-look';
import { regenLine } from './pick-other';
import { pickPreview, pickStore, picksOf, removePickIn, setPickDest, setPicksIn, togglePickIn } from './pick-store';
import { pickView } from './pick-view';

// 勾选的样子（第六十五轮写给导入窗口，第六十七轮窗口并进资源库面板）：连带、一行的状态、全选、清单。
// 以前在 page-import.test.ts 里用窗口的勾选测，现在用按库记的勾选（pick-store.ts），规则同一套

const PACKS = builtinPacks();
const LIB: LibraryEntry[] = PACKS.map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const mine = (id = 'mine'): LibraryEntry => ({ key: id, pack: { format: 'map2-pack', version: 1, id, name: '我的库' } as ResourcePack, builtin: false, mine: true, installedAt: 1 });
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({ world: null, lib: [...LIB, mine()], ...over });
const pack = (id: string) => PACKS.find((p) => p.id === id)!;

afterEach(() => {
  pickStore.value = { epoch: worldEpoch.value, bySource: {}, dest: null };
});

// 只有这个库的时代的世界（没有别的内容）
const eraWorld = (id: string) => {
  const eng = continents();
  const eras = packItems<{ id: string }>(pack(id), 'eras');
  eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
  return eng;
};

describe('连带', () => {
  const medieval = pack('medieval');
  // 目的地：科幻的时代（没有宗教、没有基督教组）
  const target = (): PageCtx => ctx({ world: eraWorld('scifi').world });
  const rows = (c: PageCtx, key = 'medieval') => pickPreview(key, c)!.rows;
  const ids = (c: PageCtx) => rows(c).map((r) => r.id).sort();

  it('× 文化组：连要它的文化一起去掉，什么都不留', () => {
    const c = target();
    const culture = packItems<{ id: string; group: string }>(medieval, 'cultures')[0];
    togglePickIn('medieval', { kind: 'culture', id: culture.id }, true, c);
    expect(rows(c).find((r) => r.id === culture.group)).toMatchObject({ role: 'follow' });
    removePickIn('medieval', { kind: 'cultureGroup', id: culture.group }, c);
    expect(picksOf('medieval').picks).toEqual([]);
    expect(picksOf('medieval').off).toEqual([]);
    expect(rows(c)).toEqual([]);
    // 不留下 off：再勾这个组里别的文化，组还能跟着来
    const other = packItems<{ id: string; group: string }>(medieval, 'cultures').find((x) => x.group === culture.group && x.id !== culture.id)!;
    togglePickIn('medieval', { kind: 'culture', id: other.id }, true, c);
    expect(ids(c)).toEqual([other.id, culture.group].sort());
  });

  it('× 跟着来的变量：连要它的取值一起去掉；× 勾的取值，变量也不在了', () => {
    const c = target();
    const v = { kind: 'popValue', id: 'catholic' };
    togglePickIn('medieval', v, true, c);
    expect(rows(c).map((r) => [r.kind, r.id, r.role])).toEqual(expect.arrayContaining([['dimension', 'religion', 'follow'], ['popValue', 'catholic', 'pick']]));
    removePickIn('medieval', { kind: 'dimension', id: 'religion' }, c);
    expect([picksOf('medieval').picks, picksOf('medieval').off, rows(c)]).toEqual([[], [], []]);
    togglePickIn('medieval', v, true, c);
    removePickIn('medieval', v, c);
    expect(rows(c)).toEqual([]);
  });

  it('去掉变量：要它的政体从勾选里拿掉（取消勾选、× 都一样）', () => {
    const c = ctx({ world: eraWorld('fantasy').world });
    const dim = { kind: 'dimension', id: 'ideology' };
    const gov = { kind: 'government', id: 'socialist-republic' };
    togglePickIn('modern', dim, true, c);
    togglePickIn('modern', gov, true, c);
    expect(rows(c, 'modern').some((r) => r.id === gov.id)).toBe(true);
    togglePickIn('modern', dim, false, c);
    expect(picksOf('modern').picks).toEqual([]);
    expect(rows(c, 'modern')).toEqual([]);
    togglePickIn('modern', dim, true, c);
    togglePickIn('modern', gov, true, c);
    removePickIn('modern', dim, c);
    expect(picksOf('modern').picks).toEqual([]);
    expect(picksOf('modern').off).toEqual([]);
    expect(pickPreview('modern', c)!.dropped).toEqual([]);
  });

  it('去掉子项：记进 off，名单少这一个；勾回来不多记一笔；取消又勾上级时都回来', () => {
    const eng = eraWorld('medieval');
    const c = ctx({ world: eng.world });
    const gov = packItems<{ id: string; factions?: string[] }>(medieval, 'governments').find((g) => g.factions?.length && importGates(medieval, { t: 'world', world: eng.world }).of({ kind: 'government', id: g.id }).t === 'free')!;
    const govRef = { kind: 'government', id: gov.id };
    const f = { kind: 'faction', id: gov.factions![0] };
    togglePickIn('medieval', govRef, true, c);
    expect(rows(c).find((r) => r.id === f.id)?.role).toBe('child');
    removePickIn('medieval', f, c);
    expect(picksOf('medieval').off).toEqual([f]);
    expect(rows(c).some((r) => r.id === f.id)).toBe(false);
    expect(picksOf('medieval').picks).toEqual([govRef]);
    togglePickIn('medieval', f, true, c);
    expect([picksOf('medieval').picks, picksOf('medieval').off]).toEqual([[govRef], []]);
    setPicksIn('medieval', [f], true, c);
    togglePickIn('medieval', f, false, c);
    expect([picksOf('medieval').picks, picksOf('medieval').off]).toEqual([[govRef], [f]]);
    togglePickIn('medieval', govRef, false, c);
    togglePickIn('medieval', govRef, true, c);
    expect(picksOf('medieval').off).toEqual([]);
    expect(rows(c).find((r) => r.id === f.id)?.role).toBe('child');
  });

  it('跟着来的勾上是勾整项；取消后变回跟着来的', () => {
    const c = target();
    const culture = packItems<{ id: string; group: string }>(medieval, 'cultures')[0];
    const group = { kind: 'cultureGroup', id: culture.group };
    togglePickIn('medieval', { kind: 'culture', id: culture.id }, true, c);
    togglePickIn('medieval', group, true, c);
    expect(rows(c).find((r) => r.id === culture.group)!.role).toBe('pick');
    expect(rows(c).filter((r) => r.kind === 'culture').length).toBeGreaterThan(1);
    togglePickIn('medieval', group, false, c);
    expect(rows(c).find((r) => r.id === culture.group)!.role).toBe('follow');
    expect(rows(c).filter((r) => r.kind === 'culture').map((r) => r.id)).toEqual([culture.id]);
  });
});

describe('一行的状态', () => {
  const medieval = pack('medieval');
  const look = (key: string, c: PageCtx) => pickView({ t: 'lib', key }, c)!.look;

  it('勾的、跟着来的、灰的、能勾的', () => {
    const c = ctx({ world: eraWorld('scifi').world });
    const culture = packItems<{ id: string; group: string; name: string }>(medieval, 'cultures')[0];
    togglePickIn('medieval', { kind: 'culture', id: culture.id }, true, c);
    const l = look('medieval', c);
    expect(rowLook({ kind: 'culture', id: culture.id }, l)).toMatchObject({ mark: 'on', picked: true });
    const group = rowLook({ kind: 'cultureGroup', id: culture.group }, l);
    expect(group.mark).toBe('follow');
    expect(group.note).toBe(`${culture.name}要它`);
    // 灰的：写原因（这个世界没有宗教）
    expect(rowLook({ kind: 'government', id: 'iqta' }, l)).toMatchObject({ mark: 'grey' });
    expect(rowLook({ kind: 'government', id: 'iqta' }, l).note).toMatch(/^需要/);
    // 变量没有：能勾
    expect(rowLook({ kind: 'dimension', id: 'religion' }, l).mark).toBe('off');
  });

  it('已经有了：✓；同 id 不同内容：写“有一份不同的”；加到我的库时写“这个库”', () => {
    const modern = pack('modern');
    const f = packItems<{ id: string; name: string }>(modern, 'factions')[0];
    const p = { format: 'map2-pack', version: 1, id: 'm', name: '我的', eras: packItems(modern, 'eras'), factions: [f, { ...packItems<{ id: string; name: string }>(modern, 'factions')[1], name: '改过' }] } as unknown as ResourcePack;
    const entry: LibraryEntry = { key: 'm', pack: p, builtin: false, mine: true, installedAt: 1 };
    const c: PageCtx = { world: null, lib: [...LIB, entry] };
    setPickDest({ lib: 'm' });
    const l = look('modern', c);
    expect(l.here).toBe('这个库');
    expect(rowLook({ kind: 'faction', id: f.id }, l).mark).toBe('have');
    const other = packItems<{ id: string }>(modern, 'factions')[1];
    expect(rowLook({ kind: 'faction', id: other.id }, l)).toMatchObject({ mark: 'off', note: '这个库有一份不同的，添加后并存' });
  });

  it('全选：变量的取值页勾的是变量；已经有了时勾能选的行；都灰时不能勾', () => {
    const c = ctx({ world: eraWorld('fantasy').world });
    const values = packItems<{ id: string; dimension: string }>(pack('modern'), 'popValues').filter((v) => v.dimension === 'ideology').map((v) => ({ kind: 'popValue', id: v.id }));
    const head = { kind: 'dimension', id: 'ideology' };
    expect(allLook(values, look('modern', c), head)).toMatchObject({ checked: false, mixed: false, disabled: false, acts: [head] });
    setPicksIn('modern', allLook(values, look('modern', c), head).acts, true, c);
    expect(allLook(values, look('modern', c), head)).toMatchObject({ checked: true, count: values.length });
    // 去掉一个取值：半勾；再全选：去掉的回来
    removePickIn('modern', values[0], c);
    expect(allLook(values, look('modern', c), head)).toMatchObject({ checked: false, mixed: true });
    setPicksIn('modern', allLook(values, look('modern', c), head).acts, true, c);
    expect(picksOf('modern').off).toEqual([]);
    // 取消全选：变量和取值都没了
    setPicksIn('modern', allLook(values, look('modern', c), head).clears, false, c);
    expect(picksOf('modern').picks).toEqual([]);
    // 世界有这个变量时（奇幻的宗教）：勾的是行；灰的跳过
    const religion = packItems<{ id: string; dimension: string }>(pack('modern'), 'popValues').filter((v) => v.dimension === 'religion').map((v) => ({ kind: 'popValue', id: v.id }));
    const acts = allLook(religion, look('modern', c), { kind: 'dimension', id: 'religion' }).acts;
    expect(acts.every((a) => a.kind !== 'dimension')).toBe(true);
    const govs = packItems<{ id: string }>(pack('modern'), 'governments').map((g) => ({ kind: 'government', id: g.id }));
    const all = allLook(govs, look('modern', c));
    expect(all.acts.length).toBeLessThan(govs.length);
    expect(all.acts.some((a) => a.id === 'socialist-republic')).toBe(false);
    expect(allLook([{ kind: 'government', id: 'socialist-republic' }], look('modern', c))).toMatchObject({ disabled: true });
  });
});

describe('清单', () => {
  const medieval = pack('medieval');

  it('科幻世界勾天主教：变量和取值两项，取值挂在变量下面，写明里面只有它', () => {
    const c = ctx({ world: eraWorld('scifi').world });
    togglePickIn('medieval', { kind: 'popValue', id: 'catholic' }, true, c);
    const p = pickPreview('medieval', c)!;
    expect(p.count).toBe(2);
    const g = basketGroups(p, medieval);
    expect(g.map((x) => x.title)).toEqual(['变量']);
    expect(g[0].nodes.map((n) => n.row.id)).toEqual(['religion']);
    expect(g[0].nodes[0].children.map((n) => n.row.id)).toEqual(['catholic']);
    expect(soleValue(p, medieval, p.rows.find((r) => r.kind === 'dimension')!)).toBe('天主教');
  });

  it('变量已经有了时小标题写变量的名字；勾整个变量时取值收成一行', () => {
    const c = ctx({ world: eraWorld('medieval').world });
    const antiquity = pack('antiquity');
    const value = packItems<{ id: string; name: string; dimension: string }>(antiquity, 'popValues').find((v) => !packItems<{ id: string }>(medieval, 'popValues').some((x) => x.id === v.id))!;
    togglePickIn('antiquity', { kind: 'popValue', id: value.id }, true, c);
    expect(basketGroups(pickPreview('antiquity', c)!, antiquity).map((x) => x.title)).toContain('宗教');
    const c2 = ctx({ world: eraWorld('fantasy').world });
    togglePickIn('modern', { kind: 'dimension', id: 'ideology' }, true, c2);
    const p2 = pickPreview('modern', c2)!;
    const dim = basketGroups(p2, pack('modern'))[0].nodes[0];
    expect(foldText(dim.children)).toBe('15 种取值');
    expect(p2.count).toBe(dim.children.length + 1);
  });

  it('勾文化带来的组不写比重是 0；为什么写在一起', () => {
    const c = ctx({ world: eraWorld('scifi').world });
    const culture = packItems<{ id: string }>(medieval, 'cultures')[0];
    togglePickIn('medieval', { kind: 'culture', id: culture.id }, true, c);
    expect(hasZeroWeightGroup(pickPreview('medieval', c)!)).toBe(false);
    expect(whyText(['直隶人 要它'])).toBe('直隶人要它');
    expect(whyText(['甲 要它', '乙 要它', '丙 要它'])).toBe('甲、乙 等 3 项要它');
    expect(whyText(['封建君主制 里的'])).toBe('封建君主制里的');
  });

  it('跳过的写成一句；加完顶上那句写用户点的那一项和跳过了几项', () => {
    expect(skippedLine([])).toBeNull();
    expect(skippedLine([{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '需要意识形态' }])).toBe('还有 1 项需要意识形态，没加');
    expect(skippedLine([{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '政体最多 3 个' }])).toBe('还有 1 项没加：政体最多 3 个');
    expect(skippedLine([{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '需要意识形态' }, { kind: 'government', id: 'b', name: 'B', kindLabel: '政体', reason: '需要民族认同' }])).toBe('还有 2 项缺别的内容，没加');
    expect(doneHead('添加“社会主义共和国”等 19 项', [])).toBe('已添加“社会主义共和国”等 19 项');
    expect(doneHead('添加 2 项', [{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '需要意识形态' }])).toBe('已添加 2 项。还有 1 项需要意识形态，没加');
  });
});

describe('重新生成的一句话（没有“添加并重新生成”按钮时写在清单底下）', () => {
  it('世界有国家时才写；加了变量写加变量的那句', () => {
    const eng = continents();
    const modern = pack('modern');
    const none = importCommand({ source: modern, target: { t: 'world', world: eng.world }, picks: [{ kind: 'mapStyle', id: packItems<{ id: string }>(modern, 'mapStyles')[0].id }] });
    expect(regenLine(none.preview, { t: 'world', world: eng.world })).toBeNull();
    const human = { small: { ...eng.world.small, human: { era: 'x', countryRules: {} } }, causes: eng.world.causes } as never;
    const gov = importCommand({ source: { id: 's', name: 's', countryTiers: [{ id: 'new-tier', name: '新' }] }, target: { t: 'world', world: eng.world }, picks: [{ kind: 'countryTier', id: 'new-tier' }] });
    expect(regenLine(gov.preview, { t: 'world', world: human })).toBe('重新生成国家后才用上');
    expect(regenLine({ ...gov.preview, dims: [{ id: 'd', label: 'd' }] }, { t: 'world', world: human })).toContain('重新生成国家');
    expect(regenLine(gov.preview, { t: 'pack', pack: mine().pack })).toBeNull();
    const eras = packItems<{ id: string }>(pack('medieval'), 'eras');
    eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
    const withEra = importCommand({ source: { id: 's', name: 's', popValues: [{ id: 'nv', name: '新', dimension: 'religion' }] } as never, target: { t: 'world', world: eng.world }, picks: [{ kind: 'popValue', id: 'nv' }] });
    expect(regenLine(withEra.preview, { t: 'world', world: human })).toContain('重新生成人文才分到人');
  });

  it('灰的跳过：清单底下写几项、按真实原因写', () => {
    const eng = eraWorld('fantasy');
    const modern = pack('modern');
    const picks = packItems<{ id: string }>(modern, 'governments').map((g) => ({ kind: 'government', id: g.id }));
    const p = importPreview({ source: modern, target: { t: 'world', world: eng.world }, picks });
    expect(p.dropped.length).toBeGreaterThan(0);
    expect(p.dropped.length + p.rows.filter((r) => r.role === 'pick').length).toBe(picks.length);
    expect(skippedLine(p.dropped)).toContain('需要');
  });
});
