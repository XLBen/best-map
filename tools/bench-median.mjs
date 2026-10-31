// 跑几次 tools/bench.ts --json，取每一步的中位数；或者对照两个提交。
//   node tools/bench-median.mjs [次数] [--out 文件] -- [bench 的参数]
//     例：node tools/bench-median.mjs 5 -- --globe          整个星球的加工各步，五次的中位数
//         node tools/bench-median.mjs 3 -- --globe --pack fantasy
//   node tools/bench-median.mjs [次数] --against <提交> [--out 文件] -- [bench 的参数]
//     在临时的 git worktree 里检出那个提交，把现在的 tools/bench.ts 复制过去（两边跑同样的步骤），
//     旧、新交替各跑几次（机器忙闲的变化两边一样），打出对照表；--out 存下 { base, head } 两份中位数
//   node tools/bench-median.mjs --compare 旧.json 新.json：对照两份存下的中位数（单份的，或 --against 存的 { base, head }）
//   对照表只列步骤的总耗时（键里没有“.”“#”的）；--all 连同各阶段一起列。加工的步骤比旧的慢 5% 以上的标出来（第六条门槛）
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const benchArgs = sep >= 0 ? argv.slice(sep + 1) : ['--globe', '--pack', 'fantasy'];
const flag = (name) => {
  const k = own.indexOf(name);
  return k >= 0 ? own[k + 1] : null;
};
const runs = Number(own.find((a, k) => /^\d+$/.test(a) && !own[k - 1]?.startsWith('--'))) || 3;
const showAll = own.includes('--all');

// 加工：门槛是不比旧的慢 5% 以上（开发说明“速度”、计划的第六条）。
// rivers、coast：加工各步之后 Worker 描河并打包、主线程算海岸场的时间加起来（第三十三轮提速）
const EDITS = ['rivers', 'coast', 'relief', 'erod', 'tempBrush', 'paintLand', 'island', 'reroll', 'rerollFjord', 'river', 'lake', 'humidity', 'latShift', 'undo1', 'undo2', 'undo3', 'undo4', 'undo5', 'undo6', 'redo', 'hotRelief', 'warmRelief'];

function runOnce(dir) {
  const out = execFileSync(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(dir, 'tools', 'bench.ts'), ...benchArgs, '--json'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function median(all) {
  const out = {};
  for (const key of Object.keys(all[0])) {
    const v = all.map((r) => r[key]).filter((x) => x !== undefined).sort((a, b) => a - b);
    out[key] = v[Math.floor(v.length / 2)];
  }
  return out;
}

function table(base, head) {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((k) => showAll || !/[.#]/.test(k));
  const rows = ['| 步骤 | 旧 | 新 | 变化 |', '|---|---:|---:|---:|'];
  const slow = [];
  for (const k of keys) {
    const a = base[k];
    const b = head[k];
    const pct = a > 0 && b !== undefined ? ((b - a) / a) * 100 : null;
    const bad = pct !== null && EDITS.includes(k) && pct > 5 && b - a > 2;
    if (bad) slow.push(k);
    rows.push(`| ${k} | ${a ?? '—'} | ${b ?? '—'} | ${pct === null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`}${bad ? ' ⚠' : ''} |`);
  }
  console.log(rows.join('\n'));
  console.log(slow.length ? `\n比旧的慢 5% 以上的加工：${slow.join('、')}` : '\n加工都没有比旧的慢 5% 以上');
}

function load(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return j.head && j.base ? j : { head: j };
}

const cmpAt = own.indexOf('--compare');
if (cmpAt >= 0) {
  const a = load(own[cmpAt + 1]);
  const b = load(own[cmpAt + 2]);
  table(a.head, b.head);
} else {
  const against = flag('--against');
  const outFile = flag('--out');
  if (!against) {
    const all = [];
    for (let k = 0; k < runs; k++) {
      all.push(runOnce(root));
      process.stderr.write(`run ${k + 1}/${runs} done\n`);
    }
    const m = median(all);
    if (outFile) writeFileSync(outFile, JSON.stringify(m, null, 1) + '\n');
    console.log(JSON.stringify(m, null, 1));
  } else {
    // 旧的提交检出到临时目录（不动现在的工作区），依赖用这里的
    const dir = mkdtempSync(join(tmpdir(), 'map2-bench-'));
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    git('worktree', 'add', '--detach', dir, against);
    try {
      symlinkSync(realpathSync(join(root, 'node_modules')), join(dir, 'node_modules'));
      copyFileSync(join(root, 'tools', 'bench.ts'), join(dir, 'tools', 'bench.ts'));
      if (!existsSync(join(dir, 'tools', 'hash.ts'))) throw new Error('旧的提交里没有 tools/hash.ts');
      const base = [];
      const head = [];
      for (let k = 0; k < runs; k++) {
        base.push(runOnce(dir));
        head.push(runOnce(root));
        process.stderr.write(`run ${k + 1}/${runs} done (old, new)\n`);
      }
      const m = { against, args: benchArgs, base: median(base), head: median(head) };
      if (outFile) writeFileSync(outFile, JSON.stringify(m, null, 1) + '\n');
      table(m.base, m.head);
    } finally {
      git('worktree', 'remove', '--force', dir);
    }
  }
}
