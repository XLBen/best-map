import { recordedOrigin } from '../content/origin';
import { CommandError } from '../errors';
import type { CountryRules, Derived, HumanHearth, HumanState, SettlementRules, SmallState, World } from '../world';
import type { GenContext, GenGroup, HumanStage } from './context';
import { snapshotCountries, snapshotPop } from './auto';
import { blocsStage } from './blocs';
import { claimsStage } from './claims';
import { culturesStage } from './cultures';
import { type CountryPlan, clearCountries, countriesStage, countryMixStage } from './countries';
import { type Era, cultureById, cultureGroupById, worldCultures, worldEras } from './era';
import { compactGroups } from './groups';
import { pruneHumanContent } from './prune';
import { compilePrefs, preferenceFactors } from './habitability';
import { ensurePopArrays, populationStage } from './population';
import { cellInputs } from './rules';
import { cellKm2 } from './space';
import { worldTerrainClasses } from './terrain-class';
import { generateSettlements, settlementRules } from './settle-gen';
import { clearCities } from './settlements';

// 生成人文（第二十二轮）：文化圈 → 国家（第二十三轮）→ 领土补齐 → 帝国、联邦、同盟（第二十六轮）→ 人口 → 国家的移民，每一步是一个 HumanStage（见 context.ts）。
// 结果写进原因（causes.popTotal / popGroup / popShare）与 small.human、small.popGroups，像省份一样“生成一次、之后修补”。
// 第三十轮：生成只读世界里的内容——时代、取值、文化组、文化、地名风格、政体、派系都由界面先从资源包加进世界
// （core/packs/import.ts 的 packImportCommands：planPack，带 from），这里不再从代码里的内置常量复制。
// 规则（时代）取 packs 里第一个带时代的包的那个时代；缺了什么就跳过用到它的那一步，结果里写明（见 content/missing.ts）。
// 生成完只留用到的（第二十八轮，见 prune.ts；第三十轮起不论是不是内置原样）

export interface HumanParams {
  // 用的资源包（资源库里的路径，按勾选的先后）：规则取第一个带时代的包（见 ruleEra）
  packs: string[][];
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
// 第二十六轮：国家之后补齐领土（claims.ts），再生成帝国、联邦、同盟（blocs.ts）
registerHumanStage(claimsStage, { after: 'countries' });
registerHumanStage(blocsStage, { after: 'claims' });
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

// 规则用的时代（第三十轮）：packs 里第一个带时代的包——世界里来源（small.origin）在这个包下面的时代；
// 都对不上时是世界里第一个时代（自己做的时代没有来源）；世界里一个时代都没有时 undefined（不生成人文）
const under = (path: readonly string[] | undefined, pack: readonly string[]) => !!path && pack.length <= path.length && pack.every((x, k) => path[k] === x);
export function ruleEra(small: Pick<SmallState, 'content' | 'origin'>, packs: readonly (readonly string[])[]): Era | undefined {
  const eras = worldEras(small);
  for (const p of packs) {
    const hit = eras.find((e) => under(recordedOrigin(small, 'era', e.id), p));
    if (hit) return hit;
  }
  return eras[0];
}

// 生成要用的文化组（世界里有的、组里有文化的；点名的文化只留世界里有的）
function usableGroups(world: World, groups: HumanParams['groups']): HumanParams['groups'] {
  const small = world.small;
  const out: HumanParams['groups'] = [];
  for (const g of groups) {
    if (!cultureGroupById(small, g.id)) continue;
    if (g.cultures?.length) {
      const named = g.cultures.filter((id) => cultureById(small, id));
      if (named.length) out.push({ ...g, cultures: named });
      continue;
    }
    if (worldCultures(small).some((c) => c.group === g.id)) out.push(g);
  }
  return out;
}

// 生成人文之前：缺了时代、文化（选的文化组世界里都没有，或组里没有文化）时不生成，写明缺什么
export function humanBlockers(world: World, params: Pick<HumanParams, 'packs' | 'groups'>): string[] {
  if (!ruleEra(world.small, params.packs)) return ['没有时代：没有生成人文（先从资源库添加一个时代包）'];
  if (!usableGroups(world, params.groups).length) return ['没有文化：没有生成人口（选的文化组世界里没有，或组里没有文化）'];
  return [];
}

// 生成（或重新生成）。keepManual：手改过的格（causes.popManual）不动。返回生成的状态
// countryMode（第二十三轮，有 params.countries 时）：generate 重新长国家（keepLocked：锁定的留着，默认不留），keep 用现有的领土
export function generateHuman(
  world: World,
  d: Derived,
  params: HumanParams,
  opts: { keepManual?: boolean; hearths?: HumanHearth[]; countryMode?: CountryPlan['mode']; keepLocked?: boolean; regenerate?: boolean } = {},
): HumanState {
  const small = world.small;
  const era = ruleEra(small, params.packs);
  if (!era) throw new CommandError('世界里没有时代');
  const used = usableGroups(world, params.groups);
  if (!used.length) throw new CommandError('世界里没有选的文化组的文化');
  const classes = worldTerrainClasses(small);
  const classIds = classes.map((c) => c.id);
  const x = cellInputs(world, d);
  const cls = d.terrainClass;
  const groups: GenGroup[] = used.map((p) => {
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
    const layout = params.countries.layout;
    const rules: CountryRules = { fragmentation: params.countries.fragmentation ?? 0.5, seed: (params.countries.seed ?? seed) >>> 0, ...(layout && layout !== 'era' ? { layout } : {}) };
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
    packs: params.packs.map((p) => [...p]),
    era: era.id,
    seed,
    groups: used.map((g) => ({ id: g.id, weight: g.weight, ...(g.cultures?.length ? { cultures: [...g.cultures] } : {}) })),
    totalPop: ctx.totalPop,
    perWeight: ctx.perWeight ?? 0,
    hearths: ctx.hearths,
    nextGroup: 1,
    ...(countries ? { countryRules: countries.rules } : {}),
  };
  small.human = state;
  // 第二十七轮：自动的结果存一份（橡皮擦的“恢复自动”），快照里的群体编号跟着一起整理
  const autoGroups = snapshotPop(world, keep);
  snapshotCountries(world, !!countries && countries.mode === 'generate');
  compactGroups(small, world.causes, autoGroups ? [autoGroups] : []);
  // 第二十四轮：城市、道路、地标（时代、人口、国家都定了之后）。重新生成时只换自动的（锁定的、自己放的留着）
  if (params.settlements) {
    const p = params.settlements;
    const rules = opts.regenerate ? settlementRules(world, p) : { seed: (p.seed ?? seed) >>> 0, roads: p.roads ?? true, landmarks: p.landmarks ?? true };
    generateSettlements(world, d, { rules, fresh: !opts.regenerate });
  } else if (!opts.regenerate) {
    clearCities(world);
    if (!small.landmarks) delete small.settlementRules;
  }
  // 第二十八轮：没用到的时代、取值、文化组、文化（和它们的地名风格）、政体、派系移出世界
  pruneHumanContent(world);
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
    packs: patch.packs ?? h.packs,
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
