import { describe, expect, it } from 'vitest';
import { FRAG_FREQ, FRAG_OFF, fragCoast, fragIsleHeight, fragSeaDepth } from '../../core/subcell';
import { FRAG_GLSL, PROJ_SOURCES, TERRAIN_SOURCES } from './renderer';

// 第十八轮：着色器里的破碎度（FRAG_GLSL）与 core/subcell.ts 的 CPU 版本是同一个算式。
// 这一段只用标量（float、min、max、abs），把它照字面换成 JS 跑一遍，与 CPU 版本逐个比（着色器是单精度，差在千分之一以内）

function transliterate(src: string): Record<string, (...a: number[]) => number> {
  const js = src
    .replace(/\bfloat\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (_m, name: string, args: string) => `fns.${name} = function (${args.replace(/\bfloat\s+/g, '')}) {`)
    .replace(/\bfloat\s+/g, 'let ')
    .replace(/\b(min|max|abs)\(/g, 'Math.$1(');
  const fns: Record<string, (...a: number[]) => number> = {};
  new Function('fns', js)(fns);
  return fns;
}

describe('着色器里的破碎度与 CPU 版本相同', () => {
  const g = transliterate(FRAG_GLSL);

  it('fragCoast、碎岛的高度、破碎的海的水深：随机取几千组输入，与 CPU 版本一致', () => {
    let seed = 7;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let k = 0; k < 5000; k++) {
      const sv = (rnd() * 2 - 1) * 250;
      const det = (rnd() * 2 - 1) * 150;
      const fv = k % 10 === 0 ? 1 : rnd();
      const w = rnd();
      const n = (rnd() * 2 - 1) * 0.9;
      const cpu = fragCoast(sv, det, fv, w, n);
      expect(g.fragCoast(sv, det, fv, w, n)).toBeCloseTo(cpu, 6);
      const s = rnd() * 200;
      expect(g.fragIsleHeight(s)).toBeCloseTo(fragIsleHeight(s), 9);
      const h = -rnd() * 5000;
      expect(g.fragSeaDepth(h, fv)).toBeCloseTo(fragSeaDepth(h, fv), 6);
    }
    // fv → 0 时与没有破碎度的算式连续（碎与不碎的交界没有断口）
    expect(fragCoast(-120, 30, 1e-9, 1, 0.5)).toBeCloseTo(-120 + 30, 5);
    expect(fragCoast(180, -20, 1e-9, 0.7, -0.2)).toBeCloseTo(180 - 20, 5);
    // 格心（weight = 0）的正负与插值的海岸值一致：格心的陆海不变
    for (const sv of [-250, -3, 2, 240]) for (const fv of [0.1, 0.5, 1]) expect(Math.sign(fragCoast(sv, 0, fv, 0, 0.9))).toBe(Math.sign(sv));
  });

  it('地形着色器（平面、星球、极地）只在 vFrag > 0 时用它，碎岛的噪声与 CPU 的频率、偏移相同', () => {
    const plane = `fbmSub(vWorld / uSpacing * ${FRAG_FREQ} + vec2(${FRAG_OFF[0]}, ${FRAG_OFF[1]}), 3)`;
    const sphere = `fbmSub3(P * (uNoiseK * ${FRAG_FREQ}) + vec3(${FRAG_OFF.join(', ')}), 3)`;
    expect(TERRAIN_SOURCES.plane).toContain(`if (vFrag > 0.0) s = fragCoast(vCoast, det, vFrag, weight, ${plane});`);
    for (const src of [TERRAIN_SOURCES.planet, PROJ_SOURCES.polarTerrainFs]) expect(src).toContain(`if (vFrag > 0.0) s = fragCoast(vCoast, det, vFrag, weight, ${sphere});`);
    for (const src of [TERRAIN_SOURCES.plane, TERRAIN_SOURCES.planet, PROJ_SOURCES.polarTerrainFs]) {
      expect(src).toContain('float s = vCoast + det;');
      expect(src).toContain('if (vFrag > 0.0) hh = max(hh, fragIsleHeight(s));');
      expect(src).toContain('(vFrag > 0.0 ? fragSeaDepth(seaE, vFrag) : seaE)');
    }
    // 顶点着色器把海岸值纹理的 g 交给 vFrag
    expect(PROJ_SOURCES.polarCellVs).toContain('vFrag = cf.g;');
  });
});
