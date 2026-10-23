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
// 陆地、高程、格号、高度图、公开函数的摘要一个没变。
// 第十二轮只重录 rivers.bmp 的四个值：河画成一条带子（加密、宽度平滑、源头收尖、河口张开、细小的弯曲），河口画到画面上的岸线；别的一个没变

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
  'planet 256x128 README.txt': 'd4c9cae1dd9d520d',
  'planet 256x128 biomes.bmp': '62b2fb0d251c3705',
  'planet 256x128 cell': 'c8f4981190b1b715',
  'planet 256x128 definition.csv': '508bd74be7dce0d7',
  'planet 256x128 elevation': 'e17ca7291863980f',
  'planet 256x128 features.csv': '5e0f807481d35d28',
  'planet 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 256x128 heightmap.bmp': '64c7b8214853c5a7',
  'planet 256x128 heightmap16.png': '7416766d80e580bb',
  'planet 256x128 land': 'ea430b0a9f3236ee',
  'planet 256x128 provinces.bmp': '7ead2309d864be15',
  'planet 256x128 provinces_summary.csv': 'c5cee2757def7c69',
  'planet 256x128 rivers.bmp': 'b6919f495a1dcab9',
  'planet 256x128 terrain.bmp': '48c942a90506043b',
  'planet 256x128 world.json': 'b14bcf5ed922a8a4',
  'planet 300x150 README.txt': '84b709421c27656c',
  'planet 300x150 biomes.bmp': '092c8b92e02d8838',
  'planet 300x150 cell': 'c307af33a65dcc05',
  'planet 300x150 definition.csv': '508bd74be7dce0d7',
  'planet 300x150 elevation': '096acb98a187eac6',
  'planet 300x150 features.csv': 'b63107cddbad7461',
  'planet 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 300x150 heightmap.bmp': 'b5dfed13e82316bb',
  'planet 300x150 heightmap16.png': '00744c60357f1206',
  'planet 300x150 land': '7224302020b9dbfa',
  'planet 300x150 provinces.bmp': '28935c72f770ff42',
  'planet 300x150 provinces_summary.csv': 'c5cee2757def7c69',
  'planet 300x150 rivers.bmp': 'ff50d755da6ebefd',
  'planet 300x150 terrain.bmp': 'c4a6182877ce0b7e',
  'planet 300x150 world.json': 'b14bcf5ed922a8a4',
  'planet functions': '046cd1a5329b69d3',
  'planet thumbnail': '142bb3c22fca1212',
  'region 256x128 README.txt': '18840f1e86b20658',
  'region 256x128 biomes.bmp': '141de571d26a8241',
  'region 256x128 cell': '01fd2ba8503e7702',
  'region 256x128 definition.csv': '8e3722e0bb046a94',
  'region 256x128 elevation': '92dd6b0813e5eaa2',
  'region 256x128 features.csv': '359fb2ab06831e09',
  'region 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 256x128 heightmap.bmp': 'c063f3fd8bed92c3',
  'region 256x128 heightmap16.png': '0de4aea8090ea5ea',
  'region 256x128 land': 'ee3ef034fad2b13a',
  'region 256x128 provinces.bmp': 'd7fdfb238847849b',
  'region 256x128 provinces_summary.csv': 'ad9e38d0a0ac3e08',
  'region 256x128 rivers.bmp': '0230686403084d44',
  'region 256x128 terrain.bmp': '202e0469259c4edd',
  'region 256x128 world.json': '3e04512e12984af0',
  'region 300x150 README.txt': '45a1a0d5a3be7261',
  'region 300x150 biomes.bmp': '75521ec9516fced9',
  'region 300x150 cell': '910cd177ab45aad3',
  'region 300x150 definition.csv': '8e3722e0bb046a94',
  'region 300x150 elevation': 'd227b0cf8e4bff91',
  'region 300x150 features.csv': '7ef0439e65109dac',
  'region 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 300x150 heightmap.bmp': '2c8d65c04b85aae2',
  'region 300x150 heightmap16.png': '048a709f9337694d',
  'region 300x150 land': 'cfc0c397f1ee27ff',
  'region 300x150 provinces.bmp': '30f40d286768b41a',
  'region 300x150 provinces_summary.csv': 'ad9e38d0a0ac3e08',
  'region 300x150 rivers.bmp': 'd37a724990e46417',
  'region 300x150 terrain.bmp': '4b78cfbaa02103a6',
  'region 300x150 world.json': '3e04512e12984af0',
  'region functions': 'f1d277296d3fa77f',
  'region thumbnail': 'f17285d67f15f1b0',
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
