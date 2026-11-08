import { VS_CELL, VS_ID, VS_SEAM } from './plane';
import { FJORD_GLSL, FRAG_GLSL, FRAG_N3, glsl, LITH_LAND_GLSL, LITH_SEA_GLSL, NOISE_GLSL, PATTERN3_GLSL, SEA_RELIEF, SPECK_MARK, STYLE_GLSL, STYLE_N3, STYLE_SEA_GLSL, styleMain, TEX_W } from './common';
import { LOOK } from '../../../core/coast-style';
import { FS_COMPOSE } from './compose';
import { GLOBE_G, PROJ_GLSL } from '../projection';

// ---------- 整个星球：平铺图左右重复几份；格以下的细节在球面位置上取三维噪声 ----------
// 与 core/subcell.ts 的 hashU3 / vnoise3 / fbmSub3 / sphereOf 逐位（浮点部分逐位相近）一致，导出的图与屏幕一致

export const SPHERE_GLSL = `
const float PI = 3.14159265358979;
vec3 sphereOf(vec2 w) {
  float lon = PI * (w.x - 1.0);
  float colat = PI * clamp(w.y, 0.0, 1.0);
  float s = sin(colat);
  return vec3(s * cos(lon), s * sin(lon), cos(colat));
}
uint hashU3(ivec3 p) {
  uint a = uint(p.x) * 1664525u + 1013904223u;
  uint b = uint(p.y) * 1664525u + 1013904223u;
  uint c = uint(p.z) * 1664525u + 1013904223u;
  for (int r = 0; r < 2; r++) {
    a += b * 1664525u; b += c * 1664525u; c += a * 1664525u;
    a ^= a >> 16u; b ^= b >> 16u; c ^= c >> 16u;
  }
  return a ^ b ^ c;
}
float vnoise3(vec3 p) {
  vec3 i = floor(p); vec3 f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  ivec3 ii = ivec3(i);
  float a = unitH(hashU3(ii)); float b = unitH(hashU3(ii + ivec3(1, 0, 0)));
  float c = unitH(hashU3(ii + ivec3(0, 1, 0))); float d = unitH(hashU3(ii + ivec3(1, 1, 0)));
  float e = unitH(hashU3(ii + ivec3(0, 0, 1))); float g = unitH(hashU3(ii + ivec3(1, 0, 1)));
  float k = unitH(hashU3(ii + ivec3(0, 1, 1))); float m = unitH(hashU3(ii + ivec3(1, 1, 1)));
  float x00 = a + (b - a) * u.x; float x10 = c + (d - c) * u.x;
  float x01 = e + (g - e) * u.x; float x11 = k + (m - k) * u.x;
  float y0 = x00 + (x10 - x00) * u.y; float y1 = x01 + (x11 - x01) * u.y;
  return (y0 + (y1 - y0) * u.z) * 2.0 - 1.0;
}
float fbmSub3(vec3 p, int oct) {
  float s = 0.0; float amp = 0.5;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    s += amp * vnoise3(p);
    p = p * 2.03 + vec3(17.1, -9.3, 5.7);
    amp *= 0.5;
  }
  return s;
}
`;

// 着色器源码里的一处替换；找不到就报错（避免悄悄没替换上）
export function must(src: string, from: string, to: string): string {
  if (!src.includes(from)) throw new Error(`着色器替换失败：${from.slice(0, 40)}`);
  return src.replace(from, to);
}

// 星球的顶点：画第 uCopy0 + 实例号 份（x 平移 2 的倍数）；细节噪声用基准坐标，所以每份一模一样
export const planetVs = (vs: string) =>
  must(
    must(vs, 'uniform vec4 uView;', 'uniform vec4 uView;\nuniform int uCopy0;'),
    'gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);',
    'vec2 pp = aPos + vec2(2.0 * float(uCopy0 + gl_InstanceID), 0.0);\n  gl_Position = vec4(pp * uView.xy + uView.zw, 0.0, 1.0);',
  );
export const VS_CELL_PLANET = planetVs(VS_CELL);
export const VS_ID_PLANET = planetVs(VS_ID);

// 极地的场景（第十三轮 G4，球形投影看着极地时）：以极点为中心的等距方位投影，按球面上真实的三角形、Voronoi 画（见 projection.ts 的 SceneNeed）。
// 平面上的位置 = 到极点的弧长（地图单位）·（cos 经度，uPole · sin 经度）。格的坡度（东、南分量）在顶点上换成这个平面上的方向再插值
// （极点附近各格的东、南方向差得很多，直接插值会乱），片元里再换回这一点的东、南
export const POLAR_VS = (body: string) => `float pa = 3.14159265358979 * (aPos.x - 1.0);
  float pr = uPole > 0.0 ? aPos.y : 1.0 - aPos.y;
  vec2 polarPos = pr * vec2(cos(pa), uPole * sin(pa));
  ${body}
  gl_Position = vec4(polarPos * uView.xy + uView.zw, 0.0, 1.0);`;
export const VS_CELL_POLAR = must(
  must(
    must(
      must(VS_CELL, 'uniform vec4 uView;', 'uniform vec4 uView;\nuniform float uPole;\nout vec2 vPolar;'),
      'out vec2 vGrad;\nout vec2 vSeaGrad;',
      'out vec2 vGradP;\nout vec2 vSeaGradP;',
    ),
    '  vGrad = texelFetch(uGrad, t, 0).rg;\n  vSeaGrad = texelFetch(uSeaGrad, t, 0).rg;\n',
    '',
  ),
  '  gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);',
  POLAR_VS(`vPolar = polarPos;
  vec2 pE = vec2(-sin(pa), uPole * cos(pa));
  vec2 pS = vec2(cos(pa), uPole * sin(pa)) * uPole;
  vec2 g0 = texelFetch(uGrad, t, 0).rg;
  vec2 g1 = texelFetch(uSeaGrad, t, 0).rg;
  vGradP = g0.x * pE + g0.y * pS;
  vSeaGradP = g1.x * pE + g1.y * pS;`),
);
export const VS_ID_POLAR = must(must(VS_ID, 'uniform vec4 uView;', 'uniform vec4 uView;\nuniform float uPole;'), '  gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);', POLAR_VS(''));
export const VS_SEAM_POLAR = must(
  must(VS_SEAM, 'uniform float uShift;', 'uniform float uShift;\nuniform float uPole;'),
  '  gl_Position = vec4((p + vec2(uShift, 0.0)) * uView.xy + uView.zw, 0.0, 1.0);',
  `  float pa = 3.14159265358979 * (p.x - 1.0);
  float pr = uPole > 0.0 ? p.y : 1.0 - p.y;
  gl_Position = vec4(pr * vec2(cos(pa), uPole * sin(pa)) * uView.xy + uView.zw, 0.0, 1.0);`,
);

export const FS_TERRAIN_PLANET = `#version 300 es
precision highp float;
in vec4 vLandCol;
in vec4 vSeaCol;
in float vElev;
in float vSeaElev;
in float vCoast;
in float vFrag;
in vec4 vStyle;
flat in int vFjRank;
float vSpeck;
float vBar;
float vSkerry;
float vCoastAbs;
// 峡湾刻成的水面画入海口那一格的水色、按它的水深（第三十六轮）
uniform sampler2D uColor;
uniform highp sampler2D uElev;
in vec2 vGrad;
in vec2 vSeaGrad;
in vec2 vWorld;
in vec3 vBary;
in vec4 vLith;
uniform float uSpacing;
uniform float uCoastAmp;
uniform float uDetail;
// 陆地颜色的饱和度（地形类着色 1.1，别的 1）
uniform float uSat;
// 海面也是数据（海水温度底图，第十四轮）：不加浅水的青绿，海面就是每格的颜色
uniform int uSeaData;
uniform float uPixel;
uniform float uMetersPerUnit;
// 噪声频率：1 / (π · 格距)，一个噪声单位约一格
uniform float uNoiseK;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oHeight;
${NOISE_GLSL}
${SPHERE_GLSL}
${FRAG_GLSL}
${STYLE_GLSL}
${FJORD_GLSL}
float fbmFade3(vec3 p, int oct, float pxPerUnit) {
  float s = 0.0; float amp = 0.5; float wl = pxPerUnit;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    float fade = smoothstep(1.5, 4.0, wl);
    if (fade == 0.0) break;
    s += amp * vnoise3(p) * fade;
    p = p * 2.03 + vec3(17.1, -9.3, 5.7);
    amp *= 0.5;
    wl /= 2.03;
  }
  return s;
}
// 一个坐标平面上沿坡向拉长的冲沟（与平面世界同一个图案）
float gullyPlane(vec2 q, vec2 d, float cellPx) {
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 r = vec2(dot(q, vec2(-dir.y, dir.x)), dot(q, dir));
  float gully = 0.0; float a = 0.5; vec2 f = vec2(4.0, 1.1);
  for (int k = 0; k < 3; k++) {
    float fade = smoothstep(3.0, 9.0, cellPx / f.x);
    if (fade == 0.0) break;
    float n = vnoise(r * f + vec2(float(k) * 7.3, 1.7));
    gully += a * (1.0 - sqrt(n * n + 0.04) - 0.47) * fade;
    a *= 0.5; f *= 2.0;
  }
  return gully;
}
// 球面上没有一个全局的平面坐标：冲沟按三个坐标平面混合（法向越接近哪根轴，那个平面的权重越大）
float landDetailAt3(vec3 P, vec3 D, float relief, float h, float cellPx) {
  vec3 N = abs(P); N *= N; N *= N; N /= (N.x + N.y + N.z);
  vec3 Q = P * uNoiseK;
  float gully = 0.0;
  if (N.x > 0.02) gully += N.x * gullyPlane(Q.yz, D.yz, cellPx);
  if (N.y > 0.02) gully += N.y * gullyPlane(Q.zx, D.zx, cellPx);
  if (N.z > 0.02) gully += N.z * gullyPlane(Q.xy, D.xy, cellPx);
  gully *= relief * 0.45;
  float bumps = fbmFade3(P * uNoiseK * 1.7 + 5.0, 4, cellPx / 1.7) * (14.0 + 0.05 * max(h, 0.0));
  return uDetail * (gully + bumps);
}
void main() {
  vSpeck = vStyle.x; vBar = vStyle.y; vSkerry = vStyle.z; vCoastAbs = vStyle.w;
  // 上下超出两极的部分不画
  if (vWorld.y < 0.0 || vWorld.y > 1.0) discard;
  float h = vElev;
  vec3 P = sphereOf(vWorld);
  float wmax = max(vBary.x, max(vBary.y, vBary.z));
  float weight = clamp((1.0 - wmax) * 2.2, 0.0, 1.0);
  float rugged = clamp(max(h, 0.0) / 1200.0, 0.0, 1.0);
  float amp = uCoastAmp * (0.55 + 0.9 * rugged);
  float nd = fbmSub3(P * uNoiseK * 2.1, 4);
  float det = weight * amp * (barrierDetail(vBar) * (1.0 + ${glsl(LOOK.SK_ROUGH)} * min(1.0, ${glsl(LOOK.SK_ROUGH_K)} * vSkerry))) * nd;
  float s = vCoast + det;
  if (vFrag > 0.0) s = fragCoast(vCoast, det, vFrag, weight, ${FRAG_N3});
${styleMain(STYLE_N3)}  bool land = s > 0.0;
  float cellPx = uSpacing / uPixel;
  float gm = length(vGrad);
  float relief = gm * uSpacing;
  // 坡向：格的坡度是（东、南）分量，换成球面上的三维方向
  float lon = PI * (vWorld.x - 1.0);
  float colat = PI * clamp(vWorld.y, 0.0, 1.0);
  vec3 E = vec3(-sin(lon), cos(lon), 0.0);
  vec3 S = vec3(cos(colat) * cos(lon), cos(colat) * sin(lon), -sin(colat));
  vec2 g2 = gm > 1e-3 ? vGrad / gm : vec2(1.0, 0.0);
  vec3 D = g2.x * E + g2.y * S;
  float coastLine = 1.0 - smoothstep(0.6, 1.8, abs(s) / max(fwidth(s), 1e-6));
  // 离海岸几个像素（陆上为正）：珊瑚岛的白浪
  float sPx = s / max(fwidth(s), 1e-6);
  vec3 col;
  float hh;
  vec2 slope = vec2(0.0);
  if (land) {
    float landDetail = landDetailAt3(P, D, relief, h, cellPx);
    // 细节坡度：右边、下边各一个像素处的差分，除以那一个像素在地面上的长度（东西方向乘 cos 纬度）
    float cosLat = max(sin(colat), 0.05);
    float dx = landDetailAt3(sphereOf(vWorld + vec2(uPixel, 0.0)), D, relief, h, cellPx) - landDetail;
    float dy = landDetailAt3(sphereOf(vWorld + vec2(0.0, uPixel)), D, relief, h, cellPx) - landDetail;
    vec2 dDetail = vec2(dx / cosLat, dy) / (uPixel * uMetersPerUnit) * 0.6;
    col = vLandCol.rgb;
    col = clamp(mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat), 0.0, 1.0);
    hh = max(h + landDetail, 2.0);
    // 碎岛：几米到三十来米高，边上一圈沙滩
    if (vFrag > 0.0) hh = max(hh, fragIsleHeight(s));
    slope = vGrad / uMetersPerUnit + dDetail;
    float beach = (1.0 - smoothstep(4.0, 22.0, hh)) * (1.0 - smoothstep(0.0, 120.0, relief)) * (0.35 + 0.65 * vLandCol.a);
    col = mix(col, vec3(0.86, 0.80, 0.62), beach * 0.75);
    col *= 1.0 + 0.05 * fbmFade3(P * uNoiseK * 3.3 - 2.0, 3, cellPx / 3.3);
    ${LITH_LAND_GLSL}
  } else {
    float seaDetail = uDetail * fbmFade3(P * uNoiseK * 1.3, 3, cellPx / 1.3) * 25.0;
    float subN = fbmSub3(P * uNoiseK * 1.7 + 11.0, 3);
    // 峡湾刻成的水面（第三十六轮）：入海口那一格的水色，水深按它（峡湾比岸外深）
    vec4 seaC = vSeaCol;
    float seaE = vSeaElev;
    if (fjM >= 0) {
      ivec2 mt = ivec2(fjM % ${TEX_W}, fjM / ${TEX_W});
      seaC = texelFetch(uColor, mt, 0);
      seaE = fjordDepth(texelFetch(uElev, mt, 0).r);
    }
    col = seaC.rgb;
    // 水深只按水面格的（第十三轮修）：陆地格上是挨着它的水面里最浅的那格的高程（colors.ts 的 shoreElevation），
    // 不再把陆地的高程插值进来——陡的小岛四周的水不会整片三角形都画成浅水
    hh = min((vFrag > 0.0 ? fragSeaDepth(seaE, vFrag) : seaE) + seaDetail, -2.0);
    float depth = -hh;
    vec3 shallow = mix(vec3(0.30, 0.50, 0.56), vec3(0.24, 0.62, 0.66), seaC.a);
    // 海冰（第八十六轮，core/sea-ice.ts）：格的颜色里盖了浅色的冰（最暗的通道很亮，海的色带最亮也只有 0.25）时浅水不盖过它；
    // 没有冰的海 iceK 正好是 0，与以前逐位相同
    float iceK = smoothstep(0.3, 0.75, min(seaC.r, min(seaC.g, seaC.b)));
    col = mix(col, shallow, (1.0 - smoothstep(4.0, 70.0, depth)) * (uSeaData == 1 ? 0.0 : 0.7) * (1.0 - iceK));
    ${LITH_SEA_GLSL}
    ${STYLE_SEA_GLSL}
    // 海底的坡：按水深的坡度（每格一份，在三角形内插值），比陆上缓得多（合成里只轻轻晕渲）
    slope = vSeaGrad / uMetersPerUnit * ${glsl(SEA_RELIEF)};
  }
  oColor = vec4(col, coastLine);
  // 小湖群的水面（第三十四轮）：海岸场写成 SPECK_MARK（合成里认出来，不进省份、不再找附近的水面格）
  oHeight = vec4(hh, lakeDot > 0.0 && s <= 0.0 ? ${glsl(SPECK_MARK)} : s, slope);
}`;

// 极地的场景的地形层：世界坐标按这一点在极地平面上的位置算回来（不按顶点的世界坐标插值：跨过接缝、极点的三角形会乱），
// 坡度从平面上的方向换回这一点的东、南
export const FS_TERRAIN_POLAR = must(
  must(FS_TERRAIN_PLANET, 'in vec2 vGrad;\nin vec2 vSeaGrad;\nin vec2 vWorld;', 'in vec2 vPolar;\nin vec2 vGradP;\nin vec2 vSeaGradP;\nuniform float uPole;\nvec2 vGrad;\nvec2 vSeaGrad;\nvec2 vWorld;'),
  'void main() {\n',
  `void main() {
  float pr = length(vPolar);
  if (pr > 1.0) discard;
  float pa = pr > 1e-9 ? atan(uPole * vPolar.y, vPolar.x) : 0.0;
  vWorld = vec2(1.0 + pa / PI, uPole > 0.0 ? pr : 1.0 - pr);
  vec2 pE = vec2(-sin(pa), uPole * cos(pa));
  vec2 pS = vec2(cos(pa), uPole * sin(pa)) * uPole;
  vGrad = vec2(dot(vGradP, pE), dot(vGradP, pS));
  vSeaGrad = vec2(dot(vSeaGradP, pE), dot(vSeaGradP, pS));
`,
);

// 合成：按扭曲后的坐标取格。扭曲的噪声、生态的花纹在球面上取（每份副本一样），两极以外是背景
export const PATTERN_AT_2D = 'float patternAt(int kind, vec2 world, float size, float seed) {\n  return patternValue(';
export const FS_COMPOSE_PLANET = must(
  must(
    must(FS_COMPOSE, 'int idAt(vec2 uv) {', `uniform float uNoiseK;
${SPHERE_GLSL}
int idAt(vec2 uv) {`),
    PATTERN_AT_2D,
    `${PATTERN3_GLSL}\nfloat patternAt2(int kind, vec2 world, float size, float seed) {\n  return patternValue(`,
  ),
  `  float f = 0.9 / uSpacing;
  vec2 w = 0.6 * uSpacing * vec2(fbmSub(world * f + vec2(3.7, 0.0), 3), fbmSub(world * f + vec2(0.0, -5.1), 3));
  vec2 uvW = ((world + w) * uView.xy + uView.zw) * 0.5 + 0.5;
  int id = idAt(uvW);`,
  `  bool onMap = world.y >= 0.0 && world.y <= 1.0;
  vec3 Pf = sphereOf(world) * uNoiseK * 0.9;
  vec2 w = 0.6 * uSpacing * vec2(fbmSub3(Pf + vec3(3.7, 0.0, 0.0), 3), fbmSub3(Pf + vec3(0.0, -5.1, 0.0), 3));
  vec2 ww = world + w;
  ww.y = clamp(ww.y, 0.0, 1.0);
  vec2 uvW = (ww * uView.xy + uView.zw) * 0.5 + 0.5;
  int id = onMap ? idAt(uvW) : -1;`,
);

// 着色器源码里按正则替换全部，次数不对就报错
export function mustAll(src: string, re: RegExp, to: string, count: number): string {
  const n = (src.match(re) ?? []).length;
  if (n !== count) throw new Error(`着色器替换失败：${re.source.slice(0, 40)}（${n} 处，应为 ${count} 处）`);
  return src.replace(re, to);
}

// ---------- 整个星球的等面积、球形投影（第十三轮 G4）：编号层、地形层、切线层照旧画成等距圆柱的“场景”，
// 合成时每个像素按投影反算回世界坐标，再到场景上取（见 projection.ts 的 PROJ_GLSL）。
// 由星球的合成着色器改成：像素的位置（pW）、取周围格的偏移、圆圈都在世界坐标上；一格合几个像素（uCellPx）、
// 场景一个像素合几个屏幕像素（uScenePx）按这个像素自己的投影比例算；投影之外画背景（球形外面一圈淡淡的大气）
export const PROJ_TO_SCENE = `
// 场景：世界坐标 → 场景上的位置（0–1）。场景是 x 从 uSceneX0 起的一块（整圈时宽 2），经度按 2 绕回
vec2 wrapW(vec2 w) { return vec2(uSceneX0 + mod(w.x - uSceneX0, 2.0), w.y); }
// 极地的场景（uScenePole = ±1）：以那一极为中心的等距方位投影
vec2 toScene(vec2 w) {
  vec2 q = wrapW(w);
  if (uScenePole != 0.0) {
    float a = PI * (w.x - 1.0);
    q = (uScenePole > 0.0 ? w.y : 1.0 - w.y) * vec2(cos(a), uScenePole * sin(a));
  }
  return (q * uSceneView.xy + uSceneView.zw) * 0.5 + 0.5;
}
// 投影之外：背景（导出时透明）；球形的外面一圈淡淡的大气
vec4 outsideColor(vec2 plane) {
  vec4 o = uOutside;
  if (uProj == 2) {
    float rho = length(vec2(plane.x - 1.0, 0.5 - plane.y)) / ${glsl(GLOBE_G)};
    float glow = rho >= 1.0 ? exp(-(rho - 1.0) * 14.0) * 0.5 : 0.5;
    o = vec4(mix(o.rgb, vec3(0.42, 0.62, 0.95), glow), max(o.a, glow));
  }
  return o;
}
// 收尾：球形的边上暗一点、带一点大气的颜色；投影的边缘按到边的像素数抗锯齿
vec4 projFinish(vec3 col) {
  if (uProj == 2) {
    float r2 = uRho * uRho;
    col *= 1.0 - 0.22 * r2 * r2 * r2;
    col = mix(col, vec3(0.55, 0.72, 0.98), 0.22 * pow(uRho, 10.0));
  }
  float a = clamp(uEdge * uPlanePx + 0.5, 0.0, 1.0);
  return mix(outsideColor(uPlane), vec4(col, 1.0), a);
}
`;
export const PROJ_PROLOGUE = `  // 投影（第十三轮 G4）：画面上的位置 → 平面 → 世界；之外画背景
  uPlane = (vUv * 2.0 - 1.0 - uView.zw) / uView.xy;
  if (!projInv(uPlane, pW, uEdge)) {
    oColor = outsideColor(uPlane);
    return;
  }
  {
    // 右边、上边一个画面像素在世界坐标上差多少（省界、轮廓看的相邻像素按它取）
    vec2 sp = 2.0 * uPx / uView.xy;
    vec2 w2;
    float e2;
    uDX = projInv(uPlane + vec2(sp.x, 0.0), w2, e2) ? w2 - pW : (projInv(uPlane - vec2(sp.x, 0.0), w2, e2) ? pW - w2 : vec2(0.0));
    uDY = projInv(uPlane + vec2(0.0, sp.y), w2, e2) ? w2 - pW : (projInv(uPlane - vec2(0.0, sp.y), w2, e2) ? pW - w2 : vec2(0.0));
    uDX.x -= 2.0 * floor(uDX.x * 0.5 + 0.5);
    uDY.x -= 2.0 * floor(uDY.x * 0.5 + 0.5);
    // 一个画面像素合多少地图单位²（东西方向乘 cos 纬度是真实的面积）→ 一格合几个像素
    float det = max(abs(uDX.x * uDY.y - uDX.y * uDY.x), 1e-20);
    float cosLat = max(sin(PI * clamp(pW.y, 0.0, 1.0)), 1e-3);
    uCellPx = uSpacing / sqrt(det * cosLat);
    // 圆圈（0.6、1.2 格半径）在世界坐标上：uCellPx · uTexel = uSpacing
    uTexel = vec2(uSpacing / uCellPx);
    uScenePx = uPxScale / sqrt(uSceneZ.x * uSceneZ.y * det);
    uRho = uProj == 2 ? length(vec2(uPlane.x - 1.0, 0.5 - uPlane.y)) / ${glsl(GLOBE_G)} : 0.0;
  }
`;
export const FS_COMPOSE_PROJ = (() => {
  let s = FS_COMPOSE_PLANET;
  // 场景上的位置：画面上的位置 × uSceneXf → 世界坐标的 toScene
  s = mustAll(s, /(\(vUv \+ o[12]\)|\buv\b|\bvUv\b) \* uSceneXf\.xy \+ uSceneXf\.zw/g, 'toScene($1)', 8);
  // 这个像素的位置换成世界坐标（pW）；画面上的位置只在开头算投影时用
  s = s.replace(/\bvUv\b/g, 'pW');
  s = must(s, 'in vec2 pW;', 'in vec2 vUv;\nvec2 pW;\nvec2 uDX;\nvec2 uDY;\nvec2 uPlane;\nfloat uRho;\nfloat uEdge;');
  s = must(s, 'uniform vec2 uTexel;', 'vec2 uTexel;\nuniform vec2 uPx;');
  s = must(s, 'uniform float uCellPx;', 'float uCellPx;');
  s = must(s, 'uniform float uScenePx;', 'float uScenePx;\nuniform vec2 uSceneZ;\nuniform vec4 uSceneView;\nuniform float uSceneX0;\nuniform float uScenePole;\nuniform vec4 uOutside;\nuniform float uPlanePx;');
  s = must(s, 'int idAt(vec2 uv) {', `${PROJ_GLSL}${PROJ_TO_SCENE}int idAt(vec2 uv) {`);
  s = must(s, 'vec2 world = (pW * 2.0 - 1.0 - uView.zw) / uView.xy;', 'vec2 world = pW;');
  s = must(s, 'vec2 uvW = (ww * uView.xy + uView.zw) * 0.5 + 0.5;', 'vec2 uvW = ww;');
  s = must(s, 'vec2 dx = vec2(uTexel.x * 1.5, 0.0);', 'vec2 dx = uDX * 1.5;');
  s = must(s, 'vec2 dy = vec2(0.0, uTexel.y * 1.5);', 'vec2 dy = uDY * 1.5;');
  s = must(s, 'vec2 hx = vec2(uTexel.x * 1.5, 0.0);', 'vec2 hx = uDX * 1.5;');
  s = must(s, 'vec2 hy = vec2(0.0, uTexel.y * 1.5);', 'vec2 hy = uDY * 1.5;');
  s = must(s, 'vec2 cx = vec2(uTexel.x, 0.0);', 'vec2 cx = uDX;');
  s = must(s, 'vec2 cy = vec2(0.0, uTexel.y);', 'vec2 cy = uDY;');
  s = must(s, 'vec2 ex = vec2(uTexel.x, 0.0);', 'vec2 ex = uDX;');
  s = must(s, 'vec2 ey = vec2(0.0, uTexel.y);', 'vec2 ey = uDY;');
  // 河的图层画在场景那一块上（同样的范围、大小）：按场景上的位置取
  s = must(s, 'texture(uRiver, pW * uRiverXf.xy + uRiverXf.zw)', 'texture(uRiver, toScene(pW) * uRiverXf.xy + uRiverXf.zw)');
  s = must(s, 'oColor = vec4(col, 1.0);', 'oColor = projFinish(col);');
  // 离边界远的格（第三十九轮）：画面一个像素合多少地图单位按这个像素自己的投影（uDX、uDY），编号层的纹素按场景的密度
  // （只在等距圆柱、整圈的场景里用：极地的场景、不到一整圈的场景经度绕回时不连续，渲染器不开 uNearOn）
  s = must(s, 'float nearPx() { return uSpacing / uCellPx; }', 'float nearPx() { return max(length(uDX), length(uDY)); }');
  s = must(s, 'float nearSlack() { return 0.71 * nearPx() * uScenePx / uPxScale; }', 'float nearSlack() { return 0.71 / min(uSceneZ.x, uSceneZ.y); }');
  s = must(s, 'void main() {\n', `void main() {\n${PROJ_PROLOGUE}`);
  return s;
})();
