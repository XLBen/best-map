import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import '../../../core/content/kinds';
import { linkProblems, linksOf } from '../../../core/content/links';
import { type ContentKind, type FieldDesc, allKinds, kindOf } from '../../../core/content/registry';
import { dpOfPercent } from '../../../core/effect-ranges';
import { BIOME_TERRAINS } from '../../../core/export-terrain';
import { FLAG_EMBLEMS, FLAG_LAYOUTS, makeFlag } from '../../../core/human';
import type { Era } from '../../../core/human';
import { islandTypeSchema } from '../../../core/island-types';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { continents } from '../../../core/testing/fixtures';
import { riverTypeSchema } from '../../../core/river-types';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { newIslandType } from '../panels/island-types';
import { newWaterType } from '../panels/water-types';
import { blankItem, keyProblem, sliderScale, valueText } from './fields';
import { genNotes } from './gen-settings';
import { libraryDelete, referrersText, worldDelete } from './item-delete';
import { setShowAllSettings, setShowAllSources, showAllSettings, showAllSources } from './lib-prefs';
import { usedByOf } from './page-used-by';
import { MORE_ID, moreBrief, moreKey, moreOpen, moreSegmentsBrief, segmentIsMore, splitMore, splitSegments, toggleMore } from './more-settings';
import { fieldBrief, initialOpen, segmentsOf } from './page-segments';
import { type PageCtx, WORLD_SOURCE, itemActions, rowsOf } from './pages';
import { LANDMARK_TOKENS, LANDMARK_TOKEN_NAMES, flagChoices, toggleFlagWord, unknownFlagWords } from './previews';
import { newRefName, refLabel, refNewMax, refOptions, refOptionsOf } from './refs';
import type { ItemRow } from './rows';

// 第九十三轮：资源库（四）表单变简单、做法一致。
//   表单变简单：常用 / 更多设置（哪些字段算常用钉在这里，和设计文档的表是同一张）、不再手填英文的 id 和记号、同一个数一套范围
//   （范围本身的测试在 core/effect-ranges.test.ts）；做法一致：新建的 id 一种起法、同一排按钮、删除同一套规矩

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const kinds = (): ContentKind[] => allKinds().filter((k) => k.id !== 'field');

afterEach(() => setShowAllSources(false));

// ---------- 常用 / 更多设置 ----------

// 每种内容平时就在页面上的字段：段 → 字段（按页面上的先后）。没列的段整个在页面底下的“更多设置”里；
// 列着的段里没写到的字段在这一段最下面折叠着。生态的页面是自己的编辑器（BiomeEditor.tsx），这里钉的是它照着做的那张表
const COMMON: Record<string, Record<string, string[]>> = {
  biome: { basic: ['name', 'color', 'natural', 'competition'], where: ['height'] },
  riverType: { basic: ['name', 'color', 'style', 'width'], where: ['natural', 'biomes'] },
  lakeType: { basic: ['name', 'color', 'style'], where: ['natural', 'biomes'] },
  islandType: { basic: ['name', 'shape', 'height', 'color'] },
  planetForm: { basic: ['name', 'hint'], profile: ['profile'] },
  nameStyle: { basic: ['name', 'description'], words: ['lists', 'lists'], samples: [] },
  terrainClass: { basic: ['name', 'color', 'height', 'description'], traits: ['movement', 'habitability'] },
  resource: { basic: ['name', 'color', 'icon', 'category', 'description'], spread: ['rarity', 'cluster'] },
  era: { basic: ['name', 'color', 'description'], people: ['popDensity', 'urbanization'], state: ['countryKm2', 'tiers', 'patterns', 'nationalism'] },
  valueGroup: { basic: ['name', 'color', 'description'] },
  popValue: { basic: ['name', 'color', 'group', 'description'] },
  cultureGroup: { basic: ['name', 'color', 'weight', 'description'], names: ['nameStyle'] },
  culture: { basic: ['name', 'color', 'group', 'weight', 'description'], names: ['nameStyle'] },
  government: { basic: ['name', 'color', 'weight', 'description'], titles: ['titles', 'rulers'], shape: ['size', 'expansion'], flag: ['emblems', 'layouts'] },
  faction: { basic: ['name', 'color', 'amount', 'description'] },
  countryTier: { basic: ['name', 'area', 'description'] },
  countryPattern: { basic: ['name', 'description', 'amount'] },
  cityRank: { basic: ['name', 'icon', 'color', 'description'], rule: ['minShare'], look: ['label'] },
  landmarkType: { basic: ['name', 'icon', 'color', 'description'], who: ['cultureGroups'], where: ['place', 'count'], label: ['label'] },
  pointType: { basic: ['name', 'icon', 'image', 'color', 'description'] },
  mapStyle: {
    basic: ['name', 'description'],
    land: ['landTint', 'landTintAmount'],
    sea: ['sea', 'seaShade', 'tier1', 'tier2', 'tier3', 'tier4'],
    lines: ['coastLine', 'coastAmount', 'provinceLine', 'countryLine'],
    water: ['river', 'quietRoad'],
    text: ['countryLabel'],
    hand: ['paper', 'wash', 'ripples', 'mountains', 'forests'],
  },
  provinceRules: { basic: ['name', 'description'], size: ['size', 'varied', 'wasteland'], water: ['lakeMode'] },
};

describe('常用 / 更多设置', () => {
  it('每种内容平时露哪些字段：整张表钉住', () => {
    const got: Record<string, Record<string, string[]>> = {};
    for (const k of kinds()) {
      got[k.id] = {};
      for (const s of splitSegments(segmentsOf(k), false).main) got[k.id][s.id] = splitMore(s.fields, false).common.map((f) => f.key);
    }
    expect(got).toEqual(COMMON);
  });

  it('平时露的不多：每一段不超过六项，名字都在第一段', () => {
    for (const k of kinds()) {
      const main = splitSegments(segmentsOf(k), false).main;
      expect(main[0].fields.some((f) => f.key === 'name' && !f.more), k.id).toBe(true);
      for (const s of main) expect(splitMore(s.fields, false).common.length, `${k.id}.${s.id}`).toBeLessThanOrEqual(6);
    }
  });

  it('规则、脚本、换说法、限谁用、倾向都在“更多设置”里', () => {
    const isMore = (kind: string, key: string) => kindOf(kind)!.fields.filter((f) => f.key === key).every((f) => f.more === true);
    for (const [kind, key] of [
      ['riverType', 'scripts'],
      ['lakeType', 'scripts'],
      ['biome', 'scripts'],
      ['planetForm', 'scripts'],
      ['terrainClass', 'rules'],
      ['resource', 'rules'],
      ['government', 'names'],
      ['government', 'only'],
      ['government', 'category'],
      ['culture', 'tendencies'],
      ['cultureGroup', 'eraTendencies'],
      ['culture', 'prefs'],
      ['era', 'dimensions'],
      ['era', 'relations'],
      ['nameStyle', 'types'],
    ] as const)
      expect(isMore(kind, key), `${kind}.${key}`).toBe(true);
  });

  it('一段是不是整个算“更多设置”：有字段、而且全是 more 的；没有字段的自己画的段（示例）是常用的；自己写了的照写的', () => {
    const f = (key: string, more?: true): FieldDesc => ({ key, label: key, type: 'text', ...(more ? { more } : {}) });
    expect(segmentIsMore({ fields: [f('a', true), f('b', true)] })).toBe(true);
    expect(segmentIsMore({ fields: [f('a', true), f('b')] })).toBe(false);
    expect(segmentIsMore({ fields: [] })).toBe(false);
    expect(segmentIsMore({ fields: [], more: true })).toBe(true);
    expect(segmentIsMore({ fields: [f('a', true)], more: false })).toBe(false);
    // 时代：变量、集团的称号整段收起；人口、国家留着
    const era = splitSegments(segmentsOf(kindOf('era')!), false);
    expect(era.main.map((s) => s.id)).toEqual(['basic', 'people', 'state']);
    expect(era.more.map((s) => s.id)).toEqual(['dims', 'relations']);
  });

  it('画风的“基本”不再有 13 项：手绘的另成一段，很少动的两项整段收起', () => {
    const segs = segmentsOf(kindOf('mapStyle')!);
    expect(segs.find((s) => s.id === 'basic')!.fields.map((f) => f.key)).toEqual(['name', 'description']);
    expect(segs.find((s) => s.id === 'hand')!.fields.map((f) => f.key)).toEqual(['paper', 'wash', 'ripples', 'mountains', 'forests', 'paperColor', 'rippleColor', 'ink']);
    expect(splitSegments(segs, false).more.map((s) => s.id)).toEqual(['other']);
    // 字段还是每个都在、只在一段里
    const all = segs.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(kindOf('mapStyle')!.fields.length - 1);
  });

  it('都摊开：一个函数说了算，和来源下拉的“更多”是同一个偏好', () => {
    expect([showAllSettings(), showAllSources()]).toEqual([false, false]);
    setShowAllSettings(true);
    expect([showAllSettings(), showAllSources()]).toEqual([true, true]);
    const segs = segmentsOf(kindOf('government')!);
    expect(splitSegments(segs, true)).toEqual({ main: segs, more: [] });
    expect(splitMore(segs[0].fields, true)).toEqual({ common: segs[0].fields, more: [] });
    setShowAllSources(false);
    expect(showAllSettings()).toBe(false);
  });

  it('展开过的记着：页面底下那一层、一段里的那一层各有各的键；直达里面的一段时那一层跟着展开', () => {
    const { more } = splitSegments(segmentsOf(kindOf('era')!), false);
    expect(moreOpen(new Set(['basic']), more)).toBe(false);
    expect(moreOpen(new Set([MORE_ID]), more)).toBe(true);
    // 从别处直达“变量”那一段（route.seg）：它在“更多设置”里，那一层算展开着
    expect(moreOpen(initialOpen(segmentsOf(kindOf('era')!), 'dims'), more)).toBe(true);
    // 点一下收起：里面展开着的也收起（不然马上又算展开着）
    expect([...toggleMore(new Set(['basic', 'dims', MORE_ID]), more)]).toEqual(['basic']);
    expect([...toggleMore(new Set(['basic']), more)]).toEqual(['basic', MORE_ID]);
    expect(moreKey('titles')).not.toBe(MORE_ID);
    expect(moreKey('titles')).not.toBe(moreKey('shape'));
  });

  it('收着时写里面是什么', () => {
    expect(moreBrief([])).toBe('');
    expect(moreBrief(['换说法'])).toBe('换说法');
    expect(moreBrief(['偏海岸', '城市化', '紧凑', '收附庸', '游牧'])).toBe('偏海岸、城市化、紧凑 等 5 项');
    expect(moreSegmentsBrief([{ title: '限谁用' }], true)).toBe('限谁用、id');
    expect(moreSegmentsBrief([], true)).toBe('id');
  });
});

// ---------- 不再手填 id 和记号 ----------

const ASCII_WORD = /[A-Za-z]{3,}/;
// 平时露的字段的说明里允许的英文：花括号里的词是起名模板的写法（下面有示例和能写的词）
const strip = (s: string) => s.replace(/\{[^}]*\}/g, '').replace(/km²?|m³\/s|\bm\b/g, '');

describe('常用的那一层没有要手填英文的地方', () => {
  const commonFields = (k: ContentKind): FieldDesc[] => splitSegments(segmentsOf(k), false).main.flatMap((s) => splitMore(s.fields, false).common);

  it('字段的名字、说明、选项都是中文', () => {
    for (const k of kinds()) {
      for (const f of commonFields(k)) {
        expect(ASCII_WORD.test(strip(f.label)), `${k.id}.${f.key} 的名字`).toBe(false);
        expect(ASCII_WORD.test(strip(f.hint ?? '')), `${k.id}.${f.key} 的说明“${f.hint}”`).toBe(false);
        for (const o of f.options ?? []) expect(ASCII_WORD.test(o.label), `${k.id}.${f.key} 的选项 ${o.value}`).toBe(false);
      }
    }
  });

  it('一组字（tags）都是从现成的里面选：写了 ref / pick，或者界面另画（旗的纹章、样式）', () => {
    const drawn = new Set(['government.emblems', 'government.layouts']);
    for (const k of kinds()) for (const f of commonFields(k)) if (f.type === 'tags') expect(!!(f.ref ?? f.pick) || drawn.has(`${k.id}.${f.key}`), `${k.id}.${f.key}`).toBe(true);
  });

  it('手打的框只剩名字、说明这样的字：平时露的 text 字段都在这张单子里', () => {
    const typed = new Set(['name', 'hint', 'description']);
    // 图标是下拉、图片是上传、岛的颜色是几个里选一个（ContentEditor.tsx 按种类画）
    const drawn = new Set(['icon', 'image', 'color']);
    for (const k of kinds()) for (const f of commonFields(k)) if ((f.type === 'text' || f.type === 'longtext') && !(f.ref ?? f.pick)) expect(typed.has(f.key) || drawn.has(f.key), `${k.id}.${f.key}`).toBe(true);
  });

  it('生态的地形、地物的类别、政体的类别：选项写中文', () => {
    const ctx = { world: null, lib: BUILTIN };
    const terrains = refOptions('biomeTerrain', ctx);
    expect(terrains.slice(0, BIOME_TERRAINS.length).map((o) => o.id)).toEqual(BIOME_TERRAINS.map((t) => t.id));
    expect(terrains.find((o) => o.id === 'forest')!.label).toBe('森林');
    const types = refOptions('featureType', ctx);
    expect(types[0]).toEqual({ id: 'province', label: '省份' });
    expect(types.find((o) => o.id === 'island')!.label).toBe('岛');
    for (const o of [...terrains, ...types]) expect(ASCII_WORD.test(o.label), o.id).toBe(false);
    expect(refOptions('govCategory', ctx).find((o) => o.id === 'monarchy')!.label).toBe('君主制');
  });

  it('规则里“生态的地形”、地名风格“各类地物”的键从表里选；它们不是内容的引用，引用表不看', () => {
    const rule = kindOf('terrainClass')!.fields.find((f) => f.key === 'rules')!.of!.find((f) => f.key === 'terrain')!;
    expect([rule.pick, rule.ref]).toEqual(['biomeTerrain', undefined]);
    const types = kindOf('nameStyle')!.fields.filter((f) => f.key === 'types');
    expect(types.map((f) => [f.keyPick, f.keyRef])).toEqual([
      ['featureType', undefined],
      ['featureType', undefined],
    ]);
    // 导入、改名、“谁用到它”都不受影响：这两处不出现在引用里，登记表也没有问题
    const cls = { id: 'c', name: '类', color: '#112233', priority: 1, rules: [{ terrain: ['forest', 'marsh'] }] };
    expect(linksOf('terrainClass', cls)).toEqual([]);
    const style = { id: 's', name: '风格', kind: 'template', lists: { a: ['青'] }, types: { island: { patterns: [{ p: '{a}岛' }] } } };
    expect(linksOf('nameStyle', style)).toEqual([]);
    expect(linkProblems()).toEqual([]);
  });

  it('旗一段收起时的一句写中文名（以前写 crown、lion）；这两项也不是内容的引用', () => {
    const ctx = { world: null, lib: BUILTIN };
    const labelOf = (ref: string | readonly string[], id: string) => refLabel(refOptionsOf(ref, ctx), id);
    const fields = kindOf('government')!.fields;
    const emblems = fields.find((f) => f.key === 'emblems')!;
    const layouts = fields.find((f) => f.key === 'layouts')!;
    expect(fieldBrief(emblems, ['crown', 'lion', 'tower'], labelOf)).toBe('王冠、狮 等 3 个');
    expect(fieldBrief(layouts, ['nordic'], labelOf)).toBe('北欧十字');
    expect(refOptions('flagEmblem', ctx).map((o) => o.id)).toEqual([...FLAG_EMBLEMS]);
    expect(refOptions('flagLayout', ctx).map((o) => o.id)).toEqual([...FLAG_LAYOUTS]);
    expect(linksOf('government', { id: 'g', name: '政', emblems: ['crown'], layouts: ['nordic'] })).toEqual([]);
    expect(linkProblems()).toEqual([]);
  });

  it('政体的类别能新加一个：写名字就行（存的就是这个名字），别的引用不能', () => {
    const opts = refOptions('govCategory', { world: null, lib: BUILTIN });
    expect(refNewMax('govCategory')).toBe(16);
    expect(refNewMax('culture')).toBeNull();
    expect(newRefName('govCategory', '  议会制 ', opts)).toBe('议会制');
    // 已经有的（按名字、按存的字）、空的、太长的不行
    expect(newRefName('govCategory', '君主制', opts)).toBeNull();
    expect(newRefName('govCategory', 'monarchy', opts)).toBeNull();
    expect(newRefName('govCategory', '   ', opts)).toBeNull();
    expect(newRefName('govCategory', '一'.repeat(17), opts)).toBeNull();
    expect(newRefName('culture', '新文化', [])).toBeNull();
    // 新加的名字存得进去
    const gov = { ...(kindOf('government')!.blank!() as object), category: ['议会制'] };
    expect(kindOf('government')!.schema.safeParse(gov).success).toBe(true);
  });

  it('旗的纹章、样式：每个一张小图、一个中文名；点一下选上、再点去掉', () => {
    const emblems = flagChoices('emblems');
    const layouts = flagChoices('layouts');
    expect(emblems.map((c) => c.id)).toEqual([...FLAG_EMBLEMS]);
    expect(layouts.map((c) => c.id)).toEqual([...FLAG_LAYOUTS]);
    for (const c of [...emblems, ...layouts]) expect(ASCII_WORD.test(c.label), c.id).toBe(false);
    expect(emblems.find((c) => c.id === 'crown')).toMatchObject({ label: '王冠', flag: { layout: 'plain', emblem: 'crown' } });
    expect(layouts.find((c) => c.id === 'bicolor-h')).toMatchObject({ label: '横二色', flag: { layout: 'bicolor-h' } });
    // 选上的按那张表的先后；全去掉了是 undefined（这个字段可以不写）
    expect(toggleFlagWord('emblems', undefined, 'lion')).toEqual(['lion']);
    expect(toggleFlagWord('emblems', ['lion'], 'crown')).toEqual(['crown', 'lion']);
    expect(toggleFlagWord('emblems', ['crown', 'lion'], 'crown')).toEqual(['lion']);
    expect(toggleFlagWord('emblems', ['lion'], 'lion')).toBeUndefined();
    // 以前手打错的照旧留着、列得出来、能点掉
    expect(unknownFlagWords('layouts', ['bicolor-h', 'bicolour'])).toEqual(['bicolour']);
    expect(toggleFlagWord('layouts', ['bicolor-h', 'bicolour'], 'cross')).toEqual(['bicolor-h', 'cross', 'bicolour']);
    expect(toggleFlagWord('layouts', ['bicolour'], 'bicolour')).toBeUndefined();
    // 选的结果生成国家时认得（和手打的是同一种写法）
    const flag = makeFlag(7, '#b8202a', { emblems: toggleFlagWord('emblems', undefined, 'tower'), layouts: toggleFlagWord('layouts', undefined, 'nordic') });
    expect([undefined, 'tower']).toContain(flag.emblem);
  });

  it('地标名字能写的词各有中文名', () => {
    for (const t of LANDMARK_TOKENS) expect(LANDMARK_TOKEN_NAMES[t]).toBeTruthy();
  });

  it('键 → 值的表新加一项先写名字：空的、已经有的不行（不再先起一个叫 new 的键）', () => {
    expect(keyProblem({}, '  ')).toBe('先写名字');
    expect(keyProblem({ a: 1 }, 'a')).toBe('已经有“a”了');
    expect(keyProblem({ a: 1 }, ' 颜色 ')).toBeNull();
    const lists = kindOf('nameStyle')!.fields.filter((f) => f.key === 'lists');
    expect(lists.map((f) => f.keyLabel)).toEqual(['词表的名字', '词缀表的名字']);
  });

  it('岛的形状、高低、地标放在哪：选项写中文（以前照写 rugged、big-city）', () => {
    const opt = (kind: string, key: string) => kindOf(kind)!.fields.find((f) => f.key === key)!.options!;
    expect(opt('islandType', 'shape').map((o) => o.label)).toEqual(['圆', '长条', '不规则', '环礁', '一格', '碎']);
    expect(opt('islandType', 'height').map((o) => o.label)).toEqual(['平', '起伏', '高']);
    expect(opt('landmarkType', 'place').find((o) => o.value === 'big-city')!.label).toBe('大城市');
    expect(opt('landmarkType', 'detector').find((o) => o.value === 'volcano')!.label).toBe('火山');
    // 岩石有了范围（以前是一个没有范围的数字框）
    const rock = kindOf('islandType')!.fields.find((f) => f.key === 'rock')!;
    expect(sliderScale(rock)).not.toBeNull();
    for (const v of [rock.min!, rock.max!]) expect(islandTypeSchema.safeParse({ id: 'i', name: '岛', rock: v }).success).toBe(true);
  });
});

// ---------- 新建：id 一种起法 ----------

describe('新建一项：id、名字一种起法', () => {
  it('第一个是登记表里的底子，之后 id、名字都带编号', () => {
    for (const k of kinds().filter((x) => x.blank)) {
      const first = blankItem(k, new Set())!;
      const second = blankItem(k, new Set([String(first.id)]))!;
      const third = blankItem(k, new Set([String(first.id), String(second.id)]))!;
      expect([second.id, third.id], k.id).toEqual([`${String(first.id)}-2`, `${String(first.id)}-3`]);
      if (typeof first.name === 'string') expect([second.name, third.name], k.id).toEqual([`${first.name} 2`, `${first.name} 3`]);
      // 带了编号的名字照样合格（名字有长度上限）
      expect(k.schema.safeParse(third).success, k.id).toBe(true);
    }
  });

  it('底部条上河、湖、岛的“新建…”和列表上的“新建”同一种 id（以前另起 river-type-1、island-type-1）', () => {
    const eng = continents();
    const w = eng.world as World;
    const river = newWaterType(w, 'river');
    expect(river.id).toBe(blankItem(kindOf('riverType')!, new Set((w.small.riverTypes ?? []).map((t) => t.id)))!.id);
    expect(riverTypeSchema.safeParse(river).success).toBe(true);
    expect(newWaterType(w, 'lake').id).toBe('my-lake');
    const island = newIslandType(w);
    expect(island.id).toBe('my-island');
    eng.exec({ op: 'set_island_type', type: island });
    expect([newIslandType(eng.world as World).id, newIslandType(eng.world as World).name]).toEqual(['my-island-2', '新的岛 2']);
  });
});

// ---------- 同一个数一套范围：通用表单这一边 ----------

describe('变湿变干在通用表单里写成百分比', () => {
  it('滑块停在降水的百分之几上，写“降水 +20%”；存的还是指数', () => {
    const dP = kindOf('riverType')!.fields.find((f) => f.key === 'bank')!.of!.find((f) => f.key === 'dP')!;
    const scale = sliderScale(dP)!;
    expect(scale.at(0.5)).toBe(0);
    expect(valueText(dP, 0)).toBe('不变');
    expect(valueText(dP, dpOfPercent(20))).toBe('降水 +20%');
    expect(scale.at(scale.pos(dpOfPercent(-35)))).toBe(dpOfPercent(-35));
    // 河的粗细写成百分之几
    const width = kindOf('riverType')!.fields.find((f) => f.key === 'width')!;
    expect(valueText(width, 1.2)).toBe('120%');
  });
});

// ---------- 做法一致 ----------

const used = (n: number) => ({ count: n, label: `长在 ${n} 格` });
// 一种放在 small.content 里的内容（引擎不让删在用的）和一种自己有删除命令的（生态：删了换成别的）
const fakeRow = (kind: ContentKind, usage: ReturnType<typeof used> | null, status: Partial<ItemRow['status']> = {}): ItemRow => ({
  kind: { ...kind, usage: () => usage },
  key: 'k',
  id: 'x',
  name: '某项',
  item: {},
  source: 'world',
  status: { on: true, worldId: 'x', ...status },
});
const NOBODY = { groups: [] };
const SOMEONE = { groups: [{ kind: 'government', title: '政体', rows: [{ kind: 'government', id: 'g', name: '封建君主制' }] }] };

describe('删除：同一套规矩', () => {
  // 用在哪里按世界记着（rows.ts 的 rowUsage）：每次给一个新的
  const fresh = () => ({}) as never;

  it('没人用到：直接删，不问（能撤销）', () => {
    const v = worldDelete(fakeRow(kindOf('faction')!, null), fresh(), NOBODY)!;
    expect(v.t).toBe('go');
    expect(v.t !== 'blocked' && v.cmd).toMatchObject({ op: 'batch', label: '删除派系“某项”', commands: [{ op: 'set_content', kind: 'faction', id: 'x', item: null }] });
    expect(libraryDelete('某项', NOBODY)).toEqual({ t: 'go', cmd: null });
  });

  it('别的内容写到了它：问一次，说清楚是谁、删了会怎样', () => {
    const v = worldDelete(fakeRow(kindOf('faction')!, null), fresh(), SOMEONE)!;
    expect(v).toMatchObject({ t: 'ask', title: '删除“某项”', text: '政体“封建君主制”写到了它，删了以后那几处不会跟着改。可以撤销。' });
    expect(libraryDelete('某项', SOMEONE)).toMatchObject({ t: 'ask', cmd: null, text: '政体“封建君主制”写到了它，删了以后那几处不会跟着改。可以撤销。' });
    const many = { groups: [{ kind: 'culture', title: '文化', rows: ['甲', '乙', '丙', '丁'].map((name) => ({ kind: 'culture', id: name, name })) }] };
    expect(referrersText(many)).toBe('文化“甲”、文化“乙”、文化“丙” 等 4 项');
  });

  it('地图上用着、删得掉的（生态、河、湖、岛）：问一次，写用在哪、删了变成什么；自己长出来的也算', () => {
    const texts: Record<string, string> = { biome: '长它的地方会换成别的生态', riverType: '这种河会变回普通的河', lakeType: '这种湖会变回普通的湖', islandType: '已放的这种岛会变成大陆岛' };
    for (const [kind, after] of Object.entries(texts)) {
      // 手动指定了它的（涂的、选了它的）
      const v = worldDelete(fakeRow(kindOf(kind)!, used(1200)), fresh(), NOBODY)!;
      expect(v, kind).toMatchObject({ t: 'ask', text: `地图上长在 1200 格。删了以后${after}。可以撤销。` });
      expect(v.t !== 'blocked' && v.cmd, kind).toBeTruthy();
      // 没有手动指定、按规则自己长出来的（“谁用到它”里地图的那一行）
      const grown = worldDelete(fakeRow(kindOf(kind)!, null), fresh(), { groups: [], places: '长在 261 格' })!;
      expect(grown, kind).toMatchObject({ t: 'ask', text: `地图上长在 261 格。删了以后${after}。可以撤销。` });
      // 地图上没有它：直接删
      expect(worldDelete(fakeRow(kindOf(kind)!, null), fresh(), { groups: [], places: null })!.t, kind).toBe('go');
    }
  });

  it('地图上用着、引擎不让删的：不能删，写清楚用在哪、先做什么', () => {
    const v = worldDelete(fakeRow(kindOf('culture')!, used(3)), fresh(), NOBODY)!;
    expect(v).toEqual({ t: 'blocked', why: '地图上有 3 处用到它（长在 3 格），先把用到它的地方改掉' });
  });

  it('动不了的（星球形态）没有删除', () => {
    expect(worldDelete(fakeRow(kindOf('planetForm')!, null, { locked: '不能删除' }), fresh(), NOBODY)).toBeNull();
  });

  it('真的世界里：长着的生态问一次，删掉以后能撤销', () => {
    const eng = continents();
    const ctx: PageCtx = { world: eng.world, lib: BUILTIN };
    const biome = kindOf('biome')!;
    const usedOf = (r: ItemRow) => usedByOf(WORLD_SOURCE, biome, r.id, r.item, ctx);
    const row = rowsOf(WORLD_SOURCE, biome, ctx).find((r) => usedOf(r).places)!;
    const v = worldDelete(row, eng.world, usedOf(row))!;
    expect(v.t).toBe('ask');
    expect(v.t === 'ask' && v.text).toMatch(/^地图上长在 [\d,]+ 格。删了以后长它的地方会换成别的生态。/);
    const n = eng.world.small.species.length;
    eng.exec((v as { cmd: Command }).cmd);
    expect(eng.world.small.species.length).toBe(n - 1);
    eng.undo();
    expect(eng.world.small.species.length).toBe(n);
  });
});

describe('同一排按钮、同一种先后', () => {
  const eng = continents();
  const ctx: PageCtx = { world: eng.world, lib: BUILTIN };
  const can = { remove: true, usage: null, changed: true, setDefault: true, hasCells: true, saveable: true, newable: true };
  const ids = (kind: string, more: Partial<typeof can & { paint: boolean }> = {}) => itemActions(WORLD_SOURCE, rowsOf(WORLD_SOURCE, kindOf(kind)!, ctx)[0], ctx, { ...can, ...more }).map((a) => a.id);

  it('这张地图：先是“用它”的几个，然后 复制 → 存到我的库 → 导出文件 → 删除；生态只多一个“用它涂”', () => {
    const order = ['setDefault', 'locate', 'useSource', 'copyItem', 'saveToMine', 'exportItem', 'removeFromWorld'];
    expect(ids('terrainClass')).toEqual(order);
    expect(ids('riverType')).toEqual(order);
    expect(ids('biome', { paint: true })).toEqual(['paint', ...order]);
    // 没有“详细编辑”（河湖岛的编辑器就是这一页），新建不在这一排（在列表上）
    for (const kind of ['riverType', 'lakeType', 'islandType', 'biome']) expect(ids(kind)).not.toContain('dedicated' as never);
  });

  it('删除总在最后；没有可做的几样时那几个不出现', () => {
    const bare = ids('terrainClass', { changed: false, setDefault: false, hasCells: false, saveable: false });
    expect(bare).toEqual(['copyItem', 'exportItem', 'removeFromWorld']);
    for (const kind of ['terrainClass', 'biome', 'riverType']) expect(ids(kind).at(-1)).toBe('removeFromWorld');
  });

  it('删不了时按钮还在，带着原因', () => {
    const list = itemActions(WORLD_SOURCE, rowsOf(WORLD_SOURCE, kindOf('terrainClass')!, ctx)[0], ctx, { ...can, remove: false, usage: '地图上有 3 处用到它' });
    expect(list.at(-1)).toEqual({ id: 'removeFromWorld', disabled: '地图上有 3 处用到它' });
  });
});

// ---------- 生成设置：每一项下面一句 ----------

describe('生成设置里每一项下面写现在是什么样', () => {
  const era = { ...(kindOf('era')!.blank!() as Era), popDensity: 10, urbanization: 0.2 };

  it('有地图时写数：按这个密度一共多少人、城里多少人；没有国家时只写方向', () => {
    const w = continents().world as World;
    const n = genNotes(w, era);
    expect(n.countryKm2).toBe('调小，国家更多');
    expect(n.popDensity).toMatch(/^按这个密度一共约 .+ 人$/);
    expect(n.urbanization).toMatch(/^城里约 .+ 人$/);
    // 密度翻倍，人数跟着变
    expect(genNotes(w, { ...era, popDensity: 20 }).popDensity).not.toBe(n.popDensity);
    const withCountries = { ...w, small: { ...w.small, countries: { 1: {}, 2: {} } } } as never;
    expect(genNotes(withCountries, era).countryKm2).toBe('现在 2 个国家；调小，国家更多');
  });

  it('只有小状态时（没有推导）只写一句说明', () => {
    const n = genNotes({ small: { countries: {} }, causes: {} } as never, era);
    expect(n).toEqual({ countryKm2: '调小，国家更多', popDensity: '陆地上平均每平方千米几个人', urbanization: '住在城里的人占几成' });
  });
});
