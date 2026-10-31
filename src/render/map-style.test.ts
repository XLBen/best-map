import { describe, expect, it } from 'vitest';
import { FALLBACK_MAP_STYLE } from '../../core/map-style';
import { BUILTIN_MAP_STYLES } from '../../core/packs/map-styles';
import { lakeTypeColor } from './colors';
import { riverStroke, riverTypeColor } from './overlay';
import { styleUniforms } from './renderer';
import { roadStyle } from './settle-draw';

// 第三十八轮：内置的写实、地图册与第三十七轮写死在代码里的常数逐值相同。
// 着色器：uniform 上传的 float32 与原来着色器里的字面常数（也是 float32）逐位相同；画布：颜色字符串与原来的表一模一样

const [REALISTIC, ATLAS] = BUILTIN_MAP_STYLES;
const f32 = (xs: readonly number[]) => xs.map(Math.fround);
const arr = (a: Float32Array) => Array.from(a);

// 第三十七轮的着色器里写的常数（renderer.ts 的 FS_COMPOSE，uStyle == 1 是地图册）
const OLD_SHADER = {
  realistic: {
    seaShade: [0.86, 0.14],
    glowGain: 0.6,
    coastLine: [0.18, 0.22, 0.24, 0.4],
    provLine: [0.12, 0.1, 0.08],
    countryLine: [0.16, 0.11, 0.1],
  },
  atlas: {
    landTint: [0.93, 0.87, 0.72, 0.3],
    shadeDark: [0.62, 0.52, 0.42],
    shadeLight: [1.04, 1.02, 0.98],
    seaTier: [0.8, 0.88, 0.89, 0.73, 0.83, 0.86, 0.66, 0.77, 0.82, 0.59, 0.71, 0.78],
    seaDepth: [200, 1000, 3000],
    isobath: [0.45, 0.58, 0.66, 0.35],
    // 海面是数据（海水温度）时与写实一样
    seaShade: [0.86, 0.14],
    tierShade: [0.94, 0.06],
    glowGain: 0.3,
    coastLine: [0.35, 0.27, 0.2, 0.8],
    provLine: [0.45, 0.2, 0.15],
    countryLine: [0.42, 0.14, 0.1],
  },
};

// 第三十七轮的画布颜色表（overlay.ts 的 riverStroke、BANK_COLOR、COUNTRY_COLOR，settle-draw.ts 的 ROAD_COLOR 等）
const OLD_CANVAS = {
  realistic: { river: 'rgba(52, 104, 168, 0.92)', bank: 'rgba(24, 52, 88, 0.55)', road: 'rgba(84, 38, 22, 0.92)', roadMinor: 'rgba(70, 36, 22, 0.8)', quiet: 'rgba(52, 44, 38, 0.45)', quietMinor: 'rgba(52, 44, 38, 0.3)', country: 'rgba(36, 28, 24, 0.8)' },
  atlas: { river: 'rgba(70, 110, 150, 0.95)', bank: 'rgba(48, 70, 92, 0.55)', road: 'rgba(120, 36, 24, 0.92)', roadMinor: 'rgba(110, 34, 22, 0.8)', quiet: 'rgba(84, 46, 34, 0.45)', quietMinor: 'rgba(84, 46, 34, 0.3)', country: 'rgba(78, 34, 24, 0.82)' },
};

describe('内置画风与第三十七轮的常数逐值相同', () => {
  it('写实：uniform 与原来着色器里的常数相同；不混底色、山影平常、海按明暗', () => {
    const u = styleUniforms(REALISTIC);
    const o = OLD_SHADER.realistic;
    expect(u.landTint[3]).toBe(0);
    expect(u.shadeTint).toBe(0);
    expect(u.seaTiers).toBe(0);
    expect(arr(u.seaShade)).toEqual(f32(o.seaShade));
    expect(Math.fround(u.glowGain)).toBe(Math.fround(o.glowGain));
    expect(arr(u.coastLine)).toEqual(f32(o.coastLine));
    expect(arr(u.provLine)).toEqual(f32(o.provLine));
    expect(arr(u.countryLine)).toEqual(f32(o.countryLine));
    // 没有画风的世界按的默认画法与写实画出来一样
    const fb = styleUniforms(FALLBACK_MAP_STYLE);
    for (const k of Object.keys(u) as (keyof typeof u)[]) expect(fb[k], k).toEqual(u[k]);
  });

  it('地图册：羊皮纸底色、暖色山影、四层海、等深线、线条的 uniform 与原来的常数相同', () => {
    const u = styleUniforms(ATLAS);
    const o = OLD_SHADER.atlas;
    expect(u.shadeTint).toBe(1);
    expect(u.seaTiers).toBe(1);
    expect(arr(u.landTint)).toEqual(f32(o.landTint));
    expect(arr(u.shadeDark)).toEqual(f32(o.shadeDark));
    expect(arr(u.shadeLight)).toEqual(f32(o.shadeLight));
    expect(arr(u.seaTier)).toEqual(f32(o.seaTier));
    expect(arr(u.seaDepth)).toEqual(f32(o.seaDepth));
    expect(arr(u.isobath)).toEqual(f32(o.isobath));
    expect(arr(u.seaShade)).toEqual(f32(o.seaShade));
    expect(arr(u.tierShade)).toEqual(f32(o.tierShade));
    expect(Math.fround(u.glowGain)).toBe(Math.fround(o.glowGain));
    expect(arr(u.coastLine)).toEqual(f32(o.coastLine));
    expect(arr(u.provLine)).toEqual(f32(o.provLine));
    expect(arr(u.countryLine)).toEqual(f32(o.countryLine));
    // 按对象记住：同一个画风每帧拿到同一份
    expect(styleUniforms(ATLAS)).toBe(u);
  });

  it('画布：河、河岸、道路、国名的颜色与原来的表相同；河湖的种类写实用颜色、地图册用另一种颜色', () => {
    for (const [s, o] of [
      [REALISTIC, OLD_CANVAS.realistic],
      [ATLAS, OLD_CANVAS.atlas],
    ] as const) {
      expect(riverStroke(s), s.id).toBe(o.river);
      expect(s.riverBank, s.id).toBe(o.bank);
      expect(s.countryLabel, s.id).toBe(o.country);
      const clear = roadStyle({ clear: true }, s);
      const quiet = roadStyle({}, s);
      expect([clear.major.color, clear.minor.color, quiet.major.color, quiet.minor.color], s.id).toEqual([o.road, o.roadMinor, o.quiet, o.quietMinor]);
    }
    const t = { color: '#9b1b1b', atlasColor: '#a3302a' };
    expect([riverTypeColor(t, REALISTIC), lakeTypeColor(t, REALISTIC)]).toEqual(['#9b1b1b', '#9b1b1b']);
    expect([riverTypeColor(t, ATLAS), lakeTypeColor(t, ATLAS)]).toEqual(['#a3302a', '#a3302a']);
    expect(lakeTypeColor({ color: '#9b1b1b' }, ATLAS)).toBe('#9b1b1b');
  });

  it('改一份画风：uniform 跟着变（海的第二层、海的明暗）', () => {
    const mine = { ...ATLAS, tier2: '#204060', tierShade: 0.2 };
    const u = styleUniforms(mine);
    expect(arr(u.seaTier).slice(3, 6)).toEqual(f32([0x20 / 255, 0x40 / 255, 0x60 / 255]));
    expect(arr(u.tierShade)).toEqual(f32([0.8, 0.2]));
  });
});
