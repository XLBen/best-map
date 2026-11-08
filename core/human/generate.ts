import { recordedOrigin } from '../content/origin';
import { CommandError } from '../errors';
import type { CountryRules, Derived, HumanHearth, HumanState, SettlementRules, SmallState, World } from '../world';
import type { GenContext, GenGroup, HumanStage } from './context';
import { fillAddedDims } from './add-dimension';
import { snapshotCountries, snapshotPop } from './auto';
import { claimsStage } from './claims';
import { capitalsStage } from './countries/capitals';
import { culturesStage } from './cultures';
import { type CountryPlan, blocsStage, clearCountries, countriesStage, countryMixStage } from './countries';
import { type Era, cultureGroupById, worldCultures, worldEras } from './era';
import { compactGroups } from './groups';
import { compilePrefs, preferenceFactorsAfter, preferenceProducts } from './habitability';
import { ensurePopArrays, populationStage } from './population';
import { liveResources, resourceHabitability } from './resources';
import { cellInputs } from './rules';
import { cellKm2 } from './space';
import { worldTerrainClasses } from './terrain-class';
import { generateSettlements, settlementRules } from './settle-gen';
import { clearCities } from './settlements';

// 生成人文（第二十二轮）：文化圈 → 人口 → 国家（第二十三轮）→ 领土补齐 → 帝国、联邦、同盟（第二十六轮）→ 首都 → 国家的移民，
// 每一步是一个 HumanStage（见 context.ts）。第八十四轮：人口挪到国家之前，首都挪到人口的重心一带（countries/capitals.ts），宜居度含资源的倍数
// 结果写进原因（causes.popTotal / popGroup / popShare）与 small.human、small.popGroups，像省份一样“生成一次、之后修补”。
// 第三十轮：生成只读世界里的内容——时代、取值、文化组、文化、地名风格、政体、派系都由界面先从资源包加进世界
// （core/packs/import.ts 的 packImportCommands：planPack，带 from），这里不再从代码里的内置常量复制。
// 规则（时代）取 packs 里第一个带时代的包的那个时代；缺了什么就跳过用到它的那一步，结果里写明（见 content/missing.ts）。
// 第五十轮：生成完世界里的内容都留着（以前没用到的会移出），要清理时走整理（core/tidy.ts）

export interface HumanParams {
  // 用的资源包（资源库里的路径，按勾选的先后）：规则取第一个带时代的包（见 ruleEra）
  packs: string[][];
  // 文化组的 id（第七十七轮：各组占多少是世界里组的比重 cultureGroup.weight，省略为 1）
  groups: string[];
  // 总人口（省略时按时代的默认密度 × 陆地面积）。命令里不再写（第七十七轮）：重新生成时用记着的（改过总人口的留着），换库时按新时代的默认
  totalPop?: number;
  // 省略时用世界的种子
  seed?: number;
  // 国家（第二十三轮）：写了就生成国家（seed 省略为人文的种子）；省略时没有国家
  countries?: Partial<CountryRules>;
  // 城市、道路、地标（第二十四轮）：写了就在最后一步一起生成（seed 省略为人文的种子，roads、landmarks 省略为 true）；
  // 省略时没有城市与道路（已有的去掉；地标、自定义点留着）
  settlements?: Partial<SettlementRules>;
}

// 第二十三轮：国家插在文化圈与人口之间，国家的移民在人口之后。
// 第八十四轮：人口挪到国家之前（国家的起点、首都按人口挑），首都一带多出来的人在集团之后（capitals）
const STAGES: HumanStage[] = [culturesStage, populationStage, countriesStage, capitalsStage, countryMixStage];

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
// 第二十六轮：国家之后补齐领土（claims.ts），再生成帝国、联邦、同盟（第七十三轮起在 countries/relate.ts，是国家格局）
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

// 生成要用的文化组（世界里有的、比重不是 0 的、组里有文化的）。
// 比重（cultureGroup.weight）：第五十轮起 0 不参与；第七十七轮起也是各组占多少（省略为 1），以前是命令写的权重
function usableGroups(world: World, groups: readonly string[]): string[] {
  const small = world.small;
  return groups.filter((id) => {
    const group = cultureGroupById(small, id);
    return !!group && group.weight !== 0 && worldCultures(small).some((c) => c.group === id);
  });
}

// 生成人文之前：缺了时代、文化（选的文化组世界里都没有，或组里没有文化）时不生成，写明缺什么
export function humanBlockers(world: World, params: Pick<HumanParams, 'packs' | 'groups'>): string[] {
  if (!ruleEra(world.small, params.packs)) return ['没有时代：没有生成人文（先从资源库添加一个时代包）'];
  if (!usableGroups(world, params.groups).length) return ['没有文化：没有生成人口（选的文化组世界里没有，或组里没有文化，或比重是 0）'];
  return [];
}

// 上一次生成用的包（重新生成时没写 packs 就用它）
export const stampedPacks = (small: Pick<SmallState, 'genStamp'>): readonly (readonly string[])[] => small.genStamp?.packs ?? [];

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
  const groups: GenGroup[] = used.map((id) => {
    const group = cultureGroupById(small, id)!;
    const cultures = worldCultures(small)
      .filter((c) => c.group === id)
      .map((c) => ({ culture: c, weight: c.weight ?? 1 }));
    return { group, weight: group.weight ?? 1, cultures };
  });
  const cultures = groups.flatMap((g) => g.cultures.map((c) => c.culture));
  const cultureGroup = Int32Array.from(groups.flatMap((g, k) => g.cultures.map(() => k)));
  const groupPrefs = groups.map((g) => compilePrefs(g.group.prefs, small.species, classIds));
  // 第七十九轮（提速，逐位不变）：组的偏好先按双精度算一遍（取成单精度就是组的那一份）。文化的偏好是“组的 + 文化的”连成一串：
  // 文化自己没写时就是组的那几条，用组的同一个数组（两份都只读；历史上的四个时代的文化都没写）；写了的在组的双精度上接着乘
  const groupProd = groupPrefs.map((p) => preferenceProducts(p, x, cls));
  const groupPref = groupProd.map((v) => Float32Array.from(v));
  const culturePref = cultures.map((c, k) => (c.prefs?.length ? preferenceFactorsAfter(groupProd[cultureGroup[k]], compilePrefs(c.prefs, small.species, classIds), x, cls) : groupPref[cultureGroup[k]]));
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
  // 第八十四轮：资源按世界现在的列表现算（见 resources.ts 的 liveResources）
  const resource = liveResources(world, d, x, cls, classIds);
  let countries: CountryPlan | undefined;
  if (params.countries) {
    const rules: CountryRules = { seed: (params.countries.seed ?? seed) >>> 0 };
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
    resource,
    popHab: resourceHabitability(small, d.habitability, resource),
    groupPref,
    culturePref,
    hearths: opts.hearths ?? [],
    ...(keep ? { keep } : {}),
    ...(countries ? { countries } : {}),
  };
  for (const stage of STAGES) stage.run(ctx);
  fillAddedDims(ctx);
  const state: HumanState = {
    era: era.id,
    seed,
    groups: [...used],
    totalPop: ctx.totalPop,
    perWeight: ctx.perWeight ?? 0,
    hearths: ctx.hearths,
    nextGroup: 1,
    ...(countries ? { countryRules: countries.rules } : {}),
  };
  small.human = state;
  small.genStamp = { packs: params.packs.map((p) => [...p]) };
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
    packs: patch.packs ?? stampedPacks(world.small).map((p) => [...p]),
    groups: patch.groups ?? h.groups,
    totalPop: patch.totalPop ?? h.totalPop,
    seed: patch.seed ?? h.seed,
    ...(rules ? { countries: rules } : {}),
    ...(world.small.settlementRules ? { settlements: world.small.settlementRules } : {}),
  };
  // 换了时代、文化组时，不在新的组里的发源地不要了
  const ids = new Set(params.groups);
  const hearths = h.hearths.filter((x) => x.locked && ids.has(x.group));
  return generateHuman(world, d, params, { keepManual: opts.keepManual, hearths, countryMode: fresh ? 'generate' : 'keep', keepLocked: opts.keepLocked ?? true, regenerate: true });
}
