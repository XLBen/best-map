import { CommandError } from '../errors';
import { styleById } from '../name-styles';
import { BUILTIN_STYLES } from '../packs/names';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from '../packs/eras';
import type { CountryRules, Derived, HumanHearth, HumanState, SettlementRules, World } from '../world';
import type { GenContext, GenGroup, HumanStage } from './context';
import { culturesStage } from './cultures';
import { type CountryPlan, clearCountries, countriesStage, countryMixStage } from './countries';
import { type Era, cultureById, cultureGroupById, worldCultures } from './era';
import { compactGroups } from './groups';
import { compilePrefs, preferenceFactors } from './habitability';
import { ensurePopArrays, populationStage } from './population';
import { cellInputs } from './rules';
import { cellKm2 } from './space';
import { worldTerrainClasses } from './terrain-class';
import { generateSettlements, settlementRules } from './settle-gen';
import { clearCities } from './settlements';

// 生成人文（第二十二轮）：文化圈 → 国家（第二十三轮）→ 人口 → 国家的移民，每一步是一个 HumanStage（见 context.ts）。
// 结果写进原因（causes.popTotal / popGroup / popShare）与 small.human、small.popGroups，像省份一样“生成一次、之后修补”。
// 用到的时代、取值、文化组、文化、地名风格世界里没有时从内置的复制进来（世界打开不依赖仓库）

export interface HumanParams {
  era: string;
  groups: { id: string; weight: number; cultures?: string[] }[];
  // 总人口（省略时按时代的默认密度 × 陆地面积）
  totalPop?: number;
  // 省略时用世界的种子
  seed?: number;
  // 国家（第二十三轮）：写了就生成国家（fragmentation 省略为 0.5，seed 省略为人文的种子）；省略时没有国家
  countries?: Partial<CountryRules>;
  // 城市、道路、地标（第二十四轮）：写了就在最后一步一起生成（seed 省略为人文的种子，roads、landmarks 省略为 true）；
  // 省略时没有城市与道路（已有的去掉；地标、自定义点留着）
  settlements?: Partial<SettlementRules>;
}

// 第二十三轮：国家插在文化圈与人口之间，国家的移民在人口之后
const STAGES: HumanStage[] = [culturesStage, countriesStage, populationStage, countryMixStage];

// 加一步（第二十三轮的国家）：排在 before 之前或 after 之后（都省略时排在最后）；同一个 id 再登记一次是换掉
export function registerHumanStage(stage: HumanStage, at: { before?: string; after?: string } = {}) {
  const old = STAGES.findIndex((s) => s.id === stage.id);
  if (old >= 0) STAGES.splice(old, 1);
  const ref = at.before ?? at.after;
  const k = ref ? STAGES.findIndex((s) => s.id === ref) : -1;
  if (k < 0) STAGES.push(stage);
  else STAGES.splice(at.before ? k : k + 1, 0, stage);
}
export const humanStages = (): readonly string[] => STAGES.map((s) => s.id);
// 去掉一步（测试用）
export function unregisterHumanStage(id: string) {
  const k = STAGES.findIndex((s) => s.id === id);
  if (k >= 0) STAGES.splice(k, 1);
}

const WORLD_SEED = (world: World) => world.small.terrain.gen?.seed ?? world.settings.seed;

// 干的陆地的面积（km²）
export function dryLandKm2(world: World, d: Derived): number {
  let a = 0;
  for (let i = 0; i < world.mesh.n; i++) if (world.causes.land[i] && d.lake[i] !== 1) a += cellKm2(world, i);
  return a;
}

// 时代的默认总人口：默认密度 × 陆地面积（取整）
export function defaultTotalPop(world: World, d: Derived, era: Pick<Era, 'popDensity'>): number {
  return Math.round(era.popDensity * dryLandKm2(world, d));
}

// 时代、取值、文化组、文化、地名风格：世界里没有的从内置的复制进来（同 id 已经在世界里的不动）
export function ensureHumanContent(world: World, eraId: string, groupIds: readonly string[]) {
  const small = world.small;
  const content = { ...(small.content ?? {}) };
  const add = (kind: string, id: string, item: unknown) => {
    const store = (content[kind] ?? {}) as Record<string, unknown>;
    if (store[id]) return;
    content[kind] = { ...store, [id]: structuredClone(item) };
  };
  const era = (content.era as Record<string, Era> | undefined)?.[eraId] ?? BUILTIN_ERAS.find((e) => e.id === eraId);
  if (!era) throw new CommandError(`没有时代 "${eraId}"`);
  add('era', eraId, era);
  const dims = new Set(era.dimensions.map((x) => x.id));
  for (const v of BUILTIN_POP_VALUES) if (dims.has(v.dimension) && (!v.eras || v.eras.includes(eraId))) add('popValue', v.id, v);
  for (const g of groupIds) {
    const own = (content.cultureGroup as Record<string, unknown> | undefined)?.[g];
    const b = BUILTIN_CULTURE_GROUPS.find((x) => x.id === g);
    if (!own && !b) throw new CommandError(`没有文化组 "${g}"`);
    if (!own) add('cultureGroup', g, b);
    // 世界里这一组一个文化都没有时，内置的这一组的文化都放进来
    const has = Object.values((content.culture ?? {}) as Record<string, { group: string }>).some((c) => c.group === g);
    if (!has) for (const c of BUILTIN_CULTURES) if (c.group === g) add('culture', c.id, c);
  }
  small.content = content;
  // 文化用的地名风格
  for (const c of worldCultures(small)) {
    if (!groupIds.includes(c.group) || styleById(small, c.nameStyle)) continue;
    const s = BUILTIN_STYLES.find((x) => x.id === c.nameStyle);
    if (s) small.content = { ...small.content, nameStyle: { ...(small.content?.nameStyle ?? {}), [s.id]: structuredClone(s) } };
  }
}

// 生成（或重新生成）。keepManual：手改过的格（causes.popManual）不动。返回生成的状态
// countryMode（第二十三轮，有 params.countries 时）：generate 重新长国家（keepLocked：锁定的留着，默认不留），keep 用现有的领土
export function generateHuman(
  world: World,
  d: Derived,
  params: HumanParams,
  opts: { keepManual?: boolean; hearths?: HumanHearth[]; countryMode?: CountryPlan['mode']; keepLocked?: boolean; regenerate?: boolean } = {},
): HumanState {
  if (!params.groups.length) throw new CommandError('至少要有一个文化组');
  ensureHumanContent(
    world,
    params.era,
    params.groups.map((g) => g.id),
  );
  const small = world.small;
  const era = (small.content!.era as Record<string, Era>)[params.era];
  const classes = worldTerrainClasses(small);
  const classIds = classes.map((c) => c.id);
  const x = cellInputs(world, d);
  const cls = d.terrainClass;
  const groups: GenGroup[] = params.groups.map((p) => {
    const group = cultureGroupById(small, p.id)!;
    const list = p.cultures?.length ? p.cultures.map((id) => cultureById(small, id)) : worldCultures(small).filter((c) => c.group === p.id);
    const cultures = list.map((c, k) => {
      if (!c) throw new CommandError(`没有文化 "${p.cultures![k]}"`);
      return { culture: c, weight: c.weight ?? 1 };
    });
    return { group, weight: p.weight, cultures };
  });
  const cultures = groups.flatMap((g) => g.cultures.map((c) => c.culture));
  const cultureGroup = Int32Array.from(groups.flatMap((g, k) => g.cultures.map(() => k)));
  const groupPrefs = groups.map((g) => compilePrefs(g.group.prefs, small.species, classIds));
  const groupPref = groupPrefs.map((p) => preferenceFactors(p, x, cls));
  const culturePref = cultures.map((c, k) => {
    const g = groups[cultureGroup[k]].group;
    return preferenceFactors(compilePrefs([...(g.prefs ?? []), ...(c.prefs ?? [])], small.species, classIds), x, cls);
  });
  ensurePopArrays(world);
  let keep: Uint8Array | undefined;
  const manual = world.causes.popManual;
  if (manual) {
    if (opts.keepManual) {
      keep = new Uint8Array(world.mesh.n);
      for (let i = 0; i < keep.length; i++) if (manual[i] && x.dry[i]) keep[i] = 1;
    } else manual.fill(0);
  }
  const seed = (params.seed ?? WORLD_SEED(world)) >>> 0;
  let countries: CountryPlan | undefined;
  if (params.countries) {
    const rules: CountryRules = { fragmentation: params.countries.fragmentation ?? 0.5, seed: (params.countries.seed ?? seed) >>> 0 };
    countries = { mode: opts.countryMode ?? 'generate', rules, keepLocked: opts.keepLocked ?? false };
  } else clearCountries(world);
  const ctx: GenContext = {
    world,
    d,
    x,
    cls,
    classIds,
    era,
    seed,
    totalPop: params.totalPop ?? defaultTotalPop(world, d, era),
    groups,
    cultures,
    cultureGroup,
    hab: d.habitability,
    groupPref,
    culturePref,
    hearths: opts.hearths ?? [],
    ...(keep ? { keep } : {}),
    ...(countries ? { countries } : {}),
  };
  for (const stage of STAGES) stage.run(ctx);
  const state: HumanState = {
    era: era.id,
    seed,
    groups: params.groups.map((g) => ({ id: g.id, weight: g.weight, ...(g.cultures?.length ? { cultures: [...g.cultures] } : {}) })),
    totalPop: ctx.totalPop,
    perWeight: ctx.perWeight ?? 0,
    hearths: ctx.hearths,
    nextGroup: 1,
    ...(countries ? { countryRules: countries.rules } : {}),
  };
  small.human = state;
  compactGroups(small, world.causes);
  // 第二十四轮：城市、道路、地标（时代、人口、国家都定了之后）。重新生成时只换自动的（锁定的、自己放的留着）
  if (params.settlements) {
    const p = params.settlements;
    const rules = opts.regenerate ? settlementRules(world, p) : { seed: (p.seed ?? seed) >>> 0, roads: p.roads ?? true, landmarks: p.landmarks ?? true };
    generateSettlements(world, d, { rules, fresh: !opts.regenerate });
  } else if (!opts.regenerate) {
    clearCities(world);
    if (!small.landmarks) delete small.settlementRules;
  }
  return state;
}

// 按世界里记着的参数重新生成（拖过的发源地留着）；patch 换掉其中几项。
// 国家（第二十三轮）：patch 写了 countries 时按它重新长（keepLocked 默认留着锁定的），没写时用现有的领土
export function regenerateHuman(world: World, d: Derived, patch: Partial<HumanParams>, opts: { keepManual?: boolean; keepLocked?: boolean } = {}): HumanState {
  const h = world.small.human;
  if (!h) throw new CommandError('还没有生成人文');
  const fresh = patch.countries !== undefined;
  const rules = fresh ? { ...h.countryRules, ...patch.countries } : h.countryRules;
  const params: HumanParams = {
    era: patch.era ?? h.era,
    groups: patch.groups ?? h.groups,
    totalPop: patch.totalPop ?? h.totalPop,
    seed: patch.seed ?? h.seed,
    ...(rules ? { countries: rules } : {}),
    ...(world.small.settlementRules ? { settlements: world.small.settlementRules } : {}),
  };
  // 换了时代、文化组时，不在新的组里的发源地不要了
  const ids = new Set(params.groups.map((g) => g.id));
  const hearths = h.hearths.filter((x) => x.locked && ids.has(x.group));
  return generateHuman(world, d, params, { keepManual: opts.keepManual, hearths, countryMode: fresh ? 'generate' : 'keep', keepLocked: opts.keepLocked ?? true, regenerate: true });
}
