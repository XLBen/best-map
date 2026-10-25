import { z } from 'zod';
import { contentItems } from '../content/registry';
import { CommandError } from '../errors';
import { DEFAULT_SPECIES, type Species } from '../species';
import { typeIdSchema } from '../type-id';
import type { SmallState, World } from '../world';
import { type CellInputs, type CellRule, cellRuleSchema, compileRule, ruleMatches } from './rules';

// 地形类别（第二十一轮）：平原、丘陵、高原、山地、山峰，每格一种，只是一层分类，不改高度。
// 第二十七轮起只管起伏：植被（森林、沙漠、沼泽……）是生态的事，格的档案写成“丘陵 · 温带阔叶林”。
// 默认由自动规则按高度、坡度算出（derived.terrainClassAuto），点格、笔刷可以改（causes.terrainClass，0 是自动）。
//
// 世界里有哪些类别：内置的 5 种总在（像内置中文风格一样，不用启用），small.content.terrainClass 里同 id 的一项换掉内置的那一种
// （改它的颜色、规则……），别的 id 是新加的类别，排在内置的后面（按启用的先后）。停用新加的类别时，画成它的格恢复自动。
// 编号：内置的按下面的先后是 1–5，新加的接着往后；0 是水面（derived）或自动（causes）。

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
  // 起伏的通行难度（平原为 1）：乘上生态的倍数是一格的通行难度（cellMovement），文化、国家往外长与道路按它
  movement: z.number().min(0.1).max(20).optional(),
  // 宜居度的倍数（第二十二轮，见 habitability.ts）：省略时内置的按 CLASS_HABITABILITY，别的为 1
  habitability: z.number().min(0).max(3).optional(),
});
export type TerrainClass = z.output<typeof terrainClassSchema>;

const cls = (id: string, name: string, color: string, terrain: string, priority: number, rules: CellRule[], extra: Partial<TerrainClass> = {}): TerrainClass => ({ id, name, color, terrain, priority, rules, ...extra });

// 内置的一套（第二十七轮起只管起伏：平原、丘陵、高原、山地、山峰，按高度、坡度算；森林、沙漠、沼泽、冻原、冰川……是生态，
// 不再是地形类别）。阈值按生成的世界标定：陆地的坡度中位数约 1.3 m/km、九成以下约 9；海拔四分之三以下约 900 m
export const BUILTIN_CLASSES: readonly TerrainClass[] = [
  cls('plains', '平原', '#c9d88f', 'plains', 0, [], { movement: 1, fallback: true, description: '低平的地方（别的几类都不是时）' }),
  cls('hills', '丘陵', '#b79a68', 'hills', 50, [{ slopeMin: 4.5 }, { elevMin: 700, slopeMin: 2.5 }], { movement: 1.5, ore: true, description: '起伏的低山：坡度 4.5 m/km 以上，或 700 m 以上、坡度 2.5 以上' }),
  cls('highlands', '高原', '#c8ad84', 'highlands', 65, [{ elevMin: 1100, slopeMax: 4 }], { movement: 1.3, ore: true, description: '高而平：1100 m 以上、坡度不到 4 m/km' }),
  cls('mountains', '山地', '#8e7d6c', 'mountains', 70, [{ elevMin: 1900 }, { elevMin: 1100, slopeMin: 7 }], { movement: 2.5, ore: true, peaks: true, description: '1900 m 以上，或 1100 m 以上、坡度 7 m/km 以上' }),
  cls('peaks', '山峰', '#5f5550', 'mountains', 80, [{ elevMin: 3000, slopeMin: 8 }, { elevMin: 4200, slopeMin: 3 }], { movement: 4, ore: true, peaks: true, description: '最高最陡的山：3000 m 以上、坡度 8 以上，或 4200 m 以上' }),
];
// 第二十七轮以前的内置类别（植被的那几种，现在是生态）：重放旧命令里画成它们的格恢复自动
export const RETIRED_CLASSES: ReadonlySet<string> = new Set(['grasslands', 'steppe', 'forest', 'woods', 'jungle', 'marsh', 'desert', 'tundra', 'glacier']);
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

// 地形的说法（第二十七轮：地形类别只管起伏，植被看生态）：“丘陵 · 温带阔叶林”；只有一样时只写它，水面为 null
export function terrainLabel(world: Pick<World, 'small' | 'derived' | 'causes'>, cell: number): string | null {
  const { small, derived: d } = world;
  if (!world.causes.land[cell] || d.lake[cell] === 1) return null;
  const tc = classAt(small, d.terrainClass[cell]);
  const sp = d.dominant[cell] >= 0 ? small.species[d.dominant[cell]] : undefined;
  const parts = [tc?.name, sp ? sp.name || sp.id : undefined].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : null;
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

// ---------- 通行难度（第二十七轮） ----------
// 一格的通行难度 = 地形类别（起伏）的 movement × 生态（植被）的倍数。平原上的草原为 1；
// 植被的倍数：生态写了 movement 就用它，内置的生态按 BIOME_MOVEMENT，别的按生态的地形（TERRAIN_MOVEMENT）

export const BIOME_MOVEMENT: Readonly<Record<string, number>> = {
  ice: 3,
  tundra: 1.3,
  taiga: 1.4,
  temperate_forest: 1.3,
  steppe: 1,
  shrubland: 1.25,
  subtropical_forest: 1.4,
  savanna: 1,
  dry_forest: 1.25,
  monsoon_forest: 1.8,
  rainforest: 2,
  wetland: 2,
  desert: 1.5,
};
export const TERRAIN_MOVEMENT: Readonly<Record<string, number>> = {
  plains: 1,
  steppe: 1,
  savanna: 1,
  hills: 1.25,
  forest: 1.35,
  jungle: 2,
  marsh: 2,
  desert: 1.5,
  arctic: 1.3,
};
const BUILTIN_TERRAIN = new Map(DEFAULT_SPECIES.map((sp) => [sp.id, sp.terrain]));

// 一种生态的通行倍数
export function biomeMovement(sp: Pick<Species, 'id' | 'terrain' | 'movement'>): number {
  if (sp.movement !== undefined) return sp.movement;
  const b = BIOME_MOVEMENT[sp.id];
  if (b !== undefined && BUILTIN_TERRAIN.get(sp.id) === sp.terrain) return b;
  return TERRAIN_MOVEMENT[sp.terrain] ?? 1;
}

// 每格的通行难度（干的陆地；别的格为 1）。cls：生效的地形类别
export function cellMovement(small: Pick<SmallState, 'content' | 'species'>, x: Pick<CellInputs, 'n' | 'dry' | 'biome'>, cls: Uint8Array): Float32Array {
  const move = [1, ...worldTerrainClasses(small).map((c) => c.movement ?? 1)];
  const bio = small.species.map(biomeMovement);
  const out = new Float32Array(x.n).fill(1);
  for (let i = 0; i < x.n; i++) {
    if (!x.dry[i]) continue;
    const b = x.biome[i];
    out[i] = (move[cls[i]] ?? 1) * (b >= 0 ? (bio[b] ?? 1) : 1);
  }
  return out;
}

// 最便宜的通行难度（A* 的估计用）：最便宜的类别 × 最便宜的生态（不到 1 时）
export function minMovement(small: Pick<SmallState, 'content' | 'species'>): number {
  let m = 1;
  for (const c of worldTerrainClasses(small)) m = Math.min(m, c.movement ?? 1);
  let b = 1;
  for (const sp of small.species) b = Math.min(b, biomeMovement(sp));
  return m * b;
}

// ---------- 导出到游戏的地形（第二十七轮） ----------
// terrain.bmp、provinces_summary.csv 的 terrain 与 terrain_classes.csv 都按这一个函数：
// 起伏的类别写了地形（丘陵、高原、山地……）就是它；平原（或类别的地形是 plains、没写）按生态的地形（forest、desert、steppe……）；
// 没有类别（relief 为 undefined）时按海拔、坡度用内置的阈值判起伏
export function paradoxTerrain(relief: Pick<TerrainClass, 'terrain'> | undefined, biomeTerrain: string | undefined, elev: number, slope: number): string {
  const own = relief ? relief.terrain : reliefTerrain(elev, slope);
  if (own && own !== 'plains') return own;
  return biomeTerrain || 'plains';
}

// 内置阈值下的起伏（平原为 undefined）：与 BUILTIN_CLASSES 的规则一致
function reliefTerrain(elev: number, slope: number): string | undefined {
  if (elev >= 1900 || (elev >= 1100 && slope >= 7)) return 'mountains';
  if (elev >= 1100 && slope <= 4) return 'highlands';
  if (slope >= 4.5 || (elev >= 700 && slope >= 2.5)) return 'hills';
  return undefined;
}

// 每格导出的地形（干的陆地；湖面 'lake'、海 'ocean'）。没有类别的陆地格按兜底的那一类
export function cellParadoxTerrain(world: Pick<World, 'mesh' | 'causes' | 'derived' | 'small'>): string[] {
  const { mesh, causes, derived: d, small } = world;
  const list = worldTerrainClasses(small);
  const fallback = list.find((c) => c.fallback);
  const out = new Array<string>(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) out[i] = 'ocean';
    else if (d.lake[i] === 1) out[i] = 'lake';
    else {
      const sp = d.dominant[i] >= 0 ? small.species[d.dominant[i]] : undefined;
      const code = d.terrainClass?.[i] ?? 0;
      out[i] = paradoxTerrain(code ? list[code - 1] : fallback, sp?.terrain, d.elevation[i], d.slope[i]);
    }
  }
  return out;
}
