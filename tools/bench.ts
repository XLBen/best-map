// 计时：各阶段耗时
import { Engine } from '../core/engine';
import { coastalStroke } from './hash';
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
// 画一笔真改海陆的陆地（沿海的海格附近）、撤销、重做；只改冷暖
{
  const cells = coastalStroke(eng.world, 0.37, 8);
  const before = eng.world.causes.land.reduce((a, b) => a + b, 0);
  lap('(pick cells)');
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  lap(`paint land (+${eng.world.causes.land.reduce((a, b) => a + b, 0) - before} land)`);
  console.log(eng.lastTimings);
  eng.undo();
  lap('undo');
  eng.redo();
  lap('redo');
  const land = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.land[i]).slice(0, 300);
  eng.exec({ op: 'paint', field: 'tempOffset', cells: land, value: 2, mode: 'add' });
  lap('paint temp (climate only)');
  const doc = eng.toDoc();
  Engine.fromDoc(doc, eng.world.mesh);
  lap(`fromDoc replay (${doc.commands.length} commands)`);
}
