// 画风的 uniform（第八十三轮从 src/render/renderer.ts 原样搬出）
import { styleRgba, type MapStyle } from '../../core/map-style';

// 画风（第三十八轮）在合成着色器里的 uniform：颜色按 r / 255 上传（float32 与第三十七轮写在着色器里的常数逐位相同，测试查）。
// 按画风对象记住，每帧只上传
export interface StyleUniforms {
  landTint: Float32Array;
  shadeTint: number;
  shadeDark: Float32Array;
  shadeLight: Float32Array;
  seaTiers: number;
  seaTier: Float32Array;
  seaDepth: Float32Array;
  isobath: Float32Array;
  seaShade: Float32Array;
  tierShade: Float32Array;
  glowGain: number;
  coastLine: Float32Array;
  provLine: Float32Array;
  countryLine: Float32Array;
}
const styleUniformCache = new WeakMap<object, StyleUniforms>();
const unitRgb = (c: string): number[] => {
  const v = styleRgba(c) ?? [0, 0, 0, 1];
  return [v[0] / 255, v[1] / 255, v[2] / 255];
};
// 明暗 x + y · shade：y 是“海的明暗”，x = 1 − y（在 JS 里按双精度减，与以前写的 0.86、0.94 一样）
const shadePair = (k: number) => new Float32Array([1 - k, k]);
export function styleUniforms(style: MapStyle): StyleUniforms {
  let u = styleUniformCache.get(style);
  if (!u) {
    u = {
      landTint: new Float32Array([...unitRgb(style.landTint), style.landTintAmount]),
      shadeTint: style.landShade === 'tinted' ? 1 : 0,
      shadeDark: new Float32Array(unitRgb(style.shadeDark)),
      shadeLight: new Float32Array(unitRgb(style.shadeLight)),
      seaTiers: style.sea === 'tiers' ? 1 : 0,
      seaTier: new Float32Array([style.tier1, style.tier2, style.tier3, style.tier4].flatMap(unitRgb)),
      seaDepth: new Float32Array([style.depth2, style.depth3, style.depth4]),
      isobath: new Float32Array([...unitRgb(style.isobath), style.isobathAmount]),
      seaShade: shadePair(style.seaShade),
      tierShade: shadePair(style.tierShade),
      glowGain: style.glow,
      coastLine: new Float32Array([...unitRgb(style.coastLine), style.coastAmount]),
      provLine: new Float32Array(unitRgb(style.provinceLine)),
      countryLine: new Float32Array(unitRgb(style.countryLine)),
    };
    styleUniformCache.set(style, u);
  }
  return u;
}
