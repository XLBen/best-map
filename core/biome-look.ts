// 生态在地图上的样子：屏幕、缩略图用同一套算法，看到的颜色才一致

type RGB = [number, number, number];

// 没有植被份额的陆地（裸地）的颜色
export const BARE_RGB: RGB = [205, 190, 160];

// 一格的植被颜色：按各生态的份额混合。share 是份额数组（每格 colors.length 个数），i 是格号；
// 份额都是 0 时是裸地的颜色。每次给出新的数组，调用方可以直接改
export function blendRgb(share: ArrayLike<number>, i: number, colors: readonly RGB[]): RGB {
  const S = colors.length;
  let r = 0;
  let g = 0;
  let b = 0;
  let t = 0;
  for (let s = 0; s < S; s++) {
    const w = share[i * S + s];
    if (w <= 0) continue;
    r += w * colors[s][0];
    g += w * colors[s][1];
    b += w * colors[s][2];
    t += w;
  }
  return t > 0 ? [r / t, g / t, b / t] : [BARE_RGB[0], BARE_RGB[1], BARE_RGB[2]];
}
