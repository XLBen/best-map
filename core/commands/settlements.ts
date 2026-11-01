import type { World } from '../world';
import { addCity, cityName, cityOf, generateCities, moveCityCell, removeCity, setCity, settleInputs, tidyCities } from '../human/settlements';
import { addLandmark, generateLandmarks, landmarkName, landmarkOf, moveLandmark, setLandmark } from '../human/landmarks';
import type { Command } from './schema';
import { type ApplyContext, Dirty, type RunResult } from './shared';
import { CommandError } from '../errors';
import { generateSettlements, removeSettlements, settlementRules } from '../human/settle-gen';
import { missingNotes } from '../content/missing';
import { addRoad, editRoad, generateRoads, rerouteCity, roadKm, roadOf, setRoad } from '../human/roads';
import { worldCityRanks, worldLandmarkTypes } from '../human/settle-content';
import { addPoint, movePoint, pointOf, removePoint, setPoint } from '../human/points';

// 城市、道路、地标、自定义点的命令（第四十一轮从 commands.ts 原样搬来）

// 城市、地标的名字（历史里写）
export const cityLabel = (world: World, id: number) => {
  const c = world.small.cities?.[id];
  return `“${c ? cityName(world, c).zh || id : id}”`;
};
export const landmarkLabel = (world: World, id: number) => {
  const l = world.small.landmarks?.[id];
  return `“${l ? landmarkName(world, l).zh || id : id}”`;
};

// 城市、道路、地标、自定义点的命令（第四十一轮从 runOp 拆出来，case 原样）；不是这一类的命令返回 undefined
export function runSettlementOp(world: World, cmd: Command, ctx: ApplyContext): RunResult | undefined {
  const { causes, small, mesh } = world;
  const n = mesh.n;
  const checkCells = (list: number[]) => {
    const bad = list.find((i) => i >= n);
    if (bad !== undefined) throw new CommandError(`格编号 ${bad} 超出范围（共 ${n} 格）`);
  };
  switch (cmd.op) {
    // ---------- 城市、道路、地标、自定义点（第二十四轮） ----------
    case 'generate_settlements':
    case 'regenerate_settlements': {
      const d = ctx.ensureDerived();
      const fresh = cmd.op === 'generate_settlements';
      const patch = { ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}), ...(cmd.roads !== undefined ? { roads: cmd.roads } : {}), ...(cmd.landmarks !== undefined ? { landmarks: cmd.landmarks } : {}) };
      const k = generateSettlements(world, d, { rules: settlementRules(world, patch), fresh });
      const parts = [small.human ? `${k.cities} 座城市` : '', k.roads ? `${k.roads} 条道路` : '', k.landmarks ? `${k.landmarks} 个地标` : ''].filter(Boolean);
      const skipped = missingNotes(small, ['settlements']);
      return { dirty: Dirty.None, summary: `${fresh ? '生成' : '重新生成'}城市与地标${parts.length ? ` · ${parts.join(' · ')}` : ''}`, ...(skipped.length ? { skipped } : {}) };
    }
    case 'remove_settlements': {
      removeSettlements(world, { cities: cmd.cities, roads: cmd.roads, landmarks: cmd.landmarks, points: cmd.points });
      const names = [cmd.cities ? '城市' : '', cmd.cities || cmd.roads ? '道路' : '', cmd.landmarks ? '地标' : '', cmd.points ? '自定义点' : ''].filter(Boolean);
      return { dirty: Dirty.None, summary: `删除${names.join('、') || '城市与地标'}` };
    }
    case 'generate_cities':
    case 'regenerate_cities': {
      if (!small.human || !causes.popTotal) throw new CommandError('还没有生成人文');
      const S = settleInputs(world, ctx.ensureDerived());
      const rules = settlementRules(world, cmd.seed !== undefined ? { seed: cmd.seed } : {});
      const fresh = cmd.op === 'generate_cities';
      // 重新生成：自己放的留着；keepLocked 时锁定的也留着
      if (!fresh && cmd.keepLocked === false && small.cities) {
        for (const c of Object.values(small.cities)) if (c.auto && c.locked) delete small.cities[c.id];
      }
      generateCities(S, rules, fresh);
      tidyCities(world);
      // 有道路时自动的道路跟着重连（画的留着）
      if (rules.roads && (fresh || small.roads)) generateRoads(S, rules, false);
      small.settlementRules = { ...rules };
      const skipped = worldCityRanks(small).length ? [] : ['没有城市等级：没有放城市和道路'];
      return { dirty: Dirty.None, summary: `${fresh ? '生成' : '重新生成'}城市 · ${Object.keys(small.cities ?? {}).length} 座`, ...(skipped.length ? { skipped } : {}) };
    }
    case 'add_city': {
      checkCells([cmd.cell]);
      const id = addCity(world, cmd.cell, { name: cmd.name, orig: cmd.orig, rank: cmd.rank });
      return { dirty: Dirty.None, summary: `新建城市${cityLabel(world, id)}` };
    }
    case 'remove_city': {
      const name = cityLabel(world, cmd.id);
      removeCity(world, cmd.id);
      return { dirty: Dirty.None, summary: `删除城市${name}` };
    }
    case 'move_city': {
      checkCells([cmd.cell]);
      const c = cityOf(world, cmd.id);
      if (c.cell !== cmd.cell) {
        moveCityCell(world, cmd.id, cmd.cell);
        if (small.roads) rerouteCity(settleInputs(world, ctx.ensureDerived()), cmd.id);
      }
      return { dirty: Dirty.None, summary: `挪动城市${cityLabel(world, cmd.id)}` };
    }
    case 'set_city': {
      cityOf(world, cmd.id);
      const what = setCity(world, cmd.id, cmd.patch);
      return { dirty: Dirty.None, summary: `城市${cityLabel(world, cmd.id)} · ${what.join('、') || '修改'}` };
    }
    case 'generate_roads':
    case 'regenerate_roads': {
      const d = ctx.ensureDerived();
      const rules = settlementRules(world, { roads: true });
      const k = generateRoads(settleInputs(world, d), rules, cmd.op === 'generate_roads');
      small.settlementRules = rules;
      return { dirty: Dirty.None, summary: `${cmd.op === 'generate_roads' ? '生成' : '重新生成'}道路 · ${k} 条` };
    }
    case 'add_road': {
      const id = addRoad(world, cmd.cells, cmd.kind ?? 'minor', cmd.name);
      return { dirty: Dirty.None, summary: `画道路 · 约 ${Math.round(roadKm(world, small.roads![id].cells))} km` };
    }
    case 'edit_road': {
      editRoad(world, cmd.id, cmd.cells, cmd.from, cmd.to);
      return { dirty: Dirty.None, summary: `改道路 · 约 ${Math.round(roadKm(world, roadOf(world, cmd.id).cells))} km` };
    }
    case 'remove_road': {
      roadOf(world, cmd.id);
      delete small.roads![cmd.id];
      return { dirty: Dirty.None, summary: '删除道路' };
    }
    case 'set_road': {
      const what = setRoad(world, cmd.id, cmd.patch);
      return { dirty: Dirty.None, summary: `道路 · ${what.join('、') || '修改'}` };
    }
    case 'generate_landmarks': {
      const d = ctx.ensureDerived();
      const rules = settlementRules(world, { landmarks: true });
      const k = generateLandmarks(settleInputs(world, d), rules, cmd.keepManual === false);
      small.settlementRules = rules;
      const skipped = worldLandmarkTypes(small).length ? [] : ['没有地标类型：没有放地标'];
      return { dirty: Dirty.None, summary: `生成地标 · ${k} 个`, ...(skipped.length ? { skipped } : {}) };
    }
    case 'add_landmark': {
      checkCells([cmd.cell]);
      const id = addLandmark(world, cmd.type, cmd.cell, { name: cmd.name, orig: cmd.orig, description: cmd.description });
      return { dirty: Dirty.None, summary: `新建地标${landmarkLabel(world, id)}` };
    }
    case 'remove_landmark': {
      landmarkOf(world, cmd.id);
      const name = landmarkLabel(world, cmd.id);
      delete small.landmarks![cmd.id];
      return { dirty: Dirty.None, summary: `删除地标${name}` };
    }
    case 'move_landmark': {
      checkCells([cmd.cell]);
      moveLandmark(world, cmd.id, cmd.cell);
      return { dirty: Dirty.None, summary: `挪动地标${landmarkLabel(world, cmd.id)}` };
    }
    case 'set_landmark': {
      const what = setLandmark(world, cmd.id, cmd.patch);
      return { dirty: Dirty.None, summary: `地标${landmarkLabel(world, cmd.id)} · ${what.join('、') || '修改'}` };
    }
    case 'add_point': {
      checkCells([cmd.cell]);
      const id = addPoint(world, { type: cmd.type, cell: cmd.cell, x: cmd.x, y: cmd.y, name: cmd.name, note: cmd.note, attachedCity: cmd.attachedCity });
      return { dirty: Dirty.None, summary: `新建点“${small.points![id].name}”` };
    }
    case 'remove_point': {
      const name = pointOf(world, cmd.id).name;
      removePoint(world, cmd.id);
      return { dirty: Dirty.None, summary: `删除点“${name}”` };
    }
    case 'move_point': {
      checkCells([cmd.cell]);
      movePoint(world, cmd.id, cmd.cell, cmd.x, cmd.y);
      return { dirty: Dirty.None, summary: `挪动点“${pointOf(world, cmd.id).name}”` };
    }
    case 'set_point': {
      const what = setPoint(world, cmd.id, cmd.patch);
      return { dirty: Dirty.None, summary: `点“${pointOf(world, cmd.id).name}” · ${what.join('、') || '修改'}` };
    }
  }
}
