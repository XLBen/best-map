import { describe, expect, it } from 'vitest';
import { PLAIN_LAKE, lakeParts } from '../../core/lake-types';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { LAKE_GLOW, LAKE_LAND_GLOW, LAKE_WATER_CRUST, LAKE_WATER_TINT, lakeTintLayer, lakeTypeColor } from '../render/colors';
import { setOptions } from '../state';
import { chosenLakeType, lakeInfo, lakeList, lakeRefAt, lakeTypeChoiceCommand, lakeTypeOfLake } from './lakeInfo';
import { newWaterType } from './panels/waterTypes';

// 湖（第九轮）：点中的是哪个湖、给它选类型的命令、新放的湖带的类型、湖的颜色

const blood = { id: 'blood_pool', name: '血池', color: '#9b1b1b', atlasColor: '#a3302a' };

function setup() {
  const eng = continents();
  const w = eng.world;
  const d = w.derived;
  const cells: number[] = [];
  for (let i = 0; i < w.mesh.n && cells.length < 2; i++) {
    if (!w.causes.land[i] || d.lake[i] || d.continentality[i] < 0.55 || d.slope[i] > 6) continue;
    if (cells.some((c) => Math.hypot(w.mesh.x[c] - w.mesh.x[i], w.mesh.y[c] - w.mesh.y[i]) < 0.15)) continue;
    cells.push(i);
  }
  cells.forEach((cell, k) => eng.exec({ op: 'add_lake', lake: { id: `L${k}`, cell, radius: 120, depth: 150, perennial: true } }));
  return { eng, w, cells };
}

const rgbAt = (out: Uint8Array, i: number) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]];

describe('点中的湖、给湖选类型', () => {
  it('点在放的湖上是那个放的湖；不是湖为 null', () => {
    const { w, cells } = setup();
    expect(lakeRefAt(w, cells[0])).toEqual({ kind: 'placed', id: 'L0' });
    const dry = cells[0] + 0;
    expect(lakeInfo(w, { kind: 'placed', id: 'L0' })!.cells).toContain(dry);
    const notLake = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && !w.derived.lake[i])!;
    expect(lakeRefAt(w, notLake)).toBeNull();
  });

  it('放的湖改自己的 type；自然的湖记进 lakeTyping（这个湖里原来选的先去掉）；没有规则时“普通的湖”就是不选', () => {
    const { eng, w, cells } = setup();
    eng.exec({ op: 'set_lake_type', type: blood });
    expect(lakeTypeChoiceCommand(w, { kind: 'placed', id: 'L0' }, blood.id)).toMatchObject({ op: 'update_lake', id: 'L0', patch: { type: blood.id } });
    expect(lakeTypeChoiceCommand(w, { kind: 'placed', id: 'L0' }, PLAIN_LAKE)).toBeNull();
    // 当作自然的湖（这一格所在的那片）
    const ref = { kind: 'natural' as const, cell: cells[1] };
    const cmd = lakeTypeChoiceCommand({ ...w, small: { ...w.small, lakes: [w.small.lakes[0]] } }, ref, blood.id)!;
    expect(cmd).toMatchObject({ op: 'type_lake', cell: cells[1], type: blood.id });
    eng.exec(cmd);
    // 这片湖里有放的湖 L1：它没选，这片湖选的照样算
    expect(lakeTypeOfLake(w, { kind: 'placed', id: 'L1' })).toMatchObject({ chosen: 'type', type: { id: blood.id } });
    // 给 L1 改回按规则：这片湖原来选的也一起去掉
    expect(lakeTypeChoiceCommand(w, { kind: 'placed', id: 'L1' }, null)).toMatchObject({ op: 'type_lake', type: null, drop: [cells[1]] });
    expect(w.derived.lakeType![cells[1]]).toBe(1);
    const parts = lakeParts(w, w.derived);
    const other = Array.from(parts.lakes[parts.of[cells[1]]]).find((c) => c !== cells[1])!;
    eng.exec({ op: 'type_lake', cell: other, type: 'other' });
    const again = lakeTypeChoiceCommand({ ...w, small: { ...w.small, lakes: [w.small.lakes[0]] } }, ref, null)!;
    expect(again.op).toBe('type_lake');
    expect((again as { drop?: number[] }).drop?.length).toBe(2);
  });

  it('新放的湖带上工具条上选的类型；那种删掉了就不带；没有规则时 plain 不带', () => {
    const { eng, w } = setup();
    setOptions({ lakeType: blood.id });
    expect(chosenLakeType(w)).toEqual({});
    eng.exec({ op: 'set_lake_type', type: blood });
    expect(chosenLakeType(w)).toEqual({ type: blood.id });
    setOptions({ lakeType: PLAIN_LAKE });
    expect(chosenLakeType(w)).toEqual({});
    setOptions({ lakeType: '' });
    expect(newWaterType(w, 'lake').id).toBe('lake-type-1');
  });
});

describe('一片湖里放了两个湖：与引擎同一个规则', () => {
  it('前一个带类型、后一个没带：显示前一个的类型；改回按规则两个都清掉；给后一个选别的，前一个的去掉', () => {
    const { eng, w, cells } = setup();
    eng.exec({ op: 'set_lake_type', type: blood });
    eng.exec({ op: 'set_lake_type', type: { id: 'ice', name: '冰湖', color: '#ccefff' } });
    eng.exec({ op: 'update_lake', id: 'L0', patch: { type: blood.id } });
    // 在 L0 的湖里再放一个小湖（后放的，没带类型）
    const inner = lakeInfo(w, { kind: 'placed', id: 'L0' })!.cells.find((c) => c !== cells[0] && w.derived.lake[c] === 1)!;
    eng.exec({ op: 'add_lake', lake: { id: 'L9', cell: inner, radius: 20, depth: 150, perennial: true } });
    const ref = lakeRefAt(w, cells[0])!;
    expect(ref).toEqual({ kind: 'placed', id: 'L9' });
    expect(w.derived.lakeType![cells[0]]).toBe(1);
    expect(lakeTypeOfLake(w, ref)).toMatchObject({ chosen: 'type', type: { id: blood.id } });
    const clear = lakeTypeChoiceCommand(w, ref, null)!;
    expect(clear).toMatchObject({ op: 'update_lake', id: 'L0', patch: { type: null } });
    const ice = lakeTypeChoiceCommand(w, ref, 'ice')!;
    eng.exec(ice);
    expect(w.small.lakes.find((l) => l.id === 'L0')!.type).toBeUndefined();
    expect(w.small.lakes.find((l) => l.id === 'L9')!.type).toBe('ice');
    expect(lakeTypeOfLake(w, ref)).toMatchObject({ chosen: 'type', type: { id: 'ice' } });
    eng.exec(lakeTypeChoiceCommand(w, ref, null)!);
    expect(lakeTypeOfLake(w, ref).chosen).toBeNull();
    expect(w.small.lakes.every((l) => l.type === undefined)).toBe(true);
  });
});

// 第十二轮修：“水系 ⋯”里“湖”那一栏列出全部的湖（名字、面积、是哪一种），点一下选中、镜头移过去
describe('湖的列表（lakeList）', () => {
  it('每片湖列一次（里面有放的湖时是那个放的湖），从大到小；名字、面积、类型与点中这个湖时一样', () => {
    const { eng, w } = setup();
    eng.exec({ op: 'set_lake_type', type: blood });
    eng.exec(lakeTypeChoiceCommand(w, { kind: 'placed', id: 'L0' }, blood.id)!);
    const list = lakeList(w);
    expect(list.map((x) => x.ref).filter((r) => r.kind === 'placed')).toEqual(expect.arrayContaining([{ kind: 'placed', id: 'L0' }, { kind: 'placed', id: 'L1' }]));
    // 每格只在一个湖里，湖格都列到了
    const seen = new Set<number>();
    for (const { info } of list) for (const c of info.cells) {
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
    const lakeCells = [...Array(w.mesh.n).keys()].filter((c) => w.derived.lake[c] && w.causes.land[c]);
    expect(seen.size).toBe(lakeCells.length);
    for (let k = 1; k < list.length; k++) expect(list[k - 1].info.areaKm2).toBeGreaterThanOrEqual(list[k].info.areaKm2);
    for (const { ref, info, type } of list) {
      const again = lakeInfo(w, ref)!;
      expect(again.cells).toEqual(info.cells);
      expect(again.feature?.name).toBe(info.feature?.name);
      expect(lakeRefAt(w, info.cells[0])).toEqual(ref);
      expect(type).toEqual(lakeTypeOfLake(w, ref).type);
    }
    const l0 = list.find((x) => x.ref.kind === 'placed' && x.ref.id === 'L0')!;
    expect(l0.type?.id).toBe(blood.id);
    expect(l0.info.feature?.name).toBeTruthy();
    expect(l0.info.areaKm2).toBeGreaterThan(1000);
  });
});

describe('湖的颜色（lakeTintLayer）', () => {
  it('没有湖泊类型时为 null；有类型的湖面染上它的颜色，地图集用 atlasColor；画法写进 alpha', () => {
    const { eng, w, cells } = setup();
    expect(lakeTintLayer(w, { mode: 'terrain' }, 'realistic')).toBeNull();
    eng.exec({ op: 'set_lake_type', type: blood });
    // 有类型但一个湖都不是：也是 null
    expect(lakeTintLayer(w, { mode: 'terrain' }, 'realistic')).toBeNull();
    eng.exec({ op: 'update_lake', id: 'L0', patch: { type: blood.id } });
    const out = lakeTintLayer(w, { mode: 'terrain' }, 'realistic')!;
    expect(rgbAt(out, cells[0])).toEqual([0x9b, 0x1b, 0x1b]);
    expect(out[cells[0] * 4 + 3] & 3).toBe(LAKE_WATER_TINT);
    // 别的湖不染
    expect(out[cells[1] * 4 + 3]).toBe(0);
    const atlas = lakeTintLayer(w, { mode: 'terrain' }, 'atlas')!;
    expect(rgbAt(atlas, cells[0])).toEqual([0xa3, 0x30, 0x2a]);
    expect(lakeTypeColor(blood, 'atlas')).toBe('#a3302a');
    // 数据底图（气温……）不画
    expect(lakeTintLayer(w, { mode: 'temperature' }, 'realistic')).toBeNull();
    // 干湖底的画法：水面是盐壳；发光：湖面发光，湖岸一圈光晕
    eng.exec({ op: 'set_lake_type', type: { ...blood, style: 'playa' } });
    expect(lakeTintLayer(w, { mode: 'terrain' }, 'realistic')![cells[0] * 4 + 3] & 3).toBe(LAKE_WATER_CRUST);
    eng.exec({ op: 'set_lake_type', type: { ...blood, style: 'glow' } });
    const glow = lakeTintLayer(w, { mode: 'terrain' }, 'realistic')!;
    expect(glow[cells[0] * 4 + 3] & LAKE_GLOW).toBe(LAKE_GLOW);
    const lake = new Set(lakeInfo(w, { kind: 'placed', id: 'L0' })!.cells);
    let halo = 0;
    for (let i = 0; i < w.mesh.n; i++) if (!lake.has(i) && glow[i * 4 + 3] & LAKE_LAND_GLOW) halo++;
    expect(halo).toBeGreaterThan(0);
  });

  it('湖岸那格挨着别的湖、挨着海时，那格里的水面像素不染（不会染到旁边的湖、海上）', () => {
    const { eng, w } = setup();
    eng.exec({ op: 'set_lake_type', type: blood });
    eng.exec({ op: 'update_lake', id: 'L0', patch: { type: blood.id } });
    const out = lakeTintLayer(w as World, { mode: 'terrain' }, 'realistic')!;
    const lt = w.derived.lakeType!;
    for (let i = 0; i < w.mesh.n; i++) {
      if (lt[i] || !(out[i * 4 + 3] & 3)) continue;
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) {
        const k = w.mesh.adj[e];
        expect(w.causes.land[k]).toBe(1);
        expect(w.derived.lake[k] === 1 && lt[k] !== 1).toBe(false);
      }
    }
  });
});
