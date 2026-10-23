import { describe, expect, it } from 'vitest';
import { checkSpeciesScripts } from './biome-scripts';
import { FANTASY_BIOMES, FANTASY_FIELDS, fantasyBiomeCommands } from './packs/fantasy-biomes';
import { speciesSchema } from './species';
import { continents } from './testing/fixtures';

// 内置示例包的五种生态：数据有效、脚本能编译；加进测试用的大陆世界（1.2 万格）后各占陆地 ≤ 8%，也至少有一格

describe('示例生态', () => {
  it('数据：解析后不变，脚本能编译，种子固定，用到第三批的新项（存成第 4 版）', () => {
    expect(FANTASY_BIOMES.map((sp) => sp.name)).toEqual(['水晶丛林', '死亡森林', '虫群占领区', '神圣之地', '血腥之地']);
    for (const sp of FANTASY_BIOMES) {
      expect(speciesSchema.parse(sp)).toEqual(sp);
      expect(() => checkSpeciesScripts(sp)).not.toThrow();
      expect(sp.seedKey).toBe(`fantasy/${sp.id}`);
      expect(sp.feature?.label).toBeTruthy();
    }
    const cmd = fantasyBiomeCommands({ fields: [], species: [] });
    expect(cmd.op === 'batch' && cmd.commands.map((c) => c.op)).toEqual(['add_field', ...FANTASY_BIOMES.map(() => 'add_species')]);
    // 已有的场、生态跳过
    const again = fantasyBiomeCommands({ fields: [...FANTASY_FIELDS], species: ['crystal_jungle'] });
    expect(again.op === 'batch' && again.commands.length).toBe(4);
  });

  it('示例生态各占陆地 ≤8% 且至少 1 格（五种一起加上，一步）', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec(fantasyBiomeCommands({ fields: Object.keys(w.causes.fields), species: w.small.species.map((s) => s.id) }));
    expect(eng.history.at(-1)!.summary).toBe('添加了示例生态：水晶丛林、死亡森林、虫群占领区、神圣之地、血腥之地');
    const d = w.derived;
    expect(d.scriptIssues).toBeUndefined();
    expect(d.placeF).toBeDefined();
    expect(d.look).toBeDefined();
    let land = 0;
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i]) land++;
    for (const sp of FANTASY_BIOMES) {
      const s = w.small.species.findIndex((x) => x.id === sp.id);
      let count = 0;
      for (let i = 0; i < w.mesh.n; i++) if (d.dominant[i] === s) count++;
      expect(count, sp.name).toBeGreaterThanOrEqual(1);
      expect(count / land, sp.name).toBeLessThanOrEqual(0.08);
    }
  });
});
