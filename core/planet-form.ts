import { z } from 'zod';
import { CommandError } from './errors';
import { compileScript, scriptHash, scriptsEnabled, scriptsSchema } from './script';
import { WORLD_TYPES, type WorldType } from './world-types';

// 星球形态（第八轮第三批）：从六种星球里的一种（base）改起，改几项声明式的参数，再加两段可选的脚本：
//   profile —— 星球的“配方”：陆地多少、板块数、大陆块数与大小……（planet-gen.ts 的 PLANET_PROFILES 里的各项）
//   tuning  —— 地壳细节的倍数：山带宽窄、洋中脊、海沟、裂谷、丘陵。全是 1 时与今天的字面量逐位相同
//   scripts.setup —— 布局脚本：建星球模型时运行一次，加大陆块、加岛（rand() 是一条新的随机流 105）
//   scripts.crust —— 地形脚本：每格运行一次，改高度、山、丘陵、岩性；crustMode 'replace' 时板块边界的山带、
//                    洋中脊、海沟都不算，地形完全由脚本决定
// 形态写在 set_worldgen 的 params.form 里，所以世界文件自带它用到的形态，别人没有这个形态也能打开。
// 只能用在整个星球上（一块地区的生成器是另一套）。
//
// 出错的处理与别的脚本相同：语法错误在 set_worldgen 里当场拒绝；运行时出错、算出 NaN 不拒绝，
// 这段脚本这一次按“没有脚本”处理（地形脚本按遍：原来的噪声一遍、每次重画一遍，出错的那一遍按没有脚本算），
// 问题记进 d.scriptIssues 给界面看（terrain.ts 的 planetFormIssues）。
// 安全模式下两段脚本都不运行（也不记问题），profile、tuning、crustMode 照常生效。
//
// 本文件只引用 errors.ts、script.ts、world-types.ts：generate.ts 的 worldgenSchema 在模块顶层就要用 planetFormSchema，
// 这里再值引用 generate.ts（或间接引用它的文件）就成了循环

// 两个数的范围 [小, 大]
function pair(lo: number, hi: number, what: string, int = false) {
  const one = (int ? z.number().int(`${what}要是整数`) : z.number()).min(lo, `${what}最小是 ${lo}`).max(hi, `${what}最大是 ${hi}`);
  return z.tuple([one, one]).refine(([a, b]) => a <= b, `${what}：前一个数不能比后一个大`);
}

// 星球的“配方”（与 planet-gen.ts 的 PlanetProfile 一项项对应；省略的项取 base 那种星球的值）
export const formProfileSchema = z.object({
  // 陆地多少（面积比例）、岛多少（火山锥露出多少）：与“调整”里的两个滑块相同，滑块的值优先
  landFraction: z.number().min(0, '陆地多少最小是 0').max(0.85, '陆地多少最大是 0.85').optional(),
  islands: z.number().min(0, '岛多少最小是 0').max(1, '岛多少最大是 1').optional(),
  // 板块个数（至少 2 块：板块边界才有山）
  plates: pair(2, 40, '板块数', true).optional(),
  // 大陆块个数与半径（布局单位：星球半径约 0.64）
  blocks: pair(0, 60, '大陆块数', true).optional(),
  radius: pair(0.02, 0.6, '大陆块大小').optional(),
  // 主块（“一块超大陆”的主体）的半径；attach：其余的块贴在主块边上
  main: pair(0.05, 0.9, '主大陆大小').optional(),
  attach: z.boolean().optional(),
  // 大陆从海岸往内陆抬升的快慢（m / 单位大陆场）、近地表起伏（m）
  rise: z.number().min(0, '内陆抬升最小是 0').max(4000, '内陆抬升最大是 4000').optional(),
  relief: z.number().min(0, '地表起伏最小是 0').max(2000, '地表起伏最大是 2000').optional(),
  // 热点（火山岛链）个数、海山个数
  hotspots: pair(0, 30, '热点数', true).optional(),
  seamounts: z.number().int('海山数要是整数').min(0, '海山数最小是 0').max(1000, '海山数最大是 1000').optional(),
  // 大陆块排成一圈，环抱一片内海
  ring: z.boolean().optional(),
});
export type FormProfile = z.output<typeof formProfileSchema>;

// 地壳细节的倍数（省略为 1）。只收那些“1 倍时与今天的字面量逐位相同”的项
export const formTuningSchema = z.object({
  // 山带宽窄：碰撞带、大陆边缘山带的宽度
  beltWidth: z.number().min(0.3, '山带宽窄最小是 0.3').max(3, '山带宽窄最大是 3').optional(),
  // 洋中脊的抬升、海沟的深度、大陆裂谷的下陷
  ridge: z.number().min(0, '洋中脊最小是 0').max(3, '洋中脊最大是 3').optional(),
  trench: z.number().min(0, '海沟最小是 0').max(3, '海沟最大是 3').optional(),
  rift: z.number().min(0, '裂谷最小是 0').max(3, '裂谷最大是 3').optional(),
  // 丘陵的强弱
  hills: z.number().min(0, '丘陵最小是 0').max(3, '丘陵最大是 3').optional(),
});
export type FormTuning = z.output<typeof formTuningSchema>;

export const planetFormSchema = z.object({
  id: z.string().regex(/^[\w-]+$/, 'id 只能包含字母、数字、下划线和连字符').max(64, 'id 太长了'),
  name: z.string().min(1, '形态要有名字').max(12, '名字最多 12 个字'),
  // 一句话说明（向导的卡片上）
  hint: z.string().max(60, '说明最多 60 个字').optional(),
  api: z.literal(1),
  // 从哪种星球改起（含向导里不提供的“内海”这一种）。set_worldgen 的 type 必须与它相同
  base: z.enum(WORLD_TYPES),
  // 噪声、随机数的种子用它（省略时用 id）：资源包里改了 id，花样也不变
  seedKey: z.string().min(1).max(64).optional(),
  profile: formProfileSchema.optional(),
  tuning: formTuningSchema.optional(),
  // 统一的脚本容器（script.ts），星球形态只用其中的布局、地形两种
  scripts: scriptsSchema.pick({ setup: true, crust: true }).optional(),
  // 地形脚本是在原来的地形上改（modify，默认），还是完全由脚本决定（replace：不算板块边界）
  crustMode: z.enum(['modify', 'replace']).optional(),
});
export type PlanetForm = z.output<typeof planetFormSchema>;
export type PlanetFormInput = z.input<typeof planetFormSchema>;

export const hasFormScripts = (form: PlanetForm | undefined): boolean => !!(form?.scripts?.setup || form?.scripts?.crust);

// 按 base 的配方改几项：只改给出了值的项（解析结果里显式的 undefined 不算）
export function mergeProfile<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as T;
}

// 缓存键里的形态（terrain.ts 的 sampleKey / shapeKey；只在有形态时才加这一项）。
// 带脚本的形态还要记下安全模式开没开：同一个形态，脚本跑与不跑是两个不同的模型
const digestMemo = new WeakMap<object, string>();
export function formDigest(form: PlanetForm): string {
  let d = digestMemo.get(form);
  if (d === undefined) digestMemo.set(form, (d = scriptHash(JSON.stringify(form))));
  return hasFormScripts(form) ? `${d}:${scriptsEnabled() ? 'run' : 'safe'}` : d;
}

// 两个形态是否相同（set_worldgen 的说明“换了星球形态”用）
export function sameForm(a: PlanetForm | undefined, b: PlanetForm | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

// set_worldgen 里检查形态：只能用在整个星球上；type 与 base 相同；脚本的语法（出错时抛 ScriptError，说明第几行）。
// 安全模式下也检查语法（只是解析，不运行）。typeName：世界类型的中文名（generate.ts 的 WORLD_TYPE_INFO，本文件不能引用它）
export function checkForm(form: PlanetForm, type: WorldType, globe: boolean, typeName: (t: WorldType) => string = (t) => t): void {
  if (!globe) throw new CommandError('星球形态只能用在整个星球上');
  if (form.base !== type) throw new CommandError(`星球形态「${form.name}」只能用在“${typeName(form.base)}”这种世界上，这里是“${typeName(type)}”`);
  if (form.scripts?.setup) compileScript('setup', form.scripts.setup.src, form.name);
  if (form.scripts?.crust) compileScript('crust', form.scripts.crust.src, form.name);
}
