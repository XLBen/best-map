// 跑几次 tools/bench.ts --json，取每一步的中位数：node tools/bench-median.mjs [次数] -- [bench 的参数]
//   例：node tools/bench-median.mjs 3 -- --globe --pack fantasy
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sep = process.argv.indexOf('--');
const runs = Number(process.argv[2]) || 3;
const args = sep >= 0 ? process.argv.slice(sep + 1) : ['--globe', '--pack', 'fantasy'];
const all = [];
for (let k = 0; k < runs; k++) {
  const out = execFileSync(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'tools', 'bench.ts'), ...args, '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  all.push(JSON.parse(out.trim().split('\n').pop()));
  process.stderr.write(`run ${k + 1}/${runs} done\n`);
}
const median = {};
for (const key of Object.keys(all[0])) {
  const v = all.map((r) => r[key]).sort((a, b) => a - b);
  median[key] = v[Math.floor(v.length / 2)];
}
console.log(JSON.stringify(median, null, 1));
