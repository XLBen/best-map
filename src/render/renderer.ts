import { GLOW_GAIN, GLOW_GAIN_ATLAS, PATTERN_DETAIL, SEED_STEP, SPARKLE, SPARKLE3 } from '../../core/biome-look';
import type { Mesh } from '../../core/mesh';
import type { SeamLayers } from '../../core/seams';
import { PATTERNS } from '../../core/species';
import { viewOf } from '../../core/sphere';
import type { GhostLayers } from './colors';

// WebGL2 渲染：
//   1. 编号层：Voronoi 多边形写入每个像素属于哪一格
//   2. 地形层：Delaunay 三角形（不共享顶点，带重心坐标）。颜色、高程、海岸值、坡度在三角形内插值；
//      格以下补海岸细节与沿坡向的冲沟纹理（噪声在格中心为 0，陆海与模拟一致）→ 离屏的颜色、高度、坡度。
//      陆地像素只用陆色、水面像素只用水色（每格另带一份“对岸的颜色”），颜色不跨海岸互相渗；
//      晕渲的大尺度坡度用插值后的格坡度，没有三角形折面；海岸线在这里画成抗锯齿的细线
//   3. 切线层：剪刀切省时画的线（core/seams.ts）。每段一个长方形，像素写入离它最近的那一段与在线的哪一边
//      （深度 = 距离 / 带宽，近的胜）
//   4. 合成：晕渲、陡坡露岩、两种风格；按扭曲后的坐标取格，画分类平涂（主导生态、省份）、
//      分组边界（省份）、高亮与轮廓。边界因此是自然的曲线而不是六边形；切线附近按在线的哪一边换格，省界就是画的线
// 1、2 只在镜头、图层、窗口大小变了时重画，3 另外在切线变了时重画；鼠标移动、高亮变化只重画合成层。
// 海岸噪声与 core/subcell.ts 逐位一致，导出的位图与屏幕一致。

const TEX_W = 1024;

const NOISE_GLSL = `
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

// 数 → GLSL 的浮点字面量（整数也带小数点）
const glsl = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// 合成着色器里生态的花纹、发光那几段的首尾标记。这几段在个别显卡、驱动上编译不过时，去掉它们再编译一次（compileCompose）：
// 地图照常画，只是没有花纹、发光，不会整张地图都出不来
const FX_BEGIN = '// <fx>';
const FX_END = '// </fx>';
export const withoutFx = (src: string) => src.replace(/[ \t]*\/\/ <fx>[\s\S]*?\/\/ <\/fx>\n?/g, '');

// 生态的花纹（第三批）：与 core/biome-look.ts 的 patternValue 相同的算式（编号是 PATTERNS 里的序号）。
// q 以花纹单位计（一个单位 = size 格），值在 [0, 1]。整个星球把 patternAt 换成三维的（PATTERN3_GLSL）
const PATTERN_GLSL = `
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

const PATTERN3_GLSL = `
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

const VS_CELL = `#version 300 es
in vec2 aPos;
in float aCell;
in vec3 aBary;
uniform vec4 uView;
uniform sampler2D uColor;
uniform sampler2D uOther;
uniform highp sampler2D uElev;
uniform highp sampler2D uCoast;
uniform highp sampler2D uGrad;
out vec4 vLandCol;
out vec4 vSeaCol;
out float vElev;
out float vCoast;
out vec2 vGrad;
out vec2 vWorld;
out vec3 vBary;
flat out int vCell;
void main() {
  int c = int(aCell + 0.5);
  ivec2 t = ivec2(c % ${TEX_W}, c / ${TEX_W});
  vec4 col = texelFetch(uColor, t, 0);
  vec4 other = texelFetch(uOther, t, 0);
  vCoast = texelFetch(uCoast, t, 0).r;
  // 陆地格：陆色是自己、水色是对岸的；水面格反过来。像素再按陆海选一个，颜色不跨海岸互相渗
  bool isLand = vCoast > 0.0;
  vLandCol = isLand ? col : other;
  vSeaCol = isLand ? other : col;
  vElev = texelFetch(uElev, t, 0).r;
  vGrad = texelFetch(uGrad, t, 0).rg;
  vWorld = aPos;
  vBary = aBary;
  vCell = c;
  gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);
}`;

const FS_ID = `#version 300 es
precision highp float;
flat in int vCell;
layout(location = 0) out vec4 oId;
void main() {
  int id = vCell + 1;
  oId = vec4(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255), 255.0) / 255.0;
}`;

const FS_TERRAIN = `#version 300 es
precision highp float;
in vec4 vLandCol;
in vec4 vSeaCol;
in float vElev;
in float vCoast;
in vec2 vGrad;
in vec2 vWorld;
in vec3 vBary;
uniform float uSpacing;
uniform float uCoastAmp;
uniform float uDetail;
// 一个设备像素合多少地图单位；一个地图单位合多少米
uniform float uPixel;
uniform float uMetersPerUnit;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oHeight;
${NOISE_GLSL}
// 分形噪声：屏幕上不到两像素的那几层淡掉（全图时不闪）。pxPerUnit：p 的一个单位合多少像素。
// 淡到正好为 0 之后的各层都是 0（波长只会越来越短），不必再算
float fbmFade(vec2 p, int oct, float pxPerUnit) {
  float s = 0.0; float amp = 0.5; float wl = pxPerUnit;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    float fade = smoothstep(1.5, 4.0, wl);
    if (fade == 0.0) break;
    s += amp * vnoise(p) * fade;
    p = p * 2.03 + vec2(17.1, -9.3);
    amp *= 0.5;
    wl /= 2.03;
  }
  return s;
}
// 陆上的细节高度（米）：沿坡向拉长的冲沟（横向高频、纵向低频，坐标系随坡向旋转）和起伏，
// 屏幕上太细的那几层淡掉。冲沟比别的细节淡得早（不到 8 像素就淡），沟底用圆滑的 √(n² + 0.04)
float landDetailAt(vec2 world, vec2 dir, float relief, float h, float cellPx) {
  vec2 q = vec2(dot(world, vec2(-dir.y, dir.x)), dot(world, dir)) / uSpacing;
  float gully = 0.0; float a = 0.5; vec2 f = vec2(4.0, 1.1);
  for (int k = 0; k < 3; k++) {
    float fade = smoothstep(3.0, 9.0, cellPx / f.x);
    if (fade == 0.0) break;
    float n = vnoise(q * f + vec2(float(k) * 7.3, 1.7));
    gully += a * (1.0 - sqrt(n * n + 0.04) - 0.47) * fade;
    a *= 0.5; f *= 2.0;
  }
  gully *= relief * 0.45;
  float bumps = fbmFade(world / uSpacing * 1.7 + 5.0, 4, cellPx / 1.7) * (14.0 + 0.05 * max(h, 0.0));
  return uDetail * (gully + bumps);
}
void main() {
  float h = vElev;
  // 格以下的海岸：重心权重在格中心为 0，格的陆海与模拟一致（与导出逐位一致，不淡出）
  float wmax = max(vBary.x, max(vBary.y, vBary.z));
  float weight = clamp((1.0 - wmax) * 2.2, 0.0, 1.0);
  float rugged = clamp(max(h, 0.0) / 1200.0, 0.0, 1.0);
  float amp = uCoastAmp * (0.55 + 0.9 * rugged);
  float s = vCoast + weight * amp * fbmSub(vWorld / uSpacing * 2.1, 4);
  bool land = s > 0.0;
  float cellPx = uSpacing / uPixel;
  float gm = length(vGrad);
  float relief = gm * uSpacing;
  vec2 dir = gm > 1e-3 ? vGrad / gm : vec2(1.0, 0.0);
  // 海岸线：陆海交界处约 1.2 像素宽、抗锯齿
  float coastLine = 1.0 - smoothstep(0.6, 1.8, abs(s) / max(fwidth(s), 1e-6));
  vec3 col;
  float hh;
  vec2 slope = vec2(0.0);
  // 陆上的细节只在陆地上算、海底的细节只在海上算
  if (land) {
    float landDetail = landDetailAt(vWorld, dir, relief, h, cellPx);
    // 细节的坡度：在右边、下边各一个像素处再算一次细节，差分出来（屏幕导数按 2×2 像素一组算，
    // 细碎的噪声会变成一道道像素级的细线，放大后山上像一片刮痕）。
    // 细节不像整座山那样夸张晕渲（乘 0.6）
    float dx = landDetailAt(vWorld + vec2(uPixel, 0.0), dir, relief, h, cellPx) - landDetail;
    float dy = landDetailAt(vWorld + vec2(0.0, uPixel), dir, relief, h, cellPx) - landDetail;
    vec2 dDetail = vec2(dx, dy) / (uPixel * uMetersPerUnit) * 0.6;
    col = vLandCol.rgb;
    hh = max(h + landDetail, 2.0);
    // 坡度（地图坐标，米 / 米）：大尺度用插值后的格坡度（光滑），加上细节的差分
    slope = vGrad / uMetersPerUnit + dDetail;
    // 低平海岸有沙滩
    float beach = (1.0 - smoothstep(4.0, 22.0, hh)) * (1.0 - smoothstep(0.0, 120.0, relief)) * (0.35 + 0.65 * vLandCol.a);
    col = mix(col, vec3(0.86, 0.80, 0.62), beach * 0.75);
    // 地表纹理的轻微明暗变化
    col *= 1.0 + 0.05 * fbmFade(vWorld / uSpacing * 3.3 - 2.0, 3, cellPx / 3.3);
  } else {
    float seaDetail = uDetail * fbmFade(vWorld / uSpacing * 1.3, 3, cellPx / 1.3) * 25.0;
    col = vSeaCol.rgb;
    hh = min(h + seaDetail, -2.0);
    // 浅水：暖海偏青绿（alpha = 海水暖度），冷海偏灰绿
    float depth = -hh;
    vec3 shallow = mix(vec3(0.30, 0.50, 0.56), vec3(0.24, 0.62, 0.66), vSeaCol.a);
    col = mix(col, shallow, (1.0 - smoothstep(4.0, 70.0, depth)) * 0.7);
  }
  oColor = vec4(col, coastLine);
  oHeight = vec4(hh, s, slope);
}`;

const VS_QUAD = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 切线层：每段一个盖住带宽的长方形（实例 = 段，四个角 aCorner 画两个三角形），uShift 是整个星球上的副本平移。
// 距离、在线的哪一边与 core/seams.ts 的 segDist 一步一步相同
const VS_SEAM = `#version 300 es
in float aCorner;
in vec4 aSeg;
in vec4 aNb;
in vec2 aEnds;
uniform vec4 uView;
uniform float uShift;
uniform float uBand;
out vec2 vWorld;
flat out vec4 vSeg;
flat out vec4 vNb;
flat out vec2 vEnds;
flat out int vIdx;
void main() {
  vec2 a = aSeg.xy;
  vec2 b = aSeg.zw;
  vec2 d = normalize(b - a);
  vec2 nrm = vec2(-d.y, d.x);
  int k = int(aCorner + 0.5);
  vec2 p = ((k == 1 || k == 3) ? b + d * uBand : a - d * uBand) + nrm * (k >= 2 ? uBand : -uBand);
  vWorld = p;
  vSeg = aSeg;
  vNb = aNb;
  vEnds = aEnds;
  vIdx = gl_InstanceID;
  gl_Position = vec4((p + vec2(uShift, 0.0)) * uView.xy + uView.zw, 0.0, 1.0);
}`;

const FS_SEAM = `#version 300 es
precision highp float;
precision highp int;
in vec2 vWorld;
flat in vec4 vSeg;
flat in vec4 vNb;
flat in vec2 vEnds;
flat in int vIdx;
uniform float uBand;
layout(location = 0) out vec4 oSeam;
vec2 leftNormal(vec2 e) {
  float l = length(e);
  return l > 0.0 ? vec2(-e.y, e.x) / l : vec2(0.0);
}
void main() {
  vec2 a = vSeg.xy;
  vec2 e = vSeg.zw - a;
  vec2 q = vWorld - a;
  float t = dot(q, e) / dot(e, e);
  // 过了切线真正的两端不管
  if (t < 0.0 && vEnds.x < 0.5) discard;
  if (t > 1.0 && vEnds.y < 0.5) discard;
  float d;
  bool left;
  if (t > 0.0 && t < 1.0) {
    left = e.x * q.y - e.y * q.x > 0.0;
    d = length(q - e * t);
  } else {
    // 端点外（转角处）：到端点的距离；哪一边按两段法向之和
    bool start = t <= 0.0;
    vec2 v = start ? a : vSeg.zw;
    vec2 sn = leftNormal(e);
    vec2 on = start ? leftNormal(a - vNb.xy) : leftNormal(vNb.zw - v);
    vec2 nn = sn + on;
    if (dot(nn, nn) < 1e-8) nn = sn;
    vec2 r = vWorld - v;
    left = dot(r, nn) > 0.0;
    d = length(r);
  }
  if (d >= uBand) discard;
  gl_FragDepth = d / uBand;
  int id = vIdx + 1;
  oSeam = vec4(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255), left ? 255.0 : 0.0) / 255.0;
}`;

const FS_COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSceneColor;
uniform highp sampler2D uSceneHeight;
uniform sampler2D uIdTex;
uniform sampler2D uFlat;
uniform sampler2D uHighlight;
uniform highp sampler2D uGroup;
// 切线层（屏幕大小）与每段的数据（两边的分组值、代表格：gL, gR, repL, repR）
uniform sampler2D uSeam;
uniform highp sampler2D uSegData;
uniform int uHasSeams;
// 平涂、高亮按省份取（省份着色、省份工具）：切线附近也跟着换格
uniform int uFlatByGroup;
uniform int uHighlightByGroup;
uniform vec2 uTexel;
uniform vec4 uView;
uniform float uSpacing;
uniform float uRelief;
uniform float uShade;
uniform float uRock;
uniform int uStyle;
uniform int uHasFlat;
uniform int uHasGroup;
uniform int uHasHighlight;
uniform float uCellPx;
// 每个省大约几格宽（√ 省份格数的中位数）：省界按省的大小淡出
uniform float uProvScale;
// 生态的花纹与发光（每格的字节与调色板，见 colors.ts 的 fxLayers）
uniform sampler2D uFx;
uniform highp sampler2D uFxPal;
uniform int uHasFx;
out vec4 oColor;
${NOISE_GLSL}
int idAt(vec2 uv) {
  vec4 c = texture(uIdTex, clamp(uv, vec2(0.0), vec2(1.0))) * 255.0;
  return int(c.r + 0.5) + int(c.g + 0.5) * 256 + int(c.b + 0.5) * 65536 - 1;
}
vec4 cellTex(sampler2D tex, int id) {
  return texelFetch(tex, ivec2(id % ${TEX_W}, id / ${TEX_W}), 0);
}
// 分组值：陆地省份 = 编号 + 1（> 0），海域省份 = −(编号 + 1)（< 0），未划分 = 0，地图外 = −1e9
float groupOf(int id) { return id < 0 ? -1e9 : cellTex(uGroup, id).r; }
// 切线附近按在线的哪一边换格（与 core/seams.ts 的 seamPixel 相同）：id 是像素按扭曲后的位置取的格，
// uv 是像素没扭曲的位置（切线层按它找最近的段）
int seamCell(int id, vec2 uv) {
  if (uHasSeams == 0 || id < 0) return id;
  vec4 s = texture(uSeam, uv) * 255.0;
  int seg = int(s.r + 0.5) + int(s.g + 0.5) * 256 + int(s.b + 0.5) * 65536 - 1;
  if (seg < 0) return id;
  vec4 sd = texelFetch(uSegData, ivec2(seg % ${TEX_W}, seg / ${TEX_W}), 0);
  if (sd.r == sd.g) return id;
  vec2 g = cellTex(uGroup, id).rg;
  if (g.g < 0.5) return id;
  bool left = s.a > 127.5;
  if (g.r != (left ? sd.g : sd.r)) return id;
  return int((left ? sd.b : sd.a) + 0.5);
}
// 高亮的 alpha 字节（编码见 colors.ts 的 highlightColors）：0 没有，1–127 平涂，128 只描边，129–255 斜线
float hlByte(int id) { return id < 0 ? 0.0 : cellTex(uHighlight, id).a * 255.0; }
// 平涂、斜线的不透明度；只描边的是 0
float hlAlpha(float A) { return A > 128.5 ? (A - 128.0) / 127.0 : A < 127.5 ? A / 127.0 : 0.0; }
${FX_BEGIN}${PATTERN_GLSL}${FX_END}
void main() {
  vec4 base = texture(uSceneColor, vUv);
  vec4 hs = texture(uSceneHeight, vUv);
  float h = hs.r;
  bool land = hs.g > 0.0;
  // 地形层算好的坡度（地图坐标，y 向下）→ 法线
  vec3 n = normalize(vec3(-hs.b * uRelief, hs.a * uRelief, 1.0));
  vec3 L = normalize(vec3(-0.6, 0.6, 0.75));
  float shade = clamp(1.0 + 0.85 * (dot(n, L) - L.z), 0.3, 1.3);
  vec3 col = base.rgb;

  // 按扭曲后的坐标找格：分类平涂与边界是自然的曲线
  vec2 world = (vUv * 2.0 - 1.0 - uView.zw) / uView.xy;
  // 与 core/subcell.ts 的 warpOffset 相同（WARP_AMP = 0.6，WARP_FREQ = 0.9）
  float f = 0.9 / uSpacing;
  vec2 w = 0.6 * uSpacing * vec2(fbmSub(world * f + vec2(3.7, 0.0), 3), fbmSub(world * f + vec2(0.0, -5.1), 3));
  vec2 uvW = ((world + w) * uView.xy + uView.zw) * 0.5 + 0.5;
  int id = idAt(uvW);

  // 省界、省份着色、省份的高亮用切线换过的格
  int idG = seamCell(id, vUv);
  if (uHasFlat == 1 && id >= 0) {
    vec4 fc = cellTex(uFlat, uFlatByGroup == 1 ? idG : id);
    col = mix(col, fc.rgb, fc.a);
  }
  ${FX_BEGIN}
  // 生态的花纹：画在晕渲之前（跟着山的明暗）。屏幕上太细时淡成平均值，远看与缩略图的颜色一致
  vec4 fx = uHasFx == 1 && land && id >= 0 ? cellTex(uFx, id) * 255.0 : vec4(0.0);
  int patSlot = int(fx.r + 0.5) - 1;
  if (patSlot >= 0 && fx.g > 0.5) {
    vec4 c2 = texelFetch(uFxPal, ivec2(0, patSlot), 0);
    vec4 kd = texelFetch(uFxPal, ivec2(2, patSlot), 0);
    int kind = int(kd.r + 0.5);
    float fade = smoothstep(1.5, 5.0, uCellPx * kd.g * PAT_DETAIL[kind]);
    float v = fade > 0.0 ? mix(kd.b, patternAt(kind, world, kd.g, kd.a), fade) : kd.b;
    col = mix(col, c2.rgb, v * c2.a * fx.g / 255.0);
  }
  ${FX_END}
  if (land) {
    // 陡坡露岩
    float steep = 1.0 - n.z;
    col = mix(col, vec3(0.52, 0.48, 0.44), smoothstep(0.25, 0.6, steep) * uRock);
  }
  if (uStyle == 1) {
    // 地图册：羊皮纸底色、暖色晕渲、平涂的海
    if (land) {
      col = mix(col, vec3(0.93, 0.87, 0.72), 0.45);
      col *= mix(vec3(0.62, 0.52, 0.42), vec3(1.04, 1.02, 0.98), clamp(shade - 0.3, 0.0, 1.0));
    } else {
      float depth = -h;
      col = mix(vec3(0.70, 0.80, 0.83), vec3(0.80, 0.88, 0.89), 1.0 - smoothstep(20.0, 300.0, depth));
    }
  } else if (land) {
    col *= mix(1.0, shade, uShade);
  } else {
    col *= mix(1.0, 0.92 + 0.08 * shade, uShade);
  }
  ${FX_BEGIN}
  // 生态的发光：加在晕渲之后（背光的坡上照样亮）
  int glowSlot = int(fx.a + 0.5) - 1;
  if (glowSlot >= 0 && fx.b > 0.5) col += texelFetch(uFxPal, ivec2(1, glowSlot), 0).rgb * (fx.b / 255.0) * (uStyle == 1 ? ${glsl(GLOW_GAIN_ATLAS)} : ${glsl(GLOW_GAIN)});
  ${FX_END}

  // 海岸线：地形层画好的抗锯齿细线
  col = mix(col, uStyle == 1 ? vec3(0.35, 0.27, 0.2) : vec3(0.18, 0.22, 0.24), base.a * (uStyle == 1 ? 0.8 : 0.4));

  // 分组边界（省份）：扭曲坐标下相邻像素的分组不同
  if (uHasGroup == 1 && id >= 0) {
    vec2 dx = vec2(uTexel.x * 1.5, 0.0);
    vec2 dy = vec2(0.0, uTexel.y * 1.5);
    float g0 = groupOf(idG);
    float gx = groupOf(seamCell(idAt(uvW + dx), vUv + dx));
    float gy = groupOf(seamCell(idAt(uvW + dy), vUv + dy));
    // 陆海之间的边界已经由海岸线画出，这里只画同类之间的
    bool bx = gx > -1e8 && gx != g0 && (gx > 0.0) == (g0 > 0.0);
    bool by = gy > -1e8 && gy != g0 && (gy > 0.0) == (g0 > 0.0);
    // 缩小到省份只有十几像素宽时淡出（看省有多大，不看格有多大），否则全图视角下边界会密成一张网；
    // 格比一个像素还小时也淡出（扭曲后取到的格在像素之间乱跳，边界碎成噪点）
    float fade = smoothstep(6.0, 16.0, uCellPx * uProvScale) * smoothstep(0.7, 1.4, uCellPx);
    if (bx || by) col = mix(col, uStyle == 1 ? vec3(0.45, 0.2, 0.15) : vec3(0.12, 0.1, 0.08), (g0 > 0.0 ? 0.55 : 0.15) * fade);
  }

  // 高亮与轮廓
  if (uHasHighlight == 1 && id >= 0) {
    bool byGroup = uHighlightByGroup == 1;
    int idH = byGroup ? idG : id;
    vec4 hc = cellTex(uHighlight, idH);
    float A0 = hc.a * 255.0;
    float a0 = hlAlpha(A0);
    if (A0 > 128.5) {
      // 斜线：按屏幕像素画，缩放时线宽不变
      float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
      col = mix(col, hc.rgb, a0 * stripe);
    } else {
      col = mix(col, hc.rgb, a0);
    }
    // 轮廓画在有高亮（不论多淡）与没有高亮的格之间。浓淡跟着两边较浓的一侧：0.18 以上照旧，
    // 更淡的（闪烁淡出时、渐变的边缘）跟着一起淡，不会在中途忽然断掉；只描边的格固定 0.75
    vec2 hx = vec2(uTexel.x * 1.5, 0.0);
    vec2 hy = vec2(0.0, uTexel.y * 1.5);
    int ix = idAt(uvW + hx);
    int iy = idAt(uvW + hy);
    float Ax = hlByte(byGroup ? seamCell(ix, vUv + hx) : ix);
    float Ay = hlByte(byGroup ? seamCell(iy, vUv + hy) : iy);
    bool on0 = A0 > 0.5;
    if (on0 != (Ax > 0.5) || on0 != (Ay > 0.5)) {
      bool lineOnly = abs(A0 - 128.0) < 0.5 || abs(Ax - 128.0) < 0.5 || abs(Ay - 128.0) < 0.5;
      float oa = max(a0, max(hlAlpha(Ax), hlAlpha(Ay)));
      col = mix(col, vec3(1.0), lineOnly ? 0.75 : 0.9 * min(1.0, oa / 0.18));
    }
  }
  if (id < 0) col = vec3(0.08, 0.1, 0.14);
  oColor = vec4(col, 1.0);
}`;

// ---------- 整个星球：平铺图左右重复几份；格以下的细节在球面位置上取三维噪声 ----------
// 与 core/subcell.ts 的 hashU3 / vnoise3 / fbmSub3 / sphereOf 逐位（浮点部分逐位相近）一致，导出的图与屏幕一致

const SPHERE_GLSL = `
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
function must(src: string, from: string, to: string): string {
  if (!src.includes(from)) throw new Error(`着色器替换失败：${from.slice(0, 40)}`);
  return src.replace(from, to);
}

// 星球的顶点：画第 uCopy0 + 实例号 份（x 平移 2 的倍数）；细节噪声用基准坐标，所以每份一模一样
const VS_CELL_PLANET = must(
  must(VS_CELL, 'uniform vec4 uView;', 'uniform vec4 uView;\nuniform int uCopy0;'),
  'gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);',
  'vec2 pp = aPos + vec2(2.0 * float(uCopy0 + gl_InstanceID), 0.0);\n  gl_Position = vec4(pp * uView.xy + uView.zw, 0.0, 1.0);',
);

const FS_TERRAIN_PLANET = `#version 300 es
precision highp float;
in vec4 vLandCol;
in vec4 vSeaCol;
in float vElev;
in float vCoast;
in vec2 vGrad;
in vec2 vWorld;
in vec3 vBary;
uniform float uSpacing;
uniform float uCoastAmp;
uniform float uDetail;
uniform float uPixel;
uniform float uMetersPerUnit;
// 噪声频率：1 / (π · 格距)，一个噪声单位约一格
uniform float uNoiseK;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oHeight;
${NOISE_GLSL}
${SPHERE_GLSL}
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
  // 上下超出两极的部分不画
  if (vWorld.y < 0.0 || vWorld.y > 1.0) discard;
  float h = vElev;
  vec3 P = sphereOf(vWorld);
  float wmax = max(vBary.x, max(vBary.y, vBary.z));
  float weight = clamp((1.0 - wmax) * 2.2, 0.0, 1.0);
  float rugged = clamp(max(h, 0.0) / 1200.0, 0.0, 1.0);
  float amp = uCoastAmp * (0.55 + 0.9 * rugged);
  float s = vCoast + weight * amp * fbmSub3(P * uNoiseK * 2.1, 4);
  bool land = s > 0.0;
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
    hh = max(h + landDetail, 2.0);
    slope = vGrad / uMetersPerUnit + dDetail;
    float beach = (1.0 - smoothstep(4.0, 22.0, hh)) * (1.0 - smoothstep(0.0, 120.0, relief)) * (0.35 + 0.65 * vLandCol.a);
    col = mix(col, vec3(0.86, 0.80, 0.62), beach * 0.75);
    col *= 1.0 + 0.05 * fbmFade3(P * uNoiseK * 3.3 - 2.0, 3, cellPx / 3.3);
  } else {
    float seaDetail = uDetail * fbmFade3(P * uNoiseK * 1.3, 3, cellPx / 1.3) * 25.0;
    col = vSeaCol.rgb;
    hh = min(h + seaDetail, -2.0);
    float depth = -hh;
    vec3 shallow = mix(vec3(0.30, 0.50, 0.56), vec3(0.24, 0.62, 0.66), vSeaCol.a);
    col = mix(col, shallow, (1.0 - smoothstep(4.0, 70.0, depth)) * 0.7);
  }
  oColor = vec4(col, coastLine);
  oHeight = vec4(hh, s, slope);
}`;

// 合成：按扭曲后的坐标取格。扭曲的噪声、生态的花纹在球面上取（每份副本一样），两极以外是背景
const PATTERN_AT_2D = 'float patternAt(int kind, vec2 world, float size, float seed) {\n  return patternValue(';
const FS_COMPOSE_PLANET = must(
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

// 测试用（没有 WebGL 时检查拼出来的源码）：合成着色器的平面、星球两份
export const COMPOSE_SOURCES = { plane: FS_COMPOSE, planet: FS_COMPOSE_PLANET };

// 合成程序：带花纹的编译不过时退回不带花纹的（见 withoutFx），只在控制台留一句
function compileCompose(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  try {
    return compile(gl, VS_QUAD, fs);
  } catch (e) {
    console.warn('生态花纹的着色器编译不过，先不画花纹、发光：', e);
    return compile(gl, VS_QUAD, withoutFx(fs));
  }
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '着色器编译失败');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.bindAttribLocation(p, 1, 'aCell');
  gl.bindAttribLocation(p, 2, 'aBary');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? '着色器链接失败');
  return p;
}

export interface Camera {
  // 视图中心（地图单位）与缩放（像素 / 地图单位）
  x: number;
  y: number;
  zoom: number;
}

export interface CellLayers {
  // 平滑层颜色（alpha：陆地为“沙质”程度，海为海水暖度）
  smooth: Uint8Array;
  // 对岸的颜色：陆地格是相邻水面的颜色，水面格是相邻陆地的颜色（没有对岸就是自己的）
  other: Uint8Array;
  elevation: Float32Array;
  coast: Float32Array;
  grad: Float32Array;
  // 分类平涂（alpha = 覆盖度），null 不画
  flat: Uint8Array | null;
  // 分组（省份），画分组边界；每格两个值（分组编号、切线用的标记，见 colors.ts 的 provinceGroups）；null 不画
  group: Float32Array | null;
  // 剪刀切过的线（core/seams.ts）：切线附近按在线的哪一边换格；没有切线时为 null
  seams?: SeamLayers | null;
  shade: number;
  rock: number;
  coastAmp: number;
  // 生态的花纹与发光（colors.ts 的 fxLayers）：每格 RGBA 字节与 256 行 × 3 纹素的调色板；没有时为 null（整段跳过）
  fx?: Uint8Array | null;
  fxPalette?: Float32Array | null;
}

export type MapStyle = 'realistic' | 'atlas';

export class Renderer {
  private gl: WebGL2RenderingContext;
  private progId: WebGLProgram;
  private progTerrain: WebGLProgram;
  private progCompose: WebGLProgram;
  private progSeam: WebGLProgram;
  // 整个星球用的三个程序（第一次遇到星球时才编译）
  private planetProgs: { id: WebGLProgram; terrain: WebGLProgram; compose: WebGLProgram } | null = null;
  private planet = false;
  // 星球几何在 x 方向上的范围（含接缝外的一点），用来算要画哪几份副本
  private xRange: [number, number] = [0, 2];
  private triVao: WebGLVertexArrayObject | null = null;
  private triCount = 0;
  private fanVao: WebGLVertexArrayObject | null = null;
  private fanCount = 0;
  private tex: Record<'color' | 'other' | 'elev' | 'coast' | 'grad' | 'flat' | 'highlight' | 'group' | 'segData' | 'fx' | 'fxPal', WebGLTexture>;
  private fbo: WebGLFramebuffer;
  private fboId: WebGLFramebuffer;
  private fboSeam: WebGLFramebuffer;
  private sceneColor: WebGLTexture;
  private sceneHeight: WebGLTexture;
  private idTex: WebGLTexture;
  private seamTex: WebGLTexture;
  private seamDepth: WebGLRenderbuffer;
  // 切线：每段一个实例（两端、前后两段的端点、前后有没有段）。setLayers 给的与现在显示的（剪刀拖动时多一条）
  private seamVao: WebGLVertexArrayObject;
  private seamBuf: WebGLBuffer;
  private seamCount = 0;
  private seamBand = 0;
  private seamX: [number, number] = [0, 0];
  private seamsBase: SeamLayers | null = null;
  private seamsShown: SeamLayers | null = null;
  private seamVersion = 0;
  private seamKey = '';
  private fboSize = [0, 0];
  private mesh: Mesh | null = null;
  private hasFlat = false;
  private hasGroup = false;
  private hasHighlight = false;
  private shade = 1;
  private rock = 1;
  private coastAmp = 180;
  style: MapStyle = 'realistic';
  detail = 1;
  // 平涂是省份着色、高亮是省份工具的：切线附近也按换过的格取（否则按像素自己的格）
  flatByGroup = false;
  highlightByGroup = false;
  camera: Camera = { x: 1, y: 0.5, zoom: 500 };
  // 晕渲的夸张倍数（全图时）：真实的山坡很缓，不夸张就看不出起伏
  relief = 24;
  // 每个省大约几格宽（√ 省份格数的中位数，MapView 在省份变了时算）：缩小时省界按它淡出
  provinceScale = 1;
  // 场景（编号层、地形层）与合成画面的版本：没变就不重画
  private layersVersion = 0;
  private highlightVersion = 0;
  private sceneKey = '';
  private composeKey = '';
  // 分组、平涂：setLayers 给的底子与现在显示的（省份预览覆盖时不同）。换预览时只上传变了的行
  private groupBase: Float32Array | null = null;
  private groupShown: Float32Array | null = null;
  private flatBase: Uint8Array | null = null;
  private flatShown: Uint8Array | null = null;
  private groupVersion = 0;
  // 幽灵海岸（colors.ts 的 GhostBuffer）：setLayers 给的底子，现在显示着幽灵的那些行，幽灵的海岸细节幅度
  private base: CellLayers | null = null;
  private ghostRows: number[] = [];
  private ghostAmp: number | null = null;
  private ghostGroup: Float32Array | null = null;
  private ghostFlat: Uint8Array | null = null;
  // 生态的花纹与发光：setLayers 给的，与现在显示的（拖花纹、发光滑块时主线程上换的）
  private fxBase: { fx: Uint8Array | null; palette: Float32Array | null } = { fx: null, palette: null };
  private fxShown: { fx: Uint8Array | null; palette: Float32Array | null } = { fx: null, palette: null };
  private fxVersion = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('浏览器不支持浮点渲染目标（EXT_color_buffer_float）');
    this.gl = gl;
    this.progId = compile(gl, VS_CELL, FS_ID);
    this.progTerrain = compile(gl, VS_CELL, FS_TERRAIN);
    this.progCompose = compileCompose(gl, FS_COMPOSE);
    this.progSeam = compile(gl, VS_SEAM, FS_SEAM);
    const t = () => this.makeTex();
    this.tex = { color: t(), other: t(), elev: t(), coast: t(), grad: t(), flat: t(), highlight: t(), group: t(), segData: t(), fx: t(), fxPal: t() };
    this.fbo = gl.createFramebuffer()!;
    this.fboId = gl.createFramebuffer()!;
    this.fboSeam = gl.createFramebuffer()!;
    this.sceneColor = this.makeTex(true);
    this.sceneHeight = this.makeTex();
    this.idTex = this.makeTex();
    this.seamTex = this.makeTex();
    this.seamDepth = gl.createRenderbuffer()!;
    // 每段的数据先放一个空纹素：还没有切线时合成程序照样绑着它，不能是没有内容的纹理
    gl.bindTexture(gl.TEXTURE_2D, this.tex.segData);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    // 花纹的两张纹理也先放一个空纹素（没有花纹时合成程序照样绑着它们）
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fxPal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    // 切线：长方形的四个角（每个顶点一个），与每段的实例数据：10 个数（aSeg 4、aNb 4、aEnds 2）
    this.seamVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.seamVao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2, 3]), gl.STATIC_DRAW);
    const cornerLoc = gl.getAttribLocation(this.progSeam, 'aCorner');
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 1, gl.FLOAT, false, 0, 0);
    this.seamBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seamBuf);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.progSeam, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr('aSeg', 4, 0);
    attr('aNb', 4, 16);
    attr('aEnds', 2, 32);
    gl.bindVertexArray(null);
  }

  private makeTex(linear = false): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  setMesh(mesh: Mesh) {
    if (this.mesh === mesh) return;
    this.mesh = mesh;
    this.layersVersion++;
    this.planet = mesh.kind === 'sphere';
    if (mesh.kind === 'sphere') {
      this.setSphereMesh(mesh);
      return;
    }
    // Delaunay 三角形，不共享顶点，每个顶点带重心坐标的一个分量
    const tris = mesh.triangles;
    const tp = new Float32Array(tris.length * 2);
    const tc = new Float32Array(tris.length);
    const tb = new Float32Array(tris.length * 3);
    for (let k = 0; k < tris.length; k++) {
      const c = tris[k];
      tp[2 * k] = mesh.x[c];
      tp[2 * k + 1] = mesh.y[c];
      tc[k] = c;
      tb[3 * k + (k % 3)] = 1;
    }
    this.triVao = this.makeVao(tp, tc, tb);
    this.triCount = tris.length;
    // Voronoi：每个多边形以格中心做扇形三角化（编号层）
    const vp: number[] = [];
    const vc: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      const a = mesh.polyOff[i];
      const b = mesh.polyOff[i + 1];
      const m = b - a;
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        vp.push(mesh.x[i], mesh.y[i], mesh.poly[2 * (a + k)], mesh.poly[2 * (a + k) + 1], mesh.poly[2 * (a + k2)], mesh.poly[2 * (a + k2) + 1]);
        vc.push(i, i, i);
      }
    }
    this.fanVao = this.makeVao(new Float32Array(vp), new Float32Array(vc), new Float32Array(vc.length * 3));
    this.fanCount = vc.length;
  }

  // 整个星球：显示用的三角网（含接缝两侧、两极的影子点，对应回真实的格）。
  // 同一个三角形里对应同一格的角共用一个重心坐标分量，与导出（subcell.ts）的权重合并一致
  private setSphereMesh(mesh: Extract<Mesh, { kind: 'sphere' }>) {
    const gl = this.gl;
    if (!this.planetProgs) {
      this.planetProgs = {
        id: compile(gl, VS_CELL_PLANET, FS_ID),
        terrain: compile(gl, VS_CELL_PLANET, FS_TERRAIN_PLANET),
        compose: compileCompose(gl, FS_COMPOSE_PLANET),
      };
    }
    const view = viewOf(mesh);
    const tris = view.triangles;
    const tp = new Float32Array(tris.length * 2);
    const tc = new Float32Array(tris.length);
    const tb = new Float32Array(tris.length * 3);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let t = 0; t < tris.length; t += 3) {
      const c0 = view.cellOf[tris[t]];
      const c1 = view.cellOf[tris[t + 1]];
      for (let k = 0; k < 3; k++) {
        const v = tris[t + k];
        const c = view.cellOf[v];
        tp[2 * (t + k)] = view.x[v];
        tp[2 * (t + k) + 1] = view.y[v];
        tc[t + k] = c;
        const slot = c === c0 ? 0 : c === c1 ? 1 : k;
        tb[3 * (t + k) + slot] = 1;
        x0 = Math.min(x0, view.x[v]);
        x1 = Math.max(x1, view.x[v]);
      }
    }
    this.triVao = this.makeVao(tp, tc, tb);
    this.triCount = tris.length;
    // 编号层：Voronoi 多边形（凸），从第一个顶点扇形三角化
    const polys = view.polygons();
    let count = 0;
    for (let q = 0; q + 1 < polys.off.length; q++) count += Math.max(0, polys.off[q + 1] - polys.off[q] - 2) * 3;
    const vp = new Float32Array(count * 2);
    const vc = new Float32Array(count);
    let o = 0;
    for (let q = 0; q + 1 < polys.off.length; q++) {
      const a = polys.off[q];
      const b = polys.off[q + 1];
      for (let k = a + 1; k + 1 < b; k++) {
        for (const v of [a, k, k + 1]) {
          vp[2 * o] = polys.xy[2 * v];
          vp[2 * o + 1] = polys.xy[2 * v + 1];
          vc[o] = polys.cell[q];
          o++;
        }
      }
    }
    this.fanVao = this.makeVao(vp, vc, new Float32Array(count * 3));
    this.fanCount = count;
    this.xRange = [Math.min(x0, 0), Math.max(x1, 2)];
  }

  private makeVao(pos: Float32Array, cell: Float32Array, bary: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attr = (loc: number, data: Float32Array, size: number) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attr(0, pos, 2);
    attr(1, cell, 1);
    attr(2, bary, 3);
    gl.bindVertexArray(null);
    return vao;
  }

  private upload(tex: WebGLTexture, data: Uint8Array | Float32Array, n: number, channels: 1 | 2 | 4) {
    const gl = this.gl;
    const rows = Math.ceil(n / TEX_W);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (data instanceof Float32Array) {
      const padded = new Float32Array(TEX_W * rows * channels);
      padded.set(data.subarray(0, n * channels));
      if (channels === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, TEX_W, rows, 0, gl.RED, gl.FLOAT, padded);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_W, rows, 0, gl.RG, gl.FLOAT, padded);
    } else {
      const padded = new Uint8Array(TEX_W * rows * 4);
      padded.set(data.subarray(0, n * 4));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEX_W, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, padded);
    }
  }

  setLayers(l: CellLayers) {
    const n = this.mesh?.n ?? 0;
    this.layersVersion++;
    this.upload(this.tex.color, l.smooth, n, 4);
    this.upload(this.tex.other, l.other, n, 4);
    this.upload(this.tex.elev, l.elevation, n, 1);
    this.upload(this.tex.coast, l.coast, n, 1);
    this.upload(this.tex.grad, l.grad, n, 2);
    this.hasFlat = !!l.flat;
    if (l.flat) this.upload(this.tex.flat, l.flat, n, 4);
    this.hasGroup = !!l.group;
    if (l.group) this.upload(this.tex.group, l.group, n, 2);
    this.groupBase = this.groupShown = l.group;
    this.flatBase = this.flatShown = l.flat;
    this.seamsBase = l.group ? (l.seams ?? null) : null;
    this.showSeams(this.seamsBase);
    this.shade = l.shade;
    this.rock = l.rock;
    this.coastAmp = l.coastAmp;
    this.base = l;
    this.ghostRows = [];
    this.ghostAmp = null;
    this.ghostGroup = null;
    this.ghostFlat = null;
    this.fxBase = { fx: l.fx ?? null, palette: l.fxPalette ?? null };
    this.fxShown = { fx: null, palette: null };
    this.setFx(this.fxBase.fx, this.fxBase.palette);
  }

  // 生态的花纹与发光：拖花纹、发光滑块时主线程上换一份（colors.ts 的 fxLayers 带上覆盖的外观），null 回到 setLayers 给的。
  // 同一份不重新上传；setLayers 之后回到它给的，调用方要重新给
  setFx(fx: Uint8Array | null, palette: Float32Array | null) {
    if (fx === this.fxShown.fx && palette === this.fxShown.palette) return;
    this.fxShown = { fx, palette };
    this.fxVersion++;
    if (!fx || !palette) return;
    const gl = this.gl;
    this.upload(this.tex.fx, fx, this.mesh?.n ?? 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fxPal);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 3, palette.length / 12, 0, gl.RGBA, gl.FLOAT, palette);
  }

  // 幽灵海岸：几格的地形输入（颜色、对岸的颜色、高程、海岸值，与平涂、分组）换成将来的样子，着色器照此画出将来真实的海岸线；
  // null 回到 setLayers 给的。g 的数组是持久的缓冲，g.cells 是现在与底子不同的格：只上传这些格与上一次不同的格所在的行。
  // 省份预览（setGroupPreview）显示着的时候平涂、分组听省份预览的。setLayers 之后幽灵就没了，调用方要重新给
  setGhost(g: GhostLayers | null) {
    const base = this.base;
    if (!base) return;
    const now = new Set<number>();
    if (g) for (const i of g.cells) now.add(Math.floor(i / TEX_W));
    const rows = [...new Set([...this.ghostRows, ...now])].sort((a, b) => a - b);
    const amp = g?.coastAmp ?? null;
    if (!rows.length && amp === this.ghostAmp) return;
    const src = g ?? { smooth: base.smooth, other: base.other, elevation: base.elevation, coast: base.coast, flat: base.flat, group: base.group };
    this.uploadRows(this.tex.color, src.smooth, rows, 4);
    this.uploadRows(this.tex.other, src.other, rows, 4);
    this.uploadRows(this.tex.elev, src.elevation, rows, 1);
    this.uploadRows(this.tex.coast, src.coast, rows, 1);
    // 平涂、分组：显示着的是底子或上一次的幽灵时才换
    if (this.groupBase && src.group && (this.groupShown === this.groupBase || this.groupShown === this.ghostGroup)) {
      this.uploadRows(this.tex.group, src.group, rows, 2);
      this.groupShown = g ? src.group : this.groupBase;
      this.groupVersion++;
    }
    if (this.flatBase && src.flat && (this.flatShown === this.flatBase || this.flatShown === this.ghostFlat)) {
      this.uploadRows(this.tex.flat, src.flat, rows, 4);
      this.flatShown = g ? src.flat : this.flatBase;
      this.groupVersion++;
    }
    this.ghostGroup = g?.group ?? null;
    this.ghostFlat = g?.flat ?? null;
    this.ghostRows = [...now];
    this.ghostAmp = amp;
    this.layersVersion++;
  }

  // 只上传这几行（每行 TEX_W 格；连着的几行一次传）
  private uploadRows(tex: WebGLTexture, data: Uint8Array | Float32Array, rows: number[], channels: 1 | 2 | 4) {
    if (!rows.length) return;
    const gl = this.gl;
    const per = TEX_W * channels;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let k = 0; k < rows.length; ) {
      const r = rows[k];
      let r1 = r + 1;
      while (k + 1 < rows.length && rows[k + 1] === r1) {
        k++;
        r1++;
      }
      k++;
      // 最后一行不满时补齐
      let src: Uint8Array | Float32Array = data.subarray(r * per, Math.min(data.length, r1 * per));
      if (src.length < (r1 - r) * per) {
        const padded = data instanceof Float32Array ? new Float32Array((r1 - r) * per) : new Uint8Array((r1 - r) * per);
        padded.set(src);
        src = padded;
      }
      if (channels === 1) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RED, gl.FLOAT, src);
      else if (channels === 2) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RG, gl.FLOAT, src);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
  }

  // 省份预览：整份分组（与平涂、切线）换成将来的样子，着色器照此画出真实的新省界；null 回到 setLayers 给的。
  // 没有画分组边界时不管。setLayers 之后预览就没了，调用方要重新给
  setGroupPreview(p: { group: Float32Array; flat: Uint8Array | null; seams?: SeamLayers | null } | null) {
    if (!this.groupBase || !this.groupShown) return;
    const group = p ? p.group : this.groupBase;
    const flat = p && p.flat && this.flatBase ? p.flat : this.flatBase;
    const seams = p ? (p.seams ?? null) : this.seamsBase;
    if (group === this.groupShown && flat === this.flatShown && seams === this.seamsShown) return;
    this.uploadChanged(this.tex.group, this.groupShown, group, 2);
    this.groupShown = group;
    if (flat && this.flatShown && flat !== this.flatShown) {
      this.uploadChanged(this.tex.flat, this.flatShown, flat, 4);
      this.flatShown = flat;
    }
    this.showSeams(seams);
    this.groupVersion++;
  }

  // 切线：每段的几何（实例数据）与两边的省（gL, gR, repL, repR 一段一个纹素）
  private showSeams(L: SeamLayers | null) {
    if (L === this.seamsShown) return;
    this.seamsShown = L;
    this.seamVersion++;
    const m = L ? L.segs.count : 0;
    this.seamCount = m;
    if (!L || !m) return;
    const gl = this.gl;
    const S = L.segs;
    const inst = new Float32Array(m * 10);
    const data = new Float32Array(m * 4);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let s = 0; s < m; s++) {
      inst.set([S.ax[s], S.ay[s], S.bx[s], S.by[s], S.px[s], S.py[s], S.nx[s], S.ny[s], S.hasPrev[s], S.hasNext[s]], s * 10);
      data.set([L.gL[s], L.gR[s], L.repL[s], L.repR[s]], s * 4);
      x0 = Math.min(x0, S.ax[s], S.bx[s]);
      x1 = Math.max(x1, S.ax[s], S.bx[s]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seamBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
    const rows = Math.ceil(m / TEX_W);
    const padded = new Float32Array(TEX_W * rows * 4);
    padded.set(data);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.segData);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, padded);
    this.seamBand = L.band;
    this.seamX = [x0, x1];
  }

  // 只上传与现在显示的不同的那些行（每行 TEX_W 格）：涂省、剪刀每动一下只改一小片
  private uploadChanged(tex: WebGLTexture, before: Float32Array | Uint8Array, after: Float32Array | Uint8Array, channels: 2 | 4) {
    const gl = this.gl;
    const n = this.mesh?.n ?? 0;
    const rows = Math.ceil(n / TEX_W);
    const per = TEX_W * channels;
    const differs = (r: number) => {
      const end = Math.min(n * channels, (r + 1) * per);
      for (let k = r * per; k < end; k++) if (before[k] !== after[k]) return true;
      return false;
    };
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let r = 0; r < rows; ) {
      if (!differs(r)) {
        r++;
        continue;
      }
      let r1 = r + 1;
      while (r1 < rows && differs(r1)) r1++;
      // 最后一行不满时补齐
      let src: Float32Array | Uint8Array = after.subarray(r * per, Math.min(after.length, r1 * per));
      if (src.length < (r1 - r) * per) {
        const padded = after instanceof Float32Array ? new Float32Array((r1 - r) * per) : new Uint8Array((r1 - r) * per);
        padded.set(src);
        src = padded;
      }
      if (channels === 2) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RG, gl.FLOAT, src);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RGBA, gl.UNSIGNED_BYTE, src);
      r = r1;
    }
  }

  setHighlight(h: Uint8Array | null) {
    this.highlightVersion++;
    this.hasHighlight = !!h;
    if (h) this.upload(this.tex.highlight, h, this.mesh?.n ?? 0, 4);
  }

  // 地图单位 → 裁剪空间
  private viewUniform(): [number, number, number, number] {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = w / this.canvas.clientWidth || 1;
    const z = this.camera.zoom * dpr;
    const sx = (2 * z) / w;
    const sy = (-2 * z) / h;
    return [sx, sy, -this.camera.x * sx, -this.camera.y * sy];
  }

  private ensureFbo() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.fboSize[0] === w && this.fboSize[1] === h) return;
    this.fboSize = [w, h];
    gl.bindTexture(gl.TEXTURE_2D, this.sceneColor);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneHeight);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.idTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.sceneHeight, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboId);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.idTex, 0);
    // 切线层：段号与哪一边（RGBA8），深度 = 到段的距离 / 带宽
    gl.bindTexture(gl.TEXTURE_2D, this.seamTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.seamDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSeam);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.seamTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.seamDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(kmPerUnit: number) {
    const gl = this.gl;
    const mesh = this.mesh;
    if (!mesh || !this.triVao || !this.fanVao) return;
    this.resize();
    this.ensureFbo();
    const view = this.viewUniform();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cam = this.camera;
    const dpr = w / this.canvas.clientWidth || 1;
    // 放大后晕渲不必夸张那么多：一格 8 像素以内照旧，越放大越缓（一格 64 像素时约一半）
    const cellCss = mesh.spacing * cam.zoom;
    const relief = this.relief / (1 + 0.4 * Math.max(0, Math.log2(cellCss / 8)));
    // 幽灵海岸带着将来的海岸细节幅度（拖海岸曲折时）
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    const sceneKey = `${this.layersVersion}|${w}x${h}|${cam.x}|${cam.y}|${cam.zoom}|${this.detail}|${coastAmp}|${kmPerUnit}`;
    // 整个星球：屏幕上看得见的那几份副本（x 平移 2 的倍数）
    let copy0 = 0;
    let copies = 1;
    if (this.planet) {
      const halfW = this.canvas.clientWidth / 2 / cam.zoom;
      copy0 = Math.ceil((cam.x - halfW - this.xRange[1]) / 2);
      const copy1 = Math.floor((cam.x + halfW - this.xRange[0]) / 2);
      copies = Math.max(1, Math.min(7, copy1 - copy0 + 1));
    }
    const pp = this.planet ? this.planetProgs : null;
    const noiseK = 1 / (Math.PI * mesh.spacing);
    // 切线层：镜头、窗口、切线变了才重画
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const seamKey = hasSeams ? `${w}x${h}|${cam.x}|${cam.y}|${cam.zoom}|${this.seamVersion}` : '';
    const composeKey = `${sceneKey}|${seamKey}|${this.highlightVersion}|${this.groupVersion}|${this.fxVersion}|${this.style}|${relief}|${this.flatByGroup}|${this.highlightByGroup}|${this.provinceScale}`;
    // 画面没有任何变化：画布保留着上一帧（preserveDrawingBuffer），什么都不用画
    if (composeKey === this.composeKey) return;
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, w, h);

    if (sceneKey !== this.sceneKey) {
      this.sceneKey = sceneKey;
      // 1. 编号层
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboId);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      const pid = pp ? pp.id : this.progId;
      gl.useProgram(pid);
      gl.uniform4fv(gl.getUniformLocation(pid, 'uView'), view);
      // 顶点着色器与地形层共用，会读这些纹理：显式绑好，否则采样器默认的 0 号单元
      // 可能正绑着刚分配的编号纹理（写入目标），形成反馈环，整帧画不出来
      this.bindTex(pid, 'uColor', this.tex.color, 0);
      this.bindTex(pid, 'uElev', this.tex.elev, 1);
      this.bindTex(pid, 'uCoast', this.tex.coast, 2);
      this.bindTex(pid, 'uGrad', this.tex.grad, 3);
      this.bindTex(pid, 'uOther', this.tex.other, 4);
      gl.bindVertexArray(this.fanVao);
      if (pp) {
        gl.uniform1i(gl.getUniformLocation(pid, 'uCopy0'), copy0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, this.fanCount, copies);
      } else gl.drawArrays(gl.TRIANGLES, 0, this.fanCount);

      // 2. 地形层
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.clearBufferfv(gl.COLOR, 0, [0.08, 0.1, 0.14, 0]);
      gl.clearBufferfv(gl.COLOR, 1, [-4000, -1, 0, 0]);
      const pt = pp ? pp.terrain : this.progTerrain;
      gl.useProgram(pt);
      gl.uniform4fv(gl.getUniformLocation(pt, 'uView'), view);
      gl.uniform1f(gl.getUniformLocation(pt, 'uSpacing'), mesh.spacing);
      gl.uniform1f(gl.getUniformLocation(pt, 'uCoastAmp'), coastAmp);
      gl.uniform1f(gl.getUniformLocation(pt, 'uDetail'), this.detail);
      gl.uniform1f(gl.getUniformLocation(pt, 'uPixel'), 1 / (cam.zoom * dpr));
      gl.uniform1f(gl.getUniformLocation(pt, 'uMetersPerUnit'), kmPerUnit * 1000);
      this.bindTex(pt, 'uColor', this.tex.color, 0);
      this.bindTex(pt, 'uElev', this.tex.elev, 1);
      this.bindTex(pt, 'uCoast', this.tex.coast, 2);
      this.bindTex(pt, 'uGrad', this.tex.grad, 3);
      this.bindTex(pt, 'uOther', this.tex.other, 4);
      gl.bindVertexArray(this.triVao);
      if (pp) {
        gl.uniform1i(gl.getUniformLocation(pt, 'uCopy0'), copy0);
        gl.uniform1f(gl.getUniformLocation(pt, 'uNoiseK'), noiseK);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, this.triCount, copies);
      } else gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    }

    // 3. 切线层：每段画一个长方形，片元算到段的距离与在哪一边，近的胜（深度测试 LESS，同样近时先画的段号小的胜）
    if (hasSeams && seamKey !== this.seamKey) {
      this.seamKey = seamKey;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSeam);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      gl.clearBufferfv(gl.DEPTH, 0, [1]);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      const ps = this.progSeam;
      gl.useProgram(ps);
      gl.uniform4fv(gl.getUniformLocation(ps, 'uView'), view);
      gl.uniform1f(gl.getUniformLocation(ps, 'uBand'), this.seamBand);
      gl.bindVertexArray(this.seamVao);
      // 整个星球：线（经度展开后可能超出 [0, 2)）在屏幕上看得见的那几份
      let k0 = 0;
      let k1 = 0;
      if (this.planet) {
        const halfW = this.canvas.clientWidth / 2 / cam.zoom;
        k0 = Math.ceil((cam.x - halfW - this.seamX[1] - this.seamBand) / 2);
        k1 = Math.min(k0 + 6, Math.floor((cam.x + halfW - this.seamX[0] + this.seamBand) / 2));
      }
      for (let k = k0; k <= k1; k++) {
        gl.uniform1f(gl.getUniformLocation(ps, 'uShift'), 2 * k);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.seamCount);
      }
      gl.disable(gl.DEPTH_TEST);
    }

    // 4. 合成
    this.composeKey = composeKey;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const pc = pp ? pp.compose : this.progCompose;
    gl.useProgram(pc);
    if (pp) gl.uniform1f(gl.getUniformLocation(pc, 'uNoiseK'), noiseK);
    this.bindTex(pc, 'uSceneColor', this.sceneColor, 0);
    this.bindTex(pc, 'uSceneHeight', this.sceneHeight, 1);
    this.bindTex(pc, 'uIdTex', this.idTex, 2);
    this.bindTex(pc, 'uFlat', this.tex.flat, 3);
    this.bindTex(pc, 'uHighlight', this.tex.highlight, 4);
    this.bindTex(pc, 'uGroup', this.tex.group, 5);
    this.bindTex(pc, 'uSeam', this.seamTex, 6);
    this.bindTex(pc, 'uSegData', this.tex.segData, 7);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasSeams'), hasSeams ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uFlatByGroup'), this.flatByGroup ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHighlightByGroup'), this.highlightByGroup ? 1 : 0);
    gl.uniform2f(gl.getUniformLocation(pc, 'uTexel'), 1 / w, 1 / h);
    gl.uniform4fv(gl.getUniformLocation(pc, 'uView'), view);
    gl.uniform1f(gl.getUniformLocation(pc, 'uSpacing'), mesh.spacing);
    gl.uniform1f(gl.getUniformLocation(pc, 'uRelief'), relief);
    gl.uniform1f(gl.getUniformLocation(pc, 'uCellPx'), mesh.spacing * cam.zoom * dpr);
    gl.uniform1f(gl.getUniformLocation(pc, 'uProvScale'), this.provinceScale);
    gl.uniform1f(gl.getUniformLocation(pc, 'uShade'), this.shade);
    gl.uniform1f(gl.getUniformLocation(pc, 'uRock'), this.rock);
    gl.uniform1i(gl.getUniformLocation(pc, 'uStyle'), this.style === 'atlas' ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasFlat'), this.hasFlat ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasGroup'), this.hasGroup ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasHighlight'), this.hasHighlight ? 1 : 0);
    const hasFx = !!(this.fxShown.fx && this.fxShown.palette);
    this.bindTex(pc, 'uFx', this.tex.fx, 8);
    this.bindTex(pc, 'uFxPal', this.tex.fxPal, 9);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasFx'), hasFx ? 1 : 0);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(prog: WebGLProgram, name: string, tex: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  }

  // 屏幕坐标（CSS 像素，相对画布）→ 地图单位
  screenToWorld(px: number, py: number): [number, number] {
    const c = this.camera;
    return [c.x + (px - this.canvas.clientWidth / 2) / c.zoom, c.y + (py - this.canvas.clientHeight / 2) / c.zoom];
  }

  worldToScreen(x: number, y: number): [number, number] {
    const c = this.camera;
    return [(x - c.x) * c.zoom + this.canvas.clientWidth / 2, (y - c.y) * c.zoom + this.canvas.clientHeight / 2];
  }

  // 整张图放进画布；inset：四周被浮层挡住、要留出来的边（CSS 像素）
  fit(mesh: Mesh, inset = { top: 0, right: 0, bottom: 0, left: 0 }) {
    const cw = Math.max(100, (this.canvas.clientWidth || 800) - inset.left - inset.right);
    const ch = Math.max(100, (this.canvas.clientHeight || 600) - inset.top - inset.bottom);
    const zoom = Math.min(cw / mesh.width, ch / mesh.height) * 0.98;
    this.camera = {
      x: mesh.width / 2 - (inset.left - inset.right) / 2 / zoom,
      y: mesh.height / 2 - (inset.top - inset.bottom) / 2 / zoom,
      zoom,
    };
  }
}
