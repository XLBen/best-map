import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { allKinds, enableCommand, itemId, kindOf } from '../../../core/content/registry';
import { digest } from '../../../core/digest';
import { Engine } from '../../../core/engine';
import { packItems } from '../../../core/packs';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../../../core/packs/import';
import { type PostedRegenBase, postRegenBase, regenBaseOf, unpostRegenBase } from '../../../core/regen-base';
import { NO_CURRENTS, engineFor, humanDigest, meshFor, setGroupWeights } from '../../../core/testing/fixtures';
import type { World } from '../../../core/world';
import { type LibraryEntry, library } from '../../library';
import { RegenTrack } from '../../regen-track';
import { regenTrack } from '../../state';
import { newWaterType } from '../panels/water-types';
import { blankItem, copyItem } from './fields';
import { cultureGroupChoices, newChoiceOf } from './new-in';
import { newItemIn } from './page-actions';
import { segmentsOf } from './page-segments';
import { type PageCtx, type SourceRef, WORLD_SOURCE } from './pages';
import { libPanel, pendingBadge, showWorldLibrary } from './panel-store';
import { LANDMARK_TOKENS, flagPreview, landmarkSamples } from './previews';
import { type RegenNeed, regenCommand, regenNeed } from './regen';
import { REGEN_KINDS, type Timing, fieldTiming, instantKeys, kindTiming, segmentTiming, timingLine } from './timing';

// 第九十轮：资源库“改了就看得到”——新建就生效、复制保持原样；每一段标改了什么时候用上（从一张表推，和“改了 N 项”同一张）；
// “改了 N 项”刷新、重新打开以后还在（从命令记录里算），顶栏上有小标记；地标名字、政体的旗的小预览。
// “在地图上”一行的每种原因在 on-map.test.ts

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const MINE: LibraryEntry = { key: 'mine-1', pack: { ...builtinPacks().find((p) => p.id === 'medieval')!, id: 'mine-1', name: '我的库' }, builtin: false, mine: true, installedAt: 0 };
const ROOTS = BUILTIN.map((e) => ({ key: e.key, pack: e.pack }));
const ctxOf = (e: Engine | null, lib: LibraryEntry[] = BUILTIN): PageCtx => ({ world: e && { ...e.world }, lib });
const SETTINGS = { cells: 3000, seed: 2 };

let bare: Engine;
let full: Engine;
beforeAll(() => {
  bare = engineFor(SETTINGS, { bare: true });
  bare.exec(NO_CURRENTS);
  bare.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  library.value = BUILTIN;
  full = worldOf();
});

function worldOf(more: Record<string, unknown> | null = { countries: {}, settlements: {} }, lib = 'medieval'): Engine {
  const e = bare.clone();
  const root = builtinPacks().find((p) => p.id === lib)!;
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf(lib))) e.exec(c);
  const groups = packItems<{ id: string; weight?: number }>(root, 'cultureGroups')
    .filter((g) => g.weight !== 0)
    .slice(0, 3)
    .map((g) => ({ id: g.id, weight: 1 }));
  for (const c of packImportCommands(ROOTS, { packs: [[lib]], groups: groups.map((g) => g.id) }, e.world)) e.exec(c);
  setGroupWeights(e, groups);
  if (more) e.exec({ op: 'generate_human', packs: [[lib]], groups: groups.map((g) => g.id), ...more } as Command);
  // 和新建向导一样：最后划分省份
  e.exec({ op: 'generate_provinces', seed: 1 });
  e.update();
  return e;
}

const items = (e: Engine, kind: string) => kindOf(kind)!.inWorld(e.world) as Record<string, unknown>[];
const item = (e: Engine, kind: string, id: string) => items(e, kind).find((x) => itemId(kindOf(kind)!, x) === id)!;
const put = (e: Engine, kind: string, next: Record<string, unknown>): Command => {
  const cmd = enableCommand(kindOf(kind)!, next, e.world);
  e.exec(cmd);
  e.update();
  return cmd;
};

// ---------- 新建、复制 ----------

describe('新建就生效、复制保持原样', () => {
  it('生态、河、湖：新建的“自然生成”开着；三处新建河湖的默认一样', () => {
    for (const kind of ['biome', 'riverType', 'lakeType']) expect((kindOf(kind)!.blank!() as { natural?: boolean }).natural, kind).toBe(true);
    const w = full.world as World;
    expect(newWaterType(w, 'river').natural).toBe(true);
    expect(newWaterType(w, 'lake').natural).toBe(true);
  });

  it('默认值是界面发命令时写进命令的：命令里写着关着，执行、重放出来就是关着（登记表里的默认不参与）', () => {
    const e = full.clone();
    // 以前的界面发的命令（自然生成关着）
    const old: Command = { op: 'add_species', species: { id: 'old-new', name: '新生态', color: '#88aa66', terrain: 'plains', competition: 1, tolerances: [], natural: false } };
    e.exec(old);
    e.exec({ op: 'set_river_type', type: { id: 'old-river', name: '新的河', color: '#2a7fbf', natural: false } });
    // 没写“自然生成”的（更早的命令）：照旧是开着的意思，世界里也不补上
    e.exec({ op: 'add_species', species: { id: 'older', name: '更早', color: '#88aa66', terrain: 'plains', competition: 1, tolerances: [] } });
    e.update();
    const again = Engine.fromDoc(e.toDoc(), meshFor(SETTINGS));
    for (const w of [e.world, again.world]) {
      expect(w.small.species.find((s) => s.id === 'old-new')!.natural).toBe(false);
      expect(w.small.riverTypes!.find((t) => t.id === 'old-river')!.natural).toBe(false);
      expect('natural' in w.small.species.find((s) => s.id === 'older')!).toBe(false);
    }
    expect(digest(again.world.derived.dominant)).toBe(digest(e.world.derived.dominant));
  });

  it('通用的复制原样：自然生成、条件一个不动，只换 id、名字带编号', () => {
    const k = kindOf('riverType')!;
    for (const natural of [true, false]) {
      const src = { id: 'r', name: '河', color: '#123456', natural, biomes: ['a'] };
      expect(copyItem(k, src, new Set(['r']))).toEqual({ ...src, id: 'r-2', name: '河 2' });
    }
  });

  it('文化：在组里新建跟这个组；从“全部文化”新建先选组——本世界只列参与生成的组，不再默认 chinese', () => {
    const e = full.clone();
    const h = e.world.small.human!;
    const ctx = ctxOf(e);
    // 加两个组：多少是 0 的不参与；本世界自己加的（多少不是 0）下次重新生成就参与，算
    put(e, 'cultureGroup', { id: 'outsiders', name: '局外', color: '#999999', weight: 0 });
    put(e, 'cultureGroup', { id: 'newcomers', name: '新来', color: '#999999' });
    const ctx2 = ctxOf(e);
    const choice = newChoiceOf('culture', {}, WORLD_SOURCE, ctx2)!;
    expect(choice.field).toBe('group');
    expect(choice.options.map((o) => o.id).sort()).toEqual([...h.groups, 'newcomers'].sort());
    expect(choice.options.some((o) => o.id === 'outsiders')).toBe(false);
    // 这个世界没有 chinese 以外的也照样：列的都是世界里参与的，不是写死的哪一组
    expect(choice.options.every((o) => items(e, 'cultureGroup').some((g) => g.id === o.id))).toBe(true);
    // 已经定了组（在某个文化组里新建）：不用选
    expect(newChoiceOf('culture', { group: h.groups[0] }, WORLD_SOURCE, ctx)).toBeNull();
    expect(newChoiceOf('government', {}, WORLD_SOURCE, ctx)).toBeNull();
    // 没选组时不建（不会悄悄放进登记表里写的那个组）
    expect(newItemIn(WORLD_SOURCE, kindOf('culture')!, ctx)).toBeNull();
    // 我的库里列这个库的全部组；一个组都没有时写一句
    const lib: SourceRef = { t: 'lib', key: MINE.key };
    const inLib = cultureGroupChoices(lib, ctxOf(null, [...BUILTIN, MINE]));
    expect(inLib.options.length).toBe(packItems(MINE.pack, 'cultureGroups').length);
    const empty: LibraryEntry = { ...MINE, key: 'empty', pack: { ...MINE.pack, id: 'empty', cultureGroups: [], packs: [] } as LibraryEntry['pack'] };
    expect(cultureGroupChoices({ t: 'lib', key: 'empty' }, ctxOf(null, [empty]))).toMatchObject({ options: [], empty: '先新建一个文化组' });
    // 还没生成人文的世界：多少不是 0 的组
    const none = worldOf(null);
    put(none, 'cultureGroup', { id: 'zero', name: '零', color: '#999999', weight: 0 });
    const ids = cultureGroupChoices(WORLD_SOURCE, ctxOf(none)).options.map((o) => o.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain('zero');
  });
});

// ---------- 改了什么时候用上 ----------

// 本世界里每种内容每一段标什么（i 即时、r 要重新生成；没列的段不标）。有意改时改这张表
const WORLD_TIMING: Record<string, Record<string, Timing>> = {
  biome: { basic: 'instant', where: 'instant', water: 'instant', human: 'instant', look: 'instant', effects: 'instant', feature: 'instant', scripts: 'instant' },
  riverType: { basic: 'instant', where: 'instant', bank: 'instant', names: 'instant', scripts: 'instant' },
  lakeType: { basic: 'instant', where: 'instant', bank: 'instant', names: 'instant', scripts: 'instant' },
  islandType: { basic: 'instant', names: 'instant' },
  nameStyle: { basic: 'instant', words: 'instant' },
  terrainClass: { basic: 'instant', rules: 'instant', traits: 'instant', export: 'instant' },
  resource: { basic: 'instant', rules: 'instant', spread: 'instant' },
  mapStyle: { basic: 'instant', land: 'instant', sea: 'instant', lines: 'instant', water: 'instant', text: 'instant' },
  provinceRules: { basic: 'instant', size: 'regen', water: 'instant', borders: 'regen' },
  era: { basic: 'regen', dims: 'instant', people: 'regen', state: 'regen', relations: 'instant' },
  valueGroup: { basic: 'regen' },
  popValue: { basic: 'regen', prefs: 'regen' },
  cultureGroup: { basic: 'regen', names: 'regen', tend: 'regen', prefs: 'regen' },
  culture: { basic: 'regen', names: 'regen', tend: 'regen', prefs: 'regen' },
  government: { basic: 'regen', titles: 'instant', only: 'regen', shape: 'regen', flag: 'regen' },
  faction: { basic: 'instant', drivers: 'instant' },
  countryTier: { basic: 'regen', join: 'regen', capital: 'instant' },
  countryPattern: { basic: 'regen', params: 'regen' },
  cityRank: { basic: 'regen', rule: 'regen', look: 'instant' },
  landmarkType: { basic: 'instant', who: 'regen', where: 'regen', label: 'instant' },
  pointType: { basic: 'instant', city: 'regen' },
};

describe('改了什么时候用上', () => {
  it('本世界：每种内容每一段标“即时”还是“要重新生成”', () => {
    const got: Record<string, Record<string, Timing>> = {};
    for (const kind of allKinds().filter((k) => k.pack.listed)) {
      const row: Record<string, Timing> = {};
      for (const s of segmentsOf(kind)) {
        const t = segmentTiming('world', kind, s);
        if (t) row[s.id] = t.timing;
      }
      if (Object.keys(row).length) got[kind.id] = row;
    }
    expect(got).toEqual(WORLD_TIMING);
  });

  it('我的库：都是“只影响新地图”；只读的库、本世界的星球形态、示例那一段不标', () => {
    for (const kind of allKinds()) {
      for (const s of segmentsOf(kind)) {
        const t = segmentTiming('mine', kind, s);
        if (s.custom === 'samples' || (!s.fields.length && !s.custom)) expect(t, `${kind.id}.${s.id}`).toBeNull();
        else expect(t?.timing, `${kind.id}.${s.id}`).toBe('new');
        for (const src of ['builtin', 'imported', 'file', null] as const) expect(segmentTiming(src, kind, s)).toBeNull();
      }
    }
    for (const s of segmentsOf(kindOf('planetForm')!)) expect(segmentTiming('world', kindOf('planetForm')!, s)).toBeNull();
    expect(kindTiming('world', 'biome')).toBe('instant');
    expect(kindTiming('mine', 'biome')).toBe('new');
    expect(kindTiming('builtin', 'biome')).toBeNull();
    expect(kindTiming('world', 'era')).toBe('regen');
  });

  it('从种类和字段推：不在“要重新生成”的种类里都即时；里面的只有画的时候现读的几项即时', () => {
    for (const kind of allKinds()) {
      const regen = REGEN_KINDS.includes(kind.id);
      for (const f of kind.fields) {
        const t = fieldTiming(kind.id, f.key);
        if (!regen) expect(t, `${kind.id}.${f.key}`).toBe('instant');
        else if (kind.id !== 'provinceRules') expect(t, `${kind.id}.${f.key}`).toBe(instantKeys(kind.id).has(f.key) ? 'instant' : 'regen');
      }
    }
    // 省份划分：只有重新划分才读的几项要重新生成
    expect(['size', 'varied', 'wasteland', 'seaByDistance', 'riverCost', 'ridgeCost'].map((k) => fieldTiming('provinceRules', k))).toEqual(Array(6).fill('regen'));
    expect(['name', 'description', 'lakeMode'].map((k) => fieldTiming('provinceRules', k))).toEqual(Array(3).fill('instant'));
    // 派系不在“要重新生成”的种类里了
    expect(REGEN_KINDS).not.toContain('faction');
  });

  it('一段里有马上变的字段时写出来；岛的形状只影响以后放的', () => {
    const seg = (kind: string, id: string) => segmentTiming('world', kindOf(kind)!, segmentsOf(kindOf(kind)!).find((s) => s.id === id)!)!;
    // 第九十一轮：名字、外文名也马上变（现读的）
    expect(seg('culture', 'basic').also).toEqual(['名字', '外文名', '颜色', '说明']);
    expect(timingLine(seg('culture', 'basic'))).toBe('改完点底下的“重新生成”；名字、外文名、颜色、说明马上变');
    expect(timingLine(seg('government', 'basic'))).toBe('改完点底下的“重新生成”；名字、有哪些派系、颜色、说明马上变');
    expect(timingLine(seg('countryTier', 'basic'))).toBe('改完点底下的“重新生成”；名字、简称、说明马上变');
    // 第九十一轮：政体的称号、时代的集团的称号即时，写一句自己改过的不动
    expect(seg('government', 'titles')).toEqual({ timing: 'instant', also: [], note: '自己改过的国名、称号不动' });
    expect(timingLine(seg('government', 'titles'))).toBe('自己改过的国名、称号不动');
    expect(timingLine(seg('era', 'relations'))).toBe('自己改过名字的集团不动');
    expect(timingLine(seg('countryTier', 'capital'))).toBeNull();
    expect(timingLine(seg('islandType', 'basic'))).toBe('形状、高低、岩石只影响以后放的岛');
    expect(timingLine(seg('provinceRules', 'water'))).toBeNull();
    expect(timingLine(seg('provinceRules', 'size'))).toBe('改完点底下的“重新生成”');
  });
});

// 标成“即时”的字段：改了不算“改了 N 项”，而且改了以后重新生成、结果一样（证明生成时确实不读它们）
describe('标“即时”的字段和“改了 N 项”是同一张表', () => {
  const track = (e: Engine) => {
    const t = new RegenTrack();
    t.reset(0, e.world.small.content);
    return t;
  };
  // 每种挑一项：改这几个字段不算；改那一个算
  const CASES: { kind: string; pick?: (e: Engine) => string; quiet: Record<string, unknown>; loud: Record<string, unknown>; regen: Command }[] = [
    { kind: 'countryTier', quiet: { capitalIcon: 0.5, capitalAlpha: 0.4, capitalLabel: 0.6, capitalBold: false, color: '#123456', description: '改' }, loud: { area: 7 }, regen: { op: 'regenerate_countries' } },
    {
      kind: 'government',
      pick: (e) => Object.values(e.world.small.countries!)[0].government,
      quiet: { factions: [], color: '#123456', description: '改' },
      loud: { size: 3 },
      regen: { op: 'regenerate_countries' },
    },
    { kind: 'cityRank', quiet: { name: '改', icon: 'dot', label: 2, alpha: 0.3, iconScale: 0.5, labelAlpha: 0.3 }, loud: { minShare: 0.5 }, regen: { op: 'regenerate_settlements' } },
    {
      kind: 'landmarkType',
      pick: (e) => Object.values(e.world.small.landmarks!)[0].type,
      quiet: { name: '改', icon: 'pin', label: '{place}改' },
      loud: { chance: 0.01 },
      regen: { op: 'regenerate_settlements' },
    },
    { kind: 'pointType', quiet: { name: '改', icon: 'pin', image: 'data:image/png;base64,AAAA' }, loud: { actsAsCity: { capital: true } }, regen: { op: 'regenerate_settlements' } },
  ];

  for (const c of CASES) {
    it(`${kindOf(c.kind)?.label ?? c.kind}：${Object.keys(c.quiet).join('、')} 不算，改了以后重新生成结果一样；${Object.keys(c.loud).join('、')} 算`, () => {
      const e = full.clone();
      const id = c.pick?.(e) ?? itemId(kindOf(c.kind)!, items(e, c.kind)[0]);
      const t = track(e);
      put(e, c.kind, { ...item(e, c.kind, id), ...c.quiet });
      t.step(1, e.world.small.content);
      expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
      // 改了以后重新生成，和没改重新生成一样
      const plain = full.clone();
      plain.exec(c.regen);
      plain.update();
      e.exec(c.regen);
      e.update();
      expect(humanDigest(e.world)).toEqual(humanDigest(plain.world));
      // 生成要读的那一项：算
      const e2 = full.clone();
      const t2 = track(e2);
      put(e2, c.kind, { ...item(e2, c.kind, id), ...c.loud });
      t2.step(1, e2.world.small.content);
      expect(regenNeed(e2.world.small, t2.base(), BUILTIN)?.count).toBe(1);
    });
  }

  // 第九十一轮：名字、外文名、简称是现读的。每一种里有这几项的都改一遍：不算“改了 N 项”，改了以后重新生成结果一样
  // （只有文化的名字写进了国家档案“历史”那一段：那是写下的字，不跟着改，重新生成才换）
  it('名字、外文名、简称：每一种都不算；改了以后重新生成，结果一样（文化的名字只差“历史”那一段文字）', () => {
    for (const kindId of REGEN_KINDS) {
      if (kindId === 'provinceRules') continue;
      const kind = kindOf(kindId)!;
      const keys = ['name', 'orig', 'short'].filter((k) => kind.fields.some((f) => f.key === k));
      expect(keys.length, kindId).toBeGreaterThan(0);
      for (const k of keys) expect(fieldTiming(kindId, k), `${kindId}.${k}`).toBe('instant');
      const e = full.clone();
      const t = track(e);
      for (const x of items(e, kindId)) put(e, kindId, { ...x, ...Object.fromEntries(keys.map((k) => [k, `改${String(itemId(kind, x)).slice(0, 5)}`])) });
      t.step(1, e.world.small.content);
      expect(regenNeed(e.world.small, t.base(), BUILTIN), kindId).toBeNull();
      const regen: Command = REGEN_KINDS.indexOf(kindId) >= 0 && ['cityRank', 'landmarkType', 'pointType'].includes(kindId) ? { op: 'regenerate_settlements' } : { op: 'regenerate_countries' };
      const plain = full.clone();
      plain.exec(regen);
      plain.update();
      e.exec(regen);
      e.update();
      const a = humanDigest(e.world);
      const b = humanDigest(plain.world);
      if (kindId !== 'culture') expect(a, kindId).toEqual(b);
      else {
        expect({ ...a, countries: '' }).toEqual({ ...b, countries: '' });
        const bare = (w: World) => Object.values(w.small.countries!).map((m) => ({ ...m, history: '' }));
        expect(bare(e.world as World)).toEqual(bare(plain.world as World));
      }
    }
  });

  // 第九十一轮：政体的称号、统治者称号、换说法——国名、称号跟着资源库变（core/human/retitle.ts）
  it('政体的称号、统治者称号、换说法：不算“改了 N 项”，国名和称号马上变；和“改完再重新生成国家”起出来的一样', () => {
    const e = full.clone();
    const w = () => e.world as World;
    const govId = Object.values(w().small.countries!).find((m) => !m.nameLocked)!.government;
    const g = item(e, 'government', govId);
    for (const k of ['titles', 'rulers', 'names']) expect(fieldTiming('government', k)).toBe('instant');
    const names0 = Object.fromEntries(Object.values(w().small.countries!).map((m) => [m.id, m.name]));
    const t = track(e);
    const re = (v: unknown): unknown => (typeof v === 'string' ? `${v}改` : Array.isArray(v) ? v : v && typeof v === 'object' ? ('zh' in v ? { ...v, zh: `${(v as { zh: string }).zh}改` } : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, re(x)]))) : v);
    const names = ((g.names as Record<string, unknown>[] | undefined) ?? []).map((r) => ({ ...r, ...(r.titles !== undefined ? { titles: re(r.titles) } : {}), ...(r.rulers !== undefined ? { rulers: re(r.rulers) } : {}) }));
    put(e, 'government', { ...g, titles: re(g.titles), ...(g.rulers !== undefined ? { rulers: re(g.rulers) } : {}), ...(g.names ? { names: [...names, { cultureGroups: ['no-such-group'], titles: '某某国' }] } : {}) });
    t.step(1, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    // 真的马上变了
    const hit = Object.values(w().small.countries!).filter((m) => m.government === govId && !m.nameLocked);
    expect(hit.length).toBeGreaterThan(0);
    for (const m of hit) expect(m.name).toBe(`${names0[m.id]}改`);
    for (const m of Object.values(w().small.countries!)) if (m.government !== govId) expect(m.name).toBe(names0[m.id]);
    // 和重新生成起出来的一样
    const list = (x: World) =>
      Object.values(x.small.countries!)
        .map((m) => `${m.name}|${m.orig ?? ''}|${(x.small.archive?.countries[m.id]?.rulers ?? []).map((r) => r.title ?? '').join(',')}`)
        .sort();
    const now = list(w());
    e.exec({ op: 'regenerate_countries' });
    e.update();
    expect(list(w())).toEqual(now);
  });

  it('时代的“集团的称号”：不算“改了 N 项”；同一种里生成要读的一项（国家大小）改了就算', () => {
    expect(fieldTiming('era', 'relations')).toBe('instant');
    const e = full.clone();
    const era = item(e, 'era', e.world.small.human!.era);
    const t = track(e);
    put(e, 'era', { ...era, relations: { titles: { empire: ['天朝'], alliance: ['盟约'], federation: ['合众国'], member: ['州'] } } });
    t.step(1, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    put(e, 'era', { ...item(e, 'era', e.world.small.human!.era), countryKm2: 123456 });
    t.step(2, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toMatchObject({ count: 1, scopes: ['human', 'countries'] });
  });

  it('派系：改“多少”、来自人口都不算；改了以后重新生成国家结果一样', () => {
    const e = full.clone();
    const t = track(e);
    for (const f of items(e, 'faction')) put(e, 'faction', { ...f, amount: 5, drivers: [] });
    t.step(1, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    const plain = full.clone();
    plain.exec({ op: 'regenerate_countries' });
    plain.update();
    e.exec({ op: 'regenerate_countries' });
    e.update();
    expect(humanDigest(e.world)).toEqual(humanDigest(plain.world));
  });

  it('新加一种点（只有名字、图标、颜色）不算；新加一种城市等级、地标算', () => {
    const e = full.clone();
    const t = track(e);
    put(e, 'pointType', { id: 'new-pt', name: '新的点', icon: 'pin', color: '#d94a3d' });
    t.step(1, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    put(e, 'cityRank', blankItem(kindOf('cityRank')!, new Set())!);
    t.step(2, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)?.count).toBe(1);
  });
});

// ---------- 刷新以后还在 ----------

// 主线程收到的那一份（过一遍结构化克隆，和 Worker 发过来一样）
const received = (e: Engine): { base: ReturnType<typeof unpostRegenBase>; posted: PostedRegenBase } => {
  const posted = structuredClone(postRegenBase(e.regenBase(), e.world.small.content));
  return { base: unpostRegenBase(posted, e.world.small.content), posted };
};
const brief = (n: RegenNeed | null) => n && { scopes: n.scopes, count: n.count, label: n.label, what: n.what, warn: n.warn };

describe('待用上的改动刷新、重新打开以后还在', () => {
  // 生成之后：改政体、改省份大小、手改一个国家、改城市等级的“连大道”
  function edited(): { e: Engine; t: RegenTrack; steps: number } {
    const e = full.clone();
    const t = new RegenTrack();
    const start = e.history.filter((h) => h.done).length;
    t.reset(start, e.world.small.content, e.regenBase());
    let at = start;
    const run = (cmd: Command) => {
      e.exec(cmd);
      e.update();
      t.pending = cmd;
      t.step(++at, e.world.small.content);
    };
    const gov = Object.values(e.world.small.countries!)[0].government;
    run(enableCommand(kindOf('government')!, { ...item(e, 'government', gov), size: 3 }, e.world));
    run(enableCommand(kindOf('provinceRules')!, { ...items(e, 'provinceRules')[0], size: 90 }, e.world));
    run({ op: 'set_country', id: Number(Object.keys(e.world.small.countries!)[0]), patch: { name: '手改' } } as Command);
    const rank = items(e, 'cityRank')[0];
    run(enableCommand(kindOf('cityRank')!, { ...rank, major: !rank.major }, e.world));
    return { e, t, steps: at };
  }

  it('刚生成完：没有待用上的；发给主线程的那一份是空的', () => {
    const { base, posted } = received(full);
    expect(posted).toEqual({ diff: {} });
    expect(regenNeed(full.world.small, base, BUILTIN)).toBeNull();
    // 没变的就是手上的同一个对象
    expect(base.human).toBe(full.world.small.content);
  });

  it('从世界文件重放、从检查点恢复：和这次打开页面里跟着记的一样', () => {
    const { e, t } = edited();
    const live = brief(regenNeed(e.world.small, t.base(), BUILTIN));
    expect(live).toMatchObject({ scopes: ['provinces', 'countries'], count: 3, warn: '手改过的国家会被换掉' });
    // 这次打开页面里：引擎从历史里算的和主线程跟着记的一样
    expect(brief(regenNeed(e.world.small, received(e).base, BUILTIN))).toEqual(live);
    // 存成世界文件再打开（重放）
    const doc = structuredClone(e.toDoc());
    const replayed = Engine.fromDoc(doc, meshFor(SETTINGS));
    expect(brief(regenNeed(replayed.world.small, received(replayed).base, BUILTIN))).toEqual(live);
    // 刷新页面（从检查点恢复，检查点是结构化克隆进存储的）
    const restored = Engine.fromCheckpoint(structuredClone(e.toCheckpoint()), doc, meshFor(SETTINGS))!;
    expect(restored).not.toBeNull();
    expect(brief(regenNeed(restored.world.small, received(restored).base, BUILTIN))).toEqual(live);
    // 只带换过的项：三项内容，一样一种
    const { posted } = received(restored);
    expect(Object.keys(posted.diff).sort()).toEqual(['countries', 'provinces', 'settlements']);
    expect(Object.keys(posted.diff.countries!)).toEqual(['government']);
    expect(Object.keys(posted.diff.countries!.government.set)).toHaveLength(1);
    expect(posted.hand).toEqual(['countries']);
  });

  it('重新打开以后接着做：重新生成就没了，撤销又回来（撤销到打开以前的步骤也知道）', () => {
    const { e } = edited();
    const opened = Engine.fromDoc(structuredClone(e.toDoc()), meshFor(SETTINGS));
    const t = new RegenTrack();
    let at = opened.history.filter((h) => h.done).length;
    t.reset(at, opened.world.small.content, received(opened).base);
    const need = regenNeed(opened.world.small, t.base(), BUILTIN)!;
    expect(need.count).toBe(3);
    const cmd = regenCommand(need, opened.world.small, BUILTIN);
    opened.exec(cmd);
    opened.update();
    t.pending = cmd;
    t.step(++at, opened.world.small.content);
    expect(regenNeed(opened.world.small, t.base(), BUILTIN)).toBeNull();
    expect(received(opened).posted).toEqual({ diff: {} });
    // 撤销重新生成：回到打开时的那一份
    opened.undo();
    t.pending = 'history';
    t.step(--at, opened.world.small.content, received(opened).base);
    expect(regenNeed(opened.world.small, t.base(), BUILTIN)?.count).toBe(3);
    // 再撤销一步（打开以前做的：改城市等级）：主线程没记过这个位置，用引擎给的
    opened.undo();
    t.pending = 'history';
    t.step(--at, opened.world.small.content, received(opened).base);
    expect(brief(regenNeed(opened.world.small, t.base(), BUILTIN))).toMatchObject({ scopes: ['provinces', 'countries'], count: 2, warn: '手改过的国家会被换掉' });
    // 没给引擎的那一份时（以前）：从现在的内容算起，就不知道了
    const blind = new RegenTrack();
    blind.reset(at, opened.world.small.content);
    expect(regenNeed(opened.world.small, blind.base(), BUILTIN)).toBeNull();
  });

  it('一串操作里每一步：引擎从历史里算的和主线程跟着记的都一样', () => {
    const e = full.clone();
    const t = new RegenTrack();
    let at = e.history.filter((h) => h.done).length;
    t.reset(at, e.world.small.content, e.regenBase());
    const same = () => expect(brief(regenNeed(e.world.small, received(e).base, BUILTIN))).toEqual(brief(regenNeed(e.world.small, t.base(), BUILTIN)));
    const run = (cmd: Command) => {
      e.exec(cmd);
      e.update();
      t.pending = cmd;
      t.step(++at, e.world.small.content);
      same();
    };
    const back = () => {
      e.undo();
      t.pending = 'history';
      t.step(--at, e.world.small.content);
      same();
    };
    const again = () => {
      e.redo();
      t.pending = 'history';
      t.step(++at, e.world.small.content);
      same();
    };
    const h = e.world.small.human!;
    const culture = items(e, 'culture').find((c) => h.groups.includes(String(c.group)))!;
    run(enableCommand(kindOf('culture')!, { ...culture, weight: 3 }, e.world));
    run({ op: 'assign_province', cells: [0], province: Number(Object.keys(e.world.small.provinces)[0]) } as Command);
    const gov = Object.values(e.world.small.countries!)[0].government;
    run(enableCommand(kindOf('government')!, { ...item(e, 'government', gov), size: 2 }, e.world));
    run(regenCommand(regenNeed(e.world.small, t.base(), BUILTIN)!, e.world.small, BUILTIN));
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    run({ op: 'set_country', id: Number(Object.keys(e.world.small.countries!)[0]), patch: { name: '手改' } } as Command);
    run(enableCommand(kindOf('landmarkType')!, { ...items(e, 'landmarkType')[0], chance: 0.02 }, e.world));
    run(enableCommand(kindOf('provinceRules')!, { ...items(e, 'provinceRules')[0], size: 70 }, e.world));
    back();
    back();
    again();
    run({ op: 'generate_provinces', seed: 3 });
    run({ op: 'regenerate_settlements' });
    back();
    back();
    back();
    back();
    back();
  });

  it('规则：生成的那一步之后的内容，就是它后面那一步的撤销记录里的那一份', () => {
    const a = { era: { x: { id: 'x' } } };
    const b = { era: { x: { id: 'x', n: 1 } } };
    const c = { era: { x: { id: 'x', n: 2 } } };
    const done = [
      { cmd: { op: 'generate_human' } as Command, undo: {} },
      { cmd: { op: 'set_content', kind: 'era', id: 'x', item: {} } as Command, undo: { content: a } },
      { cmd: { op: 'regenerate_settlements' } as Command, undo: { content: b } },
      { cmd: { op: 'set_country', id: 1, patch: {} } as Command, undo: { content: b } },
      { cmd: { op: 'set_content', kind: 'era', id: 'x', item: {} } as Command, undo: { content: b } },
    ];
    expect(regenBaseOf(done, c)).toEqual({ human: a, countries: a, settlements: b, provinces: c, hand: ['countries'] });
    // 手改的先后不影响写出来的那一句（主线程记的是手改的先后，引擎给的是固定的先后）
    const e = full.clone();
    const rules = items(e, 'provinceRules')[0];
    const gov = Object.values(e.world.small.countries!)[0].government;
    const base = { human: e.world.small.content, countries: e.world.small.content, settlements: e.world.small.content, provinces: e.world.small.content };
    put(e, 'provinceRules', { ...rules, size: 77 });
    put(e, 'government', { ...item(e, 'government', gov), size: 3 });
    for (const hand of [['countries', 'provinces'], ['provinces', 'countries']] as const) expect(regenNeed(e.world.small, { ...base, hand }, BUILTIN)?.warn).toBe('手改过的省份、国家会被换掉');
    // 从来没生成过的：按现在的算
    expect(regenBaseOf([], c)).toEqual({ human: c, countries: c, settlements: c, provinces: c, hand: [] });
    // 每一种生成的命令都认得（单独的、放在 batch 里的）
    for (const op of ['generate_human', 'regenerate_human', 'generate_countries', 'regenerate_countries', 'generate_settlements', 'regenerate_settlements', 'generate_provinces']) {
      const gen = { op } as Command;
      for (const cmd of [gen, { op: 'batch', commands: [gen] } as Command]) {
        const got = regenBaseOf([{ cmd, undo: {} }, { cmd: { op: 'paint_land' } as unknown as Command, undo: { content: a } }], c);
        expect(Object.values(got).filter((x) => x === a).length, op).toBeGreaterThan(0);
      }
    }
    // 发过去再拼回来，逐值一样；没换的种类是同一个对象
    const now = { era: c.era, culture: { k: { id: 'k' } } } as unknown as World['small']['content'];
    const then = { era: a.era, culture: now!.culture } as unknown as World['small']['content'];
    const back = unpostRegenBase(structuredClone(postRegenBase({ human: then, countries: now, settlements: now, provinces: now, hand: [] }, now)), now);
    expect(back.human).toEqual(then);
    expect(back.human!.culture).toBe(now!.culture);
    expect(back.countries).toBe(now);
  });
});

// ---------- 顶栏的小标记 ----------

describe('顶栏“资源库”按钮上的“改了 N 项”', () => {
  it('面板关着、看别的库时写几项；看本世界时不写（那一条就在面板底下）；点了回到本世界', () => {
    const e = full.clone();
    const start = e.history.filter((h) => h.done).length;
    regenTrack.reset(start, e.world.small.content, e.regenBase());
    const w0 = e.world as World;
    expect(pendingBadge(null, { ...w0 }, BUILTIN)).toBe(0);
    const gov = Object.values(e.world.small.countries!)[0].government;
    const cmd = put(e, 'government', { ...item(e, 'government', gov), size: 3 });
    regenTrack.pending = cmd;
    regenTrack.step(start + 1, e.world.small.content);
    const w = { ...(e.world as World) };
    expect(pendingBadge(null, w, BUILTIN)).toBe(1);
    expect(pendingBadge({ source: { t: 'lib', key: 'fantasy' }, stack: [{ p: 'home' }] }, w, BUILTIN)).toBe(1);
    expect(pendingBadge({ source: WORLD_SOURCE, stack: [{ p: 'home' }] }, w, BUILTIN)).toBe(0);
    expect(pendingBadge(null, null, BUILTIN)).toBe(0);
    // 点了：面板开着看别的库时换回本世界
    libPanel.value = { source: { t: 'lib', key: 'fantasy' }, stack: [{ p: 'home' }] };
    showWorldLibrary();
    expect(libPanel.value?.source).toEqual(WORLD_SOURCE);
    libPanel.value = null;
    regenTrack.reset(0, undefined);
  });
});

// ---------- 小预览 ----------

describe('地标名字、政体的旗的预览', () => {
  it('地标名字：每种写法一行，词换成名字；本世界里用地图上的名字', () => {
    const lib: SourceRef = { t: 'lib', key: 'medieval' };
    const temple = { name: '神庙', label: { default: { zh: '{city}神庙', orig: 'Temple of {city}' }, chinese: '{city}大寺' } };
    const inLib = landmarkSamples(temple, lib, ctxOf(null));
    expect(inLib.map((s) => s.zh)).toEqual(['洛安神庙', '洛安大寺']);
    expect(inLib[0]).toMatchObject({ who: '默认', orig: 'Temple of Loan' });
    expect(inLib[1].who).not.toBe('chinese');
    // 一种写法、没写时用类型的名字、不认识的词按小地名
    expect(landmarkSamples({ name: '长城', label: '{country}长城' }, lib, ctxOf(null))).toEqual([{ who: '默认', zh: '青岚长城' }]);
    expect(landmarkSamples({ name: '石阵' }, lib, ctxOf(null))).toEqual([{ who: '默认', zh: '石阵' }]);
    expect(landmarkSamples({ name: 'x', label: '{nothing}塔' }, lib, ctxOf(null))[0].zh).toBe('河口塔');
    expect(landmarkSamples({ name: 'x', label: '{peak}' }, lib, ctxOf(null))[0]).toEqual({ who: '默认', zh: '雪顶山', orig: 'Xueding' });
    for (const t of LANDMARK_TOKENS) expect(landmarkSamples({ name: 'x', label: `{${t}}` }, lib, ctxOf(null))[0].zh).not.toContain('{');
    // 本世界：最大的城市、第一个国家
    const w = full.world as World;
    const here = landmarkSamples({ name: 'x', label: '{country}的{city}塔' }, WORLD_SOURCE, ctxOf(full))[0].zh;
    expect(here).toContain(Object.values(w.small.countries!)[0].base.zh);
    expect(here).not.toContain('洛安');
  });

  it('政体的旗：按写的纹章、样式；换一批不一样；不认识的写出来', () => {
    const gov = { category: ['monarchy'], emblems: ['tower'], layouts: ['cross'] };
    const a = flagPreview(gov, 1);
    expect(a.flags).toHaveLength(6);
    expect(a.unknown).toEqual([]);
    // 有纹章的都是写的那一种；写的样式占多数
    expect(a.flags.filter((f) => f.emblem).every((f) => f.emblem === 'tower')).toBe(true);
    const many = Array.from({ length: 20 }, (_, k) => flagPreview(gov, k + 1).flags).flat();
    expect(many.filter((f) => f.layout === 'cross').length).toBeGreaterThan(many.length / 2);
    expect(flagPreview(gov, 2)).not.toEqual(a);
    expect(flagPreview(gov, 1)).toEqual(a);
    expect(flagPreview({ emblems: ['dragon', 'sun'], layouts: ['zigzag'] }, 1).unknown).toEqual(['dragon', 'zigzag']);
    // 什么都没写也有旗
    expect(flagPreview({}, 1).flags).toHaveLength(6);
  });
});
