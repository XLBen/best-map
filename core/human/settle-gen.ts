import type { Derived, SettlementRules, World } from '../world';
import { generateLandmarks } from './landmarks';
import { generateRoads } from './roads';
import { clearCities, generateCities, settleInputs } from './settlements';

// 城市、道路、地标一起生成（第二十四轮）：生成人文的最后一步（写好 small.human 之后：时代、人口、国家都定了），
// 也是 generate_settlements 等命令用的。fresh：全部换掉；否则锁定的、自己放的、画的留着，只换自动的

export interface SettlementPlan {
  rules: SettlementRules;
  fresh: boolean;
}

export interface SettlementCounts {
  cities: number;
  roads: number;
  landmarks: number;
}

export function generateSettlements(world: World, d: Derived, plan: SettlementPlan): SettlementCounts {
  const S = settleInputs(world, d);
  const { rules, fresh } = plan;
  const small = world.small;
  // 城市要有人口；没有人文时只放自然的地标
  if (small.human && world.causes.popTotal) generateCities(S, rules, fresh);
  else if (fresh) clearCities(world);
  if (rules.roads && small.cities) generateRoads(S, rules, fresh);
  else if (small.roads) {
    for (const [k, r] of Object.entries(small.roads)) if (fresh || r.auto) delete small.roads[k];
  }
  if (rules.landmarks) generateLandmarks(S, rules, fresh);
  else if (small.landmarks) {
    for (const [k, l] of Object.entries(small.landmarks)) if (fresh || (l.auto && !l.locked)) delete small.landmarks[k];
  }
  small.settlementRules = { ...rules };
  return {
    cities: Object.keys(small.cities ?? {}).length,
    roads: Object.keys(small.roads ?? {}).length,
    landmarks: Object.keys(small.landmarks ?? {}).length,
  };
}

// 生成的参数：写了的几项换掉记着的（种子省略时用人文的种子、再没有时用世界的）
export function settlementRules(world: World, patch: Partial<SettlementRules> = {}): SettlementRules {
  const prev = world.small.settlementRules;
  const seed = patch.seed ?? prev?.seed ?? world.small.human?.seed ?? world.small.terrain.gen?.seed ?? world.settings.seed;
  return { seed: seed >>> 0, roads: patch.roads ?? prev?.roads ?? true, landmarks: patch.landmarks ?? prev?.landmarks ?? true };
}

// 去掉城市、道路、地标、自定义点里的几种
export function removeSettlements(world: World, what: { cities?: boolean; roads?: boolean; landmarks?: boolean; points?: boolean }) {
  const small = world.small;
  if (what.cities) clearCities(world);
  if (what.roads) delete small.roads;
  if (what.landmarks) delete small.landmarks;
  if (what.points) delete small.points;
  if (!small.cities && !small.roads && !small.landmarks) delete small.settlementRules;
  if (!small.cities && !small.roads && !small.landmarks && !small.points) delete small.nextSettlement;
}
