import { ScriptSession, worldSeedOf } from './biome-scripts';
import { type ScriptIssue, scriptsEnabled, worldInputs } from './script';
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
// 只在脚本没关掉、有生态带颜色脚本时算；否则 d.look 为 undefined。脚本出错时那种生态这一次用基础色，说明记进 issues
export function computeLook(world: World, d: Derived, issues: ScriptIssue[] = []): void {
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
  const session = new ScriptSession(world);
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
    const r = session.run('color', sp, sp.scripts!.color!.src, inputs, Int32Array.from(list), mask, seed, { share: `share#${sp.seedKey ?? sp.id}` });
    if (!r.ok) {
      issues.push(r.issue);
      continue;
    }
    own.push({ s, mask, rgb: r.out });
  }
  session.finish();
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
