import { type CityRank, type LandmarkType, type PointType, cityRankSchema, landmarkTypeSchema, pointTypeSchema } from '../../human/settle-types';
import landmarks from './landmarks.json';
import points from './points.json';
import ranks from './ranks.json';

// 内置的城市等级、地标类型、自定义点的类型（第二十四轮）：格式见 human/settle-types.ts 与 docs/开发说明.md 的“城市、道路、地标、自定义点”。
// 都总在世界里（不用启用）；加一种：在对应的 JSON 里加一项

export const BUILTIN_RANKS: readonly CityRank[] = ranks.map((r) => cityRankSchema.parse(r));
export const BUILTIN_LANDMARK_TYPES: readonly LandmarkType[] = landmarks.map((t) => landmarkTypeSchema.parse(t));
export const BUILTIN_POINT_TYPES: readonly PointType[] = points.map((t) => pointTypeSchema.parse(t));
