// 命令行批量生成随机世界并导出：npx tsx tools/generate.ts --seed 3 --type continents --out out/seed3 [--cells 40000 --land 0.3 --islands 0.5 --width 2048]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { Engine } from '../core/engine';
import { newWorldContentCommands } from '../core/packs/import';
import { exportPackage } from '../core/export';

const args = new Map<string, string>();
for (let k = 2; k < process.argv.length; k += 2) args.set(process.argv[k].replace(/^--/, ''), process.argv[k + 1]);
const num = (k: string, v: number) => (args.has(k) ? Number(args.get(k)) : v);
const seed = num('seed', 1);
const out = args.get('out') ?? `out/seed${seed}`;
const width = num('width', 2048);

const t0 = performance.now();
const eng = new Engine({ cells: num('cells', 40000), seed, latNorth: num('north', 72), latSouth: num('south', -8) });
const params: Record<string, unknown> = { seed, type: args.get('type') ?? 'continents', mountains: num('mountains', 1) };
if (args.has('land')) params.landFraction = num('land', 0.3);
if (args.has('islands')) params.islands = num('islands', 0.5);
eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: params as { seed: number }, reset: true }] });
eng.exec({ op: 'generate_provinces', rules: { seed } });
const r = exportPackage(eng.world, eng.toDoc(), { width, height: Math.round(width / eng.world.settings.aspect), seaLevelGray: 95, maxElevation: 6000 });
mkdirSync(out, { recursive: true });
for (const [name, data] of Object.entries(unzipSync(r.zip))) writeFileSync(join(out, name), data);
console.log(`已导出 ${r.files.length} 个文件到 ${out}（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
