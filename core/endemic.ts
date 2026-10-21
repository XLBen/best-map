import type { Species } from './species';
import type { World } from './world';

// 岛屿特有生态：以岛上最多的那种生态为底，照抄它喜欢的冷暖干湿和条件，强势程度只高一丝（×1.001，
// 和底生态适宜度完全相同，所以正好在底生态占上风的地方胜出），
// 只能在这个岛上扩散（不能跨海）。所以岛上原来是这种生态的地方换成特有的版本，
// 冰原、湿地等别的生态不受影响，岛外也不会出现。颜色在底生态上略微偏一点，看得出是近亲。
// 岛上没有能长东西的地方时返回 null
export function endemicSpecies(world: World, islandCells: number[], id: string, islandName: string): Species | null {
  const d = world.derived;
  const land = islandCells.filter((c) => world.causes.land[c] && d.lake[c] !== 1);
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
  if (base < 0) return null;
  const b = world.small.species[base];
  return {
    ...structuredClone(b),
    id,
    name: `${islandName}${b.name || b.id}`,
    color: shiftColor(b.color, islandCells[0] ?? 0),
    competition: Math.min(100, b.competition * 1.001),
    dispersal: { origins: land.slice(0, 200), range: 20000, gapCost: 4, seaCost: 1e6 },
  };
}

// 在底色上转一点色相、略微压暗：一眼看得出是近亲，又分得开。往哪边转按岛定，结果固定
function shiftColor(hex: string, salt: number): string {
  const [h, s, l] = hexToHsl(hex);
  const turn = salt % 2 === 0 ? 22 : -22;
  return hslToHex((h + turn + 360) % 360, Math.min(1, s + 0.06), Math.max(0, l - 0.05));
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
