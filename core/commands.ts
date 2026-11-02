// 所有编辑都是可序列化的命令。命令只改“原因”，并且只保存明确的格编号，
// 所以重放结果与当时界面上的推导状态无关（例外：generate_provinces 需要当时的水文与高程，引擎会先把推导算好）。
// 第四十一轮拆成 commands/ 下几个文件（代码原样搬）：schema 命令的格式（baseCommands 的先后不要调换）、shared 共用的、
// 每类命令一个文件（terrain、nature、provinces、features、human、settlements，各有一个 runXxxOp）。
// 这里留 applyCommand（校验、撤销记录、内容的增减）、revert、addArrayUndo、runOp（批量、整理本世界，其余依次问各类），并照旧导出全部。
// 加一种命令：schema.ts 的 baseCommands 加格式，对应类别的 runXxxOp 加 case，改了人文的数组的在下面 touchedArrays 里登记
import { type Command, commandSchema, nameCarrySchema, popFixSchema, provinceFixSchema } from './commands/schema';
import './content/kinds';
import { allKinds, itemId, itemName, kindOf } from './content/registry';
import { originTarget, recordedOrigin, setOrigin, tidyOrigins } from './content/origin';
import { type ContentRef, refName, removeCommand, unusedContent } from './content/unused';
import { CommandError } from './errors';
import { applyNameCarry } from './features';
import { applyPopFix } from './human/population';
import { tidyCities } from './human/settlements';
import { applyProvinceFix } from './provinces';
import { copySmall, restoreSmall, sameAsCopy } from './small-copy';
import { resolveTerrain } from './terrain';
import type { SmallState, World } from './world';
import { type ApplyContext, type ArrayKey, AUTO_ARRAYS, Dirty, formatIssues, getArray, HUMAN_ARRAYS, POP_ARRAYS, type RemovedItem, type RunResult, type UndoRecord } from './commands/shared';
import { runFeatureOp } from './commands/features';
import { runHumanOp } from './commands/human';
import { runNatureOp } from './commands/nature';
import { runProvinceOp } from './commands/provinces';
import { runSettlementOp } from './commands/settlements';
import { runTerrainOp } from './commands/terrain';
export { type GuidePatch, type LakePatch, type Command, commandSchema } from './commands/schema';
export { Dirty, type UndoRecord, type ApplyContext, type RemovedItem } from './commands/shared';
export { popText } from './commands/human';
export { truncateGuide, guideDirty } from './commands/nature';
export { postedSmall } from './small-copy';

// 在 errors.ts 里（避免循环引用），这里照旧导出
export { CommandError };

function touchedArrays(world: World, cmd: Command): ArrayKey[] {
  switch (cmd.op) {
    case 'set_worldgen':
      return ['landDelta', 'upliftDelta', 'erodDelta', 'province', 'islandType', 'islandHeight', 'fragment', 'terrainClass', 'resource', ...POP_ARRAYS, 'country', ...AUTO_ARRAYS];
    case 'generate_human':
    case 'regenerate_human':
    case 'move_hearth':
    case 'remove_human':
    case 'generate_countries':
    case 'regenerate_countries':
      return [...POP_ARRAYS, 'country', 'province', ...AUTO_ARRAYS];
    case 'set_pop_total':
    case 'paint_pop':
    case 'paint_culture':
    case 'set_cell_pop':
    case 'restore_pop':
      return [...POP_ARRAYS];
    case 'remove_countries':
    case 'paint_country':
    case 'restore_country':
    case 'new_country':
    case 'merge_countries':
    case 'split_country':
    case 'set_country':
    case 'remove_country':
    case 'move_capital':
      return ['country', 'province'];
    case 'paint_land':
    case 'add_island':
    case 'add_island_chain':
    case 'restore_terrain':
    case 'fragment':
      return ['landDelta', 'upliftDelta', 'erodDelta', 'province', 'islandType', 'islandHeight', 'fragment', 'country'];
    case 'set_cell_class':
      return ['terrainClass'];
    case 'set_cell_resource':
      return ['resource'];
    case 'set_content':
    case 'order_content':
      return [...(kindOf(cmd.kind)?.arrays ?? [])];
    // 整理本世界：移出的种类里有画格的（地形类别、资源）才有数组；自定义场按场的记法单独记
    case 'tidy_content':
      return [...new Set((cmd.items ?? []).flatMap((x) => kindOf(x.kind)?.arrays ?? []))];
    case 'set_coast_style':
      return ['landDelta', 'upliftDelta', 'erodDelta', 'province', 'country'];
    case 'set_island_type':
    case 'remove_island_type':
      return ['islandType', 'province'];
    case 'reroll_region':
      return ['landDelta', 'upliftDelta', 'province', 'country'];
    case 'paint_relief':
      return ['upliftDelta'];
    case 'restore_climate':
      return ['tempOffset', 'moistOffset'];
    case 'paint':
      return [cmd.field as ArrayKey];
    case 'generate_provinces':
    case 'regenerate_provinces':
    case 'set_lake_mode':
    case 'split_province':
    case 'cut_province':
      return ['province'];
    // 有国家时：涂进、并进的格跟着省份换国家（第二十三轮）
    case 'assign_province':
    case 'merge_province':
      return ['province', 'country'];
    case 'batch':
      return [...new Set(cmd.commands.flatMap((c) => touchedArrays(world, c)))];
    default:
      return [];
  }
}

// 世界里的各项内容（按种类）：放在 small.content 的种类记那一种的对象（不可变，改了就是新对象，没变的这一步不用比）；
// 以前的种类按原来的放法，当时就按 id 列好（数组可能就地改）。星球形态不算（换形态不是移出）
type KindItems = Map<string, unknown>;
type ContentBefore = Map<string, Record<string, unknown> | KindItems>;
const NO_ITEMS: Record<string, unknown> = {};
function contentSnapshot(world: World): ContentBefore {
  const out: ContentBefore = new Map();
  for (const k of allKinds()) {
    if (k.id === 'planetForm') continue;
    out.set(k.id, k.store === 'content' ? (world.small.content?.[k.id] ?? NO_ITEMS) : new Map(k.inWorld(world).map((x) => [itemId(k, x), x])));
  }
  return out;
}

// 前后两份比较：移出的项、新加的项（按种类的登记先后，同一种按世界里的先后）
function contentDiff(world: World, before: ContentBefore, originBefore: SmallState['origin']): { removed: RemovedItem[]; added: ContentRef[] } {
  const after = contentSnapshot(world);
  const removed: RemovedItem[] = [];
  const added: ContentRef[] = [];
  for (const [kind, wasAll] of before) {
    const nowAll = after.get(kind)!;
    if (nowAll === wasAll) continue;
    const k = kindOf(kind)!;
    const itemsOf = (v: Record<string, unknown> | KindItems): KindItems => (v instanceof Map ? v : new Map(Object.values(v).map((x) => [itemId(k, x), x])));
    const was = itemsOf(wasAll);
    const now = itemsOf(nowAll);
    for (const [id, item] of was) {
      if (now.has(id)) continue;
      const origin = originBefore ? recordedOrigin({ origin: originBefore }, kind, id) : undefined;
      removed.push({ kind, id, name: itemName(k, item), item: structuredClone(item), ...(origin ? { origin: [...origin] } : {}) });
    }
    for (const id of now.keys()) if (!was.has(id)) added.push({ kind, id });
  }
  return { removed, added };
}

// changed：命令有没有改动原因或小数据（没改动时推导也不会变）。
// provinceNames：这一步新起的省名。起名要看推导（河、山、冷暖），重放时推导还没算到这一步，起出来的名字可能
// 与当时不同，所以记进命令；命令里记着的就照用（没有记的：这一步没有新起的省名）
export function applyCommand(
  world: World,
  input: Command,
  ctx: ApplyContext,
): {
  dirty: Dirty;
  summary: string;
  undo: UndoRecord;
  changed: boolean;
  provinceNames: Record<string, string> | null;
  provinceOrig: Record<string, string> | null;
  // 第二十九轮：这一步移出、新加的内容
  removed: RemovedItem[];
  added: ContentRef[];
  // 第三十轮：缺了内容跳过的步骤（“没有城市等级：没有放城市和道路”……），界面显示一次
  skipped: string[];
} {
  const { provinceNames: stored, provinceOrig: storedOrig, nameCarry: carryInput, provinceFix: fixInput, popFix: popInput, ...raw } = input;
  const carry = carryInput === undefined ? undefined : nameCarrySchema.safeParse(carryInput);
  if (carry && !carry.success) throw new CommandError(`命令里的地名无效：${formatIssues(carry.error)}`);
  const nameCarry = carry?.data;
  const fixParsed = fixInput === undefined ? undefined : provinceFixSchema.safeParse(fixInput);
  if (fixParsed && !fixParsed.success) throw new CommandError(`命令里的省份整理无效：${formatIssues(fixParsed.error)}`);
  const provinceFix = fixParsed?.data;
  if (provinceFix && provinceFix.cells.some((c) => c >= world.mesh.n)) throw new CommandError('命令里的省份整理不属于这张地图');
  const popParsed = popInput === undefined ? undefined : popFixSchema.safeParse(popInput);
  if (popParsed && !popParsed.success) throw new CommandError(`命令里的人口修补无效：${formatIssues(popParsed.error)}`);
  const popFix = popParsed?.data;
  if (popFix && popFix.cells.some((c) => c >= world.mesh.n)) throw new CommandError('命令里的人口修补不属于这张地图');
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new CommandError(`命令参数无效：${formatIssues(parsed.error)}`);
  const cmd = parsed.data;
  const touched = touchedArrays(world, cmd);
  if (provinceFix && !touched.includes('province')) touched.push('province');
  if (popFix) for (const k of POP_ARRAYS) if (!touched.includes(k)) touched.push(k);
  const keys = touched.filter((k) => getArray(world, k));
  const before = keys.map((k) => Float64Array.from(getArray(world, k)!));
  const smallBefore = copySmall(world.small);
  const fieldsBefore = { ...world.causes.fields };
  const heightsBefore = world.causes.islandHeight;
  const fragmentBefore = world.causes.fragment;
  const humanBefore = HUMAN_ARRAYS.filter((k) => world.causes[k]);
  const idsBefore = new Set(Object.keys(world.small.provinces));
  const contentBefore = contentSnapshot(world);
  const originBefore = world.small.origin;
  let result: RunResult;
  try {
    result = run(world, cmd, ctx);
    // 第二十四轮：有城市时每步之后整理（首都格上有城市、挂着连着的城市还在）
    if (world.small.cities) tidyCities(world);
    if (stored) {
      for (const [id, name] of Object.entries(stored)) {
        const p = world.small.provinces[Number(id)];
        if (!p || idsBefore.has(id)) continue;
        p.name = name;
        // 原文跟着记下的名字（没记原文的名字没有原文）
        const orig = storedOrig?.[id];
        if (orig) p.orig = orig;
        else delete p.orig;
      }
    }
    if (nameCarry) applyNameCarry(world.small, nameCarry);
    if (provinceFix) applyProvinceFix(world, provinceFix);
    if (popFix) applyPopFix(world, popFix);
    // 第二十九轮：不在世界里了的项，来源一起去掉
    tidyOrigins(world);
  } catch (e) {
    // 失败时恢复，保证命令要么完整生效要么不生效
    keys.forEach((k, idx) => getArray(world, k)!.set(before[idx]));
    world.small = restoreSmall(smallBefore);
    world.causes.fields = fieldsBefore;
    if (!heightsBefore) delete world.causes.islandHeight;
    if (!fragmentBefore) delete world.causes.fragment;
    for (const k of HUMAN_ARRAYS) if (!humanBefore.includes(k)) delete world.causes[k];
    throw e;
  }
  const undo: UndoRecord = { arrays: [], fields: [], ...smallBefore };
  if (!heightsBefore && world.causes.islandHeight) undo.dropHeights = true;
  if (!fragmentBefore && world.causes.fragment) undo.dropFragment = true;
  const created = HUMAN_ARRAYS.filter((k) => world.causes[k] && !humanBefore.includes(k));
  if (created.length) undo.dropArrays = created;
  keys.forEach((k, idx) => {
    const now = getArray(world, k)!;
    const old = before[idx];
    const changed: number[] = [];
    for (let i = 0; i < now.length; i++) if (now[i] !== old[i]) changed.push(i);
    if (changed.length) undo.arrays.push({ key: k, idx: Int32Array.from(changed), old: Float64Array.from(changed, (i) => old[i]) });
  });
  const names = new Set([...Object.keys(fieldsBefore), ...Object.keys(world.causes.fields)]);
  for (const name of names) if (fieldsBefore[name] !== world.causes.fields[name]) undo.fields.push({ name, old: fieldsBefore[name] ?? null });
  const changed = undo.arrays.length > 0 || undo.fields.length > 0 || !!undo.dropHeights || !!undo.dropFragment || !!undo.dropArrays || !sameAsCopy(world.small, smallBefore);
  // 什么都没改（比如把一项改成一模一样的）：内容换回原来的对象（一字不差），之后接着共用、缓存照样命中
  if (!changed && smallBefore.content !== undefined) world.small.content = smallBefore.content;
  const provinceNames: Record<string, string> = {};
  const provinceOrig: Record<string, string> = {};
  for (const [id, p] of Object.entries(world.small.provinces)) {
    // 记下的湖与陆地的整理（provinceFix）加的省份不算这一步新起的：执行时它们是推导算好之后才加的，不在 provinceNames 里
    // （第三十二轮：新建的世界一开始就有湖省时，重放出来的命令多了这几个名字）
    if (idsBefore.has(id) || (provinceFix && id in provinceFix.add)) continue;
    provinceNames[id] = p.name;
    if (p.orig) provinceOrig[id] = p.orig;
  }
  const { removed, added } = contentDiff(world, contentBefore, originBefore);
  return {
    ...result,
    skipped: result.skipped ?? [],
    undo,
    changed,
    removed,
    added,
    provinceNames: Object.keys(provinceNames).length ? provinceNames : null,
    provinceOrig: Object.keys(provinceOrig).length ? provinceOrig : null,
  };
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
  if (undo.dropFragment) delete world.causes.fragment;
  for (const k of undo.dropArrays ?? []) delete world.causes[k];
  world.small = restoreSmall(undo);
  // 陆海、抬升等组合值由增量与生成参数算出，撤销后重新组合
  resolveTerrain(world);
}

function run(world: World, cmd: Command, ctx: ApplyContext): RunResult {
  const r = runOp(world, cmd, ctx);
  const from = (cmd as { from?: string[] }).from;
  const target = from ? originTarget(cmd) : null;
  if (target) setOrigin(world.small, target.kind, target.id, from!, (cmd as { fromId?: string }).fromId);
  return r;
}

// 整理本世界（tidy_content）：逐项用“移出”的那条命令（与资源库里移出一样：生态、河湖的种类、场照旧的删法，其余 set_content）
function tidyContent(world: World, items: readonly ContentRef[] | undefined, ctx: ApplyContext): { dirty: Dirty; summary: string } {
  const list = items ?? unusedContent({ small: world.small, causes: world.causes, derived: ctx.ensureDerived() });
  let dirty: Dirty = Dirty.None;
  const names: string[] = [];
  for (const ref of list) {
    const k = kindOf(ref.kind);
    if (!k) throw new CommandError(`不认识的内容种类 "${ref.kind}"`);
    if (!k.inWorld(world).some((x) => itemId(k, x) === ref.id)) continue;
    names.push(refName(world, ref));
    dirty = Math.max(dirty, runOp(world, removeCommand(ref), ctx).dirty) as Dirty;
  }
  const more = names.length > 3 ? ` 等 ${names.length} 项` : '';
  return { dirty, summary: names.length ? `整理本世界 · 移出${names.slice(0, 3).map((x) => `“${x}”`).join('、')}${more}` : '整理本世界 · 没有要移出的' };
}

function runOp(world: World, cmd: Command, ctx: ApplyContext): RunResult {
  switch (cmd.op) {
    case 'batch': {
      let dirty: Dirty = Dirty.None;
      const skipped: string[] = [];
      const inner = { ...ctx, inBatch: true };
      for (const c of cmd.commands) {
        const r = run(world, c, inner);
        dirty = Math.max(dirty, r.dirty) as Dirty;
        for (const x of r.skipped ?? []) if (!skipped.includes(x)) skipped.push(x);
      }
      return { dirty, summary: cmd.label ?? `批量 · ${cmd.commands.length} 条`, ...(skipped.length ? { skipped } : {}) };
    }
    case 'tidy_content':
      return tidyContent(world, cmd.items, ctx);
  }
  return (runTerrainOp(world, cmd, ctx) ?? runNatureOp(world, cmd, ctx) ?? runProvinceOp(world, cmd, ctx) ?? runFeatureOp(world, cmd, ctx) ?? runHumanOp(world, cmd, ctx) ?? runSettlementOp(world, cmd, ctx)) as RunResult;
}
