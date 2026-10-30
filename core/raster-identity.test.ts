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
  'planet 256x128 README.txt': 'ca48d00f2cf60cc5',
  'planet 256x128 biomes.bmp': '8ec4b547dbd5c9ff',
  'planet 256x128 cell': '5ca9de0df38a66a1',
  'planet 256x128 definition.csv': '8a97d9a1282c27dd',
  'planet 256x128 elevation': 'c02321d211902e94',
  'planet 256x128 features.csv': '90581fbcbacf4fa2',
  'planet 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'planet 256x128 heightmap.bmp': 'a873ae19e6bc10bb',
  'planet 256x128 heightmap16.png': 'd940bfc1c999c0c9',
  'planet 256x128 land': 'ea4e0e4a8d8d52d6',
  'planet 256x128 provinces.bmp': 'db073f109ac3f3b0',
  'planet 256x128 provinces_summary.csv': '566ad647b5c09a97',
  'planet 256x128 resources.bmp': '72b4b8deb2a92030',
  'planet 256x128 resources.csv': 'c2569d6479bc7df0',
  'planet 256x128 rivers.bmp': '1b2f4b50276e41d6',
  'planet 256x128 terrain.bmp': '34042c0af255248c',
  'planet 256x128 terrain_class.bmp': 'f12c5486ded0b1b6',
  'planet 256x128 terrain_classes.csv': '6b33e54f14e213cd',
  'planet 256x128 world.json': 'd629d18535e4e2bb',
  'planet 300x150 README.txt': '103a14de15728ce8',
  'planet 300x150 biomes.bmp': '5dc87f3d95fa2de3',
  'planet 300x150 cell': '6da87a52ce6f470c',
  'planet 300x150 definition.csv': '8a97d9a1282c27dd',
  'planet 300x150 elevation': '8ac22fce93d98f5a',
  'planet 300x150 features.csv': '427ff227d4b8f771',
  'planet 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'planet 300x150 heightmap.bmp': 'c7bccf9f7d83fae9',
  'planet 300x150 heightmap16.png': 'cf65840e40c498a2',
  'planet 300x150 land': '5e63aa7500d5282b',
  'planet 300x150 provinces.bmp': '5d2a9d5ccb8261ce',
  'planet 300x150 provinces_summary.csv': '566ad647b5c09a97',
  'planet 300x150 resources.bmp': '21e7bfca9dbe54d2',
  'planet 300x150 resources.csv': 'c2569d6479bc7df0',
  'planet 300x150 rivers.bmp': 'c511a0eed68aa286',
  'planet 300x150 terrain.bmp': '39005608678ee560',
  'planet 300x150 terrain_class.bmp': '3664c2fe3037bb88',
  'planet 300x150 terrain_classes.csv': '6b33e54f14e213cd',
  'planet 300x150 world.json': 'd629d18535e4e2bb',
  'planet functions': '6c0e188422279976',
  'planet thumbnail': '0c4e514f66331bed',
  'region 256x128 README.txt': '0ada3705a8400505',
  'region 256x128 biomes.bmp': '1030623023b6ae0c',
  'region 256x128 cell': '05858ded4aa0ffc7',
  'region 256x128 definition.csv': '6178254d0e212889',
  'region 256x128 elevation': 'ffb91fbc6116964e',
  'region 256x128 features.csv': 'c3e06c9b415e09cd',
  'region 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'region 256x128 heightmap.bmp': 'c4e8f20db00dde03',
  'region 256x128 heightmap16.png': '3306c8e72e097997',
  'region 256x128 land': 'f9e41b95097809ab',
  'region 256x128 provinces.bmp': '74eb5b7f5640d3c7',
  'region 256x128 provinces_summary.csv': '3200368f5e4bc14d',
  'region 256x128 resources.bmp': '883de740508e023e',
  'region 256x128 resources.csv': '96ce858a780686f2',
  'region 256x128 rivers.bmp': '38b270e2f8443dd4',
  'region 256x128 terrain.bmp': 'a010a73acc896936',
  'region 256x128 terrain_class.bmp': 'dbafbdc8b6d4e6be',
  'region 256x128 terrain_classes.csv': 'e666df48b227135a',
  'region 256x128 world.json': 'e167760929bedb87',
  'region 300x150 README.txt': '9abcc080a79b77d8',
  'region 300x150 biomes.bmp': '676c8cd3608689c1',
  'region 300x150 cell': '4aa0c440133fc9e6',
  'region 300x150 definition.csv': '6178254d0e212889',
  'region 300x150 elevation': 'fdc065b6e908aae0',
  'region 300x150 features.csv': 'f9d2af41a759bf7d',
  'region 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'region 300x150 heightmap.bmp': '089c85dcb6061a74',
  'region 300x150 heightmap16.png': '04364f92d0e755e6',
  'region 300x150 land': '8d272faec991f176',
  'region 300x150 provinces.bmp': 'c2d0f4e52d59f07d',
  'region 300x150 provinces_summary.csv': '3200368f5e4bc14d',
  'region 300x150 resources.bmp': '0cc4ccf0636f33ca',
  'region 300x150 resources.csv': '96ce858a780686f2',
  'region 300x150 rivers.bmp': 'df881fde9e5c1398',
  'region 300x150 terrain.bmp': '6740454824b951dc',
  'region 300x150 terrain_class.bmp': '698753620a29f824',
  'region 300x150 terrain_classes.csv': 'e666df48b227135a',
  'region 300x150 world.json': 'e167760929bedb87',
  'region functions': '599636bca173fb1a',
  'region thumbnail': '48d1097bd3e17ba5',
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
