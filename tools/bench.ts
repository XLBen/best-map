// 计时：各阶段耗时
//   npx tsx tools/bench.ts [格数] [--globe] [--json] [--long] [--human]：一块地区（默认 4 万格）或整个星球（--globe，
//     默认是新建类地星球的格数，每格约 100 km，见 planetCells），按用户平时的加工逐步计时（第三十一轮补全）：
//     新建、抬山、岩性、冷暖笔、画陆地、放岛、重新生成一片、画河、放湖、湿度、纬度（星球上是轴倾角）、撤销 6 次、重做，
//     再从检查点打开后的第一笔（冷：网格是新的对象，所有按网格的缓存都是空的）、预热以后的第一笔、一直开着时的同一笔。
//     每一步另记各阶段（高程里再分生成器采样、认陆块、求解、收尾）与计数（重算了几块陆地、湖、河口）。
//     --long：再造一份约 200 条混合命令的文档，计整段重放与从检查点恢复（都在新的网格上，像重新打开）。
//     --human：再接着跑人文（省份、文化、人口、国家、城市）的旧步骤（只打印，不进 --json）
//   npx tsx tools/bench.ts --globe --pack fantasy [--json] [--hash]：整个星球 + 奇幻示例包，按用户平时的操作逐步计时
//     （新建、用资源包、画陆地、堆山、放岛、冷暖、自然融入的生态、湿度滑块、画河的预览与执行、撤销 6 次、重做、
//     打开（整段重放）、从检查点恢复）
//   --json 最后一行打出 { 步骤: 毫秒 }；键里带“.”的是这一步的某个阶段，带“#”的是计数（不是毫秒）。
//   tools/bench-median.mjs 取几次的中位数、对照两个提交（见开发说明“速度”）
//
// 这个文件要能在旧的提交上跑（bench-median 的 --at 把它复制过去）：只用到那时已有的接口，后加的（预热、高程分段）
// 用 * as 取、没有时跳过
import * as Elev from '../core/elevation';
import * as Terr from '../core/terrain';
import { Engine } from '../core/engine';
import type { Command } from '../core/commands';
import { packMesh, unpackMesh } from '../core/mesh-pack';
import type { Mesh } from '../core/mesh';
import { PLANET_SIZES, planetCells, planetSettings } from '../core/presets';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { mulberry32 } from '../core/rng';
import { coastalStroke, digest } from './hash';

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
const packArg = process.argv.indexOf('--pack');
const pack = packArg >= 0 ? process.argv[packArg + 1] : null;
const EARTH_CELLS = planetCells(PLANET_SIZES.earth.radiusKm);
const cellsArg = process.argv.slice(2).find((a, k, all) => !a.startsWith('--') && all[k - 1] !== '--pack');

// 后加的接口（旧的提交上没有）：没有时为 undefined
type Laps = { sample?: number; scan?: number; solve?: number; finish?: number };
const elevLaps = (Elev as unknown as { elevationLaps?: Laps }).elevationLaps;
const terrLaps = (Terr as unknown as { terrainLaps?: Laps }).terrainLaps;
const memo = Elev.elevationMemo;


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
  results[`${key}#landmasses`] = memo.computed - c0;
  results[`${key}#lakes`] = eng.world.derived.features.filter((f) => f.type === 'lake').length;
  results[`${key}#mouths`] = mouths(eng);
  if (!json) {
    console.log(label.padEnd(28), ms.toFixed(0).padStart(5), 'ms', `  [${memo.computed - c0} landmasses]`);
    if (parts.length) console.log('    ', parts.join(', '));
  }
  t = performance.now();
}

function plainBench() {
  const settings = globe ? { ...planetSettings('earth', Number(cellsArg ?? EARTH_CELLS)), seed: 3 } : { seed: 3, cells: Number(cellsArg ?? 40000) };
  t = performance.now();
  const eng = new Engine(settings);
  lap('mesh', 'mesh');
  measure(eng, 'newWorld', 'new world', () => eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] }));
  const w = eng.world;

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

  if (process.argv.includes('--long')) longBench(eng);
  if (process.argv.includes('--human')) humanBench(eng);
  if (process.argv.includes('--hash')) printHashes(eng);
  if (json) console.log(JSON.stringify(results));
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
  eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
  lap('provinces');
  const land = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.land[i]).slice(0, 300);
  eng.exec({ op: 'set_cell_class', cells: land.slice(0, 120), class: 'hills' });
  lap('paint terrain class (human)');
  eng.exec({ op: 'set_cell_resource', cells: land.slice(0, 120), resource: 'iron' });
  lap('paint resource (human)');
  for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']], groups: ['western', 'eastern', 'steppe'] }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [['medieval']], groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }, { id: 'steppe', weight: 1.5 }], countries: {} });
  lap(`generate human + countries (${Object.keys(eng.world.small.countries ?? {}).length})`);
  const peopled = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.popTotal![i] > 0).slice(1000, 1120);
  eng.exec({ op: 'paint_culture', cells: peopled, culture: 'frankish', amount: 0.5 });
  lap('paint culture (human)');
  eng.exec({ op: 'paint_pop', cells: peopled, mode: 'count', factor: 1.5 });
  lap('paint count (human)');
  eng.undo();
  lap('undo paint (human)');
  eng.exec({ op: 'regenerate_countries', fragmentation: 0.7 });
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
