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
import { NO_CURRENTS, seededEngine } from './testing/fixtures';

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
// 第三十六轮：峡湾换成谷网的画法、峡湾海岸多了岛礁、岸线更曲折（格以下的陆海变了；格的陆海、高程、水文不变）：重录按像素的几项
// 第三十六轮（续）：峡湾的长短、宽窄按 km，支湾最多三条，不顺着海岸走，岛礁海岸更曲折一点：再重录按像素的几项
// 第三十八轮：只重录 world.json（四个）：命令里新建时从资源包加内容的那一步多了“通用 ▸ 画风”；图片、表格一个不变
// 第四十二轮：只重录 world.json（四个）：新建时多加“通用 ▸ 国家等级”、城市等级多了浓淡与大小；图片、表格一个不变（核对过去掉这些时与原来的值相同）
// 第四十三轮：只重录 world.json（四个）：文件的版本是 11；图片、表格一个不变
// 第五十轮：只重录 world.json（四个）：文件的版本是 12；图片、表格一个不变（核对过文件写成版本 11 时与原来的值相同）
// 第五十一轮：只重录 world.json（四个）：命令里的 from 从 common 换成 medieval；图片、表格一个不变（核对过 from 写回 common 时与原来的值相同）
// 第五十三轮：只重录 world.json（四个）：文件的版本是 13；图片、表格一个不变（核对过文件写成版本 12 时与原来的值相同）
// 第五十七轮：world.json（四个）：新建的命令里多了现实的水系、毛皮多一种生态；星球的 resources.bmp、resources.csv（各两个）：毛皮长到高山苔原上。
// 河、生态、地形类别的图一个不变（核对过去掉这些时与原来的值相同）
// 第七十一轮：只重录 features.csv（四个）：type_name 一列大类地物的类型字跟着生态的名字（地区：苔原 1 行、沼泽湿地 2 行；
// 星球：冰盖 2 行、苔原 2 行、沼泽湿地 7 行）。核对过把这一列换回冰原、冻原、沼泽时四个都与原来的值相同，别的列没有新的字
// 第七十三轮：只重录 world.json（四个）：文件的版本是 14；图片、表格一个不变（核对过文件写成版本 13 时与原来的值相同）
// 第七十四轮：同样只重录 world.json（四个）：文件的版本是 15（核对过写成版本 14 时与原来的值相同）
// 第七十五轮：同样只重录 world.json（四个）：文件的版本是 16（核对过写成版本 15 时与原来的值相同）
// 第七十六轮：星球的 features.csv（两个）与 world.json（四个）：中文地名模板的沙漠 / 冻原 / 冰原改成荒漠 / 苔原 / 冰盖（地名与世界里的地名风格）；图片一个不变
// 第七十七轮：去掉了格局（countryLayout），新世界的小数据里没有内置的四种格局，只重录 world.json 四个（版本 17）；图片、表格一个不变；核对过旧的提交上新世界的内容去掉格局时得到同样的值（见 docs/dev/history/第77轮.md）

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
  // 第四十六轮：关掉区域的洋流（强弱 0 与第四十五轮逐值相同，见 fixtures 的 NO_CURRENTS）：与记下这些值时的世界相同
  eng.exec(NO_CURRENTS);
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

// 第四十六轮：一块地区先关掉洋流，只有 world.json（设置里写着 currents: 0）重录；第四十五轮的代码上同样的设置得到同样的值
// 第五十五轮：生态跟高度走：biomes.bmp、terrain.bmp、features.csv、provinces_summary.csv、资源、world.json、缩略图重录（高度、陆海、河、省份的不变）；核对过去掉高度范围时与原来的值逐值相同
const RECORDED: Record<string, string> = {
  'region 256x128 land': '40f111eba907e8c7',
  'region 256x128 elevation': '8f9308bdce2c8e2f',
  'region 256x128 cell': '2219fe841e4eaba8',
  'region 256x128 lakeDot': '83395b72b36be5ae',
  'region 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'region 256x128 heightmap.bmp': '45121eb33ad444ed',
  'region 256x128 heightmap16.png': '5b7ab2a54ecb82e3',
  'region 256x128 provinces.bmp': 'c58d000a7958d88e',
  'region 256x128 definition.csv': 'ba2a28c81706ec2e',
  'region 256x128 provinces_summary.csv': '2dcffc767ffae1e2',
  'region 256x128 features.csv': 'd879faeb63032e51',
  'region 256x128 terrain.bmp': '37974b74564b2fa0',
  'region 256x128 biomes.bmp': '52a63e9e0a83caae',
  'region 256x128 rivers.bmp': '9ac478f168eb64c9',
  'region 256x128 terrain_class.bmp': '7bab7972b88e0f30',
  'region 256x128 resources.bmp': '8c5357a61f173686',
  'region 256x128 terrain_classes.csv': 'e40143df203f2c29',
  'region 256x128 resources.csv': 'adee17512a93512f',
  'region 256x128 world.json': 'd6463c68993a15ce',
  'region 256x128 README.txt': 'e119bc0eb4669bf8',
  'region 300x150 land': '21ebb4f1ddc4a08b',
  'region 300x150 elevation': '53bf091ef5b50eb8',
  'region 300x150 cell': 'bff95c6c36dd6646',
  'region 300x150 lakeDot': '4903309dcdf23333',
  'region 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'region 300x150 heightmap.bmp': '6379c89031321752',
  'region 300x150 heightmap16.png': '798e669f60cf7249',
  'region 300x150 provinces.bmp': 'efa5bc12f8b5a44c',
  'region 300x150 definition.csv': 'ba2a28c81706ec2e',
  'region 300x150 provinces_summary.csv': '2dcffc767ffae1e2',
  'region 300x150 features.csv': '2626ee7413b613be',
  'region 300x150 terrain.bmp': '92c0fcda97f2206c',
  'region 300x150 biomes.bmp': '87c49b454f6edee5',
  'region 300x150 rivers.bmp': '9b3998d611e618ba',
  'region 300x150 terrain_class.bmp': '667734e6e709893c',
  'region 300x150 resources.bmp': 'd127157c2d2990de',
  'region 300x150 terrain_classes.csv': 'e40143df203f2c29',
  'region 300x150 resources.csv': 'adee17512a93512f',
  'region 300x150 world.json': 'd6463c68993a15ce',
  'region 300x150 README.txt': '61d7aa0393c2ab35',
  'region thumbnail': '8efca894a4696eca',
  'region functions': '21b1b0794f63fb65',
  'planet 256x128 land': '2840ce8210f850d6',
  'planet 256x128 elevation': '231d9feb13928df9',
  'planet 256x128 cell': '557fb0a97b15fa0b',
  'planet 256x128 lakeDot': 'ab838d974cfdabd7',
  'planet 256x128 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'planet 256x128 heightmap.bmp': 'd9cd82c8ddc9626e',
  'planet 256x128 heightmap16.png': '98c7b7d424ba5026',
  'planet 256x128 provinces.bmp': '0fda7b4292759c06',
  'planet 256x128 definition.csv': 'fb32209bec684ff5',
  'planet 256x128 provinces_summary.csv': 'd061726399d2bb01',
  'planet 256x128 features.csv': '96263f761eb50f34',
  'planet 256x128 terrain.bmp': '279a757945153ddf',
  'planet 256x128 biomes.bmp': '1785830708f407d7',
  'planet 256x128 rivers.bmp': '4fe2ee5b3aead50f',
  'planet 256x128 terrain_class.bmp': 'e4e48ba97c03cd43',
  'planet 256x128 resources.bmp': '54ad4d8a17c22a6a',
  'planet 256x128 terrain_classes.csv': '416ef548f21384fe',
  'planet 256x128 resources.csv': '3872e2d500c914df',
  'planet 256x128 world.json': '9e24db73cafaba8f',
  'planet 256x128 README.txt': '7d6804179e70b277',
  'planet 300x150 land': '84cf08ba8ffc6ab6',
  'planet 300x150 elevation': 'dd0a7bed4769b3a1',
  'planet 300x150 cell': '0af5ebe8b1c765f6',
  'planet 300x150 lakeDot': 'd3c5c4d6f4134f26',
  'planet 300x150 files': 'heightmap.bmp,heightmap16.png,provinces.bmp,definition.csv,provinces_summary.csv,features.csv,terrain.bmp,biomes.bmp,rivers.bmp,terrain_class.bmp,resources.bmp,terrain_classes.csv,resources.csv,world.json,README.txt',
  'planet 300x150 heightmap.bmp': '30b5c33a9ed99e6c',
  'planet 300x150 heightmap16.png': 'f3a5673c7ea7ed70',
  'planet 300x150 provinces.bmp': '6e7369023485d48c',
  'planet 300x150 definition.csv': 'fb32209bec684ff5',
  'planet 300x150 provinces_summary.csv': 'd061726399d2bb01',
  'planet 300x150 features.csv': 'c1f71a6fe8d3096b',
  'planet 300x150 terrain.bmp': 'cc5a24a054ee095a',
  'planet 300x150 biomes.bmp': '3bb710e9c9b6b8bf',
  'planet 300x150 rivers.bmp': '9c57d85c985371f2',
  'planet 300x150 terrain_class.bmp': '09c4146120ac9e93',
  'planet 300x150 resources.bmp': '09783432fa3e7b98',
  'planet 300x150 terrain_classes.csv': '416ef548f21384fe',
  'planet 300x150 resources.csv': '3872e2d500c914df',
  'planet 300x150 world.json': '9e24db73cafaba8f',
  'planet 300x150 README.txt': '57acf72e11dc422a',
  'planet thumbnail': '33920eb4237a4772',
  'planet functions': '2b5491eb1322a165',
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
