import { describe, expect, it } from 'vitest';
import type { Command } from './commands';
import { digest } from './digest';
import { Engine } from './engine';
import { kindOf } from './content/registry';
import { builtinItem } from './packs/builtin-tree';
import { DEFAULT_PROVINCE_RULES, worldProvinceRules } from './province-rules';
import { continents, setProvinceRules } from './testing/fixtures';
import type { World } from './world';

// 第七十八轮：省份划分的规则是资源库里的内容（province-rules.ts、content/province-kind.ts）。
// 划出来的省份与以前逐值相同由 docs/dev/history/第78轮.md 的临时核对管（82e28a7 上旧的命令与这里的写法，123 组世界）

const provinces = (w: World) => digest([w.causes.province, Object.entries(w.small.provinces).map(([k, p]) => [k, p.name, p.kind])]);

describe('省份划分是内容', () => {
  it('内置的一份在每个库的“基础”里，与默认的相同；新世界带着它，种子记在世界里', () => {
    const b = builtinItem('provinceRules', DEFAULT_PROVINCE_RULES.id)!;
    expect(b.item).toBe(DEFAULT_PROVINCE_RULES);
    expect(b.paths.map((p) => p[1])).toEqual(['base', 'base', 'base', 'base', 'base', 'base']);
    const w = continents({ provinces: true }).world;
    expect(w.small.content?.provinceRules).toEqual({ [DEFAULT_PROVINCE_RULES.id]: DEFAULT_PROVINCE_RULES });
    expect(w.small.origin?.provinceRules?.[DEFAULT_PROVINCE_RULES.id]).toEqual(['medieval', 'base']);
    expect(w.small.provinceSeed).toBe(5);
    expect('provinceRules' in w.small).toBe(false);
  });

  it('以前的写法报错：规则写在命令里、一次另定的大小、只整理湖', () => {
    const eng = continents({ provinces: true });
    const cells = [...Array(200).keys()];
    for (const cmd of [{ op: 'generate_provinces', rules: { seed: 3 } }, { op: 'generate_provinces', seed: 3, size: 'small' }, { op: 'regenerate_provinces', cells, size: 20 }, { op: 'set_lake_mode', mode: 'merge' }]) {
      expect(() => eng.exec(cmd as unknown as Command), JSON.stringify(cmd).slice(0, 40)).toThrow();
    }
  });

  it('移出以后按默认的划：与带着内置的那一份逐值相同', () => {
    const eng = continents();
    const a = eng.clone();
    a.exec({ op: 'generate_provinces', seed: 7 });
    eng.exec({ op: 'set_content', kind: 'provinceRules', id: DEFAULT_PROVINCE_RULES.id, item: null });
    expect(worldProvinceRules(eng.world.small)).toBe(DEFAULT_PROVINCE_RULES);
    eng.exec({ op: 'generate_provinces', seed: 7 });
    expect(provinces(eng.world)).toBe(provinces(a.world));
  });

  it('一个世界只有一份：再加一份报错；改同一份可以', () => {
    const eng = continents();
    const other = { ...DEFAULT_PROVINCE_RULES, id: 'big', name: '大省', size: 120 };
    expect(() => eng.exec({ op: 'set_content', kind: 'provinceRules', id: 'big', item: other })).toThrow(/最多 1/);
    expect(kindOf('provinceRules')!.maxInWorld).toBe(1);
    setProvinceRules(eng, { size: 120 });
    expect(worldProvinceRules(eng.world.small).size).toBe(120);
  });

  it('改了大小不重算，划分省份才用上；种子省略时沿用', () => {
    const eng = continents({ provinces: true });
    const before = provinces(eng.world);
    setProvinceRules(eng, { size: 120 });
    expect(provinces(eng.world)).toBe(before);
    eng.exec({ op: 'generate_provinces' });
    expect(eng.world.small.provinceSeed).toBe(5);
    const land = (w: World) => Object.values(w.small.provinces).filter((p) => p.land).length;
    const fresh = continents({ provinces: true });
    expect(land(eng.world)).toBeLessThan(land(fresh.world));
  });

  it('改了湖的归属马上整理（只动湖与陆地之间的格），记进这一步：重放、撤销都一样', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const lakes = () => Object.values(w.small.provinces).filter((p) => p.kind === 'lake').length;
    expect(lakes()).toBeGreaterThan(0);
    const before = provinces(w);
    setProvinceRules(eng, { lakeMode: 'merge' });
    expect(lakes()).toBe(0);
    expect(eng.toDoc().commands.at(-1)!.provinceFix).toBeTruthy();
    expect(provinces(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toBe(provinces(w));
    eng.undo();
    expect(provinces(eng.world)).toBe(before);
    // 只改了别的项：不整理
    setProvinceRules(eng, { riverCost: 9 });
    expect(provinces(eng.world)).toBe(before);
  });
});
