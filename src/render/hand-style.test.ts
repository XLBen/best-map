import { describe, expect, it } from 'vitest';
import { FALLBACK_MAP_STYLE, HAND_OFF, handLook, hasSymbols, mapStyleKey, mapStyleSchema } from '../../core/map-style';
import { BUILTIN_MAP_STYLES, DRAWN_MAP_STYLES, HAND_LABEL_FONT, HAND_STYLE_ID } from '../../core/packs/map-styles';
import { COUNTRY_FONT, countryFamily } from './overlay-country-labels';
import { SETTLE_FONT, labelFamily } from './overlay-labels';
import { styleUniforms } from './style-uniforms';
import { COMPOSE_SOURCES } from './shaders';

// 第八十七轮：手绘画风。写实、地图册不写手绘的几项（内容与以前逐字节相同），上传的 uniform 里手绘那一段是关着的（uHand = 0），
// 字体照旧；手绘的几项、uniform 按画风来

const HAND_KEYS = [...Object.keys(HAND_OFF), 'labelFont'];
const f32 = (xs: readonly number[]) => xs.map(Math.fround);

describe('手绘画风', () => {
  it('写实、地图册不写手绘的几项：对象里没有这些键（库里、世界里的内容与以前相同）', () => {
    for (const s of BUILTIN_MAP_STYLES) for (const k of HAND_KEYS) expect(k in s, `${s.id}.${k}`).toBe(false);
    for (const k of HAND_KEYS) expect(k in FALLBACK_MAP_STYLE).toBe(false);
    // 照着格式补默认值时也不补这几项
    const parsed = mapStyleSchema.parse({ id: 'x', name: 'x' });
    for (const k of HAND_KEYS) expect(k in parsed, k).toBe(false);
  });

  it('写实、地图册：手绘那一段关着（uHand 0、纸 0、水彩 0、水纹 0），不画符号，字体照旧', () => {
    for (const s of [...BUILTIN_MAP_STYLES, FALLBACK_MAP_STYLE]) {
      const u = styleUniforms(s);
      expect(u.hand, s.id).toBe(0);
      expect(u.paper[3]).toBe(0);
      expect(u.wash).toBe(0);
      expect(u.ripple[3]).toBe(0);
      expect(hasSymbols(s)).toBe(false);
      expect(handLook(s)).toEqual({ ...HAND_OFF, labelFont: null });
      expect(labelFamily(s)).toBe('system-ui, "PingFang SC", sans-serif');
      expect(labelFamily(s)).toBe(SETTLE_FONT);
      expect(countryFamily(s)).toBe(COUNTRY_FONT);
    }
  });

  it('手绘：纸、水彩、三道水纹、山与森林的符号、楷体、导出时加装饰；uniform 按颜色 / 255 上传', () => {
    const [h] = DRAWN_MAP_STYLES;
    expect(h.id).toBe(HAND_STYLE_ID);
    expect(mapStyleSchema.parse(h)).toEqual(h);
    const u = styleUniforms(h);
    expect(u.hand).toBe(1);
    expect(Array.from(u.paper)).toEqual(f32([238 / 255, 226 / 255, 196 / 255, 1]));
    expect(Math.fround(u.wash)).toBe(Math.fround(0.6));
    expect(Array.from(u.ripple)).toEqual(f32([72 / 255, 96 / 255, 108 / 255, 3]));
    expect(u.seaTiers).toBe(1);
    expect(u.shadeTint).toBe(1);
    expect(hasSymbols(h)).toBe(true);
    expect(handLook(h).exportDecor).toBe(true);
    expect(labelFamily(h)).toBe(HAND_LABEL_FONT);
    expect(countryFamily(h)).toBe(HAND_LABEL_FONT);
    // 楷体的后备是本机的楷体
    expect(HAND_LABEL_FONT).toContain('"LXGW WenKai"');
    expect(HAND_LABEL_FONT).toContain('"Kaiti SC"');
    // 签名里有手绘的几项（换了就重画）
    expect(mapStyleKey(h)).not.toBe(mapStyleKey(BUILTIN_MAP_STYLES[1]));
    expect(mapStyleKey({ ...h, ripples: 2 })).not.toBe(mapStyleKey(h));
  });

  it('只有一项开着也走手绘那一段（只开水纹）；只开符号不走', () => {
    const base = BUILTIN_MAP_STYLES[0];
    expect(styleUniforms({ ...base, ripples: 2 }).hand).toBe(1);
    expect(styleUniforms({ ...base, mountains: true }).hand).toBe(0);
  });

  it('合成着色器：手绘那一段只在 uHand == 1 时走，平面、星球两份都有', () => {
    for (const src of Object.values(COMPOSE_SOURCES)) {
      expect(src).toContain('uniform int uHand;');
      expect(src).toContain('if (uHand == 1) col = handLook(col, world, sUv, hs.g, land, base.a);');
    }
  });
});
