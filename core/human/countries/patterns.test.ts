import { describe, expect, it } from 'vitest';
import { dependencyClosure, linkTable, linksOf, packScope } from '../../content/links';
import { kindOf } from '../../content/registry';
import { type PackNode, type ResourcePack, defaultPicks, ownItems, packFromWorld, packItems, parsePack, planPack } from '../../packs';
import { builtinPacks } from '../../packs/builtin-tree';
import { importCommand, importPreview } from '../../packs/closure';
import { BUILTIN_COUNTRY_PATTERNS } from '../../packs/countries';
import { BUILTIN_ERAS } from '../../packs/eras';
import { continents, engineFor, generateHuman } from '../../testing/fixtures';
import { blocList } from '../blocs';
import { countryList } from './base';
import { type CountryPattern, patternModules, patternUses } from './patterns';

// 第七十三轮：邦联、联邦、同盟、附庸成了国家格局（模块 + 资源库里的“国家格局”），时代写 patterns

const LIB = builtinPacks();
const top = (id: string): PackNode => LIB.find((p) => p.id === id)!;
const builtinSmall = { content: { countryPattern: Object.fromEntries(BUILTIN_COUNTRY_PATTERNS.map((p) => [p.id, p])) } };

// 第七十二轮以前六个时代的 relations（拷下来的，不要改它）：除了称号，这些都是生成的规则
const OLD_RELATIONS: Record<string, { confederation?: number; federation?: number; alliances?: number; subjects?: Record<string, number> }> = {
  antiquity: { subjects: { tributary: 3, vassal: 1 } },
  medieval: { confederation: 1, subjects: { vassal: 4, tributary: 1 } },
  industrial: { federation: 0.7, alliances: 2, subjects: { protectorate: 2, dominion: 2, vassal: 0.5 } },
  modern: { federation: 1, alliances: 3, subjects: { protectorate: 2, dominion: 1 } },
  fantasy: { confederation: 0.6, alliances: 1, subjects: { vassal: 3, tributary: 1 } },
  scifi: { federation: 1, alliances: 2, subjects: { protectorate: 2, dominion: 1, vassal: 1 } },
};

describe('模块', () => {
  it('第七十三轮的四个按调的先后：神圣帝国 → 联邦 → 军事同盟 → 附庸（联邦、同盟共用随机流 blocs，先后不能换；第七十四轮的插在中间，见 era-patterns.test.ts）', () => {
    expect(patternModules().map((m) => m.id).filter((id) => ['holy-empire', 'federation', 'alliance', 'vassals'].includes(id))).toEqual(['holy-empire', 'federation', 'alliance', 'vassals']);
    // 时代没列时：附庸照旧（1），别的没有（第七十四轮的民族主义也是 1，按时代的 nationalism）
    expect(['holy-empire', 'federation', 'alliance', 'vassals'].map((id) => patternModules().find((m) => m.id === id)!.fallback ?? 0)).toEqual([0, 0, 0, 1]);
  });

  it('时代没写格局：附庸 1、没有从属的种类，别的 0（和以前没写 relations 一样）', () => {
    const uses = patternUses(builtinSmall, { patterns: undefined });
    expect(uses.get('vassals')).toEqual({ amount: 1, params: {}, patterns: [] });
    for (const id of ['holy-empire', 'federation', 'alliance']) expect(uses.get(id)!.amount).toBe(0);
  });

  it('同一个模块列了几次：多少加起来，参数用第一个；世界里没有的格局、不认得的模块不算', () => {
    const small = { content: { countryPattern: { ...builtinSmall.content.countryPattern, odd: { id: 'odd', name: '怪', module: 'nope', amount: 3 } } } };
    const uses = patternUses(small, {
      patterns: [{ pattern: 'feudal-vassals' }, { pattern: 'protectorates', amount: 0.5 }, { pattern: 'missing', amount: 9 }, { pattern: 'odd' }, { pattern: 'alliances', amount: 1.5 }],
    });
    expect(uses.get('vassals')).toEqual({ amount: 1.5, params: { vassal: 4, tributary: 1 }, patterns: ['feudal-vassals', 'protectorates'] });
    expect(uses.get('alliance')!.amount).toBe(1.5);
    expect(uses.get('holy-empire')!.amount).toBe(0);
  });
});

describe('六个内置的时代', () => {
  for (const era of BUILTIN_ERAS) {
    it(`${era.id}：格局就是以前的 relations（邦联、联邦、同盟的多少，附庸的种类）；relations 只剩称号`, () => {
      const old = OLD_RELATIONS[era.id];
      const uses = patternUses(builtinSmall, era);
      // 第七十五轮：奇幻不再有神圣帝国（种族王国的山中要塞、荒原部落取代了它，见 era-patterns.test.ts）
      expect(uses.get('holy-empire')!.amount).toBe(era.id === 'fantasy' ? 0 : (old.confederation ?? 0));
      expect(uses.get('federation')!.amount).toBe(old.federation ?? 0);
      expect(uses.get('alliance')!.amount).toBe(old.alliances ?? 0);
      expect(uses.get('vassals')!.amount).toBe(1);
      expect(uses.get('vassals')!.params).toEqual(old.subjects ?? {});
      expect(Object.keys(era.relations ?? {}).filter((k) => k !== 'titles')).toEqual([]);
      expect(era.nationalism).toBeGreaterThan(0);
    });
  }

  it('每个库的“时代”小包里正好是它的时代用的格局（按时代列的先后）；几个库共用的是同一份', () => {
    for (const era of BUILTIN_ERAS) {
      const node = (top(era.id).packs as PackNode[]).find((p) => p.id === 'era')!;
      expect(ownItems<CountryPattern>(node, 'countryPatterns').map((p) => p.id)).toEqual((era.patterns ?? []).map((e) => e.pattern));
    }
    const fed = (id: string) => packItems<CountryPattern>(top(id), 'countryPatterns').find((p) => p.id === 'federation');
    expect(fed('modern')).toBe(fed('scifi'));
    // 内置的每一种都有时代用
    const used = new Set(BUILTIN_ERAS.flatMap((e) => (e.patterns ?? []).map((p) => p.pattern)));
    expect(BUILTIN_COUNTRY_PATTERNS.map((p) => p.id).filter((id) => !used.has(id))).toEqual([]);
  });
});

describe('引用与闭包', () => {
  it('时代的 patterns 是 auto 的引用：引用表、依赖的闭包都带上', () => {
    const era = BUILTIN_ERAS.find((e) => e.id === 'medieval')!;
    const links = linksOf('era', era).filter((l) => l.kinds.includes('countryPattern'));
    expect(links.map((l) => [l.id, l.cls])).toEqual([
      ['holy-empire', 'auto'],
      ['central-empire', 'auto'],
      ['feudal-vassals', 'auto'],
      ['khanate', 'auto'],
    ]);
    const closure = dependencyClosure(linkTable(packScope(top('medieval'))), [{ kind: 'era', id: 'medieval' }]);
    expect(closure.auto.filter((r) => r.kind === 'countryPattern').map((r) => r.id)).toEqual(['holy-empire', 'central-empire', 'feudal-vassals', 'khanate']);
  });

  it('从库里勾一个时代加进世界：格局跟着来；缺了的格局去掉那一条（auto）', () => {
    const eng = engineFor({ cells: 2000 }, { bare: true });
    const ask = { source: top('industrial'), target: { t: 'world' as const, world: eng.world }, picks: [{ kind: 'era', id: 'industrial' }] };
    const rows = importPreview(ask).rows.filter((r) => r.kind === 'countryPattern');
    // 第七十四轮多了殖民地、民族统一、多民族帝国
    const all = ['alliances', 'colonies', 'federation', 'multiethnic', 'protectorates', 'unification'];
    expect(rows.map((r) => r.id).sort()).toEqual(all);
    eng.exec(importCommand(ask).command!);
    expect(Object.keys(eng.world.small.content?.countryPattern ?? {}).sort()).toEqual(all);
    // 只勾时代、去掉联邦：时代里那一条去掉，别的照旧
    const off = importPreview({ ...ask, target: { t: 'world', world: engineFor({ cells: 2000 }, { bare: true }).world }, off: [{ kind: 'countryPattern', id: 'federation' }] });
    expect(off.rows.filter((r) => r.kind === 'countryPattern').map((r) => r.id).sort()).toEqual(all.filter((id) => id !== 'federation'));
  });
});

describe('资源包', () => {
  const mine: CountryPattern = { id: 'my-vassals', name: '我的附庸', module: 'vassals', amount: 0.5, protectorate: 3, dominion: 1 };

  it('自己做的格局导出成资源包、读回来、加进另一个世界：一模一样；不认得的键读的时候去掉', () => {
    const eng = engineFor({ cells: 2000 }, { bare: true });
    eng.exec({ op: 'set_content', kind: 'countryPattern', id: mine.id, item: mine as unknown as Record<string, unknown> });
    const pack = packFromWorld(eng.world, {}, { id: 'mine', name: '我的' });
    expect(pack.countryPatterns).toEqual([mine]);
    const parsed = parsePack(JSON.parse(JSON.stringify(pack)));
    expect(parsed.ok).toBe(true);
    const back = (parsed as { pack: ResourcePack }).pack;
    expect(back.countryPatterns).toEqual([mine]);
    const other = engineFor({ cells: 2000 }, { bare: true });
    other.exec(planPack(other.world, back, defaultPicks(back), { path: ['mine'] }).command);
    expect(other.world.small.content?.countryPattern?.[mine.id]).toEqual(mine);
    const schema = kindOf('countryPattern')!.schema;
    expect(schema.parse({ ...mine, nope: 3 })).toEqual(mine);
  });

  it('模块不认得：不能加进世界，资源包的问题里写明', () => {
    const eng = engineFor({ cells: 2000 }, { bare: true });
    expect(() => eng.exec({ op: 'set_content', kind: 'countryPattern', id: 'x', item: { id: 'x', name: '怪', module: 'nope', amount: 1 } })).toThrow(/模块 nope 不认识/);
    const problems = kindOf('countryPattern')!.pack.problems!([{ id: 'x', name: '怪', module: 'nope', amount: 1 }], { ids: () => new Set(), fields: new Set(), lists: new Set() });
    expect(problems[0]).toMatch(/不认识/);
  });
});

describe('生成', () => {
  it('中世纪：时代去掉神圣帝国就没有帝国，附庸照旧；附庸的多少写 0 就没有附庸', () => {
    const eng = continents({ cells: 6000, provinces: true });
    generateHuman(eng, 'medieval', [
      { id: 'germanic', weight: 3 },
      { id: 'french', weight: 2 },
      { id: 'italian', weight: 1 },
    ], { countries: {} });
    const era = eng.world.small.content!.era!.medieval as (typeof BUILTIN_ERAS)[number];
    const base = eng.clone();
    const subjects = (e: typeof eng) => countryList(e.world.small).filter((m) => m.overlord !== undefined).length;
    const empires = (e: typeof eng) => blocList(e.world.small).filter((b) => b.kind === 'empire').length;
    expect(empires(base)).toBeGreaterThan(0);
    const without = eng.clone();
    without.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: { ...era, patterns: [{ pattern: 'feudal-vassals' }] } as unknown as Record<string, unknown> });
    without.exec({ op: 'regenerate_countries' } as never);
    expect(empires(without)).toBe(0);
    const none = eng.clone();
    none.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: { ...era, patterns: [{ pattern: 'holy-empire', amount: 1 }, { pattern: 'feudal-vassals', amount: 0 }] } as unknown as Record<string, unknown> });
    none.exec({ op: 'regenerate_countries' } as never);
    expect(subjects(none)).toBe(0);
    // 再写回原来的：和第一次一样
    const again = none.clone();
    again.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: era as unknown as Record<string, unknown> });
    again.exec({ op: 'regenerate_countries' } as never);
    const regen = base.clone();
    regen.exec({ op: 'regenerate_countries' } as never);
    expect(JSON.stringify(again.world.small.countries)).toBe(JSON.stringify(regen.world.small.countries));
    // 收不收附庸是随机的（第八十四轮：这个种子下正好一个都没收），再换两个种子一起数
    const more = [11, 12].map((seed) => {
      const e = base.clone();
      e.exec({ op: 'regenerate_countries', seed } as never);
      return subjects(e);
    });
    expect(subjects(regen) + more[0] + more[1]).toBeGreaterThan(0);
  });
});
