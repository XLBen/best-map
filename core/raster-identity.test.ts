import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { exportPackage } from './export';
import {
  coastDetail,
  coastDetail3,
  coastValues,
  fbmSub,
  fbmSub3,
  hashU,
  hashU3,
  locate,
  pointIsLand,
  rasterizeWorld,
  terrainDetail,
  terrainDetail3,
  vnoise,
  vnoise3,
  warpOffset,
  warpOffset3,
} from './subcell';
import { renderThumbnail } from './thumbnail';

// 导出的栅格化（subcell.ts）、导出文件（export.ts）、缩略图（thumbnail.ts）提速后结果逐位不变。
// 下面记下的摘要由提速前的代码（提交 c6f1444 的这三个文件）跑同一个 digests() 得到；
// 以后有意改变导出结果时才更新（RECORD_RASTER=1 时打印当前的摘要）。
// world.json 的四个值更新过一次：命令里记下了新起的省名（provinceNames），图片与表格不变。
// features.csv 的四个值在第八轮更新过一次：质心落在地物外面的标注改放到地物自己的格上（只有标注的坐标列变了，名字不变）。
// 第九轮去掉旧存档兼容时重录一次：山挡风默认打开，气候往后（生态、省份、河、地形类别、地名、world.json 的版本）都变了；
// 第十三轮重录格号（cell）与 provinces.bmp 各四个：海上的像素永远不取陆地格，窄海湾里邻格都是陆地时沿网格往外找最近的海格
// （原来保持扭曲后的陆地格、涂成陆上省的颜色）；其余文件不变
// 第十三轮：默认生态换了新配色、混色按份额的平方，biomes.bmp 与缩略图也重录
// 第十三轮只重录 rivers.bmp（四个）：河口最后一段改成沿岸线的法向进水、海岸边不到 1.5 格的源头小河不画、
// 流进同一格海挨着的河口并成一条（core/rivers.ts 的 normalMouth、tidyMouths，只改画法，水文与别的文件逐位不变）
// 第十三轮修：陆地围住的小块海（6 格以内）并回陆地、三格以上挖成湖，放的火山岛按大小定高度并有火山口，陆海、高程往后都变了，重录变了的项
// 第十三轮后来又重录 rivers.bmp（四个）：挤在一起的河口改成小的沿岸挪开、各自入海，只在接得顺时并进大河（以前常常拐回去接，画成钩子、“V”）；
// 河口那一段不再急转（法向与原来方向差太多时偏回来、换长一点的一段）；找岸线少取几个点（准到千分之一格）；
// 量岸线法向的一圈从 12 个点改成 8 个、河口本来就在岸线上时不再沿法向重找（提速）。
// 与小海并回陆地、火山岛高度那一批合起来以后再重录 rivers.bmp（四个，只有河变了）：地形变了河口跟着变；另外窄海湾湾头两边斜着
// 流进来的两条河（小的挪不开、接不顺）现在把大河的河口往另一侧挪开（在那一段汇进来的支流重新接上），并进大河时多试几种曲线
// （离岸 0.1 格接、起点切向短一点、一路沿大河方向往前的曲线），挪小河的河口时圆周上与岸线相交的几处都试

// 字节摘要：两个不同起点的 32 位 FNV-1a 拼成 16 位十六进制
function digest(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 0x01000193);
    h2 = Math.imul(h2 ^ b[i], 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function region(): Engine {
  const eng = new Engine({ seed: 3, cells: 6000 });
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
  return eng;
}

function planet(): Engine {
  const eng = new Engine({ cells: 6000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 4 } });
  return eng;
}

const SIZES: [number, number][] = [
  [256, 128],
  [300, 150],
];

function digests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, eng] of [
    ['region', region()],
    ['planet', planet()],
  ] as const) {
    const w = eng.world;
    for (const [W, H] of SIZES) {
      const key = `${name} ${W}x${H}`;
      const r = rasterizeWorld(w, W, H);
      out[`${key} land`] = digest(r.land);
      out[`${key} elevation`] = digest(r.elevation);
      out[`${key} cell`] = digest(r.cell);
      // zip 里带文件的修改时间，所以逐个比较解出来的文件
      const pkg = exportPackage(w, eng.toDoc(), { width: W, height: H, seaLevelGray: 95, maxElevation: 6000 });
      const files = unzipSync(pkg.zip);
      out[`${key} files`] = pkg.files.join(',');
      for (const f of pkg.files) out[`${key} ${f}`] = digest(files[f]);
    }
    out[`${name} thumbnail`] = digest(renderThumbnail(w, 240, 120));
    // 公开的噪声、定位函数在一组散点上的值
    const { mesh } = w;
    const sp = mesh.spacing;
    const s = coastValues(w);
    const v: number[] = [];
    let hint = 0;
    for (let k = 0; k < 400; k++) {
      const x = ((k * 0.6180339887498949) % 1) * mesh.width;
      const y = ((k * 0.7548776662466927) % 1) * mesh.height;
      const ix = k * 7919 - 1500000;
      const iy = ((k * 104729) % 99991) - 50000;
      v.push(hashU(ix, iy), hashU3(ix, iy, k - 200), vnoise(x * 97.3 - 50, y * 41.1 + 3), vnoise3(x * 97.3 - 50, y * 41.1 + 3, k * 0.37 - 20));
      v.push(fbmSub(x / sp, y / sp, 4), fbmSub3(x / sp, y / sp, k * 0.11, 4));
      const loc = locate(mesh, x, y, hint);
      hint = loc.nearest;
      v.push(...loc.i, ...loc.w, loc.nearest);
      const pl = pointIsLand(w, s, w.derived.elevation, x, y, hint);
      v.push(pl.land ? 1 : 0, pl.nearest, pl.height);
      const gx = Math.sin(k) * 0.02;
      const gy = Math.cos(k * 1.3) * 0.02;
      if (mesh.kind === 'sphere') v.push(coastDetail3(x, y, sp), ...warpOffset3(x, y, sp), terrainDetail3(x, y, 300, gx, gy, sp, true), terrainDetail3(x, y, -300, 0, 0, sp, false));
      else v.push(coastDetail(x, y, sp), ...warpOffset(x, y, sp), terrainDetail(x, y, 300, gx, gy, sp, true), terrainDetail(x, y, -300, 0, 0, sp, false));
    }
    out[`${name} functions`] = digest(Float64Array.from(v));
  }
  return out;
}

const RECORDED: Record<string, string> = {
  'planet 256x128 README.txt': 'c319d95b77d85e9f',
  'planet 256x128 biomes.bmp': '56f75dd35a329b49',
  'planet 256x128 cell': '471c5cc5371212f1',
  'planet 256x128 definition.csv': '5d8910907f74d6fe',
  'planet 256x128 elevation': 'b5adc3e1d745a1bb',
  'planet 256x128 features.csv': 'e18e8647abd3762f',
  'planet 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 256x128 heightmap.bmp': 'e4690144cf6c0278',
  'planet 256x128 heightmap16.png': '77df18932457b807',
  'planet 256x128 land': '5b0a363376c22aaf',
  'planet 256x128 provinces.bmp': '269fdb2dd74e2a67',
  'planet 256x128 provinces_summary.csv': 'd3a93fbef94f73e6',
  'planet 256x128 rivers.bmp': '6e8650a1ae84fddf',
  'planet 256x128 terrain.bmp': 'e442d5bb95d47dd3',
  'planet 256x128 world.json': '97a1f83188bfeed1',
  'planet 300x150 README.txt': '3cebcd487b23dd8e',
  'planet 300x150 biomes.bmp': 'b457f20350618be5',
  'planet 300x150 cell': '0bc269dba62ce0fb',
  'planet 300x150 definition.csv': '5d8910907f74d6fe',
  'planet 300x150 elevation': '96b938979fca222f',
  'planet 300x150 features.csv': '21f60216b0c6bd86',
  'planet 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 300x150 heightmap.bmp': '0b4f9f159be5c6e7',
  'planet 300x150 heightmap16.png': '1d74697043008218',
  'planet 300x150 land': 'dde226cd48a2d703',
  'planet 300x150 provinces.bmp': '3cc58bf710812117',
  'planet 300x150 provinces_summary.csv': 'd3a93fbef94f73e6',
  'planet 300x150 rivers.bmp': 'dcdb9a8098b056d0',
  'planet 300x150 terrain.bmp': 'f84ee35b9fd44f51',
  'planet 300x150 world.json': '97a1f83188bfeed1',
  'planet functions': 'ecb4ac7af1985234',
  'planet thumbnail': '6706a4e4e3854180',
  'region 256x128 README.txt': 'fad4308b9c7d9811',
  'region 256x128 biomes.bmp': '0a33780d88b4af5d',
  'region 256x128 cell': '7a0c8415281fad99',
  'region 256x128 definition.csv': '8672a526c1daf96c',
  'region 256x128 elevation': '4acc369d12ac9819',
  'region 256x128 features.csv': 'aec00f0764d306f3',
  'region 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 256x128 heightmap.bmp': '3563fadd62e2b225',
  'region 256x128 heightmap16.png': 'e68cf0e6a2e458fa',
  'region 256x128 land': '444e93600b6444da',
  'region 256x128 provinces.bmp': 'dae8c214e32cf3cc',
  'region 256x128 provinces_summary.csv': '5dc0ab305487dd86',
  'region 256x128 rivers.bmp': '61275afd5abb6391',
  'region 256x128 terrain.bmp': '05bbf3c3c89f8f39',
  'region 256x128 world.json': '22e33075333b73b7',
  'region 300x150 README.txt': 'aaac48241077e658',
  'region 300x150 biomes.bmp': '4591adaff22873fd',
  'region 300x150 cell': '66765fa68ed95ba6',
  'region 300x150 definition.csv': '8672a526c1daf96c',
  'region 300x150 elevation': '123b96837ed3e61d',
  'region 300x150 features.csv': '16aa5b5b233aa625',
  'region 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 300x150 heightmap.bmp': '9d95610a5eb60278',
  'region 300x150 heightmap16.png': '9430d887538b7345',
  'region 300x150 land': '45b844d3802a1b17',
  'region 300x150 provinces.bmp': '18acb72bc645beef',
  'region 300x150 provinces_summary.csv': '5dc0ab305487dd86',
  'region 300x150 rivers.bmp': '25a677f2231dd230',
  'region 300x150 terrain.bmp': 'da661901ced45171',
  'region 300x150 world.json': '22e33075333b73b7',
  'region functions': 'ec0eb23ceb75674c',
  'region thumbnail': 'c971e53c79dc1b7a',
};

describe('导出栅格化逐位不变', () => {
  it('位图、高度、文件包、缩略图与提速前的摘要一致', () => {
    const d = digests();
    if (process.env.RECORD_RASTER) console.log(JSON.stringify(d, null, 1));
    expect(d).toEqual(RECORDED);
  });

  it('进度回调只报进度，不改变结果', () => {
    const eng = region();
    const plain = rasterizeWorld(eng.world, 300, 150);
    const fractions: number[] = [];
    const r = rasterizeWorld(eng.world, 300, 150, (f) => fractions.push(f));
    expect(digest(r.elevation)).toBe(digest(plain.elevation));
    expect(digest(r.cell)).toBe(digest(plain.cell));
    expect(fractions.length).toBeGreaterThan(5);
    expect(fractions.every((f, k) => f > 0 && f <= 1 && (k === 0 || f > fractions[k - 1]))).toBe(true);
    expect(fractions[fractions.length - 1]).toBe(1);
    const steps: number[] = [];
    const pkg = exportPackage(eng.world, eng.toDoc(), { width: 300, height: 150, seaLevelGray: 95, maxElevation: 6000 }, (f) => steps.push(f));
    expect(steps.every((f, k) => k === 0 || f >= steps[k - 1])).toBe(true);
    expect(steps[steps.length - 1]).toBe(1);
    expect(pkg.files).toContain('provinces.bmp');
  });
});
