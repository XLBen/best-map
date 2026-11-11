import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import type { Engine } from '../../../core/engine';
import { currentRuler, loreOf } from '../../../core/human';
import { type ResourcePack, packItems } from '../../../core/packs';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../../../core/packs/import';
import { NO_CURRENTS, engineFor, setGroupWeights } from '../../../core/testing/fixtures';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { type LibBackend, createLibEditor } from '../../library-edit';
import { type Obj, titleRows } from './fields';
import { type PageCtx, type SourceRef, WORLD_SOURCE } from './pages';
import {
  SAMPLE_BASE,
  SAMPLE_RULER,
  TITLE_MAX,
  countWord,
  governmentsIn,
  overridesLine,
  replaceCommand,
  replaceInGovernment,
  replaceLabel,
  replaceNote,
  replacePlan,
  ruleWho,
  sampleWords,
  titleHelpOf,
  titleOverrides,
  titleSample,
} from './title-help';

// 第九十一轮：称号编辑器旁的示例、“哪几条换说法盖过它”、把一个称号都换掉

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ROOTS = BUILTIN.map((e) => ({ key: e.key, pack: e.pack }));
const MEDIEVAL = builtinPacks().find((p) => p.id === 'medieval')!;
const MINE: LibraryEntry = { key: 'mine-1', pack: { ...MEDIEVAL, id: 'mine-1', name: '我的库' }, builtin: false, mine: true, installedAt: 0 };
const ctxOf = (e: Engine | null, lib: LibraryEntry[] = BUILTIN): PageCtx => ({ world: e && { ...e.world }, lib });

let full: Engine;
beforeAll(() => {
  const e = engineFor({ cells: 3000, seed: 2 }, { bare: true });
  e.exec(NO_CURRENTS);
  e.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf('medieval'))) e.exec(c);
  const groups = packItems<{ id: string; weight?: number }>(MEDIEVAL, 'cultureGroups')
    .filter((g) => g.weight !== 0)
    .slice(0, 3)
    .map((g) => ({ id: g.id, weight: 1 }));
  for (const c of packImportCommands(ROOTS, { packs: [['medieval']], groups: groups.map((g) => g.id) }, e.world)) e.exec(c);
  setGroupWeights(e, groups);
  e.exec({ op: 'generate_human', packs: [['medieval']], groups: groups.map((g) => g.id), countries: {}, settlements: {} } as Command);
  e.update();
  full = e;
});

const metas = (w: World) => Object.values(w.small.countries ?? {});
const gov = (list: readonly Obj[], id: string) => list.find((g) => g.id === id)!;
const GOV: Obj = {
  id: 'g1',
  name: '封建君主制',
  titles: { small: '公国', large: { zh: '王国', orig: 'Kingdom of {name}' }, empire: '帝国' },
  rulers: { small: '公爵', large: '国王', empire: '皇帝' },
  names: [
    { cultureGroups: ['altaic', 'tatar'], titles: { large: { zh: '汗国', orig: 'Khanate of {name}' }, default: '兀鲁思' }, rulers: { large: '汗' } },
    { valueGroups: ['muslim'], cultures: ['arab'], titles: '苏丹国' },
    { values: ['sunni'], rulers: '埃米尔' },
    { titles: { empire: '天朝' } },
  ],
};
const LABELS: Record<string, string> = { altaic: '阿尔泰', tatar: '鞑靼', muslim: '伊斯兰', arab: '阿拉伯', sunni: '逊尼派' };
const labelOf = (_ref: string, id: string) => LABELS[id] ?? id;

describe('示例', () => {
  it('国家称号写出来是国名（接在后面，或换进 {name}），有外文写法时跟在后面；统治者称号是“称号 + 名字”', () => {
    const words = { base: { zh: '青岚', orig: 'Qinglan' }, ruler: '安澜' };
    expect(titleSample('titles', { zh: '王国', orig: '' }, words)).toBe('青岚王国　Qinglan');
    expect(titleSample('titles', { zh: '王国', orig: 'Kingdom of {name}' }, words)).toBe('青岚王国　Kingdom of Qinglan');
    expect(titleSample('titles', { zh: '大{name}朝', orig: '' }, { base: { zh: '青岚' }, ruler: '' })).toBe('大青岚朝');
    expect(titleSample('rulers', { zh: '国王', orig: '' }, words)).toBe('国王安澜');
    // 正在写的字马上就是示例；空着时没有
    expect(titleSample('titles', { zh: '汗', orig: '' }, words)).toBe('青岚汗　Qinglan');
    expect(titleSample('titles', { zh: ' ', orig: 'x' }, words)).toBe('');
  });

  it('本世界里用地图上真的国家：先找用这个政体、又是这一级的，再找用这个政体的；库里、没有国家时用固定的例子', () => {
    const w = full.world;
    const m = metas(w).find((x) => !x.nameLocked && x.tier)!;
    const got = sampleWords(w, m.government, m.tier);
    const same = metas(w).find((x) => !x.nameLocked && x.government === m.government && x.tier === m.tier)!;
    expect(got.base).toEqual(same.base);
    expect(got.ruler).toBe(currentRuler(w.small, same.id)!.name);
    // 这一级没有国家：同一个政体的
    expect(sampleWords(w, m.government, 'no-such-tier').base).toEqual(metas(w).find((x) => !x.nameLocked && x.government === m.government)!.base);
    // 这个政体没有国家：随便一个国家
    expect(sampleWords(w, 'no-such-gov', undefined).base).toEqual(metas(w).filter((x) => !x.nameLocked)[0].base);
    expect(sampleWords(null, m.government, m.tier)).toEqual({ base: SAMPLE_BASE, ruler: SAMPLE_RULER });
    // 示例就是这个国家现在的名字（称号没改时）
    const help = titleHelpOf(w.small.content!.government![m.government] as Obj, WORLD_SOURCE, ctxOf(full));
    const row = { key: same.tier!, zh: same.name.slice(same.base.zh.length), orig: '' };
    if (same.name.startsWith(same.base.zh)) expect(help.sample('titles', row).split('　')[0]).toBe(same.name);
    // 看库时用固定的例子
    const lib: SourceRef = { t: 'lib', key: 'medieval' };
    expect(titleHelpOf(GOV, lib, ctxOf(full)).sample('titles', { key: 'large', zh: '王国', orig: '' })).toBe('青岚王国　Qinglan');
    expect(titleHelpOf(GOV, lib, ctxOf(null)).sample('rulers', { key: 'large', zh: '国王', orig: '' })).toBe('国王安澜');
  });
});

describe('哪几条换说法会盖过默认的这一行', () => {
  it('换说法的表里写了这一级、写了“其余”、或只写一种的那几条；和引擎挑称号的先后一样', () => {
    // 大国这一行：第 1 条写了 large，第 2 条只写一种（各级都用），第 4 条只写了 empire（不盖 large）
    expect(titleOverrides(GOV, 'titles', 'large', labelOf)).toEqual([
      { rule: 0, who: '阿尔泰、鞑靼', zh: '汗国' },
      { rule: 1, who: '阿拉伯 且 伊斯兰', zh: '苏丹国' },
    ]);
    // 小国这一行：第 1 条没写 small，用它的“其余”
    expect(titleOverrides(GOV, 'titles', 'small', labelOf).map((o) => o.zh)).toEqual(['兀鲁思', '苏丹国']);
    // 帝国：还有一条什么条件都没写的（所有国家）
    expect(titleOverrides(GOV, 'titles', 'empire', labelOf).map((o) => [o.who, o.zh])).toEqual([
      ['阿尔泰、鞑靼', '兀鲁思'],
      ['阿拉伯 且 伊斯兰', '苏丹国'],
      ['所有国家', '天朝'],
    ]);
    // 统治者称号：只有写了统治者称号的那几条
    expect(titleOverrides(GOV, 'rulers', 'large', labelOf)).toEqual([
      { rule: 0, who: '阿尔泰、鞑靼', zh: '汗' },
      { rule: 2, who: '逊尼派', zh: '埃米尔' },
    ]);
    expect(titleOverrides(GOV, 'rulers', 'small', labelOf).map((o) => o.zh)).toEqual(['埃米尔']);
    expect(titleOverrides({ ...GOV, names: undefined }, 'titles', 'large', labelOf)).toEqual([]);
    expect(ruleWho({}, labelOf)).toBe('所有国家');
  });

  it('写成一句；多了写“等 N 条”；没有时不写', () => {
    expect(overridesLine(titleOverrides(GOV, 'titles', 'large', labelOf))).toBe('阿尔泰、鞑靼写“汗国”；阿拉伯 且 伊斯兰写“苏丹国”');
    expect(overridesLine([])).toBe('');
    const many = [1, 2, 3, 4, 5].map((k) => ({ rule: k, who: `甲${k}`, zh: '乙' }));
    expect(overridesLine(many)).toBe('甲1写“乙”；甲2写“乙”；甲3写“乙” 等 5 条');
  });

  it('内置的政体：名字从本世界里查（文化组的名字，不是 id）', () => {
    const w = full.world;
    const list = governmentsIn(WORLD_SOURCE, ctxOf(full));
    const g = list.find((x) => Array.isArray(x.names) && (x.names as Obj[]).some((r) => Array.isArray(r.cultureGroups) && r.titles !== undefined))!;
    expect(g).toBeTruthy();
    const help = titleHelpOf(g, WORLD_SOURCE, ctxOf(full));
    const tiers = Object.keys(g.titles as Obj);
    const lines = tiers.map((t) => help.overrides('titles', t)).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/写“.+”/);
    void w;
  });
});

describe('把一个称号都换掉', () => {
  it('只换整个就是这个词的写法：称号、统治者称号、换说法里的都算；“部落王国”里的“王国”不算；外文写法留着', () => {
    const g: Obj = { ...GOV, titles: { ...(GOV.titles as Obj), city: '部落王国', medium: ' 王国 ' } };
    const r = replaceInGovernment(g, '王国', '汗国')!;
    expect(r.hits).toBe(2);
    expect(r.next.titles).toEqual({ small: '公国', large: { zh: '汗国', orig: 'Kingdom of {name}' }, empire: '帝国', city: '部落王国', medium: '汗国' });
    // 换说法里的
    const r2 = replaceInGovernment(GOV, '汗', '可汗')!;
    expect(r2.hits).toBe(1);
    expect((r2.next.names as Obj[])[0].rulers).toEqual({ large: '可汗' });
    expect((r2.next.names as Obj[])[0].titles).toEqual((GOV.names as Obj[])[0].titles);
    // 只写一种的
    expect((replaceInGovernment(GOV, '苏丹国', '哈里发国')!.next.names as Obj[])[1].titles).toBe('哈里发国');
    expect(replaceInGovernment(GOV, '没有的词', '甲')).toBeNull();
    // 原来的对象不动
    expect((GOV.titles as Obj).large).toEqual({ zh: '王国', orig: 'Kingdom of {name}' });
  });

  it('先数会改几处：写着词的时候就说；空的、一样的、太长的不能换', () => {
    const govs = governmentsIn(WORLD_SOURCE, ctxOf(full));
    const word = titleRows(gov(govs, metas(full.world)[0].government).rulers)[0].zh;
    const n = countWord(govs, word);
    expect(n).toBeGreaterThan(0);
    expect(replaceNote(govs, '', '甲')).toBe('');
    expect(replaceNote(govs, word, '')).toBe(`有 ${n} 处写着“${word}”`);
    expect(replaceNote(govs, word, word)).toBe(`有 ${n} 处写着“${word}”`);
    expect(replaceNote(govs, '没有的词', '甲')).toBe('没有写着“没有的词”的称号');
    expect(replaceNote(govs, word, 'x'.repeat(TITLE_MAX + 1))).toBe(`称号最长 ${TITLE_MAX} 个字`);
    const plan = replacePlan(govs, ` ${word} `, ' 大汗 ')!;
    expect(plan).toMatchObject({ from: word, to: '大汗', hits: n });
    expect(replaceNote(govs, word, '大汗')).toBe(`会改 ${n} 处（${plan.items.length} 个政体）`);
    expect(replacePlan(govs, word, word)).toBeNull();
    expect(replacePlan(govs, word, '')).toBeNull();
    expect(replacePlan(govs, '没有的词', '甲')).toBeNull();
    expect(replacePlan(govs, word, 'x'.repeat(TITLE_MAX + 1))).toBeNull();
    expect(replaceLabel(plan)).toBe(`称号“${word}”换成“大汗” · ${n} 处`);
  });

  it('本世界：一步改遍各政体，没手改过的统治者马上都换了称号；撤销一步全回去', () => {
    const e = full.clone();
    const w = e.world;
    const govs = governmentsIn(WORLD_SOURCE, ctxOf(e));
    // 在位的统治者里用得最多的称号
    const count = new Map<string, number>();
    for (const m of metas(w)) {
      const t = currentRuler(w.small, m.id)?.title;
      if (t) count.set(t, (count.get(t) ?? 0) + 1);
    }
    const word = [...count].sort((a, b) => b[1] - a[1])[0][0];
    const before = Object.fromEntries(metas(w).map((m) => [m.id, loreOf(w.small, m.id).rulers.map((r) => r.title)]));
    const names = Object.fromEntries(metas(w).map((m) => [m.id, m.name]));
    const plan = replacePlan(govs, word, '大汗')!;
    expect(plan.items.length).toBeGreaterThan(0);
    const steps = e.history.filter((h) => h.done).length;
    const summary = e.exec(replaceCommand(plan, w));
    expect(summary).toBe(replaceLabel(plan));
    expect(e.history.filter((h) => h.done).length).toBe(steps + 1);
    let changed = 0;
    for (const m of metas(e.world)) {
      const now = loreOf(e.world.small, m.id).rulers.map((r) => r.title);
      expect(now).toEqual(before[m.id].map((t) => (t === word ? '大汗' : t)));
      if (before[m.id].includes(word)) changed++;
      // 只换了统治者称号里的这个词：国名不动
      expect(m.name).toBe(names[m.id]);
    }
    expect(changed).toBeGreaterThanOrEqual(count.get(word)!);
    // 库里再没有这个词
    expect(countWord(governmentsIn(WORLD_SOURCE, ctxOf(e)), word)).toBe(0);
    e.undo();
    expect(Object.fromEntries(metas(e.world).map((m) => [m.id, loreOf(e.world.small, m.id).rulers.map((r) => r.title)]))).toEqual(before);
    expect(countWord(governmentsIn(WORLD_SOURCE, ctxOf(e)), word)).toBe(plan.hits);
  });

  it('本世界：换国家称号里的词，国名马上跟着变', () => {
    const e = full.clone();
    const w = e.world;
    const m = metas(w).find((x) => !x.nameLocked && x.name.startsWith(x.base.zh) && x.name.length > x.base.zh.length)!;
    const word = m.name.slice(m.base.zh.length);
    const plan = replacePlan(governmentsIn(WORLD_SOURCE, ctxOf(e)), word, '大公国')!;
    e.exec(replaceCommand(plan, w));
    expect(e.world.small.countries![m.id].name).toBe(`${m.base.zh}大公国`);
  });

  it('我的库：一步改几项，撤销一次全回去；有一项不合格就都不改', () => {
    const backend: LibBackend = { put: async () => true, walRead: () => null, walWrite: () => true };
    let list: LibraryEntry[] = [MINE];
    const ed = createLibEditor(backend, { entries: () => list, publish: (key, p) => void (list = list.map((x) => (x.key === key ? { ...x, pack: p } : x))) });
    const src: SourceRef = { t: 'lib', key: MINE.key };
    const govs = governmentsIn(src, { world: null, lib: list });
    expect(govs.length).toBe(packItems(MEDIEVAL, 'governments').length);
    const word = titleRows(govs.find((g) => g.rulers !== undefined)!.rulers)[0].zh;
    const plan = replacePlan(govs, word, '大汗')!;
    expect(plan.items.length).toBeGreaterThan(0);
    const start: ResourcePack = list[0].pack;
    expect(ed.setItems(MINE.key, 'government', plan.items, replaceLabel(plan))).toEqual({ ok: true });
    const after = governmentsIn(src, { world: null, lib: list });
    expect(countWord(after, word)).toBe(0);
    expect(countWord(after, '大汗')).toBeGreaterThanOrEqual(plan.hits);
    expect(ed.undoLabel(MINE.key)).toBe(replaceLabel(plan));
    ed.undo(MINE.key);
    expect(list[0].pack).toBe(start);
    // 有一项不合格：都不改
    const bad = [...plan.items.slice(0, 1), { id: plan.items[0].id, next: { ...plan.items[0].next, titles: '' } }];
    expect(ed.setItems(MINE.key, 'government', bad).ok).toBe(false);
    expect(list[0].pack).toBe(start);
    expect(ed.setItems(MINE.key, 'government', [{ id: 'no-such', next: plan.items[0].next }]).ok).toBe(false);
    // 改成一模一样的：没有变化
    expect(ed.setItems(MINE.key, 'government', [{ id: String(govs[0].id), next: govs[0] }])).toEqual({ ok: true, noop: true });
    // 只读的库里没有可改的
    expect(governmentsIn({ t: 'lib', key: 'no-such' }, { world: null, lib: list })).toEqual([]);
  });
});
