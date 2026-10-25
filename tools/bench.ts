// 计时：各阶段耗时
//   npx tsx tools/bench.ts [格数] [--globe]：--globe 是整个星球（默认是新建类地星球的格数，每格约 100 km，见 planetCells）
//   npx tsx tools/bench.ts --globe --pack fantasy [--json]：整个星球 + 奇幻示例包，按用户平时的操作逐步计时
//     （新建、用资源包、画陆地、堆山、放岛、冷暖、自然融入的生态、湿度滑块、画河的预览与执行、撤销 6 次、重做、
//     打开（整段重放）、从检查点恢复）。--json 最后一行打出 { 步骤: 毫秒 }，tools/bench-median.mjs 取几次的中位数
import { cityList, settleInputs } from '../core/human';
import { generateCities } from '../core/human/settlements';
import { generateRoads } from '../core/human/roads';
import { generateLandmarks } from '../core/human/landmarks';
import { settlementRules } from '../core/human/settle-gen';
import { archiveMarkdown } from '../core/human/archive';
import { Engine } from '../core/engine';
import { applyPackCommands } from '../core/packs';
import { PLANET_SIZES, planetCells } from '../core/presets';
import { FANTASY_PACK } from '../core/packs/fantasy';
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

if (pack) {
  if (pack !== 'fantasy') throw new Error(`没有这个资源包：${pack}`);
  fantasyBench();
} else plainBench();

function plainBench() {
  const eng = new Engine(
    globe
      ? { seed: 3, cells: Number(cellsArg ?? EARTH_CELLS), globe: true, aspect: 2, latNorth: 90, latSouth: -90 }
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
  console.log('  human layers', eng.lastTimings.human?.toFixed(0), 'ms');
  // 第二十一轮：画地形类别、资源（只重算人文的几层与名字）
  eng.exec({ op: 'set_cell_class', cells: land.slice(0, 120), class: 'hills' });
  lap('paint terrain class (human)');
  eng.exec({ op: 'set_cell_resource', cells: land.slice(0, 120), resource: 'iron' });
  lap('paint resource (human)');
  // 第二十二轮：生成人文（文化圈 + 人口）、人口与文化笔刷、撤销
  eng.exec({ op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }, { id: 'steppe', weight: 1.5 }] });
  lap('generate human');
  const peopled = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.popTotal![i] > 0).slice(1000, 1120);
  eng.exec({ op: 'paint_culture', cells: peopled, culture: 'frankish', amount: 0.5 });
  lap('paint culture (human)');
  eng.exec({ op: 'paint_pop', cells: peopled, mode: 'value', dimension: 'religion', value: 'moon-faith', amount: 0.5 });
  lap('paint religion (human)');
  eng.exec({ op: 'paint_pop', cells: peopled, mode: 'count', factor: 1.5 });
  lap('paint count (human)');
  eng.undo();
  lap('undo paint (human)');
  // 第二十三轮：连同国家生成人文（与上面的 generate human 比，多出来的是国家的两步）、生成国家（另重分人口）、领土笔刷、撤销、改档案
  eng.exec({ op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }, { id: 'steppe', weight: 1.5 }], countries: {} });
  lap(`generate human + countries (${Object.keys(eng.world.small.countries ?? {}).length})`);
  eng.exec({ op: 'regenerate_countries', fragmentation: 0.7 });
  lap(`regenerate countries (${Object.keys(eng.world.small.countries ?? {}).length})`);
  const first = Number(Object.keys(eng.world.small.countries ?? {})[0]);
  eng.exec({ op: 'paint_country', cells: peopled, country: first });
  lap('paint country (human)');
  eng.exec({ op: 'paint_country', cells: peopled.slice(0, 60), country: null });
  lap('paint unclaimed (human)');
  eng.undo();
  lap('undo paint country');
  eng.exec({ op: 'set_country', id: first, patch: { government: 'empire' } });
  lap('set country');
  // 第二十四轮：城市、道路、地标（分开计时）、档案与列表、编辑、撤销
  {
    const S = settleInputs(eng.world, eng.world.derived);
    const next = eng.world.small.nextSettlement;
    const rules = settlementRules(eng.world);
    let t = performance.now();
    generateCities(S, rules, true);
    const tc = performance.now() - t;
    t = performance.now();
    generateRoads(S, rules, true);
    const tr = performance.now() - t;
    t = performance.now();
    generateLandmarks(S, rules, true);
    const tl = performance.now() - t;
    console.log(`  cities ${tc.toFixed(0)} ms (${Object.keys(eng.world.small.cities ?? {}).length}), roads ${tr.toFixed(0)} ms (${Object.keys(eng.world.small.roads ?? {}).length}), landmarks ${tl.toFixed(0)} ms (${Object.keys(eng.world.small.landmarks ?? {}).length})`);
    delete eng.world.small.cities;
    delete eng.world.small.roads;
    delete eng.world.small.landmarks;
    // 直接调的不走命令：编号退回去，重放才一样
    if (next === undefined) delete eng.world.small.nextSettlement;
    else eng.world.small.nextSettlement = next;
  }
  lap('(settlements by step)');
  eng.exec({ op: 'generate_settlements' });
  lap(`generate settlements (${Object.keys(eng.world.small.cities ?? {}).length} cities, ${Object.keys(eng.world.small.roads ?? {}).length} roads)`);
  cityList(eng.world);
  lap('city table (first)');
  cityList(eng.world);
  lap('city table (cached)');
  const someCity = cityList(eng.world).find((c) => !c.capital)!;
  eng.exec({ op: 'set_city', id: someCity.id, patch: { rank: 'big' } });
  lap('set city');
  const freeCell = [...Array(eng.world.mesh.n).keys()].find((i) => eng.world.causes.popTotal![i] > 0 && !cityList(eng.world).some((c) => c.cell === i))!;
  eng.exec({ op: 'move_city', id: someCity.id, cell: freeCell });
  lap('move city (reroute roads)');
  eng.undo();
  lap('undo move city');
  eng.exec({ op: 'regenerate_roads' });
  lap('regenerate roads');
  archiveMarkdown(eng.world);
  lap('archive.md');
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'sea' });
  lap('paint sea with people (repair)');
  const doc = eng.toDoc();
  Engine.fromDoc(doc, eng.world.mesh);
  lap(`fromDoc replay (${doc.commands.length} commands)`);
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

function fantasyBench() {
  const eng = new Engine({ seed: 3, cells: Number(cellsArg ?? EARTH_CELLS), globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 });
  lap('mesh', 'mesh');
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
  lap('new world', 'newWorld');
  eng.exec(applyPackCommands(eng.world, FANTASY_PACK));
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
  let sea = 0;
  for (let i = Math.floor(w.mesh.n * 0.41); i < w.mesh.n; i++) if (!w.causes.land[i] && Math.abs(w.mesh.y[i] - 0.5) < 0.25) {
    sea = i;
    break;
  }
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
  const src = inland(eng, 0.7);
  const path = [src];
  const seen = new Set(path);
  for (let k = 0; k < 20; k++) {
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
