import { COUNTRY_ALPHA, FEDERATION_GROUP, ISLET_FLAT, SEA_CLAIM_ALPHA } from '../colors';
import { NEAR_MAX } from '../near';
import { FX_BEGIN, FX_END, glsl, NOISE_GLSL, PATTERN_GLSL, SPECK_MARK, TEX_W } from './common';
import { FOCUS_GLSL, PROV_CELL } from './plane';

// 合成着色器（平面；星球、投影由 sphere.ts 按它替换出来）（第四十一轮从 renderer.ts 原样搬来）

export const FS_COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSceneColor;
uniform highp sampler2D uSceneHeight;
uniform sampler2D uIdTex;
uniform sampler2D uFlat;
uniform sampler2D uHighlight;
uniform highp sampler2D uGroup;
// 国界的分组（第二十三轮，colors.ts 的 countryBorderGroups）：陆地是国家的编号（无主 0），领海是编号 + 65536，不归谁的海 −1；
// g 是集团的分组（第二十六轮）：帝国的编号、联邦的编号 + FEDERATION_GROUP，别的陆地 0，海 −1
uniform highp sampler2D uCountry;
uniform int uHasCountry;
// 切线层（屏幕大小）与每段的数据（两边的分组值、代表格：gL, gR, repL, repR）
uniform sampler2D uSeam;
uniform highp sampler2D uSegData;
uniform int uHasSeams;
// 平涂、高亮按省份取（省份着色、省份工具）：切线附近也跟着换格
uniform int uFlatByGroup;
uniform int uHighlightByGroup;
uniform vec2 uTexel;
// 场景（地形层、编号层、切线层）上的位置 = 画面上的位置 × xy + zw。停稳时是 (1, 1, 0, 0)；
// 移动中场景是按稍早的镜头、带边距、低分辨率画的那一份（见 Renderer.renderMoving）
uniform vec4 uSceneXf;
// 画面一个像素合几个屏幕像素（停稳 1，移动中按低分辨率画时 > 1）：斜线照屏幕像素的宽度画，省界、轮廓按它淡一些
uniform float uPxScale;
// 场景的一个像素合几个屏幕像素（停稳 1；移动中场景按低分辨率画、放大挪用时更大）：海岸线在场景上画成约 1.2 个像素宽，
// 合到屏幕上变宽了多少倍就淡多少倍，移动中海岸线不会变深
uniform float uScenePx;
uniform vec4 uView;
uniform float uSpacing;
uniform float uRelief;
uniform float uShade;
uniform float uRock;
// 画风（第三十八轮，core/map-style.ts；值见 styleUniforms）：陆地的底色（a 是比例，0 不混）；山影着色（1）时暗处、亮处各乘一种颜色
uniform vec4 uLandTint;
uniform int uShadeTint;
uniform vec3 uShadeDark;
uniform vec3 uShadeLight;
// 海：按水深分层（1）时四层的颜色、第二到四层从多深起（m）、等深线（a 是浓淡）；海的明暗、分层的海的明暗（x + y · 明暗）
uniform int uSeaTiers;
uniform vec3 uSeaTier[4];
uniform vec3 uSeaDepth;
uniform vec4 uIsobath;
uniform vec2 uSeaShade;
uniform vec2 uTierShade;
// 生态发光的强弱
uniform float uGlowGain;
// 海岸线（a 是浓淡）、省界、国界的颜色
uniform vec4 uCoastLine;
uniform vec3 uProvLine;
uniform vec3 uCountryLine;
// 海面也是数据（海水温度底图）：分层的画风也不把海涂平
uniform int uSeaData;
uniform int uHasFlat;
uniform int uHasGroup;
uniform int uHasHighlight;
uniform float uCellPx;
// 每个省大约几格宽（√ 省份格数的中位数）：省界按省的大小淡出
uniform float uProvScale;
// 省界的浓淡（第二十三轮：人文图里省界淡一些，国界显眼）
uniform float uProvAlpha;
// 国界的浓淡（第二十五轮：文化等地图模式里 < 1，只画近处一圈）
uniform float uCountryAlpha;
// 生态的花纹与发光（每格的字节与调色板，见 colors.ts 的 fxLayers）
uniform sampler2D uFx;
uniform highp sampler2D uFxPal;
uniform int uHasFx;
// 湖泊类型（第九轮）：每格的颜色与画法（见 colors.ts 的 lakeTintLayer）
uniform sampler2D uTint;
uniform int uHasTint;
// 每格画面上的海岸值（湖面 < 0）：省份按格取时水面的像素只取水面格（见 provCell）
uniform highp sampler2D uCellCoast;
// 河（第十三轮）：叠加层画好的河（预乘 alpha），只合在画成陆地的像素上；uRiverXf：画面上的位置 → 河的那张图上的位置
uniform sampler2D uRiver;
uniform int uHasRiver;
uniform vec4 uRiverXf;
// 画成陆地的像素落在水面格里、附近又找不到陆地格时归哪一格的省（colors.ts 的 landCellLayer，格号 + 1 写在 rgb）
uniform sampler2D uLandCell;
uniform int uHasLandCell;
// 描格（第三十七轮，renderer.setFocus）：鼠标下的格与钉住的格（格号 · 2 + 陆 1 / 水 0，−1 不描），各自的格心与半径（地图单位）；
// uFocusSphere：整个星球 1（按球面量远近），一块地区 0
uniform ivec2 uFocus;
uniform vec3 uFocusC[2];
uniform float uFocusSphere;
// 离边界远的格（第三十九轮，near.ts 的 nearLayer）：每格 r、g、b 是省份、国家、集团往外几步之内没有会与它连成线的格（低四位数全部的格，高四位只数水面格）；
// uNearRho[h]：隔 h 步的格离得最近有多远（地图单位）；uNearOn 为 0 时不跳过（省份预览、幽灵海岸、极地的场景、ρ 还没算好）
uniform sampler2D uNear;
uniform int uNearOn;
uniform float uNearRho[${NEAR_MAX + 1}];
out vec4 oColor;
${NOISE_GLSL}
// 场景上的位置夹在场景之内（停稳时与画面相同；移动中、导出的一块块场景四周多画了一圈，扭曲后伸出画面的取到那一圈）
int idAt(vec2 uv) {
  vec4 c = texture(uIdTex, clamp(uv * uSceneXf.xy + uSceneXf.zw, vec2(0.0), vec2(1.0))) * 255.0;
  return int(c.r + 0.5) + int(c.g + 0.5) * 256 + int(c.b + 0.5) * 65536 - 1;
}
vec4 cellTex(sampler2D tex, int id) {
  return texelFetch(tex, ivec2(id % ${TEX_W}, id / ${TEX_W}), 0);
}
// 分组值：陆地省份 = 编号 + 1（> 0），海域省份 = −(编号 + 1)（< 0），未划分 = 0，地图外 = −1e9
float groupOf(int id) { return id < 0 ? -1e9 : cellTex(uGroup, id).r; }
float countryOf(int id) { return id < 0 ? -1e9 : cellTex(uCountry, id).r; }
vec2 countryPair(int id) { return id < 0 ? vec2(-1e9) : cellTex(uCountry, id).rg; }
// 两边的国家不同、都不是不归谁的海、同是陆地或同是海（陆地与它的领海之间、海岸线上不画）
bool countryEdge(float a, float b) { return a >= 0.0 && b >= 0.0 && a != b && (a >= 65535.5) == (b >= 65535.5); }
// 切线附近按在线的哪一边换格（与 core/seams.ts 的 seamPixel 相同）：id 是像素按扭曲后的位置取的格，
// uv 是像素没扭曲的位置（切线层按它找最近的段）
int seamCell(int id, vec2 uv) {
  if (uHasSeams == 0 || id < 0) return id;
  vec4 s = texture(uSeam, uv * uSceneXf.xy + uSceneXf.zw) * 255.0;
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
bool waterCell(int id) { return cellTex(uCellCoast, id).r < 0.0; }
// 破碎的格（第十八轮，海岸值纹理的 g）
bool fragCell(int id) { return cellTex(uCellCoast, id).g > 0.0; }
// 省份按哪一格（第十三轮；core/display.ts 的 provinceCell 是同一条规则）：idG 是扭曲后按切线换过的格，uv 是像素没扭曲的位置，
// landPx 是这个像素画成陆地。画成水面（海、湖）的像素取到陆地格时不要它（海上的像素永远不属于陆上的省）：依次试没扭曲的
// 最近格、周围 0.6 格与 1.2 格半径上各 8 个点的格（同样按切线换过），取第一个水面格；都不是时 −1（不着色、不画省界）。
// 画成陆地的像素取到水面格时（第十三轮修）：同样依次试没扭曲的最近格、周围 0.3 格与 0.6 格半径上各 8 个点的格，取第一个陆地格；
// 都不是时（第十四轮）取那个水面格离它最近的陆地省的格（landCellOf），破碎的陆地永远归陆地省
int landCellOf(int id) {
  if (uHasLandCell == 0) return id;
  vec4 c = cellTex(uLandCell, id) * 255.0;
  int v = int(c.r + 0.5) + int(c.g + 0.5) * 256 + int(c.b + 0.5) * 65536 - 1;
  return v >= 0 ? v : id;
}
${PROV_CELL}
// 画面上另一点（省界、轮廓看的相邻像素）的省份格：陆海按那一点自己的场景像素
int provAt(vec2 uv, vec2 uvW) {
  float g = texture(uSceneHeight, uv * uSceneXf.xy + uSceneXf.zw).g;
  if (g < ${glsl(SPECK_MARK / 2)}) return -1;
  return provCell(seamCell(idAt(uvW), uv), uv, g > 0.0);
}
${FOCUS_GLSL}// 高亮的 alpha 字节（编码见 colors.ts 的 highlightColors）：0 没有，1–127 平涂，128 只描边，129–255 斜线
float hlByte(int id) { return id < 0 ? 0.0 : cellTex(uHighlight, id).a * 255.0; }
// 平涂、斜线的不透明度；只描边的是 0
float hlAlpha(float A) { return A > 128.5 ? (A - 128.0) / 127.0 : A < 127.5 ? A / 127.0 : 0.0; }
// 离边界远的像素不取环上的点（第三十九轮，near.ts 的保证）：取样离 P（扭曲后的位置）最远多少（地图单位）比隔 h 步的格还近时，
// 取到的格都画不出线。nearPx：画面一个像素合多少地图单位；nearSlack：编号层一个纹素取整最多差多远
float nearPx() { return uSpacing / uCellPx; }
float nearSlack() { return 0.71 * nearPx() * uScenePx / uPxScale; }
// h 的低四位：往外几步之内没有会连成线的格；高四位：只数水面格（画成水面的取样往外 1.2 格找的只有水面格）。
// rA：取样离 P 最远多少（扭曲后的格、landCellOf、画成陆地时往外 0.6 格找的陆地格）；rW：画成水面时往外 1.2 格找的水面格
bool nearSkip(int h, float rA, float rW) {
  int ha = h & 15;
  int hw = h >> 4;
  return ha > 0 && rA < uNearRho[min(ha, ${NEAR_MAX})] && rW < uNearRho[min(hw, ${NEAR_MAX})];
}
${FX_BEGIN}${PATTERN_GLSL}${FX_END}
void main() {
  vec2 sUv = vUv * uSceneXf.xy + uSceneXf.zw;
  // 颜色按像素所在的那个场景像素取（与陆海判定的高度层同一个像素）：移动中场景挪了不到一个像素时，
  // 线性插值会把海色混进海边的陆地像素（海岸发暗）。海岸线的浓淡（alpha）照旧插值，线是平滑的。停稳时两者完全相同
  ivec2 sSize = textureSize(uSceneColor, 0);
  ivec2 sPx = clamp(ivec2(floor(sUv * vec2(sSize))), ivec2(0), sSize - 1);
  vec4 base = vec4(texelFetch(uSceneColor, sPx, 0).rgb, texture(uSceneColor, sUv).a);
  vec4 hs = texture(uSceneHeight, sUv);
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

  // 省界的淡出（缩小到省份只有十几像素宽时、格比一个像素还小时）：先算好，为 0 时不取相邻像素（第三十九轮）
  float provFade = smoothstep(6.0, 16.0, uCellPx * uProvScale) * smoothstep(0.7, 1.4, uCellPx);
  bool provLines = uHasGroup == 1 && provFade * uProvAlpha > 0.0;
  // 省界、省份着色、省份的高亮用切线换过、水面只取水面格的格（provCell）；只在用得上时算（第三十九轮：地貌等模式里不算）
  // 小湖群的水面（第三十四轮，地形层写成 SPECK_MARK）：画成水、格还是陆地，不归哪个省（像碎岛反过来；也省得一圈圈找水面格）
  bool needPc = uFlatByGroup == 1 || provLines || uHasCountry == 1 || (uHasHighlight == 1 && uHighlightByGroup == 1);
  int pc = !needPc || hs.g < ${glsl(SPECK_MARK / 2)} ? -1 : provCell(seamCell(id, vUv), vUv, land);
  // 离边界远的格（第三十九轮）：像素的省份格就是它扭曲后的格时（陆海与格相同、没有切线换格）才看，读这一格往外几步没有会连成线的格；
  // 环上的取样离 P 最远是 nearA（扭曲后的格、往外 0.6 格找的陆地格）、nearW（往外 1.2 格找的水面格）再加环的半径
  ivec3 nearH = uNearOn == 1 && pc >= 0 && pc == id ? ivec3(cellTex(uNear, id).rgb * 255.0 + 0.5) : ivec3(0);
  float nearA = length(w) + 0.6 * uSpacing + 2.0 * nearSlack();
  float nearW = nearA + 0.6 * uSpacing;
  int idF = uFlatByGroup == 1 ? pc : id;
  vec4 fc = vec4(0.0);
  if (uHasFlat == 1 && idF >= 0) {
    fc = cellTex(uFlat, idF);
    // 归了国家的碎岛（第二十六轮，colors.ts 的 ISLET_FLAT）：陆地像素涂满国家色，水面照旧是海或领海
    float fa = fc.a * 255.0;
    if (fa > ${glsl(ISLET_FLAT - 0.5)} && fa < ${glsl(ISLET_FLAT + 1.5)}) fc.a = land ? ${glsl(COUNTRY_ALPHA / 255)} : fa > ${glsl(ISLET_FLAT + 0.5)} ? ${glsl(SEA_CLAIM_ALPHA / 255)} : 0.0;
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
  if (land) {
    // 陆地：混上画风的底色（地图册的羊皮纸）；山影平常（按“晕渲”明暗）或着色（地图册的暖色晕渲：暗处、亮处各乘一种颜色，不看“晕渲”）
    if (uLandTint.a > 0.0) col = mix(col, uLandTint.rgb, uLandTint.a);
    if (uShadeTint == 1) col *= mix(uShadeDark, uShadeLight, clamp(shade - 0.3, 0.0, 1.0));
    else col *= mix(1.0, shade, uShade);
  } else if (uSeaTiers == 0 || uSeaData == 1) {
    // 海底的坡轻轻晕渲（海面是数据——海水温度——时分层的画风也这样画，不涂平）
    col *= mix(1.0, uSeaShade.x + uSeaShade.y * shade, uShade);
  } else {
    // 按水深分层（地图册：0–200、200–1000、1000–3000、3000 m 以下），层与层之间一道淡淡的等深线；海底的坡轻轻晕渲
    float depth = -h;
    // 放大到一格有好几个像素时，按三角形线性插值的水深画出的等深线是折线（第十二轮修）：分层与等深线按约 0.6 格半径的两圈
    // 共 16 点的平均水深画，折角化开成圆滑的曲线；一格不到 3 像素时照旧（看不出折角），3–8 像素之间渐渐换过去
    float smoothK = smoothstep(3.0, 8.0, uCellPx);
    if (smoothK > 0.0) {
      float r = 0.6 * uCellPx;
      float sum = max(depth, 0.0);
      float wsum = 1.0;
      for (int k = 0; k < 8; k++) {
        float a = float(k) * 0.7853982;
        vec2 o1 = vec2(cos(a), sin(a)) * r * uTexel;
        vec2 o2 = vec2(cos(a + 0.3926991), sin(a + 0.3926991)) * (0.5 * r) * uTexel;
        sum += 0.6 * max(-texture(uSceneHeight, (vUv + o1) * uSceneXf.xy + uSceneXf.zw).r, 0.0);
        sum += max(-texture(uSceneHeight, (vUv + o2) * uSceneXf.xy + uSceneXf.zw).r, 0.0);
        wsum += 1.6;
      }
      depth = mix(depth, sum / wsum, smoothK);
    }
    float fw = max(fwidth(depth), 1e-3);
    col = uSeaTier[0];
    col = mix(col, uSeaTier[1], smoothstep(uSeaDepth.x - fw, uSeaDepth.x + fw, depth));
    col = mix(col, uSeaTier[2], smoothstep(uSeaDepth.y - fw, uSeaDepth.y + fw, depth));
    col = mix(col, uSeaTier[3], smoothstep(uSeaDepth.z - fw, uSeaDepth.z + fw, depth));
    float iso = 0.0;
    for (int k = 0; k < 3; k++) {
      float T = k == 0 ? uSeaDepth.x : k == 1 ? uSeaDepth.y : uSeaDepth.z;
      iso = max(iso, 1.0 - smoothstep(0.5, 1.5, abs(depth - T) / fw));
    }
    col = mix(col, uIsobath.rgb, uIsobath.a * iso);
    // 平涂的海盖掉了前面的省份着色：再涂一次（海省默认不着色、A 为 0；用户给海省选了颜色时与按明暗画的海一样涂上；
    // 湖省、湖所在的省照样涂）。水面的像素只取水面格（provCell），不会涂上陆上省的颜色
    col = mix(col, fc.rgb, fc.a);
    col *= mix(1.0, uTierShade.x + uTierShade.y * shade, uShade);
  }
  // 湖泊类型：A 的低两位是水面的画法（1 染色、2 干湖底那样的盐壳），再两位是陆上的（1 湖岸的光晕、2 干涸湖底的盐壳），
  // 16 是发光（湖面亮一些）。盐壳是干湖底的颜色与类型的颜色各一半
  if (uHasTint == 1 && id >= 0) {
    vec4 tc = cellTex(uTint, id);
    int A = int(tc.a * 255.0 + 0.5);
    // 扭曲后取到的格与像素的水陆不合（湖岸附近：画成湖面的像素取到了岸上的格，或者反过来）时，
    // 换成没扭曲的最近格（它有这一边的画法时）：湖面的颜色一直染到画出来的湖岸
    int id0 = idAt(vUv);
    if (id0 >= 0 && id0 != id && ((land ? (A >> 2) & 3 : A & 3) == 0)) {
      vec4 t0 = cellTex(uTint, id0);
      int A0 = int(t0.a * 255.0 + 0.5);
      if ((land ? (A0 >> 2) & 3 : A0 & 3) != 0) {
        tc = t0;
        A = A0;
      }
    }
    if (A > 0) {
      int wm = A & 3;
      int lm = (A >> 2) & 3;
      vec3 crust = mix(vec3(0.886, 0.855, 0.769), tc.rgb, 0.5);
      if (!land) {
        if (wm == 1) col = mix(col, tc.rgb * (0.82 + 0.18 * clamp(shade, 0.6, 1.2)), 0.82);
        else if (wm == 2) col = crust * mix(1.0, shade, 0.5);
        if ((A & 16) != 0 && wm > 0) col += tc.rgb * 0.2;
      } else if (lm == 1) {
        col = mix(col, tc.rgb, 0.25) + tc.rgb * 0.12;
      } else if (lm == 2) {
        col = mix(col, crust * mix(1.0, shade, 0.6), 0.7);
      }
    }
  }
  ${FX_BEGIN}
  // 生态的发光：加在晕渲之后（背光的坡上照样亮）
  int glowSlot = int(fx.a + 0.5) - 1;
  if (glowSlot >= 0 && fx.b > 0.5) col += texelFetch(uFxPal, ivec2(1, glowSlot), 0).rgb * (fx.b / 255.0) * uGlowGain;
  ${FX_END}

  // 河：画在平涂、晕渲之后，海岸线、省界、高亮之前；只画在画成陆地的像素上（海面、湖面上不画，河口正好停在岸线）
  if (uHasRiver == 1 && land) {
    vec4 rv = texture(uRiver, vUv * uRiverXf.xy + uRiverXf.zw);
    col = col * (1.0 - rv.a) + rv.rgb;
  }

  // 海岸线：地形层画好的抗锯齿细线
  col = mix(col, uCoastLine.rgb, base.a * uCoastLine.a / sqrt(max(uScenePx, 1.0)));

  // 分组边界（省份）：扭曲坐标下相邻像素的分组不同。淡出为 0、离省界远的像素不取相邻像素（第三十九轮）
  if (provLines && pc >= 0 && !nearSkip(nearH.r, nearA + 1.5 * nearPx(), nearW + 1.5 * nearPx())) {
    vec2 dx = vec2(uTexel.x * 1.5, 0.0);
    vec2 dy = vec2(0.0, uTexel.y * 1.5);
    float g0 = groupOf(pc);
    float gx = groupOf(provAt(vUv + dx, uvW + dx));
    float gy = groupOf(provAt(vUv + dy, uvW + dy));
    // 陆海之间的边界已经由海岸线画出，这里只画同类之间的
    bool bx = gx > -1e8 && gx != g0 && (gx > 0.0) == (g0 > 0.0);
    bool by = gy > -1e8 && gy != g0 && (gy > 0.0) == (g0 > 0.0);
    // 缩小到省份只有十几像素宽时淡出（看省有多大，不看格有多大），否则全图视角下边界会密成一张网；
    // 格比一个像素还小时也淡出（扭曲后取到的格在像素之间乱跳，边界碎成噪点）：provFade
    if (bx || by) col = mix(col, uProvLine, (g0 > 0.0 ? 0.55 : 0.15) * provFade * uProvAlpha / uPxScale);
  }

  // 国界（第二十三轮）：比省界粗、深——近处一圈（约 3 像素宽）浓，外面一圈淡；海上的国界淡一些
  if (uHasCountry == 1 && pc >= 0) {
    vec2 cx = vec2(uTexel.x, 0.0);
    vec2 cy = vec2(0.0, uTexel.y);
    vec2 p0 = countryPair(pc);
    float c0 = p0.x;
    float b0 = p0.y;
    vec3 lineCol = uCountryLine;
    float zoomK = mix(0.55, 1.0, smoothstep(0.6, 1.5, uCellPx)) / sqrt(max(uPxScale, 1.0));
    // 外面一圈只在国界不淡（uCountryAlpha ≥ 0.999）时画；离国界远的像素不取（第三十九轮）
    bool outer = uCountryAlpha >= 0.999;
    float cR = (outer ? 3.0 : 1.5) * nearPx();
    if (c0 >= 0.0 && uCountryAlpha > 0.0 && !nearSkip(nearH.g, nearA + cR, nearW + cR)) {
      float kIn = 0.0;
      float kOut = 0.0;
      for (int t = 0; t < 4; t++) {
        float r = 1.5;
        int q = t;
        vec2 o = (q == 0 ? cx : q == 1 ? -cx : q == 2 ? cy : -cy) * r;
        vec2 pn = countryPair(provAt(vUv + o, uvW + o));
        if (countryEdge(c0, pn.x)) {
          // 同一个联邦的成员之间（第二十六轮）：细而淡，没有外面那一圈
          bool fed = b0 >= ${glsl(FEDERATION_GROUP - 0.5)} && pn.y == b0;
          kIn = max(kIn, fed ? 0.4 : 1.0);
          if (kIn >= 1.0) break;
        }
      }
      // 外面一圈只在近处一圈没碰到国界时看得出（kIn ≥ 0.4 时 kIn · 0.82 ≥ 0.328，比外面一圈的 0.3 浓）：碰到了就不取（第三十九轮）
      if (kIn == 0.0 && outer) {
        for (int t = 4; t < 8; t++) {
          float r = 3.0;
          int q = t - 4;
          vec2 o = (q == 0 ? cx : q == 1 ? -cx : q == 2 ? cy : -cy) * r;
          vec2 pn = countryPair(provAt(vUv + o, uvW + o));
          if (countryEdge(c0, pn.x) && !(b0 >= ${glsl(FEDERATION_GROUP - 0.5)} && pn.y == b0)) {
            kOut = 1.0;
            break;
          }
        }
      }
      float k = max(kIn * 0.82, kOut * 0.3 * step(0.999, uCountryAlpha)) * uCountryAlpha * (c0 >= 65535.5 ? 0.5 : 1.0) * zoomK;
      if (k > 0.0) col = mix(col, lineCol, k);
    }
    // 帝国的外沿（第二十六轮）：帝国里面、离边界 3.5–5 像素的一道细线，和国界一起像一道双线；海岸上、成员之间不画。
    // 近处一圈碰到别的集团就不画、远处一圈碰到一点就画：都可以早停；离集团的边界远的像素不取（第三十九轮）
    float rR = 5.0 * nearPx();
    if (b0 >= 0.5 && b0 < ${glsl(FEDERATION_GROUP - 0.5)} && !nearSkip(nearH.b, nearA + rR, nearW + rR)) {
      bool rimFar = false;
      bool rimNear = false;
      for (int t = 0; t < 8; t++) {
        int q = t - (t / 4) * 4;
        vec2 o = (q == 0 ? cx : q == 1 ? -cx : q == 2 ? cy : -cy) * (t < 4 ? 3.5 : 5.0);
        float bn = countryPair(provAt(vUv + o, uvW + o)).y;
        if (bn >= 0.0 && bn != b0) {
          if (t < 4) rimNear = true;
          else rimFar = true;
        }
        if (rimNear || rimFar) break;
      }
      if (rimFar && !rimNear) col = mix(col, lineCol, 0.6 * uCountryAlpha * zoomK);
    }
  }

  // 高亮与轮廓
  if (uHasHighlight == 1 && id >= 0) {
    bool byGroup = uHighlightByGroup == 1;
    int idH = byGroup ? pc : id;
    vec4 hc = idH >= 0 ? cellTex(uHighlight, idH) : vec4(0.0);
    float A0 = hc.a * 255.0;
    float a0 = hlAlpha(A0);
    if (A0 > 128.5) {
      // 斜线：按屏幕像素画，缩放时线宽不变
      float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * uPxScale / 10.0));
      col = mix(col, hc.rgb, a0 * stripe);
    } else {
      col = mix(col, hc.rgb, a0);
    }
    // 轮廓画在有高亮（不论多淡）与没有高亮的格之间。浓淡跟着两边较浓的一侧：0.18 以上照旧，
    // 更淡的（闪烁淡出时、渐变的边缘）跟着一起淡，不会在中途忽然断掉；只描边的格固定 0.75
    vec2 hx = vec2(uTexel.x * 1.5, 0.0);
    vec2 hy = vec2(0.0, uTexel.y * 1.5);
    float Ax = hlByte(byGroup ? provAt(vUv + hx, uvW + hx) : idAt(uvW + hx));
    float Ay = hlByte(byGroup ? provAt(vUv + hy, uvW + hy) : idAt(uvW + hy));
    bool on0 = A0 > 0.5;
    if (on0 != (Ax > 0.5) || on0 != (Ay > 0.5)) {
      bool lineOnly = abs(A0 - 128.0) < 0.5 || abs(Ax - 128.0) < 0.5 || abs(Ay - 128.0) < 0.5;
      float oa = max(a0, max(hlAlpha(Ax), hlAlpha(Ay)));
      col = mix(col, vec3(1.0), (lineOnly ? 0.75 : 0.9 * min(1.0, oa / 0.18)) / uPxScale);
    }
  }
  // 描格（第三十七轮）：鼠标下的格、钉住的格描出这一格画成陆地（或水面）的那一部分（focusAt：陆海、湖岸、碎岛、峡湾跟着画面）。
  // 先按到格心的距离排除远处的像素（只有格附近的像素多算五次 focusAt）。线居中约 2 像素：里面一道白、外面一道深色的衬边
  // （浅色的平原、雪地上也看得清）；按 uPxScale 淡一些，与高亮的轮廓一样
  if (id >= 0 && (uFocus.x >= 0 || uFocus.y >= 0)) {
    bool nh = uFocus.x >= 0 && nearFocus(world, uFocusC[0]);
    bool np = uFocus.y >= 0 && nearFocus(world, uFocusC[1]);
    if (nh || np) {
      vec2 ex = vec2(uTexel.x, 0.0);
      vec2 ey = vec2(0.0, uTexel.y);
      int f0 = focusAt(vUv, uvW);
      int fE = focusAt(vUv + ex, uvW + ex);
      int fW = focusAt(vUv - ex, uvW - ex);
      int fN = focusAt(vUv + ey, uvW + ey);
      int fS = focusAt(vUv - ey, uvW - ey);
      bool inner = false;
      bool outer = false;
      for (int slot = 0; slot < 2; slot++) {
        if (!(slot == 0 ? nh : np)) continue;
        int k = slot == 0 ? uFocus.x : uFocus.y;
        bool in0 = f0 == k;
        if ((fE == k) != in0 || (fW == k) != in0 || (fN == k) != in0 || (fS == k) != in0) {
          if (in0) inner = true;
          else outer = true;
        }
      }
      if (outer) col = mix(col, vec3(0.05, 0.06, 0.08), 0.42 / uPxScale);
      if (inner) col = mix(col, vec3(1.0), 0.9 / uPxScale);
    }
  }
  if (id < 0) col = vec3(0.08, 0.1, 0.14);
  oColor = vec4(col, 1.0);
}`;
