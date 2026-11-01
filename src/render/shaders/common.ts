import { FRAG_AMP, FRAG_D_MAX, FRAG_D_MIN, FRAG_FREQ, FRAG_G, FRAG_OFF } from '../../../core/subcell';
import { LOOK, SKERRY_REACH } from '../../../core/coast-style';
import { FJ } from '../../../core/fjords';
import { PATTERNS } from '../../../core/species';
import { PATTERN_DETAIL, SEED_STEP, SPARKLE, SPARKLE3 } from '../../../core/biome-look';

// 着色器共用的片段（第四十一轮从 renderer.ts 原样搬来）：噪声、破碎度、海岸类型、峡湾、花纹、岩性

export const TEX_W = 1024;
// 海底的坡在晕渲里打几折（海底的坡比陆上陡得多，照陆上那样夸张会一片花）
export const SEA_RELIEF = 0.25;

export const NOISE_GLSL = `
uint hashU(ivec2 p) {
  uint a = uint(p.x) * 1664525u + 1013904223u;
  uint b = uint(p.y) * 1664525u + 1013904223u;
  a += b * 1664525u; b += a * 1664525u;
  a ^= a >> 16u; b ^= b >> 16u;
  a += b * 1664525u; b += a * 1664525u;
  a ^= a >> 16u; b ^= b >> 16u;
  return a ^ b;
}
float unitH(uint h) { return float(h & 0xFFFFFFu) / 16777216.0; }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 ii = ivec2(i);
  float a = unitH(hashU(ii)); float b = unitH(hashU(ii + ivec2(1, 0)));
  float c = unitH(hashU(ii + ivec2(0, 1))); float d = unitH(hashU(ii + ivec2(1, 1)));
  return (a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y) * 2.0 - 1.0;
}
float fbmSub(vec2 p, int oct) {
  float s = 0.0; float amp = 0.5;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    s += amp * vnoise(p);
    p = p * 2.03 + vec2(17.1, -9.3);
    amp *= 0.5;
  }
  return s;
}
`;

// 小湖群的水面在地形层的高度纹理里的海岸场（第三十四轮）：合成着色器认它（不进省份）
export const SPECK_MARK = -20000;

// 数 → GLSL 的浮点字面量（整数也带小数点）
export const glsl = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// 破碎度（第十八轮）：与 core/subcell.ts 的 fragCoast、fragIsleHeight、fragSeaDepth 同一个算式（测试里把这一段换成 JS 与它比）。
// 地形着色器里只在 vFrag > 0（三角形的角上有破碎的格）时才用，别处与以前逐位相同
export const FRAG_GLSL = `
float fragCoast(float sv, float det, float fv, float weight, float n) {
  float u = 1.0 - fv;
  float q = 1.0 - u * u * u;
  float d = ${glsl(FRAG_D_MAX)} + ${glsl(FRAG_D_MIN - FRAG_D_MAX)} * q;
  float c = min(d, max(-d, sv));
  float m = min(1.0, max(0.0, abs(n) * ${glsl(FRAG_G)})) * 2.0 - 1.0;
  return c + det + weight * ${glsl(FRAG_AMP)} * q * m;
}
float fragIsleHeight(float s) {
  return 2.0 + 0.5 * min(s, 60.0);
}
float fragSeaDepth(float h, float fv) {
  return h * (1.0 - 0.85 * fv);
}
`;
export const FRAG_N2 = `fbmSub(vWorld / uSpacing * ${glsl(FRAG_FREQ)} + vec2(${glsl(FRAG_OFF[0])}, ${glsl(FRAG_OFF[1])}), 3)`;
export const FRAG_N3 = `fbmSub3(P * (uNoiseK * ${glsl(FRAG_FREQ)}) + vec3(${FRAG_OFF.map(glsl).join(', ')}), 3)`;

// 海岸类型与小湖群（第三十四轮）：与 core/coast-style.ts 的 barrierDetail、fjordCut、barrierIsle、speckK、speckApply 同一个算式
// （测试里把这一段换成 JS 与它比）。峡湾的权重与方向、小湖群、沙坝在海岸值纹理的 b、a（顶点着色器拆开，见 VS_CELL）；
// 权重为 0 的地方整段跳过
export const STYLE_GLSL = `
float styleWeight(float wmax) {
  return min(1.0, max(0.0, (1.0 - wmax) * ${glsl(LOOK.STYLE_CENTER)}));
}
float sm01(float t) {
  float u = min(1.0, max(0.0, t));
  return u * u * (3.0 - 2.0 * u);
}
float barrierDetail(float bw) {
  return 1.0 - ${glsl(LOOK.BAR_SMOOTH)} * bw;
}
float fjordSeg(float px, float py, float pz, float nx, float ny, float nz, float ax, float ay, float az, float ar, float bx, float by, float bz, float br, float wst, float nd, float kw) {
  float ux = bx - ax;
  float uy = by - ay;
  float uz = bz - az;
  float wx = px - ax;
  float wy = py - ay;
  float wz = pz - az;
  float uu = ux * ux + uy * uy + uz * uz;
  float t = uu > 0.0 ? (wx * ux + wy * uy + wz * uz) / uu : 0.0;
  t = min(1.0, max(0.0, t));
  float dx = wx - t * ux;
  float dy = wy - t * uy;
  float dz = wz - t * uz;
  float ex = ny * uz - nz * uy;
  float ey = nz * ux - nx * uz;
  float ez = nx * uy - ny * ux;
  float el = sqrt(ex * ex + ey * ey + ez * ez);
  if (el > 0.0) {
    ex = ex / el;
    ey = ey / el;
    ez = ez / el;
  }
  float l = dx * ex + dy * ey + dz * ez;
  float rest = max(0.0, dx * dx + dy * dy + dz * dz - l * l);
  float r0 = (ar + (br - ar) * t) * wst;
  float lo = l - ${glsl(FJ.LAT)} * r0 * nd;
  float d = sqrt(lo * lo + rest);
  float rr = r0 * (1.0 + ${glsl(FJ.WOB)} * (2.0 * abs(nd) - ${glsl(FJ.WOB_C)}));
  return (d - rr) * kw;
}
float skerryIsle(float s, float k, float n, float r) {
  float R = max(r, ${glsl(LOOK.SK_RMIN)});
  float c = sm01((n - (${glsl(LOOK.SK_T0)} + ${glsl(LOOK.SK_T1)} * -s / R + (1.0 - k) * ${glsl(LOOK.SK_TK)})) / ${glsl(LOOK.SK_W)});
  return s + c * (${glsl(LOOK.SK_H)} - s);
}
float barrierBump(float s, float r) {
  float R = max(r, ${glsl(LOOK.BAR_RMIN)});
  return max(0.0, 1.0 - abs(s + ${glsl(LOOK.BAR_MID)} * R) / (${glsl(LOOK.BAR_HALF)} * R));
}
float barrierIsle(float s, float bw, float n, float bump, float r) {
  return s + bw * sm01((n - ${glsl(LOOK.BAR_GAP)}) / ${glsl(LOOK.BAR_GAP_W)}) * ${glsl(LOOK.BAR_LIFT)} * max(r, ${glsl(LOOK.BAR_RMIN)}) * bump;
}
float speckW(float s, float spk, float h) {
  return spk * (1.0 - sm01((h - ${glsl(LOOK.SPK_H0)}) / ${glsl(LOOK.SPK_H1)})) * sm01((s - ${glsl(LOOK.SPK_S0)}) / ${glsl(LOOK.SPK_S1)}) * sm01((h - ${glsl(LOOK.SPK_LOW0)}) / ${glsl(LOOK.SPK_LOW1)});
}
float speckK(float w, float n) {
  return sm01((n - (${glsl(LOOK.SPK_T)} + (1.0 - w) * ${glsl(LOOK.SPK_TW)})) / ${glsl(LOOK.SPK_W)});
}
float speckApply(float s, float k) {
  return s - k * (s + ${glsl(LOOK.SPK_DEPTH)});
}
float lagoonK(float s0, float bw, float r) {
  float R = max(r, ${glsl(LOOK.BAR_RMIN)});
  return bw * sm01((s0 + ${glsl(LOOK.LAG_OUT)} * R) / (${glsl(LOOK.LAG_W)} * R));
}
`;
// 峡湾（第三十六轮）：按陆海淹到哪里的段在 uFj 里（core/fjords.ts 的 fjordLayer：表头、每小段三个 texel），表号来自三角形的最后一个顶点
// （flat；那一格的表收了碰得到这个三角形的全部段，CPU 按同一格取，见 core/fjords.ts）。所有段里最小的海岸场；fjMouth 是它的入海口（海格，画水的颜色）
export const FJORD_GLSL = `
uniform highp sampler2D uFj;
int fjMouth;
float fjordDepth(float me) {
  return max(${glsl(-FJ.DEPTH_MAX)}, min(me, ${glsl(-FJ.DEPTH_MIN)}) * ${glsl(FJ.DEPTH_K)});
}
vec4 fjTexel(int i) {
  return texelFetch(uFj, ivec2(i % ${TEX_W}, i / ${TEX_W}), 0);
}
float fjordField(vec3 P, vec3 N, int rank, float wst, float nd, float kw) {
  vec4 hd = fjTexel(rank);
  int off = int(hd.x + 0.5);
  int cnt = int(hd.y + 0.5);
  float best = 1e30;
  int bi = -1;
  for (int k = 0; k < ${FJ.MAX_LIST}; k++) {
    if (k >= cnt) break;
    vec4 a = fjTexel(off + 3 * k);
    vec4 b = fjTexel(off + 3 * k + 1);
    float f = fjordSeg(P.x, P.y, P.z, N.x, N.y, N.z, a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, wst, nd, kw);
    if (f < best) { best = f; bi = k; }
  }
  fjMouth = bi >= 0 ? int(fjTexel(off + 3 * bi + 2).x + 0.5) : -1;
  return best;
}
`;
export const vec2Of = (o: readonly number[]) => `vec2(${glsl(o[0])}, ${glsl(o[1])})`;
export const vec3Of = (o: readonly number[]) => `vec3(${o.map(glsl).join(', ')})`;
// 峡湾：这一点（平面 z = 0，星球是单位球上的点）与陡度 SMAX / (EDGE × 一格的距离)；岛礁、沙坝、小湖群的噪声
export const STYLE_N2 = {
  fjP: 'vec3(vWorld, 0.0)',
  fjN: 'vec3(0.0, 0.0, 1.0)',
  fjK: `${glsl(FJ.SMAX / FJ.EDGE)} / uSpacing`,
  skerry: `fbmSub(vWorld / uSpacing * ${glsl(LOOK.SK_FREQ)} + ${vec2Of(LOOK.SK_OFF)}, 2)`,
  bar: `fbmSub(vWorld / uSpacing * ${glsl(LOOK.BAR_FREQ)} + ${vec2Of(LOOK.BAR_OFF)}, 2)`,
  speck: `fbmSub(vWorld / uSpacing * ${glsl(LOOK.SPK_FREQ)} + ${vec2Of(LOOK.SPK_OFF)}, 2)`,
};
export const STYLE_N3 = {
  fjP: 'P',
  fjN: 'P',
  fjK: `${glsl(FJ.SMAX / FJ.EDGE)} / (PI * uSpacing)`,
  skerry: `fbmSub3(P * (uNoiseK * ${glsl(LOOK.SK_FREQ)}) + ${vec3Of(LOOK.SK_OFF)}, 2)`,
  bar: `fbmSub3(P * (uNoiseK * ${glsl(LOOK.BAR_FREQ)}) + ${vec3Of(LOOK.BAR_OFF)}, 2)`,
  speck: `fbmSub3(P * (uNoiseK * ${glsl(LOOK.SPK_FREQ)}) + ${vec3Of(LOOK.SPK_OFF)}, 2)`,
};
// 地形层的主函数里：海岸场算完（含破碎）之后依次冒岛礁、刻峡湾、冒沙坝、画小湖群；sBase 是之前的（潟湖的颜色按它）。
// fjM：峡湾刻成水面的像素的入海口（海格，水的颜色按它；别的像素 −1）
export const styleMain = (n: { fjP: string; fjN: string; fjK: string; skerry: string; bar: string; speck: string }) => `  float sBase = s;
  float wst = styleWeight(wmax);
  int fjM = -1;
  if (vSkerry > 0.0 && s <= 0.0 && -s < ${glsl(SKERRY_REACH)} * max(vCoastAbs, ${glsl(LOOK.SK_RMIN)})) s = skerryIsle(s, vSkerry * wst, ${n.skerry}, vCoastAbs);
  if (vFjRank >= 0 && s > 0.0) {
    float fjf = fjordField(${n.fjP}, ${n.fjN}, vFjRank, vCoast > 0.0 ? wst : 1.0, nd, ${n.fjK});
    if (fjf < s) {
      s = fjf;
      if (s <= 0.0) fjM = fjMouth;
    }
  }
  if (vBar > 0.0) {
    float bump = barrierBump(s, vCoastAbs);
    if (bump > 0.0) s = barrierIsle(s, vBar * wst, ${n.bar}, bump, vCoastAbs);
  }
  float lakeDot = 0.0;
  if (vSpeck > 0.0) {
    float spw = speckW(s, vSpeck * wst, h);
    if (spw > 0.0) {
      lakeDot = speckK(spw, ${n.speck});
      if (lakeDot > 0.0) s = speckApply(s, lakeDot);
    }
  }
`;
// 水面一侧：沙坝后面的潟湖（偏青绿的浅水）、小湖群（湖的颜色）
export const STYLE_SEA_GLSL = `
    if (vBar > 0.0 && uSeaData == 0) col = mix(col, vec3(0.42, 0.66, 0.62), 0.6 * lagoonK(sBase, vBar * wst, vCoastAbs));
    if (lakeDot > 0.0) col = mix(col, vec3(0.27, 0.49, 0.69), min(1.0, 1.5 * lakeDot));`;

// 合成着色器里生态的花纹、发光那几段的首尾标记。这几段在个别显卡、驱动上编译不过时，去掉它们再编译一次（compileCompose）：
// 地图照常画，只是没有花纹、发光，不会整张地图都出不来
export const FX_BEGIN = '// <fx>';
export const FX_END = '// </fx>';
export const withoutFx = (src: string) => src.replace(/[ \t]*\/\/ <fx>[\s\S]*?\/\/ <\/fx>\n?/g, '');

// 生态的花纹（第三批）：与 core/biome-look.ts 的 patternValue 相同的算式（编号是 PATTERNS 里的序号）。
// q 以花纹单位计（一个单位 = size 格），值在 [0, 1]。整个星球把 patternAt 换成三维的（PATTERN3_GLSL）
export const PATTERN_GLSL = `
const float PAT_DETAIL[${PATTERNS.length}] = float[${PATTERNS.length}](${PATTERNS.map((p) => glsl(PATTERN_DETAIL[p])).join(', ')});
float patSparkle(vec2 q) {
  vec2 g = q * 3.0;
  ivec2 c = ivec2(floor(g));
  uint h = hashU(c);
  if (unitH(h) >= ${glsl(SPARKLE.p)}) return 0.0;
  vec2 ctr = vec2(c) + 0.2 + 0.6 * vec2(float(h & 255u), float((h >> 8u) & 255u)) / 255.0;
  return 1.0 - smoothstep(${glsl(SPARKLE.r0)}, ${glsl(SPARKLE.r1)}, length(g - ctr));
}
float patCracks(vec2 q) {
  ivec2 i = ivec2(floor(q));
  float f1 = 8.0; float f2 = 8.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 c = i + ivec2(dx, dy);
      uint h = hashU(c);
      float d = length(q - (vec2(c) + vec2(float(h & 65535u), float(h >> 16u)) / 65536.0));
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return 1.0 - smoothstep(0.03, 0.08, f2 - f1);
}
float patternValue(int kind, vec2 q) {
  if (kind == 1) return patSparkle(q);
  if (kind == 2) return patCracks(q);
  if (kind == 3) return smoothstep(-0.1, 0.25, fbmSub(q, 3));
  if (kind == 4) return smoothstep(0.88, 0.97, 1.0 - abs(fbmSub(q * 0.8, 3)));
  if (kind == 5) return smoothstep(0.35, 0.45, vnoise(q * 1.7));
  if (kind == 6) return smoothstep(0.2, 0.6, sin(6.28318531 * fract(q.y + 0.6 * fbmSub(q * 0.5, 2))));
  return 0.0;
}
// 这一点的花纹：world 是地图坐标，size 是花纹大小（格），seed 是这种生态的种子
float patternAt(int kind, vec2 world, float size, float seed) {
  return patternValue(kind, world / (uSpacing * size) + seed * vec2(${glsl(SEED_STEP[0])}, ${glsl(SEED_STEP[1])}));
}
`;

export const PATTERN3_GLSL = `
float patSparkle3(vec3 q) {
  vec3 g = q * 3.0;
  ivec3 c = ivec3(floor(g));
  uint h = hashU3(c);
  if (unitH(h) >= ${glsl(SPARKLE3.p)}) return 0.0;
  vec3 ctr = vec3(c) + 0.2 + 0.6 * vec3(float(h & 255u), float((h >> 8u) & 255u), float(h >> 24u)) / 255.0;
  return 1.0 - smoothstep(${glsl(SPARKLE3.r0)}, ${glsl(SPARKLE3.r1)}, length(g - ctr));
}
float patCracks3(vec3 q) {
  ivec3 i = ivec3(floor(q));
  float f1 = 8.0; float f2 = 8.0;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 c = i + ivec3(dx, dy, dz);
        uint h = hashU3(c);
        vec3 p = vec3(c) + vec3(float(h & 1023u), float((h >> 10u) & 1023u), float((h >> 20u) & 1023u)) / 1024.0;
        float d = length(q - p);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
  }
  return 1.0 - smoothstep(0.03, 0.08, f2 - f1);
}
float patternValue3(int kind, vec3 q) {
  if (kind == 1) return patSparkle3(q);
  if (kind == 2) return patCracks3(q);
  if (kind == 3) return smoothstep(-0.1, 0.25, fbmSub3(q, 3));
  if (kind == 4) return smoothstep(0.88, 0.97, 1.0 - abs(fbmSub3(q * 0.8, 3)));
  if (kind == 5) return smoothstep(0.35, 0.45, vnoise3(q * 1.7));
  if (kind == 6) return smoothstep(0.2, 0.6, sin(6.28318531 * fract(q.z + 0.6 * fbmSub3(q * 0.5, 2))));
  return 0.0;
}
// 星球：在球面位置上取（每份副本一样，东西接缝、两极都没有断口）
float patternAt(int kind, vec2 world, float size, float seed) {
  return patternValue3(kind, sphereOf(world) * (uNoiseK / size) + seed * vec3(${SEED_STEP.map(glsl).join(', ')}));
}
`;

// 岛的样子（colors.ts 的 lithLayer；每格插值，第十四轮起按每格记下的岛的种类）：g 沙洲、b 白沙、a 格里的潟湖（一格大的环礁）；
// r 不用（第十四轮去掉了火山岛的玄武岩）。平面与星球的地形着色器共用；没有放岛（全是 0）的地方画面不变
export const LITH_LAND_GLSL = `
    {
      float lowK = 1.0 - smoothstep(20.0, 160.0, hh);
      // 沙洲（低平岛）：低处是浅色的沙，湿的地方是沼泽（青绿、偏暗）；比周围的草原、森林都浅或都青
      vec3 soft = mix(vec3(0.36, 0.50, 0.42), vec3(0.90, 0.85, 0.68), smoothstep(0.15, 0.6, vLandCol.a));
      col = mix(col, soft, vLith.g * lowK * 0.8);
      // 白沙（珊瑚岛、小礁）：海边最白
      float shoreK = 1.0 - smoothstep(0.0, 70.0, s);
      col = mix(col, vec3(0.95, 0.93, 0.85), vLith.b * mix(0.45, 0.95, shoreK));
      // 一格大的环礁：格心一圈是潟湖（青绿、平的）
      float lag = smoothstep(0.80, 0.86, vLith.a);
      col = mix(col, vec3(0.33, 0.72, 0.72), lag);
      hh = mix(hh, 2.0, lag);
      slope *= 1.0 - lag;
    }`;
export const LITH_SEA_GLSL = `
    // 白沙的海底（潟湖、礁上）：青绿；珊瑚岛、小礁的岸边一圈白浪（约一格的十分之一宽）。
    // 潟湖的边（第十三轮修）：按格插值的岩性加上格以下的噪声（格心为 0，与海岸细节同样的权重）再取阈值，
    // 边是弯弯曲曲的，不是三角形的直边
    float coralK = smoothstep(0.3, 0.7, vLith.b + weight * 0.5 * subN);
    col = mix(col, vec3(0.30, 0.76, 0.76), coralK * 0.8 * (1.0 - smoothstep(8.0, 60.0, depth)));
    float surf = 1.0 - smoothstep(0.4, 1.0, -sPx / max(1.5, cellPx * 0.1));
    col = mix(col, vec3(0.94, 0.97, 0.97), min(1.0, vLith.b * 2.0) * surf * 0.8);`;
