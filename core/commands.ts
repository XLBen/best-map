import { z } from 'zod';
import { WORLD_TYPE_INFO, worldgenSchema } from './generate';
import { packProblems, wordPackSchema } from './names';
import {
  PROVINCE_KINDS,
  PROVINCE_KIND_INFO,
  type ProvinceKind,
  generateProvinces,
  isConnected,
  nameNewProvince,
  provinceRulesPatchSchema, provinceRulesSchema,
  provinceSizes,
  regenTargets,
  regenerateProvinces,
  repairProvinces,
  splitCells,
} from './provinces';
import { speciesSchema } from './species';
import {
  ISLAND_KIND_INFO,
  chainIslands,
  chainSchema,
  combineStamps,
  islandRadiusKm,
  islandSchema,
  islandStamp,
  landStroke,
  reliefStroke,
  resolveTerrain,
  restoreKeep,
  restoredLandDelta,
  roundKm,
} from './terrain';
import { REGION_KIND_INFO } from './features';
import {
  REGION_KINDS,
  constraintSchema,
  type Derived,
  guideSchema,
  lakeSchema,
  planetPatchSchema,
  planetSchema,
  regionSchema,
  type SmallState,
  type World,
} from './world';

// 所有编辑都是可序列化的命令。命令只改“原因”，并且只保存明确的格编号，
// 所以重放结果与当时界面上的推导状态无关（例外：generate_provinces 需要当时的水文与高程，引擎会先把推导算好）。

const cells = z.array(z.number().int().min(0));
const fieldName = z.string().regex(/^[\w-]+$/, '场名只能包含字母、数字、下划线和连字符');
const paintField = z.union([z.enum(['erodDelta', 'tempOffset', 'moistOffset']), z.string().regex(/^field:[\w-]+$/)]);
// 画笔落点：每格到画笔中心的归一化距离（0 中心，1 边缘），与 cells 对齐
const strokeT = z.array(z.number().min(0).max(1));

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
    // 历史与提示条上的一句话（画的时候算好，比如“汇入赤江”），重放时原样显示
    label: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal('remove_guide'), id: z.string() }),
  z.object({ op: z.literal('add_lake'), lake: lakeSchema.omit({ id: true }).extend({ id: z.string().optional() }) }),
  z.object({ op: z.literal('remove_lake'), id: z.string() }),
  z.object({ op: z.literal('add_field'), name: fieldName }),
  z.object({ op: z.literal('remove_field'), name: fieldName }),
  // 自动划分省份：规则与当前规则合并（省略的项沿用），锁定的省份不动
  z.object({ op: z.literal('generate_provinces'), rules: provinceRulesPatchSchema.default({}) }),
  // 只重新划分被这些格盖住一半以上的省份；别处的省份编号、名字不变
  z.object({ op: z.literal('regenerate_provinces'), cells }),
  z.object({ op: z.literal('assign_province'), cells, province: z.union([z.number().int().min(0), z.literal('new')]) }),
  z.object({ op: z.literal('merge_province'), from: z.number().int(), into: z.number().int() }),
  z.object({ op: z.literal('split_province'), id: z.number().int() }),
  z.object({
    op: z.literal('set_province'),
    id: z.number().int(),
    name: z.string().optional(),
    locked: z.boolean().optional(),
    kind: z.enum(PROVINCE_KINDS).optional(),
  }),
  // 地名：key 为“类型:锚点格”；name 为空字符串时恢复自动命名
  z.object({ op: z.literal('rename_feature'), key: z.string().regex(/^\w+:\d+$/), name: z.string().max(40) }),
  z.object({ op: z.literal('reroll_feature'), key: z.string().regex(/^\w+:\d+$/) }),
  z.object({ op: z.literal('set_word_pack'), pack: wordPackSchema.nullable() }),
  // 用户的地名：圈一块（cells）或放一个点（kind = spot，at 为位置）；name 为空时按文字包自动起名
  z.object({ op: z.literal('add_region'), region: regionSchema.omit({ id: true }).extend({ id: z.string().optional() }) }),
  // 改名（空字符串恢复自动）、改类型、reroll 换一个自动的名字
  z.object({
    op: z.literal('update_region'),
    id: z.string(),
    name: z.string().max(40).optional(),
    kind: z.enum(REGION_KINDS).optional(),
    reroll: z.boolean().optional(),
  }),
  z.object({ op: z.literal('remove_region'), id: z.string() }),
] as const;

// provinceNames：命令执行时新起的省名（省份编号 → 名字），由引擎记下，重放、重做时照用
export type Command = (z.input<(typeof baseCommands)[number]> | { op: 'batch'; label?: string; commands: Command[] }) & { provinceNames?: Record<string, string> };

const single = z.discriminatedUnion('op', baseCommands);
export const commandSchema: z.ZodType<Command> = z.lazy(() =>
  z.union([single, z.object({ op: z.literal('batch'), label: z.string().optional(), commands: z.array(commandSchema) })]),
) as z.ZodType<Command>;

export class CommandError extends Error {}

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

type ArrayKey = 'landDelta' | 'upliftDelta' | 'erodDelta' | 'tempOffset' | 'moistOffset' | 'province' | `field:${string}`;

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
}

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).join('；');
}

export interface ApplyContext {
  // 需要推导结果的命令调用它，保证推导是最新的
  ensureDerived: () => Derived;
}

function touchedArrays(world: World, cmd: Command): ArrayKey[] {
  switch (cmd.op) {
    case 'set_worldgen':
      return ['landDelta', 'upliftDelta', 'erodDelta', 'province'];
    case 'set_coast_style':
    case 'paint_land':
    case 'add_island':
    case 'add_island_chain':
    case 'reroll_region':
      return ['landDelta', 'upliftDelta', 'province'];
    case 'paint_relief':
      return ['upliftDelta'];
    case 'restore_terrain':
      return ['landDelta', 'upliftDelta', 'erodDelta', 'province'];
    case 'restore_climate':
      return ['tempOffset', 'moistOffset'];
    case 'paint':
      return [cmd.field as ArrayKey];
    case 'generate_provinces':
    case 'regenerate_provinces':
    case 'assign_province':
    case 'merge_province':
    case 'split_province':
      return ['province'];
    case 'batch':
      return [...new Set(cmd.commands.flatMap((c) => touchedArrays(world, c)))];
    default:
      return [];
  }
}

// changed：命令有没有改动原因或小数据（没改动时推导也不会变）。
// provinceNames：这一步新起的省名。起名要看推导（河、山、冷暖），重放时推导还没算到这一步，起出来的名字可能
// 与当时不同，所以记进命令；命令里记着的就照用（旧存档没有记，照旧重放）
export function applyCommand(
  world: World,
  input: Command,
  ctx: ApplyContext,
): { dirty: Dirty; summary: string; undo: UndoRecord; changed: boolean; provinceNames: Record<string, string> | null } {
  const { provinceNames: stored, ...raw } = input;
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new CommandError(`命令参数无效：${formatIssues(parsed.error)}`);
  const cmd = parsed.data;
  const keys = touchedArrays(world, cmd).filter((k) => getArray(world, k));
  const before = keys.map((k) => Float64Array.from(getArray(world, k)!));
  const smallBefore = JSON.stringify(world.small);
  const fieldsBefore = { ...world.causes.fields };
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
  } catch (e) {
    // 失败时恢复，保证命令要么完整生效要么不生效
    keys.forEach((k, idx) => getArray(world, k)!.set(before[idx]));
    world.small = JSON.parse(smallBefore);
    world.causes.fields = fieldsBefore;
    throw e;
  }
  const undo: UndoRecord = { arrays: [], fields: [], small: smallBefore };
  keys.forEach((k, idx) => {
    const now = getArray(world, k)!;
    const old = before[idx];
    const changed: number[] = [];
    for (let i = 0; i < now.length; i++) if (now[i] !== old[i]) changed.push(i);
    if (changed.length) undo.arrays.push({ key: k, idx: Int32Array.from(changed), old: Float64Array.from(changed, (i) => old[i]) });
  });
  const names = new Set([...Object.keys(fieldsBefore), ...Object.keys(world.causes.fields)]);
  for (const name of names) if (fieldsBefore[name] !== world.causes.fields[name]) undo.fields.push({ name, old: fieldsBefore[name] ?? null });
  const changed = undo.arrays.length > 0 || undo.fields.length > 0 || JSON.stringify(world.small) !== smallBefore;
  const provinceNames: Record<string, string> = {};
  for (const [id, p] of Object.entries(world.small.provinces)) if (!idsBefore.has(id)) provinceNames[id] = p.name;
  return { ...result, undo, changed, provinceNames: Object.keys(provinceNames).length ? provinceNames : null };
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
  world.small = JSON.parse(undo.small) as SmallState;
  // 陆海、抬升等组合值由增量与生成参数算出，撤销后重新组合
  resolveTerrain(world);
}

// 重新组合地形；陆海变了就修补省份。返回新增与消失的陆地格数
function applyTerrain(world: World): { gained: number; lost: number } {
  const before = world.causes.land.slice();
  resolveTerrain(world);
  let gained = 0;
  let lost = 0;
  for (let i = 0; i < before.length; i++) {
    if (!before[i] && world.causes.land[i]) gained++;
    else if (before[i] && !world.causes.land[i]) lost++;
  }
  if (gained || lost) repairProvinces(world);
  return { gained, lost };
}

const nextId = (world: World, prefix: string) => `${prefix}-${world.small.nextId++}`;

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
      for (const c of cmd.commands) dirty = Math.max(dirty, run(world, c, ctx).dirty) as Dirty;
      return { dirty, summary: cmd.label ?? `批量 ${cmd.commands.length} 条` };
    }
    case 'set_worldgen': {
      const params = worldgenSchema.parse(cmd.params);
      if (cmd.reset) {
        causes.landDelta.fill(0);
        causes.upliftDelta.fill(0);
        causes.erodDelta.fill(0);
        causes.province.fill(-1);
        small.provinces = {};
        small.constraints = [];
        small.guides = [];
        small.lakes = [];
      }
      const prev = small.terrain.gen;
      small.terrain.gen = params;
      applyTerrain(world);
      if (cmd.reset || !prev) return { dirty: Dirty.Elevation, summary: `新世界：${WORLD_TYPE_INFO[params.type].name}` };
      const what = [
        prev.landFraction !== params.landFraction ? '陆地多少' : '',
        prev.islands !== params.islands ? '岛多少' : '',
        prev.mountains !== params.mountains ? '山多高' : '',
      ].filter(Boolean);
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
      const ch = applyTerrain(world);
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
      const ch = applyTerrain(world);
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
      const r = islandStamp(world, spec);
      if (!r.footprint.length) throw new CommandError('这里放不下岛（可能已经是陆地）');
      r.cells.forEach((i, k) => {
        causes.landDelta[i] += r.landDelta[k];
        causes.upliftDelta[i] += r.upliftDelta[k];
      });
      applyTerrain(world);
      return { dirty: Dirty.Elevation, summary: `放了一个${ISLAND_KIND_INFO[spec.kind].name}（直径约 ${roundKm(islandRadiusKm(world, spec.size) * 2)} km）` };
    }
    case 'add_island_chain': {
      const spec = chainSchema.parse(cmd.chain);
      const islands = chainIslands(world, spec);
      const r = combineStamps(world, islands);
      r.cells.forEach((i, k) => {
        causes.landDelta[i] += r.landDelta[k];
        causes.upliftDelta[i] += r.upliftDelta[k];
      });
      applyTerrain(world);
      return { dirty: Dirty.Elevation, summary: `画了一条岛链：${islands.length} 个${ISLAND_KIND_INFO[spec.kind].name}` };
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
      small.species.push(speciesSchema.parse(cmd.species));
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
      small.species[idx] = parsed.data;
      return { dirty: Dirty.Solve, summary: `修改了生态“${parsed.data.name || cmd.id}”` };
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
      small.constraints[idx] = parsed.data;
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
      for (let k = 0; k + 1 < cmd.guide.cells.length; k++) {
        const a = cmd.guide.cells[k];
        const b = cmd.guide.cells[k + 1];
        let adjacent = false;
        for (let e = mesh.off[a]; e < mesh.off[a + 1]; e++) if (mesh.adj[e] === b) adjacent = true;
        if (!adjacent) throw new CommandError(`河道路径第 ${k} 与第 ${k + 1} 格不相邻`);
      }
      const g = guideSchema.parse({ ...cmd.guide, id: cmd.guide.id ?? nextId(world, cmd.guide.locked ? 'lock' : 'river') });
      if (cmd.reroute) {
        // 原来那段河道不再留着（也就不再有白色虚线标记）
        const start = g.cells[0];
        small.guides = small.guides.flatMap((old) => {
          const k = old.cells.indexOf(start);
          if (k < 0 || k === old.cells.length - 1) return [old];
          return k === 0 ? [] : [{ ...old, cells: old.cells.slice(0, k + 1) }];
        });
      }
      small.guides.push(g);
      const km = roundKm(g.cells.length * mesh.spacing * world.kmPerUnit);
      const summary = cmd.label || (cmd.reroute ? `让河改道（约 ${km} km）` : g.spring ? `画了一条河（约 ${km} km）` : `固定了一段河道（约 ${km} km）`);
      return { dirty: Dirty.Elevation, summary };
    }
    case 'remove_guide': {
      const before = small.guides.length;
      small.guides = small.guides.filter((g) => g.id !== cmd.id);
      if (small.guides.length === before) throw new CommandError(`找不到河道 "${cmd.id}"`);
      return { dirty: Dirty.Elevation, summary: '删掉了一条画的河' };
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
      return { dirty: Dirty.None, summary: `自动划分省份：${Object.keys(small.provinces).length} 个` };
    }
    case 'regenerate_provinces': {
      checkCells(cmd.cells);
      const ids = regenTargets(world, cmd.cells);
      if (!ids.length) throw new CommandError('涂的范围要盖住省份的一大半，那个省份才会重新划分');
      const d = ctx.ensureDerived();
      const fresh = regenerateProvinces(world, d, ids);
      return { dirty: Dirty.None, summary: `重新划分了 ${ids.length} 个省份 → ${fresh.length} 个` };
    }
    case 'assign_province': {
      checkCells(cmd.cells);
      let id: number;
      const land = cmd.cells.length ? causes.land[cmd.cells[0]] === 1 : true;
      if (cmd.province === 'new') {
        // 新省份的类型随这些格原来所在省份的多数
        const kinds = new Map<ProvinceKind, number>();
        for (const i of cmd.cells) {
          const k = small.provinces[causes.province[i]]?.kind;
          if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1);
        }
        let kind: ProvinceKind = land ? 'land' : 'sea';
        let bk = 0;
        for (const [k, c] of kinds) if (c > bk && (k === 'sea') !== land) {
          bk = c;
          kind = k;
        }
        id = small.nextProvince++;
        small.provinces[id] = { name: '', locked: false, land, kind };
      } else {
        id = cmd.province;
        if (!small.provinces[id]) throw new CommandError(`找不到省份 ${id}`);
      }
      const meta = small.provinces[id];
      const wrong = cmd.cells.filter((i) => (causes.land[i] === 1) !== meta.land);
      if (wrong.length) throw new CommandError(`${wrong.length} 格与省份的陆海类别不符（${meta.land ? '陆地' : '海域'}省份）`);
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
      return { dirty: Dirty.None, summary: `拆分省份 ${meta.name || cmd.id}` };
    }
    case 'rename_feature': {
      const ov = { ...(small.featureNames[cmd.key] ?? {}) };
      if (cmd.name.trim()) ov.name = cmd.name.trim();
      else delete ov.name;
      small.featureNames = { ...small.featureNames, [cmd.key]: ov };
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
      }
      if (cmd.name !== undefined) next.name = cmd.name.trim();
      if (cmd.reroll) {
        next.name = '';
        next.salt = r.salt + 1;
      }
      small.regions = small.regions.map((x) => (x.id === r.id ? next : x));
      const summary = cmd.reroll
        ? '换了个名字'
        : next.kind !== r.kind
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
        if ((cmd.kind === 'sea') === meta.land) throw new CommandError(meta.land ? '陆地上的省份不能改成海域' : '海上的省份只能是海域');
        meta.kind = cmd.kind;
      }
      if (cmd.name !== undefined) meta.name = cmd.name;
      if (cmd.locked !== undefined) meta.locked = cmd.locked;
      const what = cmd.kind !== undefined ? `改成${PROVINCE_KIND_INFO[cmd.kind].name}` : cmd.locked !== undefined ? (cmd.locked ? '锁定' : '解锁') : '改名';
      return { dirty: Dirty.None, summary: `省份“${meta.name || cmd.id}”：${what}` };
    }
  }
}

