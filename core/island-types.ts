import { z } from 'zod';
// 只在 z.lazy 里读 scriptsSchema：script.ts 经 world.ts 又引用别的模块，顶层直接读会碰上“初始化之前不能访问”
import { scriptsSchema } from './script';
import { typeIdSchema } from './type-id';
import type { SmallState, World } from './world';

// 岛的种类（第十四轮）：放岛、画岛链时选一种。内置四种（大陆岛、低平岛、珊瑚岛、小礁），用户可以新建自己的，
// 两者用同一套说法：形状、颜色、岩石软硬、高低、归陆地省还是海省、起名的模板。
//   · 形状、高低、岩石只在放岛的那一刻起作用（改了以后只影响以后放的岛）；
//   · 颜色、归哪种省、起名按每格记下的种类（causes.islandType）随时查，改了马上用到已经放的岛上。
// 每格记的是种类的编号：0 不是放的岛；内置的是 1–4（BUILTIN_ISLAND_TYPES 的下标 + 1），
// 自己的是 BUILTIN_COUNT + 1 + 在 small.islandTypes 里的下标。删掉一种时，这种岛变成大陆岛、后面的编号往前挪（见 removeIslandCode）。
// 环礁潟湖的海格另加 LAGOON_BIT：潟湖就是潟湖（海底挖浅、四周的小块海不并回陆地），以后改了、删了这种岛也不变
export const LAGOON_BIT = 0x80;
export const ISLAND_CODE_MASK = 0x7f;

export const ISLAND_SHAPES = ['round', 'long', 'rugged', 'ring', 'cell'] as const;
export type IslandShape = (typeof ISLAND_SHAPES)[number];
export const ISLAND_SHAPE_INFO: Record<IslandShape, { name: string; hint: string }> = {
  round: { name: '圆', hint: '接近圆形' },
  long: { name: '长条', hint: '拉得长长的' },
  rugged: { name: '不规则', hint: '有湾有岬，形状不规则' },
  ring: { name: '环礁', hint: '一圈陆地，中间是浅浅的潟湖' },
  cell: { name: '一格', hint: '只占一格，画出来约半格大，不看大小' },
};

// 高低：平（低矮平坦）、起伏（有丘陵）、高（中间隆起成山）。环礁、一格的岛总是平的
export const ISLAND_HEIGHTS = ['flat', 'hilly', 'high'] as const;
export type IslandHeight = (typeof ISLAND_HEIGHTS)[number];
export const ISLAND_HEIGHT_INFO: Record<IslandHeight, { name: string; hint: string }> = {
  flat: { name: '平', hint: '低矮平坦' },
  hilly: { name: '起伏', hint: '有丘陵' },
  high: { name: '高', hint: '中间隆起成山' },
};

// 颜色：和周围一样（不写）、两种现成的样子（白沙：珊瑚砂的白沙滩、四周一圈浪花、潟湖青绿；沙洲：低处是沙和沼泽），或自己选的颜色
export const ISLAND_LOOKS = ['coral', 'marsh'] as const;
export type IslandLook = (typeof ISLAND_LOOKS)[number];
export const ISLAND_LOOK_INFO: Record<IslandLook, { name: string; hint: string }> = {
  coral: { name: '白沙', hint: '珊瑚砂的白沙，岸边一圈浪花' },
  marsh: { name: '沙洲', hint: '低处是浅色的沙和青绿的沼泽' },
};

// 岩石软硬（可蚀性）：生成的地形在 0.4–1.8；软的蚀得低平，硬的留得高
export const ISLAND_ROCK_RANGE: readonly [number, number] = [0.3, 5];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #rrggbb');

const BUILTIN_IDS = ['continental', 'low', 'atoll', 'reef'] as const;
export type BuiltinIslandId = (typeof BUILTIN_IDS)[number];

export const islandTypeSchema = z.object({
  id: typeIdSchema.refine((id) => !(BUILTIN_IDS as readonly string[]).includes(id), '这个 id 是内置的岛用的，换一个'),
  name: z.string().min(1).max(12),
  shape: z.enum(ISLAND_SHAPES).default('rugged'),
  height: z.enum(ISLAND_HEIGHTS).default('hilly'),
  // 不写：和周围的地一样
  color: z.union([hexColor, z.enum(ISLAND_LOOKS)]).optional(),
  // 不写：和周围的地一样
  rock: z.number().min(ISLAND_ROCK_RANGE[0]).max(ISLAND_ROCK_RANGE[1]).optional(),
  // 归陆地省还是海省：海省的像小礁，算进旁边的海省
  province: z.enum(['land', 'sea']).default('land'),
  // 起名模板（{词表} 用文字包的词表，{__species} 是种类的名字）：岛的大半是这一种时按它起名
  names: z
    .array(z.object({ p: z.string().min(1).max(40), w: z.number().positive().optional() }))
    .min(1)
    .max(20)
    .optional(),
  // 脚本（第十五轮，见 island-scripts.ts）：放在哪里（placement）、岛的样子（shape）。和形状、高低一样只在放岛的那一刻起作用
  scripts: z
    .lazy(() => scriptsSchema)
    .refine((s) => Object.entries(s).every(([k, v]) => k === 'placement' || k === 'shape' || v === undefined), '岛的种类只能有“放在哪里”和“岛的样子”两种脚本')
    .optional(),
});
export type IslandType = z.output<typeof islandTypeSchema>;
export type IslandTypeInput = z.input<typeof islandTypeSchema>;

// 内置的四种（与自己的用同一套说法）。编号 = 下标 + 1，不能改顺序
export const BUILTIN_ISLAND_TYPES: readonly (IslandType & { id: BuiltinIslandId; hint: string })[] = [
  { id: 'continental', name: '大陆岛', hint: '形状不规则，有丘陵', shape: 'rugged', height: 'hilly', province: 'land' },
  { id: 'low', name: '低平岛', hint: '平坦低矮，多沙洲和沼泽', shape: 'long', height: 'flat', color: 'marsh', rock: 3.2, province: 'land' },
  { id: 'atoll', name: '珊瑚岛', hint: '环形的白沙岛，中间是青绿色的浅潟湖', shape: 'ring', height: 'flat', color: 'coral', rock: 4.8, province: 'land' },
  { id: 'reef', name: '小礁', hint: '只占一格的白沙小岛，四周一圈浪花，算进旁边的海省', shape: 'cell', height: 'flat', color: 'coral', rock: 4.3, province: 'sea' },
];
export const BUILTIN_COUNT = BUILTIN_ISLAND_TYPES.length;
export const DEFAULT_ISLAND_TYPE: BuiltinIslandId = 'continental';
export const MAX_ISLAND_TYPES = 64;

// 界面的选项里记的种类还在不在（被删掉了、换了世界时按大陆岛）
export function liveIslandKind(w: Pick<World, 'small'> | null, id: string): string {
  return w && islandTypeById(w.small, id) ? id : DEFAULT_ISLAND_TYPE;
}

export const isBuiltinIsland = (id: string): id is BuiltinIslandId => (BUILTIN_IDS as readonly string[]).includes(id);

// 世界里自己的岛的种类
export const islandTypesOf = (small: Pick<SmallState, 'islandTypes'>): readonly IslandType[] => small.islandTypes ?? [];

// 全部种类，按编号排（编号 = 下标 + 1）
export function allIslandTypes(small: Pick<SmallState, 'islandTypes'>): readonly IslandType[] {
  const own = islandTypesOf(small);
  return own.length ? [...BUILTIN_ISLAND_TYPES, ...own] : BUILTIN_ISLAND_TYPES;
}

export function islandTypeById(small: Pick<SmallState, 'islandTypes'>, id: string): IslandType | undefined {
  return BUILTIN_ISLAND_TYPES.find((t) => t.id === id) ?? islandTypesOf(small).find((t) => t.id === id);
}

// 种类的编号（找不到为 0）
export function islandCode(small: Pick<SmallState, 'islandTypes'>, id: string): number {
  const b = BUILTIN_IDS.indexOf(id as BuiltinIslandId);
  if (b >= 0) return b + 1;
  const k = islandTypesOf(small).findIndex((t) => t.id === id);
  return k >= 0 ? BUILTIN_COUNT + 1 + k : 0;
}

export function islandTypeOfCode(small: Pick<SmallState, 'islandTypes'>, code: number): IslandType | undefined {
  if (code <= 0) return undefined;
  if (code <= BUILTIN_COUNT) return BUILTIN_ISLAND_TYPES[code - 1];
  return islandTypesOf(small)[code - BUILTIN_COUNT - 1];
}

// 按编号查的表（下标是编号，0 是“不是放的岛”）：f(种类) 为真的编号为 1
export function codeFlags(small: Pick<SmallState, 'islandTypes'>, f: (t: IslandType) => boolean): Uint8Array {
  const all = allIslandTypes(small);
  const out = new Uint8Array(256);
  all.forEach((t, k) => {
    if (f(t)) out[k + 1] = 1;
  });
  return out;
}

// 环礁形状的编号（一格大的环礁在格里画潟湖，见 colors.ts 的 lithLayer）
export const ringCodes = (small: Pick<SmallState, 'islandTypes'>) => codeFlags(small, (t) => t.shape === 'ring');
// 归海省的编号（小礁一类）
export const seaCodes = (small: Pick<SmallState, 'islandTypes'>) => codeFlags(small, (t) => t.province === 'sea');

// 省份按格分陆海（第十四轮）：陆地格里归海省的岛（小礁一类）算海。省份的自动划分、修补、划省、合并、省界都按它
export function provinceLand(world: Pick<World, 'causes' | 'small'>): Uint8Array {
  const { land, islandType } = world.causes;
  const sea = seaCodes(world.small);
  const out = new Uint8Array(land.length);
  for (let i = 0; i < land.length; i++) out[i] = land[i] === 1 && !sea[islandType[i] & ISLAND_CODE_MASK] ? 1 : 0;
  return out;
}

// 删掉自定义的第 k 种（编号 BUILTIN_COUNT + 1 + k）：这种岛变成大陆岛，后面的编号往前挪一个
export function removeIslandCode(arr: Uint8Array, k: number): void {
  const gone = BUILTIN_COUNT + 1 + k;
  const fallback = BUILTIN_IDS.indexOf(DEFAULT_ISLAND_TYPE) + 1;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i] & ISLAND_CODE_MASK;
    const bit = arr[i] & LAGOON_BIT;
    if (c === gone) arr[i] = fallback | bit;
    else if (c > gone) arr[i] = (c - 1) | bit;
  }
}

// 改一种要从哪一层重算：只改颜色只重画；只改名字、起名模板只重新起名；改了归哪种省要整理省份（命令里做）；
// 形状、高低、岩石、脚本只影响以后放的岛（什么都不重算）
export function islandTypeDirty(before: IslandType | undefined, after: IslandType): 'none' | 'names' {
  if (!before) return 'none';
  return JSON.stringify([before.name, before.names ?? null]) === JSON.stringify([after.name, after.names ?? null]) ? 'none' : 'names';
}

// 颜色：自己选的颜色（#rrggbb）为 RGB，别的为 null
export function islandTint(t: IslandType | undefined): [number, number, number] | null {
  const c = t?.color;
  if (!c || !c.startsWith('#')) return null;
  const v = parseInt(c.slice(1), 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
}

// ---------- 画成陆地的像素归哪个陆地省（第十四轮） ----------
// 海边格以下的海岸细节会让一些陆地像素落在海格（湖格）里，它们的省份按附近的陆地格算。附近一圈都找不到陆地格时，
// 以前留在海省里；现在按这张表：每个水面格（海、湖）与归海省的岛（小礁）离它最近的“陆地省的格”（归陆地省的陆地、不是湖面），
// 沿网格一圈圈往外找（同一圈里有几个时取格心离得最近的，一样近取编号小的）。陆地省的格是它自己；没有陆地时为 −1。
// 屏幕（着色器的 provCell）、悬停与选省（display.ts 的 provinceCell）、导出（subcell.ts 的 rasterizeWorld）都用它
// 缓存按内容认（引擎在同一个线程里就地改数组时也不会拿到旧表）：只和陆地、岛的种类、湖面、哪几种归海省有关，
// 和高程无关（堆山、河床改了高程不必重算）
const landCellCache = new WeakMap<object, { key: string; value: Int32Array }[]>();
function hashBytes(h: number, a: Uint8Array): number {
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619);
  return h >>> 0;
}
export function landProvinceCells(world: Pick<World, 'mesh' | 'causes' | 'small' | 'derived'>): Int32Array {
  const { mesh, causes, derived } = world;
  const sea = seaCodes(world.small);
  let sig = '';
  for (let k = 1; k < 128; k++) if (sea[k]) sig += `${k},`;
  let h = hashBytes(2166136261, causes.land);
  h = hashBytes(h, causes.islandType);
  h = hashBytes(h, derived.lake);
  const key = `${h}|${sig}`;
  let list = landCellCache.get(mesh);
  if (!list) landCellCache.set(mesh, (list = []));
  const hit = list.find((e) => e.key === key);
  if (hit) return hit.value;
  const n = mesh.n;
  const pland = provinceLand(world);
  const lake = derived.lake;
  const owner = new Int32Array(n).fill(-1);
  // 一圈一圈的格放在一个数组里：[from, to) 是这一圈
  const ring = new Int32Array(n);
  let to = 0;
  for (let i = 0; i < n; i++) {
    if (pland[i] && lake[i] !== 1) {
      owner[i] = i;
      ring[to++] = i;
    }
  }
  // 格心的位置（整个星球按球面上的三维位置，一块地区按平面）
  const dim = mesh.kind === 'sphere' ? 3 : 2;
  const pos = new Float64Array(n * dim);
  if (mesh.kind === 'sphere') pos.set(mesh.p.subarray(0, n * 3));
  else
    for (let i = 0; i < n; i++) {
      pos[2 * i] = mesh.x[i];
      pos[2 * i + 1] = mesh.y[i];
    }
  const { off, adj } = mesh;
  const cand = new Int32Array(n).fill(-1);
  const bd = new Float64Array(n);
  let from = 0;
  while (from < to) {
    const end = to;
    for (let q = from; q < end; q++) {
      const c = ring[q];
      const o = owner[c];
      const ob = o * dim;
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (owner[j] >= 0) continue;
        const jb = j * dim;
        const dx = pos[jb] - pos[ob];
        const dy = pos[jb + 1] - pos[ob + 1];
        const dz = dim === 3 ? pos[jb + 2] - pos[ob + 2] : 0;
        const d = dx * dx + dy * dy + dz * dz;
        if (cand[j] < 0) {
          cand[j] = o;
          bd[j] = d;
          ring[to++] = j;
        } else if (d < bd[j] || (d === bd[j] && o < cand[j])) {
          cand[j] = o;
          bd[j] = d;
        }
      }
    }
    for (let q = end; q < to; q++) owner[ring[q]] = cand[ring[q]];
    from = end;
  }
  list.unshift({ key, value: owner });
  list.length = Math.min(list.length, 3);
  return owner;
}

// 有没有岛的脚本（放在哪里、岛的样子）。有时放岛要在 Worker 里按脚本算（见 island-scripts.ts），主线程只画轮廓
export function hasIslandScripts(t: Pick<IslandType, 'scripts'> | undefined): boolean {
  return !!(t?.scripts?.placement?.src.trim() || t?.scripts?.shape?.src.trim());
}
