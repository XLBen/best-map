import { describe, expect, it } from 'vitest';
import { digest } from '../../tools/hash';

import { Engine } from '../engine';
import { continents, snapshot, humanExec, type HumanCommand } from '../testing/fixtures';
import type { World } from '../world';
import { SLOTS, readComp, worldDimensions, dimensionValues } from './index';

// 第二十七轮：生成时的快照、橡皮擦的“恢复自动”（restore_country、restore_pop）、人口往外推、清空

const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
];
const GEN: HumanCommand = { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} };

const nations = (): Engine =>
  snapshot('r27-nations', () => {
    const eng = continents({ provinces: true });
    humanExec(eng, GEN);
    return eng;
  });

const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
// 有人的干陆地，按人数从多到少
function peopled(w: World, k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (dry(w, i) && w.causes.popTotal![i] > 0) out.push(i);
  return out.sort((a, b) => w.causes.popTotal![b] - w.causes.popTotal![a]).slice(0, k);
}
const popOf = (w: World, cells: number[]) => cells.reduce((a, i) => a + w.causes.popTotal![i], 0);
const popState = (w: World) => ({ t: digest(w.causes.popTotal!), g: digest(w.causes.popGroup!), s: digest(w.causes.popShare!), m: digest(w.causes.popManual ?? new Uint8Array()) });

describe('第二十七轮：自动的结果', () => {
  it('生成时存下领土与人口，与生成的结果相同', () => {
    const w = nations().world;
    expect(w.causes.countryAuto).toEqual(w.causes.country);
    expect(w.causes.popAutoTotal).toEqual(w.causes.popTotal);
    expect(w.causes.popAutoGroup).toEqual(w.causes.popGroup);
    expect(w.causes.popAutoShare).toEqual(w.causes.popShare);
  });

  it('restore_country：涂过的领土回到生成时的样子，可以撤销', () => {
    const eng = nations();
    const w0 = eng.world;
    const before = w0.causes.country!.slice();
    const ids = Object.keys(w0.small.countries!).map(Number);
    // 把第一个国家的一些格涂给第二个国家
    const cells: number[] = [];
    for (let i = 0; i < w0.mesh.n && cells.length < 40; i++) if (before[i] === ids[0]) cells.push(i);
    eng.exec({ op: 'paint_country', cells, country: ids[1] });
    expect(cells.every((i) => eng.world.causes.country![i] === ids[1])).toBe(true);
    // 快照不跟着涂领土变
    expect(eng.world.causes.countryAuto).toEqual(before);
    eng.exec({ op: 'restore_country', cells });
    expect(eng.world.causes.country).toEqual(before);
    eng.undo();
    expect(cells.every((i) => eng.world.causes.country![i] === ids[1])).toBe(true);
    // 重放与执行相同
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh).world;
    expect(digest(again.causes.country!)).toBe(digest(eng.world.causes.country!));
  });

  it('restore_country：自动的那一国删掉了，恢复成无主地；没涂过的格不动', () => {
    const eng = nations();
    const w0 = eng.world;
    const id = Object.keys(w0.small.countries!).map(Number)[0];
    const cells: number[] = [];
    for (let i = 0; i < w0.mesh.n && cells.length < 20; i++) if (w0.causes.country![i] === id) cells.push(i);
    eng.exec({ op: 'remove_country', id });
    const s = eng.exec({ op: 'restore_country', cells });
    expect(s).toContain('0 格');
    expect(cells.every((i) => eng.world.causes.country![i] === -1)).toBe(true);
  });

  it('restore_pop：改过的人口回到生成时的样子，不再算手改过；撤销照旧', () => {
    const eng = nations();
    const w0 = eng.world;
    const auto = popState(w0);
    const cells = peopled(w0, 30);
    const before = popOf(w0, cells);
    eng.exec({ op: 'paint_pop', cells, mode: 'count', factor: 3 });
    expect(popOf(eng.world, cells)).toBeGreaterThan(before * 2.5);
    const painted = popState(eng.world);
    eng.exec({ op: 'restore_pop', cells });
    expect({ ...popState(eng.world), m: '' }).toEqual({ ...auto, m: '' });
    expect(cells.every((i) => eng.world.causes.popManual![i] === 0)).toBe(true);
    eng.undo();
    expect(popState(eng.world)).toEqual(painted);
  });

  it('重新生成时手改过的格留着，快照里还是上一次自动的', () => {
    const eng = nations();
    const w0 = eng.world;
    const cells = peopled(w0, 10);
    const autoT = cells.map((i) => w0.causes.popTotal![i]);
    eng.exec({ op: 'paint_pop', cells, mode: 'count', factor: 2 });
    humanExec(eng, { op: 'regenerate_human', keepManual: true });
    const w = eng.world;
    // 群体重新编号后，快照里的编号仍然指向原来的群体
    for (const i of cells) for (let k = 0; k < SLOTS; k++) if (w.causes.popAutoGroup![i * SLOTS + k]) expect(w.small.popGroups![w.causes.popAutoGroup![i * SLOTS + k]]).toBeTruthy();
    eng.exec({ op: 'restore_pop', cells });
    cells.forEach((i, q) => expect(eng.world.causes.popTotal![i]).toBeCloseTo(autoT[q], 0));
  });

  it('paint_pop clear：这里没有人；restore_pop 把人请回来', () => {
    const eng = nations();
    const cells = peopled(eng.world, 15);
    const before = popOf(eng.world, cells);
    eng.exec({ op: 'paint_pop', cells, mode: 'clear' });
    expect(popOf(eng.world, cells)).toBe(0);
    eng.exec({ op: 'restore_pop', cells });
    expect(popOf(eng.world, cells)).toBeCloseTo(before, -2);
  });

  it('改人数：倍数小于 1 时人数减少', () => {
    const eng = nations();
    const cells = peopled(eng.world, 20);
    const before = popOf(eng.world, cells);
    eng.exec({ op: 'paint_pop', cells, mode: 'count', factor: 0.5 });
    expect(popOf(eng.world, cells)).toBeCloseTo(before * 0.5, -2);
  });

  it('改成分：负值把这一群体往外推，占比减少，人数不变', () => {
    const eng = nations();
    const w0 = eng.world;
    const cells = peopled(w0, 20).filter((i) => readComp(w0.causes, i).filter((x) => x.code).length >= 2);
    expect(cells.length).toBeGreaterThan(3);
    const i = cells[0];
    const top = readComp(w0.causes, i).find((x) => x.code)!;
    const group = w0.small.popGroups![top.code];
    const total = w0.causes.popTotal![i];
    eng.exec({ op: 'paint_pop', cells: [i], mode: 'share', group, amount: -0.5 });
    const w = eng.world;
    const after = readComp(w.causes, i).find((x) => x.code === top.code)?.s ?? 0;
    expect(after).toBeLessThan(top.s * 0.6);
    expect(w.causes.popTotal![i]).toBe(total);
    expect(w.causes.popManual![i]).toBe(1);
  });

  it('改一个维度：负值让这个取值的人减少', () => {
    const eng = nations();
    const w0 = eng.world;
    const dim = worldDimensions(w0.small)[0];
    const values = dimensionValues(w0.small, dim.id);
    const cells = peopled(w0, 200);
    // 这一格最多的取值
    const valueAt = (w: World, i: number, v: string) =>
      readComp(w.causes, i)
        .filter((x) => x.code && w.small.popGroups![x.code].values[dim.id] === v)
        .reduce((a, x) => a + x.s, 0);
    const v = values.find((x) => cells.some((i) => valueAt(w0, i, x.id) > 0.5))!;
    const target = cells.filter((i) => valueAt(w0, i, v.id) > 0.5).slice(0, 10);
    const before = target.map((i) => valueAt(w0, i, v.id));
    eng.exec({ op: 'paint_pop', cells: target, mode: 'value', dimension: dim.id, value: v.id, amount: -0.6 });
    target.forEach((i, q) => expect(valueAt(eng.world, i, v.id)).toBeLessThan(before[q] - 0.2));
  });

  it('去掉人文时快照清空，撤销时回来', () => {
    const eng = nations();
    const t = eng.world.causes.popAutoTotal!.slice();
    eng.exec({ op: 'remove_human' });
    expect(eng.world.causes.popAutoTotal!.every((x) => x === 0)).toBe(true);
    eng.undo();
    expect(eng.world.causes.popAutoTotal).toEqual(t);
  });
});
