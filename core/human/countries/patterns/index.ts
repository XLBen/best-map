import { z } from 'zod';
import { typeIdSchema } from '../../../type-id';
import { type CountryPattern, type PatternParam, patternModules, registerPattern } from '../patterns';
import { alliance } from './alliance';
import { centralEmpire } from './central-empire';
import { cityLeague } from './city-league';
import { colonies } from './colonies';
import { federation } from './federation';
import { holyEmpire } from './holy-empire';
import { khanate } from './khanate';
import { multiethnic } from './multiethnic';
import { nationState } from './nation-state';
import { nationalism } from './nationalism';
import { postColonial } from './post-colonial';
import { riverEmpire } from './river-empire';
import { unification } from './unification';
import { vassals } from './vassals';

// 内置的格局模块，按调的先后登记（每个钩子都按这个先后调）。第七十三轮的四个：神圣帝国 → 联邦 → 军事同盟 → 附庸，
// 联邦、同盟共用随机流 'blocs'，两个的先后不要调换。第七十四轮的新模块不取共用流里的数、多少是 0 时什么都不做，插在中间只为钩子的先后：
//   reserve：神圣帝国 → 城邦群 → 大河帝国 → 集权帝国 → 汗国 → 殖民地（先圈的先挑地方）；
//   relate：城邦群结成同盟在军事同盟之前（军事同盟不再拉它的成员）；
//   diplomacy：殖民地在附庸之后（列强是定完附庸以后不是附庸的大国）；
//   grow：大河帝国、集权帝国、汗国 → 多民族帝国 → 民族主义（民族主义看多民族的大国的记号）；
//   after：民族统一 → 民族国家 → 前殖民地国家
registerPattern(holyEmpire);
registerPattern(cityLeague);
registerPattern(riverEmpire);
registerPattern(centralEmpire);
registerPattern(khanate);
registerPattern(federation);
registerPattern(alliance);
registerPattern(vassals);
registerPattern(colonies);
registerPattern(multiethnic);
registerPattern(nationalism);
registerPattern(unification);
registerPattern(nationState);
registerPattern(postColonial);

// 资源库里的一项：名字、说明、模块、多少，各模块的参数平铺在项里（资源库里只显示选着的模块的那几个）。
// 几个模块用同一个键时范围要一样（登记时查）
const BASE_KEYS = new Set(['id', 'name', 'description', 'module', 'amount']);
function paramShape(): Record<string, z.ZodOptional<z.ZodNumber>> {
  const seen = new Map<string, PatternParam>();
  for (const m of patternModules()) {
    for (const p of m.params ?? []) {
      if (BASE_KEYS.has(p.key)) throw new Error(`格局模块 ${m.id} 的参数不能叫 ${p.key}`);
      const had = seen.get(p.key);
      if (had && (had.min !== p.min || had.max !== p.max)) throw new Error(`格局模块的参数 ${p.key} 范围不一样`);
      seen.set(p.key, p);
    }
  }
  return Object.fromEntries([...seen.values()].map((p) => [p.key, z.number().min(p.min).max(p.max).optional()]));
}

export const AMOUNT_MAX = 20;
export const countryPatternSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  description: z.string().max(400).optional(),
  // 模块的 id（patterns.ts 登记的）
  module: typeIdSchema,
  // 时代没写多少时用它
  amount: z.number().min(0).max(AMOUNT_MAX),
  ...paramShape(),
}) as unknown as z.ZodType<CountryPattern>;
