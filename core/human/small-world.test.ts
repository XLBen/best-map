import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { builtinPacks, worldPartsOf } from '../packs/builtin-tree';
import { ERA_PACKS } from '../packs/eras';
import { packImportCommands } from '../packs/import';
import { settingsAt } from '../presets';
import { engineFor } from '../testing/fixtures';
import { worldEra } from './era';
import { useRound85Terrain } from '../../core/testing/round85';

// 第八十六轮：生成的地形有意变了。这里查的是编辑（画河、切省、起名……）的逻辑，要的地方、记下的值是在第八十五轮的地形上的：
// 地形退回第八十五轮（core/testing/round85.ts）
useRound85Terrain();

// 第八十四轮的回归：向导里“一块大陆 · 一片海域”（约 5000 km 宽）的世界，时代的国家大小按大世界定（中世纪平均 150 万 km²），
// 以前只有 2 个国家、一国最多占能住人的地方的 12%，七成的地方无主。现在至少约 9 国（够盖满），能住人的地方大半有主。
// 走向导的那条路：库里的世界部分 → 生成地形 → 库里的时代、文化组（默认的那些）→ 生成人文（国家、城市）→ 划分省份
function wizardWorld(era: string, seed: number) {
  const LIB = builtinPacks();
  const eng = engineFor({ ...settingsAt('region', 46, 12000), seed }, { bare: true });
  const groups = ERA_PACKS.get(era)!.cultures.map(([g]) => g);
  for (const c of packImportCommands(LIB, { packs: worldPartsOf(era), groups: [] }, eng.world)) eng.exec(c);
  eng.exec({ op: 'set_worldgen', params: { seed, type: 'continent' }, reset: true });
  for (const c of packImportCommands(LIB, { packs: [[era]], groups }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [[era]], groups, seed: 694690, countries: {}, settlements: {} } as Command);
  eng.exec({ op: 'generate_provinces', seed });
  eng.update();
  return eng.world;
}

describe('小世界的国家（向导的一片海域）', () => {
  // 古代的国家只占河谷、海岸（时代的“别处多是无人的荒野”，minHabitability 0.25、领土补齐窄）：门槛低一些
  const OWNED: Record<string, number> = { antiquity: 0.4, medieval: 0.6, industrial: 0.5, modern: 0.8, fantasy: 0.6, scifi: 0.8 };
  for (const era of Object.keys(OWNED)) {
    it(`${era}：国家不少于 6 个，能住人的地方大半有主`, () => {
      const w = wizardWorld(era, 1);
      const n = Object.keys(w.small.countries ?? {}).length;
      expect(n).toBeGreaterThanOrEqual(6);
      const minH = worldEra(w.small)!.unclaimed.minHabitability;
      let hab = 0;
      let owned = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        if (!w.causes.land[i] || w.derived.lake[i] === 1 || w.derived.habitability[i] < minH) continue;
        hab++;
        if (w.causes.country![i] >= 0) owned++;
      }
      expect(owned / hab, `${n} 国`).toBeGreaterThan(OWNED[era]);
    });
  }
});
