import { WORLD_TYPE_INFO, type Worldgen, worldgenSchema } from '../generate';
import { planetKindName } from '../presets';
import { islandTypeById, LAGOON_BIT, provinceLand } from '../island-types';
import { FREE_HEIGHT, planetSchema, type World } from '../world';
import { brushCore, centerCell, chainIslands, chainSchema, checkIslandKind, combineStamps, fragmentStroke, islandSchema, islandTypeName, type LakeView, landStroke, placeIsland, reliefStroke, resolveTerrain, restoredFragment, restoredLandDelta, restoreKeep, roundKm, sizeText, type StampResult } from '../terrain';
import { repairCountries } from '../human/country-edit';
import { repairCities } from '../human/settlements';
import { repairRoads } from '../human/roads';
import { repairLandmarks } from '../human/landmarks';
import { repairProvinces } from '../provinces';
import type { Command } from './schema';
import { type ApplyContext, type ArrayKey, clearPop, Dirty, formatIssues, getArray, type RunResult } from './shared';
import { CommandError } from '../errors';
import { checkForm, sameForm } from '../planet-form';
import { removeSettlements } from '../human/settle-gen';
import { missingNotes } from '../content/missing';

// 地形、气候、星球的命令（第四十一轮从 commands.ts 原样搬来）

// 重新组合地形；陆海变了就修补省份。返回新增与消失的陆地格数
// 历史里“新世界：X”的 X：星球形态的名字；整个星球用向导里星球类型的名字（“像地球”，而不是地区的“几块大陆”）；
// 一块地区用世界类型的名字。只是说明文字，不进世界状态
export function worldgenName(params: Worldgen, globe: boolean): string {
  if (params.form) return params.form.name;
  if (globe) {
    // 海洋星球与空白星球同是 ocean：有没有露出海面的火山岛
    return planetKindName(params.type, params.islands);
  }
  return WORLD_TYPE_INFO[params.type].name;
}

// 组合地形，陆海变了的格修补省份。classBefore：命令改之前省份按格分的陆海（provinceLand；放岛记上了归海省的岛时
// 陆海没变、省份的陆海也会变）。clear：画陆地 / 海、恢复原样画到的格，先清掉记着的岛的种类（画成了普通的陆地、海）；
// 这时陆海变了的格也清掉（潟湖的海格除外：它们是不是潟湖要与重新组合的结果一致）
export function applyTerrain(world: World, opts: { classBefore?: Uint8Array; clear?: number[] } = {}): { gained: number; lost: number } {
  const { causes } = world;
  const before = causes.land.slice();
  const classBefore = opts.classBefore ?? provinceLand(world);
  const fixed = causes.islandHeight;
  const frag = causes.fragment;
  if (opts.clear) {
    for (const i of opts.clear) causes.islandType[i] = 0;
    if (fixed) for (const i of opts.clear) fixed[i] = FREE_HEIGHT;
    // 破碎度（第十八轮）：画成了整块的陆地、整片的海
    if (frag) for (const i of opts.clear) frag[i] = 0;
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
    if (opts.clear && frag) frag[i] = 0;
  }
  // 国家（第二十三轮）：变成海的格不再归哪国，新陆地归挨着的国家（在修补省份之前：省份跟着国家）
  if (gained || lost) repairCountries(world, before);
  // 城市、道路、地标（第二十四轮）：变成海的格上的删掉（锁定的挪到最近的陆地），道路断开
  if (lost) {
    repairCities(world);
    repairRoads(world);
    repairLandmarks(world);
  }
  const after = provinceLand(world);
  let moved = false;
  for (let i = 0; i < after.length && !moved; i++) if (after[i] !== classBefore[i]) moved = true;
  if (moved) repairProvinces(world);
  return { gained, lost };
}

// 放岛的增量加进原因；湖里的岛定下的高度写进 causes.islandHeight（第一次用到时才建）
export function putStamp(world: World, r: StampResult) {
  const { causes } = world;
  r.cells.forEach((i, k) => {
    causes.landDelta[i] += r.landDelta[k];
    causes.upliftDelta[i] += r.upliftDelta[k];
    causes.erodDelta[i] += r.erodDelta[k];
    if (r.types[k]) causes.islandType[i] = r.types[k];
  });
  // 碎岛的破碎度（第十八轮）：只抬不降，第一次用到时才建数组
  if (r.frag?.cells.length) {
    const f = (causes.fragment ??= new Uint8Array(world.mesh.n));
    r.frag.cells.forEach((i, k) => (f[i] = Math.max(f[i], r.frag!.value[k])));
  }
  if (!r.heights) return;
  const fixed = (causes.islandHeight ??= new Float32Array(world.mesh.n).fill(FREE_HEIGHT));
  r.cells.forEach((i, k) => {
    const h = r.heights![k];
    if (!Number.isNaN(h)) fixed[i] = h;
  });
}

// 地形、气候、星球的命令（第四十一轮从 runOp 拆出来，case 原样）；不是这一类的命令返回 undefined
export function runTerrainOp(world: World, cmd: Command, ctx: ApplyContext): RunResult | undefined {
  const { causes, small, mesh } = world;
  const n = mesh.n;
  const checkCells = (list: number[]) => {
    const bad = list.find((i) => i >= n);
    if (bad !== undefined) throw new CommandError(`格编号 ${bad} 超出范围（共 ${n} 格）`);
  };
  switch (cmd.op) {
    case 'set_worldgen': {
      const params = worldgenSchema.parse(cmd.params);
      // 星球形态：只能用在整个星球上，type 要与形态的 base 相同；脚本有语法错误时当场拒绝
      // （运行时出错不拒绝：那一部分按没有脚本算，见 planet-gen.ts）
      if (params.form) checkForm(params.form, params.type, world.settings.globe === true, (t) => planetKindName(t, t === 'ocean' ? 1 : undefined));
      if (cmd.reset) {
        causes.landDelta.fill(0);
        causes.upliftDelta.fill(0);
        causes.erodDelta.fill(0);
        causes.islandType.fill(0);
        causes.islandHeight?.fill(FREE_HEIGHT);
        causes.fragment?.fill(0);
        causes.terrainClass?.fill(0);
        causes.resource?.fill(0);
        clearPop(world);
        removeSettlements(world, { cities: true, roads: true, landmarks: true, points: true });
        causes.province.fill(-1);
        delete small.cells;
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
      if (cmd.reset || !prev) {
        const skipped = missingNotes(small, ['world']);
        return { dirty: Dirty.Elevation, summary: `新世界“${name}”`, ...(skipped.length ? { skipped } : {}) };
      }
      const what = [
        prev.landFraction !== params.landFraction ? '陆地多少' : '',
        prev.islands !== params.islands ? '岛多少' : '',
        prev.mountains !== params.mountains ? '山多高' : '',
      ].filter(Boolean);
      if (!sameForm(prev.form, params.form)) {
        const more = what.length ? ` · ${what.join('、')}` : '';
        // 去掉形态时说去掉了哪一个（“换了星球形态：像地球”读起来像是换成了另一个形态）
        if (!params.form && prev.form) return { dirty: Dirty.Elevation, summary: `删除星球形态“${prev.form.name}”${more}` };
        return { dirty: Dirty.Elevation, summary: `换星球形态“${name}”${more}` };
      }
      return { dirty: Dirty.Elevation, summary: `调整 · ${what.length ? what.join('、') : '世界参数'}` };
    }
    case 'set_coast_style': {
      small.terrain.coastRoughness = cmd.roughness;
      applyTerrain(world);
      const style = cmd.roughness < 0.6 ? '平滑' : cmd.roughness < 1.4 ? '自然' : '破碎';
      return { dirty: Dirty.Elevation, summary: `海岸风格 · ${style}` };
    }
    case 'paint_land': {
      checkCells(cmd.cells);
      if (cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      const r = landStroke(world, cmd.cells, cmd.t, cmd.mode);
      r.cells.forEach((i, k) => (causes.landDelta[i] += r.delta[k]));
      // 画到的地方成了整块的陆地、整片的海：破碎度在 applyTerrain 里随岛的种类一起清掉
      // 画笔中心（七成半径以内，一定变成陆地、海的那一圈）画到的岛成了普通的陆地、海
      const ch = applyTerrain(world, { clear: brushCore(cmd.cells, cmd.t) });
      return { dirty: Dirty.Elevation, summary: cmd.mode === 'land' ? `画陆地 · ${ch.gained} 格` : `画海 · ${ch.lost} 格` };
    }
    case 'paint_relief': {
      checkCells(cmd.cells);
      if (cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      const r = reliefStroke(cmd.cells, cmd.t, cmd.strength);
      r.cells.forEach((i, k) => (causes.upliftDelta[i] += r.delta[k]));
      applyTerrain(world);
      return { dirty: Dirty.Elevation, summary: cmd.strength >= 0 ? `堆山 · ${cmd.cells.length} 格` : `压低 · ${cmd.cells.length} 格` };
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
        if (causes.fragment) causes.fragment[i] = restoredFragment(causes.fragment[i], cmd.t[k]);
      });
      // 完全恢复的地方（画笔中心七成半径以内）不再是放的岛
      const ch = applyTerrain(world, { clear: brushCore(cmd.cells, cmd.t) });
      return { dirty: Dirty.Elevation, summary: ch.gained || ch.lost ? `恢复 · 陆地 +${ch.gained} / −${ch.lost} 格` : '恢复' };
    }
    case 'fragment': {
      checkCells(cmd.cells);
      if (cmd.t.length !== cmd.cells.length) throw new CommandError('t 的长度必须与 cells 相同');
      const r = fragmentStroke(world, cmd.cells, cmd.t, cmd.strength, cmd.mode, cmd.size);
      if (r.frag.cells.length) {
        const f = (causes.fragment ??= new Uint8Array(n));
        r.frag.cells.forEach((i, k) => (f[i] = r.frag.value[k]));
      }
      if (!r.cells.length) {
        return { dirty: Dirty.Vegetation, summary: cmd.mode === 'coast' ? `打碎海岸 · ${r.frag.cells.length} 格` : `打碎 · ${r.frag.cells.length} 格` };
      }
      r.cells.forEach((i, k) => (causes.landDelta[i] += r.delta[k]));
      const ch = applyTerrain(world);
      return { dirty: Dirty.Elevation, summary: `裂成碎块 · ${ch.lost} 格` };
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
      return { dirty: Dirty.Climate, summary: `擦除冷暖干湿 · ${n} 格` };
    }
    case 'add_island': {
      const spec = islandSchema.parse(cmd.island);
      checkIslandKind(world, spec.kind);
      // 岛心在陆格上（湖面或干的陆地）：要看推导里的湖面。批量命令里推导不是最新的，不放
      const c0 = centerCell(world.mesh, spec.x, spec.y);
      if (causes.land[c0] && ctx.inBatch) throw new CommandError('批量命令里的岛只能放在海里');
      const { stamp: r, lake } = placeIsland(world, spec, () => ctx.ensureDerived());
      const shards = islandTypeById(small, spec.kind)?.shape === 'frag';
      if (shards) {
        // 碎岛（第十八轮）：不改陆海，只抬破碎度
        if (!r.frag?.cells.length) {
          const c = centerCell(world.mesh, spec.x, spec.y);
          throw new CommandError(causes.land[c] && !lake ? '碎岛要放在海里或湖里' : '这里已经是同样的碎岛');
        }
        putStamp(world, r);
        const fragKm = Math.max(spec.size, world.mesh.spacing * world.kmPerUnit * 0.75);
        return { dirty: Dirty.Vegetation, summary: `${lake ? '在湖里' : ''}放${islandTypeName(world, spec.kind)} · 直径约 ${roundKm(fragKm * 2)} km` };
      }
      if (lake && !r.cells.length) throw new CommandError('湖太窄，放不下岛');
      if (!r.footprint.length) throw new CommandError('这里放不下岛');
      const classBefore = provinceLand(world);
      putStamp(world, r);
      applyTerrain(world, { classBefore });
      // 一格的岛（小礁）不看大小：画出来约半格大
      const cellKm = world.mesh.spacing * world.kmPerUnit;
      const one = islandTypeById(small, spec.kind)?.shape === 'cell';
      const size = one ? `直径约 ${roundKm(cellKm * 0.5)} km` : spec.size < cellKm * 0.5 ? sizeText(world, spec.size) : `直径约 ${roundKm(spec.size * 2)} km`;
      return { dirty: Dirty.Elevation, summary: `${lake ? '在湖里' : ''}放${islandTypeName(world, spec.kind)} · ${size}` };
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
      // 全是碎岛（第十八轮）：陆海不变，只重认地物
      const fragOnly = !r.cells.length;
      if (!fragOnly) applyTerrain(world, { classBefore });
      const placed = islands.length - (r.skipped ?? 0);
      const shards = islands.filter((x) => islandTypeById(small, x.kind)?.shape === 'frag').length;
      const what = shards && shards < islands.length ? `${placed} 个岛（其中 ${shards} 片碎岛）` : `${placed} 个${islandTypeName(world, spec.kind)}`;
      return { dirty: fragOnly ? Dirty.Vegetation : Dirty.Elevation, summary: `画岛链 · ${shards === islands.length && islandTypeById(small, spec.kind)?.shape !== 'frag' ? `${placed} 片碎岛` : what}` };
    }
    case 'reroll_region': {
      const gen = small.terrain.gen;
      if (!gen) throw new CommandError('空白海洋没有可重画的地形');
      gen.rerolls = [...gen.rerolls, { x: cmd.x, y: cmd.y, radius: cmd.radius, variant: cmd.variant }];
      const ch = applyTerrain(world);
      return { dirty: Dirty.Elevation, summary: `重画 · 陆地 +${ch.gained} / −${ch.lost} 格` };
    }
    case 'paint': {
      checkCells(cmd.cells);
      const arr = getArray(world, cmd.field as ArrayKey);
      if (!arr) throw new CommandError(`没有字段 ${cmd.field}；先用 add_field 新建`);
      if (cmd.values && cmd.values.length !== cmd.cells.length) throw new CommandError('values 的长度必须与 cells 相同');
      const mode = cmd.mode ?? 'set';
      cmd.cells.forEach((i, k) => {
        const v = cmd.values ? cmd.values[k] : (cmd.value ?? 1);
        const cur = arr[i];
        arr[i] = mode === 'set' ? v : mode === 'add' ? cur + v : mode === 'max' ? Math.max(cur, v) : Math.min(cur, v);
      });
      if (cmd.field === 'erodDelta') {
        applyTerrain(world);
        return { dirty: Dirty.Elevation, summary: `岩石软硬 · ${cmd.cells.length} 格` };
      }
      const dirty = cmd.field.startsWith('field:') ? Dirty.Solve : Dirty.Climate;
      const sign = cmd.values ? cmd.values.reduce((a, b) => a + b, 0) : (cmd.value ?? 1);
      // 冷暖干湿：写明最多改了多少（画笔中心那一格）
      const peak = cmd.values ? cmd.values.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0) : (cmd.value ?? 1);
      const signed = (v: number, digits: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
      if (cmd.field === 'tempOffset') {
        return { dirty, summary: `${sign >= 0 ? '变暖' : '变冷'} · ${cmd.cells.length} 格 · 最多 ${signed(peak, Math.abs(peak) < 2 ? 1 : 0)} °C` };
      }
      if (cmd.field === 'moistOffset') {
        const pct = Math.round((Math.exp(peak) - 1) * 100);
        return { dirty, summary: `${sign >= 0 ? '变湿' : '变干'} · ${cmd.cells.length} 格 · 雨水最多 ${signed(pct, 0)}%` };
      }
      return { dirty, summary: `调整“${cmd.field.slice(6)}” · ${cmd.cells.length} 格` };
    }
    case 'set_planet': {
      const before = small.planet;
      if (world.settings.globe && 'latShift' in cmd.patch && cmd.patch.latShift !== undefined) throw new CommandError('整个星球不能南北挪动');
      if (world.settings.globe && 'outsideOcean' in cmd.patch && cmd.patch.outsideOcean !== undefined) throw new CommandError('整个星球没有地图外面');
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
      return { dirty, summary: `调整 · ${keys.map((k) => names[k] ?? k).join('、')}` };
    }
  }
}

