import type { Derived, SmallState, World } from '../world';
import { type Dimension, type Era, MAX_DIMENSIONS, cultureById, cultureGroupById, dimensionValues, popValueById, worldDimensions, worldEra } from '../human/era';
import { CommandError } from '../errors';
import type { Command } from './schema';
import { afterCountries, type ApplyContext, clearPop, Dirty, type RunResult } from './shared';
import { classAt, classCode, RETIRED_CLASSES } from '../human/terrain-class';
import { classLift, groundUnder, putLift, restoreLift } from '../human/class-ground';
import { RESOURCE_NONE, resourceAt, resourceCode } from '../human/resources';
import { missingNotes, type MissingScope } from '../content/missing';
import { defaultTotalPop, generateHumanSteps, humanBlockers, regenerateHuman, regenerateHumanSteps, ruleEra, stampedPacks } from '../human/generate';
import { drain } from '../progress';
import { clearCountries } from '../human/countries';
import { countryOf, mergeCountries, moveCapital, newCountry, paintCountry, removeCountry, setCountry, splitCountry, tidyCountries } from '../human/country-edit';
import { restoreCountry, restorePop } from '../human/auto';
import { BLOC_NAMES, blocById, setBloc } from '../human/blocs';
import { paintPop, type PopBrush, scalePop, setCellPop } from '../human/population';
import { fillPopulation } from '../human/add-dimension';
import { contentItems } from '../content/registry';
import { setContent } from './features';
import { groupInfo } from '../human/layers';
import { leaveLibrary } from './switch';

// 格的地形类别与资源、人文、国家、集团、人口的命令（第四十一轮从 commands.ts 原样搬来）

// 人数写成“4.0 亿”“35.2 万”“820”
export function popText(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return `${Math.round(n)}`;
}

export const countryLabel = (world: World, id: number) => `“${world.small.countries?.[id]?.name || id}”`;

// 群体里的文化、取值都要在世界里，维度要是这个时代的
export function checkTuple(small: SmallState, t: { culture: string; values: Record<string, string> }) {
  if (!cultureById(small, t.culture)) throw new CommandError(`世界里没有文化 "${t.culture}"`);
  const dims = new Set(worldDimensions(small).map((x) => x.id));
  for (const [dim, v] of Object.entries(t.values)) {
    if (!dims.has(dim)) throw new CommandError(`这个时代没有维度 "${dim}"`);
    if (popValueById(small, v)?.dimension !== dim) throw new CommandError(`维度 "${dim}" 没有取值 "${v}"`);
  }
}

// ---------- 内容（第二十轮，见 content/registry.ts） ----------

// 力度大于 0 的一笔（第五十八轮，见 human/class-ground.ts）。这种类别没写典型高度时返回 null：只改类别
function paintClassGround(world: World, cmd: Extract<Command, { op: 'set_cell_class' }>, strength: number, code: number, ctx: ApplyContext): RunResult | null {
  const { causes, small, mesh } = world;
  if (cmd.t && cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
  const tOf = (k: number) => cmd.t?.[k] ?? 0;
  const cells: number[] = [];
  const t: number[] = [];
  // 恢复自动：画过类别的格恢复，地面回去（和堆山的橡皮一样，中心回到生成时的样子）。没画过类别的格不动，堆过的山还在
  if (!code) {
    const arr = causes.terrainClass;
    cmd.cells.forEach((i, k) => {
      if (causes.land[i] && arr?.[i]) {
        cells.push(i);
        t.push(tOf(k));
      }
    });
    const moved = restoreLift(world, cells, t);
    if (arr) for (const i of cells) arr[i] = 0;
    return { dirty: moved ? Dirty.Elevation : Dirty.Human, summary: `地形类别恢复自动 · ${cells.length} 格` };
  }
  const kind = classAt(small, code)!;
  if (kind.height === undefined) return null;
  // 第一次执行：湖面上的格去掉（只涂干的陆地），记下这一笔下面的平均高度；重放、重做照用记下的
  const d = cmd.ground === undefined ? ctx.ensureDerived() : null;
  cmd.cells.forEach((i, k) => {
    if (causes.land[i] && (!d || d.lake[i] !== 1)) {
      cells.push(i);
      t.push(tOf(k));
    }
  });
  const ground = d ? groundUnder(cells, t, d.elevation) : cmd.ground!;
  if (cells.length) {
    const arr = (causes.terrainClass ??= new Uint8Array(mesh.n));
    for (const i of cells) arr[i] = code;
  }
  const moved = putLift(world, cells, classLift(world, cells, t, kind.height, strength, ground));
  return {
    dirty: moved ? Dirty.Elevation : Dirty.Human,
    summary: `地形类别“${kind.name}” · ${cells.length} 格 · 地面向 ${kind.height} m`,
    recorded: { cells, t, ground },
  };
}

// 格的地形类别与资源、人文、国家、集团、人口的命令（第四十一轮从 runOp 拆出来，case 原样）；不是这一类的命令返回 undefined
// 生成、重新生成人文和国家（第九十七轮从 runHumanOp 原样搬出，改成分阶段的）：生成的每一步之间停一下（yield），
// 见 human/generate.ts 的 generateHumanSteps。一口气走完（runHumanOp 里的 drain）与原来完全相同
const HUMAN_GEN_OPS = new Set<Command['op']>(['generate_human', 'regenerate_human', 'generate_countries', 'regenerate_countries']);
export const isHumanGen = (cmd: Command): boolean => HUMAN_GEN_OPS.has(cmd.op);
// 要推导时：引擎给了分阶段的（Engine.applySteps）就用它，重算的各步之间也能停
function* derivedOf(ctx: ApplyContext): Generator<void, Derived> {
  return ctx.derivedSteps ? yield* ctx.derivedSteps() : ctx.ensureDerived();
}
export function* runHumanGenSteps(world: World, cmd: Command, ctx: ApplyContext): Generator<void, RunResult | undefined> {
  const { small } = world;
  switch (cmd.op) {
    case 'generate_human': {
      const d = yield* derivedOf(ctx);
      const scopes: MissingScope[] = ['world', ...(cmd.countries ? (['countries'] as const) : []), ...(cmd.settlements ? (['settlements'] as const) : [])];
      // 第三十轮：缺了时代、文化时不生成（已有的人文去掉：生成是整个换掉），写明缺什么
      const blockers = humanBlockers(world, cmd);
      if (blockers.length) {
        if (small.human) clearPop(world);
        return { dirty: Dirty.Human, summary: '没有生成人文', skipped: [...blockers, ...missingNotes(small, ['world'])] };
      }
      const left = cmd.switchLibrary ? leaveLibrary(world, cmd.switchLibrary) : Dirty.None;
      const h = yield* generateHumanSteps(world, d, {
        packs: cmd.packs,
        groups: cmd.groups,
        seed: cmd.seed,
        ...(cmd.countries ? { countries: cmd.countries } : {}),
        ...(cmd.settlements ? { settlements: cmd.settlements } : {}),
      });
      afterCountries(world);
      const era = worldEra(small);
      const k = (small.countries ? ` · ${Object.keys(small.countries).length} 个国家` : '') + (cmd.settlements && small.cities ? ` · ${Object.keys(small.cities).length} 座城市` : '');
      const skipped = missingNotes(small, scopes);
      return { dirty: Math.max(Dirty.Human, left) as Dirty, summary: `生成人文“${era?.name ?? h.era}” · ${h.groups.length} 个文化组 · ${popText(h.totalPop)}${k}`, ...(skipped.length ? { skipped } : {}) };
    }
    case 'regenerate_human': {
      const h = small.human;
      if (!h) throw new CommandError('还没有生成人文');
      const blockers = humanBlockers(world, { packs: cmd.packs ?? stampedPacks(small).map((p) => [...p]), groups: cmd.groups ?? h.groups });
      if (blockers.length) throw new CommandError(blockers[0]);
      const d = yield* derivedOf(ctx);
      const left = cmd.switchLibrary ? leaveLibrary(world, cmd.switchLibrary) : Dirty.None;
      // 换了库：总人口按新时代的默认（和新世界一样），不留旧时代的；没换时用记着的（改过总人口的留着）
      const era = cmd.switchLibrary && cmd.packs ? ruleEra(small, cmd.packs) : undefined;
      const patch = { packs: cmd.packs, groups: cmd.groups, totalPop: era ? defaultTotalPop(world, d, era) : undefined, seed: cmd.seed, countries: cmd.countries };
      yield* regenerateHumanSteps(world, d, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { keepManual: cmd.keepManual ?? true });
      afterCountries(world);
      const skipped = missingNotes(small, ['world', ...(small.human?.countryRules ? (['countries'] as const) : [])]);
      return { dirty: Math.max(Dirty.Human, left) as Dirty, summary: '重新生成人文', ...(skipped.length ? { skipped } : {}) };
    }
    case 'generate_countries':
    case 'regenerate_countries': {
      const h = small.human;
      if (!h) throw new CommandError('还没有生成人文');
      if (cmd.op === 'regenerate_countries' && !h.countryRules) throw new CommandError('还没有生成国家');
      const blockers = humanBlockers(world, { packs: stampedPacks(small).map((p) => [...p]), groups: h.groups });
      if (blockers.length) throw new CommandError(blockers[0]);
      const d = yield* derivedOf(ctx);
      const rules = cmd.seed !== undefined ? { seed: cmd.seed } : {};
      // 生成：整个换掉（参数从默认起）；重新生成：按记着的参数，锁定的留着
      if (cmd.op === 'generate_countries') delete h.countryRules;
      yield* regenerateHumanSteps(world, d, { countries: rules }, { keepManual: true, keepLocked: cmd.op === 'regenerate_countries' ? (cmd.keepLocked ?? true) : false });
      afterCountries(world);
      const k = Object.keys(small.countries ?? {}).length;
      const skipped = missingNotes(small, ['countries']);
      return { dirty: Dirty.Human, summary: `${cmd.op === 'generate_countries' ? '生成' : '重新生成'}国家 · ${k} 个`, ...(skipped.length ? { skipped } : {}) };
    }
  }
  return undefined;
}

export function runHumanOp(world: World, cmd: Command, ctx: ApplyContext): RunResult | undefined {
  const { causes, small, mesh } = world;
  const n = mesh.n;
  const checkCells = (list: number[]) => {
    const bad = list.find((i) => i >= n);
    if (bad !== undefined) throw new CommandError(`格编号 ${bad} 超出范围（共 ${n} 格）`);
  };
  switch (cmd.op) {
    case 'set_cell_class': {
      checkCells(cmd.cells);
      // 第二十七轮以前的植被类别（森林、沙漠……现在是生态）：世界里没有同 id 的类别时恢复自动
      const retired = cmd.class !== null && RETIRED_CLASSES.has(cmd.class) && !classCode(small, cmd.class);
      const code = cmd.class === null || retired ? 0 : classCode(small, cmd.class);
      if (cmd.class !== null && !retired && !code) throw new CommandError(`世界里没有地形类别 "${cmd.class}"`);
      // 力度大于 0（第五十八轮）：地面跟着变。这种类别没写典型高度时往下走，只改类别
      if (cmd.strength) {
        const r = paintClassGround(world, cmd, cmd.strength, code, ctx);
        if (r) return r;
      }
      const land = cmd.cells.filter((i) => causes.land[i]);
      if (land.length && (code || causes.terrainClass)) {
        const arr = (causes.terrainClass ??= new Uint8Array(n));
        for (const i of land) arr[i] = code;
      }
      const name = classAt(small, code)?.name;
      return { dirty: Dirty.Human, summary: name ? `地形类别“${name}” · ${land.length} 格` : `地形类别恢复自动 · ${land.length} 格` };
    }
    case 'set_cell_resource': {
      checkCells(cmd.cells);
      const code = cmd.resource === null ? 0 : cmd.resource === 'none' ? RESOURCE_NONE : resourceCode(small, cmd.resource);
      if (cmd.resource !== null && !code) throw new CommandError(`世界里没有资源 "${cmd.resource}"`);
      const land = cmd.cells.filter((i) => causes.land[i]);
      if (land.length && (code || causes.resource)) {
        const arr = (causes.resource ??= new Uint8Array(n));
        for (const i of land) arr[i] = code;
      }
      const name = resourceAt(small, code)?.name;
      const what = name ? `资源“${name}”` : code === RESOURCE_NONE ? '去掉资源' : '资源恢复自动';
      return { dirty: Dirty.Human, summary: `${what} · ${land.length} 格` };
    }
    case 'set_cell': {
      checkCells([cmd.cell]);
      const meta = { ...(small.cells?.[cmd.cell] ?? {}) };
      let summary = '修改格的档案';
      if (cmd.name !== undefined) {
        const name = cmd.name?.trim();
        if (name) meta.name = name;
        else delete meta.name;
        summary = name ? `改名为“${name}”` : '名字恢复自动';
      }
      // 原文跟着自己起的名字；只改中文名时去掉
      if (cmd.name !== undefined || cmd.orig !== undefined) {
        const orig = cmd.orig?.trim();
        if (orig && meta.name) meta.orig = orig;
        else delete meta.orig;
        if (cmd.name === undefined) summary = orig ? `原文改为“${orig}”` : '去掉原文';
      }
      if (cmd.salt !== undefined || cmd.reroll) {
        delete meta.name;
        delete meta.orig;
        const salt = cmd.salt ?? (meta.salt ?? 0) + 1;
        if (salt) meta.salt = salt;
        else delete meta.salt;
        summary = '换名字';
      }
      if (cmd.note !== undefined) {
        const note = cmd.note?.trim();
        if (note) meta.note = note;
        else delete meta.note;
        summary = note ? '写备注' : '删除备注';
      }
      const cellsMeta = { ...small.cells };
      if (Object.keys(meta).length) cellsMeta[cmd.cell] = meta;
      else delete cellsMeta[cmd.cell];
      if (Object.keys(cellsMeta).length) small.cells = cellsMeta;
      else delete small.cells;
      return { dirty: Dirty.None, summary };
    }
    case 'generate_human':
    case 'regenerate_human':
    case 'generate_countries':
    case 'regenerate_countries':
      return drain(runHumanGenSteps(world, cmd, ctx));
    case 'remove_countries': {
      if (!small.countries) throw new CommandError('还没有生成国家');
      // 第六十二轮：政体、派系留在世界里（世界保留全部内容，导入的、改过的不该跟着没了），不想要时“清理没用到的”
      clearCountries(world);
      return { dirty: Dirty.Human, summary: '删除国家' };
    }
    case 'paint_country': {
      checkCells(cmd.cells);
      if (!small.countries) throw new CommandError('还没有国家');
      const k = paintCountry(world, cmd.cells, cmd.country);
      afterCountries(world);
      return { dirty: Dirty.Human, summary: cmd.country === null ? `无主地 · ${k} 格` : `领土${countryLabel(world, cmd.country)} · ${k} 格` };
    }
    case 'restore_country': {
      checkCells(cmd.cells);
      if (!small.countries) throw new CommandError('还没有国家');
      const k = restoreCountry(world, cmd.cells);
      afterCountries(world);
      return { dirty: Dirty.Human, summary: `领土恢复自动 · ${k} 格` };
    }
    case 'new_country': {
      if (cmd.cells) checkCells(cmd.cells);
      const id = newCountry(world, { cells: cmd.cells, name: cmd.name, orig: cmd.orig, culture: cmd.culture, government: cmd.government, color: cmd.color, flag: cmd.flag });
      afterCountries(world);
      return { dirty: Dirty.Human, summary: `新建国家${countryLabel(world, id)}${cmd.cells?.length ? ` · ${cmd.cells.length} 格` : ''}` };
    }
    case 'merge_countries': {
      const a = countryLabel(world, cmd.a);
      const b = countryLabel(world, cmd.b);
      mergeCountries(world, cmd.a, cmd.b);
      afterCountries(world);
      return { dirty: Dirty.Human, summary: `合并国家${b} → ${a}` };
    }
    case 'split_country': {
      if (cmd.cells) checkCells(cmd.cells);
      const name = countryLabel(world, cmd.id);
      const id = splitCountry(world, cmd.id, cmd.cells);
      afterCountries(world);
      return { dirty: Dirty.Human, summary: `拆分国家${name} · 分出${countryLabel(world, id)}` };
    }
    case 'set_country': {
      countryOf(world, cmd.id);
      const what = setCountry(world, cmd.id, cmd.patch);
      tidyCountries(world);
      return { dirty: Dirty.Human, summary: `国家${countryLabel(world, cmd.id)} · ${what.join('、') || '修改'}` };
    }
    case 'remove_country': {
      const name = countryLabel(world, cmd.id);
      removeCountry(world, cmd.id);
      afterCountries(world);
      return { dirty: Dirty.Human, summary: `删除国家${name}` };
    }
    case 'set_bloc': {
      const before = cmd.id !== undefined ? blocById(small, cmd.id) : undefined;
      const label = before ? `${BLOC_NAMES[before.kind]}“${before.name}”` : '';
      const { id, what } = setBloc(world, cmd.id, cmd.patch);
      const b = blocById(small, id);
      if (cmd.patch === null) return { dirty: Dirty.Human, summary: `删除${label}` };
      if (cmd.id === undefined) return { dirty: Dirty.Human, summary: `新建${b ? `${BLOC_NAMES[b.kind]}“${b.name}”` : '集团'} · ${b?.members.length ?? 0} 国` };
      return { dirty: Dirty.Human, summary: `${b ? `${BLOC_NAMES[b.kind]}“${b.name}”` : label} · ${what.join('、') || '修改'}` };
    }
    case 'move_capital': {
      if (cmd.cell !== null) checkCells([cmd.cell]);
      moveCapital(world, cmd.id, cmd.cell);
      return { dirty: Dirty.Human, summary: cmd.cell === null ? `首都恢复自动 · ${countryLabel(world, cmd.id)}` : `挪动首都 · ${countryLabel(world, cmd.id)}` };
    }
    case 'move_hearth': {
      const h = small.human;
      if (!h) throw new CommandError('还没有生成人文');
      if (!cmd.group === !cmd.culture) throw new CommandError('写 group 或 culture 中的一个');
      if (cmd.cell !== null) {
        checkCells([cmd.cell]);
        if (!causes.land[cmd.cell]) throw new CommandError('发源地要在陆地上');
      }
      const list = h.hearths.filter((x) => (cmd.culture ? x.culture === cmd.culture : x.group === cmd.group && !x.culture));
      const target = list[cmd.index ?? 0];
      if (!target) throw new CommandError(cmd.culture ? `没有文化“${cmd.culture}”的发源地` : `没有文化组“${cmd.group}”的发源地`);
      if (cmd.cell === null) delete target.locked;
      else {
        target.cell = cmd.cell;
        target.locked = true;
      }
      const d = ctx.ensureDerived();
      regenerateHuman(world, d, {}, { keepManual: cmd.keepManual ?? true });
      afterCountries(world);
      const name = cmd.culture ? (cultureById(small, cmd.culture)?.name ?? cmd.culture) : (cultureGroupById(small, cmd.group!)?.name ?? cmd.group!);
      return { dirty: Dirty.Human, summary: cmd.cell === null ? `发源地“${name}”恢复自动` : `挪动发源地“${name}”` };
    }
    case 'remove_human': {
      if (!small.human) throw new CommandError('还没有生成人文');
      // 第六十二轮：时代、取值、文化……留在世界里，同上
      clearPop(world);
      return { dirty: Dirty.Human, summary: '删除人文' };
    }
    case 'set_pop_total': {
      if (!small.human) throw new CommandError('还没有生成人文');
      scalePop(world, cmd.total);
      return { dirty: Dirty.Human, summary: `总人口 · ${popText(cmd.total)}` };
    }
    case 'paint_pop':
    case 'paint_culture': {
      checkCells(cmd.cells);
      if (!small.human) throw new CommandError('还没有生成人文');
      if (cmd.t && cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      let brush: PopBrush;
      let what: string;
      if (cmd.op === 'paint_culture') {
        const c = cultureById(small, cmd.culture);
        if (!c) throw new CommandError(`世界里没有文化 "${cmd.culture}"`);
        brush = { mode: 'culture', culture: cmd.culture, amount: cmd.amount, ...(cmd.typical ? { typical: true } : {}) };
        what = `文化“${c.name}”`;
      } else if (cmd.mode === 'clear') {
        brush = { mode: 'clear' };
        what = '清空人口';
      } else if (cmd.mode === 'count') {
        if (cmd.factor === undefined) throw new CommandError('改人数要写 factor');
        brush = { mode: 'count', factor: cmd.factor };
        what = `人数 ×${cmd.factor >= 1 ? cmd.factor.toFixed(2).replace(/\.?0+$/, '') : cmd.factor.toFixed(2)}`;
      } else if (cmd.mode === 'share') {
        if (!cmd.group || cmd.amount === undefined) throw new CommandError('改成分要写 group 与 amount');
        checkTuple(small, cmd.group);
        brush = { mode: 'share', group: cmd.group, amount: cmd.amount };
        what = `人口“${groupInfo(world, 0, cmd.group).label}”${cmd.amount < 0 ? '减少' : ''}`;
      } else {
        if (!cmd.dimension || !cmd.value || cmd.amount === undefined) throw new CommandError('改一个维度要写 dimension、value 与 amount');
        const dim = worldDimensions(small).find((x) => x.id === cmd.dimension);
        if (!dim) throw new CommandError(`这个时代没有维度 "${cmd.dimension}"`);
        const v = dimensionValues(small, dim.id).find((x) => x.id === cmd.value);
        if (!v) throw new CommandError(`${dim.label}没有 "${cmd.value}"`);
        brush = { mode: 'value', dimension: dim.id, value: v.id, amount: cmd.amount };
        what = cmd.amount < 0 ? `${dim.label}“${v.name}”减少` : `${dim.label}改为“${v.name}”`;
      }
      const d = ctx.ensureDerived();
      const k = paintPop(world, d, cmd.cells, cmd.t, brush);
      return { dirty: Dirty.Human, summary: `${what} · ${k} 格` };
    }
    case 'restore_pop': {
      checkCells(cmd.cells);
      if (!small.human) throw new CommandError('还没有生成人文');
      const k = restorePop(world, cmd.cells);
      return { dirty: Dirty.Human, summary: `人口恢复自动 · ${k} 格` };
    }
    case 'set_cell_pop': {
      checkCells([cmd.cell]);
      if (!small.human) throw new CommandError('还没有生成人文');
      if (!causes.land[cmd.cell]) throw new CommandError('海上没有人口');
      for (const g of cmd.groups ?? []) checkTuple(small, g);
      setCellPop(world, cmd.cell, cmd.total, cmd.groups);
      return { dirty: Dirty.Human, summary: cmd.total !== undefined && !cmd.groups ? `人口改为 ${popText(cmd.total)}` : '修改人口' };
    }
    case 'add_dimension': {
      const eras = contentItems<Era>(small, 'era');
      const id = cmd.era ?? small.human?.era ?? (Object.keys(eras).length === 1 ? Object.keys(eras)[0] : undefined);
      const era = id ? eras[id] : undefined;
      if (!era) throw new CommandError(cmd.era ? `世界里没有时代 "${cmd.era}"` : '世界里没有时代，或者有几个时代，要写明加到哪一个');
      const { id: dimId, label } = cmd.dimension;
      if (era.dimensions.some((x) => x.id === dimId)) throw new CommandError(`时代“${era.name}”已经有“${label}”了`);
      if (era.dimensions.length >= MAX_DIMENSIONS) throw new CommandError(`一个时代最多 ${MAX_DIMENSIONS} 个变量`);
      // required：文化没写倾向时按平均；added：之后生成也原地分开（见 add-dimension.ts）
      const dim: Dimension = { id: dimId, label, required: true, added: true };
      // 是人文用的时代时把现有的人分开；别的时代（换库时带到新时代，第五十二轮的 switch.ts）只多一维
      const fill = small.human?.era === era.id && !!causes.popGroup && !!causes.popShare;
      const count = dimensionValues(small, dimId).length;
      if (fill && !count) throw new CommandError(`世界里没有“${label}”的取值`);
      const d = fill ? ctx.ensureDerived() : null;
      setContent(world, 'era', era.id, { ...era, dimensions: [...era.dimensions, dim] });
      if (fill) fillPopulation(world, d!, era.id, dim);
      return { dirty: Dirty.Human, summary: `加变量“${label}” · ${count} 种` };
    }
  }
}

