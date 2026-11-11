// 量撤销记录占多少内存（第九十五轮）：
//   node --expose-gc --import tsx tools/undo-bytes.ts [--globe] [--human] [--steps N]
//     一块地区（4 万格）、整个星球（--globe，新建类地星球的格数）、带一整个时代库和人文的地区（--human）。
//     先逐种命令打出这一步的撤销记录各部分多少字节（小数据的 JSON 是多少个字、数组多少字节），
//     再连着做 N 步（默认 300）混合的编辑，打出：按 core/undo-budget.ts 估的合计、真的多占了多少内存
//     （做之前、之后各回收一次，比 heapUsed + arrayBuffers；撤销缓存关掉，只剩撤销记录和命令本身）、
//     把撤销记录都丢掉以后还剩多少（命令本身）。
// 不进 vitest；数写在 docs/dev/history/第95轮.md
import { Engine } from '../core/engine';
import type { Command } from '../core/commands';
import type { UndoRecord } from '../core/commands';
import { PLANET_SIZES, planetCells, planetSettings } from '../core/presets';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { undoRecordBytes } from '../core/undo-budget';
import { coastalStroke } from './hash';

const globe = process.argv.includes('--globe');
const human = process.argv.includes('--human');
const stepsArg = process.argv.indexOf('--steps');
const STEPS = stepsArg >= 0 ? Number(process.argv[stepsArg + 1]) : 300;
const era = 'medieval';

const gc = (globalThis as { gc?: () => void }).gc;
function used(): number {
  gc?.();
  gc?.();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

type Step = { id: number; cmd: Command; undo: UndoRecord; state?: unknown };
const doneOf = (eng: Engine) => (eng as unknown as { done: Step[] }).done;

function disc(eng: Engine, c: number, r: number): number[] {
  const { mesh } = eng.world;
  const out: number[] = [];
  if (mesh.kind === 'sphere') {
    const s = mesh as unknown as { px: Float32Array; py: Float32Array; pz: Float32Array };
    // 球面上按弦长
    if (s.px) {
      for (let i = 0; i < mesh.n; i++) if (Math.hypot(s.px[i] - s.px[c], s.py[i] - s.py[c], s.pz[i] - s.pz[c]) < mesh.spacing * r) out.push(i);
      if (out.length) return out;
    }
  }
  for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < mesh.spacing * r) out.push(i);
  return out;
}

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

function parts(u: UndoRecord) {
  let arrays = 0;
  for (const a of u.arrays) arrays += a.idx.byteLength + a.old.byteLength;
  let fields = 0;
  for (const f of u.fields) if (f.old) fields += f.old.byteLength;
  return { smallChars: u.small.length, arrays, fields, est: undoRecordBytes(u) };
}

function show(eng: Engine, label: string, cmd: Command) {
  const before = doneOf(eng).length;
  eng.exec(cmd);
  const d = doneOf(eng);
  if (d.length === before) {
    console.log(label.padEnd(34), '（没有变化）');
    return;
  }
  const p = parts(d[d.length - 1].undo);
  const cmdChars = JSON.stringify(d[d.length - 1].cmd).length;
  console.log(label.padEnd(34), `小数据 ${String(p.smallChars).padStart(8)} 字  数组 ${kb(p.arrays).padStart(11)}  场 ${kb(p.fields).padStart(10)}  估 ${kb(p.est).padStart(11)}  命令 ${String(cmdChars).padStart(8)} 字`);
}

const settings = globe ? { ...planetSettings('earth', planetCells(PLANET_SIZES.earth.radiusKm)), seed: 3 } : { seed: 3, cells: 40000 };
const eng = new Engine(settings);
// 只量撤销记录：推导的撤销缓存（另有 UNDO_BYTES 的上限）关掉
eng.undoCache = 0;
const w = eng.world;
console.log(`${globe ? '整个星球' : '一块地区'}${human ? ' + 时代库 + 人文' : ''}：${w.mesh.n} 格`);

show(eng, '新建（内容 + 生成）', { op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
if (human) {
  for (const c of packImportCommands(builtinPacks(), { packs: [[era]] }, w)) eng.exec(c);
  const groups = ((builtinPacks().find((p) => p.id === era)?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => n.id);
  show(eng, '划分省份', { op: 'generate_provinces', seed: 3 } as unknown as Command);
  show(eng, '生成人文、国家、城市', { op: 'generate_human', packs: [[era]], groups, countries: {}, settlements: {} } as unknown as Command);
  eng.update();
  console.log(`  小数据 ${Math.round(JSON.stringify(w.small).length / 1000)} 千字，其中内容 ${Math.round(JSON.stringify(w.small.content ?? {}).length / 1000)} 千字`);
}

const small = disc(eng, inland(eng, 0.3), 6);
const big = disc(eng, inland(eng, 0.5), 30);
const huge = disc(eng, inland(eng, 0.5), 80);
show(eng, `抬山（小笔 ${small.length} 格）`, { op: 'paint_relief', cells: small, t: small.map((_, k) => (k % 5) / 5), strength: 0.7 });
show(eng, `抬山（大笔 ${big.length} 格）`, { op: 'paint_relief', cells: big, t: big.map(() => 0), strength: 0.5 });
show(eng, `抬山（最大的笔 ${huge.length} 格）`, { op: 'paint_relief', cells: huge, t: huge.map(() => 0), strength: 0.3 });
show(eng, `冷暖笔（${big.length} 格）`, { op: 'paint', field: 'tempOffset', cells: big, values: big.map(() => -1), mode: 'add' });
const stroke = coastalStroke(w, 0.37, 8);
show(eng, `画陆地（${stroke.length} 格）`, { op: 'paint_land', cells: stroke, t: stroke.map(() => 0), mode: 'land' });
const rr = inland(eng, 0.5);
show(eng, '重新生成一片', { op: 'reroll_region', x: w.mesh.x[rr], y: w.mesh.y[rr], radius: 0.08, variant: 1 });
show(eng, '湿度滑块', { op: 'set_planet', patch: { humidity: 1.2 } });
if (human) {
  show(eng, '重新生成国家', { op: 'regenerate_countries', seed: 5 } as unknown as Command);
  const cells = disc(eng, inland(eng, 0.5), 3);
  const c0 = (Object.values(w.small.countries ?? {})[0] as { id: string } | undefined)?.id;
  if (c0) show(eng, `涂领土（${cells.length} 格）`, { op: 'paint_country', cells, country: c0 } as unknown as Command);
  const culture = Object.values(w.small.popGroups ?? {})[0].culture;
  show(eng, `涂文化（${cells.length} 格）`, { op: 'paint_culture', cells, culture, amount: 0.3 } as unknown as Command);
  if (c0) show(eng, '改国名', { op: 'set_country', id: c0, patch: { name: '量内存国' } } as unknown as Command);
}
show(eng, '重新生成整个世界', { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
// 带人文的：重新生成世界会去掉人文，撤掉这一步再接着量
if (human) eng.undo();

// 连着做 N 步：小笔的抬山、冷暖、画陆地、湿度轮着来（都是平时的一步），每十步一笔大的
console.log(`\n连着做 ${STEPS} 步……`);
const n0 = doneOf(eng).length;
const m0 = used();
let est = 0;
for (let k = 0; k < STEPS; k++) {
  const c = inland(eng, 0.05 + ((k * 0.137) % 0.9));
  const r = k % 10 === 9 ? 30 : 6;
  const cells = disc(eng, c, r);
  let cmd: Command;
  if (k % 4 === 0) cmd = { op: 'paint_relief', cells, t: cells.map((_, j) => (j % 5) / 5), strength: 0.4 };
  else if (k % 4 === 1) cmd = { op: 'paint', field: 'tempOffset', cells, values: cells.map(() => (k % 8 < 4 ? -1 : 1)), mode: 'add' };
  else if (k % 4 === 2) cmd = { op: 'paint', field: 'erodDelta', cells, value: 0.2, mode: 'add' };
  else if (human && k % 8 === 3) cmd = { op: 'paint_culture', cells: disc(eng, c, 3), culture: Object.values(w.small.popGroups ?? {})[k % 5].culture, amount: 0.3 } as unknown as Command;
  else cmd = { op: 'set_planet', patch: { humidity: 1 + (k % 7) * 0.03 } };
  eng.exec(cmd);
}
const d = doneOf(eng);
const made = d.length - n0;
for (let k = n0; k < d.length; k++) est += undoRecordBytes(d[k].undo);
const m1 = used();
console.log(`  进了历史 ${made} 步；估的撤销记录合计 ${mb(est)}（每步 ${kb(est / made)}）`);
console.log(`  真的多占 ${mb(m1 - m0)}（每步 ${kb((m1 - m0) / made)}）${gc ? '' : '（没有 --expose-gc，这个数不准）'}`);
// 把这些步的撤销记录都丢掉：剩下的是命令本身
for (let k = n0; k < d.length; k++) d[k].undo = { small: '', arrays: [], fields: [] } as unknown as UndoRecord;
const m2 = used();
console.log(`  丢掉撤销记录以后还多占 ${mb(m2 - m0)}（命令本身，每步 ${kb((m2 - m0) / made)}）；撤销记录真的占 ${mb(m1 - m2)}（每步 ${kb((m1 - m2) / made)}）`);
console.log(`  估的 / 真的 = ${(est / Math.max(1, m1 - m2)).toFixed(2)}`);
