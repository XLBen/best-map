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
import { seededEngine } from './testing/fixtures';

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

// 第二十一轮：只加了 terrain_class.bmp、resources.bmp、terrain_classes.csv、resources.csv 四个文件的摘要，重录文件列表、README.txt 与
// provinces_summary.csv（最后加了地形类别、资源两列）；别的文件逐位不变
// 第二十七轮：地形类别只管起伏，terrain.bmp、省份汇总的 terrain、terrain_classes.csv 都按 paradoxTerrain（起伏优先，平原按生态），
// 资源的规则按生态的地形写：重录 terrain.bmp、terrain_class.bmp、terrain_classes.csv、resources.*、provinces_summary.csv 与 README.txt
// 第三十轮：只重录 world.json（四个）：文件的版本是 6，命令里多了新建时从资源包加内容的那一步；图片、表格一个不变
// 第三十二轮：地形有了大格局（高程、河、湖、生态、省份往后都变了；格的陆海与以前相同，格以下的海岸细节随高程变），world.json 的版本是 7：重录变了的项
// 第三十三轮：平原与河口（冲积平原、冲积扇、三角洲平原）改了高程，往后都变了，再重录一次
// 第三十四轮：冰川刻蚀改了高程（湖群），海岸有了峡湾、沙坝（格以下的陆海变了），栅格化多了小湖群（lakeDot，缩略图按湖画；
// 游戏文件包照旧按格）：按新的地形重录，并加上每个尺寸的 lakeDot 摘要

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
  const eng = seededEngine({ seed: 3, cells: 6000 });
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
  return eng;
}

function planet(): Engine {
  const eng = seededEngine({ cells: 6000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
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
      out[`${key} lakeDot`] = digest(r.lakeDot);
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
  'planet 256x128 README.txt': '859fe48e042fb5fe',
  'planet 256x128 biomes.bmp': '8acd1554fe25453a',
  'planet 256x128 cell': '8a3f7cfa575c1ce8',
  'planet 256x128 definition.csv': '048f3efd3763c151',
  'planet 256x128 elevation': '1032dd9a00397a7c',
  'planet 256x128 features.csv': '98ae44f5f261b49d',
  'planet 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'planet 256x128 heightmap.bmp': '17d5448e7c82513a',
  'planet 256x128 heightmap16.png': '461cf3cca5605fae',
  'planet 256x128 lakeDot': 'cf373511e9dc9493',
  'planet 256x128 land': 'be40935c2dbcf37a',
  'planet 256x128 provinces.bmp': 'ecd5eaadc3882dd5',
  'planet 256x128 provinces_summary.csv': '27a317022cd12a2c',
  'planet 256x128 resources.bmp': '8dbcd2139fa39173',
  'planet 256x128 resources.csv': '809a3e05a012b9a7',
  'planet 256x128 rivers.bmp': '7f2ab754bfe027b4',
  'planet 256x128 terrain.bmp': '130561b2fdeff48e',
  'planet 256x128 terrain_class.bmp': 'c9b9a508ae4296b6',
  'planet 256x128 terrain_classes.csv': '81f604c460365408',
  'planet 256x128 world.json': '7d75a34676544ad8',
  'planet 300x150 README.txt': '25141ab75072a6a3',
  'planet 300x150 biomes.bmp': 'd06d1221a493a4e7',
  'planet 300x150 cell': '19e2fc90820cc53e',
  'planet 300x150 definition.csv': '048f3efd3763c151',
  'planet 300x150 elevation': '818482aefab6881a',
  'planet 300x150 features.csv': '1ef551eb238e13d1',
  'planet 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'planet 300x150 heightmap.bmp': '7a9242bd7e2e620d',
  'planet 300x150 heightmap16.png': '3e1aabc29833266e',
  'planet 300x150 lakeDot': 'ff089f6d21854bb3',
  'planet 300x150 land': 'ae97cc38fef1c70a',
  'planet 300x150 provinces.bmp': 'e91eb6da53080d62',
  'planet 300x150 provinces_summary.csv': '27a317022cd12a2c',
  'planet 300x150 resources.bmp': '0277da28b689a1c2',
  'planet 300x150 resources.csv': '809a3e05a012b9a7',
  'planet 300x150 rivers.bmp': 'fd0b4322f5ae4488',
  'planet 300x150 terrain.bmp': '9a644fff0a28e947',
  'planet 300x150 terrain_class.bmp': '647a7912ec5585f4',
  'planet 300x150 terrain_classes.csv': '81f604c460365408',
  'planet 300x150 world.json': '7d75a34676544ad8',
  'planet functions': 'cde5f2136eb59b31',
  'planet thumbnail': '01fda12d44177cf9',
  'region 256x128 README.txt': 'f84d39441bfad0ec',
  'region 256x128 biomes.bmp': '65d71c03043352b7',
  'region 256x128 cell': '3a52c7ef58d8243b',
  'region 256x128 definition.csv': '2b46e8eeedf2b45e',
  'region 256x128 elevation': '338f9b35f1c06191',
  'region 256x128 features.csv': 'bc5f4639a29fb101',
  'region 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'region 256x128 heightmap.bmp': 'cce079976ffa3e5d',
  'region 256x128 heightmap16.png': 'e89cb02bb2c689db',
  'region 256x128 lakeDot': 'ee455b933a30dbdf',
  'region 256x128 land': '891b5baf754e79c7',
  'region 256x128 provinces.bmp': '7600be92302e7fe8',
  'region 256x128 provinces_summary.csv': 'f01b985ab81a28d4',
  'region 256x128 resources.bmp': '1bfba97638916e76',
  'region 256x128 resources.csv': '3560a48f751aff19',
  'region 256x128 rivers.bmp': 'f88986e331b9b813',
  'region 256x128 terrain.bmp': '94961f3ff7965adf',
  'region 256x128 terrain_class.bmp': 'ff60a0ea5216fbb2',
  'region 256x128 terrain_classes.csv': '9775b2ae9d70623a',
  'region 256x128 world.json': '6cf95d9f28d84839',
  'region 300x150 README.txt': 'efad1111788e4191',
  'region 300x150 biomes.bmp': '97a5de5626023d08',
  'region 300x150 cell': '9faf0cb5bc2d29df',
  'region 300x150 definition.csv': '2b46e8eeedf2b45e',
  'region 300x150 elevation': '2144c92251037c0a',
  'region 300x150 features.csv': '89624d514847dfd9',
  'region 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'region 300x150 heightmap.bmp': '8aa418a374bba1a5',
  'region 300x150 heightmap16.png': '832d412d12b9e389',
  'region 300x150 lakeDot': '39a18d74dc4e3e82',
  'region 300x150 land': 'f172be5b69c8f527',
  'region 300x150 provinces.bmp': '443c129e9c657980',
  'region 300x150 provinces_summary.csv': 'f01b985ab81a28d4',
  'region 300x150 resources.bmp': '33d504b40377b03e',
  'region 300x150 resources.csv': '3560a48f751aff19',
  'region 300x150 rivers.bmp': '257b4674b0855a26',
  'region 300x150 terrain.bmp': '77041c3dd979e775',
  'region 300x150 terrain_class.bmp': '1c8c9041a12504a1',
  'region 300x150 terrain_classes.csv': '9775b2ae9d70623a',
  'region 300x150 world.json': '6cf95d9f28d84839',
  'region functions': '79139008b9a8c26e',
  'region thumbnail': '466d1d6eda26ae92',
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
