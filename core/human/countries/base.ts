import type { CountryMeta, CountryRules, World } from '../../world';

// 国家（第二十三轮）的几个常数和最基本的几件事。第七十三轮从 countries.ts 搬来（原样），countries.ts 照旧导出。
// 生成分几步，一步一个文件（见 stage.ts 的 growCountries）：
//   count.ts 几个国家 → 格局的 reserve（神圣帝国的诸侯……）→ seeds.ts 挑政体、等级、起点 → 格局的 grow → grow.ts 往外长 →
//   cleanup.ts 整理（隔海的、住满、湖、飞地）→ 格局的 after → records.ts 写进原因、档案（diplomacy.ts 外交，格局的 diplomacy）；
//   领土补齐（claims.ts）之后格局的 relate（帝国、联邦、同盟）。共用的东西在 state.ts 的 CountryRun，格局在 patterns.ts

// 一个国家平均占多少 km² 能住人的陆地（时代没写 countryKm2 时）
export const COUNTRY_KM2 = 1.6e6;
// 建国年份的范围（时代没写 years 时）
export const DEFAULT_YEARS: [number, number] = [500, 1000];
// 一个世界最多几个国家
export const MAX_COUNTRIES = 512;
// 宜居度低到这里的格（冰盖）谁都不占
export const NOBODY = 0.002;
// 时代的宜居度下限不超过这个时，没长到的陆地也分给最近的国家（住满）
export const FILL_ALL_HAB = 0.02;

// 生成国家要的参数：generate 新长（keepLocked：锁定的留着），keep 用现有的领土（只调人口）
export interface CountryPlan {
  mode: 'generate' | 'keep';
  rules: CountryRules;
  keepLocked: boolean;
}

export function ensureCountryArray(world: World): Int32Array {
  return (world.causes.country ??= new Int32Array(world.mesh.n).fill(-1));
}

// 去掉国家（数组留着，撤销时照旧退回）
export function clearCountries(world: World) {
  world.causes.country?.fill(-1);
  delete world.small.countries;
  delete world.small.nextCountry;
  delete world.small.blocs;
  if (world.small.human) delete world.small.human.countryRules;
}

// 国家列表（按编号）；编号 → 图层的编号（下标 + 1）
export function countryList(small: Pick<World['small'], 'countries'>): CountryMeta[] {
  return Object.values(small.countries ?? {}).sort((a, b) => a.id - b.id);
}

// 带权重随机挑一个
export function pickWeighted<T>(items: readonly T[], w: (x: T) => number, rand: () => number): T | undefined {
  let total = 0;
  for (const x of items) total += Math.max(0, w(x));
  if (!(total > 0)) return items[0];
  let r = rand() * total;
  for (const x of items) {
    r -= Math.max(0, w(x));
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}
