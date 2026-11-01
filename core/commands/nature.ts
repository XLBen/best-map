import { constraintSchema, FREE_HEIGHT, type Guide, guideSchema, lakeSchema, type World } from '../world';
import { ISLAND_CODE_MASK, islandCode, islandTypeDirty, islandTypeSchema, islandTypesOf, MAX_ISLAND_TYPES, provinceLand, removeIslandCode } from '../island-types';
import { repairProvinces } from '../provinces';
import { type Species, speciesSchema } from '../species';
import { type ApplyContext, Dirty, formatIssues, nextId, type RunResult } from './shared';
import { namesNaturally } from '../features';
import type { Mesh } from '../mesh';
import type { Command } from './schema';
import { CommandError } from '../errors';
import { cutPathAtCell, ownsCell } from '../rivers';
import { checkSpeciesScripts } from '../biome-scripts';
import { roundKm } from '../terrain';
import { checkRiverTypeScripts, MAX_RIVER_TYPES, riverTypeDirty, riverTypeSchema } from '../river-types';
import { checkLakeTypeScripts, lakeTypeDirty, lakeTypeSchema, MAX_LAKE_TYPES } from '../lake-types';

// 生态、约束、画的河、河湖与岛的种类、自定义场的命令（第四十一轮从 commands.ts 原样搬来）

// 湖里有没有这一种岛（定了高度、记着这一种的格）
export function hasLakeIsles(world: World, code: number): boolean {
  const fixed = world.causes.islandHeight;
  if (!fixed || !code) return false;
  const types = world.causes.islandType;
  for (let i = 0; i < fixed.length; i++) if (fixed[i] !== FREE_HEIGHT && (types[i] & ISLAND_CODE_MASK) === code) return true;
  return false;
}

// 岛的种类改了归哪种省、删了一种之后：省份按格分的陆海变了的格换到对的省份里（与陆海变了时一样就近修补）
export function refileProvinces(world: World, classBefore: Uint8Array) {
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
export const LOOK_KEYS = new Set(['visual']);
export const NAME_KEYS = new Set(['visual', 'name', 'feature']);
export function speciesChange(before: Species, after: Species): { dirty: Dirty; what: string } {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const only = (k: string) => changed.length > 0 && changed.every((x) => x === k);
  const what = only('visual') ? ' · 外观' : only('feature') ? ' · 地名' : only('scripts') ? ' · 脚本' : only('effects') ? ' · 对周围的影响' : '';
  if (changed.every((k) => LOOK_KEYS.has(k))) return { dirty: Dirty.None, what };
  // 带脚本的生态改名也从求解重算：脚本出错的说明（d.scriptIssues）里有它的名字，要与重放一致（脚本本身记着结果，不重跑）
  if (changed.includes('name') && (before.scripts || after.scripts)) return { dirty: Dirty.Solve, what };
  // 加上、去掉地名设定（feature）时，自然长成的那些片要不要成为自己的地物也跟着变（features.ts 的 namesNaturally）：
  // 地物要重新识别，不只是重新起名
  if (changed.every((k) => NAME_KEYS.has(k)) && namesNaturally(before) === namesNaturally(after)) return { dirty: Dirty.Names, what };
  // 只改宜居度（第二十二轮）、通行难度（第二十七轮）：长什么不变，只重算人文的几层
  const human = (k: string) => k === 'habitability' || k === 'movement';
  if (changed.every((k) => human(k) || NAME_KEYS.has(k)) && namesNaturally(before) === namesNaturally(after))
    return { dirty: Dirty.Human, what: only('habitability') ? ' · 宜居度' : only('movement') ? ' · 通行难度' : what };
  return { dirty: Dirty.Solve, what };
}

// ---------- 画的河 ----------

// 河道上前后两格必须相邻
export function checkCourse(mesh: Mesh, cells: readonly number[]) {
  for (let k = 0; k + 1 < cells.length; k++) {
    const a = cells[k];
    const b = cells[k + 1];
    let adjacent = false;
    for (let e = mesh.off[a]; e < mesh.off[a + 1]; e++) if (mesh.adj[e] === b) adjacent = true;
    if (!adjacent) throw new CommandError(`河道路径第 ${k} 与第 ${k + 1} 格不相邻`);
  }
}

// 河道还要查两项：不经过同一格两次（水会绕成圈）；在终点消失的，终点要在陆地上
export function checkNewCourse(world: World, g: Guide, cells: boolean, end: boolean) {
  if (cells && new Set(g.cells).size !== g.cells.length) throw new CommandError('河道不能经过同一格两次');
  if (cells && g.branch && !world.causes.land[g.cells[0]]) throw new CommandError('分出的一股要从陆地上的河分出');
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
export function captureBy(world: World, guides: Guide[], g: Guide): Guide[] {
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
  if (!same((g) => [g.name ?? null, g.nameKey ?? null, g.autoName ?? null, g.autoOrig ?? null, g.salt ?? null, g.path ?? null, g.sourceOf ?? null, g.label ?? null, g.hidden ?? null])) return Dirty.Names;
  return Dirty.None;
}

// 生态、约束、画的河、河湖与岛的种类、自定义场的命令（第四十一轮从 runOp 拆出来，case 原样）；不是这一类的命令返回 undefined
export function runNatureOp(world: World, cmd: Command, _ctx: ApplyContext): RunResult | undefined {
  const { causes, small, mesh } = world;
  const n = mesh.n;
  const checkCells = (list: number[]) => {
    const bad = list.find((i) => i >= n);
    if (bad !== undefined) throw new CommandError(`格编号 ${bad} 超出范围（共 ${n} 格）`);
  };
  switch (cmd.op) {
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
      if ('id' in cmd.patch && cmd.patch.id !== cmd.id) throw new CommandError('不能修改类型 id；请新建后删除旧的');
      // 值为 null 的项表示去掉（例如取消扩散限制）；命令要能存成 JSON，所以不用 undefined
      const merged: Record<string, unknown> = { ...small.species[idx], ...cmd.patch };
      for (const [k, v] of Object.entries(cmd.patch)) if (v === null) delete merged[k];
      const parsed = speciesSchema.safeParse(merged);
      if (!parsed.success) throw new CommandError(`update_species 参数无效：${formatIssues(parsed.error)}`);
      checkSpeciesScripts(parsed.data);
      const before = small.species[idx];
      small.species[idx] = parsed.data;
      const { dirty, what } = speciesChange(before, parsed.data);
      return { dirty, summary: `修改生态“${parsed.data.name || cmd.id}”${what}` };
    }
    case 'remove_species': {
      const idx = small.species.findIndex((s) => s.id === cmd.id);
      if (idx < 0) throw new CommandError(`找不到类型 "${cmd.id}"`);
      const [gone] = small.species.splice(idx, 1);
      return { dirty: Dirty.Solve, summary: `删除生态“${gone.name || cmd.id}”` };
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
      return { dirty: Dirty.Solve, summary: `涂“${sp?.name || c.species}” · ${c.cells.length} 格 · ${c.mode === 'constraint' ? '自然融入' : '强制'}` };
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
        return { dirty: Dirty.None, summary: parsed.data.ignored ? `忽略没涂成的“${name}”` : `恢复提醒“${name}”` };
      }
      return { dirty: Dirty.Solve, summary: '修改涂的生态' };
    }
    case 'remove_constraint': {
      const before = small.constraints.length;
      small.constraints = small.constraints.filter((c) => c.id !== cmd.id);
      if (small.constraints.length === before) throw new CommandError(`找不到约束 "${cmd.id}"`);
      return { dirty: Dirty.Solve, summary: '删除涂的生态' };
    }
    case 'erase_constraints': {
      checkCells(cmd.cells);
      const gone = new Set(cmd.cells);
      const before = small.constraints.reduce((k, c) => k + c.cells.length, 0);
      small.constraints = small.constraints.map((x) => ({ ...x, cells: x.cells.filter((i) => !gone.has(i)) })).filter((x) => x.cells.length > 0);
      const after = small.constraints.reduce((k, c) => k + c.cells.length, 0);
      return { dirty: Dirty.Solve, summary: `擦除生态 · ${before - after} 格` };
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
      const summary = cmd.label || (cmd.reroute ? `改道 · 约 ${km} km` : g.spring ? `画河 · 约 ${km} km` : `锁定河段 · 约 ${km} km`);
      return { dirty: guideDirty(before, small.guides), summary };
    }
    case 'remove_guide': {
      const before = small.guides;
      small.guides = small.guides.filter((g) => g.id !== cmd.id);
      if (small.guides.length === before.length) throw new CommandError(`找不到河道 "${cmd.id}"`);
      return { dirty: guideDirty(before, small.guides), summary: cmd.label || '删除河' };
    }
    case 'update_guide': {
      const idx = small.guides.findIndex((g) => g.id === cmd.id);
      if (idx < 0) throw new CommandError(`找不到河道 "${cmd.id}"`);
      const old = small.guides[idx];
      const merged: Record<string, unknown> = { ...old, ...cmd.patch };
      for (const [k, v] of Object.entries(cmd.patch)) if (v === null) delete merged[k];
      // 记下的名字去掉了，它的原文也去掉
      if (merged.autoName === undefined) delete merged.autoOrig;
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
      return { dirty: guideDirty(before, small.guides), summary: cmd.label || (g.name ? `修改“${g.name}”` : '修改河') };
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
      return { dirty, summary: `${before ? '修改' : '新建'}河流类型“${t.name}”` };
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
      return { dirty: Dirty.Vegetation, summary: `删除河流类型“${gone.name}”` };
    }
    case 'add_lake': {
      checkCells([cmd.lake.cell]);
      if (!causes.land[cmd.lake.cell]) throw new CommandError('湖必须放在陆地上');
      const l = lakeSchema.parse({ ...cmd.lake, id: cmd.lake.id ?? nextId(world, 'lake') });
      small.lakes.push(l);
      return { dirty: Dirty.Elevation, summary: `放湖 · 直径约 ${roundKm(l.radius * 2)} km` };
    }
    case 'remove_lake': {
      const before = small.lakes.length;
      small.lakes = small.lakes.filter((l) => l.id !== cmd.id);
      if (small.lakes.length === before) throw new CommandError(`找不到湖 "${cmd.id}"`);
      return { dirty: Dirty.Elevation, summary: '删除湖' };
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
      return { dirty, summary: cmd.label || (l.radius !== old.radius ? `修改湖的直径 · 约 ${roundKm(l.radius * 2)} km` : '修改湖') };
    }
    case 'type_lake': {
      checkCells([cmd.cell, ...(cmd.drop ?? [])]);
      const drop = new Set([cmd.cell, ...(cmd.drop ?? [])]);
      const list = (small.lakeTyping ?? []).filter((e) => !drop.has(e.cell));
      if (cmd.type !== null) list.push({ cell: cmd.cell, type: cmd.type });
      if (list.length) small.lakeTyping = list;
      else delete small.lakeTyping;
      return { dirty: Dirty.Vegetation, summary: cmd.label || (cmd.type === null ? '湖的类型恢复自动' : '修改湖的类型') };
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
      return { dirty, summary: `${before ? '修改' : '新建'}湖泊类型“${t.name}”` };
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
      return { dirty: Dirty.Vegetation, summary: `删除湖泊类型“${gone.name}”` };
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
      // 第三十轮：只有带起名模板的种类的岛打 itype: 标签（features.ts 的 tagIslandType），加上、去掉模板时地物要重算
      if (before && !!before.names !== !!t.names) dirty = Dirty.Vegetation;
      if (moved && dirty < Dirty.Names && hasLakeIsles(world, islandCode(small, t.id))) dirty = Dirty.Names;
      return { dirty, summary: `${before ? '修改' : '新建'}岛的种类“${t.name}”` };
    }
    case 'remove_island_type': {
      const list = islandTypesOf(small);
      const k = list.findIndex((x) => x.id === cmd.id);
      if (k < 0) throw new CommandError(`找不到岛的种类 "${cmd.id}"`);
      const gone = list[k];
      const classBefore = provinceLand(world);
      small.islandTypes = list.filter((x) => x.id !== cmd.id);
      // 这种岛变成大陆岛（世界里没有大陆岛时是普通的岛；潟湖照旧是潟湖），后面的编号往前挪
      removeIslandCode(causes.islandType, k, small.islandTypes);
      if (!small.islandTypes.length) delete small.islandTypes;
      refileProvinces(world, classBefore);
      // 地物要重算：这种岛上的 itype: 标签要去掉（只重新起名会留着旧标签，同一个 id 再新建时名字就和重放不一样）
      return { dirty: Dirty.Vegetation, summary: `删除岛的种类“${gone.name}”` };
    }
    case 'add_field': {
      if (causes.fields[cmd.name]) throw new CommandError(`场 "${cmd.name}" 已存在`);
      causes.fields = { ...causes.fields, [cmd.name]: new Float32Array(n) };
      return { dirty: Dirty.Solve, summary: `新建自定义场“${cmd.name}”` };
    }
    case 'remove_field': {
      if (!causes.fields[cmd.name]) throw new CommandError(`没有场 "${cmd.name}"`);
      const { [cmd.name]: _removed, ...rest } = causes.fields;
      causes.fields = rest;
      return { dirty: Dirty.Solve, summary: `删除自定义场“${cmd.name}”` };
    }
  }
}

