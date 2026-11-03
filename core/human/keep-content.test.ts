import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { compactWorldDoc } from '../compact';
import { danglingLinks, linkTable, worldScope } from '../content/links';
import { kindOf } from '../content/registry';
import { sameContent } from '../content/refs';
import { worldDigest } from '../digest';
import { Engine } from '../engine';
import { type PackNode, planPack } from '../packs';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES } from '../packs/eras';
import { NO_CURRENTS, engineFor, humanDigest, importPacks } from '../testing/fixtures';
import { mapDiff } from '../tidy';
import { cultureGroupById, worldCultureGroups, worldCultures, worldEras } from './era';
import { humanBlockers } from './generate';
import saved from './r29-digests.json';

// 第五十轮：世界保留全部内容。生成后不再移出没用到的；清理（整理）覆盖文化、文化组、地名风格、时代；文化组的比重决定参不参与生成

const r29 = saved as Record<string, unknown>;
const GROUPS = [['germanic', 3], ['chinese', 3], ['levantine', 2], ['hindustani', 2], ['east-slavic', 1.5], ['altaic', 1.5]] as const;
const groupsOf = (g: readonly (readonly [string, number])[]) => g.map(([id, weight]) => ({ id, weight }));
const MEDIEVAL = groupsOf(GROUPS);
const FANTASY = groupsOf([['germanic', 3], ['elven', 2], ['dwarven', 1.5], ['orcish', 1.5]]);

let base: Engine;
beforeAll(() => {
  base = engineFor({ cells: 12000, seed: 1, latNorth: 72, latSouth: 20 });
  base.exec(NO_CURRENTS);
  base.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  base.exec({ op: 'generate_provinces', rules: { seed: 5 } });
});

const generate = (era: string, groups: { id: string; weight: number }[], imported: string[] = groups.map((g) => g.id)): Engine => {
  const e = base.clone();
  importPacks(e, { packs: [[era]], groups: imported });
  e.exec({ op: 'generate_human', packs: [[era]], groups, countries: {}, settlements: {} });
  e.update();
  return e;
};

// 生成要用、再生成之前会加回来的几种内容（别的种类、不是生成要用的，整理掉就没了，要用时自己从资源库加）。先后也算：先后会影响挑哪一个
const GEN_KINDS = ['era', 'valueGroup', 'popValue', 'cultureGroup', 'culture', 'government', 'faction'];
const genContent = (e: Engine) => Object.fromEntries(GEN_KINDS.map((k) => [k, Object.entries((e.world.small.content?.[k] ?? {}) as object)]));

describe('保留和重新导入结果相同', () => {
  for (const [id, era, groups] of [['medieval', 'medieval', MEDIEVAL], ['fantasy', 'fantasy', FANTASY]] as const) {
    it(`${id}：生成后内容都在，地图与第二十九轮的摘要一样；整理掉再加回来与一直留着，重新生成的结果逐值相同`, () => {
      const kept = generate(era, groups);
      expect(humanDigest(kept.world)).toEqual(r29[id]);
      expect(kept.lastRemoved).toEqual([]);

      // 一直留着：重新生成国家（界面照样先加一遍包）
      const a = kept.clone();
      importPacks(a, { packs: [[era]], groups: groups.map((g) => g.id) });
      a.exec({ op: 'regenerate_countries', seed: 9 });
      a.update();
      expect(humanDigest(a.world)).toEqual(r29[`${id}:again`]);

      // 不先加：世界里已经都有了，结果也一样
      const direct = kept.clone();
      direct.exec({ op: 'regenerate_countries', seed: 9 });
      direct.update();
      expect(humanDigest(direct.world)).toEqual(r29[`${id}:again`]);

      // 整理掉没用到的，再加回来
      const b = kept.clone();
      b.exec(b.planTidy().command!);
      importPacks(b, { packs: [[era]], groups: groups.map((g) => g.id) });
      expect(genContent(b)).toEqual(genContent(kept));
      b.exec({ op: 'regenerate_countries', seed: 9 });
      b.update();
      expect(humanDigest(b.world)).toEqual(humanDigest(a.world));
      expect(mapDiff(a.world, b.world)).toEqual([]);
      // 重新生成人文也一样
      const c = kept.clone();
      c.exec({ op: 'regenerate_human' });
      c.update();
      const d = kept.clone();
      d.exec(d.planTidy().command!);
      importPacks(d, { packs: [[era]], groups: groups.map((g) => g.id) });
      d.exec({ op: 'regenerate_human' });
      d.update();
      expect(humanDigest(d.world)).toEqual(humanDigest(c.world));
    });
  }

  it('生成不碰内容：是同一个对象，撤销记录里没有内容', () => {
    const e = base.clone();
    importPacks(e, { packs: [['medieval']], groups: MEDIEVAL.map((g) => g.id) });
    const before = e.world.small.content;
    e.exec({ op: 'generate_human', packs: [['medieval']], groups: MEDIEVAL, countries: {}, settlements: {} });
    expect(e.world.small.content).toBe(before);
    const steps = (e as unknown as { done: { undo: { small?: string } }[] }).done;
    expect(steps[steps.length - 1].undo.small ?? '').not.toContain(BUILTIN_CULTURES[0].name);
  });
});

describe('清理：文化、文化组、地名风格、时代都算，地图不变', () => {
  it('没选的组、没人的文化、它们的地名风格一起移出；摘要、地图逐值相同，没有找不到的 hard 引用；撤销回到原样', () => {
    // 多带一个没选的组（北欧）
    const eng = generate('medieval', MEDIEVAL, [...MEDIEVAL.map((g) => g.id), 'scandinavian']);
    expect(humanDigest(eng.world)).toEqual(r29.medieval);
    const before = humanDigest(eng.world);
    const content = JSON.stringify(eng.world.small.content);
    const copy = eng.clone();
    const plan = eng.planTidy();
    expect(plan.kept).toEqual([]);
    const kinds = new Set(plan.removed.map((r) => r.kind));
    for (const k of ['culture', 'cultureGroup', 'nameStyle', 'government', 'popValue']) expect(kinds.has(k), k).toBe(true);
    expect(plan.removed.some((r) => r.kind === 'cultureGroup' && r.id === 'scandinavian')).toBe(true);
    const inPlan = new Set(plan.removed.map((r) => `${r.kind}:${r.id}`));
    for (const c of worldCultures(eng.world.small).filter((x) => x.group === 'scandinavian')) expect(inPlan.has(`culture:${c.id}`), c.id).toBe(true);
    eng.exec(plan.command!);
    eng.update();
    expect(humanDigest(eng.world)).toEqual(before);
    expect(mapDiff(copy.world, eng.world)).toEqual([]);
    expect(danglingLinks(linkTable(worldScope(eng.world))).filter((x) => x.link.cls === 'hard')).toEqual([]);
    // 选的组留着（生成时选了它），世界默认的地名风格留着
    expect(worldCultureGroups(eng.world.small).map((g) => g.id).sort()).toEqual(MEDIEVAL.map((g) => g.id).sort());
    expect(eng.world.small.content!.nameStyle![eng.world.small.nameStyle ?? 'zh-default']).toBeDefined();
    // 再整理一遍没有要移出的
    expect(eng.planTidy().command).toBeNull();
    // 重放与撤销
    expect(humanDigest(Engine.fromDoc(eng.toDoc(), eng.world.mesh).world)).toEqual(before);
    eng.undo();
    expect(JSON.stringify(eng.world.small.content)).toBe(content);
  });

  it('换过时代：旧的时代与旧时代没用到的内容能清理掉，地图不变', () => {
    const eng = generate('medieval', MEDIEVAL);
    importPacks(eng, { packs: [['modern']], groups: MEDIEVAL.map((g) => g.id) });
    eng.exec({ op: 'regenerate_human', packs: [['modern']], groups: MEDIEVAL, keepManual: false, countries: {} });
    eng.update();
    expect(worldEras(eng.world.small).map((e) => e.id).sort()).toEqual(['medieval', 'modern']);
    const before = humanDigest(eng.world);
    const plan = eng.planTidy();
    expect(plan.removed.some((r) => r.kind === 'era' && r.id === 'medieval')).toBe(true);
    eng.exec(plan.command!);
    eng.update();
    expect(worldEras(eng.world.small).map((e) => e.id)).toEqual(['modern']);
    expect(humanDigest(eng.world)).toEqual(before);
  });

  it('只看几项时（一个包“移出没用到的”）：文化组和组里的文化一起移出，不管列的先后；组里有在用的文化时组留着', () => {
    const eng = generate('medieval', MEDIEVAL, [...MEDIEVAL.map((g) => g.id), 'scandinavian']);
    const cultures = worldCultures(eng.world.small).filter((c) => c.group === 'scandinavian').map((c) => ({ kind: 'culture', id: c.id }));
    // 组排在文化前面
    const plan = eng.planTidy({ only: [{ kind: 'cultureGroup', id: 'scandinavian' }, ...cultures] });
    expect(plan.kept).toEqual([]);
    expect(plan.removed.map((r) => r.id).sort()).toEqual(['scandinavian', ...cultures.map((c) => c.id)].sort());
    expect(plan.command!.items!.at(-1)).toEqual({ kind: 'cultureGroup', id: 'scandinavian' });
    eng.exec(plan.command!);
    expect(cultureGroupById(eng.world.small, 'scandinavian')).toBeUndefined();
    // 选了的组、里面有人的文化：都不动
    const german = worldCultures(eng.world.small).filter((c) => c.group === 'germanic').map((c) => ({ kind: 'culture', id: c.id }));
    const p2 = eng.planTidy({ only: [{ kind: 'cultureGroup', id: 'germanic' }, ...german] });
    expect(p2.removed.some((r) => r.kind === 'cultureGroup')).toBe(false);
  });
});

describe('文化组的比重', () => {
  const withWeights = (e: Engine, weight: Record<string, number>) => {
    for (const [id, w] of Object.entries(weight)) {
      const g = cultureGroupById(e.world.small, id)!;
      e.exec({ op: 'set_content', kind: 'cultureGroup', id, item: { ...g, weight: w } as unknown as Record<string, unknown> });
    }
  };
  const run = (weight: Record<string, number>, groups: { id: string; weight: number }[] = MEDIEVAL, imported = MEDIEVAL.map((g) => g.id)) => {
    const e = base.clone();
    importPacks(e, { packs: [['medieval']], groups: imported });
    withWeights(e, weight);
    e.exec({ op: 'generate_human', packs: [['medieval']], groups, countries: {}, settlements: {} });
    e.update();
    return e;
  };

  it('内置的文化组都没写比重；没写和写了不是 0 的，结果都与第二十九轮逐字节相同（各组占多少仍是命令写的权重）', () => {
    expect(BUILTIN_CULTURE_GROUPS.every((g) => g.weight === undefined)).toBe(true);
    expect(humanDigest(run({}).world)).toEqual(r29.medieval);
    expect(humanDigest(run({ germanic: 7, altaic: 0.5 }).world)).toEqual(r29.medieval);
  });

  it('0 的组不参与生成：与命令里没选它（但它在世界里）逐字节相同；组和文化留在世界里', () => {
    const rest = MEDIEVAL.filter((g) => g.id !== 'altaic');
    const zero = run({ altaic: 0 });
    const without = run({}, rest);
    const a = humanDigest(zero.world);
    const b = humanDigest(without.world);
    // 比重写在内容里，人文、地图都与没选它一样
    expect(a).toEqual(b);
    const small = zero.world.small;
    expect(small.human!.groups.map((g) => g.id)).toEqual(rest.map((g) => g.id));
    expect(small.human!.hearths.some((h) => h.group === 'altaic')).toBe(false);
    const altaic = new Set(worldCultures(small).filter((c) => c.group === 'altaic').map((c) => c.id));
    expect(altaic.size).toBeGreaterThan(0);
    expect(Object.values(small.popGroups!).some((t) => altaic.has(t.culture))).toBe(false);
    expect(Object.values(small.countries!).some((c) => altaic.has(c.primaryCulture))).toBe(false);
    expect(cultureGroupById(small, 'altaic')).toBeDefined();
  });

  it('改成 0 后重新生成：这一组退出，锁定的发源地不碍事；全是 0 时不生成，写明缺文化', () => {
    const e = run({});
    const cell = e.world.small.human!.hearths.find((h) => h.group === 'altaic' && !h.culture)!.cell;
    e.exec({ op: 'move_hearth', group: 'altaic', cell });
    withWeights(e, { altaic: 0 });
    e.exec({ op: 'regenerate_human' });
    expect(e.world.small.human!.groups.some((g) => g.id === 'altaic')).toBe(false);
    expect(e.world.small.human!.hearths.some((h) => h.group === 'altaic')).toBe(false);

    const all = base.clone();
    importPacks(all, { packs: [['medieval']], groups: ['germanic'] });
    withWeights(all, { germanic: 0 });
    const cmd: Command = { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 1 }] };
    expect(humanBlockers(all.world, { packs: [['medieval']], groups: [{ id: 'germanic', weight: 1 }] })[0]).toMatch(/^没有文化/);
    all.exec(cmd);
    expect(all.world.small.human).toBeUndefined();
    expect(all.lastSkipped[0]).toMatch(/^没有文化/);
  });

  it('是不是同一项不看比重：世界里 0 的组，再加一遍同样的组跳过，比重不变、不改名', () => {
    const k = kindOf('cultureGroup')!;
    expect(k.pack.sameIgnore).toEqual(['weight']);
    const g = BUILTIN_CULTURE_GROUPS[0];
    expect(sameContent(k, { ...g, weight: 0 }, g)).toBe(true);
    expect(sameContent(k, { ...g, name: '别的' }, g)).toBe(false);
    const e = base.clone();
    importPacks(e, { packs: [['medieval']], groups: [g.id] });
    withWeights(e, { [g.id]: 0 });
    const pack: PackNode = { id: 'p', name: 'p', cultureGroups: [{ ...g, weight: 2 }] as unknown as PackNode['cultureGroups'] };
    const plan = planPack(e.world, pack, { cultureGroups: [g.id] });
    expect(plan.added).toEqual([]);
    expect(plan.skipped.map((s) => s.id)).toEqual([g.id]);
    importPacks(e, { packs: [['medieval']], groups: [g.id] });
    expect(cultureGroupById(e.world.small, g.id)!.weight).toBe(0);
  });
});

describe('压缩世界文件：只去掉“加了又删”', () => {
  it('生成过的世界：加了又删的那两条去掉，世界里有的一项不少，重放逐值相同', () => {
    const eng = generate('fantasy', FANTASY);
    const gov = { ...(Object.values(eng.world.small.content!.government!)[0] as object), id: 'r50-spare', name: '加了又删' } as Record<string, unknown>;
    eng.exec({ op: 'set_content', kind: 'government', id: 'r50-spare', item: gov });
    eng.exec({ op: 'set_content', kind: 'government', id: 'r50-spare', item: null });
    const doc = eng.toDoc();
    const r = compactWorldDoc(doc, { mesh: eng.world.mesh });
    expect(r.verified).toBe(true);
    expect(r.dropped).toBe(2);
    expect(r.doc.commands.length).toBe(doc.commands.length - 2);
    expect(JSON.stringify(r.doc)).not.toContain('r50-spare');
    expect(JSON.stringify(r.doc)).not.toContain('tidy_content');
    const back = Engine.fromDoc(r.doc, eng.world.mesh).world;
    expect(back.small.content).toEqual(eng.world.small.content);
    expect(worldDigest(back)).toBe(worldDigest(eng.world));
    // 没用到的（整理才移出的）都在
    expect(eng.planTidy().removed.every((x) => (back.small.content?.[x.kind] as Record<string, unknown> | undefined)?.[x.id] !== undefined || x.kind === 'biome' || x.kind === 'field')).toBe(true);
  });
});
