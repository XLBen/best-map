import { z } from 'zod';
import { typeIdSchema } from '../type-id';
import { originSchema } from '../content/origin';
import { constraintSchema, guideSchema, lakeSchema, planetPatchSchema, REGION_KINDS, regionSchema } from '../world';
import { HEX } from '../human/terrain-class';
import { flagSchema } from '../human/flags';
import { SUBJECT_KINDS } from '../human/era';
import { MAX_COUNTRIES } from '../human/countries';
import { worldgenSchema } from '../generate';
import { chainSchema, islandSchema } from '../terrain';
import { speciesSchema } from '../species';
import { type ProvinceFix, provinceRulesPatchSchema } from '../provinces';
import { SEAM_MAX_POINTS } from '../seams';
import { riverTypeSchema } from '../river-types';
import { lakeTypeSchema } from '../lake-types';
import { islandTypeSchema } from '../island-types';
import type { NameCarry } from '../features';
import type { PopFix } from '../human/population';

// 命令的格式（zod）：baseCommands 的先后就是命令登记的先后，不要调换（第四十一轮从 commands.ts 原样搬来）

export const cells = z.array(z.number().int().min(0));
// 人文（第二十二轮）
export const popCount = z.number().min(0).max(1e13);
export const seedSchema = z.number().int().min(0).max(0xffffffff);
export const humanGroups = z
  .array(z.object({ id: typeIdSchema, weight: z.number().min(0).max(1000), cultures: z.array(typeIdSchema).max(64).optional() }))
  .max(32);
// 生成人文用的资源包（第三十轮）：资源库里的路径，按勾选的先后；规则取第一个带时代的包
export const humanPacks = z.array(originSchema).max(32);
export const popTupleSchema = z.object({ culture: typeIdSchema, values: z.record(typeIdSchema, typeIdSchema) });
// 国家（第二十三轮）
export const countryId = z.number().int().min(1);
export const fragmentation = z.number().min(0).max(1);
// 第二十六轮：格局（国家大小怎么分布，'era' 按时代）
// 格局（第四十二轮起是内容的 id，'era' 按时代）
export const layoutSchema = typeIdSchema;
export const countryRulesInput = z.object({ fragmentation: fragmentation.optional(), seed: seedSchema.optional(), layout: layoutSchema.optional() }).strict();
// 换库（第五十二轮，见 core/packs/switch.ts）：生成之前从世界里移出 drop（旧库带来、新库不带的），两个库都有的项来源改写到新库（rehome）。
// 只跟着生成走：用到它们的人口、国家马上就被新的换掉，所以不查“还在用”；生成之后还在的东西用到的，界面算计划时已经留下了
export const librarySwitchInput = z
  .object({
    drop: z.array(z.object({ kind: typeIdSchema, id: z.string().min(1).max(64) })).max(4096),
    rehome: z.array(z.object({ kind: typeIdSchema, id: z.string().min(1).max(64), from: originSchema })).max(4096),
  })
  .strict();
export const countryPatchSchema = z
  .object({
    // '' 是恢复自动；orig 跟着 name
    name: z.string().max(40).optional(),
    orig: z.string().max(80).optional(),
    color: HEX.optional(),
    // null 是按种子重新生成
    flag: flagSchema.nullable().optional(),
    government: typeIdSchema.optional(),
    primaryCulture: typeIdSchema.optional(),
    acceptedGroups: z.array(typeIdSchema).max(32).optional(),
    // null 是恢复自动（按人口构成算）
    factions: z.record(typeIdSchema, z.number().min(0).max(1)).nullable().optional(),
    overlord: countryId.nullable().optional(),
    // 从属的种类（第二十六轮）；null 是恢复默认（附庸）
    subject: z.enum(SUBJECT_KINDS).nullable().optional(),
    allies: z.array(countryId).max(64).optional(),
    rivals: z.array(countryId).max(64).optional(),
    ruler: z.object({ name: z.string().min(1).max(40), orig: z.string().max(80).optional(), title: z.string().max(16).optional() }).optional(),
    founded: z.number().int().min(-100000).max(100000).optional(),
    history: z.string().max(4000).optional(),
    locked: z.boolean().optional(),
  })
  .strict();
// 帝国、联邦、同盟（第二十六轮）
export const blocId = z.number().int().min(1);
export const blocPatchSchema = z
  .object({
    kind: z.enum(['empire', 'federation', 'alliance']).optional(),
    // '' 是恢复自动；orig 跟着 name
    name: z.string().max(40).optional(),
    orig: z.string().max(80).optional(),
    leader: countryId.optional(),
    members: z.array(countryId).max(MAX_COUNTRIES).optional(),
    color: HEX.optional(),
  })
  .strict();
// 城市、道路、地标、自定义点（第二十四轮）
export const settleId = z.number().int().min(1);
export const settlementsInput = z.object({ seed: seedSchema.optional(), roads: z.boolean().optional(), landmarks: z.boolean().optional() }).strict();
export const nullableText = (max: number) => z.string().max(max).nullable().optional();
export const cityPatchSchema = z
  .object({
    // '' 是恢复自动；orig 跟着 name；reroll 换一个自动的名字
    name: z.string().max(40).optional(),
    orig: z.string().max(80).optional(),
    reroll: z.literal(true).optional(),
    // null 是恢复自动
    rank: typeIdSchema.nullable().optional(),
    country: countryId.nullable().optional(),
    founded: z.number().int().min(-100000).max(100000).nullable().optional(),
    description: nullableText(2000),
    notes: nullableText(2000),
    locked: z.boolean().optional(),
  })
  .strict();
export const roadPatchSchema = z.object({ kind: typeIdSchema.optional(), name: nullableText(40), note: nullableText(2000) }).strict();
export const landmarkPatchSchema = z
  .object({ type: typeIdSchema.optional(), name: z.string().max(40).optional(), orig: z.string().max(80).optional(), description: nullableText(2000), locked: z.boolean().optional() })
  .strict();
export const pointPatchSchema = z.object({ type: typeIdSchema.optional(), name: z.string().max(40).optional(), note: nullableText(2000), attachedCity: settleId.nullable().optional() }).strict();
export const mapXY = z.number().min(-10).max(10);

export const fieldName = z.string().regex(/^[\w-]+$/, '场名只能包含字母、数字、下划线和连字符');
export const paintField = z.union([z.enum(['erodDelta', 'tempOffset', 'moistOffset']), z.string().regex(/^field:[\w-]+$/)]);
// 画笔落点：每格到画笔中心的归一化距离（0 中心，1 边缘），与 cells 对齐
export const strokeT = z.array(z.number().min(0).max(1));

// 改一条画的河：只写要改的项；null 表示去掉这一项（命令要能存成 JSON，所以不用 undefined）。
// 写错的项名直接报错，不会悄悄忽略
export const G = guideSchema.shape;
export const guidePatchSchema = z
  .object({
    cells: G.cells.optional(),
    path: G.path.unwrap().nullable().optional(),
    name: G.name.unwrap().nullable().optional(),
    nameKey: G.nameKey.unwrap().nullable().optional(),
    autoName: G.autoName.unwrap().nullable().optional(),
    autoOrig: G.autoOrig.unwrap().nullable().optional(),
    salt: G.salt.unwrap().nullable().optional(),
    spring: z.boolean().optional(),
    flow: G.flow.unwrap().nullable().optional(),
    width: G.width.unwrap().nullable().optional(),
    end: G.end.unwrap().nullable().optional(),
    type: G.type.unwrap().nullable().optional(),
    branch: G.branch.unwrap().nullable().optional(),
    sourceOf: G.sourceOf.unwrap().nullable().optional(),
    label: G.label.unwrap().nullable().optional(),
    hidden: G.hidden.unwrap().nullable().optional(),
  })
  .strict();
export type GuidePatch = z.input<typeof guidePatchSchema>;

// 改一个放的湖：只写要改的项，null 去掉这一项
export const L = lakeSchema.shape;
export const lakePatchSchema = z
  .object({
    type: L.type.unwrap().nullable().optional(),
    radius: z.number().min(0.1).max(2000).optional(),
  })
  .strict();
export type LakePatch = z.input<typeof lakePatchSchema>;

export const baseCommands = [
  // 世界生成参数；reset 时清空所有手工编辑（新世界），否则保留（拖滑块）
  z.object({ op: z.literal('set_worldgen'), params: worldgenSchema, reset: z.boolean().default(false) }),
  z.object({ op: z.literal('set_coast_style'), roughness: z.number().min(0).max(3) }),
  z.object({ op: z.literal('paint_land'), cells, t: strokeT, mode: z.enum(['land', 'sea']) }),
  z.object({ op: z.literal('paint_relief'), cells, t: strokeT, strength: z.number().min(-2).max(2) }),
  // 恢复原样：画到的地方，陆地、山、岩性的改动按画笔权重退回生成时的样子
  z.object({ op: z.literal('restore_terrain'), cells, t: strokeT }),
  // 打碎（第十八轮，见 terrain.ts 的 fragmentStroke）：力度 0.1–1；blocks 裂成碎块，coast 只打碎海岸；size 是画笔半径（km，碎块的大小随它）
  z.object({ op: z.literal('fragment'), cells, t: strokeT, strength: z.number().min(0.1).max(1), mode: z.enum(['blocks', 'coast']), size: z.number().positive() }),
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
  // from（第二十九轮，见 content/origin.ts）：这一项来自资源库的哪个包，记进 small.origin（启用一项的几种命令都能带）；
  // fromId（第四十九轮）：撞 id 改了名时它在包里的 id，记进 small.originId
  z.object({ op: z.literal('add_species'), species: speciesSchema, from: originSchema.optional(), fromId: typeIdSchema.optional() }),
  z.object({ op: z.literal('update_species'), id: z.string(), patch: z.record(z.string(), z.unknown()), from: originSchema.optional(), fromId: typeIdSchema.optional() }),
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
  z.object({ op: z.literal('add_field'), name: fieldName, from: originSchema.optional(), fromId: typeIdSchema.optional() }),
  z.object({ op: z.literal('remove_field'), name: fieldName }),
  // 自动划分省份：规则与当前规则合并（省略的项沿用），锁定的省份不动
  z.object({ op: z.literal('generate_provinces'), rules: provinceRulesPatchSchema.default({}) }),
  // 只重新划分被这些格盖住一半以上的省份；别处的省份编号、名字不变。
  // size（第二十七轮，“省份大小”滑块）：这一次的目标大小（格数，按 4 万格的地区标定，见 provinces.ts 的 provinceSizeCells），不改规则
  z.object({ op: z.literal('regenerate_provinces'), cells, size: z.number().min(4).max(400).optional() }),
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
    // 名字的原文（第二十轮）：和 name 一起写；只改 name 时原文去掉，'' 也是去掉
    orig: z.string().max(80).optional(),
    // 地名风格（第二十轮）：按这种风格重新起名；null 换回世界默认（也重新起名）
    style: typeIdSchema.nullable().optional(),
  }),
  // 湖：单独成省 / 并进旁边的陆地省。只整理湖与陆地之间的格，别的省份不动
  z.object({ op: z.literal('set_lake_mode'), mode: z.enum(['separate', 'merge']) }),
  // 地名：key 为“类型:锚点格”；name 为空字符串时恢复自动命名。
  // label（第十四轮）：名字前面的类型字（“圣山”），空字符串换回按地物类型的；只改 label 时不写 name
  // orig（第二十轮）：名字的原文，和 name 一起写；只写 name 时原文去掉
  z.object({
    op: z.literal('rename_feature'),
    key: z.string().regex(/^\w+:\d+$/),
    name: z.string().max(40).optional(),
    orig: z.string().max(80).optional(),
    label: z.string().max(20).optional(),
    hidden: z.boolean().optional(),
  }),
  z.object({ op: z.literal('reroll_feature'), key: z.string().regex(/^\w+:\d+$/) }),
  // 启用、修改、停用一项内容（第二十轮，见 content/registry.ts）：item 为 null 是停用。只用于存在 small.content 里的种类
  z.object({ op: z.literal('set_content'), kind: typeIdSchema, id: typeIdSchema, item: z.record(z.string(), z.unknown()).nullable(), from: originSchema.optional(), fromId: typeIdSchema.optional() }),
  // 排一排一种内容在世界里的先后（第三十轮，见 packs/import.ts）：ids 里列着的（世界里有的）按 ids 的先后排进它们占着的位置，
  // 没列的不动。从资源包加回来的项排回包里的先后（取值、政体、派系、文化的先后会影响挑哪一个）
  z.object({ op: z.literal('order_content'), kind: typeIdSchema, ids: z.array(typeIdSchema).max(4096) }),
  // 整理本世界（第二十九轮，见 content/unused.ts、tidy.ts）：一步移出这些没用到的内容（种类、id）；省略 items 时移出按规则判断的全部
  // （界面先用 planTidy 在副本上试过、地图不变的才写进 items）。不在世界里的跳过，在用的报错
  z.object({ op: z.literal('tidy_content'), items: z.array(z.object({ kind: typeIdSchema, id: z.string().min(1).max(64) })).max(4096).optional() }),
  // 世界默认的地名风格（第二十轮）：null 是不选（第三十轮起按世界里的第一种）
  z.object({ op: z.literal('set_name_style'), id: typeIdSchema.nullable() }),
  // 世界的画风（第三十八轮，见 map-style.ts）：只能选世界里有的；null 是不选（按世界里的第一种）。只是画法，不重算
  z.object({ op: z.literal('set_map_style'), id: typeIdSchema.nullable() }),
  // 一个地物的地名风格（第二十轮）：key 是地物的键（“类型:锚点格”“guide:id”“region:id”）；null 换回世界默认
  z.object({ op: z.literal('set_feature_style'), key: z.string().regex(/^\w+:\S+$/).max(60), style: typeIdSchema.nullable() }),
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
  z.object({ op: z.literal('set_river_type'), type: riverTypeSchema, from: originSchema.optional(), fromId: typeIdSchema.optional() }),
  z.object({ op: z.literal('remove_river_type'), id: z.string() }),
  // 湖泊类型（第九轮）：同河流类型；删掉时放的湖、自然的湖上选的这一种也去掉
  z.object({ op: z.literal('set_lake_type'), type: lakeTypeSchema, from: originSchema.optional(), fromId: typeIdSchema.optional() }),
  z.object({ op: z.literal('remove_lake_type'), id: z.string() }),
  // 岛的种类（第十四轮，见 island-types.ts）：新建或整份换掉（按 id）；删掉时这种岛变成大陆岛
  z.object({ op: z.literal('set_island_type'), type: islandTypeSchema, from: originSchema.optional(), fromId: typeIdSchema.optional() }),
  z.object({ op: z.literal('remove_island_type'), id: z.string() }),
  // 画地形类别（第二十一轮，见 human/terrain-class.ts）：这些格（只画陆地格）的类别换成 class，null 恢复自动。只改类别、不改高度
  z.object({ op: z.literal('set_cell_class'), cells, class: typeIdSchema.nullable() }),
  // 画资源（第二十一轮，见 human/resources.ts）：'none' 是明确没有，null 恢复自动
  z.object({ op: z.literal('set_cell_resource'), cells, resource: typeIdSchema.nullable() }),
  // 一格的档案（第二十一轮，见 human/cells.ts）：小地名（null 恢复自动；orig 跟着 name，只写 name 时原文去掉）、
  // 换一个自动的名字（reroll，或直接写 salt）、备注（null 去掉）
  z.object({
    op: z.literal('set_cell'),
    cell: z.number().int().min(0),
    name: z.string().max(40).nullable().optional(),
    orig: z.string().max(80).nullable().optional(),
    salt: z.number().int().min(0).optional(),
    reroll: z.literal(true).optional(),
    note: z.string().max(2000).nullable().optional(),
  }),
  // ---------- 人文（第二十二轮，见 human/generate.ts、human/population.ts） ----------
  // 生成：资源包（第三十轮：规则取第一个带时代的包；内容都要先加进世界）、文化组与权重（cultures 只用组里的这几个文化）、
  // 总人口（省略时按时代的默认密度）、种子（省略时用世界的）。缺了时代、文化时不生成，结果里写明（skipped）
  // countries（第二十三轮）：写了就同时生成国家（fragmentation 省略为 0.5，seed 省略为人文的种子）
  // settlements（第二十四轮）：写了就在最后一起放城市、道路、地标（seed 省略为人文的种子，roads、landmarks 省略为 true）
  z.object({
    op: z.literal('generate_human'),
    packs: humanPacks,
    groups: humanGroups,
    totalPop: popCount.optional(),
    seed: seedSchema.optional(),
    countries: countryRulesInput.optional(),
    settlements: settlementsInput.optional(),
    switchLibrary: librarySwitchInput.optional(),
  }),
  // 按记着的参数重新生成（拖过的发源地留着）；写了的几项换掉。keepManual：手改过的格不动（省略为 true）。
  // 有国家时用现有的领土（只按它调人口）；写了 countries 时国家也重新长（锁定的留着）
  z.object({
    op: z.literal('regenerate_human'),
    packs: humanPacks.optional(),
    groups: humanGroups.optional(),
    totalPop: popCount.optional(),
    seed: seedSchema.optional(),
    keepManual: z.boolean().optional(),
    countries: countryRulesInput.optional(),
    switchLibrary: librarySwitchInput.optional(),
  }),
  // 挪一个发源地（文化组的写 group，同一组有几个时 index 是第几个；文化的写 culture），挪过的锁定；cell 为 null 是不再锁定。之后重新生成
  z.object({
    op: z.literal('move_hearth'),
    group: typeIdSchema.optional(),
    culture: typeIdSchema.optional(),
    index: z.number().int().min(0).optional(),
    cell: z.number().int().min(0).nullable(),
    keepManual: z.boolean().optional(),
  }),
  // 去掉人文（人口清零）
  z.object({ op: z.literal('remove_human') }),
  // 总人口按比例改
  z.object({ op: z.literal('set_pop_total'), total: popCount }),
  // 人口笔刷：share 这个群体的占比升高 amount（人数不变）；count 人数 × factor（Shift 反过来由界面给小于 1 的 factor）；
  // value 每个群体里 amount 的人这一维换成 value（传教、改宗）。t 是画笔的权重（省略为 1）。
  // 第二十七轮：amount 为负是往外推（这一群体、这一个取值的占比减少）；clear 是这里没有人（橡皮擦的“清空”）
  z.object({
    op: z.literal('paint_pop'),
    cells,
    t: strokeT.optional(),
    mode: z.enum(['share', 'count', 'value', 'clear']),
    group: popTupleSchema.optional(),
    amount: z.number().min(-1).max(1).optional(),
    factor: z.number().min(0.01).max(100).optional(),
    dimension: typeIdSchema.optional(),
    value: typeIdSchema.optional(),
  }),
  // 文化笔刷：每个群体里 amount 的人换成这个文化（其余维度不变；typical 时换成这个文化最典型的群体）
  z.object({ op: z.literal('paint_culture'), cells, t: strokeT.optional(), culture: typeIdSchema, amount: z.number().min(0).max(1), typical: z.boolean().optional() }),
  // 橡皮擦的“恢复自动”（第二十七轮，见 human/auto.ts）：这些格里手改过的人口回到生成时的样子
  z.object({ op: z.literal('restore_pop'), cells }),
  // 档案里改一格的人口：总人数、各群体的占比（0–1，不到 1 的是“其他”）
  z.object({
    op: z.literal('set_cell_pop'),
    cell: z.number().int().min(0),
    total: popCount.optional(),
    groups: z.array(popTupleSchema.extend({ share: z.number().min(0).max(1) })).max(8).optional(),
  }),
  // ---------- 国家（第二十三轮，见 human/countries.ts、human/country-edit.ts） ----------
  // 生成国家（已有时整个换掉）：人口按国家重新分（手改过的格不动）
  // layout（第二十六轮）：格局，省略或 'era' 按时代
  z.object({ op: z.literal('generate_countries'), fragmentation: fragmentation.optional(), seed: seedSchema.optional(), layout: layoutSchema.optional(), packs: humanPacks.optional(), groups: humanGroups.optional() }),
  // 重新生成国家：写了的几项换掉；keepLocked 省略为 true（锁定的国家不动）
  z.object({ op: z.literal('regenerate_countries'), fragmentation: fragmentation.optional(), seed: seedSchema.optional(), layout: layoutSchema.optional(), keepLocked: z.boolean().optional(), packs: humanPacks.optional(), groups: humanGroups.optional() }),
  // 去掉国家（人口不动）
  z.object({ op: z.literal('remove_countries') }),
  // 领土笔刷：这些格（只画陆地）归 country，null 是无主
  z.object({ op: z.literal('paint_country'), cells, country: countryId.nullable() }),
  // 橡皮擦的“恢复自动”（第二十七轮）：这些格（陆地）的领土回到生成国家时的样子
  z.object({ op: z.literal('restore_country'), cells }),
  // 新建国家：这些格（可以不写）归它；名字、文化、政体、颜色、旗帜不写时自动
  z.object({
    op: z.literal('new_country'),
    cells: cells.optional(),
    name: z.string().min(1).max(40).optional(),
    orig: z.string().max(80).optional(),
    culture: typeIdSchema.optional(),
    government: typeIdSchema.optional(),
    color: HEX.optional(),
    flag: flagSchema.optional(),
  }),
  // 合并：b 并进 a
  z.object({ op: z.literal('merge_countries'), a: countryId, b: countryId }),
  // 拆分：cells（这个国家里的格）成新国家；不写时分成两半
  z.object({ op: z.literal('split_country'), id: countryId, cells: cells.optional() }),
  // 改档案
  z.object({ op: z.literal('set_country'), id: countryId, patch: countryPatchSchema }),
  z.object({ op: z.literal('remove_country'), id: countryId }),
  // 挪首都（这个国家的陆地上的一格）；null 恢复自动
  z.object({ op: z.literal('move_capital'), id: countryId, cell: z.number().int().min(0).nullable() }),
  // 帝国、联邦、同盟（第二十六轮，见 human/blocs.ts）：id 省略是新建（patch 写 kind 与 members），patch 为 null 是删除，别的是改
  z.object({ op: z.literal('set_bloc'), id: blocId.optional(), patch: blocPatchSchema.nullable() }),
  // ---------- 城市、道路、地标、自定义点（第二十四轮，见 human/settlements.ts、roads.ts、landmarks.ts、points.ts） ----------
  // 一起生成（全部换掉）/ 重新生成（锁定的、自己放的、画的留着）；写了的几项换掉记着的参数
  z.object({ op: z.literal('generate_settlements'), seed: seedSchema.optional(), roads: z.boolean().optional(), landmarks: z.boolean().optional() }),
  z.object({ op: z.literal('regenerate_settlements'), seed: seedSchema.optional(), roads: z.boolean().optional(), landmarks: z.boolean().optional() }),
  // 去掉几种（城市连同道路）
  z.object({ op: z.literal('remove_settlements'), cities: z.boolean().optional(), roads: z.boolean().optional(), landmarks: z.boolean().optional(), points: z.boolean().optional() }),
  // 城市：生成（全部换掉）/ 重新生成（自己放的留着；keepLocked 省略为 true：锁定的也留着）；有道路时自动的道路跟着重连
  z.object({ op: z.literal('generate_cities'), seed: seedSchema.optional() }),
  z.object({ op: z.literal('regenerate_cities'), seed: seedSchema.optional(), keepLocked: z.boolean().optional() }),
  z.object({ op: z.literal('add_city'), cell: z.number().int().min(0), name: z.string().max(40).optional(), orig: z.string().max(80).optional(), rank: typeIdSchema.optional() }),
  z.object({ op: z.literal('remove_city'), id: settleId }),
  z.object({ op: z.literal('move_city'), id: settleId, cell: z.number().int().min(0) }),
  z.object({ op: z.literal('set_city'), id: settleId, patch: cityPatchSchema }),
  // 道路：生成（全部换掉）/ 重新生成（画的、改过的留着）；画（一串相邻的陆地格）、改走向（cells 换掉 [from, to] 那一段，省略时整条）、删除、改种类
  z.object({ op: z.literal('generate_roads') }),
  z.object({ op: z.literal('regenerate_roads') }),
  z.object({ op: z.literal('add_road'), cells, kind: typeIdSchema.optional(), name: z.string().max(40).optional() }),
  z.object({ op: z.literal('edit_road'), id: settleId, cells, from: z.number().int().min(0).optional(), to: z.number().int().min(0).optional() }),
  z.object({ op: z.literal('remove_road'), id: settleId }),
  z.object({ op: z.literal('set_road'), id: settleId, patch: roadPatchSchema }),
  // 地标：重新生成（keepManual 省略为 true：自己放的、锁定的留着）
  z.object({ op: z.literal('generate_landmarks'), keepManual: z.boolean().optional() }),
  z.object({ op: z.literal('add_landmark'), type: typeIdSchema, cell: z.number().int().min(0), name: z.string().max(40).optional(), orig: z.string().max(80).optional(), description: z.string().max(2000).optional() }),
  z.object({ op: z.literal('remove_landmark'), id: settleId }),
  z.object({ op: z.literal('move_landmark'), id: settleId, cell: z.number().int().min(0) }),
  z.object({ op: z.literal('set_landmark'), id: settleId, patch: landmarkPatchSchema }),
  // 自定义点：x、y 是精确的位置（地图坐标，省略时在格心）；attachedCity 省略时“当作城市”的类型挂上这一格的城市
  z.object({
    op: z.literal('add_point'),
    type: typeIdSchema,
    cell: z.number().int().min(0),
    x: mapXY.optional(),
    y: mapXY.optional(),
    name: z.string().max(40).optional(),
    note: z.string().max(2000).optional(),
    attachedCity: settleId.nullable().optional(),
  }),
  z.object({ op: z.literal('remove_point'), id: settleId }),
  z.object({ op: z.literal('move_point'), id: settleId, cell: z.number().int().min(0), x: mapXY.optional(), y: mapXY.optional() }),
  z.object({ op: z.literal('set_point'), id: settleId, patch: pointPatchSchema }),
  // 给世界的时代加一维（第五十四轮）：只把现有的人按这一维分开，文化、国家、城市都不动。这一维的取值要已经在世界里（界面在同一个批量里先 set_content）。
  // era 省略时是人文用的时代；写了别的时代时只改那个时代（换库时把世界加的维度带到新时代）
  z.object({ op: z.literal('add_dimension'), dimension: z.object({ id: typeIdSchema, label: z.string().min(1).max(12) }), era: typeIdSchema.optional() }),
] as const;

// provinceNames：命令执行时新起的省名（省份编号 → 名字），由引擎记下，重放、重做时照用。
// nameCarry：这一步之后为了地名不乱跳留下的名字、挪过去的改名（见 features.ts 的 carryNames），同样由引擎记下、照用。
// provinceFix：这一步改了湖（放湖、删湖、湖干了、地形变了）之后，湖与陆地省份的整理（见 provinces.ts 的 lakeProvinceFix），
// 同样由引擎在推导算好之后记下，重放、重做时照用。
// provinceOrig（第二十轮）：新起的省名里有原文的那些（省份编号 → 原文），和 provinceNames 一起记、一起用。
// popFix（第二十二轮）：改了陆海之后人口的修补（变成水面的格没有人了，新的陆地按宜居度补上人，见 human/population.ts 的 populationFix），
// 同样由引擎在推导算好之后记下，重放、重做时照用
export type Command = (z.input<(typeof baseCommands)[number]> | { op: 'batch'; label?: string; commands: Command[] }) & {
  provinceNames?: Record<string, string>;
  provinceOrig?: Record<string, string>;
  nameCarry?: NameCarry;
  provinceFix?: ProvinceFix;
  popFix?: PopFix;
};

export const provinceMetaSchema = z.object({
  name: z.string(),
  locked: z.boolean(),
  land: z.boolean(),
  kind: z.enum(['land', 'wasteland', 'lake', 'sea']),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  style: typeIdSchema.optional(),
  orig: z.string().optional(),
});
export const provinceFixSchema = z
  .object({
    cells: z.array(z.number().int().min(0)),
    to: z.array(z.number().int().min(-1)),
    add: z.record(z.string().regex(/^\d+$/), provinceMetaSchema),
    drop: z.array(z.number().int().min(0)),
    next: z.number().int().min(0),
  })
  .refine((f) => f.cells.length === f.to.length, '格与省份的个数不同');

export const popFixSchema = z
  .object({
    cells: z.array(z.number().int().min(0)),
    total: z.array(z.number().min(0)),
    groups: z.array(z.number().int().min(0).max(65535)),
    shares: z.array(z.number().int().min(0).max(255)),
  })
  .refine((f) => f.cells.length === f.total.length && f.groups.length === f.cells.length * 4 && f.shares.length === f.cells.length * 4, '人口修补的长短不对');

// 命令里记下的地名（见 Command 的 nameCarry）：键是“类型:锚点格”或“guide:河道 id”
export const featureKey = z.string().regex(/^\w+:\S+$/);
export const nameCarrySchema = z.object({
  keep: z.record(featureKey, z.object({ name: z.string(), ctx: z.string(), orig: z.string().optional() }).nullable()).optional(),
  move: z.record(featureKey, featureKey).optional(),
});

export const single = z.discriminatedUnion('op', baseCommands);
export const commandSchema: z.ZodType<Command> = z.lazy(() =>
  z.union([single, z.object({ op: z.literal('batch'), label: z.string().optional(), commands: z.array(commandSchema) })]),
) as z.ZodType<Command>;
