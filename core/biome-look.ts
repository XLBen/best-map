import { ScriptSession, worldSeedOf } from './biome-scripts';
import { hashString } from './names';
import { smoothstep } from './rng';
import { type ScriptIssue, scriptsEnabled, worldInputs } from './script';
import { PATTERNS, type Pattern, type Species, type Visual } from './species';
import { fbmSub, fbmSub3, hashU, hashU3, vnoise, vnoise3 } from './subcell';
import type { Derived, World } from './world';

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

// 颜色脚本只在这种生态占的份额超过它的格上运行（份额更小的格上看不出来）
export const LOOK_MIN_SHARE = 0.004;

const rgbOf = (hex: string): RGB => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// 颜色脚本（第三批）：每格的植被颜色按份额混合（blendRgb），带颜色脚本的生态在它份额超过 LOOK_MIN_SHARE 的格上
// 用脚本算出的颜色代替它的基础色。结果写进 d.look（n × 4，a 为 255；海、湖为 0），屏幕、缩略图以后直接用它。
// 只在脚本没关掉、有生态带颜色脚本时算；否则 d.look 为 undefined。脚本出错时那种生态这一次用基础色，说明记进 issues。
// session：与长在哪里的脚本共用的那一次运行（computeVegetation 传进来，由它 finish）；不传时自己开一次
export function computeLook(world: World, d: Derived, issues: ScriptIssue[] = [], session?: () => ScriptSession): void {
  const species = world.small.species;
  const scripted = scriptsEnabled() ? species.map((sp, s) => (sp.scripts?.color ? s : -1)).filter((s) => s >= 0) : [];
  if (!scripted.length) {
    if (d.look !== undefined) d.look = undefined;
    return;
  }
  const { mesh, causes } = world;
  const n = mesh.n;
  const S = species.length;
  const base = species.map((sp) => rgbOf(sp.color));
  const veg = (i: number) => causes.land[i] === 1 && d.lake[i] !== 1;
  const mine = !session;
  const run = session ? session() : new ScriptSession(world);
  const seed = worldSeedOf(world);
  // 每种带脚本的生态：在哪些格用脚本的颜色（mask）、颜色是什么（rgb，n × 3）
  const own: { s: number; mask: Uint8Array; rgb: Uint8Array }[] = [];
  for (const s of scripted) {
    const sp = species[s];
    const share = new Float32Array(n);
    const mask = new Uint8Array(n);
    const list: number[] = [];
    for (let i = 0; i < n; i++) {
      const w = d.share[i * S + s];
      share[i] = w;
      if (w > LOOK_MIN_SHARE && veg(i)) {
        mask[i] = 1;
        list.push(i);
      }
    }
    const inputs = worldInputs(world, d, { extra: { share, color: base[s] } });
    // share 是这种生态自己的，记录里换个键，免得与别的生态的混在一起
    const r = run.run('color', sp, sp.scripts!.color!.src, inputs, Int32Array.from(list), mask, seed, { share: `share#${sp.id}` });
    if (!r.ok) {
      issues.push(r.issue);
      continue;
    }
    own.push({ s, mask, rgb: r.out });
  }
  if (mine) run.finish();
  const look = d.look?.length === n * 4 ? d.look : new Uint8Array(n * 4);
  const colors = base.map((c) => [c[0], c[1], c[2]] as RGB);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (!veg(i)) {
      look[o] = look[o + 1] = look[o + 2] = look[o + 3] = 0;
      continue;
    }
    for (const { s, mask, rgb } of own) {
      const c = colors[s];
      if (mask[i]) {
        c[0] = rgb[3 * i];
        c[1] = rgb[3 * i + 1];
        c[2] = rgb[3 * i + 2];
      } else {
        c[0] = base[s][0];
        c[1] = base[s][1];
        c[2] = base[s][2];
      }
    }
    const c = blendRgb(d.share, i, colors);
    look[o] = Math.round(c[0]);
    look[o + 1] = Math.round(c[1]);
    look[o + 2] = Math.round(c[2]);
    look[o + 3] = 255;
  }
  d.look = look;
}

// ---------- 花纹与发光（第三批） ----------
// 屏幕上在着色器里画（renderer.ts 的 PATTERN_GLSL），这里是同一套算式。花纹只用格以下细节那套整数哈希噪声
// （subcell.ts 的 hashU / vnoise / fbmSub 及三维版本，着色器里都有一份）。q 以“花纹单位”计（一个单位 = size 格），
// 值都在 [0, 1]：0 是底色，1 是第二种颜色。拉远时花纹淡成它的平均值 PATTERN_MEAN（缩略图也用平均值），
// 所以远看、近看、缩略图的平均颜色一致

// 着色器里花纹的编号（PATTERNS 里的序号，none 为 0）
export const patternKind = (p: Pattern): number => PATTERNS.indexOf(p);

// 闪光：三倍细的网格上 p 那么多的格里有一个点（点心在格的中间六成里，边缘从 r0 淡到 r1，不出格）。
// 星球上看到的是三维小球被球面切开的截面，比平面上稀：概率放大三倍、球大一些，疏密与平面相近。
// 着色器（renderer.ts）直接用这几个数，两边不会改了一边忘了另一边
export const SPARKLE = { p: 0.25, r0: 0.06, r1: 0.12 };
export const SPARKLE3 = { p: 0.75, r0: 0.08, r1: 0.16 };

const unitOf = (h: number) => (h & 0xffffff) / 16777216;

function sparkle(x: number, y: number): number {
  const gx = x * 3;
  const gy = y * 3;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const h = hashU(ix, iy);
  if (unitOf(h) >= SPARKLE.p) return 0;
  const cx = ix + 0.2 + (0.6 * (h & 255)) / 255;
  const cy = iy + 0.2 + (0.6 * ((h >>> 8) & 255)) / 255;
  return 1 - smoothstep(SPARKLE.r0, SPARKLE.r1, Math.hypot(gx - cx, gy - cy));
}

// 条纹：t 先取小数部分再求正弦（值不变；着色器里 t 可到几千，有的显卡大角度的 sin 不准）
const stripe = (t: number) => smoothstep(0.2, 0.6, Math.sin(2 * Math.PI * (t - Math.floor(t))));

function sparkle3(x: number, y: number, z: number): number {
  const gx = x * 3;
  const gy = y * 3;
  const gz = z * 3;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const iz = Math.floor(gz);
  const h = hashU3(ix, iy, iz);
  if (unitOf(h) >= SPARKLE3.p) return 0;
  const cx = ix + 0.2 + (0.6 * (h & 255)) / 255;
  const cy = iy + 0.2 + (0.6 * ((h >>> 8) & 255)) / 255;
  const cz = iz + 0.2 + (0.6 * (h >>> 24)) / 255;
  return 1 - smoothstep(SPARKLE3.r0, SPARKLE3.r1, Math.hypot(gx - cx, gy - cy, gz - cz));
}

// 裂纹：每个单位格里一个随机点，到最近两点的距离差（F2 − F1）很小的地方是裂缝
function cracks(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 8;
  let f2 = 8;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const h = hashU(cx, cy);
      const d = Math.hypot(x - (cx + (h & 0xffff) / 65536), y - (cy + (h >>> 16) / 65536));
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  return 1 - smoothstep(0.03, 0.08, f2 - f1);
}

function cracks3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let f1 = 8;
  let f2 = 8;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx;
        const cy = iy + dy;
        const cz = iz + dz;
        const h = hashU3(cx, cy, cz);
        const d = Math.hypot(x - (cx + (h & 1023) / 1024), y - (cy + ((h >>> 10) & 1023) / 1024), z - (cz + ((h >>> 20) & 1023) / 1024));
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
    }
  }
  return 1 - smoothstep(0.03, 0.08, f2 - f1);
}

// 平面世界上的花纹：q = 地图坐标 / (格距 · size) + 种子偏移
export function patternValue(p: Pattern, x: number, y: number): number {
  switch (p) {
    case 'sparkle':
      return sparkle(x, y);
    case 'cracks':
      return cracks(x, y);
    case 'mottle':
      return smoothstep(-0.1, 0.25, fbmSub(x, y, 3));
    case 'veins':
      return smoothstep(0.88, 0.97, 1 - Math.abs(fbmSub(x * 0.8, y * 0.8, 3)));
    case 'spots':
      return smoothstep(0.35, 0.45, vnoise(x * 1.7, y * 1.7));
    case 'stripes':
      // 横条纹（星球上是沿纬线的带），用低频噪声扭弯
      return stripe(y + 0.6 * fbmSub(x * 0.5, y * 0.5, 2));
    default:
      return 0;
  }
}

// 整个星球上的花纹：在球面位置上取三维噪声，q = 球面上的点 · uNoiseK / size + 种子偏移（每份副本一样，没有接缝）
export function patternValue3(p: Pattern, x: number, y: number, z: number): number {
  switch (p) {
    case 'sparkle':
      return sparkle3(x, y, z);
    case 'cracks':
      return cracks3(x, y, z);
    case 'mottle':
      return smoothstep(-0.1, 0.25, fbmSub3(x, y, z, 3));
    case 'veins':
      return smoothstep(0.88, 0.97, 1 - Math.abs(fbmSub3(x * 0.8, y * 0.8, z * 0.8, 3)));
    case 'spots':
      return smoothstep(0.35, 0.45, vnoise3(x * 1.7, y * 1.7, z * 1.7));
    case 'stripes':
      return stripe(z + 0.6 * fbmSub3(x * 0.5, y * 0.5, z * 0.5, 2));
    default:
      return 0;
  }
}

// 各种花纹的平均值（平面、星球各一份；一百万个采样量出来，biome-look.test.ts 用 64k 个采样核对）
export const PATTERN_MEAN: Record<Pattern, number> = { none: 0, sparkle: 0.0064, cracks: 0.1354, mottle: 0.3931, veins: 0.2204, spots: 0.2004, stripes: 0.3683 };
export const PATTERN_MEAN3: Record<Pattern, number> = { none: 0, sparkle: 0.0058, cracks: 0.2017, mottle: 0.3744, veins: 0.2634, spots: 0.1539, stripes: 0.3688 };

// 花纹最细的地方占一个花纹单位的多少：屏幕上一个花纹单位不到 1.5 / detail 像素时淡成平均值，5 / detail 像素以上画全
// （裂纹和脉络的线比斑驳细得多，要放得更大才画出来，否则断成一串点。闪光的点不到一个像素时照样画：
// 落在像素上的点就是一闪一闪的亮点，平均颜色不变）
export const PATTERN_DETAIL: Record<Pattern, number> = { none: 1, sparkle: 0.4, cracks: 0.3, mottle: 1, veins: 0.3, spots: 0.6, stripes: 0.7 };

// 花纹画出来的程度：pxPerUnit 是一个花纹单位在屏幕上合多少像素（格的像素数 × size）
export const patternFade = (p: Pattern, pxPerUnit: number) => smoothstep(1.5, 5.0, pxPerUnit * PATTERN_DETAIL[p]);

// 种子偏移：每种生态的花纹各不相同，按 seedKey（没有时按 id）取，改名不改花纹
export const SEED_STEP: [number, number, number] = [13.37, 7.91, 5.53];
export const patternSeed = (sp: Species) => hashString(sp.seedKey ?? sp.id) & 255;

// 发光加在晕渲之后：写实风格亮一些，地图册（羊皮纸）淡一些
export const GLOW_GAIN = 0.6;
export const GLOW_GAIN_ATLAS = 0.3;

// 一种生态画在地图上的外观（补上默认值）：第二种颜色默认是基础色调暗 40%，明显程度 0.6，大小 0.5 格，
// 发光的颜色默认是基础色与白色各半。颜色都是 0–255
export interface VisualLook {
  pattern: Pattern;
  color2: RGB;
  amount: number;
  size: number;
  glow: number;
  glowColor: RGB;
  seed: number;
  // 这种花纹的平均值（平面或星球的）
  mean: number;
}

// 没有花纹、也不发光时为 null（画法与没有外观的一样）
export function visualLook(sp: Species, visual: Visual | undefined, sphere: boolean): VisualLook | null {
  if (!visual) return null;
  const glow = visual.glow ?? 0;
  if (visual.pattern === 'none' && glow <= 0) return null;
  const base = rgbOf(sp.color);
  return {
    pattern: visual.pattern,
    color2: visual.color2 ? rgbOf(visual.color2) : [base[0] * 0.6, base[1] * 0.6, base[2] * 0.6],
    amount: visual.amount ?? 0.6,
    size: visual.size ?? 0.5,
    glow,
    glowColor: visual.glowColor ? rgbOf(visual.glowColor) : [(base[0] + 255) / 2, (base[1] + 255) / 2, (base[2] + 255) / 2],
    seed: patternSeed(sp),
    mean: (sphere ? PATTERN_MEAN3 : PATTERN_MEAN)[visual.pattern],
  };
}

// 调色板最多几行（格上用一个字节记“第几行 + 1”）
export const FX_SLOTS = 255;

// 一批生态的外观：looks[slot]，slotOf[生态的序号] = slot（没有花纹也不发光的是 −1）。
// overrides：拖花纹、发光滑块时按 id 换上的外观（只影响画法）。没有一种生态有花纹或发光时为 null
export interface FxSet {
  looks: VisualLook[];
  slotOf: Int16Array;
}

export function fxSet(species: readonly Species[], sphere: boolean, overrides?: ReadonlyMap<string, Visual>): FxSet | null {
  const looks: VisualLook[] = [];
  const slotOf = new Int16Array(species.length).fill(-1);
  species.forEach((sp, s) => {
    if (looks.length >= FX_SLOTS) return;
    const v = visualLook(sp, overrides?.get(sp.id) ?? sp.visual, sphere);
    if (!v) return;
    slotOf[s] = looks.length;
    looks.push(v);
  });
  return looks.length ? { looks, slotOf } : null;
}

// 一格的花纹与发光，写进 out：
//   [0] 花纹：份额最大的有花纹的生态的 slot（没有为 −1），[1] 它的份额；
//   [2] 发光：各生态份额 × 发光强度之和（0–1），[3] 发光的颜色取贡献最大的那种的 slot（没有为 −1）
export function cellFx(set: FxSet, share: ArrayLike<number>, i: number, S: number, out: Float64Array): void {
  let top = -1;
  let topShare = 0;
  let glow = 0;
  let gTop = -1;
  let gBest = 0;
  for (let s = 0; s < S; s++) {
    const k = set.slotOf[s];
    if (k < 0) continue;
    const w = share[i * S + s];
    if (w <= 0) continue;
    const v = set.looks[k];
    if (v.pattern !== 'none' && w > topShare) {
      top = k;
      topShare = w;
    }
    const g = w * v.glow;
    if (g > 0) {
      glow += g;
      if (g > gBest) {
        gBest = g;
        gTop = k;
      }
    }
  }
  out[0] = top;
  out[1] = topShare;
  out[2] = Math.min(1, glow);
  out[3] = gTop;
}

// 着色器用的调色板：256 行 × 3 个 RGBA 浮点纹素（颜色 0–1）。
//   第 0 个：第二种颜色、明显程度；第 1 个：发光的颜色、强度；第 2 个：花纹编号、大小、平均值、种子
export function fxPalette(set: FxSet): Float32Array {
  const pal = new Float32Array(256 * 3 * 4);
  set.looks.forEach((v, k) => {
    const o = k * 12;
    pal.set([v.color2[0] / 255, v.color2[1] / 255, v.color2[2] / 255, v.amount], o);
    pal.set([v.glowColor[0] / 255, v.glowColor[1] / 255, v.glowColor[2] / 255, v.glow], o + 4);
    pal.set([patternKind(v.pattern), v.size, v.mean, v.seed], o + 8);
  });
  return pal;
}

// 拉远看（缩略图、屏幕上花纹淡成平均值时）一格的颜色：c（0–255，就地改）混入花纹的平均色；
// cover：没被雪、盐壳盖住的部分（盖住的地方不画花纹）。fx 是 cellFx 的结果
export function meanTint(set: FxSet, fx: Float64Array, cover: number, c: RGB): void {
  if (fx[0] < 0) return;
  const v = set.looks[fx[0]];
  const t = v.mean * v.amount * fx[1] * cover;
  c[0] += (v.color2[0] - c[0]) * t;
  c[1] += (v.color2[1] - c[1]) * t;
  c[2] += (v.color2[2] - c[2]) * t;
}
