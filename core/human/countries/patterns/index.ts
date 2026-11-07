import { z } from 'zod';
import { typeIdSchema } from '../../../type-id';
import { type CountryPattern, type PatternParam, patternModules, registerPattern } from '../patterns';
import { alliance } from './alliance';
import { federation } from './federation';
import { holyEmpire } from './holy-empire';
import { vassals } from './vassals';

// 内置的格局模块（第七十三轮），按调的先后登记：神圣帝国 → 联邦 → 军事同盟 → 附庸。
// 先后定了随机流里取数的先后（联邦、同盟共用 'blocs'），不要调换；第七十四轮的新模块加在后面
registerPattern(holyEmpire);
registerPattern(federation);
registerPattern(alliance);
registerPattern(vassals);

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
