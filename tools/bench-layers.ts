// 计时：各视图模式的着色（第三十九轮，src/render/colors.ts）
//   npx tsx tools/bench-layers.ts [--globe] [--json] [--runs 5]
//     种子 3 的一块地区（4 万格）或整个星球（--globe，类地星球的格数），划好省份、生成中世纪的人文与国家（有帝国、联邦时同盟也算），
//     按 MapView 的选项（省界、国界跟着模式）逐个模式计时：
//       full：整份 cellLayers（第三十九轮以前每次换模式都要算的）；
//       base：底子（baseLayers：smooth、other、岩性、静态层、碎岛的颜色；同一个底子的模式共用一份）；
//       mode：这一模式自己的那一层（modeLayers：平涂、分组、切线、国界、花纹、landCell）；
//       near：离边界远的格（near.ts 的 nearLayer，渲染器在空闲时算，不在换模式的那一帧里）。
//     第三十九轮以前的提交上没有 baseLayers、modeLayers：只记 full。各取几次的中位数（先热一次：静态层的缓存）。
//   --json 最后一行打出 { 模式.full / 模式.base / 模式.mode: 毫秒 }
import * as Colors from '../src/render/colors';
import type { ColorOptions } from '../src/render/colors';
import type { ViewMode } from '../src/state';
import { Engine } from '../core/engine';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { PLANET_SIZES, planetCells } from '../core/presets';
import { blocList, worldDimensions } from '../core/human';
import type { World } from '../core/world';
import type { Command } from '../core/commands';
import { kindOf } from '../core/content/registry';

// 中世纪包默认的前三个文化组与权重（第四十三轮起是 EU4 的文化组；按包里列的，旧的提交上也能跑）
const medievalGroups = () => ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => ({ id: n.id, weight: n.weight ?? 1 }));

const json = process.argv.includes('--json');
const globe = process.argv.includes('--globe');
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Number(process.argv[runsArg + 1]) : 5;

type Split = {
  baseLayers?: (w: World, o: ColorOptions) => unknown;
  modeLayers?: (w: World, o: ColorOptions) => unknown;
};
const split = Colors as unknown as Split;
// 离边界远的格（第三十九轮，渲染器在空闲时算）：旧的提交上没有 near.ts
type NearMod = { nearLayer: (mesh: World['mesh'], g: Float32Array | null, c: Float32Array | null | undefined, coast: Float32Array, lc: Uint8Array | null | undefined) => Uint8Array };
const Near = (await import('../src/render/near').catch(() => null)) as NearMod | null;

function build(): World {
  const t0 = performance.now();
  const eng = globe
    ? new Engine({ seed: 3, cells: planetCells(PLANET_SIZES.earth.radiusKm), globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 })
    : new Engine({ seed: 3, cells: 40000 });
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  // 第七十八轮起省份的命令只写种子、第七十七轮起文化组只写 id（同 tools/bench.ts：旧的提交上用旧的写法，结果一样）
  eng.exec((kindOf('provinceRules') ? { op: 'generate_provinces', seed: 3 } : { op: 'generate_provinces', rules: { seed: 3 } }) as unknown as Command);
  for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']], groups: medievalGroups().map((g) => g.id) }, eng.world)) eng.exec(c);
  const human = { op: 'generate_human', packs: [['medieval']], countries: { seed: 3 } };
  try {
    eng.exec({ ...human, groups: medievalGroups().map((g) => g.id) } as unknown as Command);
  } catch {
    eng.exec({ ...human, groups: medievalGroups() } as unknown as Command);
  }
  if (!json) console.log(`world ${eng.world.mesh.n} cells, ${Object.keys(eng.world.small.countries ?? {}).length} countries, ${blocList(eng.world.small).length} blocs (${(performance.now() - t0).toFixed(0)} ms)`);
  return eng.world;
}

// MapView 的选项：人文模式画省界、国界（文化等模式里淡），省份底图画省界，别的地理底图都不画
const HUMAN = new Set(['country', 'bloc', 'culture', 'cultureGroup', 'popDensity']);
function options(w: World, mode: ViewMode): ColorOptions {
  const human = HUMAN.has(mode) || mode.startsWith('dim:');
  return { mode, season: 'annual', focusSpecies: w.small.species[0]?.id ?? null, borders: human || mode === 'provinces', countryBorders: human && !!w.small.countries };
}

function median(f: () => void): number {
  const all: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t = performance.now();
    f();
    all.push(performance.now() - t);
  }
  all.sort((a, b) => a - b);
  return all[Math.floor(all.length / 2)];
}

const w = build();
const dims = worldDimensions(w.small).map((d) => `dim:${d.id}` as ViewMode);
const modes: ViewMode[] = ['terrain', 'dominant', 'elevation', 'temperature', 'suitability', 'habitability', 'provinces', 'terrainClass', 'resource', 'culture', 'cultureGroup', ...dims.slice(0, 1), 'popDensity', 'country', ...(blocList(w.small).length ? (['bloc'] as ViewMode[]) : [])];
// 先热一次（静态层、碎岛的颜色等按世界的缓存）
Colors.cellLayers(w, options(w, 'terrain'));
const out: Record<string, number> = {};
for (const m of modes) {
  const o = options(w, m);
  out[`${m}.full`] = Math.round(median(() => Colors.cellLayers(w, o)) * 10) / 10;
  if (split.baseLayers) out[`${m}.base`] = Math.round(median(() => split.baseLayers!(w, o)) * 10) / 10;
  if (split.modeLayers) out[`${m}.mode`] = Math.round(median(() => split.modeLayers!(w, o)) * 10) / 10;
  const L = Colors.cellLayers(w, o);
  if (Near && (L.group || L.countryGroup)) out[`${m}.near`] = Math.round(median(() => Near.nearLayer(w.mesh, L.group, L.countryGroup, L.coast, L.landCell)) * 10) / 10;
  if (!json) console.log(m.padEnd(16), ['full', 'base', 'mode', 'near'].map((k) => (out[`${m}.${k}`] !== undefined ? `${k} ${out[`${m}.${k}`].toFixed(1)} ms` : '')).join('  '));
}
if (json) console.log(JSON.stringify(out));
