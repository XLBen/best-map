// 计时：同一个世界上同一种笔画做很多次（第七十九轮）
//   npx tsx tools/bench-steady.ts [--globe] [--json]
//   node tools/bench-median.mjs 5 --against <提交> --script tools/bench-steady.ts -- [--globe]
//     种子 3 的一块地区（4 万格）或类地星球，新建以后抬山、岩性、冷暖笔各做 21 次（每次换一个内陆的地方、半径 6–8 格，做完撤销），记中位数（毫秒）。
//     tools/bench.ts 的每一步只做一次，量的是新建以后的头几笔（很多函数还没编译好、垃圾回收落在哪一笔是碰巧的）：岩性一笔在 170–300 ms 之间，
//     七次的中位数和旧的比也会差 ±10%。这里量的是编译好以后的，窄得多，用来分辨那几步是不是真的变慢（第七十九轮的岩性、冷暖笔）
import { Engine } from '../core/engine';
import type { Command } from '../core/commands';
import { newWorldContentCommands } from '../core/packs/import';
import { PLANET_SIZES, planetCells } from '../core/presets';

const globe = process.argv.includes('--globe');
const json = process.argv.includes('--json');
const eng = globe
  ? new Engine({ seed: 3, cells: planetCells(PLANET_SIZES.earth.radiusKm), globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 })
  : new Engine({ seed: 3, cells: 40000 });
eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
const w = eng.world;
// 内陆的格（离赤道不远）
const land: number[] = [];
for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && Math.abs(w.mesh.y[i] - 0.5) < 0.3) land.push(i);
const disc = (c: number, r: number) => {
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < w.mesh.spacing * r) out.push(i);
  return out;
};
const steps: [string, (cells: number[]) => Command][] = [
  ['relief', (cells) => ({ op: 'paint_relief', cells, t: cells.map((_, k) => (k % 5) / 5), strength: 0.7 })],
  ['erod', (cells) => ({ op: 'paint', field: 'erodDelta', cells, value: 0.5, mode: 'add' })],
  ['tempBrush', (cells) => ({ op: 'paint', field: 'tempOffset', cells, values: cells.map(() => -1), mode: 'add' })],
];
const ms = new Map<string, number[]>(steps.map(([k]) => [k, []]));
for (let k = 0; k < 21; k++) {
  const cells = disc(land[Math.floor(((k * 0.618) % 1) * land.length)], 6 + (k % 3));
  for (const [key, make] of steps) {
    const a = performance.now();
    eng.exec(make(cells));
    ms.get(key)!.push(performance.now() - a);
    eng.undo();
  }
}
const out: Record<string, number> = {};
for (const [key, v] of ms) out[key] = Math.round([...v].sort((x, y) => x - y)[v.length >> 1] * 10) / 10;
console.log(json ? JSON.stringify(out) : out);
