import type { Mesh } from '../../core/mesh';
import { viewOf } from '../../core/sphere';

// WebGL2 渲染：
//   1. 编号层：Voronoi 多边形写入每个像素属于哪一格
//   2. 地形层：Delaunay 三角形（不共享顶点，带重心坐标）。颜色、高程、海岸值、坡度在三角形内插值；
//      格以下补海岸细节与沿坡向的冲沟纹理（噪声在格中心为 0，陆海与模拟一致）→ 离屏的颜色、高度、坡度。
//      陆地像素只用陆色、水面像素只用水色（每格另带一份“对岸的颜色”），颜色不跨海岸互相渗；
//      晕渲的大尺度坡度用插值后的格坡度，没有三角形折面；海岸线在这里画成抗锯齿的细线
//   3. 合成：晕渲、陡坡露岩、两种风格；按扭曲后的坐标取格，画分类平涂（主导生态、省份）、
//      分组边界（省份）、高亮与轮廓。边界因此是自然的曲线而不是六边形
// 1、2 只在镜头、图层、窗口大小变了时重画；鼠标移动、高亮变化只重画合成层。
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

const FS_COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSceneColor;
uniform highp sampler2D uSceneHeight;
uniform sampler2D uIdTex;
uniform sampler2D uFlat;
uniform sampler2D uHighlight;
uniform highp sampler2D uGroup;
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
// 高亮的不透明度（解码见 colors.ts 的 highlightColors）
float hlAlpha(int id) {
  if (id < 0) return 0.0;
  float A = cellTex(uHighlight, id).a * 255.0;
  return (A > 127.5 ? A - 128.0 : A) / 127.0;
}
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

  if (uHasFlat == 1 && id >= 0) {
    vec4 fc = cellTex(uFlat, id);
    col = mix(col, fc.rgb, fc.a);
  }
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

  // 海岸线：地形层画好的抗锯齿细线
  col = mix(col, uStyle == 1 ? vec3(0.35, 0.27, 0.2) : vec3(0.18, 0.22, 0.24), base.a * (uStyle == 1 ? 0.8 : 0.4));

  // 分组边界（省份）：扭曲坐标下相邻像素的分组不同
  if (uHasGroup == 1 && id >= 0) {
    float g0 = groupOf(id);
    float gx = groupOf(idAt(uvW + vec2(uTexel.x * 1.5, 0.0)));
    float gy = groupOf(idAt(uvW + vec2(0.0, uTexel.y * 1.5)));
    // 陆海之间的边界已经由海岸线画出，这里只画同类之间的
    bool bx = gx > -1e8 && gx != g0 && (gx > 0.0) == (g0 > 0.0);
    bool by = gy > -1e8 && gy != g0 && (gy > 0.0) == (g0 > 0.0);
    // 缩小到省份只有几像素宽时淡出，否则全图视角下边界会密成一张网
    float fade = smoothstep(2.5, 7.0, uCellPx);
    if (bx || by) col = mix(col, uStyle == 1 ? vec3(0.45, 0.2, 0.15) : vec3(0.12, 0.1, 0.08), (g0 > 0.0 ? 0.55 : 0.15) * fade);
  }

  // 高亮与轮廓
  if (uHasHighlight == 1 && id >= 0) {
    vec4 hc = cellTex(uHighlight, id);
    bool hatch = hc.a * 255.0 > 127.5;
    float a0 = hlAlpha(id);
    if (hatch) {
      // 斜线：按屏幕像素画，缩放时线宽不变
      float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
      col = mix(col, hc.rgb, a0 * stripe);
    } else {
      col = mix(col, hc.rgb, a0);
    }
    float ax = hlAlpha(idAt(uvW + vec2(uTexel.x * 1.5, 0.0)));
    float ay = hlAlpha(idAt(uvW + vec2(0.0, uTexel.y * 1.5)));
    if ((a0 > 0.05) != (ax > 0.05) || (a0 > 0.05) != (ay > 0.05)) col = mix(col, vec3(1.0), 0.9);
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

// 合成：按扭曲后的坐标取格。扭曲的噪声在球面上取（每份副本一样），两极以外是背景
const FS_COMPOSE_PLANET = must(
  must(FS_COMPOSE, 'int idAt(vec2 uv) {', `uniform float uNoiseK;
${SPHERE_GLSL}
int idAt(vec2 uv) {`),
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
  shade: number;
  rock: number;
  coastAmp: number;
}

export type MapStyle = 'realistic' | 'atlas';

export class Renderer {
  private gl: WebGL2RenderingContext;
  private progId: WebGLProgram;
  private progTerrain: WebGLProgram;
  private progCompose: WebGLProgram;
  // 整个星球用的三个程序（第一次遇到星球时才编译）
  private planetProgs: { id: WebGLProgram; terrain: WebGLProgram; compose: WebGLProgram } | null = null;
  private planet = false;
  // 星球几何在 x 方向上的范围（含接缝外的一点），用来算要画哪几份副本
  private xRange: [number, number] = [0, 2];
  private triVao: WebGLVertexArrayObject | null = null;
  private triCount = 0;
  private fanVao: WebGLVertexArrayObject | null = null;
  private fanCount = 0;
  private tex: Record<'color' | 'other' | 'elev' | 'coast' | 'grad' | 'flat' | 'highlight' | 'group', WebGLTexture>;
  private fbo: WebGLFramebuffer;
  private fboId: WebGLFramebuffer;
  private sceneColor: WebGLTexture;
  private sceneHeight: WebGLTexture;
  private idTex: WebGLTexture;
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
  camera: Camera = { x: 1, y: 0.5, zoom: 500 };
  // 晕渲的夸张倍数（全图时）：真实的山坡很缓，不夸张就看不出起伏
  relief = 24;
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

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('浏览器不支持浮点渲染目标（EXT_color_buffer_float）');
    this.gl = gl;
    this.progId = compile(gl, VS_CELL, FS_ID);
    this.progTerrain = compile(gl, VS_CELL, FS_TERRAIN);
    this.progCompose = compile(gl, VS_QUAD, FS_COMPOSE);
    const t = () => this.makeTex();
    this.tex = { color: t(), other: t(), elev: t(), coast: t(), grad: t(), flat: t(), highlight: t(), group: t() };
    this.fbo = gl.createFramebuffer()!;
    this.fboId = gl.createFramebuffer()!;
    this.sceneColor = this.makeTex(true);
    this.sceneHeight = this.makeTex();
    this.idTex = this.makeTex();
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
        compose: compile(gl, VS_QUAD, FS_COMPOSE_PLANET),
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
    this.shade = l.shade;
    this.rock = l.rock;
    this.coastAmp = l.coastAmp;
  }

  // 省份预览：整份分组（与平涂）换成将来的样子，着色器照此画出真实的新省界；null 回到 setLayers 给的。
  // 没有画分组边界时不管。setLayers 之后预览就没了，调用方要重新给
  setGroupPreview(p: { group: Float32Array; flat: Uint8Array | null } | null) {
    if (!this.groupBase || !this.groupShown) return;
    const group = p ? p.group : this.groupBase;
    const flat = p && p.flat && this.flatBase ? p.flat : this.flatBase;
    if (group === this.groupShown && flat === this.flatShown) return;
    this.uploadChanged(this.tex.group, this.groupShown, group, 2);
    this.groupShown = group;
    if (flat && this.flatShown && flat !== this.flatShown) {
      this.uploadChanged(this.tex.flat, this.flatShown, flat, 4);
      this.flatShown = flat;
    }
    this.groupVersion++;
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
    const sceneKey = `${this.layersVersion}|${w}x${h}|${cam.x}|${cam.y}|${cam.zoom}|${this.detail}|${this.coastAmp}|${kmPerUnit}`;
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
    const composeKey = `${sceneKey}|${this.highlightVersion}|${this.groupVersion}|${this.style}|${relief}`;
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
      gl.uniform1f(gl.getUniformLocation(pt, 'uCoastAmp'), this.coastAmp);
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

    // 3. 合成
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
    gl.uniform2f(gl.getUniformLocation(pc, 'uTexel'), 1 / w, 1 / h);
    gl.uniform4fv(gl.getUniformLocation(pc, 'uView'), view);
    gl.uniform1f(gl.getUniformLocation(pc, 'uSpacing'), mesh.spacing);
    gl.uniform1f(gl.getUniformLocation(pc, 'uRelief'), relief);
    gl.uniform1f(gl.getUniformLocation(pc, 'uCellPx'), mesh.spacing * cam.zoom * dpr);
    gl.uniform1f(gl.getUniformLocation(pc, 'uShade'), this.shade);
    gl.uniform1f(gl.getUniformLocation(pc, 'uRock'), this.rock);
    gl.uniform1i(gl.getUniformLocation(pc, 'uStyle'), this.style === 'atlas' ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasFlat'), this.hasFlat ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasGroup'), this.hasGroup ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(pc, 'uHasHighlight'), this.hasHighlight ? 1 : 0);
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
