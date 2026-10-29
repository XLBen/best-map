import { z } from 'zod';
import { typeIdSchema } from '../type-id';
import { titleSchema } from './government';
import { HEX } from './terrain-class';

// 第二十四轮的三种内容：城市等级、地标类型、自定义点的类型（都放在 small.content，命令是 set_content）。
// 内置的总在世界里（像内置的地形类别）：small.content 里同 id 的一项换掉内置的那一份，别的 id 是新加的、排在后面

const tag = z.string().min(1).max(16);

// 城市等级：占本国人口的比例够 minShare（且人数够 minPop）的里 level 最大的（写了 perCountry 的每国有上限）；首都用写了 capital 的那一级
export const cityRankSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  // 图标：star（星）、double-ring（双圈）、circle（大圆）、dot（点）……界面按它画
  icon: typeIdSchema,
  color: HEX.optional(),
  description: z.string().max(200).optional(),
  // 首都用的一级
  capital: z.boolean().optional(),
  // 越大越重要（排序、缩小时先显示、先连大道）
  level: z.number().int().min(0).max(100),
  // 占本国人口的比例下限（0–1）与人数下限
  minShare: z.number().min(0).max(1).default(0),
  minPop: z.number().min(0).max(1e10).optional(),
  // 每国最多几座（第二十六轮）：这个国家的城市数 × perCountry（向下取整），按人口取前几座，别的降到够得上的下一级（省略时不限）
  perCountry: z.number().min(0).max(1).optional(),
  // 标注的字号倍数（1 是普通城市）
  label: z.number().min(0.3).max(4).default(1),
  // 大道连这一级（省略时：首都与 level 不小于 3 的连大道）
  major: z.boolean().optional(),
});
export type CityRank = z.output<typeof cityRankSchema>;

// 地标的自然检测器：名山（山脉里最高的峰）、火山、瀑布（河上落差大处）、峡谷（河切得深的地方）、绿洲（荒漠里的水）
export const LANDMARK_DETECTORS = ['peak', 'volcano', 'waterfall', 'canyon', 'oasis'] as const;
export type LandmarkDetector = (typeof LANDMARK_DETECTORS)[number];
// 人造地标放在哪：首都旁、城市旁（大城市、任何城市）、山里、海边、河边、荒漠、森林、国界上、远离城市的荒野、哪里都行
export const LANDMARK_PLACES = ['capital', 'big-city', 'city', 'mountain', 'coast', 'river', 'desert', 'forest', 'border', 'wild', 'any'] as const;
export type LandmarkPlace = (typeof LANDMARK_PLACES)[number];

export const landmarkTypeSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  category: z.enum(['natural', 'manmade']),
  // 图标：peak、volcano、waterfall、canyon、temple、wall……界面按它画
  icon: typeIdSchema,
  color: HEX.optional(),
  description: z.string().max(400).optional(),
  // 自然的：用哪个检测器
  detector: z.enum(LANDMARK_DETECTORS).optional(),
  // 人造的：只在这些文化组（国家的主流文化的组）、政体的类别里有（省略时不限）。第三十轮去掉了“只在哪些时代”：
  // 时代自己的地标在时代包里（packs/builtin-tree.ts），世界里有就能放
  cultureGroups: z.array(typeIdSchema).max(32).optional(),
  governments: z.array(tag).max(16).optional(),
  place: z.enum(LANDMARK_PLACES).default('any'),
  // 每个国家几个（per: country）或整个世界几个（per: world；自然的按每 5000 格陆地几个）
  per: z.enum(['country', 'world']).default('country'),
  count: z.number().min(0).max(100).default(1),
  // 每个国家有的可能（0–1）
  chance: z.number().min(0).max(1).default(1),
  // 名字的写法：{city} 最近的城市、{country} 国名的地名部分、{river} 河、{range} 山脉、{peak} 山峰、{lake} 湖、{place} 这一格的小地名、{culture} 文化；
  // 写法同政体的称号（按文化、文化组换说法）
  label: titleSchema,
  // 不自动放（只能自己加）
  manual: z.boolean().optional(),
});
export type LandmarkType = z.output<typeof landmarkTypeSchema>;

// 上传的小图：data: 地址（png、jpeg、webp、svg），不超过约 24 KB
const imageSchema = z
  .string()
  .max(32000)
  .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, '图片写成 data:image/…;base64, 的地址');

export const pointTypeSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  // 内置图标的名字（pin、star-outline、fort……），或上传的小图（image，有时界面用它）
  icon: typeIdSchema.optional(),
  image: imageSchema.optional(),
  color: HEX,
  description: z.string().max(400).optional(),
  // 当作城市：挂着的城市（没挂时这个点自己）在档案里算首都（陪都）、按这一级显示
  actsAsCity: z
    .object({ capital: z.boolean().optional(), rank: typeIdSchema.optional() })
    .strict()
    .optional(),
});
export type PointType = z.output<typeof pointTypeSchema>;
