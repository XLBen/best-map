// 量进度条默认的各步耗时（第九十七轮，结果贴在 src/progress-defaults.ts）：照新建向导的顺序新建一个带人文的世界
// （建网格 → 加内容、造陆地 → 生成人文、国家、城市 → 划省份），接上“走到哪一步了”的钩子（core/progress.ts），
// 记下每一步从开头到下一步开头用了多久。
//   node --import tsx tools/progress-weights.ts [格数] [--globe]          跑一次，最后一行打出 { 步名: 毫秒 }
//   node --import tsx tools/progress-weights.ts [格数] [--globe] --runs 3   各开一个进程跑三次，取每一步的中位数，照 progress-defaults.ts 的样子打出来
// 一步的时间里含它之后、下一步开头之前的零碎（加内容算在建网格后面的“造陆地”之前，生成人文之后重算人文的几层、起名算在“建城市”里）：
// 进度条按的就是相邻两条消息之间的时间
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Command } from '../core/commands';
import { Engine } from '../core/engine';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { PLANET_SIZES, planetCells, planetSettings } from '../core/presets';
import { setStageSink } from '../core/progress';
import { buildMeshFor, settingsSchema } from '../core/world';

const args = process.argv.slice(2);
const globe = args.includes('--globe');
const cellsArg = args.find((a) => /^\d+$/.test(a) && args[args.indexOf(a) - 1] !== '--runs');
const cells = Number(cellsArg ?? (globe ? planetCells(PLANET_SIZES.earth.radiusKm) : 40000));
const runsAt = args.indexOf('--runs');

function once(): Record<string, number> {
  const settings = globe ? { ...planetSettings('earth', cells), seed: 3 } : { seed: 3, cells };
  const out: Record<string, number> = {};
  let step = 'mesh';
  let at = performance.now();
  const next = (name: string) => {
    const now = performance.now();
    out[step] = (out[step] ?? 0) + (now - at);
    step = name;
    at = now;
  };
  setStageSink((name) => next(name));
  const mesh = buildMeshFor(settingsSchema.parse(settings));
  const eng = new Engine(settings, mesh);
  // 时代（中世纪）的内容：和向导一样和造陆地放在同一步里。要一个有内容的世界才算得出要加哪些，先在一个小世界上算
  const probe = new Engine({ seed: 3, cells: 1500 });
  probe.exec({ op: 'batch', commands: newWorldContentCommands().flatMap((c) => (c.op === 'batch' ? c.commands : [c])) });
  const era = packImportCommands(builtinPacks(), { packs: [['medieval']] }, probe.world).flatMap((c) => (c.op === 'batch' ? c.commands : [c]));
  // probe 也走了流水线：它的几条不算
  for (const k of Object.keys(out)) delete out[k];
  step = 'mesh';
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands().flatMap((c) => (c.op === 'batch' ? c.commands : [c])), ...era, { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  const groups = ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => n.id);
  eng.exec({ op: 'generate_human', packs: [['medieval']], groups, countries: {}, settlements: {} } as Command);
  eng.exec({ op: 'generate_provinces', seed: 3 });
  next('end');
  setStageSink(null);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v)]));
}

if (runsAt < 0) {
  // 建网格单独量（上面的 mesh 一步里只有加内容；网格在钩子接上之前就建了）
  const t0 = performance.now();
  buildMeshFor(settingsSchema.parse(globe ? { ...planetSettings('earth', cells), seed: 4 } : { seed: 4, cells }));
  const meshMs = Math.round(performance.now() - t0);
  const r = once();
  r.terrain = (r.terrain ?? 0) + (r.mesh ?? 0);
  r.mesh = meshMs;
  console.log(JSON.stringify(r));
} else {
  const n = Number(args[runsAt + 1]) || 3;
  const self = fileURLToPath(import.meta.url);
  const all: Record<string, number>[] = [];
  for (let k = 0; k < n; k++) {
    const text = execFileSync(process.execPath, ['--import', 'tsx', self, String(cells), ...(globe ? ['--globe'] : [])], { encoding: 'utf8', maxBuffer: 1 << 24 });
    all.push(JSON.parse(text.trim().split('\n').pop()!));
    console.error(`第 ${k + 1} 次`, text.trim().split('\n').pop());
  }
  const median = (key: string) => {
    const v = all.map((r) => r[key] ?? 0).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  console.log(`${globe ? '整个星球' : '一块地区'} ${cells} 格，${n} 次的中位数（毫秒）：`);
  for (const key of Object.keys(all[0])) console.log(`  ${JSON.stringify(key)}: ${median(key)},`);
}
