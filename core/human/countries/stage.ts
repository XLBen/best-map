import type { GenContext, HumanStage } from '../context';
import { composedDims, cultureById } from '../era';
import { eraGovernments, governmentById } from '../government';
import { GroupTable, SLOTS, type Share, readComp, writeComp } from '../groups';
import { cellKm2, distKm } from '../space';
import { type CountryPlan, ensureCountryArray } from './base';
import { cleanupOwners } from './cleanup';
import { countCountries } from './count';
import { growOwners } from './grow';
import { param, patternUses, runPatterns } from './patterns';
import { COLONIES, colonies, settleColonies } from './patterns/colonies';
import './patterns/index';
import { typical, writeRecords } from './records';
import { placeSeeds } from './seeds';
import { type CountryRun, newRun } from './state';

// 国家（第二十三轮）：在文化圈与人口之间的一步（见 generate.ts 的 registerHumanStage）。
//   1. 几个国家：能住人的陆地面积 ÷（时代的 countryKm2 × “统一 ↔ 分裂”的倍数），按各文化能住人的面积分给文化；
//   2. 每个国家先按时代与文化的倾向挑一个政体，再在本文化的地盘里挑一个起点（宜居度高、偏海岸的政体挑海边），彼此隔开；
//   3. 各国从起点按代价同时往外长（与文化圈同一套走一条边的代价，再按政体：越过文化的边界——扩张性弱的更难，内陆——偏海岸的更难，
//      下海——紧凑的更难，越远越难——紧凑的更难；强的长得快），每格归先到的那一国。宜居度低于时代 unclaimed.minHabitability 的格
//      不进（游牧的政体按 nomadic 放宽），离起点太远的不要：这些是无主地。海只能穿过，不归国家（领海是推导，见 country-layers.ts）；
//   4. 整理：湖归湖岸上最多的那一国；不连着首都、挨着别国的小块并给邻国；
//   5. 档案：名字（文化的风格起的地名 + 政体的称号）、颜色、旗帜、统治者、建国年份、兼容的文化组、外交（附庸、同盟、敌对）、历史；
//   6. 人口一步之前：首都一带的人口多一些（ctx.popScale，按政体的城市化）；人口一步之后：扩张性强的国家在异族的地方掺进主流文化的人。
// 锁定的国家（重新生成时 keepLocked）领土、档案都不动
// 第二十六轮：每国一个等级（第四十二轮起是世界里的国家等级，见 tiers.ts；按时代的 tiers 或格局 countryRules.layout），面积预算 = 平均的国家 × 等级的倍数 ×（0.7–1.3）
//   （不超过能住人的地方的 MAX_SHARE）；国家按“文化 × 陆块”分。第 3 步分两遍：先各长到预算就停，剩下能占的地方再接着长到预算的
//   FREE_MUL 倍（快慢拉平：剩下的归近的），再剩下的是无主地。下海按政体变难（游牧几乎不下海），别的陆块上没什么人的地方不要。
//   先按文化的倾向挑政体，再按政体的 size 挑相配的等级。
//   之后的两步：领土补齐（claims.ts）、帝国 / 联邦 / 同盟（relate.ts）
// 第七十三轮：一步一个文件（base、count、seeds、grow、cleanup、records、diplomacy），邦联、联邦、同盟、附庸是格局（patterns.ts），
//   按时代的 patterns 挂在几个钩子上

// 这一次的 CountryRun（时代的格局按世界里的国家格局解出来）
export const countryRun = (ctx: GenContext, plan: CountryPlan): CountryRun => newRun(ctx, plan, patternUses(ctx.world.small, ctx.era));

// 清掉不留的国家（锁定的留着）；世界里一个政体都没有时不生成（返回 false）
function resetCountries(g: CountryRun): boolean {
  const { world, plan } = g;
  const { causes, small } = world;
  const n = g.n;
  const country = (g.country = ensureCountryArray(world));
  const old = small.countries ?? {};
  const kept = (g.kept = plan.keepLocked ? Object.values(old).filter((m) => m.locked) : []);
  const keptIds = new Set(kept.map((m) => m.id));
  for (let i = 0; i < n; i++) if (!causes.land[i] || !keptIds.has(country[i])) country[i] = -1;
  small.countries = Object.fromEntries(kept.map((m) => [m.id, m]));
  // 集团（第二十六轮）：只留锁定的成员（blocs.ts 再整理）
  if (small.blocs) {
    small.blocs = small.blocs.map((b) => ({ ...b, members: b.members.filter((id) => keptIds.has(id)) })).filter((b) => b.members.length);
    if (!small.blocs.length) delete small.blocs;
  }
  // 不留锁定的（整个换掉）时编号从 1 起
  g.next = kept.length ? Math.max(1, small.nextCountry ?? 1) : 1;
  const govs = (g.govs = eraGovernments(small, g.ctx.era));
  if (!govs.length) {
    // 第三十轮：世界里一个政体都没有时不生成国家（留着锁定的；一个都没有时与没生成过一样）
    small.nextCountry = g.next;
    if (!kept.length) {
      delete small.countries;
      delete small.nextCountry;
    }
    return false;
  }
  return true;
}

// 只在挑起点时占着的地方（Region.open：大河帝国、集权帝国、汗国的核心）放开，它们的起点照常往外长
function openRegions(g: CountryRun) {
  if (!g.regions.some((r) => r.open)) return;
  const { region, regions } = g;
  for (let i = 0; i < g.n; i++) if (region[i] >= 0 && regions[region[i]].open) region[i] = -1;
}

function growCountries(ctx: GenContext, plan: CountryPlan) {
  const g = countryRun(ctx, plan);
  ctx.countryRun = g;
  if (!resetCountries(g)) return;
  countCountries(g);
  // 预留的地方（神圣帝国的诸侯……）
  runPatterns(g, 'reserve');
  placeSeeds(g);
  if (!g.seeds.length) {
    g.world.small.nextCountry = g.next;
    return;
  }
  openRegions(g);
  runPatterns(g, 'grow');
  growOwners(g);
  cleanupOwners(g);
  runPatterns(g, 'after');
  writeRecords(g);
}

// 现有的领土（重新生成人文、不换国家时）：只把不是陆地的格清掉
function keepCountries(ctx: GenContext) {
  const { world } = ctx;
  const country = ensureCountryArray(world);
  for (let i = 0; i < country.length; i++) if (!world.causes.land[i]) country[i] = -1;
}

// 首都一带的人口多一些：1 + 1.2 × 城市化 × e^(−距离 / R)，R = max(两格的距离, 0.15 × √国土面积)
export function countryPopScale(ctx: Pick<GenContext, 'world' | 'x'>): Float32Array | undefined {
  const { world, x } = ctx;
  const { small, causes } = world;
  const country = causes.country;
  if (!country || !small.countries) return undefined;
  const n = world.mesh.n;
  const area = new Map<number, number>();
  for (let i = 0; i < n; i++) if (country[i] >= 0 && x.dry[i]) area.set(country[i], (area.get(country[i]) ?? 0) + cellKm2(world, i));
  const spacing = world.mesh.spacing * world.kmPerUnit;
  const info = new Map<number, { cap: number; R: number; A: number }>();
  for (const m of Object.values(small.countries)) {
    if (m.capitalCell === undefined || country[m.capitalCell] !== m.id) continue;
    const g = governmentById(small, m.government);
    info.set(m.id, { cap: m.capitalCell, R: Math.max(2 * spacing, 0.15 * Math.sqrt(area.get(m.id) ?? 0)), A: 1.2 * (g?.urbanization ?? 1) });
  }
  const scale = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const c = country[i];
    if (c < 0 || !x.dry[i]) continue;
    const f = info.get(c);
    if (!f) continue;
    const dd = distKm(world, f.cap, i);
    if (dd < 6 * f.R) scale[i] = 1 + f.A * Math.exp(-dd / f.R);
  }
  return scale;
}

function placeCountries(ctx: GenContext) {
  const plan = ctx.countries;
  if (!plan) return;
  // 第三十轮：政体、派系只用世界里的（界面先从时代包加进来）；世界里一个政体都没有时不生成国家（见 growCountries）
  if (plan.mode === 'generate') growCountries(ctx, plan);
  else keepCountries(ctx);
  ctx.popScale = countryPopScale(ctx);
}

// 人口之后：扩张性强的国家在异族的地方（占多数的文化组不兼容）掺进 0.35 × 扩张性 的主流文化的人（官吏、移民）；
// 第七十四轮：在这之前殖民地里掺进“新土认同”（patterns/colonies.ts 的 settleColonies）
function mixCountries(ctx: GenContext) {
  const { world, keep, era } = ctx;
  const { small, causes } = world;
  const country = causes.country;
  if (!ctx.countries || !country || !small.countries || !causes.popTotal) return;
  const table = new GroupTable(small);
  // 第七十四轮：殖民地里掺进新土认同的移民（时代没列殖民地的格局时按它的默认）
  const settled = settleColonies(ctx, table, param(colonies, patternUses(small, era).get(COLONIES) ?? { amount: 0, params: {}, patterns: [] }, 'settlers'));
  // 后加的维度最后才分开（add-dimension.ts），这里的移民先不带
  const base = { ...era, dimensions: composedDims(era) };
  const plan = new Map<number, { a: number; accepted: Set<string>; code: number }>();
  for (const m of Object.values(small.countries)) {
    const g = governmentById(small, m.government);
    const a = 0.35 * (g?.expansion ?? 0);
    if (a <= 0.02) continue;
    plan.set(m.id, { a, accepted: new Set(m.acceptedGroups), code: table.code(typical(world, base, m.primaryCulture)) });
  }
  if (!plan.size) {
    if (settled) table.commit();
    return;
  }
  const groupOfCode = (code: number) => {
    const t = table.get(code);
    return t ? cultureById(small, t.culture)?.group : undefined;
  };
  for (let i = 0; i < country.length; i++) {
    const p = plan.get(country[i]);
    if (!p || keep?.[i] || !(causes.popTotal[i] > 0)) continue;
    const first = causes.popGroup![i * SLOTS];
    const g = first ? groupOfCode(first) : undefined;
    if (!g || p.accepted.has(g)) continue;
    const comp = readComp(causes, i);
    const out: Share[] = comp.map((x) => ({ code: x.code, s: x.s * (1 - p.a) }));
    out.push({ code: p.code, s: p.a });
    writeComp(causes, i, out);
  }
  table.commit();
}

export const countriesStage: HumanStage = { id: 'countries', run: placeCountries };
export const countryMixStage: HumanStage = { id: 'country-mix', run: mixCountries };
