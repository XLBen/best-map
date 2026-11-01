import { FJORD_GLSL, FRAG_GLSL, FRAG_N2, glsl, LITH_LAND_GLSL, LITH_SEA_GLSL, NOISE_GLSL, SEA_RELIEF, SPECK_MARK, STYLE_GLSL, STYLE_N2, STYLE_SEA_GLSL, styleMain, TEX_W } from './common';
import { LOOK } from '../../../core/coast-style';

// 平面地图的顶点、编号、地形、切线着色器与省份规则、描格（第四十一轮从 renderer.ts 原样搬来）

export const VS_CELL = `#version 300 es
in vec2 aPos;
in float aCell;
in vec3 aBary;
uniform vec4 uView;
uniform sampler2D uColor;
uniform sampler2D uOther;
uniform highp sampler2D uElev;
uniform highp sampler2D uCoast;
uniform highp sampler2D uGrad;
uniform highp sampler2D uSeaGrad;
uniform sampler2D uLith;
out vec4 vLandCol;
out vec4 vLith;
out vec4 vSeaCol;
out float vElev;
out float vSeaElev;
out float vCoast;
// 破碎度（第十八轮，海岸值纹理的 g）
out float vFrag;
// 海岸类型与小湖群（第三十四轮，海岸值纹理的 b、a）：小湖群、沙坝、岛礁（第三十六轮）、|海岸值| 打包成一个插值量
// （少几个插值的槽：缩小看时三角形多，每多一个槽地形层就慢一截）；峡湾的表号（第三十六轮）不插值，取最后一个顶点的
out vec4 vStyle;
flat out int vFjRank;
float vSpeck;
float vBar;
float vSkerry;
float vCoastAbs;
out vec2 vGrad;
out vec2 vSeaGrad;
out vec2 vWorld;
out vec3 vBary;
flat out int vCell;
void main() {
  int c = int(aCell + 0.5);
  ivec2 t = ivec2(c % ${TEX_W}, c / ${TEX_W});
  vec4 col = texelFetch(uColor, t, 0);
  vec4 other = texelFetch(uOther, t, 0);
  vec4 cf = texelFetch(uCoast, t, 0);
  vCoast = cf.r;
  vFrag = cf.g;
  // b：有峡湾表的格 1 + 256 × 表号 + 小湖群 × 255，别的格负的小湖群（× 255）；a：沙坝（> 0）或负的岛礁权重。见 core/coast-style.ts 的 decodeStyleB
  if (cf.b > 0.5) {
    float q = cf.b - 1.0;
    float rk = floor(q / 256.0);
    vSpeck = (q - 256.0 * rk) / 255.0;
    vFjRank = int(rk + 0.5);
  } else {
    vSpeck = -cf.b / 255.0;
    vFjRank = -1;
  }
  vBar = max(cf.a, 0.0);
  vSkerry = max(-cf.a, 0.0);
  vCoastAbs = abs(cf.r);
  vStyle = vec4(vSpeck, vBar, vSkerry, vCoastAbs);
  // 陆地格：陆色是自己、水色是对岸的；水面格反过来。像素再按陆海选一个，颜色不跨海岸互相渗
  bool isLand = vCoast > 0.0;
  vLandCol = isLand ? col : other;
  vSeaCol = isLand ? other : col;
  vec2 el = texelFetch(uElev, t, 0).rg;
  vElev = el.r;
  vSeaElev = el.g;
  vGrad = texelFetch(uGrad, t, 0).rg;
  vSeaGrad = texelFetch(uSeaGrad, t, 0).rg;
  vLith = texelFetch(uLith, t, 0);
  vWorld = aPos;
  vBary = aBary;
  vCell = c;
  gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);
}`;

// 编号层的顶点：只要位置和格号（不读纹理；位置的算式与 VS_CELL 逐位相同）
export const VS_ID = `#version 300 es
in vec2 aPos;
in float aCell;
uniform vec4 uView;
flat out int vCell;
void main() {
  vCell = int(aCell + 0.5);
  gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0);
}`;

export const FS_ID = `#version 300 es
precision highp float;
flat in int vCell;
layout(location = 0) out vec4 oId;
void main() {
  int id = vCell + 1;
  oId = vec4(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255), 255.0) / 255.0;
}`;

export const FS_TERRAIN = `#version 300 es
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
// 一个设备像素合多少地图单位；一个地图单位合多少米
uniform float uPixel;
uniform float uMetersPerUnit;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oHeight;
${NOISE_GLSL}
${FRAG_GLSL}
${STYLE_GLSL}
${FJORD_GLSL}
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
  vSpeck = vStyle.x; vBar = vStyle.y; vSkerry = vStyle.z; vCoastAbs = vStyle.w;
  float h = vElev;
  // 格以下的海岸：重心权重在格中心为 0，格的陆海与模拟一致（与导出逐位一致，不淡出）
  float wmax = max(vBary.x, max(vBary.y, vBary.z));
  float weight = clamp((1.0 - wmax) * 2.2, 0.0, 1.0);
  float rugged = clamp(max(h, 0.0) / 1200.0, 0.0, 1.0);
  float amp = uCoastAmp * (0.55 + 0.9 * rugged);
  float nd = fbmSub(vWorld / uSpacing * 2.1, 4);
  float det = weight * amp * (barrierDetail(vBar) * (1.0 + ${glsl(LOOK.SK_ROUGH)} * min(1.0, ${glsl(LOOK.SK_ROUGH_K)} * vSkerry))) * nd;
  float s = vCoast + det;
  if (vFrag > 0.0) s = fragCoast(vCoast, det, vFrag, weight, ${FRAG_N2});
${styleMain(STYLE_N2)}  bool land = s > 0.0;
  float cellPx = uSpacing / uPixel;
  float gm = length(vGrad);
  float relief = gm * uSpacing;
  vec2 dir = gm > 1e-3 ? vGrad / gm : vec2(1.0, 0.0);
  // 海岸线：陆海交界处约 1.2 像素宽、抗锯齿
  float coastLine = 1.0 - smoothstep(0.6, 1.8, abs(s) / max(fwidth(s), 1e-6));
  // 离海岸几个像素（陆上为正）：珊瑚岛的白浪
  float sPx = s / max(fwidth(s), 1e-6);
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
    col = clamp(mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat), 0.0, 1.0);
    hh = max(h + landDetail, 2.0);
    // 碎岛：几米到三十来米高，边上一圈沙滩
    if (vFrag > 0.0) hh = max(hh, fragIsleHeight(s));
    // 坡度（地图坐标，米 / 米）：大尺度用插值后的格坡度（光滑），加上细节的差分
    slope = vGrad / uMetersPerUnit + dDetail;
    // 低平海岸有沙滩
    float beach = (1.0 - smoothstep(4.0, 22.0, hh)) * (1.0 - smoothstep(0.0, 120.0, relief)) * (0.35 + 0.65 * vLandCol.a);
    col = mix(col, vec3(0.86, 0.80, 0.62), beach * 0.75);
    // 地表纹理的轻微明暗变化
    col *= 1.0 + 0.05 * fbmFade(vWorld / uSpacing * 3.3 - 2.0, 3, cellPx / 3.3);
    ${LITH_LAND_GLSL}
  } else {
    float seaDetail = uDetail * fbmFade(vWorld / uSpacing * 1.3, 3, cellPx / 1.3) * 25.0;
    float subN = fbmSub(vWorld / uSpacing * 1.7 + 11.0, 3);
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
    // 浅水：暖海偏青绿（alpha = 海水暖度），冷海偏灰绿
    float depth = -hh;
    vec3 shallow = mix(vec3(0.30, 0.50, 0.56), vec3(0.24, 0.62, 0.66), seaC.a);
    col = mix(col, shallow, (1.0 - smoothstep(4.0, 70.0, depth)) * (uSeaData == 1 ? 0.0 : 0.7));
    ${LITH_SEA_GLSL}
    ${STYLE_SEA_GLSL}
    // 海底的坡：按水深的坡度（每格一份，在三角形内插值），比陆上缓得多（合成里只轻轻晕渲）
    slope = vSeaGrad / uMetersPerUnit * ${glsl(SEA_RELIEF)};
  }
  oColor = vec4(col, coastLine);
  // 小湖群的水面（第三十四轮）：海岸场写成 SPECK_MARK（合成里认出来，不进省份、不再找附近的水面格）
  oHeight = vec4(hh, lakeDot > 0.0 && s <= 0.0 ? ${glsl(SPECK_MARK)} : s, slope);
}`;

export const VS_QUAD = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 切线层：每段一个盖住带宽的长方形（实例 = 段，四个角 aCorner 画两个三角形），uShift 是整个星球上的副本平移。
// 距离、在线的哪一边与 core/seams.ts 的 segDist 一步一步相同
export const VS_SEAM = `#version 300 es
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

export const FS_SEAM = `#version 300 es
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

// 省份按哪一格（provCell）与描格的格（focusCell，第三十七轮）是同一条规则，只差取到的格按不按剪刀切线换（pick）
export const provRule = (name: string, pick: (c: string) => string) => `int ${name}(int idG, vec2 uv, bool landPx) {
  if (idG < 0 || waterCell(idG) != landPx) return idG;
  // 碎岛（破碎的水面格里画成陆地的像素）归那一格：海省（湖里的归湖），第十八轮
  if (landPx && fragCell(idG)) return idG;
  int c = ${pick('idAt(uv)')};
  if (c >= 0 && waterCell(c) != landPx) return c;
  for (int ring = 1; ring <= 2; ring++) {
    vec2 r = ((landPx ? 0.3 : 0.6) * float(ring) * uCellPx) * uTexel;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.7853982;
      c = ${pick('idAt(uv + vec2(cos(a), sin(a)) * r)')};
      if (c >= 0 && waterCell(c) != landPx) return c;
    }
  }
  return landPx ? landCellOf(idG) : -1;
}`;
export const PROV_CELL = provRule('provCell', (c) => `seamCell(${c}, uv)`);
// 描格的格（第三十七轮；core/display.ts 的 DisplayCell.focus 是同一条规则）：省份的规则不按剪刀切线换格（focusCell），
// 小湖群的像素（地形层写成 SPECK_MARK）算它扭曲后那一格的陆地。返回 格号 · 2 + 陆 1 / 水 0（与 uFocus 比），没有格时 −1。
// 陆海按这一点自己的场景像素（描边看的相邻像素各按各的）
export const FOCUS_GLSL = `${provRule('focusCell', (c) => c)}
int focusAt(vec2 uv, vec2 uvW) {
  float g = texture(uSceneHeight, uv * uSceneXf.xy + uSceneXf.zw).g;
  int id = idAt(uvW);
  if (id < 0) return -1;
  if (g < ${glsl(SPECK_MARK / 2)}) return id * 2 + 1;
  bool landPx = g > 0.0;
  int c = focusCell(id, uv, landPx);
  return c < 0 ? -1 : c * 2 + (landPx ? 1 : 0);
}
// 这一点离描格的格心够不够近（c：格心与半径，地图单位）：远处的像素不必算 focusAt。
// 整个星球（uFocusSphere = 1）按球面上的弦长量（地图单位的 1 合 π 弧度；东西绕回、两极的格都对）
vec3 focusSphere(vec2 w) {
  float lon = 3.14159265 * (w.x - 1.0);
  float colat = 3.14159265 * clamp(w.y, 0.0, 1.0);
  return vec3(sin(colat) * cos(lon), sin(colat) * sin(lon), cos(colat));
}
bool nearFocus(vec2 p, vec3 c) {
  if (uFocusSphere > 0.5) return length(focusSphere(p) - focusSphere(c.xy)) < 3.14159265 * c.z;
  vec2 d = p - c.xy;
  return dot(d, d) < c.z * c.z;
}
`;
