import { z } from 'zod';
import { contentItems } from '../content/registry';
import { CommandError } from '../errors';
import { typeIdSchema } from '../type-id';
import type { SmallState } from '../world';
import { type CellInputs, type CellRule, cellRuleSchema, compileRule, ruleMatches } from './rules';

// 地形类别（第二十一轮）：平原、丘陵、山地、山峰、森林、沼泽、沙漠……每格一种，只是一层分类，不改高度。
// 默认由自动规则按高度、坡度、生态算出（derived.terrainClassAuto），点格、笔刷可以改（causes.terrainClass，0 是自动）。
//
// 世界里有哪些类别：内置的 14 种总在（像内置中文风格一样，不用启用），small.content.terrainClass 里同 id 的一项换掉内置的那一种
// （改它的颜色、规则……），别的 id 是新加的类别，排在内置的后面（按启用的先后）。停用新加的类别时，画成它的格恢复自动。
// 编号：内置的按下面的先后是 1–14，新加的接着往后；0 是水面（derived）或自动（causes）。

export const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色写成 #rrggbb');

export const terrainClassSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  // 图层上的颜色
  color: HEX,
  // 导出 terrain_class.bmp 的颜色（省略时同 color）
  exportColor: HEX.optional(),
  // 导出给游戏时对应的地形名（EU4 的 terrain：plains、hills、mountains……）
  terrain: z.string().max(30).optional(),
  description: z.string().max(200).optional(),
  // 几种类别的规则都满足时，大的优先（一样大时排在前面的优先）
  priority: z.number().min(-1000).max(1000).default(0),
  // 自动规则：满足任何一条就是这一类；空的不自动出现，只能画上去
  rules: z.array(cellRuleSchema).max(16).default([]),
  // 哪一类的规则都不满足的陆地格用它（有几种写了时用排在前面的）
  fallback: z.boolean().optional(),
  // 档案里写有没有矿（没有资源时写“无矿”）
  ore: z.boolean().optional(),
  // 这一类里比四周都高的格算山峰
  peaks: z.boolean().optional(),
  // 通行难度（平原为 1；以后的道路按它）
  movement: z.number().min(0.1).max(20).optional(),
  // 宜居度的倍数（第二十二轮，见 habitability.ts）：省略时内置的按 CLASS_HABITABILITY，别的为 1
  habitability: z.number().min(0).max(3).optional(),
});
export type TerrainClass = z.output<typeof terrainClassSchema>;

const cls = (id: string, name: string, color: string, terrain: string, priority: number, rules: CellRule[], extra: Partial<TerrainClass> = {}): TerrainClass => ({ id, name, color, terrain, priority, rules, ...extra });

// 内置的一套（仿 EU4 的分法）。阈值按生成的世界标定：陆地的坡度中位数约 1.3 m/km、九成以下约 9；海拔四分之三以下约 900 m
export const BUILTIN_CLASSES: readonly TerrainClass[] = [
  cls('plains', '平原', '#c9d88f', 'plains', 17, [{ terrain: ['steppe', 'savanna', 'forest'], slopeMax: 1.5, elevMax: 500, moistMin: 0.4 }], { movement: 1, fallback: true }),
  cls('grasslands', '草原', '#a9c86e', 'grasslands', 15, [{ terrain: ['steppe', 'savanna'] }], { movement: 1 }),
  cls('steppe', '干草原', '#dccb8c', 'steppe', 20, [{ terrain: ['steppe', 'savanna', 'hills'], moistMax: 0.35 }], { movement: 1.1 }),
  cls('hills', '丘陵', '#b79a68', 'hills', 50, [{ slopeMin: 4.5 }, { elevMin: 700, slopeMin: 2.5 }], { movement: 1.5, ore: true }),
  cls('highlands', '高原', '#c8ad84', 'highlands', 65, [{ elevMin: 1100, slopeMax: 4 }], { movement: 1.3, ore: true }),
  cls('mountains', '山地', '#8e7d6c', 'mountains', 70, [{ elevMin: 1900 }, { elevMin: 1100, slopeMin: 7 }], { movement: 2.5, ore: true, peaks: true }),
  cls('peaks', '山峰', '#5f5550', 'mountains', 80, [{ elevMin: 3000, slopeMin: 8 }, { elevMin: 4200, slopeMin: 3 }], { movement: 4, ore: true, peaks: true }),
  cls('forest', '森林', '#3f7a46', 'forest', 30, [{ terrain: ['forest'], moistMin: 0.8 }], { movement: 1.5 }),
  cls('woods', '林地', '#80a65b', 'woods', 25, [{ terrain: ['forest'] }, { biomes: ['shrubland'] }], { movement: 1.25 }),
  cls('jungle', '丛林', '#24693b', 'jungle', 35, [{ terrain: ['jungle'] }], { movement: 2 }),
  cls('marsh', '沼泽', '#5f9584', 'marsh', 60, [{ terrain: ['marsh'] }], { movement: 2 }),
  cls('desert', '沙漠', '#ecd9a0', 'desert', 45, [{ terrain: ['desert'] }], { movement: 1.5 }),
  cls('tundra', '冻原', '#a9b4a1', 'arctic', 28, [{ terrain: ['arctic'] }], { movement: 1.3 }),
  cls('glacier', '冰川', '#eef4f8', 'glacier', 90, [{ biomes: ['ice'] }, { tempMax: -18 }], { movement: 3 }),
];
const BUILTIN_IDS = new Set(BUILTIN_CLASSES.map((c) => c.id));
export const isBuiltinClass = (id: string): boolean => BUILTIN_IDS.has(id);

type ClassSmall = Pick<Partial<SmallState>, 'content'>;

// 世界里的地形类别（编号 = 下标 + 1）。没改过时是内置的那一份（同一个数组）
const lists = new WeakMap<object, TerrainClass[]>();
export function worldTerrainClasses(small: ClassSmall): readonly TerrainClass[] {
  const own = small.content?.terrainClass as Record<string, TerrainClass> | undefined;
  if (!own) return BUILTIN_CLASSES;
  let list = lists.get(own);
  if (!list) {
    list = BUILTIN_CLASSES.map((b) => own[b.id] ?? b);
    for (const [id, c] of Object.entries(own)) if (!BUILTIN_IDS.has(id)) list.push(c);
    lists.set(own, list);
  }
  return list;
}

// 类别的编号（没有这一类时为 0）与按编号取类别
export function classCode(small: ClassSmall, id: string): number {
  return worldTerrainClasses(small).findIndex((c) => c.id === id) + 1;
}
export function classAt(small: ClassSmall, code: number): TerrainClass | undefined {
  return code > 0 ? worldTerrainClasses(small)[code - 1] : undefined;
}

// 自动分类：每格取规则满足的类别里优先级最大的（一样大时排在前面的），都不满足时取写了“兜底”的那一类；水面为 0
export function classifyTerrain(x: CellInputs, list: readonly TerrainClass[], biomes: readonly { id: string; terrain: string }[]): Uint8Array {
  const order = list
    .map((c, k) => {
      const rules = (c.rules ?? []).map((r) => compileRule(r, biomes));
      // 各条规则的生态合在一起（有一条不限生态时为 null）：先按它筛掉
      let any: Uint8Array | null = new Uint8Array(biomes.length);
      for (const r of rules) {
        if (!r.biome) {
          any = null;
          break;
        }
        for (let b = 0; b < r.biome.length; b++) if (r.biome[b]) any[b] = 1;
      }
      return { code: k + 1, p: c.priority ?? 0, rules, any };
    })
    .filter((c) => c.rules.length);
  order.sort((a, b) => b.p - a.p || a.code - b.code);
  const fallback = list.findIndex((c) => c.fallback) + 1;
  const out = new Uint8Array(x.n);
  for (let i = 0; i < x.n; i++) {
    if (!x.dry[i]) continue;
    out[i] = fallback;
    const bi = x.biome[i];
    for (const c of order) {
      if (c.any && (bi < 0 || !c.any[bi])) continue;
      let hit = false;
      for (const r of c.rules) {
        if (ruleMatches(r, x, i)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        out[i] = c.code;
        break;
      }
    }
  }
  return out;
}

// 生效的类别：画过的格用画的（类别还在时），别的用自动的；水面为 0
export function effectiveClasses(auto: Uint8Array, override: Uint8Array | undefined, dry: Uint8Array, count: number): Uint8Array {
  if (!override) return auto;
  const out = auto.slice();
  for (let i = 0; i < out.length; i++) {
    const v = override[i];
    if (v && dry[i] && v <= count) out[i] = v;
  }
  return out;
}

// 启用一项之前的检查：地形类别的规则里不能按地形类别（会绕成圈）
export function checkTerrainClass(c: TerrainClass): void {
  if ((c.rules ?? []).some((r) => r.classes?.length)) throw new CommandError('地形类别的规则里不能按地形类别');
}

// 改了世界里的类别之后（停用了一种新加的），画过的格按 id 换成新的编号；没有了的恢复自动
export function remapCodes(arr: Uint8Array | undefined, before: readonly string[], after: readonly string[], keep: (v: number) => boolean = () => false): void {
  if (!arr) return;
  const map = new Uint8Array(256);
  for (let v = 1; v < 256; v++) {
    if (keep(v)) map[v] = v;
    else {
      const id = before[v - 1];
      map[v] = id === undefined ? 0 : after.indexOf(id) + 1;
    }
  }
  for (let i = 0; i < arr.length; i++) if (arr[i]) arr[i] = map[arr[i]];
}

export const terrainClassItems = (small: ClassSmall): Record<string, TerrainClass> => contentItems<TerrainClass>(small, 'terrainClass');
