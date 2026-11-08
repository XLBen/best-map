import { glsl, SPECK_MARK } from './common';

// 手绘（第八十七轮）：合成着色器里另加的一段（纸、水彩、岸外的水纹、粗一点的墨线海岸）。
// 只在 uHand 为 1 时走（画风有纸、水彩或水纹时，见 style-uniforms.ts）；写实、地图册的 uHand 是 0，整段跳过，画出来与以前逐像素相同。
// 合成着色器里只多了这些 uniform、这几个函数和一行调用（compose.ts 的“手绘”），星球、投影的那几份照样替换出来。
//
// 离岸多远：地形层画好的海岸线（场景颜色的 a，约 1.2 个像素宽的细线）按 mipmap 模糊（手绘时渲染器给场景颜色生成 mipmap，
// 见 renderer-draw.ts 的 compose）：模糊到 B 个场景像素宽的方块时，离岸 d 处的浓淡约是 1.3 / B · (1 − d / B)，乘回 B / 1.3
// 就是从岸上的 1 到离岸 B 处的 0。第 k 道水纹取 B = 2 · 离岸的像素数、画在 0.5 那一条线上。海岸值本身（高度纹理的 g）
// 带着格以下的海岸噪声（幅度比岸边的落差还大），按它除以 fwidth 量离岸多远时海上到处是点，不能用

export const HAND_UNIFORMS = `// 手绘（第八十七轮，shaders/hand.ts）：uPaper 纸的颜色与浓淡，uWash 水彩的晕染，uRipple 水纹的颜色与道数
uniform int uHand;
uniform vec4 uPaper;
uniform float uWash;
uniform vec4 uRipple;
`;

export const HAND_GLSL = `
// 纸的纤维：一个方向拉长的噪声叠一层圆的。波长按 2 的幂取最近的两档（约 3–6 个像素），按小数部分混合：
// 平移时跟着地图走，缩放时不游动、不闪。pxW：画面一个像素合多少地图单位
float handGrain(vec2 world, float pxW) {
  float L = log2(max(pxW, 1e-9) * 3.0);
  float l0 = floor(L);
  float t = L - l0;
  float g = 0.0;
  for (int k = 0; k < 2; k++) {
    vec2 p = world / exp2(l0 + float(k));
    float a = vnoise(vec2(p.x * 0.34 + p.y * 0.94, p.y * 0.34 - p.x * 0.94) * vec2(0.55, 1.25) + float(k) * 13.1);
    float b = vnoise(p * 1.7 + vec2(5.3, -2.1));
    g += (0.65 * a + 0.35 * b) * (k == 0 ? 1.0 - t : t);
  }
  return g / sqrt((1.0 - t) * (1.0 - t) + t * t);
}
// 离岸约 px 个屏幕像素以内的“近岸”量：岸上 1，往外到 2·px 处落到 0（见文件开头）
float handNear(vec2 sUv, float px) {
  float B = max(2.0 * px / max(uScenePx, 1e-3), 1.0);
  return textureLod(uSceneColor, sUv, log2(B)).a * B / 1.3;
}
// col：这一点的颜色；sUv：场景上的位置；s：海岸场（高度纹理的 g，小湖群的水面是 SPECK_MARK）；line：地形层画的海岸线的浓淡
vec3 handLook(vec3 col, vec2 world, vec2 sUv, float s, bool land, float line) {
  // 导数（fwidth）都在这里算：调用它的地方是 uHand 的一致分支，下面再按陆海分开
  float rv[4];
  float rw[4];
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    rv[k] = handNear(sUv, 4.5 + 5.0 * fk + 0.5 * fk * fk);
    rw[k] = max(fwidth(rv[k]), 1e-4);
  }
  float shore = clamp(handNear(sUv, 9.0), 0.0, 1.0);
  float edge = clamp(handNear(sUv, 3.0), 0.0, 1.0);
  // 粗一点的墨线：细线模糊一级再加浓
  float ink = max(line, min(1.0, textureLod(uSceneColor, sUv, 1.0 - log2(max(uScenePx, 1e-3))).a * 1.2));
  bool speck = s < ${glsl(SPECK_MARK / 2)};
  if (land) {
    // 水彩：几格大小的一片片深浅，靠近海岸的一圈颜色积得深一点
    float blot = fbmSub(world / uSpacing * 0.35 + vec2(7.0, -3.0), 3);
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.0 - 0.3 * uWash);
    col *= 1.0 + uWash * (0.1 * blot - 0.05 * edge);
  } else if (!speck) {
    // 岸边的水色深一点，往外淡
    col = mix(col, uRipple.rgb, 0.14 * shore * min(uRipple.a, 1.0));
    // 岸外几道细线：离岸约 4.5、9.5、15、21 个像素，越往外越淡
    float rip = 0.0;
    for (int k = 0; k < 4; k++) {
      if (float(k) >= uRipple.a) break;
      float a = 0.6 * (1.0 - float(k) / (uRipple.a + 0.5));
      rip = max(rip, a * (1.0 - smoothstep(0.3, 0.9, abs(rv[k] - 0.5) / rw[k])));
    }
    col = mix(col, uRipple.rgb, rip);
  }
  if (!speck) col = mix(col, uCoastLine.rgb, 0.25 * uPaper.a * ink);
  // 纸：乘上纸的颜色，加纤维与几格大小的旧痕
  float grain = handGrain(world, uSpacing / max(uCellPx, 1e-6));
  float stain = fbmSub(world / uSpacing * 0.08 + vec2(-4.0, 9.0), 3);
  col = mix(col, col * uPaper.rgb * 1.08, uPaper.a);
  col *= 1.0 + uPaper.a * (0.035 * grain + 0.05 * stain);
  return col;
}
`;

// 合成里的那一行：海岸线之后、省界之前
export const HAND_CALL = `  // 手绘（第八十七轮，shaders/hand.ts）：写实、地图册不走
  if (uHand == 1) col = handLook(col, world, sUv, hs.g, land, base.a);
`;
