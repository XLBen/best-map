import { describe, expect, it } from 'vitest';
import './content/kinds';
import { type FieldDesc, kindOf } from './content/registry';
import { BANK_RADIUS, BIOME_RADIUS, COMPETITION, EFFECT_DP, EFFECT_DT, INVADE_STRENGTH, type NumRange, RAIN_SCALE, RIVER_WIDTH, VISUAL_AMOUNT, VISUAL_GLOW, VISUAL_SIZE, dpOfPercent, percentOfDp, rainText } from './effect-ranges';
import { HEIGHT_RANGE, speciesSchema } from './species';
import { lakeTypeSchema } from './lake-types';
import { riverTypeSchema } from './river-types';

// 第九十三轮：同一个数一套范围和单位。生态编辑器的滑块和通用表单的字段表以前各写各的
// （变暖变冷一处 ±5、一处 ±10；变湿变干一处写百分比、一处写指数；范围一处“千米”、一处“km”）；现在两处都引用这里。
// 只是滑块的范围：已有的值不换算，格式收的范围照旧

const field = (kind: string, ...path: string[]): FieldDesc => {
  let fs: readonly FieldDesc[] = kindOf(kind)!.fields;
  let f: FieldDesc | undefined;
  for (const k of path) {
    f = fs.find((x) => x.key === k);
    if (!f) throw new Error(`${kind} 没有 ${path.join('.')}`);
    fs = f.of ?? [];
  }
  return f!;
};
const rangeOf = (f: FieldDesc): NumRange => ({ min: f.min!, max: f.max!, step: f.step!, ...(f.unit ? { unit: f.unit } : {}) });

describe('字段表引用的是这里的定义', () => {
  it('生态“对周围的影响”和河、湖“岸边的影响”：变暖变冷、变湿变干同一套', () => {
    for (const f of [field('biome', 'effects', 'climate', 'dT'), field('riverType', 'bank', 'dT'), field('lakeType', 'bank', 'dT')]) expect(rangeOf(f)).toEqual(EFFECT_DT);
    for (const f of [field('biome', 'effects', 'climate', 'dP'), field('riverType', 'bank', 'dP'), field('lakeType', 'bank', 'dP')]) {
      expect(rangeOf(f)).toEqual(EFFECT_DP);
      expect(f.show).toBe('expPercent');
    }
    expect(rangeOf(field('biome', 'effects', 'climate', 'radiusKm'))).toEqual(BIOME_RADIUS);
    expect(rangeOf(field('riverType', 'bank', 'radiusKm'))).toEqual(BANK_RADIUS);
    expect(rangeOf(field('lakeType', 'bank', 'radiusKm'))).toEqual(BANK_RADIUS);
    // 两种范围是两个数（格式收的不同），步子、单位一样
    expect([BIOME_RADIUS.step, BIOME_RADIUS.unit]).toEqual([BANK_RADIUS.step, BANK_RADIUS.unit]);
  });

  it('强弱、侵占的力度、图案的三项、高度范围、河的粗细', () => {
    expect(rangeOf(field('biome', 'competition'))).toEqual(COMPETITION);
    expect(rangeOf(field('biome', 'effects', 'invade', 'strength'))).toEqual(INVADE_STRENGTH);
    expect(rangeOf(field('biome', 'visual', 'amount'))).toEqual(VISUAL_AMOUNT);
    expect(rangeOf(field('biome', 'visual', 'size'))).toEqual(VISUAL_SIZE);
    expect(rangeOf(field('biome', 'visual', 'glow'))).toEqual(VISUAL_GLOW);
    expect(rangeOf(field('biome', 'height'))).toEqual(HEIGHT_RANGE);
    expect(rangeOf(field('riverType', 'width'))).toEqual(RIVER_WIDTH);
  });

  it('滑块的范围都在格式收的范围里（滑块停得到的数都存得进去）', () => {
    const sp = { id: 'x', name: 'x', color: '#112233', terrain: 'plains', competition: 1, tolerances: [] };
    const okSpecies = (patch: Record<string, unknown>) => speciesSchema.safeParse({ ...sp, ...patch }).success;
    for (const v of [COMPETITION.min, COMPETITION.max]) expect(okSpecies({ competition: v })).toBe(true);
    for (const dT of [EFFECT_DT.min, EFFECT_DT.max])
      for (const dP of [EFFECT_DP.min, EFFECT_DP.max])
        for (const radiusKm of [BIOME_RADIUS.min, BIOME_RADIUS.max]) expect(okSpecies({ effects: { climate: { dT, dP, radiusKm } } })).toBe(true);
    for (const strength of [INVADE_STRENGTH.min, INVADE_STRENGTH.max]) expect(okSpecies({ effects: { invade: { targets: ['y'], strength } } })).toBe(true);
    for (const size of [VISUAL_SIZE.min, VISUAL_SIZE.max]) expect(okSpecies({ visual: { pattern: 'spots', size, amount: VISUAL_AMOUNT.max, glow: VISUAL_GLOW.max } })).toBe(true);
    for (const schema of [riverTypeSchema, lakeTypeSchema])
      for (const radiusKm of [BANK_RADIUS.min, BANK_RADIUS.max]) expect(schema.safeParse({ id: 'w', name: 'w', color: '#112233', bank: { radiusKm, dT: EFFECT_DT.min, dP: EFFECT_DP.max } }).success).toBe(true);
    for (const width of [RIVER_WIDTH.min, RIVER_WIDTH.max]) expect(riverTypeSchema.safeParse({ id: 'w', name: 'w', color: '#112233', width }).success).toBe(true);
  });
});

describe('变湿变干：存的是指数，写的是降水的百分之几', () => {
  it('百分比与指数互换（和以前生态编辑器里的一样）', () => {
    expect(percentOfDp(0)).toBe(0);
    expect(dpOfPercent(0)).toBe(0);
    for (const p of [-50, -25, -5, 5, 20, 100, 300]) expect(percentOfDp(dpOfPercent(p))).toBe(p);
    // 超出格式的范围：夹到两头
    expect(dpOfPercent(-99)).toBe(EFFECT_DP.min);
    expect(dpOfPercent(900)).toBe(EFFECT_DP.max);
  });

  it('滑块：正中是不变，左右对称，停在 5% 的整数倍上；两头是格式的上下限', () => {
    expect(RAIN_SCALE.at(0.5)).toBe(0);
    expect(RAIN_SCALE.pos(0)).toBe(0.5);
    expect(RAIN_SCALE.at(0)).toBe(EFFECT_DP.min);
    expect(RAIN_SCALE.at(1)).toBe(EFFECT_DP.max);
    for (let k = 1; k < 40; k++) {
      const dP = RAIN_SCALE.at(k / 40);
      expect(percentOfDp(dP) % 5 === 0 || dP === EFFECT_DP.min || dP === EFFECT_DP.max, `${k}`).toBe(true);
      // 停得到的数原样回来
      expect(RAIN_SCALE.at(RAIN_SCALE.pos(dP))).toBe(dP);
    }
    for (const p of [-50, -20, 20, 100]) expect(RAIN_SCALE.at(RAIN_SCALE.pos(dpOfPercent(p)))).toBe(dpOfPercent(p));
  });

  it('已有的值不换算：只是换一种写法', () => {
    expect(rainText(0)).toBe('不变');
    expect(rainText(0.1823)).toBe('降水 +20%');
    expect(rainText(-0.2231)).toBe('降水 −20%');
    // 库里超出以前滑块范围的值（降水 −78%）照样写得出来
    expect(rainText(-1.5)).toBe('降水 −78%');
  });
});
