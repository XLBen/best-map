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
// features.csv 的四个值在第八轮更新过一次：质心落在地物外面的标注改放到地物自己的格上（只有标注的坐标列变了，名字不变）

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
  'planet 256x128 README.txt': '6cc8064c61f76f42',
  'planet 256x128 biomes.bmp': '32550e664614931e',
  'planet 256x128 cell': 'c8f4981190b1b715',
  'planet 256x128 definition.csv': '426283cc688c8c0e',
  'planet 256x128 elevation': 'e17ca7291863980f',
  'planet 256x128 features.csv': '7f8074a5202a6f19',
  'planet 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 256x128 heightmap.bmp': '64c7b8214853c5a7',
  'planet 256x128 heightmap16.png': '7416766d80e580bb',
  'planet 256x128 land': 'ea430b0a9f3236ee',
  'planet 256x128 provinces.bmp': '2847891232045e58',
  'planet 256x128 provinces_summary.csv': '4e986108b66ea36a',
  'planet 256x128 rivers.bmp': '1654ded21249d798',
  'planet 256x128 terrain.bmp': 'e85bfd5bec2f5971',
  'planet 256x128 world.json': '19d828c6dfd36c94',
  'planet 300x150 README.txt': '9999351b18cd444b',
  'planet 300x150 biomes.bmp': '29d67a76ba7bd1ea',
  'planet 300x150 cell': 'c307af33a65dcc05',
  'planet 300x150 definition.csv': '426283cc688c8c0e',
  'planet 300x150 elevation': '096acb98a187eac6',
  'planet 300x150 features.csv': '0ffdb8552b29a8d7',
  'planet 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'planet 300x150 heightmap.bmp': 'b5dfed13e82316bb',
  'planet 300x150 heightmap16.png': '00744c60357f1206',
  'planet 300x150 land': '7224302020b9dbfa',
  'planet 300x150 provinces.bmp': '820bd37dd0aa6d7f',
  'planet 300x150 provinces_summary.csv': '4e986108b66ea36a',
  'planet 300x150 rivers.bmp': 'b83b1eeb595910cd',
  'planet 300x150 terrain.bmp': 'fe0793175b61c5d5',
  'planet 300x150 world.json': '19d828c6dfd36c94',
  'planet functions': '046cd1a5329b69d3',
  'planet thumbnail': '258f99ea81b53e5e',
  'region 256x128 README.txt': '68c576214df85e4d',
  'region 256x128 biomes.bmp': '69ea50e9bb987d9f',
  'region 256x128 cell': '01fd2ba8503e7702',
  'region 256x128 definition.csv': '2dcc4b0cb6555cc8',
  'region 256x128 elevation': '92dd6b0813e5eaa2',
  'region 256x128 features.csv': '24174a44d04d18cc',
  'region 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 256x128 heightmap.bmp': 'c063f3fd8bed92c3',
  'region 256x128 heightmap16.png': '0de4aea8090ea5ea',
  'region 256x128 land': 'ee3ef034fad2b13a',
  'region 256x128 provinces.bmp': '3af42e7ead15715c',
  'region 256x128 provinces_summary.csv': '03e2084ff1e2ea8d',
  'region 256x128 rivers.bmp': '389c007c65a4eae0',
  'region 256x128 terrain.bmp': '34f14d9d36462e45',
  'region 256x128 world.json': '630ca9a7091fdc8b',
  'region 300x150 README.txt': 'da840c3202eef74c',
  'region 300x150 biomes.bmp': '21aede5ba561ed9f',
  'region 300x150 cell': '910cd177ab45aad3',
  'region 300x150 definition.csv': '2dcc4b0cb6555cc8',
  'region 300x150 elevation': 'd227b0cf8e4bff91',
  'region 300x150 features.csv': '04b7c431498194cf',
  'region 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,world.json,README.txt',
  'region 300x150 heightmap.bmp': '2c8d65c04b85aae2',
  'region 300x150 heightmap16.png': '048a709f9337694d',
  'region 300x150 land': 'cfc0c397f1ee27ff',
  'region 300x150 provinces.bmp': 'b8a6d3739961b0a9',
  'region 300x150 provinces_summary.csv': '03e2084ff1e2ea8d',
  'region 300x150 rivers.bmp': '5d29b993c3ad1fdb',
  'region 300x150 terrain.bmp': '3aa4561697db356a',
  'region 300x150 world.json': '630ca9a7091fdc8b',
  'region functions': 'f1d277296d3fa77f',
  'region thumbnail': '3a40a55f5f5415b3',
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
