import { describe, expect, it } from 'vitest';
import { compactWorldDoc } from '../compact';
import { danglingLinks, linkTable, packScope, worldScope } from '../content/links';
import { allKinds, itemId } from '../content/registry';
import { digest, worldDigest } from '../digest';
import { Engine } from '../engine';
import { countryList } from '../human/countries';
import { type Era, worldDimensions } from '../human/era';
import { SLOTS } from '../human/groups';
import { type PackNode, type ResourcePack, itemErrors, packItems, packSections, parsePack, canApply } from '../packs';
import { NO_CURRENTS, engineFor, humanDigest, snapshot } from '../testing/fixtures';
import type { World } from '../world';
import { builtinPacks, worldPartsOf } from './builtin-tree';
import { type ImportAsk, importCommand, importGates, importPreview, importToPack } from './closure';
import { ERA_PACKS } from './eras';
import { packImportCommands } from './import';

// 第六十一轮的门槛，第六十四轮按“勾什么进什么”改写：
//   1. 所有内置库之间两两导入随机抽的若干项（固定种子），加上去掉部分子项，世界和库里都没有找不到的引用；项数等于真的写入的；
//      灰的项进不来，每个灰的项写明原因；同样的勾选再导入一次 0 项；
//   2. 奇幻导入社会主义：灰着，勾意识形态后能选。变量到位，文化、国家、城市、地名的摘要逐值不变，文化比例不变；重新生成国家后出现社会主义国家；
//   3. 一步导入，撤销回到原样，存档重放逐值相同。库的那一半在 src/library-edit.test.ts
//   4. 只有一种取值的变量（科幻世界勾天主教）、补回、放不下，世界里走一遍

const LIB = builtinPacks();
const groupsOf = (id: string) => ERA_PACKS.get(id)!.cultures.map(([g, w]) => ({ id: g, weight: w }));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 抽几项：每次先抽一种再抽一项，所以小的种类也抽得到；变量也算一种
function sample(source: PackNode, world: boolean, n: number, rand: () => number) {
  const kinds = packSections().filter((k) => (world ? canApply(k) : true) && packItems(source, k.pack.key).length);
  const dims = packItems<Era>(source, 'eras').flatMap((e) => e.dimensions.map((d) => d.id));
  const out = new Map<string, { kind: string; id: string }>();
  for (let k = 0; k < n * 3 && out.size < n; k++) {
    if (dims.length && rand() < 0.15) {
      const id = dims[Math.floor(rand() * dims.length)];
      out.set(`dimension:${id}`, { kind: 'dimension', id });
      continue;
    }
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const items = packItems(source, kind.pack.key);
    const id = itemId(kind, items[Math.floor(rand() * items.length)]);
    out.set(`${kind.id}:${id}`, { kind: kind.id, id });
  }
  return [...out.values()];
}

// 随机去掉一些子项（勾的不去掉）
function untick(ask: ImportAsk, rand: () => number): ImportAsk {
  const off = importPreview(ask).rows.filter((r) => r.role === 'child' && rand() < 0.4).map((r) => ({ kind: r.kind, id: r.id }));
  return { ...ask, off };
}

const danglingKeys = (scope: Parameters<typeof linkTable>[0]) => new Set(danglingLinks(linkTable(scope)).map((b) => `${b.from.kind}:${b.from.id} ${b.link.kinds.join('/')} ${b.link.id}`));

// 一个小世界（没有地形，只看内容）：库带的底子和默认的文化组
function contentWorld(id: string): Engine {
  return snapshot(`closure-gates:content:${id}`, () => {
    const eng = engineFor({ cells: 1000, seed: 2 }, { bare: true });
    for (const c of packImportCommands(LIB, { packs: worldPartsOf(id), groups: [] }, eng.world)) eng.exec(c);
    for (const c of packImportCommands(LIB, { packs: [[id]], groups: groupsOf(id).map((g) => g.id) }, eng.world)) eng.exec(c);
    return eng;
  });
}

const copyOf = (id: string): ResourcePack => ({ ...(LIB.find((p) => p.id === id) as ResourcePack), id: `${id}-mine`, name: `${id}的副本` });

// 灰的项：写明原因，勾了也进不来
function checkGrey(ask: ImportAsk, p: ReturnType<typeof importPreview>) {
  const written = new Set(p.rows.map((r) => `${r.kind}:${r.id}`));
  for (const r of ask.picks) {
    const g = p.gates.of(r);
    if (g.t !== 'gated' && g.t !== 'full') continue;
    expect(g.reason, `${r.kind}:${r.id} 没写原因`).not.toBe('');
    expect(written.has(`${r.kind}:${r.id}`), `${r.kind}:${r.id} 灰着还写入了`).toBe(false);
    expect(p.dropped.some((d) => d.kind === r.kind && d.id === r.id), `${r.kind}:${r.id} 灰着没写进 dropped`).toBe(true);
  }
  for (const d of p.dropped) expect(d.reason, `${d.kind}:${d.id}`).not.toBe('');
  expect(p.count).toBe(p.rows.length);
  // 树和一列是同样的项
  const flat = (rows: readonly (typeof p.rows)[number][]): number => rows.reduce((n, r) => n + 1 + flat(r.children), 0);
  expect(flat(p.list)).toBe(p.rows.length);
}

describe('门槛一：两两导入不留下找不到的引用', () => {
  for (const from of LIB) {
    for (const to of LIB) {
      if (from.id === to.id) continue;
      it(`${from.id} → ${to.id}`, () => {
        const seed = LIB.indexOf(from) * 100 + LIB.indexOf(to) + 1;
        const rand = rng(seed);
        // 世界
        const eng = contentWorld(to.id);
        const base = worldDigest(eng.world);
        const before = danglingKeys(worldScope(eng.world));
        const steps = eng.toDoc().commands.length;
        // 每一项都有状态，灰的写明原因
        for (const [key, g] of importGates(from, { t: 'world', world: eng.world }).all()) if (g.t === 'gated' || g.t === 'full') expect(g.reason, key).not.toBe('');
        for (let round = 0; round < 6; round++) {
          const ask = untick({ source: from, target: { t: 'world', world: eng.world }, picks: sample(from, true, 1 + Math.floor(rand() * 12), rand) }, rand);
          const r = importCommand(ask, { path: [from.id] });
          checkGrey(ask, r.preview);
          // 按钮上的项数就是真的写入的
          expect(r.command?.commands.length ?? 0, `第 ${round} 次的项数：${JSON.stringify([ask.picks, ask.off])}`).toBe(r.preview.count);
          // 去掉的不带（勾的除外）
          for (const f of ask.off ?? []) if (!ask.picks.some((x) => x.kind === f.kind && x.id === f.id)) expect(r.preview.rows.find((x) => x.kind === f.kind && x.id === f.id && x.role === 'child'), `${f.kind}:${f.id} 去掉了还带着`).toBeUndefined();
          if (!r.command) continue;
          eng.exec(r.command);
          // 这一步之前就有的（库里政体写到世界没带的组）不算；这一步加的都找得到
          const after = danglingKeys(worldScope(eng.world));
          const fresh = [...after].filter((k) => !before.has(k));
          expect(fresh, `第 ${round} 次`).toEqual([]);
          for (const k of allKinds()) {
            if (!canApply(k)) continue;
            for (const x of k.inWorld(eng.world)) expect(itemErrors(k, x), `${k.id}:${itemId(k, x)}`).toEqual([]);
          }
          // 同样的勾选再导入一次：什么都不加
          const again = importPreview({ ...ask, target: { t: 'world', world: eng.world } });
          expect(again.count, `第 ${round} 次再导入：${JSON.stringify([ask.picks, ask.off])} ${JSON.stringify(again.rows.map((b) => [b.kind, b.id, b.state, b.because]))}, ${JSON.stringify(r.preview.dims)}, ${JSON.stringify(worldDimensions(eng.world.small))}`).toBe(0);
          // 一步撤销
          eng.undo();
          expect(worldDigest(eng.world)).toBe(base);
          expect(eng.toDoc().commands.length).toBe(steps);
        }
        // 我的库
        const target = copyOf(to.id);
        const packBefore = danglingKeys(packScope(target));
        for (let round = 0; round < 6; round++) {
          const ask = untick({ source: from, target: { t: 'pack', pack: target }, picks: sample(from, false, 1 + Math.floor(rand() * 12), rand) }, rand);
          const r = importToPack(ask);
          checkGrey(ask, r.preview);
          const fields = r.preview.rows.filter((x) => x.kind === 'field').length;
          expect(r.added.length + r.preview.plan.fixes.length + r.preview.dims.length + fields, `库，第 ${round} 次的项数`).toBe(r.preview.count);
          if (r.pack === target) continue;
          const fresh = [...danglingKeys(packScope(r.pack))].filter((k) => !packBefore.has(k));
          expect(fresh, `库，第 ${round} 次`).toEqual([]);
          expect(parsePack(JSON.parse(JSON.stringify(r.pack))).ok, `库，第 ${round} 次读得回来`).toBe(true);
          const again = importPreview({ ...ask, target: { t: 'pack', pack: r.pack } });
          expect(again.count, `库，第 ${round} 次再导入：${JSON.stringify([ask.picks, ask.off])} ${JSON.stringify(again.rows.map((b) => [b.kind, b.id, b.state, b.to, b.because]))}`).toBe(0);
        }
        expect(worldDigest(eng.world)).toBe(base);
      }, 120000);
    }
  }
});

// ---------- 门槛二、三 ----------

function build(id: string): Engine {
  const eng = engineFor({ cells: 6000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
  for (const c of packImportCommands(LIB, { packs: worldPartsOf(id), groups: [] }, eng.world)) eng.exec(c);
  eng.exec(NO_CURRENTS);
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  eng.exec({ op: 'generate_provinces', seed: 5 });
  const groups = groupsOf(id);
  for (const c of packImportCommands(LIB, { packs: [[id]], groups: groups.map((g) => g.id) }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [[id]], groups: groups.map((g) => g.id), countries: {}, settlements: {} });
  return eng;
}
const world = (id: string): Engine => snapshot(`closure-gates:${id}`, () => build(id));

function untouched(w: World): Record<string, string> {
  const { pop: _p, popGroups: _g, human: _h, ...rest } = humanDigest(w);
  const { nextGroup: _n, ...human } = w.small.human!;
  const d = w.derived;
  const c = w.causes;
  return { ...rest, human: digest(human), popTotal: digest(c.popTotal!), popManual: digest(c.popManual ?? null), popAutoTotal: digest(c.popAutoTotal ?? null), popCulture: digest(d.popCulture!), popCultureGroup: digest(d.popCultureGroup!), cultureNear: digest(d.cultureNear!), popDensity: digest(d.popDensity!) };
}

// 每格每个文化占多少（/255）
function cultureShares(w: World): [string, number][][] {
  const c = w.causes;
  const out: [string, number][][] = [];
  for (let i = 0; i < w.mesh.n; i++) {
    const m = new Map<string, number>();
    for (let k = 0; k < SLOTS; k++) {
      const code = c.popGroup![i * SLOTS + k];
      if (code) m.set(w.small.popGroups![code].culture, (m.get(w.small.popGroups![code].culture) ?? 0) + c.popShare![i * SLOTS + k]);
    }
    out.push([...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  }
  return out;
}

describe('灰的项在这个库里解得开（第六十五轮）', () => {
  const asPack = (id: string) => ({ t: 'pack' as const, pack: copyOf(id) });
  const pairs = LIB.flatMap((from) => LIB.filter((to) => to !== from).map((to) => [from, to] as const));

  it('内置库两两：灰的项要的变量都能在来源里勾到，原因里没有英文 id', () => {
    for (const [from, to] of pairs) {
      const dims = packItems<Era>(from, 'eras').flatMap((e) => e.dimensions.map((d) => d.id));
      const values = new Set(packItems<{ dimension: string }>(from, 'popValues').map((v) => v.dimension));
      for (const [key, g] of importGates(from, asPack(to.id)).all()) {
        if (g.t !== 'gated') continue;
        const at = `${from.id} → ${to.id} ${key.replace('\u0000', ':')}`;
        expect(g.reason, at).not.toMatch(/[a-z]{2}/i);
        expect(g.reason, at).not.toContain('需要变量');
        for (const n of g.needs) {
          if (n.kind !== 'dimension') continue;
          expect(dims.includes(n.id) && values.has(n.id), `${at} 要的 ${n.id} 这个库里勾不到`).toBe(true);
        }
      }
    }
  });

  it('把灰的项要的变量都勾上，它就能选（内置库两两）', () => {
    for (const [from, to] of pairs) {
      const target = asPack(to.id);
      const greyGovs = [...importGates(from, target).all()].filter(([key, g]) => key.startsWith('faction') && g.t === 'gated' && g.needs.every((n) => n.kind === 'dimension'));
      const allDims = packItems<Era>(from, 'eras').flatMap((e) => e.dimensions.map((d) => ({ kind: 'dimension', id: d.id })));
      const open = importGates(from, target, allDims);
      for (const [key] of greyGovs) {
        const id = key.split('\u0000')[1];
        expect(open.of({ kind: 'faction', id }).t, `${from.id} → ${to.id} ${id}`).toBe('free');
      }
    }
  });

  it('近现代的派系写到意识形态（它的时代没有）：不要这个变量；目的地有时引用留着，没有时去掉这一条', () => {
    const industrial = LIB.find((p) => p.id === 'industrial')!;
    const factions = packItems<{ id: string; drivers?: { dimension?: string; weight: number }[] }>(industrial, 'factions');
    const f = factions.find((x) => x.drivers?.some((d) => d.dimension === 'ideology'))!;
    expect(f).toBeDefined();
    const ref = { kind: 'faction', id: f.id };
    // 有意识形态的目的地（现代）：引用留着
    const keep = importToPack({ source: industrial, target: asPack('modern'), picks: [ref] });
    const kept = packItems<typeof f>(keep.pack, 'factions').find((x) => x.id === f.id);
    if (kept) expect(kept.drivers?.some((d) => d.dimension === 'ideology')).toBe(true);
    // 没有的目的地（中世纪）：只要这个库提供的变量，勾上后写到意识形态的那几条去掉
    const target = asPack('medieval');
    const g = importGates(industrial, target).of(ref);
    if (g.t === 'gated') expect(g.needs.map((n) => n.id)).not.toContain('ideology');
    const dims = packItems<Era>(industrial, 'eras').flatMap((e) => e.dimensions.map((d) => ({ kind: 'dimension', id: d.id })));
    const r = importToPack({ source: industrial, target, picks: [ref, ...dims] });
    const out = packItems<typeof f>(r.pack, 'factions').find((x) => x.id === f.id)!;
    expect(out).toBeDefined();
    expect(out.drivers?.some((d) => d.dimension === 'ideology') ?? false).toBe(false);
    expect(r.preview.stripCount).toBeGreaterThan(0);
  });
});

const modern = LIB.find((p) => p.id === 'modern')!;
const GOV = { kind: 'government', id: 'socialist-republic' };
const IDEOLOGY = { kind: 'dimension', id: 'ideology' };
const socialism = (w: World): ImportAsk => ({ source: modern, target: { t: 'world', world: w }, picks: [GOV, IDEOLOGY] });

describe('门槛二：奇幻世界导入社会主义', () => {
  it('社会主义共和国灰着，写明要意识形态；勾上意识形态后能选', () => {
    const eng = world('fantasy');
    const target = { t: 'world' as const, world: eng.world };
    expect(importGates(modern, target).of(GOV)).toMatchObject({ t: 'gated', reason: '需要意识形态' });
    const none = importCommand({ source: modern, target, picks: [GOV] }, { path: ['modern'] });
    expect(none.command).toBeNull();
    expect(none.preview.dropped.map((d) => [d.id, d.reason])).toEqual([['socialist-republic', '需要意识形态']]);
    expect(importGates(modern, target, [IDEOLOGY]).of(GOV).t).toBe('free');
  });

  it('带上派系和意识形态；文化、国家、城市、地名逐值不变，文化比例不变；重新生成国家后出现社会主义国家', () => {
    const eng = world('fantasy');
    const before = untouched(eng.world);
    const shares = cultureShares(eng.world);
    const oldDims = worldDimensions(eng.world.small).map((d) => d.id);
    const { command, preview } = importCommand(socialism(eng.world), { path: ['modern'] });
    expect(preview.rows.filter((r) => r.kind === 'government' || r.kind === 'faction' || r.kind === 'dimension').map((r) => r.id).sort()).toEqual(['ideology', 'liberals', 'revolutionary-left', 'socialist-republic']);
    expect(preview.dropped).toEqual([]);
    expect(command!.commands.length).toBe(preview.count);
    eng.exec(command!);
    const w = eng.world;
    expect(worldDimensions(w.small).map((d) => d.id)).toEqual([...oldDims, 'ideology']);
    expect(worldDimensions(w.small).find((d) => d.id === 'ideology')).toMatchObject({ required: true, added: true });
    expect(Object.keys(w.small.content!.faction!)).toEqual(expect.arrayContaining(['revolutionary-left', 'liberals']));
    expect((w.small.content!.government!['socialist-republic'] as { factions: string[] }).factions).toEqual(['revolutionary-left', 'liberals']);
    expect(untouched(w)).toEqual(before);
    expect(cultureShares(w)).toEqual(shares);
    expect(countryList(w.small).some((m) => m.government === 'socialist-republic')).toBe(false);
    expect(danglingLinks(linkTable(worldScope(w))).filter((b) => b.from.id === 'socialist-republic' || b.from.id === 'revolutionary-left' || b.from.id === 'liberals')).toEqual([]);
    // 派系的来源：主要的留着，民族认同那两条去掉
    expect((w.small.content!.faction!.liberals as { drivers: { dimension?: string }[] }).drivers.map((d) => d.dimension)).toEqual(['ideology', 'ideology', undefined]);
    eng.exec({ op: 'regenerate_countries', keepLocked: false });
    expect(countryList(eng.world.small).some((m) => m.government === 'socialist-republic')).toBe(true);
    eng.undo();
    eng.undo();
  });

  it('门槛三：一步导入，撤销回到原样，重做、存档重放、压缩后逐值相同', () => {
    const eng = world('fantasy');
    const base = worldDigest(eng.world);
    const steps = eng.toDoc().commands.length;
    eng.exec(importCommand(socialism(eng.world), { path: ['modern'] }).command!);
    const after = worldDigest(eng.world);
    expect(after).not.toBe(base);
    expect(eng.toDoc().commands.length).toBe(steps + 1);
    eng.undo();
    expect(worldDigest(eng.world)).toBe(base);
    eng.redo();
    expect(worldDigest(eng.world)).toBe(after);
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    expect(worldDigest(Engine.fromDoc(doc, eng.world.mesh).world)).toBe(after);
    const r = compactWorldDoc(doc, { mesh: eng.world.mesh });
    expect(r.verified).toBe(true);
    expect(worldDigest(Engine.fromDoc(r.doc, eng.world.mesh).world)).toBe(after);
    eng.undo();
  });

  it('去掉一个派系：政体的名单少这一个', () => {
    const eng = world('fantasy');
    const { command } = importCommand({ ...socialism(eng.world), off: [{ kind: 'faction', id: 'liberals' }] }, { path: ['modern'] });
    eng.exec(command!);
    expect((eng.world.small.content!.government!['socialist-republic'] as { factions: string[] }).factions).toEqual(['revolutionary-left']);
    expect(eng.world.small.content!.faction!.liberals).toBeUndefined();
    eng.undo();
  });
});

// ---------- 门槛四 ----------

describe('门槛四：只有一种取值的变量', () => {
  const medieval = LIB.find((p) => p.id === 'medieval')!;
  const CATHOLIC = { kind: 'popValue', id: 'catholic' };

  it('科幻世界勾天主教：写入 1 个取值 + 1 个变量；所有人都信它，文化比例逐值不变；撤销和重放一致', () => {
    const eng = world('scifi');
    expect(worldDimensions(eng.world.small).some((d) => d.id === 'religion')).toBe(false);
    const base = worldDigest(eng.world);
    const before = untouched(eng.world);
    const shares = cultureShares(eng.world);
    const steps = eng.toDoc().commands.length;
    const { command, preview } = importCommand({ source: medieval, target: { t: 'world', world: eng.world }, picks: [CATHOLIC] }, { path: ['medieval'] });
    expect(preview.rows.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(['dimension:religion', 'popValue:catholic']);
    expect(preview.count).toBe(2);
    expect(command!.commands.map((c) => c.op)).toEqual(['set_content', 'add_dimension']);
    eng.exec(command!);
    const w = eng.world;
    expect(untouched(w)).toEqual(before);
    expect(cultureShares(w)).toEqual(shares);
    // 每个群体都是天主教
    let people = 0;
    for (let i = 0; i < w.mesh.n * SLOTS; i++) {
      const code = w.causes.popGroup![i];
      if (!code) continue;
      people++;
      expect(w.small.popGroups![code].values.religion).toBe('catholic');
    }
    expect(people).toBeGreaterThan(0);
    const after = worldDigest(w);
    expect(eng.toDoc().commands.length).toBe(steps + 1);
    eng.undo();
    expect(worldDigest(eng.world)).toBe(base);
    eng.redo();
    expect(worldDigest(eng.world)).toBe(after);
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    expect(worldDigest(Engine.fromDoc(doc, eng.world.mesh).world)).toBe(after);
    eng.undo();
  });

  it('补回：世界里先导入天主教，再勾它的组：不产生 -2，引用补上，一步撤销', () => {
    const eng = contentWorld('scifi');
    const target = () => ({ t: 'world' as const, world: eng.world });
    eng.exec(importCommand({ source: medieval, target: target(), picks: [CATHOLIC] }, { path: ['medieval'] }).command!);
    const group = (eng.world.small.content!.popValue!.catholic as { group?: string }).group;
    expect(group).toBeUndefined();
    const srcGroup = packItems<{ id: string; group?: string }>(medieval, 'popValues').find((v) => v.id === 'catholic')!.group!;
    const picks = [{ kind: 'valueGroup', id: srcGroup }, CATHOLIC];
    const off = packItems<{ id: string; group?: string }>(medieval, 'popValues').filter((v) => v.group === srcGroup && v.id !== 'catholic').map((v) => ({ kind: 'popValue', id: v.id }));
    const r = importCommand({ source: medieval, target: target(), picks, off }, { path: ['medieval'] });
    expect(r.preview.rows.map((x) => [x.id, x.state])).toEqual(expect.arrayContaining([['catholic', 'fix']]));
    expect(r.preview.rows.length).toBe(2);
    const base = worldDigest(eng.world);
    eng.exec(r.command!);
    expect(Object.keys(eng.world.small.content!.popValue!).some((id) => id.startsWith('catholic-'))).toBe(false);
    expect((eng.world.small.content!.popValue!.catholic as { group?: string }).group).toBe(srcGroup);
    expect(importPreview({ source: medieval, target: target(), picks, off }).count).toBe(0);
    eng.undo();
    expect(worldDigest(eng.world)).toBe(base);
    eng.undo();
  });

  it('目的地没有时代：勾取值跟着带时代；此时全部变量算没有', () => {
    const eng = engineFor({ cells: 1000, seed: 2 }, { bare: true });
    const target = { t: 'world' as const, world: eng.world };
    const g = importGates(modern, target);
    expect(g.of(GOV).t).toBe('gated');
    expect(importGates(modern, target, [IDEOLOGY]).of(GOV).t).toBe('free');
    const valueId = packItems<{ id: string; dimension: string }>(modern, 'popValues').find((v) => v.dimension === 'ideology')!.id;
    const r = importCommand({ source: modern, target, picks: [{ kind: 'popValue', id: valueId }] }, { path: ['modern'] });
    // 第七十三轮：时代用的国家格局跟着时代来（联邦、军事同盟、保护国；第七十四轮多了民族国家、前殖民地国家）
    expect(r.preview.rows.map((x) => x.kind).sort()).toEqual(['countryPattern', 'countryPattern', 'countryPattern', 'countryPattern', 'countryPattern', 'era', 'popValue']);
    expect(r.command!.commands.length).toBe(r.preview.count);
    eng.exec(r.command!);
    expect(Object.keys(eng.world.small.content!.era!)).toEqual(['modern']);
    expect(Object.keys(eng.world.small.content!.countryPattern!).sort()).toEqual(['alliances', 'client-states', 'federation', 'nation-state', 'post-colonial']);
    expect(danglingLinks(linkTable(worldScope(eng.world))).filter((b) => b.from.id === valueId)).toEqual([]);
  });
});
