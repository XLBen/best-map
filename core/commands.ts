import { z } from 'zod';
import { WORLD_TYPE_INFO, type Worldgen, worldgenSchema } from './generate';
import { checkForm, sameForm } from './planet-form';
import { PLANET_TYPES } from './presets';
import { packProblems, wordPackSchema } from './names';
import {
  PROVINCE_KIND_INFO,
  type ProvinceFix,
  type ProvinceKind,
  applyProvinceFix,
  classOfKind,
  generateProvinces,
  isConnected,
  nameNewProvince,
  provinceRulesPatchSchema, provinceRulesSchema,
  provinceSizes,
  regenTargets,
  regenerateProvinces,
  repairProvinces,
  setLakeMode,
  splitCells,
} from './provinces';
import { SEAM_MAX_POINTS, cutSeams, dropSeams, inheritSeams, seamsAfterCut } from './seams';
import { cutProvinces } from './select';
import { checkSpeciesScripts } from './biome-scripts';
import { namesNaturally } from './features';
import { MAX_RIVER_TYPES, checkRiverTypeScripts, riverTypeDirty, riverTypeSchema } from './river-types';
import { MAX_LAKE_TYPES, checkLakeTypeScripts, lakeTypeDirty, lakeTypeSchema } from './lake-types';
import { ISLAND_CODE_MASK, LAGOON_BIT, MAX_ISLAND_TYPES, islandCode, islandTypeById, islandTypeDirty, islandTypeSchema, islandTypesOf, provinceLand, removeIslandCode } from './island-types';
import { typeIdSchema } from './type-id';
import { CommandError } from './errors';
import { type Species, speciesSchema } from './species';
import {
  checkIslandKind,
  islandTypeName,
  chainIslands,
  chainSchema,
  combineStamps,
  islandSchema,
  type LakeView,
  type StampResult,
  centerCell,
  landStroke,
  placeIsland,
  reliefStroke,
  resolveTerrain,
  restoreKeep,
  restoredLandDelta,
  roundKm,
  sizeText,
} from './terrain';
import { type NameCarry, REGION_KIND_INFO, applyNameCarry } from './features';
import type { Mesh } from './mesh';
import { cutPathAtCell, ownsCell } from './rivers';
import {
  REGION_KINDS,
  constraintSchema,
  type Derived,
  type Guide,
  guideSchema,
  lakeSchema,
  planetPatchSchema,
  planetSchema,
  regionSchema,
  type SmallState,
  type World,
  FREE_HEIGHT,
} from './world';

// 所有编辑都是可序列化的命令。命令只改“原因”，并且只保存明确的格编号，
// 所以重放结果与当时界面上的推导状态无关（例外：generate_provinces 需要当时的水文与高程，引擎会先把推导算好）。

const cells = z.array(z.number().int().min(0));
const fieldName = z.string().regex(/^[\w-]+$/, '场名只能包含字母、数字、下划线和连字符');
const paintField = z.union([z.enum(['erodDelta', 'tempOffset', 'moistOffset']), z.string().regex(/^field:[\w-]+$/)]);
// 画笔落点：每格到画笔中心的归一化距离（0 中心，1 边缘），与 cells 对齐
const strokeT = z.array(z.number().min(0).max(1));

// 改一条画的河：只写要改的项；null 表示去掉这一项（命令要能存成 JSON，所以不用 undefined）。
// 写错的项名直接报错，不会悄悄忽略
const G = guideSchema.shape;
const guidePatchSchema = z
  .object({
    cells: G.cells.optional(),
    path: G.path.unwrap().nullable().optional(),
    name: G.name.unwrap().nullable().optional(),
    nameKey: G.nameKey.unwrap().nullable().optional(),
    autoName: G.autoName.unwrap().nullable().optional(),
    salt: G.salt.unwrap().nullable().optional(),
    spring: z.boolean().optional(),
    flow: G.flow.unwrap().nullable().optional(),
    width: G.width.unwrap().nullable().optional(),
    end: G.end.unwrap().nullable().optional(),
    type: G.type.unwrap().nullable().optional(),
    branch: G.branch.unwrap().nullable().optional(),
    sourceOf: G.sourceOf.unwrap().nullable().optional(),
    label: G.label.unwrap().nullable().optional(),
  })
  .strict();
export type GuidePatch = z.input<typeof guidePatchSchema>;

// 改一个放的湖：只写要改的项，null 去掉这一项
const L = lakeSchema.shape;
const lakePatchSchema = z
  .object({
    type: L.type.unwrap().nullable().optional(),
    radius: z.number().min(0.1).max(2000).optional(),
  })
  .strict();
export type LakePatch = z.input<typeof lakePatchSchema>;

const baseCommands = [
  // 世界生成参数；reset 时清空所有手工编辑（新世界），否则保留（拖滑块）
  z.object({ op: z.literal('set_worldgen'), params: worldgenSchema, reset: z.boolean().default(false) }),
  z.object({ op: z.literal('set_coast_style'), roughness: z.number().min(0).max(3) }),
  z.object({ op: z.literal('paint_land'), cells, t: strokeT, mode: z.enum(['land', 'sea']) }),
  z.object({ op: z.literal('paint_relief'), cells, t: strokeT, strength: z.number().min(-2).max(2) }),
  // 恢复原样：画到的地方，陆地、山、岩性的改动按画笔权重退回生成时的样子
  z.object({ op: z.literal('restore_terrain'), cells, t: strokeT }),
  // 擦掉冷暖干湿的改动（同上）
  z.object({ op: z.literal('restore_climate'), cells, t: strokeT }),
  z.object({ op: z.literal('add_island'), island: islandSchema }),
  z.object({ op: z.literal('add_island_chain'), chain: chainSchema }),
  z.object({ op: z.literal('reroll_region'), x: z.number(), y: z.number(), radius: z.number().positive(), variant: z.number().int().min(1) }),
  z.object({
    op: z.literal('paint'),
    field: paintField,
    cells,
    // values 与 cells 对齐；省略时所有格用 value
    values: z.array(z.number()).optional(),
    value: z.number().default(1),
    mode: z.enum(['set', 'add', 'max', 'min']).default('set'),
  }),
  z.object({ op: z.literal('set_planet'), patch: planetPatchSchema }),
  z.object({ op: z.literal('add_species'), species: speciesSchema }),
  z.object({ op: z.literal('update_species'), id: z.string(), patch: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('remove_species'), id: z.string() }),
  z.object({ op: z.literal('add_constraint'), constraint: constraintSchema.omit({ id: true }).extend({ id: z.string().optional() }) }),
  z.object({ op: z.literal('update_constraint'), id: z.string(), patch: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('remove_constraint'), id: z.string() }),
  // 擦除：把这些格从所有设定里去掉（恢复自然）
  z.object({ op: z.literal('erase_constraints'), cells }),
  z.object({
    op: z.literal('add_guide'),
    guide: guideSchema.omit({ id: true }).extend({ id: z.string().optional() }),
    // 改道：画过的河经过起点的，从起点处截断（起点是它的源头就整条换掉）
    reroute: z.boolean().optional(),
    // 截走：别的画过的河经过这条河中间的，从第一次碰到的地方截断（碰到的是它的源头就整条去掉）
    capture: z.boolean().optional(),
    // 历史与提示条上的一句话（画的时候算好，比如“汇入赤江”），重放时原样显示
    label: z.string().max(200).optional(),
  }),
  // label：历史与提示条上的一句话（“删掉了「赤江」”，界面按地图上的名字写）
  z.object({ op: z.literal('remove_guide'), id: z.string(), label: z.string().max(200).optional() }),
  // 改一条画的河（名字、大小、粗细、终点、重画一段……）：在原来的位置换上改好的（重叠时后面的说了算，先后不能乱）
  z.object({
    op: z.literal('update_guide'),
    id: z.string(),
    patch: guidePatchSchema,
    capture: z.boolean().optional(),
    label: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal('add_lake'), lake: lakeSchema.omit({ id: true }).extend({ id: z.string().optional() }) }),
  z.object({ op: z.literal('remove_lake'), id: z.string() }),
  // 改一个放的湖（第九轮）：类型（'plain' 普通的湖，null 按规则）、大小。名字用 rename_feature（与自然的湖一样）
  z.object({
    op: z.literal('update_lake'),
    id: z.string(),
    patch: lakePatchSchema,
    label: z.string().max(200).optional(),
  }),
  // 给自然的湖选类型（第九轮）：cell 所在的湖是 type 这一种（null 改回按规则）；drop 是先去掉的旧选择（同一个湖里的那几格）
  z.object({
    op: z.literal('type_lake'),
    cell: z.number().int().min(0),
    type: typeIdSchema.nullable(),
    drop: z.array(z.number().int().min(0)).max(1000).optional(),
    label: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal('add_field'), name: fieldName }),
  z.object({ op: z.literal('remove_field'), name: fieldName }),
  // 自动划分省份：规则与当前规则合并（省略的项沿用），锁定的省份不动
  z.object({ op: z.literal('generate_provinces'), rules: provinceRulesPatchSchema.default({}) }),
  // 只重新划分被这些格盖住一半以上的省份；别处的省份编号、名字不变
  z.object({ op: z.literal('regenerate_provinces'), cells }),
  z.object({ op: z.literal('assign_province'), cells, province: z.union([z.number().int().min(0), z.literal('new')]) }),
  z.object({ op: z.literal('merge_province'), from: z.number().int(), into: z.number().int() }),
  z.object({ op: z.literal('split_province'), id: z.number().int() }),
  // 剪刀：沿画的线切开省份。线是界面上已经延长、化简好的（见 seams.ts 的 seamLine），这里不再延长；
  // 切出的每块成一个新省，线（每个切开的省一条，只留在那个省里的一段）记进 provinceSeams，切开的几块之间的边界就画在线上
  z.object({ op: z.literal('cut_province'), line: z.array(z.tuple([z.number(), z.number()])).min(2).max(SEAM_MAX_POINTS) }),
  z.object({
    op: z.literal('set_province'),
    id: z.number().int(),
    name: z.string().optional(),
    locked: z.boolean().optional(),
    // 只能在陆地和无人区之间改（湖省只由自动划分产生，海域省份的类型不能改）
    kind: z.enum(['land', 'wasteland']).optional(),
    // 自己选的颜色（#rrggbb）；null 恢复自动（陆地省按编号配色，海省不着色）。导出的 provinces.bmp 照旧按编号
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
  }),
  // 湖：单独成省 / 并进旁边的陆地省。只整理湖与陆地之间的格，别的省份不动
  z.object({ op: z.literal('set_lake_mode'), mode: z.enum(['separate', 'merge']) }),
  // 地名：key 为“类型:锚点格”；name 为空字符串时恢复自动命名。
  // label（第十四轮）：名字前面的类型字（“圣山”），空字符串换回按地物类型的；只改 label 时不写 name
  z.object({ op: z.literal('rename_feature'), key: z.string().regex(/^\w+:\d+$/), name: z.string().max(40).optional(), label: z.string().max(20).optional() }),
  z.object({ op: z.literal('reroll_feature'), key: z.string().regex(/^\w+:\d+$/) }),
  z.object({ op: z.literal('set_word_pack'), pack: wordPackSchema.nullable() }),
  // 用户的地名：圈一块（cells）或放一个点（kind = spot，at 为位置）；name 为空时按文字包自动起名
  z.object({ op: z.literal('add_region'), region: regionSchema.omit({ id: true }).extend({ id: z.string().optional() }) }),
  // 改名（空字符串恢复自动）、改类型（选了类型就不再自动判断）、auto 类型改成自动判断、reroll 换一个自动的名字
  z.object({
    op: z.literal('update_region'),
    id: z.string(),
    name: z.string().max(40).optional(),
    kind: z.enum(REGION_KINDS).optional(),
    auto: z.boolean().optional(),
    reroll: z.boolean().optional(),
    // 名字前面的类型字（第十四轮）：空字符串换回按类型的
    label: z.string().max(20).optional(),
  }),
  z.object({ op: z.literal('remove_region'), id: z.string() }),
  // 河流类型（第三批）：新建或整份换掉（按 id）；删掉时画的河上选的这一种也去掉
  z.object({ op: z.literal('set_river_type'), type: riverTypeSchema }),
  z.object({ op: z.literal('remove_river_type'), id: z.string() }),
  // 湖泊类型（第九轮）：同河流类型；删掉时放的湖、自然的湖上选的这一种也去掉
  z.object({ op: z.literal('set_lake_type'), type: lakeTypeSchema }),
  z.object({ op: z.literal('remove_lake_type'), id: z.string() }),
  // 岛的种类（第十四轮，见 island-types.ts）：新建或整份换掉（按 id）；删掉时这种岛变成大陆岛
  z.object({ op: z.literal('set_island_type'), type: islandTypeSchema }),
  z.object({ op: z.literal('remove_island_type'), id: z.string() }),
] as const;

// provinceNames：命令执行时新起的省名（省份编号 → 名字），由引擎记下，重放、重做时照用。
// nameCarry：这一步之后为了地名不乱跳留下的名字、挪过去的改名（见 features.ts 的 carryNames），同样由引擎记下、照用。
// provinceFix：这一步改了湖（放湖、删湖、湖干了、地形变了）之后，湖与陆地省份的整理（见 provinces.ts 的 lakeProvinceFix），
// 同样由引擎在推导算好之后记下，重放、重做时照用
export type Command = (z.input<(typeof baseCommands)[number]> | { op: 'batch'; label?: string; commands: Command[] }) & {
  provinceNames?: Record<string, string>;
  nameCarry?: NameCarry;
  provinceFix?: ProvinceFix;
};

const provinceMetaSchema = z.object({
  name: z.string(),
  locked: z.boolean(),
  land: z.boolean(),
  kind: z.enum(['land', 'wasteland', 'lake', 'sea']),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
const provinceFixSchema = z
  .object({
    cells: z.array(z.number().int().min(0)),
    to: z.array(z.number().int().min(-1)),
    add: z.record(z.string().regex(/^\d+$/), provinceMetaSchema),
    drop: z.array(z.number().int().min(0)),
    next: z.number().int().min(0),
  })
  .refine((f) => f.cells.length === f.to.length, '格与省份的个数要一样');

// 命令里记下的地名（见 Command 的 nameCarry）：键是“类型:锚点格”或“guide:河道 id”
const featureKey = z.string().regex(/^\w+:\S+$/);
const nameCarrySchema = z.object({
  keep: z.record(featureKey, z.object({ name: z.string(), ctx: z.string() }).nullable()).optional(),
  move: z.record(featureKey, featureKey).optional(),
});

const single = z.discriminatedUnion('op', baseCommands);
export const commandSchema: z.ZodType<Command> = z.lazy(() =>
  z.union([single, z.object({ op: z.literal('batch'), label: z.string().optional(), commands: z.array(commandSchema) })]),
) as z.ZodType<Command>;

// 在 errors.ts 里（避免循环引用），这里照旧导出
export { CommandError };

// 推导需要从哪一层开始重算
export const Dirty = {
  None: 0,
  // 只需要重新起名（地物本身没变）
  Names: 1,
  Vegetation: 2,
  Solve: 3,
  Climate: 4,
  Elevation: 5,
} as const;
export type Dirty = (typeof Dirty)[keyof typeof Dirty];

type ArrayKey = 'landDelta' | 'upliftDelta' | 'erodDelta' | 'tempOffset' | 'moistOffset' | 'province' | 'islandType' | 'islandHeight' | `field:${string}`;

function getArray(world: World, key: ArrayKey): Float32Array | Uint8Array | Int32Array | undefined {
  if (key.startsWith('field:')) return world.causes.fields[key.slice(6)];
  return world.causes[key as Exclude<ArrayKey, `field:${string}`>];
}

// 撤销记录：稀疏的数组差异 + 小状态快照
export interface UndoRecord {
  arrays: { key: ArrayKey; idx: Int32Array; old: Float64Array }[];
  // 新增或删除的自定义场：撤销时恢复为 old（null 表示原来不存在）
  fields: { name: string; old: Float32Array | null }[];
  small: string;
  // 这一步第一次有了湖里的岛定下的高度（causes.islandHeight）：撤销时去掉整个数组
  dropHeights?: true;
}

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).join('；');
}

export interface ApplyContext {
  // 需要推导结果的命令调用它，保证推导是最新的
  ensureDerived: () => Derived;
  // 在批量命令里（第十五轮：湖里的岛不能放进去——批量里前面几条改的东西还没算进推导，重放时却算进了）
  inBatch?: boolean;
}

function touchedArrays(world: World, cmd: Command): ArrayKey[] {
  switch (cmd.op) {
    case 'set_worldgen':
    case 'paint_land':
    case 'add_island':
    case 'add_island_chain':
    case 'restore_terrain':
      return ['landDelta', 'upliftDelta', 'erodDelta', 'province', 'islandType', 'islandHeight'];
    case 'set_coast_style':
      return ['landDelta', 'upliftDelta', 'erodDelta', 'province'];
    case 'set_island_type':
    case 'remove_island_type':
      return ['islandType', 'province'];
    case 'reroll_region':
      return ['landDelta', 'upliftDelta', 'province'];
    case 'paint_relief':
      return ['upliftDelta'];
    case 'restore_climate':
      return ['tempOffset', 'moistOffset'];
    case 'paint':
      return [cmd.field as ArrayKey];
    case 'generate_provinces':
    case 'regenerate_provinces':
    case 'set_lake_mode':
    case 'assign_province':
    case 'merge_province':
    case 'split_province':
    case 'cut_province':
      return ['province'];
    case 'batch':
      return [...new Set(cmd.commands.flatMap((c) => touchedArrays(world, c)))];
    default:
      return [];
  }
}

// changed：命令有没有改动原因或小数据（没改动时推导也不会变）。
// provinceNames：这一步新起的省名。起名要看推导（河、山、冷暖），重放时推导还没算到这一步，起出来的名字可能
// 与当时不同，所以记进命令；命令里记着的就照用（没有记的：这一步没有新起的省名）
export function applyCommand(
  world: World,
  input: Command,
  ctx: ApplyContext,
): { dirty: Dirty; summary: string; undo: UndoRecord; changed: boolean; provinceNames: Record<string, string> | null } {
  const { provinceNames: stored, nameCarry: carryInput, provinceFix: fixInput, ...raw } = input;
  const carry = carryInput === undefined ? undefined : nameCarrySchema.safeParse(carryInput);
  if (carry && !carry.success) throw new CommandError(`命令里记下的地名无效：${formatIssues(carry.error)}`);
  const nameCarry = carry?.data;
  const fixParsed = fixInput === undefined ? undefined : provinceFixSchema.safeParse(fixInput);
  if (fixParsed && !fixParsed.success) throw new CommandError(`命令里记下的省份整理无效：${formatIssues(fixParsed.error)}`);
  const provinceFix = fixParsed?.data;
  if (provinceFix && provinceFix.cells.some((c) => c >= world.mesh.n)) throw new CommandError('命令里记下的省份整理不是这张地图的');
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new CommandError(`命令参数无效：${formatIssues(parsed.error)}`);
  const cmd = parsed.data;
  const touched = touchedArrays(world, cmd);
  if (provinceFix && !touched.includes('province')) touched.push('province');
  const keys = touched.filter((k) => getArray(world, k));
  const before = keys.map((k) => Float64Array.from(getArray(world, k)!));
  const smallBefore = JSON.stringify(world.small);
  const fieldsBefore = { ...world.causes.fields };
  const heightsBefore = world.causes.islandHeight;
  const idsBefore = new Set(Object.keys(world.small.provinces));
  let result: { dirty: Dirty; summary: string };
  try {
    result = run(world, cmd, ctx);
    if (stored) {
      for (const [id, name] of Object.entries(stored)) {
        const p = world.small.provinces[Number(id)];
        if (p && !idsBefore.has(id)) p.name = name;
      }
    }
    if (nameCarry) applyNameCarry(world.small, nameCarry);
    if (provinceFix) applyProvinceFix(world, provinceFix);
  } catch (e) {
    // 失败时恢复，保证命令要么完整生效要么不生效
    keys.forEach((k, idx) => getArray(world, k)!.set(before[idx]));
    world.small = JSON.parse(smallBefore);
    world.causes.fields = fieldsBefore;
    if (!heightsBefore) delete world.causes.islandHeight;
    throw e;
  }
  const undo: UndoRecord = { arrays: [], fields: [], small: smallBefore };
  if (!heightsBefore && world.causes.islandHeight) undo.dropHeights = true;
  keys.forEach((k, idx) => {
    const now = getArray(world, k)!;
    const old = before[idx];
    const changed: number[] = [];
    for (let i = 0; i < now.length; i++) if (now[i] !== old[i]) changed.push(i);
    if (changed.length) undo.arrays.push({ key: k, idx: Int32Array.from(changed), old: Float64Array.from(changed, (i) => old[i]) });
  });
  const names = new Set([...Object.keys(fieldsBefore), ...Object.keys(world.causes.fields)]);
  for (const name of names) if (fieldsBefore[name] !== world.causes.fields[name]) undo.fields.push({ name, old: fieldsBefore[name] ?? null });
  const changed = undo.arrays.length > 0 || undo.fields.length > 0 || !!undo.dropHeights || JSON.stringify(world.small) !== smallBefore;
  const provinceNames: Record<string, string> = {};
  for (const [id, p] of Object.entries(world.small.provinces)) if (!idsBefore.has(id)) provinceNames[id] = p.name;
  return { ...result, undo, changed, provinceNames: Object.keys(provinceNames).length ? provinceNames : null };
}

// 命令执行之后又改了一个数组（引擎记进命令的整理，见 Engine.fixLakeProvinces）：把这些格改之前的值并进撤销记录。
// before 是这次改之前的数组；撤销记录里已经有的格保留原来记的（命令之前的）值
export function addArrayUndo(undo: UndoRecord, key: ArrayKey, cells: readonly number[], before: ArrayLike<number>) {
  const at = undo.arrays.findIndex((a) => a.key === key);
  const old = new Map<number, number>();
  if (at >= 0) {
    const a = undo.arrays[at];
    for (let k = 0; k < a.idx.length; k++) old.set(a.idx[k], a.old[k]);
  }
  for (const c of cells) if (!old.has(c)) old.set(c, before[c]);
  const idx = Int32Array.from([...old.keys()].sort((a, b) => a - b));
  const entry = { key, idx, old: Float64Array.from(idx, (i) => old.get(i)!) };
  if (at >= 0) undo.arrays[at] = entry;
  else undo.arrays.push(entry);
}

export function revert(world: World, undo: UndoRecord) {
  for (const f of undo.fields) {
    if (f.old) world.causes.fields[f.name] = f.old;
    else delete world.causes.fields[f.name];
  }
  for (const a of [...undo.arrays].reverse()) {
    const arr = getArray(world, a.key)!;
    for (let k = 0; k < a.idx.length; k++) arr[a.idx[k]] = a.old[k];
  }
  if (undo.dropHeights) delete world.causes.islandHeight;
  world.small = JSON.parse(undo.small) as SmallState;
  // 陆海、抬升等组合值由增量与生成参数算出，撤销后重新组合
  resolveTerrain(world);
}

// 重新组合地形；陆海变了就修补省份。返回新增与消失的陆地格数
// 历史里“新世界：X”的 X：星球形态的名字；整个星球用向导里星球类型的名字（“像地球”，而不是地区的“几块大陆”）；
// 一块地区用世界类型的名字。只是说明文字，不进世界状态
function worldgenName(params: Worldgen, globe: boolean): string {
  if (params.form) return params.form.name;
  if (globe) {
    // 海洋星球与空白星球同是 ocean：有没有露出海面的火山岛
    const t = PLANET_TYPES.find((p) => p.type === params.type && (p.type !== 'ocean' || (p.islands !== undefined) === (params.islands !== undefined && params.islands > 0)));
    if (t) return t.name;
  }
  return WORLD_TYPE_INFO[params.type].name;
}

// 组合地形，陆海变了的格修补省份。classBefore：命令改之前省份按格分的陆海（provinceLand；放岛记上了归海省的岛时
// 陆海没变、省份的陆海也会变）。clear：画陆地 / 海、恢复原样画到的格，先清掉记着的岛的种类（画成了普通的陆地、海）；
// 这时陆海变了的格也清掉（潟湖的海格除外：它们是不是潟湖要与重新组合的结果一致）
function applyTerrain(world: World, opts: { classBefore?: Uint8Array; clear?: number[] } = {}): { gained: number; lost: number } {
  const { causes } = world;
  const before = causes.land.slice();
  const classBefore = opts.classBefore ?? provinceLand(world);
  const fixed = causes.islandHeight;
  if (opts.clear) {
    for (const i of opts.clear) causes.islandType[i] = 0;
    if (fixed) for (const i of opts.clear) fixed[i] = FREE_HEIGHT;
  }
  resolveTerrain(world);
  let gained = 0;
  let lost = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === causes.land[i]) continue;
    if (!before[i]) gained++;
    else lost++;
    if (opts.clear && !(causes.islandType[i] & LAGOON_BIT)) causes.islandType[i] = 0;
    if (opts.clear && fixed) fixed[i] = FREE_HEIGHT;
  }
  const after = provinceLand(world);
  let moved = false;
  for (let i = 0; i < after.length && !moved; i++) if (after[i] !== classBefore[i]) moved = true;
  if (moved) repairProvinces(world);
  return { gained, lost };
}

const nextId = (world: World, prefix: string) => `${prefix}-${world.small.nextId++}`;

// 放岛的增量加进原因；湖里的岛定下的高度写进 causes.islandHeight（第一次用到时才建）
function putStamp(world: World, r: StampResult) {
  const { causes } = world;
  r.cells.forEach((i, k) => {
    causes.landDelta[i] += r.landDelta[k];
    causes.upliftDelta[i] += r.upliftDelta[k];
    causes.erodDelta[i] += r.erodDelta[k];
    if (r.types[k]) causes.islandType[i] = r.types[k];
  });
  if (!r.heights) return;
  const fixed = (causes.islandHeight ??= new Float32Array(world.mesh.n).fill(FREE_HEIGHT));
  r.cells.forEach((i, k) => {
    const h = r.heights![k];
    if (!Number.isNaN(h)) fixed[i] = h;
  });
}

// 湖里有没有这一种岛（定了高度、记着这一种的格）
function hasLakeIsles(world: World, code: number): boolean {
  const fixed = world.causes.islandHeight;
  if (!fixed || !code) return false;
  const types = world.causes.islandType;
  for (let i = 0; i < fixed.length; i++) if (fixed[i] !== FREE_HEIGHT && (types[i] & ISLAND_CODE_MASK) === code) return true;
  return false;
}

// 画笔中心七成半径以内的格（t ≤ 0.7：画陆地 / 海一定变成陆地、海，恢复原样完全恢复的那一圈）
const brushCore = (cells: number[], t: number[]) => cells.filter((_, k) => t[k] <= 0.7);

// 岛的种类改了归哪种省、删了一种之后：省份按格分的陆海变了的格换到对的省份里（与陆海变了时一样就近修补）
function refileProvinces(world: World, classBefore: Uint8Array) {
  const after = provinceLand(world);
  for (let i = 0; i < after.length; i++) {
    if (after[i] !== classBefore[i]) {
      repairProvinces(world);
      return;
    }
  }
}

// 改生态时按实际改了哪几项决定重算到哪一层（与改之前逐项比较，不看补丁里写了什么）：
// - 只改外观（花纹、发光）：只影响画法，什么都不重算（Worker 发轻快照）；
// - 只改外观、名字、地名设定：长什么不变，只重新起名（生态区的类型名、名字跟着生态的名字和地名设定）；
// - 别的（耐受、竞争力、扩散、脚本、效果、种子、颜色、地形类别……）：照旧从求解重算。
// 颜色也不能算进第一种：地图的着色只在推导数组换了时才重算（见 MapView 的 colorKey）
const LOOK_KEYS = new Set(['visual']);
const NAME_KEYS = new Set(['visual', 'name', 'feature']);
function speciesChange(before: Species, after: Species): { dirty: Dirty; what: string } {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const only = (k: string) => changed.length > 0 && changed.every((x) => x === k);
  const what = only('visual') ? '的外观' : only('feature') ? '的地名' : only('scripts') ? '的脚本' : only('effects') ? '对周围的影响' : '';
  if (changed.every((k) => LOOK_KEYS.has(k))) return { dirty: Dirty.None, what };
  // 带脚本的生态改名也从求解重算：脚本出错的说明（d.scriptIssues）里有它的名字，要与重放一致（脚本本身记着结果，不重跑）
  if (changed.includes('name') && (before.scripts || after.scripts)) return { dirty: Dirty.Solve, what };
  // 加上、去掉地名设定（feature）时，自然长成的那些片要不要成为自己的地物也跟着变（features.ts 的 namesNaturally）：
  // 地物要重新识别，不只是重新起名
  if (changed.every((k) => NAME_KEYS.has(k)) && namesNaturally(before) === namesNaturally(after)) return { dirty: Dirty.Names, what };
  return { dirty: Dirty.Solve, what };
}

// ---------- 画的河 ----------

// 河道上前后两格必须相邻
function checkCourse(mesh: Mesh, cells: readonly number[]) {
  for (let k = 0; k + 1 < cells.length; k++) {
    const a = cells[k];
    const b = cells[k + 1];
    let adjacent = false;
    for (let e = mesh.off[a]; e < mesh.off[a + 1]; e++) if (mesh.adj[e] === b) adjacent = true;
    if (!adjacent) throw new CommandError(`河道路径第 ${k} 与第 ${k + 1} 格不相邻`);
  }
}

// 河道还要查两项：不经过同一格两次（水会绕成圈）；在终点消失的，终点要在陆地上
function checkNewCourse(world: World, g: Guide, cells: boolean, end: boolean) {
  if (cells && new Set(g.cells).size !== g.cells.length) throw new CommandError('河道不能经过同一格两次');
  if (cells && g.branch && !world.causes.land[g.cells[0]]) throw new CommandError('分出去的一股要从陆地上的河分出来');
  if (end && g.end === 'sink' && !world.causes.land[g.cells[g.cells.length - 1]]) throw new CommandError('停在终点的河，终点要在陆地上');
}

// 河道截到第 k 格为止（含）：画的折线在第一次进这格的地方截断；原来在终点消失的不再消失（现在流进别的河）
export function truncateGuide(world: World, g: Guide, k: number): Guide {
  // 截在最后一格（在终点消失的河的终点）：格、折线都不动，只是不再消失
  if (k >= g.cells.length - 1) {
    const { end: _, ...rest } = g;
    return rest;
  }
  const out: Guide = { ...g, cells: g.cells.slice(0, k + 1) };
  if (g.path) {
    const cut = cutPathAtCell(world.mesh, g.path, g.cells[k]);
    if (cut) out.path = cut;
  }
  if (out.end !== undefined) delete out.end;
  return out;
}

// 截走：别的河道经过 g 中间（不含起点与终点）的陆地格的，从第一次碰到的地方截断，汇进 g（在终点消失的河经过的是
// 它的终点时，只去掉“消失”）；碰到的是它的源头就整条去掉
function captureBy(world: World, guides: Guide[], g: Guide): Guide[] {
  const land = world.causes.land;
  const inner = new Set(g.cells.slice(1, -1).filter((c) => land[c]));
  return guides.flatMap((b) => {
    if (b.id === g.id) return [b];
    const k = b.cells.findIndex((c, i) => ownsCell(b, i) && inner.has(c));
    if (k < 0) return [b];
    return k === 0 ? [] : [truncateGuide(world, b, k)];
  });
}

// 改了画的河之后要从哪一层重算（画的河只挖河床，不改地形的求解，所以从不需要重算高程与气候）：
//   · 走向、泉水、大小、终点、类型变了，或者有没有名字变了（地物多了、少了）→ 植被（从水文起）；
//   · 名字、盐、画的折线变了 → 只重新起名；
//   · 只改粗细 → 不用重算
export function guideDirty(before: readonly Guide[], after: readonly Guide[]): Dirty {
  const sig = (list: readonly Guide[], f: (g: Guide) => unknown) => JSON.stringify(list.map(f));
  const same = (f: (g: Guide) => unknown) => sig(before, f) === sig(after, f);
  // 有没有画的线也要从水文起重算：画的河（有折线）整条按最小的河补水
  if (!same((g) => [g.id, g.cells, g.spring, g.flow ?? null, g.end ?? null, g.type ?? null, g.name !== undefined || g.nameKey !== undefined, !!g.path, g.branch?.share ?? null])) {
    return Dirty.Vegetation;
  }
  if (!same((g) => [g.name ?? null, g.nameKey ?? null, g.autoName ?? null, g.salt ?? null, g.path ?? null, g.sourceOf ?? null, g.label ?? null])) return Dirty.Names;
  return Dirty.None;
}

// 新建一个空的省份：陆海随这些格，类型随这些格原来所在省份的多数（assign_province 'new' 与剪刀共用）
function newProvince(world: World, cells: number[]): number {
  const { causes, small } = world;
  const land = cells.length ? provinceLand(world)[cells[0]] === 1 : true;
  const kinds = new Map<ProvinceKind, number>();
  for (const i of cells) {
    const k = small.provinces[causes.province[i]]?.kind;
    if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  let kind: ProvinceKind = land ? 'land' : 'sea';
  let bk = 0;
  for (const [k, c] of kinds) if (c > bk && (k === 'sea') !== land) {
    bk = c;
    kind = k;
  }
  const id = small.nextProvince++;
  small.provinces[id] = { name: '', locked: false, land, kind };
  return id;
}

function run(world: World, cmd: Command, ctx: ApplyContext): { dirty: Dirty; summary: string } {
  const { causes, small, mesh } = world;
  const n = mesh.n;
  const checkCells = (list: number[]) => {
    const bad = list.find((i) => i >= n);
    if (bad !== undefined) throw new CommandError(`格编号 ${bad} 超出范围（共 ${n} 格）`);
  };
  switch (cmd.op) {
    case 'batch': {
      let dirty: Dirty = Dirty.None;
      const inner = { ...ctx, inBatch: true };
      for (const c of cmd.commands) dirty = Math.max(dirty, run(world, c, inner).dirty) as Dirty;
      return { dirty, summary: cmd.label ?? `批量 ${cmd.commands.length} 条` };
    }
    case 'set_worldgen': {
      const params = worldgenSchema.parse(cmd.params);
      // 星球形态：只能用在整个星球上，type 要与形态的 base 相同；脚本有语法错误时当场拒绝
      // （运行时出错不拒绝：那一部分按没有脚本算，见 planet-gen.ts）
      if (params.form) checkForm(params.form, params.type, world.settings.globe === true, (t) => PLANET_TYPES.find((p) => p.type === t)?.name ?? WORLD_TYPE_INFO[t].name);
      if (cmd.reset) {
        causes.landDelta.fill(0);
        causes.upliftDelta.fill(0);
        causes.erodDelta.fill(0);
        causes.islandType.fill(0);
        causes.islandHeight?.fill(FREE_HEIGHT);
        causes.province.fill(-1);
        small.provinces = {};
        small.constraints = [];
        small.guides = [];
        small.lakes = [];
        delete small.lakeTyping;
      }
      const prev = small.terrain.gen;
      small.terrain.gen = params;
      applyTerrain(world);
      const name = worldgenName(params, world.settings.globe === true);
      if (cmd.reset || !prev) return { dirty: Dirty.Elevation, summary: `新世界：${name}` };
      const what = [
        prev.landFraction !== params.landFraction ? '陆地多少' : '',
        prev.islands !== params.islands ? '岛多少' : '',
        prev.mountains !== params.mountains ? '山多高' : '',
      ].filter(Boolean);
      if (!sameForm(prev.form, params.form)) {
        const more = what.length ? `；调整了${what.join('、')}` : '';
        // 去掉形态时说去掉了哪一个（“换了星球形态：像地球”读起来像是换成了另一个形态）
        if (!params.form && prev.form) return { dirty: Dirty.Elevation, summary: `去掉了星球形态「${prev.form.name}」${more}` };
        return { dirty: Dirty.Elevation, summary: `换了星球形态：${name}${more}` };
      }
      return { dirty: Dirty.Elevation, summary: `调整了${what.length ? what.join('、') : '世界参数'}` };
    }
    case 'set_coast_style': {
      small.terrain.coastRoughness = cmd.roughness;
      applyTerrain(world);
      const style = cmd.roughness < 0.6 ? '平滑' : cmd.roughness < 1.4 ? '自然' : '破碎';
      return { dirty: Dirty.Elevation, summary: `海岸风格改为“${style}”` };
    }
    case 'paint_land': {
      checkCells(cmd.cells);
      if (cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      const r = landStroke(world, cmd.cells, cmd.t, cmd.mode);
      r.cells.forEach((i, k) => (causes.landDelta[i] += r.delta[k]));
      // 画笔中心（七成半径以内，一定变成陆地、海的那一圈）画到的岛成了普通的陆地、海
      const ch = applyTerrain(world, { clear: brushCore(cmd.cells, cmd.t) });
      return { dirty: Dirty.Elevation, summary: cmd.mode === 'land' ? `画陆地：新增 ${ch.gained} 格陆地` : `画海：${ch.lost} 格陆地变成海` };
    }
    case 'paint_relief': {
      checkCells(cmd.cells);
      if (cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      const r = reliefStroke(cmd.cells, cmd.t, cmd.strength);
      r.cells.forEach((i, k) => (causes.upliftDelta[i] += r.delta[k]));
      applyTerrain(world);
      return { dirty: Dirty.Elevation, summary: cmd.strength >= 0 ? `堆山：${cmd.cells.length} 格` : `压低：${cmd.cells.length} 格` };
    }
    case 'restore_terrain': {
      checkCells(cmd.cells);
      if (cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      // 剩下的零头直接归零，擦过的地方不留看不见的残余
      const snap = (v: number, eps: number) => (Math.abs(v) < eps ? 0 : v);
      cmd.cells.forEach((i, k) => {
        const keep = restoreKeep(cmd.t[k]);
        causes.landDelta[i] = restoredLandDelta(causes.landDelta[i], cmd.t[k]);
        causes.upliftDelta[i] = snap(causes.upliftDelta[i] * keep, 1e-3);
        causes.erodDelta[i] = snap(causes.erodDelta[i] * keep, 1e-3);
      });
      // 完全恢复的地方（画笔中心七成半径以内）不再是放的岛
      const ch = applyTerrain(world, { clear: brushCore(cmd.cells, cmd.t) });
      return { dirty: Dirty.Elevation, summary: ch.gained || ch.lost ? `恢复原样（陆地 +${ch.gained} / −${ch.lost} 格）` : '恢复原样' };
    }
    case 'restore_climate': {
      checkCells(cmd.cells);
      if (cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      let n = 0;
      cmd.cells.forEach((i, k) => {
        if (causes.tempOffset[i] === 0 && causes.moistOffset[i] === 0) return;
        const keep = restoreKeep(cmd.t[k]);
        causes.tempOffset[i] = Math.abs(causes.tempOffset[i] * keep) < 0.05 ? 0 : causes.tempOffset[i] * keep;
        causes.moistOffset[i] = Math.abs(causes.moistOffset[i] * keep) < 0.01 ? 0 : causes.moistOffset[i] * keep;
        n++;
      });
      return { dirty: Dirty.Climate, summary: `擦掉了 ${n} 格的冷暖干湿改动` };
    }
    case 'add_island': {
      const spec = islandSchema.parse(cmd.island);
      checkIslandKind(world, spec.kind);
      // 岛心在陆格上（湖面或干的陆地）：要看推导里的湖面。批量命令里推导不是最新的，不放
      const c0 = centerCell(world.mesh, spec.x, spec.y);
      if (causes.land[c0] && ctx.inBatch) throw new CommandError('批量命令里的岛只能放在海里（湖里的岛要单独放）');
      const { stamp: r, lake } = placeIsland(world, spec, () => ctx.ensureDerived());
      if (lake && !r.cells.length) throw new CommandError('湖太窄了，放不下岛（岛四周要留一圈湖面）');
      if (!r.footprint.length) throw new CommandError('这里放不下岛（可能已经是陆地）');
      const classBefore = provinceLand(world);
      putStamp(world, r);
      applyTerrain(world, { classBefore });
      // 一格的岛（小礁）不看大小：画出来约半格大
      const cellKm = world.mesh.spacing * world.kmPerUnit;
      const one = islandTypeById(small, spec.kind)?.shape === 'cell';
      const size = one ? `直径约 ${roundKm(cellKm * 0.5)} km` : spec.size < cellKm * 0.5 ? sizeText(world, spec.size) : `直径约 ${roundKm(spec.size * 2)} km`;
      return { dirty: Dirty.Elevation, summary: `${lake ? '在湖里' : ''}放了一个${islandTypeName(world, spec.kind)}（${size}）` };
    }
    case 'add_island_chain': {
      const spec = chainSchema.parse(cmd.chain);
      checkIslandKind(world, spec.kind);
      // 岛心落在湖面上的岛按湖里的岛放（要看推导里的湖面，只在有岛心落在陆格上时才取）；
      // 批量命令里推导不是最新的：岛心在陆格上的岛照旧不放
      let view: LakeView | null | undefined;
      const lakes = () => (view === undefined ? (view = ctx.inBatch ? null : ctx.ensureDerived()) : view);
      const islands = chainIslands(world, spec, lakes);
      const r = combineStamps(world, islands, lakes);
      const classBefore = provinceLand(world);
      putStamp(world, r);
      applyTerrain(world, { classBefore });
      return { dirty: Dirty.Elevation, summary: `画了一条岛链：${islands.length - (r.skipped ?? 0)} 个${islandTypeName(world, spec.kind)}` };
    }
    case 'reroll_region': {
      const gen = small.terrain.gen;
      if (!gen) throw new CommandError('空白海洋没有可重画的生成地形；先用“画陆地”或“放岛”');
      gen.rerolls = [...gen.rerolls, { x: cmd.x, y: cmd.y, radius: cmd.radius, variant: cmd.variant }];
      const ch = applyTerrain(world);
      return { dirty: Dirty.Elevation, summary: `重画了这一片（陆地 +${ch.gained} / −${ch.lost} 格）` };
    }
    case 'paint': {
      checkCells(cmd.cells);
      const arr = getArray(world, cmd.field as ArrayKey);
      if (!arr) throw new CommandError(`没有字段 ${cmd.field}；自定义场需先用 add_field 创建`);
      if (cmd.values && cmd.values.length !== cmd.cells.length) throw new CommandError('values 的长度必须与 cells 相同');
      const mode = cmd.mode ?? 'set';
      cmd.cells.forEach((i, k) => {
        const v = cmd.values ? cmd.values[k] : (cmd.value ?? 1);
        const cur = arr[i];
        arr[i] = mode === 'set' ? v : mode === 'add' ? cur + v : mode === 'max' ? Math.max(cur, v) : Math.min(cur, v);
      });
      if (cmd.field === 'erodDelta') {
        applyTerrain(world);
        return { dirty: Dirty.Elevation, summary: `改变岩石软硬：${cmd.cells.length} 格` };
      }
      const dirty = cmd.field.startsWith('field:') ? Dirty.Solve : Dirty.Climate;
      const sign = cmd.values ? cmd.values.reduce((a, b) => a + b, 0) : (cmd.value ?? 1);
      // 冷暖干湿：写明最多改了多少（画笔中心那一格）
      const peak = cmd.values ? cmd.values.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0) : (cmd.value ?? 1);
      const signed = (v: number, digits: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
      if (cmd.field === 'tempOffset') {
        return { dirty, summary: `${sign >= 0 ? '变暖' : '变冷'} ${cmd.cells.length} 格，最多 ${signed(peak, Math.abs(peak) < 2 ? 1 : 0)} °C` };
      }
      if (cmd.field === 'moistOffset') {
        const pct = Math.round((Math.exp(peak) - 1) * 100);
        return { dirty, summary: `${sign >= 0 ? '变湿' : '变干'} ${cmd.cells.length} 格，雨水最多 ${signed(pct, 0)}%` };
      }
      return { dirty, summary: `调整“${cmd.field.slice(6)}”：${cmd.cells.length} 格` };
    }
    case 'set_planet': {
      const before = small.planet;
      if (world.settings.globe && 'latShift' in cmd.patch && cmd.patch.latShift !== undefined) throw new CommandError('整个星球不能南北挪动');
      if (world.settings.globe && 'outsideOcean' in cmd.patch && cmd.patch.outsideOcean !== undefined) throw new CommandError('整个星球没有“地图外面”');
      const parsed = planetSchema.safeParse({ ...before, ...cmd.patch });
      if (!parsed.success) throw new CommandError(`set_planet 参数无效：${formatIssues(parsed.error)}`);
      small.planet = parsed.data;
      const keys = Object.keys(cmd.patch);
      // riverThreshold 也影响水文（画的河源头的泉水）和要素识别（哪些算河），至少要重算到植被
      const dirty = keys.includes('mountainScale')
        ? Dirty.Elevation
        : keys.some((k) => ['tilt', 'solar', 'rotation', 'lapse', 'humidity', 'outsideOcean', 'latShift', 'currents', 'terrainWind'].includes(k))
          ? Dirty.Climate
          : keys.includes('vegSharpness')
            ? Dirty.Solve
            : keys.includes('riverThreshold')
              ? Dirty.Vegetation
              : Dirty.None;
      const names: Record<string, string> = {
        tilt: '四季分明',
        solar: '整体冷暖',
        lapse: '越高越冷',
        humidity: '整体干湿',
        mountainScale: '最高的山',
        riverThreshold: '河流多少',
        vegSharpness: '生态边界',
        rotation: '自转方向',
        outsideOcean: '地图外面是不是海',
        latShift: '地图在星球上的位置',
        currents: '洋流强弱',
        terrainWind: '山挡风',
      };
      return { dirty, summary: `调整了${keys.map((k) => names[k] ?? k).join('、')}` };
    }
    case 'add_species': {
      if (small.species.some((s) => s.id === cmd.species.id)) throw new CommandError(`类型 id "${cmd.species.id}" 已存在`);
      const sp = speciesSchema.parse(cmd.species);
      // 脚本先编译一遍（只查语法）：写错了整条命令不生效，并说明第几行错了
      checkSpeciesScripts(sp);
      small.species.push(sp);
      return { dirty: Dirty.Solve, summary: `新建生态“${cmd.species.name || cmd.species.id}”` };
    }
    case 'update_species': {
      const idx = small.species.findIndex((s) => s.id === cmd.id);
      if (idx < 0) throw new CommandError(`找不到类型 "${cmd.id}"`);
      if ('id' in cmd.patch && cmd.patch.id !== cmd.id) throw new CommandError('不能修改类型 id；请新增后删除旧的');
      // 值为 null 的项表示去掉（例如取消扩散限制）；命令要能存成 JSON，所以不用 undefined
      const merged: Record<string, unknown> = { ...small.species[idx], ...cmd.patch };
      for (const [k, v] of Object.entries(cmd.patch)) if (v === null) delete merged[k];
      const parsed = speciesSchema.safeParse(merged);
      if (!parsed.success) throw new CommandError(`update_species 参数无效：${formatIssues(parsed.error)}`);
      checkSpeciesScripts(parsed.data);
      const before = small.species[idx];
      small.species[idx] = parsed.data;
      const { dirty, what } = speciesChange(before, parsed.data);
      return { dirty, summary: `修改了生态“${parsed.data.name || cmd.id}”${what}` };
    }
    case 'remove_species': {
      const idx = small.species.findIndex((s) => s.id === cmd.id);
      if (idx < 0) throw new CommandError(`找不到类型 "${cmd.id}"`);
      const [gone] = small.species.splice(idx, 1);
      return { dirty: Dirty.Solve, summary: `删除了生态“${gone.name || cmd.id}”` };
    }
    case 'add_constraint': {
      checkCells(cmd.constraint.cells);
      if (!small.species.some((s) => s.id === cmd.constraint.species)) throw new CommandError(`找不到类型 "${cmd.constraint.species}"`);
      const c = constraintSchema.parse({ ...cmd.constraint, id: cmd.constraint.id ?? nextId(world, 'set') });
      if (small.constraints.some((x) => x.id === c.id)) throw new CommandError(`约束 id "${c.id}" 已存在`);
      // 后涂的覆盖先涂的：重叠的格从旧设定里移走，空了的旧设定删掉
      const mine = new Set(c.cells);
      small.constraints = small.constraints.map((x) => ({ ...x, cells: x.cells.filter((i) => !mine.has(i)) })).filter((x) => x.cells.length > 0);
      small.constraints.push(c);
      const sp = small.species.find((x) => x.id === c.species);
      return { dirty: Dirty.Solve, summary: `涂了 ${c.cells.length} 格${sp?.name || c.species}（${c.mode === 'constraint' ? '自然融入' : '强制'}）` };
    }
    case 'update_constraint': {
      const idx = small.constraints.findIndex((c) => c.id === cmd.id);
      if (idx < 0) throw new CommandError(`找不到约束 "${cmd.id}"`);
      const parsed = constraintSchema.safeParse({ ...small.constraints[idx], ...cmd.patch, id: cmd.id });
      if (!parsed.success) throw new CommandError(`update_constraint 参数无效：${formatIssues(parsed.error)}`);
      checkCells(parsed.data.cells);
      const was = small.constraints[idx];
      small.constraints[idx] = parsed.data;
      // 只改了“就这样”的记号：推导不变（冲突照样算，界面按记号不再提醒）
      const { ignored: _a, ...restBefore } = was;
      const { ignored: _b, ...restAfter } = parsed.data;
      if (JSON.stringify(restBefore) === JSON.stringify(restAfter)) {
        const sp = small.species.find((x) => x.id === parsed.data.species);
        const name = sp?.name || parsed.data.species;
        return { dirty: Dirty.None, summary: parsed.data.ignored ? `${name}没涂成的那一笔：就这样（收进“!”里）` : `${name}没涂成的那一笔：恢复提醒` };
      }
      return { dirty: Dirty.Solve, summary: '修改了一处涂的生态' };
    }
    case 'remove_constraint': {
      const before = small.constraints.length;
      small.constraints = small.constraints.filter((c) => c.id !== cmd.id);
      if (small.constraints.length === before) throw new CommandError(`找不到约束 "${cmd.id}"`);
      return { dirty: Dirty.Solve, summary: '去掉了一处涂的生态，恢复自然' };
    }
    case 'erase_constraints': {
      checkCells(cmd.cells);
      const gone = new Set(cmd.cells);
      const before = small.constraints.reduce((k, c) => k + c.cells.length, 0);
      small.constraints = small.constraints.map((x) => ({ ...x, cells: x.cells.filter((i) => !gone.has(i)) })).filter((x) => x.cells.length > 0);
      const after = small.constraints.reduce((k, c) => k + c.cells.length, 0);
      return { dirty: Dirty.Solve, summary: `擦掉了 ${before - after} 格的设定，恢复自然` };
    }
    case 'add_guide': {
      checkCells(cmd.guide.cells);
      checkCourse(mesh, cmd.guide.cells);
      const g = guideSchema.parse({ ...cmd.guide, id: cmd.guide.id ?? nextId(world, cmd.guide.locked ? 'lock' : 'river') });
      if (small.guides.some((x) => x.id === g.id)) throw new CommandError(`河道 id "${g.id}" 已存在`);
      checkNewCourse(world, g, true, true);
      const before = small.guides.slice();
      if (cmd.reroute) {
        // 原来那段河道不再留着（也就不再有白色虚线标记）
        const start = g.cells[0];
        small.guides = small.guides.flatMap((old) => {
          const k = old.cells.indexOf(start);
          // 从它汇入的地方（那条河的格）改道不动它；从在终点消失的河的终点改道：它不再消失，水接着流进改道的河
          if (k < 0 || !ownsCell(old, k)) return [old];
          return k === 0 ? [] : [truncateGuide(world, old, k)];
        });
      }
      if (cmd.capture) small.guides = captureBy(world, small.guides, g);
      small.guides.push(g);
      const km = roundKm(g.cells.length * mesh.spacing * world.kmPerUnit);
      const summary = cmd.label || (cmd.reroute ? `让河改道（约 ${km} km）` : g.spring ? `画了一条河（约 ${km} km）` : `固定了一段河道（约 ${km} km）`);
      return { dirty: guideDirty(before, small.guides), summary };
    }
    case 'remove_guide': {
      const before = small.guides;
      small.guides = small.guides.filter((g) => g.id !== cmd.id);
      if (small.guides.length === before.length) throw new CommandError(`找不到河道 "${cmd.id}"`);
      return { dirty: guideDirty(before, small.guides), summary: cmd.label || '删掉了一条画的河' };
    }
    case 'update_guide': {
      const idx = small.guides.findIndex((g) => g.id === cmd.id);
      if (idx < 0) throw new CommandError(`找不到河道 "${cmd.id}"`);
      const old = small.guides[idx];
      const merged: Record<string, unknown> = { ...old, ...cmd.patch };
      for (const [k, v] of Object.entries(cmd.patch)) if (v === null) delete merged[k];
      const moved = cmd.patch.cells !== undefined && JSON.stringify(cmd.patch.cells) !== JSON.stringify(old.cells);
      const parsed = guideSchema.safeParse(merged);
      if (!parsed.success) throw new CommandError(`update_guide 参数无效：${formatIssues(parsed.error)}`);
      const g = parsed.data;
      if (moved) {
        checkCells(g.cells);
        checkCourse(mesh, g.cells);
      }
      // 只查这次改到的：别处的改动（比如终点后来被画成了海）不妨碍改名字、粗细
      checkNewCourse(world, g, moved, moved || cmd.patch.end !== undefined);
      const before = small.guides;
      small.guides = small.guides.map((x, k) => (k === idx ? g : x));
      if (cmd.capture) small.guides = captureBy(world, small.guides, g);
      return { dirty: guideDirty(before, small.guides), summary: cmd.label || (g.name ? `改了「${g.name}」` : '改了一条河') };
    }
    case 'set_river_type': {
      const t = riverTypeSchema.parse(cmd.type);
      // 脚本先编译一遍（只查语法）：写错了整条命令不生效，并说明第几行错了
      checkRiverTypeScripts(t);
      const list = small.riverTypes ?? [];
      const at = list.findIndex((x) => x.id === t.id);
      if (at < 0 && list.length >= MAX_RIVER_TYPES) throw new CommandError(`河流类型最多 ${MAX_RIVER_TYPES} 种`);
      const before = at >= 0 ? list[at] : undefined;
      small.riverTypes = at >= 0 ? list.map((x, k) => (k === at ? t : x)) : [...list, t];
      const level = riverTypeDirty(before, t);
      const dirty = level === 'none' ? Dirty.None : level === 'names' ? Dirty.Names : Dirty.Vegetation;
      return { dirty, summary: `${before ? '修改了' : '新建了'}河流类型「${t.name}」` };
    }
    case 'remove_river_type': {
      const list = small.riverTypes ?? [];
      const gone = list.find((x) => x.id === cmd.id);
      if (!gone) throw new CommandError(`找不到河流类型 "${cmd.id}"`);
      small.riverTypes = list.filter((x) => x.id !== cmd.id);
      // 画的河上选的这一种也去掉（撤销时一起回来）：不然以后新建一种同 id 的类型，这些河会悄悄变成它
      small.guides = small.guides.map((g) => {
        if (g.type !== cmd.id) return g;
        const { type: _, ...rest } = g;
        return rest as typeof g;
      });
      return { dirty: Dirty.Vegetation, summary: `删掉了河流类型「${gone.name}」` };
    }
    case 'add_lake': {
      checkCells([cmd.lake.cell]);
      if (!causes.land[cmd.lake.cell]) throw new CommandError('湖必须放在陆地上');
      const l = lakeSchema.parse({ ...cmd.lake, id: cmd.lake.id ?? nextId(world, 'lake') });
      small.lakes.push(l);
      return { dirty: Dirty.Elevation, summary: `放了一个湖（直径约 ${roundKm(l.radius * 2)} km）` };
    }
    case 'remove_lake': {
      const before = small.lakes.length;
      small.lakes = small.lakes.filter((l) => l.id !== cmd.id);
      if (small.lakes.length === before) throw new CommandError(`找不到湖 "${cmd.id}"`);
      return { dirty: Dirty.Elevation, summary: '删掉了一个湖' };
    }
    case 'update_lake': {
      const idx = small.lakes.findIndex((l) => l.id === cmd.id);
      if (idx < 0) throw new CommandError(`找不到湖 "${cmd.id}"`);
      const old = small.lakes[idx];
      const merged: Record<string, unknown> = { ...old, ...cmd.patch };
      for (const [k, v] of Object.entries(cmd.patch)) if (v === null) delete merged[k];
      const parsed = lakeSchema.safeParse(merged);
      if (!parsed.success) throw new CommandError(`update_lake 参数无效：${formatIssues(parsed.error)}`);
      const l = parsed.data;
      small.lakes = small.lakes.map((x, k) => (k === idx ? l : x));
      // 大小：重挖湖盆；类型：从水文起（岸边的影响、生态的条件会变）
      const dirty = l.radius !== old.radius ? Dirty.Elevation : Dirty.Vegetation;
      return { dirty, summary: cmd.label || (l.radius !== old.radius ? `湖的直径改成约 ${roundKm(l.radius * 2)} km` : '改了一个湖') };
    }
    case 'type_lake': {
      checkCells([cmd.cell, ...(cmd.drop ?? [])]);
      const drop = new Set([cmd.cell, ...(cmd.drop ?? [])]);
      const list = (small.lakeTyping ?? []).filter((e) => !drop.has(e.cell));
      if (cmd.type !== null) list.push({ cell: cmd.cell, type: cmd.type });
      if (list.length) small.lakeTyping = list;
      else delete small.lakeTyping;
      return { dirty: Dirty.Vegetation, summary: cmd.label || (cmd.type === null ? '湖的类型改回按规则' : '改了湖的类型') };
    }
    case 'set_lake_type': {
      const t = lakeTypeSchema.parse(cmd.type);
      checkLakeTypeScripts(t);
      const list = small.lakeTypes ?? [];
      const at = list.findIndex((x) => x.id === t.id);
      if (at < 0 && list.length >= MAX_LAKE_TYPES) throw new CommandError(`湖泊类型最多 ${MAX_LAKE_TYPES} 种`);
      const before = at >= 0 ? list[at] : undefined;
      small.lakeTypes = at >= 0 ? list.map((x, k) => (k === at ? t : x)) : [...list, t];
      const level = lakeTypeDirty(before, t);
      const dirty = level === 'none' ? Dirty.None : level === 'names' ? Dirty.Names : Dirty.Vegetation;
      return { dirty, summary: `${before ? '修改了' : '新建了'}湖泊类型「${t.name}」` };
    }
    case 'remove_lake_type': {
      const list = small.lakeTypes ?? [];
      const gone = list.find((x) => x.id === cmd.id);
      if (!gone) throw new CommandError(`找不到湖泊类型 "${cmd.id}"`);
      small.lakeTypes = list.filter((x) => x.id !== cmd.id);
      // 放的湖、自然的湖上选的这一种也去掉（撤销时一起回来）
      small.lakes = small.lakes.map((l) => {
        if (l.type !== cmd.id) return l;
        const { type: _, ...rest } = l;
        return rest as typeof l;
      });
      if (small.lakeTyping) {
        const left = small.lakeTyping.filter((e) => e.type !== cmd.id);
        if (left.length) small.lakeTyping = left;
        else delete small.lakeTyping;
      }
      return { dirty: Dirty.Vegetation, summary: `删掉了湖泊类型「${gone.name}」` };
    }
    case 'set_island_type': {
      const t = islandTypeSchema.parse(cmd.type);
      const list = islandTypesOf(small);
      const at = list.findIndex((x) => x.id === t.id);
      if (at < 0 && list.length >= MAX_ISLAND_TYPES) throw new CommandError(`岛的种类最多 ${MAX_ISLAND_TYPES} 种`);
      const before = at >= 0 ? list[at] : undefined;
      const classBefore = provinceLand(world);
      small.islandTypes = at >= 0 ? list.map((x, k) => (k === at ? t : x)) : [...list, t];
      // 改了归陆地省还是海省：这种岛的格换到对的省份里。湖里的这种岛（定了高度的格）省份按陆地算，陆海不变；
      // 湖单独成省时它们要在湖省与陆地省之间换：至少重新起名一遍，引擎算好之后整理（见 engine.ts 的 fixLakeProvinces）
      const moved = !!before && before.province !== t.province;
      if (moved) refileProvinces(world, classBefore);
      let dirty: Dirty = islandTypeDirty(before, t) === 'names' ? Dirty.Names : Dirty.None;
      if (moved && dirty < Dirty.Names && hasLakeIsles(world, islandCode(small, t.id))) dirty = Dirty.Names;
      return { dirty, summary: `${before ? '修改了' : '新建了'}岛的种类「${t.name}」` };
    }
    case 'remove_island_type': {
      const list = islandTypesOf(small);
      const k = list.findIndex((x) => x.id === cmd.id);
      if (k < 0) throw new CommandError(`找不到岛的种类 "${cmd.id}"`);
      const gone = list[k];
      const classBefore = provinceLand(world);
      small.islandTypes = list.filter((x) => x.id !== cmd.id);
      if (!small.islandTypes.length) delete small.islandTypes;
      // 这种岛变成大陆岛（潟湖照旧是潟湖），后面的编号往前挪
      removeIslandCode(causes.islandType, k);
      refileProvinces(world, classBefore);
      // 地物要重算：这种岛上的 itype: 标签要去掉（只重新起名会留着旧标签，同一个 id 再新建时名字就和重放不一样）
      return { dirty: Dirty.Vegetation, summary: `删掉了岛的种类「${gone.name}」（这种岛变成大陆岛）` };
    }
    case 'add_field': {
      if (causes.fields[cmd.name]) throw new CommandError(`场 "${cmd.name}" 已存在`);
      causes.fields = { ...causes.fields, [cmd.name]: new Float32Array(n) };
      return { dirty: Dirty.Solve, summary: `新增自定义场 ${cmd.name}` };
    }
    case 'remove_field': {
      if (!causes.fields[cmd.name]) throw new CommandError(`没有场 "${cmd.name}"`);
      const { [cmd.name]: _removed, ...rest } = causes.fields;
      causes.fields = rest;
      return { dirty: Dirty.Solve, summary: `删除自定义场 ${cmd.name}` };
    }
    case 'generate_provinces': {
      const d = ctx.ensureDerived();
      const rules = provinceRulesSchema.parse({ ...small.provinceRules, ...(cmd.rules ?? {}) });
      generateProvinces(world, d, rules);
      // 整张图重新划分：切线都不要了
      delete small.provinceSeams;
      return { dirty: Dirty.None, summary: `自动划分省份：${Object.keys(small.provinces).length} 个` };
    }
    case 'regenerate_provinces': {
      checkCells(cmd.cells);
      const ids = regenTargets(world, cmd.cells);
      if (!ids.length) throw new CommandError('涂的范围要盖住省份的一大半，那个省份才会重新划分');
      const d = ctx.ensureDerived();
      // 碰到重新划分的省的切线不要了（看划分前的省份）
      const regen = new Set(ids);
      dropSeams(world, (p) => regen.has(p));
      const fresh = regenerateProvinces(world, d, ids);
      return { dirty: Dirty.None, summary: `重新划分了 ${ids.length} 个省份 → ${fresh.length} 个` };
    }
    case 'set_lake_mode': {
      const d = ctx.ensureDerived();
      const was = small.provinceRules.lakeMode;
      setLakeMode(world, d, cmd.mode);
      const what = cmd.mode === 'separate' ? '湖单独成省' : '湖并进旁边的陆地省';
      return { dirty: Dirty.None, summary: was === cmd.mode ? `省份：${what}（整理了一遍）` : `省份：${what}` };
    }
    case 'assign_province': {
      checkCells(cmd.cells);
      let id: number;
      if (cmd.province === 'new') id = newProvince(world, cmd.cells);
      else {
        id = cmd.province;
        if (!small.provinces[id]) throw new CommandError(`找不到省份 ${id}`);
      }
      const meta = small.provinces[id];
      // 归海省的岛（小礁）算海：只能划进海省
      const pland = provinceLand(world);
      const wrong = cmd.cells.filter((i) => (pland[i] === 1) !== meta.land);
      if (wrong.length) throw new CommandError(`${wrong.length} 格与省份的陆海类别不符（${meta.land ? '陆地' : '海域'}省份${meta.land ? '；小礁算海' : ''}）`);
      // 湖省只收湖面的格，陆地省不收湖省里的格（湖单独成省时）：按格现在所在省份的大类判断
      const cls = classOfKind(meta.kind);
      const mixed = cmd.cells.filter((i) => {
        const p = small.provinces[causes.province[i]];
        return p && p.land && classOfKind(p.kind) !== cls;
      });
      if (mixed.length) throw new CommandError(cls === 'lake' ? `${mixed.length} 格不是湖面，不能划进湖省` : `${mixed.length} 格是湖面（属于湖省），不能划进陆地省`);
      const lockedHit = cmd.cells.find((i) => causes.province[i] >= 0 && causes.province[i] !== id && small.provinces[causes.province[i]]?.locked);
      if (lockedHit !== undefined) throw new CommandError(`格 ${lockedHit} 属于已锁定的省份 ${causes.province[lockedHit]}`);
      for (const i of cmd.cells) causes.province[i] = id;
      // 新省份在格划进来之后再起名，名字才能按省内地形取字
      if (cmd.province === 'new') nameNewProvince(world, id);
      const sizes = provinceSizes(world);
      for (const p of Object.keys(small.provinces).map(Number)) if (!sizes.has(p)) delete small.provinces[p];
      const cellsOf = (p: number) => {
        const out: number[] = [];
        for (let i = 0; i < n; i++) if (causes.province[i] === p) out.push(i);
        return out;
      };
      const warn = isConnected(world, cellsOf(id)) ? '' : '（注意：省份不连通）';
      return { dirty: Dirty.None, summary: `${cmd.cells.length} 格划入省份 ${small.provinces[id].name || id}${warn}` };
    }
    case 'merge_province': {
      const a = small.provinces[cmd.from];
      const b = small.provinces[cmd.into];
      if (!a || !b) throw new CommandError('找不到要合并的省份');
      if (a.land !== b.land) throw new CommandError('陆地省份与海域省份不能合并');
      if (classOfKind(a.kind) !== classOfKind(b.kind)) throw new CommandError('湖省与陆地省份不能合并（湖要并进陆地省，在省份规则里选“湖：并进旁边的陆地省”）');
      if (a.locked || b.locked) throw new CommandError('省份已锁定');
      for (let i = 0; i < n; i++) if (causes.province[i] === cmd.from) causes.province[i] = cmd.into;
      delete small.provinces[cmd.from];
      return { dirty: Dirty.None, summary: `省份 ${a.name || cmd.from} 并入 ${b.name || cmd.into}` };
    }
    case 'split_province': {
      const meta = small.provinces[cmd.id];
      if (!meta) throw new CommandError(`找不到省份 ${cmd.id}`);
      if (meta.locked) throw new CommandError('省份已锁定');
      const list: number[] = [];
      for (let i = 0; i < n; i++) if (causes.province[i] === cmd.id) list.push(i);
      if (list.length < 2) throw new CommandError('省份太小，不能拆分');
      const [, right] = splitCells(world, list);
      const id = small.nextProvince++;
      small.provinces[id] = { name: '', locked: false, land: meta.land, kind: meta.kind };
      for (const i of right) causes.province[i] = id;
      nameNewProvince(world, id);
      // 剪刀切过这个省时：切线也管分出来的这一半（没有切线的世界不变）
      if (small.provinceSeams) small.provinceSeams = inheritSeams(small.provinceSeams, cmd.id, [id]);
      return { dirty: Dirty.None, summary: `拆分省份 ${meta.name || cmd.id}` };
    }
    case 'cut_province': {
      // 与界面上拖动时的预览同一个算法、同一条线，切出来的块与新省份的编号都与预览相同
      const cut = cutProvinces(world, cmd.line, { extend: false });
      if (!cut.plans.length) throw new CommandError('线没有把省份分开');
      const names = cut.plans.map((pl) => `“${small.provinces[pl.id].name || `省份 ${pl.id}`}”`).join('、');
      // 记下的切线：每个切开的省一条，只留线在那个省里的一段（按切之前的省份算，与预览的 cutSeams 相同）
      const seams = cutSeams(world, cmd.line, cut);
      let count = 0;
      for (const pl of cut.plans) {
        for (const part of pl.parts.slice(1)) {
          const id = newProvince(world, part);
          for (const i of part) causes.province[i] = id;
          nameNewProvince(world, id);
          count++;
        }
      }
      small.provinceSeams = seamsAfterCut(small.provinceSeams, seams, () => nextId(world, 'seam'));
      return { dirty: Dirty.None, summary: `切开了${names}（多出 ${count} 个省份）` };
    }
    case 'rename_feature': {
      if (cmd.name === undefined && cmd.label === undefined) throw new CommandError('rename_feature 要写 name 或 label');
      const ov = { ...(small.featureNames[cmd.key] ?? {}) };
      if (cmd.name !== undefined) {
        if (cmd.name.trim()) ov.name = cmd.name.trim();
        else delete ov.name;
      }
      const label = cmd.label?.trim();
      if (cmd.label !== undefined) {
        if (label) ov.label = label;
        else delete ov.label;
      }
      small.featureNames = { ...small.featureNames, [cmd.key]: ov };
      if (cmd.name === undefined) return { dirty: Dirty.Names, summary: label ? `类型改叫“${label}”` : '类型换回自动的叫法' };
      return { dirty: Dirty.Names, summary: cmd.name.trim() ? `改名为“${cmd.name.trim()}”` : '恢复自动命名' };
    }
    case 'reroll_feature': {
      const ov = { ...(small.featureNames[cmd.key] ?? {}) };
      delete ov.name;
      ov.salt = (ov.salt ?? 0) + 1;
      small.featureNames = { ...small.featureNames, [cmd.key]: ov };
      return { dirty: Dirty.Names, summary: '换了个名字' };
    }
    case 'add_region': {
      checkCells(cmd.region.cells);
      const region = regionSchema.parse({ ...cmd.region, id: cmd.region.id ?? nextId(world, 'region') });
      if (small.regions.some((r) => r.id === region.id)) throw new CommandError(`地名 ${region.id} 已存在`);
      if (region.kind === 'spot' && region.cells.length !== 1) throw new CommandError('点状地名只占一格');
      if (region.kind === 'spot' && region.auto) throw new CommandError('点状地名没有类型可以自动判断');
      region.name = region.name.trim();
      small.regions = [...small.regions, region];
      const what = region.kind === 'spot' ? '放了一个地名' : `圈了一块${REGION_KIND_INFO[region.kind].label}`;
      return { dirty: Dirty.Names, summary: region.name ? `${what}“${region.name}”` : what };
    }
    case 'update_region': {
      const r = small.regions.find((x) => x.id === cmd.id);
      if (!r) throw new CommandError(`找不到地名 ${cmd.id}`);
      const next = { ...r };
      if (cmd.kind !== undefined) {
        if ((cmd.kind === 'spot') !== (r.kind === 'spot')) throw new CommandError('点状地名和区块不能互换');
        next.kind = cmd.kind;
        delete next.auto;
      }
      if (cmd.auto !== undefined) {
        if (r.kind === 'spot') throw new CommandError('点状地名没有类型可以自动判断');
        if (cmd.auto) next.auto = true;
        else delete next.auto;
      }
      if (cmd.name !== undefined) next.name = cmd.name.trim();
      if (cmd.reroll) {
        next.name = '';
        next.salt = r.salt + 1;
      }
      const label = cmd.label?.trim();
      if (cmd.label !== undefined) {
        if (label) next.label = label;
        else delete next.label;
      }
      small.regions = small.regions.map((x) => (x.id === r.id ? next : x));
      const onlyLabel = cmd.label !== undefined && cmd.name === undefined && cmd.kind === undefined && cmd.auto === undefined && !cmd.reroll;
      const summary = onlyLabel
        ? label
          ? `类型改叫“${label}”`
          : '类型换回自动的叫法'
        : cmd.reroll
        ? '换了个名字'
        : next.auto && !r.auto
          ? '类型改成自动判断'
          : next.kind !== r.kind || (r.auto && !next.auto)
            ? `改成${REGION_KIND_INFO[next.kind].label}`
            : next.name
              ? `改名为“${next.name}”`
              : '恢复自动命名';
      return { dirty: Dirty.Names, summary };
    }
    case 'remove_region': {
      const r = small.regions.find((x) => x.id === cmd.id);
      if (!r) throw new CommandError(`找不到地名 ${cmd.id}`);
      small.regions = small.regions.filter((x) => x.id !== cmd.id);
      const what = r.kind === 'spot' ? '地名' : REGION_KIND_INFO[r.kind].label;
      return { dirty: Dirty.Names, summary: r.name ? `删除了${what}“${r.name}”` : `删除了一个${what}` };
    }
    case 'set_word_pack': {
      if (cmd.pack) {
        const problems = packProblems(cmd.pack);
        if (problems.length) throw new CommandError(`文字包有问题：${problems.slice(0, 3).join('；')}`);
      }
      small.wordPack = cmd.pack;
      return { dirty: Dirty.Names, summary: cmd.pack ? `换用文字包“${cmd.pack.name}”` : '换回内置文字包' };
    }
    case 'set_province': {
      const meta = small.provinces[cmd.id];
      if (!meta) throw new CommandError(`找不到省份 ${cmd.id}`);
      if (cmd.kind !== undefined) {
        if (!meta.land) throw new CommandError('海上的省份只能是海域');
        meta.kind = cmd.kind;
      }
      if (cmd.name !== undefined) meta.name = cmd.name;
      if (cmd.locked !== undefined) meta.locked = cmd.locked;
      if (cmd.color !== undefined) {
        if (cmd.color) meta.color = cmd.color.toLowerCase();
        else delete meta.color;
      }
      const what =
        cmd.kind !== undefined
          ? `改成${PROVINCE_KIND_INFO[cmd.kind].name}`
          : cmd.locked !== undefined
            ? cmd.locked
              ? '锁定'
              : '解锁'
            : cmd.color !== undefined
              ? cmd.color
                ? '换了颜色'
                : '颜色恢复自动'
              : '改名';
      return { dirty: Dirty.None, summary: `省份“${meta.name || cmd.id}”：${what}` };
    }
  }
}

