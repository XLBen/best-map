// 和地球比（第三十一轮，计划的第七条）：几个种子 × {半个星球的区域、类地星球}，“几块大陆”，新建后不做任何加工，
// 列出 core/stats.ts 的 realismStats 与地球的参考值。
//   npx tsx tools/realism-report.ts [--seeds 1-6] [--only region|planet] [--cells 40000] [--raster 2048] [--json 文件]
//   --raster 0：不算海岸线的盒维数（省掉栅格化，快一半）
// 每轮跑一次，与开发说明“和地球比”里记下的上一轮对照
import { writeFileSync } from 'node:fs';
import { PLANET_SIZES, planetCells, planetSettings, settingsFor } from '../core/presets';
import { EARTH_REFERENCE, boxCountDimension, coastPixels } from '../core/stats';
import { rasterizeWorld } from '../core/subcell';
import type { World } from '../core/world';
import { REALISM_ROW_REF, type RealismRow, realismRow, realismWorld } from './realism';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const k = argv.indexOf(name);
  return k >= 0 ? argv[k + 1] : undefined;
};
const seedsArg = opt('--seeds') ?? '1-6';
const seeds = seedsArg.includes('-')
  ? (() => {
      const [a, b] = seedsArg.split('-').map(Number);
      return Array.from({ length: b - a + 1 }, (_, k) => a + k);
    })()
  : seedsArg.split(',').map(Number);
const only = opt('--only');
const regionCells = Number(opt('--cells') ?? 40000);
const rasterW = Number(opt('--raster') ?? 2048);
const jsonOut = opt('--json');

// 海岸线的盒维数：栅格化（与导出、屏幕相同的格以下的海岸），格子 2–64 像素。
// 整个星球只数南北纬 60° 以内的行（等距圆柱的高纬被拉宽）
function coastDimension(world: World): number {
  if (!rasterW) return NaN;
  const w = rasterW;
  const h = w / 2;
  const r = rasterizeWorld(world, w, h);
  const globe = world.mesh.kind === 'sphere';
  const coast = coastPixels(r.land, w, h, globe);
  const rows: [number, number] = globe ? [Math.round(h / 6), Math.round((h * 5) / 6)] : [0, h];
  return boxCountDimension(coast, w, h, [2, 4, 8, 16, 32, 64], rows);
}

const configs = [
  { key: 'region', name: `半个星球的区域（${regionCells} 格，温带）`, settings: () => settingsFor('hemisphere', 'temperate', regionCells) },
  { key: 'planet', name: `类地星球（${planetCells(PLANET_SIZES.earth.radiusKm)} 格）`, settings: () => planetSettings('earth') },
].filter((c) => !only || c.key === only);

type Row = RealismRow;
const ROWS: { key: keyof Row; label: string; fmt: (v: number) => string }[] = [
  { key: 'landShare', label: '陆地占比', fmt: pct },
  { key: 'below200', label: '200 m 以下', fmt: pct },
  { key: 'below500', label: '500 m 以下', fmt: pct },
  { key: 'above2000', label: '2000 m 以上', fmt: pct },
  { key: 'meanM', label: '陆地平均高程 m', fmt: (v) => v.toFixed(0) },
  { key: 'basinTop1', label: '最大流域 / 陆地', fmt: pct },
  { key: 'basinTop5', label: '前五流域 / 陆地', fmt: pct },
  { key: 'longestKm', label: '最长流路 km', fmt: (v) => v.toFixed(0) },
  { key: 'longestPerDiameter', label: '最长流路 ÷ 陆块直径', fmt: (v) => v.toFixed(2) },
  { key: 'hack', label: 'Hack 指数 h', fmt: (v) => v.toFixed(2) },
  { key: 'lOverSqrtA', label: '前十流域 L/√A 中位数', fmt: (v) => v.toFixed(2) },
  { key: 'exceedance', label: '汇水面积超越指数', fmt: (v) => v.toFixed(2) },
  { key: 'exceedanceBasins', label: '同上，只数前十个流域', fmt: (v) => v.toFixed(2) },
  { key: 'endorheic', label: '内流区占比', fmt: pct },
  { key: 'lakes', label: '湖的个数', fmt: (v) => v.toFixed(0) },
  { key: 'lakeShare', label: '湖面 / 陆地', fmt: (v) => `${(v * 100).toFixed(2)}%` },
  { key: 'lakeSizeK', label: '湖大小幂律指数', fmt: (v) => v.toFixed(2) },
  { key: 'plateau', label: '高原指数', fmt: (v) => `${(v * 100).toFixed(2)}%` },
  { key: 'divideShare', label: '一边活动的大陆流向另一边的面积', fmt: pct },
  { key: 'divideCoast', label: '同上，另一边占海岸', fmt: pct },
  { key: 'riftLakes', label: '裂谷湖的个数', fmt: (v) => v.toFixed(0) },
  { key: 'riftRatio', label: '裂谷湖长宽比中位数', fmt: (v) => v.toFixed(1) },
  { key: 'coastDim', label: '海岸盒维数', fmt: (v) => v.toFixed(3) },
];

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

const out: Record<string, Record<number, Row>> = {};
const REF: Record<keyof Row, string> = { ...EARTH_REFERENCE, ...REALISM_ROW_REF };
for (const c of configs) {
  out[c.key] = {};
  for (const seed of seeds) {
    const t0 = performance.now();
    const world = realismWorld(c.settings(), seed);
    const st: Row = realismRow(world, coastDimension(world));
    out[c.key][seed] = st;
    process.stderr.write(`${c.key} seed ${seed}: ${Math.round(performance.now() - t0)} ms\n`);
  }
  const mean = (k: keyof Row) => {
    const v = seeds.map((s) => out[c.key][s][k]).filter((x) => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  console.log(`\n### ${c.name}，“几块大陆”，种子 ${seedsArg}\n`);
  console.log(`| 统计 | ${seeds.map((s) => `种子 ${s}`).join(' | ')} | 平均 | 地球 |`);
  console.log(`|---|${seeds.map(() => '---:').join('|')}|---:|---:|`);
  for (const r of ROWS) {
    const cell = (v: number) => (Number.isFinite(v) ? r.fmt(v) : '—');
    console.log(`| ${r.label} | ${seeds.map((s) => cell(out[c.key][s][r.key])).join(' | ')} | ${cell(mean(r.key))} | ${REF[r.key]} |`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1) + '\n');
