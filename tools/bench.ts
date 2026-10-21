// 计时：各阶段耗时
import { Engine } from '../core/engine';
let t = performance.now();
const lap = (label: string) => {
  const now = performance.now();
  console.log(label.padEnd(20), (now - t).toFixed(0), 'ms');
  t = now;
};
// npx tsx tools/bench.ts [格数] [--globe]：--globe 是整个星球（默认 10 万格）
const globe = process.argv.includes('--globe');
const cellsArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const eng = new Engine(
  globe
    ? { seed: 3, cells: Number(cellsArg ?? 100000), globe: true, aspect: 2, latNorth: 90, latSouth: -90 }
    : { seed: 3, cells: Number(cellsArg ?? 40000) },
);
lap('mesh');
eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
lap('generate+pipeline');
console.log(eng.lastTimings);
eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
lap('provinces');
eng.exec({ op: 'paint_relief', cells: [100, 101, 102], t: [0, 0, 0], strength: 0.5 });
lap('paint relief');
eng.exec({ op: 'paint', field: 'tempOffset', cells: [100, 101, 102], value: 2, mode: 'add' });
lap('paint temp');
// 画一笔陆地（约 300 格）、撤销
{
  const m = eng.world.mesh;
  const cells: number[] = [];
  for (let i = 0; i < m.n && cells.length < 300; i++) if (Math.hypot(m.x[i] - m.x[5000], m.y[i] - m.y[5000]) < m.spacing * 10) cells.push(i);
  lap('(pick cells)');
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  lap('paint land');
  eng.undo();
  lap('undo');
}
