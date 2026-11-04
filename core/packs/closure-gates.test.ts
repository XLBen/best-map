import { describe, expect, it } from 'vitest';
import { compactWorldDoc } from '../compact';
import { danglingLinks, linkTable, packScope, worldScope } from '../content/links';
import { allKinds, itemId } from '../content/registry';
import { digest, worldDigest } from '../digest';
import { Engine } from '../engine';
import { countryList } from '../human/countries';
import { worldDimensions } from '../human/era';
import { SLOTS } from '../human/groups';
import { type PackNode, type ResourcePack, itemErrors, packItems, packSections, parsePack, canApply } from '../packs';
import { NO_CURRENTS, engineFor, humanDigest, snapshot } from '../testing/fixtures';
import type { World } from '../world';
import { builtinPacks, worldPartsOf } from './builtin-tree';
import { type ImportAsk, importCommand, importPreview, importToPack } from './closure';
import { ERA_PACKS } from './eras';
import { packImportCommands } from './import';

// 第六十一轮的门槛：
//   1. 所有内置库之间两两导入随机抽的若干项（固定种子），加上取消部分依赖，世界和库里都没有找不到的引用；
//   2. 奇幻导入社会主义：变量到位，文化、国家、城市、地名的摘要逐值不变，文化比例不变；重新生成国家后出现社会主义国家；
//   3. 一步导入，撤销回到原样，存档重放逐值相同。库的那一半在 src/ui/packs/library-edit.test.ts

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

// 抽几项：每次先抽一种再抽一项，所以小的种类也抽得到
function sample(source: PackNode, world: boolean, n: number, rand: () => number) {
  const kinds = packSections().filter((k) => (world ? canApply(k) : true) && packItems(source, k.pack.key).length);
  const out = new Map<string, { kind: string; id: string }>();
  for (let k = 0; k < n * 3 && out.size < n; k++) {
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const items = packItems(source, kind.pack.key);
    const id = itemId(kind, items[Math.floor(rand() * items.length)]);
    out.set(`${kind.id}:${id}`, { kind: kind.id, id });
  }
  return [...out.values()];
}

// 随机取消一些依赖（锁着的不取消：界面上点不了）；再随机加上可选的变量
function untick(ask: ImportAsk, rand: () => number): ImportAsk {
  const p = importPreview(ask);
  const off = p.bring.filter((r) => !r.locked && r.state !== 'off' && rand() < 0.4).map((r) => ({ kind: r.kind, id: r.id }));
  const on = p.optional.filter(() => rand() < 0.3).map((r) => ({ kind: r.kind, id: r.id }));
  return { ...ask, off, on };
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
        for (let round = 0; round < 6; round++) {
          const ask = untick({ source: from, target: { t: 'world', world: eng.world }, picks: sample(from, true, 1 + Math.floor(rand() * 12), rand) }, rand);
          const r = importCommand(ask, { path: [from.id] });
          // 取消的不带（写到它的也取消了时，这一行就没有了）
          for (const f of ask.off ?? []) expect(r.preview.bring.find((x) => x.kind === f.kind && x.id === f.id)?.state ?? 'off', `${f.kind}:${f.id} 取消了还带着`).toBe('off');
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
          // 同样的勾选再导入一次：全部已经有了
          const again = importPreview({ ...ask, target: { t: 'world', world: eng.world } });
          expect(again.count, `第 ${round} 次再导入：${JSON.stringify([ask.picks, ask.off, ask.on])} ${JSON.stringify(again.bring.map((b) => [b.id, b.state, b.why]))}${JSON.stringify(again.renamed.map((b) => b.id))}, ${JSON.stringify(r.preview.dims)}, ${JSON.stringify(worldDimensions(eng.world.small))}`).toBe(0);
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
          if (r.pack === target) continue;
          const fresh = [...danglingKeys(packScope(r.pack))].filter((k) => !packBefore.has(k));
          expect(fresh, `库，第 ${round} 次`).toEqual([]);
          expect(parsePack(JSON.parse(JSON.stringify(r.pack))).ok, `库，第 ${round} 次读得回来`).toBe(true);
          expect(importPreview({ ...ask, target: { t: 'pack', pack: r.pack } }).count).toBe(0);
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
  eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
  const groups = groupsOf(id);
  for (const c of packImportCommands(LIB, { packs: [[id]], groups: groups.map((g) => g.id) }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [[id]], groups, countries: {}, settlements: {} });
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

const modern = LIB.find((p) => p.id === 'modern')!;
const socialism = (w: World): ImportAsk => ({ source: modern, target: { t: 'world', world: w }, picks: [{ kind: 'government', id: 'socialist-republic' }] });

describe('门槛二：奇幻世界导入社会主义', () => {
  it('带上派系和意识形态；文化、国家、城市、地名逐值不变，文化比例不变；重新生成国家后出现社会主义国家', () => {
    const eng = world('fantasy');
    const before = untouched(eng.world);
    const shares = cultureShares(eng.world);
    const oldDims = worldDimensions(eng.world.small).map((d) => d.id);
    const { command, preview } = importCommand(socialism(eng.world), { path: ['modern'] });
    expect(preview.bring.map((r) => r.id).sort()).toEqual(['ideology', 'liberals', 'revolutionary-left']);
    expect(preview.optional.map((r) => r.id)).toEqual(['nation']);
    expect(preview.over).toEqual([]);
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

  it('取消意识形态：只加政体和派系，没有 add_dimension；人一点不动', () => {
    const eng = world('fantasy');
    const before = humanDigest(eng.world);
    const { command } = importCommand({ ...socialism(eng.world), off: [{ kind: 'dimension', id: 'ideology' }] }, { path: ['modern'] });
    expect(JSON.stringify(command)).not.toContain('add_dimension');
    eng.exec(command!);
    expect(humanDigest(eng.world).popGroups).toBe(before.popGroups);
    expect((eng.world.small.content!.faction!['revolutionary-left'] as { drivers?: unknown[] }).drivers).toBeUndefined();
    expect(danglingLinks(linkTable(worldScope(eng.world))).filter((b) => b.from.id === 'liberals' || b.from.id === 'revolutionary-left')).toEqual([]);
    eng.undo();
  });
});
