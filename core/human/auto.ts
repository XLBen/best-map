import type { World } from '../world';
import { SLOTS, clearCell } from './groups';

// 自动的结果（第二十七轮）：生成人文、国家时存一份（causes.countryAuto、causes.popAuto*），橡皮擦的“恢复自动”
// （restore_country、restore_pop，见 commands.ts）从这里取。只看原因：执行、重放、撤销都一样。
// 重新生成时手改过、留着不动的格（keepManual）没有新的自动值：沿用上一份快照里的（没有时就是现在的）

// 人口：生成的几步跑完、整理群体编号之前调用（compactGroups 连同快照一起重新编号）。keep：手改过、这次没重算的格
export function snapshotPop(world: World, keep?: Uint8Array): Uint16Array | null {
  const c = world.causes;
  if (!c.popTotal || !c.popGroup || !c.popShare) return null;
  const n = world.mesh.n;
  const old = c.popAutoTotal?.length === n ? { t: c.popAutoTotal, g: c.popAutoGroup!, s: c.popAutoShare! } : null;
  const t = c.popTotal.slice();
  const g = c.popGroup.slice();
  const s = c.popShare.slice();
  if (keep && old) {
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      t[i] = old.t[i];
      g.set(old.g.subarray(i * SLOTS, i * SLOTS + SLOTS), i * SLOTS);
      s.set(old.s.subarray(i * SLOTS, i * SLOTS + SLOTS), i * SLOTS);
    }
  }
  c.popAutoTotal = t;
  c.popAutoGroup = g;
  c.popAutoShare = s;
  return g;
}

// 国家：重新长了国家（generate）时换成现在的领土；用现有的领土（keep）时留着上一份（没有时就是现在的）
export function snapshotCountries(world: World, fresh: boolean) {
  const c = world.causes;
  if (!c.country || !world.small.countries) {
    if (c.countryAuto) c.countryAuto.fill(-1);
    return;
  }
  if (fresh || !c.countryAuto || c.countryAuto.length !== c.country.length) c.countryAuto = c.country.slice();
}

// 去掉人文、新世界：快照清空（数组留着，撤销时照旧退回）
export function clearAuto(world: World) {
  const c = world.causes;
  c.popAutoTotal?.fill(0);
  c.popAutoGroup?.fill(0);
  c.popAutoShare?.fill(0);
  c.countryAuto?.fill(-1);
}

// 这一格的领土与自动的不同（自动的那一国已经没了时按无主地算）
export function countryAutoAt(world: World, i: number): number {
  const a = world.causes.countryAuto?.[i] ?? -1;
  return a >= 0 && world.small.countries?.[a] ? a : -1;
}
export const countryEdited = (world: World, i: number) => !!world.causes.country && !!world.causes.countryAuto && world.causes.land[i] === 1 && world.causes.country[i] !== countryAutoAt(world, i);

// 领土恢复自动：这些格（陆地）回到生成时归的那一国。返回改了的格数
export function restoreCountry(world: World, cells: readonly number[]): number {
  const c = world.causes.country;
  if (!c || !world.causes.countryAuto) return 0;
  let k = 0;
  for (const i of cells) {
    if (!countryEdited(world, i)) continue;
    c[i] = countryAutoAt(world, i);
    k++;
  }
  return k;
}

// 人口恢复自动：这些格里手改过的（popManual）回到生成时的人数与成分，不再算手改过。返回改了的格数
export function popEdited(world: World, i: number): boolean {
  return world.causes.popManual?.[i] === 1 && world.causes.land[i] === 1;
}
export function restorePop(world: World, cells: readonly number[]): number {
  const c = world.causes;
  if (!c.popTotal || !c.popManual) return 0;
  const auto = c.popAutoTotal ? { t: c.popAutoTotal, g: c.popAutoGroup!, s: c.popAutoShare! } : null;
  let k = 0;
  for (const i of cells) {
    if (!popEdited(world, i)) continue;
    c.popManual[i] = 0;
    k++;
    if (!auto || !(auto.t[i] > 0)) {
      clearCell(c, i);
      continue;
    }
    c.popTotal[i] = auto.t[i];
    c.popGroup!.set(auto.g.subarray(i * SLOTS, i * SLOTS + SLOTS), i * SLOTS);
    c.popShare!.set(auto.s.subarray(i * SLOTS, i * SLOTS + SLOTS), i * SLOTS);
  }
  return k;
}
