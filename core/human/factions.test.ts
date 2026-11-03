import { describe, expect, it } from 'vitest';
import { digest } from '../digest';
import { Engine } from '../engine';
import { danglingLinks, linkTable, linksOf, packScope, renameLinks, stripLinks, worldScope } from '../content/links';
import { kindOf, usageOf } from '../content/registry';
import { type PackNode, type ResourcePack, defaultPicks, findPack, packItems, planPack } from '../packs';
import { builtinPacks } from '../packs/builtin-tree';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from '../packs/governments';
import { continents, humanExec, snapshot, type HumanCommand } from '../testing/fixtures';
import { countryList } from './countries';
import { allCountryStats, countryFactions } from './country-layers';
import { type Faction, type Government, governmentById } from './government';

// 第五十三轮：派系融入政体。政体列有哪些派系，比重在国家里：默认基础分量加人口（用到时才算，不存），档案里的滑块可以覆盖、恢复自动

const LIB = builtinPacks();
const GEN: HumanCommand = {
  op: 'generate_human',
  packs: [['medieval']],
  groups: [{ id: 'germanic', weight: 1 }, { id: 'east-slavic', weight: 1 }],
  countries: {},
};
const world = (): Engine =>
  snapshot('factions:medieval', () => {
    const eng = continents();
    humanExec(eng, GEN);
    return eng;
  });
// 档案和导出看到的全部
const shown = (eng: Engine) => countryList(eng.world.small).map((m) => countryFactions(eng.world, m.id));

describe('内置的名单', () => {
  it('每个内置政体至少两个派系，不重复，都有这个派系；派系的基础分量大于 0，没有旧的 base', () => {
    expect(BUILTIN_GOVERNMENTS.length).toBeGreaterThan(50);
    const ids = new Set(BUILTIN_FACTIONS.map((f) => f.id));
    for (const g of BUILTIN_GOVERNMENTS) {
      expect(g.factions?.length, g.id).toBeGreaterThanOrEqual(2);
      expect(new Set(g.factions).size, g.id).toBe(g.factions!.length);
      for (const id of g.factions!) expect(ids.has(id), `${g.id}: ${id}`).toBe(true);
    }
    for (const f of BUILTIN_FACTIONS) {
      expect(f.amount, f.id).toBeGreaterThan(0);
      expect(f, f.id).not.toHaveProperty('base');
      // 每个派系都有政体列着（不是白带的）
      expect(BUILTIN_GOVERNMENTS.some((g) => g.factions!.includes(f.id)), f.id).toBe(true);
    }
  });

  for (const root of LIB) {
    it(`${root.name}：每个政体的派系这个库里都有；库里的名单不是都一样`, () => {
      const facs = new Set(packItems<Faction>(findPack(root, ['factions'])!, 'factions').map((f) => f.id));
      const govs = packItems<Government>(findPack(root, ['governments'])!, 'governments');
      expect(govs.length).toBeGreaterThan(0);
      for (const g of govs) {
        expect(g.factions?.length, g.id).toBeGreaterThanOrEqual(2);
        for (const id of g.factions!) expect(facs.has(id), `${root.id}/${g.id}: ${id}`).toBe(true);
      }
      expect(new Set(govs.map((g) => g.factions!.join())).size, root.id).toBeGreaterThan(1);
      // 引用表也这样看：这个库单独看，政体没有找不到的派系
      const bad = danglingLinks(linkTable(packScope(root))).filter((d) => d.from.kind === 'government' && d.link.kinds.includes('faction'));
      expect(bad, root.id).toEqual([]);
    });
  }
});

describe('自动的比重', () => {
  it('只有政体列的派系，按政体列的先后，加起来是 1；用到时才算，世界里不存', () => {
    const eng = world();
    const w = eng.world;
    expect(countryList(w.small).length).toBeGreaterThan(1);
    for (const m of countryList(w.small)) {
      expect(m.factions, m.name).toBeUndefined();
      const fs = countryFactions(w, m.id);
      expect(fs.map((f) => f.id)).toEqual(governmentById(w.small, m.government)!.factions);
      expect(fs.reduce((a, f) => a + f.influence, 0)).toBeCloseTo(1, 2);
    }
  });

  it('基础分量 + 人口：和手算的逐值相同；基础分量改大，它就变大', () => {
    const eng = world();
    const m = countryList(eng.world.small)[0];
    const gov = governmentById(eng.world.small, m.government)!;
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id, item: { ...gov, factions: ['nobility', 'burghers'] } });
    const w = eng.world;
    const st = allCountryStats(w).get(m.id)!;
    const content = w.small.content!.faction as Record<string, Faction>;
    // 贵族看主流文化（权重 0.3），市民看海边（权重 0.8）
    const a = content.nobility.amount + 0.3 * st.primaryShare;
    const b = content.burghers.amount + 0.8 * st.coastalShare;
    const round = (x: number) => Math.round((x / (a + b)) * 1000) / 1000;
    const before = countryFactions(w, m.id, st);
    expect(before.map((f) => f.influence)).toEqual([round(a), round(b)]);
    eng.exec({ op: 'set_content', kind: 'faction', id: 'burghers', item: { ...content.burghers, amount: content.burghers.amount + 3 } });
    expect(countryFactions(eng.world, m.id)[1].influence).toBeGreaterThan(before[1].influence);
  });

  it('政体列的改了，下一次就是新的名单；世界里没有的派系不算', () => {
    const eng = world();
    const m = countryList(eng.world.small)[0];
    const gov = governmentById(eng.world.small, m.government)!;
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id, item: { ...gov, factions: [gov.factions![1], 'nobody', gov.factions![0]] } });
    expect(countryFactions(eng.world, m.id).map((f) => f.id)).toEqual([gov.factions![1], gov.factions![0]]);
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id, item: { ...gov, factions: [] } });
    expect(countryFactions(eng.world, m.id)).toEqual([]);
  });
});

describe('档案里的滑块', () => {
  const setup = () => {
    const eng = world();
    const m = countryList(eng.world.small)[0];
    const auto = countryFactions(eng.world, m.id);
    const own = Object.fromEntries(auto.map((f, k) => [f.id, k ? 0.2 / (auto.length - 1) : 0.8]));
    return { eng, m, auto, own };
  };

  it('一次改动一条命令：撤销回到自动，重做回到覆盖；恢复自动逐值相同', () => {
    const { eng, m, auto, own } = setup();
    const before = digest(eng.world.small.countries);
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: own } });
    const set = digest(eng.world.small.countries);
    expect(set).not.toBe(before);
    expect(countryFactions(eng.world, m.id).map((f) => f.influence)).toEqual(auto.map((f) => own[f.id]));
    eng.undo();
    expect(digest(eng.world.small.countries)).toBe(before);
    expect(countryFactions(eng.world, m.id)).toEqual(auto);
    eng.redo();
    expect(digest(eng.world.small.countries)).toBe(set);
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: null } });
    expect(digest(eng.world.small.countries)).toBe(before);
    expect(eng.world.small.countries![m.id].factions).toBeUndefined();
    expect(countryFactions(eng.world, m.id)).toEqual(auto);
  });

  it('重放：世界文件打开后比重逐值相同', () => {
    const { eng, m, own } = setup();
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: own } });
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(digest(again.world.small.countries)).toBe(digest(eng.world.small.countries));
    expect(shown(again)).toEqual(shown(eng));
  });

  it('只动档案：别的国家、地图都不变', () => {
    const { eng, m, own } = setup();
    const others = countryList(eng.world.small).filter((c) => c.id !== m.id).map((c) => countryFactions(eng.world, c.id));
    const land = digest(eng.world.causes.country!);
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: own } });
    expect(countryList(eng.world.small).filter((c) => c.id !== m.id).map((c) => countryFactions(eng.world, c.id))).toEqual(others);
    expect(digest(eng.world.causes.country!)).toBe(land);
  });

  it('换政体回到自动；撤销连覆盖一起回来', () => {
    const { eng, m, own } = setup();
    const was = m.government;
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: own } });
    const other = Object.keys(eng.world.small.content!.government!).find((id) => id !== was)!;
    eng.exec({ op: 'set_country', id: m.id, patch: { government: other } });
    expect(eng.world.small.countries![m.id].factions).toBeUndefined();
    expect(countryFactions(eng.world, m.id).map((f) => f.id)).toEqual(governmentById(eng.world.small, other)!.factions);
    eng.undo();
    expect(eng.world.small.countries![m.id].factions).toEqual(own);
    // 政体不变时写一遍政体，覆盖还在
    eng.exec({ op: 'set_country', id: m.id, patch: { government: was } });
    expect(eng.world.small.countries![m.id].factions).toEqual(own);
  });

  it('政体的名单后来改了：名单外的不看，没写的按自动，加起来还是 1', () => {
    const { eng, m, auto } = setup();
    const gov = governmentById(eng.world.small, m.government)!;
    expect(auto.length).toBeGreaterThanOrEqual(2);
    const [a, b] = auto;
    eng.exec({ op: 'set_country', id: m.id, patch: { factions: { [a.id]: 0.9, gone: 0.1 } } });
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id, item: { ...gov, factions: [a.id, b.id] } });
    const fs = countryFactions(eng.world, m.id);
    expect(fs.map((f) => f.id)).toEqual([a.id, b.id]);
    expect(fs.reduce((x, f) => x + f.influence, 0)).toBeCloseTo(1, 2);
    expect(fs[0].influence).toBeGreaterThan(fs[1].influence);
  });
});

describe('引用', () => {
  const gov = (factions: string[]): Government => kindOf('government')!.schema.parse({ id: 'g', name: '政体', category: ['monarchy'], titles: '国', factions }) as Government;
  const k = () => kindOf('government')!;

  it('政体的名单是 auto 类的引用（没有它政体也成立，默认跟着带）', () => {
    const links = linksOf(k(), gov(['a', 'b']));
    expect(links.map((l) => [l.kinds, l.id, l.cls])).toEqual([
      [['faction'], 'a', 'auto'],
      [['faction'], 'b', 'auto'],
    ]);
  });

  it('改名：名单跟着改，先后不变；没改到的给回原来的对象', () => {
    const g = gov(['a', 'b']);
    expect((renameLinks(k(), g, { biomes: new Map(), riverTypes: new Map(), factions: new Map([['a', 'a-2']]) }) as Government).factions).toEqual(['a-2', 'b']);
    expect(renameLinks(k(), g, { biomes: new Map(), riverTypes: new Map(), factions: new Map([['x', 'y']]) })).toBe(g);
  });

  it('去掉：列表里去掉一个，都去掉时字段也没了，格式检查照样过', () => {
    const g = gov(['a', 'b']);
    expect((stripLinks(k(), g, (l) => l.id === 'a') as Government).factions).toEqual(['b']);
    const none = stripLinks(k(), g, (l) => l.kinds.includes('faction'));
    expect(none).not.toHaveProperty('factions');
    expect(k().schema.safeParse(none).success).toBe(true);
  });

  it('撞名导入：世界里同 id 的派系不一样时，加进来的叫 x-2，政体跟着指到 x-2，世界里原来的不动', () => {
    const eng = world();
    const here = eng.world.small.content!.faction!.nobility as Faction;
    const pack: ResourcePack = {
      format: 'map2-pack',
      version: 1,
      id: 'mine',
      name: '我的',
      factions: [{ ...here, amount: 9 }],
      governments: [{ ...gov(['nobility', 'clergy']), id: 'mine-gov' }],
    } as ResourcePack;
    const plan = planPack(eng.world, pack as PackNode, defaultPicks(pack as PackNode), { path: ['mine'] });
    eng.exec(plan.command);
    const small = eng.world.small;
    expect(small.content!.faction!.nobility).toEqual(here);
    expect((small.content!.faction!['nobility-2'] as Faction).amount).toBe(9);
    expect((small.content!.government!['mine-gov'] as Government).factions).toEqual(['nobility-2', 'clergy']);
    expect(danglingLinks(linkTable(worldScope(eng.world))).filter((d) => d.link.kinds.includes('faction'))).toEqual([]);
  });

  it('在用：政体列着的派系移不出去；政体也没了就能移；整理时一起算', () => {
    const eng = world();
    const m = countryList(eng.world.small)[0];
    const id = governmentById(eng.world.small, m.government)!.factions![0];
    expect(() => eng.exec({ op: 'set_content', kind: 'faction', id, item: null })).toThrow(/政体列着它/);
    const u = usageOf(kindOf('faction')!, eng.world, id)!;
    expect(u.label).toMatch(/政体列着它.*国家有它/);
    // 整理之后留下的政体，它们的派系都在；没有政体列的派系都走了
    eng.exec(eng.planTidy().command!);
    const small = eng.world.small;
    const listed = new Set(Object.values(small.content!.government as Record<string, Government>).flatMap((g) => g.factions ?? []));
    expect(new Set(Object.keys(small.content!.faction!))).toEqual(listed);
    expect(listed.size).toBeGreaterThan(0);
  });

  it('删掉全部国家：政体和派系一起走', () => {
    const eng = world();
    eng.exec({ op: 'remove_countries' });
    expect(eng.world.small.content?.government).toBeUndefined();
    expect(eng.world.small.content?.faction).toBeUndefined();
  });
});
