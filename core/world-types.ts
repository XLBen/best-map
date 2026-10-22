// 生成器的世界类型。单独一个不引用任何模块的文件：generate.ts 的 worldgenSchema 引用星球形态的 schema
// （planet-form.ts），星球形态又要列出这些类型；两边都放在 generate.ts 里会形成循环引用。
// generate.ts 照旧导出它们，原来的 import 都不用改
export const WORLD_TYPES = ['archipelago', 'continent', 'continents', 'fragmented', 'inland_sea', 'ocean'] as const;
export type WorldType = (typeof WORLD_TYPES)[number];
