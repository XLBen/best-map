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
// 第十三轮重录格号（cell）与 provinces.bmp 各四个：海上的像素永远不取陆地格，窄海湾里邻格都是陆地时沿网格往外找最近的海格
// （原来保持扭曲后的陆地格、涂成陆上省的颜色）；其余文件不变

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
  'planet 256x128 README.txt': 'b7a646e76c32e29d',
  'planet 256x128 biomes.bmp': '59d8e121b6809c3f',
  'planet 256x128 cell': 'f74050f0bcca1e32',
  'planet 256x128 definition.csv': '508bd74be7dce0d7',
  'planet 256x128 elevation': '918a5d510a5e6d39',
  'planet 256x128 features.csv': '5e0f807481d35d28',
  'planet 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 256x128 heightmap.bmp': 'f5932d045240b862',
  'planet 256x128 heightmap16.png': 'ba806beac5b29c20',
  'planet 256x128 land': 'b85808d36c33a47f',
  'planet 256x128 provinces.bmp': '9e253ebec4c8f0d0',
  'planet 256x128 provinces_summary.csv': 'c5cee2757def7c69',
  'planet 256x128 rivers.bmp': 'e553a2cee2534212',
  'planet 256x128 terrain.bmp': '9fdafe6b9fbc738d',
  'planet 256x128 world.json': 'b14bcf5ed922a8a4',
  'planet 300x150 README.txt': 'e7359468a5732b0c',
  'planet 300x150 biomes.bmp': '939fa2890bf5adb7',
  'planet 300x150 cell': 'e165a362f722d0a0',
  'planet 300x150 definition.csv': '508bd74be7dce0d7',
  'planet 300x150 elevation': '382f7ac1673cd381',
  'planet 300x150 features.csv': 'b63107cddbad7461',
  'planet 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 300x150 heightmap.bmp': '34667f07eb872903',
  'planet 300x150 heightmap16.png': 'e021f3e569e20d21',
  'planet 300x150 land': '48937e82e23fbbee',
  'planet 300x150 provinces.bmp': '2951b132a665b99e',
  'planet 300x150 provinces_summary.csv': 'c5cee2757def7c69',
  'planet 300x150 rivers.bmp': '3454113fbfd99b41',
  'planet 300x150 terrain.bmp': '8105c547a5341a41',
  'planet 300x150 world.json': 'b14bcf5ed922a8a4',
  'planet functions': '360dfdd5fd12769f',
  'planet thumbnail': 'c0217c4ba684fcbd',
  'region 256x128 README.txt': 'b10d9ed431cf0ba8',
  'region 256x128 biomes.bmp': '471ded2a992f1b84',
  'region 256x128 cell': '942d20834cea5d15',
  'region 256x128 definition.csv': '8e3722e0bb046a94',
  'region 256x128 elevation': '06109f3dbe21f84d',
  'region 256x128 features.csv': '359fb2ab06831e09',
  'region 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 256x128 heightmap.bmp': '805cd785187f601d',
  'region 256x128 heightmap16.png': '7a3989d121875811',
  'region 256x128 land': '43e81fd39da93b8f',
  'region 256x128 provinces.bmp': 'd22019b3ccc16311',
  'region 256x128 provinces_summary.csv': 'ad9e38d0a0ac3e08',
  'region 256x128 rivers.bmp': 'dab532c372e7fe83',
  'region 256x128 terrain.bmp': 'c5b0bda858aed9cc',
  'region 256x128 world.json': '3e04512e12984af0',
  'region 300x150 README.txt': '01463f1b85660501',
  'region 300x150 biomes.bmp': '3fbe46d72a7887bd',
  'region 300x150 cell': '306ed850739324f2',
  'region 300x150 definition.csv': '8e3722e0bb046a94',
  'region 300x150 elevation': 'bc4c47dead4d2710',
  'region 300x150 features.csv': '7ef0439e65109dac',
  'region 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 300x150 heightmap.bmp': 'c386f8dd22973995',
  'region 300x150 heightmap16.png': '8cdd7297e158a527',
  'region 300x150 land': '91e58b02df0dee26',
  'region 300x150 provinces.bmp': 'a0b2b00ede2c734a',
  'region 300x150 provinces_summary.csv': 'ad9e38d0a0ac3e08',
  'region 300x150 rivers.bmp': '2f1096793517af69',
  'region 300x150 terrain.bmp': 'e71bafa3cbdba515',
  'region 300x150 world.json': '3e04512e12984af0',
  'region functions': '7c31fa87da6de5f9',
  'region thumbnail': '022b733b712e3f47',
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
