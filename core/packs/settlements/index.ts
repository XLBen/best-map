import { type CityRank, type LandmarkType, type PointType, cityRankSchema, landmarkTypeSchema, pointTypeSchema } from '../../human/settle-types';
import landmarks from './landmarks.json';
import points from './points.json';
import ranks from './ranks.json';

// 内置的城市等级、地标类型、自定义点的类型（第二十四轮）：格式见 human/settle-types.ts 与 docs/开发说明.md 的“城市、道路、地标、自定义点”。
// 第三十轮起是普通内容：在“通用 ▸ 基础”里，新建时默认加进世界。地标写了 eras 的（神庙、城堡、太空港……）放进那几个时代的包，
// 不放进基础（读进来的不带 eras，LANDMARK_ERAS 记着）。加一种：在对应的 JSON 里加一项

export const BUILTIN_RANKS: readonly CityRank[] = ranks.map((r) => cityRankSchema.parse(r));
export const BUILTIN_LANDMARK_TYPES: readonly LandmarkType[] = landmarks.map((t) => landmarkTypeSchema.parse(t));
// 时代自己的地标（id → 放进哪几个时代的包）
export const LANDMARK_ERAS: ReadonlyMap<string, readonly string[]> = new Map((landmarks as { id: string; eras?: string[] }[]).filter((t) => t.eras?.length).map((t) => [t.id, t.eras!]));
export const BUILTIN_POINT_TYPES: readonly PointType[] = points.map((t) => pointTypeSchema.parse(t));
