import { z } from 'zod';
import { typeIdSchema } from './type-id';
import type { SmallState } from './world';

// 省份划分的规则（第七十八轮）：以前每个世界自己记在 small.provinceRules、在“省份 ⋯”里调，
// 现在是资源库里的一种内容“省份划分”（provinceRules，包里的段 provinceRules，放在 small.content；内置的一份在每个库的“基础”里，新世界默认带上）。
// 世界里只有一份（maxInWorld 1）；没有时按 DEFAULT_PROVINCE_RULES（与内置的一份相同）。
// 划分用的种子不是规则，记在世界里（small.provinceSeed，“换一种划分”加一）。
//
// 以前的写法 → 现在：
//   size（小 · 中 · 大 = 20 · 40 · 80 格）与 sizeCells（第二十七轮的滑块）→ size（格数）。以前写 sizeCells 时不看 size，所以就是 sizeCells ?? 那三档；
//   varied、wasteland、lakeMode、seaByDistance、riverCost、ridgeCost 照旧；seed → small.provinceSeed。
// 默认值与以前的默认逐值相同（中 = 40 格、沿河 4、沿山脊 2……），用默认的规则划出来的省份与以前一样。

export const provinceRulesSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  description: z.string().max(200).optional(),
  // 目标大小：一个陆地省大约几格（按 4 万格的一块地区标定；格数不同时等比缩放，整个星球按面积，见 provinces.ts 的 provinceTargets）
  size: z.number().min(4).max(400),
  // 按地形调整大小：平原、河谷、海岸省份小，山地、荒漠大
  varied: z.boolean(),
  // 冰原、深漠、高山合成大片无人区
  wasteland: z.boolean(),
  // 湖：单独成省（separate）还是并进旁边的陆地省（merge）。海永远单独
  lakeMode: z.enum(['separate', 'merge']),
  // 近海海域小、远洋海域大
  seaByDistance: z.boolean(),
  // 跨河、跨山脊的代价（越大省界越贴着河、山脊）
  riverCost: z.number().min(0).max(20),
  ridgeCost: z.number().min(0).max(20),
});
export type ProvinceRules = z.output<typeof provinceRulesSchema>;
export type LakeMode = ProvinceRules['lakeMode'];

// 内置的一份（core/packs/builtin-tree.ts 放进每个库的“基础”）；世界里没有省份划分时也按它
export const DEFAULT_PROVINCE_RULES: ProvinceRules = {
  id: 'standard',
  name: '默认',
  description: '中等大小的省，按地形大小不一；冰原、深漠、高山划成无人区；湖单独成省；近海的海省小、远洋的大',
  size: 40,
  varied: true,
  wasteland: true,
  lakeMode: 'separate',
  seaByDistance: true,
  riverCost: 4,
  ridgeCost: 2,
};

// 划分的种子：没有记过时 1（与以前的默认相同）
export const DEFAULT_PROVINCE_SEED = 1;

type RulesSmall = Pick<Partial<SmallState>, 'content'>;

// 世界的省份划分：世界里的那一份（只有一份），没有时默认的
export function worldProvinceRules(small: RulesSmall): ProvinceRules {
  const own = small.content?.provinceRules;
  if (own) for (const k in own) return own[k] as ProvinceRules;
  return DEFAULT_PROVINCE_RULES;
}

export const provinceSeed = (small: Pick<SmallState, 'provinceSeed'>): number => small.provinceSeed ?? DEFAULT_PROVINCE_SEED;
