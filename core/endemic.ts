import type { Species } from './species';
import type { World } from './world';

// 岛屿特有生态：以岛上最多的那种生态为底，照抄它喜欢的冷暖干湿和条件，强势程度只高一丝（×1.001，
// 和底生态适宜度完全相同，所以正好在底生态占上风的地方胜出），
// 只能在这个岛上扩散（不能跨海）。所以岛上原来是这种生态的地方换成特有的版本，
// 冰原、湿地等别的生态不受影响，岛外也不会出现。颜色在底生态上明显地偏开（见 shiftColor），一眼看得出是新的一种。
// 岛上没有能长东西的地方时返回 null
export function endemicSpecies(world: World, islandCells: number[], id: string, islandName: string): Species | null {
  const land = endemicLand(world, islandCells);
  const base = endemicBase(world, land);
  if (base < 0) return null;
  const b = world.small.species[base];
  return {
    ...structuredClone(b),
    id,
    name: `${islandName}${b.name || b.id}`,
    color: shiftColor(b.color, islandCells[0] ?? 0, world.small.species.map((x) => x.color)),
    competition: Math.min(100, b.competition * 1.001),
    dispersal: { origins: land.slice(0, 200), range: 20000, gapCost: 4, seaCost: 1e6 },
  };
}

// 岛上能长东西的陆地格（不算湖面）
function endemicLand(world: World, islandCells: number[]): number[] {
  return islandCells.filter((c) => world.causes.land[c] && world.derived.lake[c] !== 1);
}

// 岛上最多的那种生态（特有生态的底）的下标；没有能长东西的地方为 −1。land：岛上的陆地格
export function endemicBase(world: World, land: number[]): number {
  const d = world.derived;
  const counts = new Map<number, number>();
  for (const c of land) if (d.dominant[c] >= 0) counts.set(d.dominant[c], (counts.get(d.dominant[c]) ?? 0) + 1);
  let base = -1;
  let most = 0;
  for (const [s, n] of counts) {
    if (n > most) {
      most = n;
      base = s;
    }
  }
  return base;
}

// 在底色上转开一大截色相（40°，以前 22°）、明暗也拉开（暗色变亮、亮色变暗）、更饱和一点：
// 放在底生态旁边一眼分得开，又还看得出是近亲。往哪边转：离已有各生态的颜色都更远的那一边
// （免得转成另一种常见生态的颜色，比如森林转黄就像草原）；一样远时按岛定。结果固定
export function shiftColor(hex: string, salt: number, avoid: string[] = []): string {
  const [h, s, l] = hexToHsl(hex);
  const dl = l < 0.45 ? 0.13 : -0.13;
  const at = (turn: number) => hslToHex((h + turn + 360) % 360, Math.min(1, Math.max(0.3, s + 0.06)), Math.max(0.08, Math.min(0.9, l + dl)));
  const first = salt % 2 === 0 ? 40 : -40;
  const a = at(first);
  const b = at(-first);
  if (!avoid.length) return a;
  const nearest = (c: string) => Math.min(...avoid.map((x) => rgbDist(c, x)));
  return nearest(b) > nearest(a) + 1e-9 ? b : a;
}

function rgbDist(a: string, b: string): number {
  let d = 0;
  for (const k of [1, 3, 5]) d += (parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)) ** 2;
  return Math.sqrt(d);
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const dd = max - min;
  const s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
  const h = max === r ? ((g - b) / dd + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / dd + 2) * 60 : ((r - g) / dd + 4) * 60;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}
