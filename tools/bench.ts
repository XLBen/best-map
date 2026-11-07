// 计时：各阶段耗时
//   npx tsx tools/bench.ts [格数] [--globe] [--json] [--long] [--human]：一块地区（默认 4 万格）或整个星球（--globe，
//     默认是新建类地星球的格数，每格约 100 km，见 planetCells），按用户平时的加工逐步计时（第三十一轮补全）：
//     新建、抬山、岩性、冷暖笔、画陆地、放岛、重新生成一片、画河、放湖、湿度、纬度（星球上是轴倾角）、撤销 6 次、重做，
//     再从检查点打开后的第一笔（冷：网格是新的对象，所有按网格的缓存都是空的）、预热以后的第一笔、一直开着时的同一笔。
//     每一步另记各阶段（高程里再分生成器采样、认陆块、求解、收尾）与计数（重算了几块陆地、湖、河口）。
//     --long：再造一份约 200 条混合命令的文档，计整段重放与从检查点恢复（都在新的网格上，像重新打开）。
//     --human：再接着跑人文（省份、文化、人口、国家、城市）的旧步骤（只打印，不进 --json）
//     --library：世界带着一整个时代库（第四十七轮：中世纪的包照常导入，small.content 约 300 KB，没有人文、地图不变），
//     步骤相同，最后另计不重算推导的几步（libEdit、libUndo、libRedo、libContent、libContentUndo、libNoop：几十次的中位数，
//     毫秒、两位小数）、发给主线程的小数据（libPost）、每步撤销记录里的字（undoKB，千字）
//     --kept：--library 再加生成人文（第五十轮：世界留着全部内容；旧的提交上生成后清理掉，正好对照），步骤相同，
//     另计改人口（libHuman、libHumanUndo）、改国家档案（libCountry、libCountryUndo）、存世界文件（libSaveDoc）和世界文件的大小（docKB）
//     --era <id>（第七十九轮）：--library、--kept 用这个时代的库（antiquity、medieval、industrial、modern、fantasy、scifi；默认 medieval），
//     --kept 另计重新生成国家（regenCountries：三个种子各一次再撤销的中位数）与国家个数（countries）
//   npx tsx tools/bench.ts --globe --pack fantasy [--json] [--hash]：整个星球 + 奇幻示例包，按用户平时的操作逐步计时
//     （新建、用资源包、画陆地、堆山、放岛、冷暖、自然融入的生态、湿度滑块、画河的预览与执行、撤销 6 次、重做、
//     打开（整段重放）、从检查点恢复）
//   每一步之后另计 Worker 接着做的：描河并打包（core/river-pack.ts 的 worldRivers，键“步骤.rivers”）与主线程地形层的海岸场
//     （core/display.ts 的 displayCoast，键“步骤.coast”）；加工各步（抬山到重做）的这两样另加起来记成 rivers、coast 两步（第三十三轮提速）。
//   --json 最后一行打出 { 步骤: 毫秒 }；键里带“.”的是这一步的某个阶段，带“#”的是计数（不是毫秒）。
//   tools/bench-median.mjs 取几次的中位数、对照两个提交（见开发说明“速度”）
//
// 这个文件要能在旧的提交上跑（bench-median 的 --at 把它复制过去）：只用到那时已有的接口，后加的（预热、高程分段）
// 用 * as 取、没有时跳过
import * as Elev from '../core/elevation';
import * as Terr from '../core/terrain';
import * as RiverPack from '../core/river-pack';
import * as Display from '../core/display';
import * as CoastStyle from '../core/coast-style';
import { Engine } from '../core/engine';
import * as Commands from '../core/commands';
import type { Command } from '../core/commands';
import { packMesh, unpackMesh } from '../core/mesh-pack';
import type { Mesh } from '../core/mesh';
import { PLANET_SIZES, planetCells, planetSettings } from '../core/presets';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { mulberry32 } from '../core/rng';
import { coastalStroke, digest } from './hash';
import { kindOf } from '../core/content/registry';

// 时代（第七十九轮：--era <id>，默认中世纪）：--library、--kept 导入这个时代的库、按它生成人文
const eraArg = process.argv.indexOf('--era');
const era = eraArg >= 0 ? process.argv[eraArg + 1] : 'medieval';
// 时代包默认的前三个文化组与权重（第四十三轮起是 EU4 的文化组；按包里列的，旧的提交上也能跑）
const medievalGroups = () => ((builtinPacks().find((p) => p.id === era)?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => ({ id: n.id, weight: n.weight ?? 1 }));
// 生成人文：第七十七轮起命令只写文化组的 id（各组占多少是世界里组的比重，内置的组带着库里的比重）；旧的提交上要写权重。
// 先试新的写法，命令的格式不认时（没执行）用旧的写法：两边的结果一样
function genHuman(eng: Engine, more: Record<string, unknown>): void {
  const cmd = { op: 'generate_human', packs: [[era]], ...more };
  try {
    eng.exec({ ...cmd, groups: medievalGroups().map((g) => g.id) } as unknown as Command);
  } catch {
    eng.exec({ ...cmd, groups: medievalGroups() } as unknown as Command);
  }
}
// 划分省份：第七十八轮起命令只写种子（规则是世界里的“省份划分”）；旧的提交上写 rules: { seed }（那时的格式不严格，
// 新的写法不报错、只是种子被丢掉，所以按有没有这种内容来分）。两边的结果一样
function genProvinces(eng: Engine, seed: number): void {
  eng.exec((kindOf('provinceRules') ? { op: 'generate_provinces', seed } : { op: 'generate_provinces', rules: { seed } }) as unknown as Command);
}

let t = performance.now();
const results: Record<string, number> = {};
const json = process.argv.includes('--json');
const lap = (label: string, key?: string) => {
  const now = performance.now();
  if (!json) console.log(label.padEnd(28), (now - t).toFixed(0), 'ms');
  if (key) results[key] = Math.round(now - t);
  t = now;
};
const globe = process.argv.includes('--globe');
const kept = process.argv.includes('--kept');
const library = kept || process.argv.includes('--library');
const noWater = process.argv.includes('--no-water');
const packArg = process.argv.indexOf('--pack');
const pack = packArg >= 0 ? process.argv[packArg + 1] : null;
const EARTH_CELLS = planetCells(PLANET_SIZES.earth.radiusKm);
const cellsArg = process.argv.slice(2).find((a, k, all) => !a.startsWith('--') && all[k - 1] !== '--pack' && all[k - 1] !== '--era');

// 后加的接口（旧的提交上没有）：没有时为 undefined
type Laps = { sample?: number; scan?: number; solve?: number; finish?: number };
const elevLaps = (Elev as unknown as { elevationLaps?: Laps }).elevationLaps;
const terrLaps = (Terr as unknown as { terrainLaps?: Laps }).terrainLaps;
const memo = Elev.elevationMemo;
// 描河并打包、海岸场（旧的提交上没有时跳过）
const worldRivers = (RiverPack as unknown as { worldRivers?: (w: Engine['world']) => unknown }).worldRivers;
const displayCoast = (Display as unknown as { displayCoast?: (w: Engine['world']) => unknown }).displayCoast;
// 加工各步（抬山到重做）：它们的 .rivers、.coast 加起来记成 rivers、coast
const EDIT_STEPS = new Set(['relief', 'erod', 'tempBrush', 'paintLand', 'island', 'reroll', 'rerollFjord', 'river', 'lake', 'humidity', 'latShift', 'undo1', 'undo2', 'undo3', 'undo4', 'undo5', 'undo6', 'redo']);


// 一个新的网格对象（与原来的逐值相同）：按网格的缓存全是空的，像刷新页面后从浏览器里读出存着的网格
function freshMesh(mesh: Mesh): Mesh {
  return unpackMesh(structuredClone(packMesh(mesh).packed));
}

// 离 c 不超过 r 格间距的格
function disc(eng: Engine, c: number, r: number): number[] {
  const { mesh } = eng.world;
  const out: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < mesh.spacing * r) out.push(i);
  return out;
}

// 内陆的一格（离海最远的那些里取第 f 个）
function inland(eng: Engine, f: number): number {
  const { mesh, causes } = eng.world;
  const land: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) continue;
    let ok = true;
    for (let e = mesh.off[i]; e < mesh.off[i + 1] && ok; e++) if (!causes.land[mesh.adj[e]]) ok = false;
    if (ok && Math.abs(mesh.y[i] - 0.5) < 0.3) land.push(i);
  }
  return land[Math.floor(land.length * f)];
}

// 海上一格（从第 f 份处往后找，离赤道不远）
function seaCell(eng: Engine, f: number): number {
  const w = eng.world;
  for (let i = Math.floor(w.mesh.n * f); i < w.mesh.n; i++) if (!w.causes.land[i] && Math.abs(w.mesh.y[i] - 0.5) < 0.25) return i;
  return 0;
}

// 从内陆一格顺着邻格往东走 len 格（不回头、只走陆地）
function riverPath(eng: Engine, src: number, len: number): number[] {
  const w = eng.world;
  const path = [src];
  const seen = new Set(path);
  for (let k = 0; k < len; k++) {
    const c = path[path.length - 1];
    let best = -1;
    for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
      const j = w.mesh.adj[e];
      if (!seen.has(j) && w.causes.land[j] && (best < 0 || w.mesh.x[j] > w.mesh.x[best])) best = j;
    }
    if (best < 0) break;
    path.push(best);
    seen.add(best);
  }
  return path;
}

// 河口：流量够显示成河、流进海里的陆格
function mouths(eng: Engine): number {
  const { mesh, causes, derived: d, small } = eng.world;
  let m = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || d.lake[i] === 1 || d.discharge[i] < small.planet.riverThreshold) continue;
    const j = d.receiver[i];
    if (j < 0 || !causes.land[j]) m++;
  }
  return m;
}

const stageKeys = ['elevation', 'climate', 'solve', 'hydrology', 'vegetation', 'human', 'features'] as const;

// 计一步：总耗时、各阶段（这一步真的重算了才有）、高程的分段与计数。
// 分段的计时（elevationLaps、terrainLaps）是累加的，这里取前后之差
function measure(eng: Engine, key: string, label: string, run: () => void, stages = true) {
  const c0 = memo.computed;
  const l0 = { ...(elevLaps ?? {}) };
  const s0 = terrLaps?.sample ?? 0;
  const before = eng.lastTimings;
  t = performance.now();
  run();
  const ms = performance.now() - t;
  results[key] = Math.round(ms);
  const tm = eng.lastTimings;
  const parts: string[] = [];
  if (stages && tm !== before) {
    for (const k of stageKeys) {
      const v = tm[k];
      if (v === undefined) continue;
      results[`${key}.${k}`] = Math.round(v);
      parts.push(`${k} ${Math.round(v)}`);
    }
    results[`${key}.apply`] = Math.round(ms - tm.total);
    parts.push(`apply ${Math.round(ms - tm.total)}`);
  }
  if (terrLaps) {
    const v = (terrLaps.sample ?? 0) - s0;
    results[`${key}.sample`] = Math.round(v);
    if (v >= 1) parts.push(`generator sample ${Math.round(v)}`);
  }
  if (elevLaps) {
    const d = (['scan', 'solve', 'finish'] as const).map((k) => (elevLaps[k] ?? 0) - (l0[k] ?? 0));
    d.forEach((v, j) => (results[`${key}.elev.${['scan', 'solve', 'finish'][j]}`] = Math.round(v)));
    if (d.some((v) => v > 0)) parts.push(`elev scan/solve/finish ${d.map((v) => Math.round(v)).join('/')}`);
  }
  // Worker 在每一步之后描河并打包（src/worker.ts 的 snapshot → worldRivers：读的东西没变时用上一次的）；
  // 主线程按新的高程数组重算地形层的海岸场（src/render/colors.ts → displayCoast：高程换一份副本，像收到的新数组）
  if (worldRivers) {
    const a = performance.now();
    worldRivers(eng.world);
    const v = performance.now() - a;
    results[`${key}.rivers`] = Math.round(v);
    parts.push(`rivers ${Math.round(v)}`);
    if (EDIT_STEPS.has(key)) results.rivers = (results.rivers ?? 0) + v;
  }
  if (displayCoast) {
    const w = eng.world;
    const copy = { ...w, derived: { ...w.derived, elevation: w.derived.elevation.slice() } };
    const a = performance.now();
    displayCoast(copy);
    const v = performance.now() - a;
    results[`${key}.coast`] = Math.round(v);
    parts.push(`coast ${Math.round(v)}`);
    if (EDIT_STEPS.has(key)) results.coast = (results.coast ?? 0) + v;
  }
  results[`${key}#landmasses`] = memo.computed - c0;
  results[`${key}#lakes`] = eng.world.derived.features.filter((f) => f.type === 'lake').length;
  results[`${key}#mouths`] = mouths(eng);
  if (!json) {
    console.log(label.padEnd(28), ms.toFixed(0).padStart(5), 'ms', `  [${memo.computed - c0} landmasses]`);
    if (parts.length) console.log('    ', parts.join(', '));
  }
  t = performance.now();
}

// 第五十七轮：新世界默认带现实的水系。--no-water 把它们从新世界的内容里去掉（和同一个提交带着的对照；旧的提交上没有，加不加一样）
function withoutWaterTypes(cmds: readonly Command[]): Command[] {
  const one = (c: Command): Command[] => {
    if (c.op === 'batch') return [{ ...c, commands: c.commands.flatMap(one) }];
    return c.op === 'set_river_type' || c.op === 'set_lake_type' ? [] : [c];
  };
  return cmds.flatMap(one);
}

function plainBench() {
  const settings = globe ? { ...planetSettings('earth', Number(cellsArg ?? EARTH_CELLS)), seed: 3 } : { seed: 3, cells: Number(cellsArg ?? 40000) };
  t = performance.now();
  const eng = new Engine(settings);
  lap('mesh', 'mesh');
  const content = noWater ? withoutWaterTypes(newWorldContentCommands()) : newWorldContentCommands();
  measure(eng, 'newWorld', 'new world', () => eng.exec({ op: 'batch', commands: [...content, { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] }));
  const w = eng.world;
  results.riverTyped = w.derived.riverType?.reduce((a, v) => a + (v ? 1 : 0), 0) ?? 0;
  if (library) {
    if (!builtinPacks().some((p) => p.id === era)) throw new Error(`没有这个时代：${era}`);
    for (const c of packImportCommands(builtinPacks(), { packs: [[era]] }, w)) eng.exec(c);
    lap('import library', 'library');
    if (kept) {
      genProvinces(eng, 3);
      genHuman(eng, { countries: {}, settlements: {} });
      eng.update();
      lap('generate human', 'genHuman');
      // 重新生成国家（第七十九轮：各时代的国家格局）：三个种子各一次再撤销，取中位数
      const regen: number[] = [];
      for (const seed of [5, 6, 7]) {
        const a = performance.now();
        eng.exec({ op: 'regenerate_countries', seed } as Command);
        eng.update();
        regen.push(performance.now() - a);
        eng.undo();
        eng.update();
      }
      results.regenCountries = Math.round([...regen].sort((a, b) => a - b)[1]);
      if (!json) console.log('regenerate countries'.padEnd(28), String(results.regenCountries).padStart(5), 'ms');
      results['genHuman#countries'] = Object.keys(w.small.countries ?? {}).length;
    }
    results.smallKB = Math.round(JSON.stringify(w.small).length / 1000);
    results.contentKB = Math.round(JSON.stringify(w.small.content ?? {}).length / 1000);
    t = performance.now();
  }

  // 抬山：内陆一笔（半径 6 格）
  const hill = disc(eng, inland(eng, 0.3), 6);
  measure(eng, 'relief', 'relief (raise mountains)', () => eng.exec({ op: 'paint_relief', cells: hill, t: hill.map((_, k) => (k % 5) / 5), strength: 0.7 }));
  // 岩性（易蚀）
  const soft = disc(eng, inland(eng, 0.45), 6);
  measure(eng, 'erod', 'erodibility', () => eng.exec({ op: 'paint', field: 'erodDelta', cells: soft, value: 0.5, mode: 'add' }));
  // 冷暖画笔
  const cold = disc(eng, inland(eng, 0.6), 8);
  measure(eng, 'tempBrush', 'temperature brush', () => eng.exec({ op: 'paint', field: 'tempOffset', cells: cold, values: cold.map(() => -1), mode: 'add' }));
  // 画陆地：沿海的一笔（真改海陆）
  const stroke = coastalStroke(w, 0.37, 8);
  measure(eng, 'paintLand', 'paint land', () => eng.exec({ op: 'paint_land', cells: stroke, t: stroke.map(() => 0), mode: 'land' }));
  // 放岛（海上一格）
  const sea = seaCell(eng, 0.41);
  measure(eng, 'island', 'add island', () => eng.exec({ op: 'add_island', island: { x: w.mesh.x[sea], y: w.mesh.y[sea], kind: 'continental', size: 300, variant: 0 } }));
  // 重新生成一片
  const rr = inland(eng, 0.5);
  measure(eng, 'reroll', 'reroll area', () => eng.exec({ op: 'reroll_region', x: w.mesh.x[rr], y: w.mesh.y[rr], radius: 0.08, variant: 1 }));
  // 第三十六轮：冰川峡湾海岸上重新生成一片（峡湾权重最大的海岸陆格；没有海岸类型的旧提交上跳过）
  const fc = fjordCoastCell(w);
  if (fc >= 0) measure(eng, 'rerollFjord', 'reroll area (fjord coast)', () => eng.exec({ op: 'reroll_region', x: w.mesh.x[fc], y: w.mesh.y[fc], radius: 0.05, variant: 2 }));
  // 画河（固定走向、带泉水）
  const path = riverPath(eng, inland(eng, 0.7), 20);
  measure(eng, 'river', 'draw river (guide)', () => eng.exec({ op: 'add_guide', guide: { cells: path, locked: true, spring: true, flow: 4, name: '' } }));
  // 放湖
  const lc = inland(eng, 0.4);
  measure(eng, 'lake', 'add lake', () => eng.exec({ op: 'add_lake', lake: { cell: lc, radius: 150, depth: 120, perennial: true } }));
  // 湿度滑块（只改气候）
  measure(eng, 'humidity', 'humidity', () => eng.exec({ op: 'set_planet', patch: { humidity: 1.2 } }));
  // 纬度（一块地区）；整个星球不能南北挪，改轴倾角（同样是只改气候、要重算风）
  if (globe) measure(eng, 'latShift', 'tilt (planet)', () => eng.exec({ op: 'set_planet', patch: { tilt: 26 } }));
  else measure(eng, 'latShift', 'latShift', () => eng.exec({ op: 'set_planet', patch: { latShift: 3 } }));

  for (let k = 1; k <= 6; k++) measure(eng, `undo${k}`, `undo ${k}`, () => eng.undo(), false);
  measure(eng, 'redo', 'redo', () => eng.redo(), false);
  if (results.rivers !== undefined) {
    results.rivers = Math.round(results.rivers);
    if (!json) console.log('rivers (edits, summed)'.padEnd(28), String(results.rivers).padStart(5), 'ms');
  }
  if (results.coast !== undefined) {
    results.coast = Math.round(results.coast);
    if (!json) console.log('coast (edits, summed)'.padEnd(28), String(results.coast).padStart(5), 'ms');
  }
  while (eng.canRedo) eng.redo();
  t = performance.now();

  // 打开后的第一笔：从检查点恢复到新的网格上（所有按网格的缓存都是空的），再抬一笔山
  const doc = eng.toDoc();
  const cp = eng.toCheckpoint();
  const hill2 = disc(eng, inland(eng, 0.55), 6);
  const relief2: Command = { op: 'paint_relief', cells: hill2, t: hill2.map(() => 0), strength: 0.6 };
  {
    const mesh = freshMesh(w.mesh);
    t = performance.now();
    const cold = Engine.fromCheckpoint(structuredClone(cp), doc, mesh)!;
    lap('open: checkpoint restore', 'openCheckpoint');
    measure(cold, 'coldRelief', 'first edit after open (cold)', () => cold.exec(relief2));
  }
  // 同上，但先空闲预热（Worker 打开后空闲时做的那些，见 Engine.warmSteps）
  {
    const mesh = freshMesh(w.mesh);
    const warm = Engine.fromCheckpoint(structuredClone(cp), doc, mesh)!;
    const steps = (warm as unknown as { warmSteps?: () => Generator<void> }).warmSteps?.();
    if (steps) {
      let worst = 0;
      let chunks = 0;
      t = performance.now();
      for (;;) {
        const a = performance.now();
        const r = steps.next();
        worst = Math.max(worst, performance.now() - a);
        if (r.done) break;
        chunks++;
      }
      lap(`warm-up (${chunks + 1} chunks)`, 'warmup');
      results.warmupLongestChunk = Math.round(worst);
      if (!json) console.log('    longest chunk', Math.round(worst), 'ms');
      measure(warm, 'warmRelief', 'first edit after warm-up', () => warm.exec(relief2));
    }
  }
  // 一直开着的世界上同一笔（缓存都是热的）
  measure(eng, 'hotRelief', 'same edit, long-open world', () => eng.exec(relief2));
  if (library) libraryBench(eng);
  classBench(eng, hill);

  if (process.argv.includes('--long')) longBench(eng);
  if (process.argv.includes('--human')) humanBench(eng);
  if (process.argv.includes('--hash')) printHashes(eng);
  if (json) console.log(JSON.stringify(results));
}

// 涂地形类别（第五十八轮）：抬山（relief）同样的笔画、同样的大小，同一个进程里交替，各涂一笔再撤销，21 次的中位数。
// classHeight：力度 0.5 的山地（门槛：不超过 classRelief）；classOnly：力度 0，只改类别（旧的提交上三步都有，classHeight 在那里也只改类别）。
// 放在最后：不影响前面各步的世界
function classBench(eng: Engine, cells: number[]) {
  const t0 = cells.map((_, k) => (k % 5) / 5);
  const steps: [string, Command][] = [
    ['classRelief', { op: 'paint_relief', cells, t: t0, strength: 0.7 }],
    ['classHeight', { op: 'set_cell_class', cells, class: 'mountains', strength: 0.5, t: t0 } as Command],
    ['classOnly', { op: 'set_cell_class', cells, class: 'mountains' }],
  ];
  const ms = new Map<string, number[]>(steps.map(([k]) => [k, []]));
  for (let round = 0; round < 21; round++) {
    for (let j = 0; j < steps.length; j++) {
      const [key, cmd] = steps[(j + round) % steps.length];
      const a = performance.now();
      eng.exec(cmd);
      ms.get(key)!.push(performance.now() - a);
      eng.undo();
    }
  }
  for (const [key, v] of ms) {
    results[key] = Math.round([...v].sort((a, b) => a - b)[v.length >> 1] * 100) / 100;
    if (!json) console.log(key.padEnd(28), results[key].toFixed(2).padStart(7), 'ms');
  }
}

// 带库的世界上不重算推导的几步：这里几乎只有小数据的开销（序列化、比较、解析、克隆）。几十次的中位数，两位小数。
// 键都不带“.”“#”，对照表里直接列出来。旧的提交上也能跑（第三十七轮起有 set_map_style）
function libraryBench(eng: Engine) {
  const w = eng.world;
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
  const time = (run: () => void) => {
    const a = performance.now();
    run();
    return performance.now() - a;
  };
  const put = (key: string, label: string, v: number[]) => {
    results[key] = Math.round(median(v) * 100) / 100;
    if (!json) console.log(label.padEnd(28), results[key].toFixed(2).padStart(7), 'ms');
  };
  const N = 41;
  const styles = Object.keys(w.small.content?.mapStyle ?? {});
  const style: Command = { op: 'set_map_style', id: styles.find((id) => id !== w.small.mapStyle) ?? styles[0] };
  const edit: number[] = [];
  const undo: number[] = [];
  const redo: number[] = [];
  for (let k = 0; k < N; k++) {
    edit.push(time(() => eng.exec(style)));
    undo.push(time(() => eng.undo()));
    redo.push(time(() => eng.redo()));
    eng.undo();
  }
  put('libEdit', 'edit, no recompute', edit);
  put('libUndo', 'undo of it', undo);
  put('libRedo', 'redo of it', redo);
  // 改一项内容（一种里的一项换掉）与它的撤销；改回一模一样的一项：“没有变化”，不进历史
  const points = (w.small.content?.pointType ?? {}) as Record<string, { id: string; name: string }>;
  const point = Object.values(points)[0];
  const changed: Command = { op: 'set_content', kind: 'pointType', id: point.id, item: { ...point, name: `${point.name}2` } };
  const same: Command = { op: 'set_content', kind: 'pointType', id: point.id, item: { ...point } };
  const content: number[] = [];
  const contentUndo: number[] = [];
  const noop: number[] = [];
  for (let k = 0; k < N; k++) {
    content.push(time(() => eng.exec(changed)));
    contentUndo.push(time(() => eng.undo()));
    noop.push(time(() => eng.exec(same)));
  }
  put('libContent', 'edit one content item', content);
  put('libContentUndo', 'undo of it', contentUndo);
  put('libNoop', 'edit that changes nothing', noop);
  // 发给主线程的小数据（Worker 的快照，结构化克隆）：内容没变时不发（没有 postedSmall 的旧提交上是整份）
  const posted = (Commands as unknown as { postedSmall?: (s: typeof w.small) => unknown }).postedSmall?.(w.small) ?? w.small;
  put('libPost', 'small posted to main thread', Array.from({ length: N }, () => time(() => structuredClone(posted))));
  // 撤销记录：每步留下多少字（一个字符 1–2 字节）。内容共用以后只有不是内容的部分
  const steps = (eng as unknown as { done: { undo: { small: string } }[] }).done;
  results.undoKB = Math.round(steps[steps.length - 1].undo.small.length / 1000);
  if (!json) console.log('undo record of the last step'.padEnd(28), String(results.undoKB).padStart(7), 'k chars');
  if (kept) {
    // 改人口（要重算人文的几层）、改国家档案（不重算）、存世界文件
    const cells = disc(eng, inland(eng, 0.5), 3);
    const culture = Object.values(w.small.popGroups ?? {})[0].culture;
    const paint: Command = { op: 'paint_culture', cells, culture, amount: 0.3 };
    const human: number[] = [];
    const humanUndo: number[] = [];
    for (let k = 0; k < 11; k++) {
      human.push(time(() => {
        eng.exec(paint);
        eng.update();
      }));
      humanUndo.push(time(() => {
        eng.undo();
        eng.update();
      }));
    }
    put('libHuman', 'paint culture', human);
    put('libHumanUndo', 'undo of it', humanUndo);
    const id = Object.values(w.small.countries ?? {})[0].id;
    const rename: Command = { op: 'set_country', id, patch: { name: '测速国' } };
    const country: number[] = [];
    const countryUndo: number[] = [];
    for (let k = 0; k < N; k++) {
      country.push(time(() => eng.exec(rename)));
      countryUndo.push(time(() => eng.undo()));
    }
    put('libCountry', 'edit a country', country);
    put('libCountryUndo', 'undo of it', countryUndo);
    put('libSaveDoc', 'world file to text', Array.from({ length: 11 }, () => time(() => JSON.stringify(eng.toDoc()))));
    results.docKB = Math.round(JSON.stringify(eng.toDoc()).length / 1000);
    if (!json) console.log('world file'.padEnd(28), String(results.docKB).padStart(7), 'k chars');
  }
  t = performance.now();
}

// 峡湾权重最大的海岸陆格（挨着海的陆格；core/coast-style.ts 的 fjord）；没有时 −1
function fjordCoastCell(w: Engine['world']): number {
  const cs = (CoastStyle as unknown as { coastStyle?: (w: Engine['world']) => { fjord: Float32Array } | null }).coastStyle;
  const st = cs ? cs(w) : null;
  if (!st) return -1;
  const { mesh } = w;
  let best = -1;
  for (let i = 0; i < mesh.n; i++) {
    if (!w.causes.land[i] || st.fjord[i] < 0.5) continue;
    let coast = false;
    for (let e = mesh.off[i]; e < mesh.off[i + 1] && !coast; e++) if (!w.causes.land[mesh.adj[e]]) coast = true;
    if (coast && (best < 0 || st.fjord[i] > st.fjord[best])) best = i;
  }
  return best;
}

// --long：约 200 条混合命令的文档（按固定的种子挑，结果确定），计整段重放与从检查点恢复。
// 命令在一个引擎上只应用不重算（与重放相同的 applyOnly），所以造文档本身只花一次重放的时间
function longBench(src: Engine) {
  const settings = src.world.settings;
  const eng = new Engine(settings, freshMesh(src.world.mesh));
  const apply = (cmd: Command) => (eng as unknown as { applyOnly(c: Command): unknown }).applyOnly(cmd);
  apply({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  const w = eng.world;
  const rnd = mulberry32(31);
  const landCells = () => {
    const out: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i]) out.push(i);
    return out;
  };
  let land = landCells();
  const pickLand = () => land[Math.floor(rnd() * land.length)];
  const kinds = ['relief', 'relief', 'relief', 'erod', 'temp', 'temp', 'moist', 'land', 'sea', 'island', 'lake', 'river', 'reroll', 'humidity'] as const;
  let count = 0;
  for (let k = 0; k < 200; k++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const c = pickLand();
    const r = 3 + Math.floor(rnd() * 5);
    const cells = disc(eng, c, r);
    let cmd: Command;
    switch (kind) {
      case 'relief':
        cmd = { op: 'paint_relief', cells, t: cells.map(() => rnd()), strength: rnd() < 0.7 ? 0.6 : -0.4 };
        break;
      case 'erod':
        cmd = { op: 'paint', field: 'erodDelta', cells, value: rnd() < 0.5 ? 0.4 : -0.3, mode: 'add' };
        break;
      case 'temp':
        cmd = { op: 'paint', field: 'tempOffset', cells, value: rnd() < 0.5 ? 1.5 : -1.5, mode: 'add' };
        break;
      case 'moist':
        cmd = { op: 'paint', field: 'moistOffset', cells, value: rnd() < 0.5 ? 0.3 : -0.3, mode: 'add' };
        break;
      case 'land':
      case 'sea': {
        const s = coastalStroke(w, rnd(), r);
        cmd = { op: 'paint_land', cells: s, t: s.map(() => rnd() * 0.5), mode: kind };
        break;
      }
      case 'island': {
        const s = seaCell(eng, rnd());
        cmd = { op: 'add_island', island: { x: w.mesh.x[s], y: w.mesh.y[s], kind: 'continental', size: 100 + Math.floor(rnd() * 300), variant: k } };
        break;
      }
      case 'lake':
        cmd = { op: 'add_lake', lake: { cell: c, radius: 40 + rnd() * 120, depth: 30 + rnd() * 150, perennial: rnd() < 0.5 } };
        break;
      case 'river': {
        const p = riverPath(eng, c, 8 + Math.floor(rnd() * 12));
        if (p.length < 2) continue;
        cmd = { op: 'add_guide', guide: { cells: p, locked: true, spring: true, flow: 1 + Math.floor(rnd() * 6), name: '' } };
        break;
      }
      case 'reroll':
        cmd = { op: 'reroll_region', x: w.mesh.x[c], y: w.mesh.y[c], radius: 0.04 + rnd() * 0.06, variant: k + 1 };
        break;
      case 'humidity':
        cmd = { op: 'set_planet', patch: { humidity: 0.8 + rnd() * 0.6 } };
        break;
    }
    apply(cmd);
    count++;
    if (kind === 'land' || kind === 'sea' || kind === 'island' || kind === 'reroll') land = landCells();
  }
  eng.update();
  const doc = eng.toDoc();
  t = performance.now();
  const replayed = Engine.fromDoc(doc, freshMesh(w.mesh));
  lap(`long: replay ${doc.commands.length} cmds (${count} mixed)`, 'longReplay');
  const cp = structuredClone(replayed.toCheckpoint());
  const mesh = freshMesh(w.mesh);
  t = performance.now();
  Engine.fromCheckpoint(cp, doc, mesh);
  lap('long: checkpoint restore', 'longCheckpoint');
  if (digest(replayed.world.derived.elevation) !== digest(eng.world.derived.elevation)) throw new Error('重放与逐条应用的高程不同');
}

// --human：人文的旧步骤（第二十一到二十四轮），只打印
function humanBench(eng: Engine) {
  t = performance.now();
  genProvinces(eng, 3);
  lap('provinces');
  const land = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.land[i]).slice(0, 300);
  eng.exec({ op: 'set_cell_class', cells: land.slice(0, 120), class: 'hills' });
  lap('paint terrain class (human)');
  eng.exec({ op: 'set_cell_resource', cells: land.slice(0, 120), resource: 'iron' });
  lap('paint resource (human)');
  for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']], groups: medievalGroups().map((g) => g.id) }, eng.world)) eng.exec(c);
  genHuman(eng, { countries: {} });
  lap(`generate human + countries (${Object.keys(eng.world.small.countries ?? {}).length})`);
  const peopled = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.popTotal![i] > 0).slice(1000, 1120);
  eng.exec({ op: 'paint_culture', cells: peopled, culture: Object.keys(eng.world.small.content?.culture ?? {})[0], amount: 0.5 });
  lap('paint culture (human)');
  eng.exec({ op: 'paint_pop', cells: peopled, mode: 'count', factor: 1.5 });
  lap('paint count (human)');
  eng.undo();
  lap('undo paint (human)');
  eng.exec({ op: 'regenerate_countries' });
  lap(`regenerate countries (${Object.keys(eng.world.small.countries ?? {}).length})`);
  const first = Number(Object.keys(eng.world.small.countries ?? {})[0]);
  eng.exec({ op: 'paint_country', cells: peopled, country: first });
  lap('paint country (human)');
  eng.exec({ op: 'generate_settlements' });
  lap(`generate settlements (${Object.keys(eng.world.small.cities ?? {}).length} cities, ${Object.keys(eng.world.small.roads ?? {}).length} roads)`);
  eng.exec({ op: 'regenerate_roads' });
  lap('regenerate roads');
}

function fantasyBench() {
  const eng = new Engine({ seed: 3, cells: Number(cellsArg ?? EARTH_CELLS), globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 });
  lap('mesh', 'mesh');
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  lap('new world', 'newWorld');
  // 第三十轮：以前的“奇幻生态示例”是内置的树“奇幻”里的生态、河、湖几个小包
  for (const c of packImportCommands(builtinPacks(), { packs: [['fantasy', 'biomes'], ['fantasy', 'rivers'], ['fantasy', 'lakes']] }, eng.world)) eng.exec(c);
  lap('apply fantasy pack', 'pack');
  const w = eng.world;
  const stage = (label: string) => {
    if (json) return;
    const tm = eng.lastTimings;
    console.log('   ', label, Object.entries(tm).map(([k, v]) => `${k} ${Math.round(v as number)}`).join(', '));
  };
  stage('pack');

  // 画陆地：沿海的一笔（预览 + 采用 = 用户画完松手；这里分开计）
  const stroke = coastalStroke(w, 0.37, 8);
  const paint = { op: 'paint_land' as const, cells: stroke, t: stroke.map(() => 0), mode: 'land' as const };
  t = performance.now();
  // 预览分阶段算：最长的一段就是松手执行别的命令时最多要等多久（Worker 在阶段之间停下预览）
  if (!eng.previewSteps) eng.preview(paint);
  else {
    const steps = eng.previewSteps(paint);
    let worst = 0;
    for (;;) {
      const a = performance.now();
      const r = steps.next();
      worst = Math.max(worst, performance.now() - a);
      if (r.done) break;
    }
    results.previewLongestStage = Math.round(worst);
    if (!json) console.log('    longest stage of the preview', Math.round(worst), 'ms');
  }
  lap('paint land preview', 'paintLandPreview');
  eng.exec(paint);
  lap('paint land exec (adopt)', 'paintLandAdopt');
  eng.undo();
  lap('(undo it)');
  eng.exec(paint);
  lap('paint land exec (no preview)', 'paintLand');
  stage('paint land');

  // 堆山
  const hill = disc(eng, inland(eng, 0.3), 6);
  eng.exec({ op: 'paint_relief', cells: hill, t: hill.map(() => 0), strength: 0.7 });
  lap('relief', 'relief');
  stage('relief');

  // 放岛（海上一格）
  const sea = seaCell(eng, 0.41);
  eng.exec({ op: 'add_island', island: { x: w.mesh.x[sea], y: w.mesh.y[sea], kind: 'continental', size: 300, variant: 0 } });
  lap('island', 'island');
  stage('island');

  // 冷暖画笔
  const cold = disc(eng, inland(eng, 0.6), 8);
  eng.exec({ op: 'paint', field: 'tempOffset', cells: cold, values: cold.map(() => -1), mode: 'add' });
  lap('climate brush', 'climateBrush');
  stage('climate brush');

  // 自然融入的生态
  const nat = disc(eng, inland(eng, 0.5), 6).filter((i) => w.causes.land[i]);
  eng.exec({ op: 'add_constraint', constraint: { cells: nat, species: 'crystal_jungle', mode: 'constraint', ratio: 1, radius: 400, label: '' } });
  lap('natural biome paint', 'naturalBiome');
  stage('natural biome');

  // 湿度滑块（停下时预览、松手采用）
  const hum = { op: 'set_planet' as const, patch: { humidity: 1.2 } };
  t = performance.now();
  eng.preview(hum);
  lap('humidity preview', 'humidityPreview');
  eng.exec(hum);
  lap('humidity exec (adopt)', 'humidityAdopt');
  stage('humidity');

  // 画河：从内陆一格顺着邻格往下走 20 格（不回头）
  const path = riverPath(eng, inland(eng, 0.7), 20);
  const river = { op: 'add_guide' as const, guide: { cells: path, locked: true, spring: true, flow: 4, name: '' } };
  t = performance.now();
  eng.preview(river);
  lap('river preview', 'riverPreview');
  eng.exec(river);
  lap('river exec (adopt)', 'riverAdopt');
  stage('river');

  for (let k = 1; k <= 6; k++) {
    eng.undo();
    lap(`undo ${k}`, `undo${k}`);
  }
  eng.redo();
  lap('redo', 'redo');
  // 重做回去，后面的打开按全部命令
  while (eng.canRedo) eng.redo();
  lap('(redo rest)');

  const doc = eng.toDoc();
  const cp = structuredClone(eng.toCheckpoint());
  lap('(checkpoint clone)');
  Engine.fromDoc(doc, eng.world.mesh);
  lap(`open: replay ${doc.commands.length} cmds`, 'openReplay');
  Engine.fromCheckpoint(cp, doc, eng.world.mesh);
  lap('open: checkpoint restore', 'openCheckpoint');
  if (process.argv.includes('--hash')) printHashes(eng);
  if (json) console.log(JSON.stringify(results));
}

// --hash：最后的世界每个数组的哈希（优化前后对照逐值一致用）
function printHashes(eng: Engine) {
  const w = eng.world;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(w.causes)) if (ArrayBuffer.isView(v)) out[`causes.${k}`] = digest(v);
  for (const [k, v] of Object.entries(w.causes.fields)) out[`fields.${k}`] = digest(v);
  for (const [k, v] of Object.entries(w.derived)) out[`derived.${k}`] = digest(ArrayBuffer.isView(v) ? v : v ?? null);
  for (const [k, v] of Object.entries(w.derived.corrF)) out[`corrF.${k}`] = digest(v);
  out.small = digest(w.small);
  console.error(JSON.stringify(out, null, 1));
}

if (pack) {
  if (pack !== 'fantasy') throw new Error(`没有这个资源包：${pack}`);
  fantasyBench();
} else plainBench();
