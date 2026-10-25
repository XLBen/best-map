import { speciesColor } from './species';
import { strToU8, zipSync, zlibSync } from 'fflate';
import type { WorldDoc } from './engine';
import { featureLabel } from './features';
import { provinceHuman, worldResources, worldTerrainClasses } from './human';
import { worldCultureGroups, worldCultures, worldDimensions } from './human/era';
import { provincePopulation } from './human/layers';
import { countryList } from './human/countries';
import { allCountryStats } from './human/country-layers';
import { CATEGORY_LABEL } from './human/resources';
import { archiveJson, archiveMarkdown, citiesCsv, hasSettlements, landmarksCsv, pointsCsv, roadsCsv, roadsGeojson } from './human/archive';
import { summarizeProvinces } from './provinces';
import { riverRibbon, traceRivers } from './rivers';
import { findCell } from './mesh';
import { wrapDelta } from './geo';
import { exportProvinceCells } from './seams';
import { rasterizeWorld } from './subcell';
import { type World, longitudeOf, provinceColor, worldLatitude } from './world';

// 导出：把格图栅格化成 Paradox 风格的一组文件。格是编辑与计算单位，像素只在导出时出现。

export interface ExportOptions {
  width: number;
  height: number;
  // 8 位高度图里的海平面灰度（EU4 约为 95）
  seaLevelGray: number;
  // 8 位高度图满灰度对应的海拔（m）
  maxElevation: number;
}

// 通用地形类别的颜色（不是游戏自带的索引调色板，导入游戏前需按其 terrain 定义重新映射）
export const TERRAIN_COLORS: Record<string, [number, number, number]> = {
  ocean: [8, 31, 130],
  lake: [55, 90, 220],
  arctic: [235, 235, 235],
  tundra: [190, 200, 175],
  forest: [40, 110, 40],
  plains: [150, 190, 80],
  steppe: [200, 190, 110],
  desert: [230, 210, 140],
  jungle: [20, 80, 30],
  savanna: [190, 180, 70],
  hills: [140, 120, 80],
  mountains: [100, 90, 90],
  marsh: [80, 120, 100],
};

function terrainColor(terrain: string): [number, number, number] {
  return TERRAIN_COLORS[terrain] ?? [255, 0, 255];
}

// 像素 → 格：沿行扫描时用上一个结果做 hint，Delaunay 游走很快
export function rasterizeCells(world: World, width: number, height: number): Int32Array {
  const { mesh } = world;
  const out = new Int32Array(width * height);
  let hint = 0;
  for (let py = 0; py < height; py++) {
    const y = ((py + 0.5) / height) * mesh.height;
    let rowHint = hint;
    for (let px = 0; px < width; px++) {
      const x = ((px + 0.5) / width) * mesh.width;
      rowHint = findCell(mesh, x, y, rowHint);
      out[py * width + px] = rowHint;
      if (px === 0) hint = rowHint;
    }
  }
  return out;
}

function encodeBmp24(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, rowSize * height, true);
  for (let y = 0; y < height; y++) {
    let o = 54 + (height - 1 - y) * rowSize;
    const end = (y + 1) * width * 3;
    for (let s = y * width * 3; s < end; s += 3, o += 3) {
      buf[o] = rgb[s + 2];
      buf[o + 1] = rgb[s + 1];
      buf[o + 2] = rgb[s];
    }
  }
  return buf;
}

// 8 位灰度 BMP（带 256 级灰度调色板）
function encodeBmp8Gray(gray: Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil(width / 4) * 4;
  const offset = 54 + 1024;
  const size = offset + rowSize * height;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, offset, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 8, true);
  dv.setUint32(34, rowSize * height, true);
  dv.setUint32(46, 256, true);
  for (let k = 0; k < 256; k++) {
    buf[54 + k * 4] = k;
    buf[54 + k * 4 + 1] = k;
    buf[54 + k * 4 + 2] = k;
  }
  for (let y = 0; y < height; y++) buf.set(gray.subarray(y * width, (y + 1) * width), offset + (height - 1 - y) * rowSize);
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 16 位灰度 PNG
function encodePng16Gray(values: Uint16Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 2 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 2 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const v = values[y * width + x];
      raw[row + 1 + x * 2] = v >> 8;
      raw[row + 2 + x * 2] = v & 255;
    }
  }
  return encodePngGray(raw, width, height, 16);
}

// 8 位灰度 PNG（第二十二轮，population.png）
function encodePng8Gray(values: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(values.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return encodePngGray(raw, width, height, 8);
}

// 灰度 PNG：raw 是每行前面带一个过滤字节（0）的像素
function encodePngGray(raw: Uint8Array, width: number, height: number, depth: 8 | 16): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(strToU8(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

// 湖面像素的湖底高度：这一格与相邻湖格的湖底按到像素的距离加权（栅格化给陆地像素的高度至少 2 m、带地表细节，
// 湖底要真实的深度）
function lakeBedAt(world: World, c: number, px: number, py: number, width: number, height: number): number {
  const { mesh, derived } = world;
  const x = ((px + 0.5) / width) * mesh.width;
  const y = ((py + 0.5) / height) * mesh.height;
  const sphere = mesh.kind === 'sphere';
  let s = 0;
  let w = 0;
  const add = (j: number) => {
    let dx = mesh.x[j] - x;
    if (sphere) dx -= 2 * Math.round(dx / 2);
    const dy = mesh.y[j] - y;
    const k = 1 / (dx * dx + dy * dy + 1e-4 * mesh.spacing * mesh.spacing);
    s += k * derived.elevation[j];
    w += k;
  };
  add(c);
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (derived.lake[mesh.adj[e]] === 1) add(mesh.adj[e]);
  return s / w;
}

// 高度图里海平面以下的量程（m）：灰度 0 是这么深
export const SEA_DEPTH_M = 11000;

// onProgress（可选）：报告完成的比例（0–1），栅格化约占前 70%，最后的压缩打包是一步（报不了中间进度）；不影响结果。
// warnings：要告诉用户的几句话（也写进 README.txt），没有就是空的
export function exportPackage(
  world: World,
  doc: WorldDoc,
  opts: ExportOptions,
  onProgress?: (fraction: number) => void,
): { zip: Uint8Array; files: string[]; warnings: string[] } {
  const { width, height } = opts;
  const { mesh, derived, small, causes } = world;
  // 与屏幕相同的判定：格以下的海岸细节、自然弯曲的省份边界、地表细节
  const raster = rasterizeWorld(world, width, height, onProgress && ((f) => onProgress(0.7 * f)));
  const cellOf = raster.cell;
  const elev = raster.elevation;
  const files: Record<string, Uint8Array> = {};
  const n = width * height;

  // 高度图：8 位（海平面 = seaLevelGray）与 16 位（海平面 = 1/4 量程）。海底、湖底都是真实的深度：
  // 湖面的像素取湖底（湖底比湖面至少低 1 m；很深的湖湖底可以在海平面以下，按海底的灰度算），
  // 海平面以下按 SEA_DEPTH_M 线性（最深的海沟约 −10000 m）
  const gray = new Uint8Array(n);
  const g16 = new Uint16Array(n);
  const sea = opts.seaLevelGray;
  for (let p = 0; p < n; p++) {
    let h = elev[p];
    const c = cellOf[p];
    if (raster.land[p] && derived.lake[c] === 1) h = Math.min(lakeBedAt(world, c, p % width, Math.floor(p / width), width, height), derived.water[c] - 1);
    elev[p] = h;
    gray[p] = h > 0 ? Math.min(255, Math.round(sea + 1 + (h / opts.maxElevation) * (254 - sea))) : Math.max(0, Math.round(sea * (1 + h / SEA_DEPTH_M)));
    g16[p] = h > 0 ? Math.min(65535, Math.round(16384 + (h / opts.maxElevation) * 49151)) : Math.max(0, Math.round(16383 * (1 + h / SEA_DEPTH_M)));
  }
  files['heightmap.bmp'] = encodeBmp8Gray(gray, width, height);
  files['heightmap16.png'] = encodePng16Gray(g16, width, height);
  onProgress?.(0.75);

  // 省份：每格的颜色先算好（无省份为黑），逐像素只抄三个字节
  const provinces = summarizeProvinces(world, derived);
  const ids = [...provinces.keys()].sort((a, b) => a - b);
  const provRgb = new Uint8Array(mesh.n * 3);
  for (let i = 0; i < mesh.n; i++) {
    const pid = causes.province[i];
    if (pid >= 0) provRgb.set(provinceColor(pid), i * 3);
  }
  // 剪刀切过的地方：切线附近的像素按在线的哪一边分省（与屏幕上相同，见 seams.ts）；别的文件仍按格
  const prov = exportProvinceCells(world, cellOf, width, height);
  const rgb = new Uint8Array(n * 3);
  copyCellRgb(rgb, provRgb, prov.cell);
  files['provinces.bmp'] = encodeBmp24(rgb, width, height);
  const def = ['province;red;green;blue;name;x'];
  // 第二十一轮在最后加了两列：格数最多的地形类别、资源（id）
  const human = provinceHuman(world, derived);
  // 第二十二轮：有人文时再加人口、人数最多的文化、文化组、每一维的取值（没有人文的世界与以前一字不差）
  const people = world.small.human ? provincePopulation(world) : null;
  const dims = people ? worldDimensions(small).map((x) => x.id) : [];
  const popHead = people ? `,population,culture,culture_group${dims.map((x) => `,${x}`).join('')}` : '';
  // 第二十三轮：有国家时再加一列 country（省份所属国家的编号，无主为空）
  const owner = small.countries && causes.country ? provinceCountries(world) : null;
  const csv = [`id,name,land,kind,terrain,species,cells,mean_elevation_m,terrain_class,resource${popHead}${owner ? ',country' : ''}`];
  ids.forEach((pid, k) => {
    const [r, g, b] = provinceColor(pid);
    const s = provinces.get(pid)!;
    const name = (s.name || `p${pid}`).replace(/[;,]/g, ' ');
    const h = human.get(pid);
    def.push(`${k + 1};${r};${g};${b};${name};x`);
    const pp = people?.get(pid);
    const popCols = people ? `,${Math.round(pp?.population ?? 0)},${pp?.culture ?? ''},${pp?.cultureGroup ?? ''}${dims.map((_, q) => `,${pp?.values[q] ?? ''}`).join('')}` : '';
    const own = owner ? `,${owner.get(pid) ?? ''}` : '';
    csv.push(`${pid},${name},${s.land ? 1 : 0},${s.kind},${s.terrain},${s.species ?? ''},${s.cells},${s.meanElevation.toFixed(0)},${h?.terrainClass ?? ''},${h?.resource ?? ''}${popCols}${own}`);
  });
  files['definition.csv'] = strToU8(`${def.join('\n')}\n`);
  files['provinces_summary.csv'] = strToU8(`${csv.join('\n')}\n`);

  // 地名：类型、名字、面积、中心（导出图片上的像素坐标与经纬度）
  files['features.csv'] = strToU8(featuresCsv(world, width, height));

  // 地形：逐像素按格的主导类型（山地按海拔另判），湖与海单列。
  // 每格主导类型的地形颜色与植被颜色先算好；固定颜色依次是海、湖、山地、丘陵（地形）与海、湖（植被）
  const kindRgb = new Uint8Array(mesh.n * 3);
  const vegRgb = new Uint8Array(mesh.n * 3);
  for (let i = 0; i < mesh.n; i++) {
    const s = derived.dominant[i];
    const sp = s >= 0 ? small.species[s] : null;
    kindRgb.set(terrainColor(sp?.terrain ?? 'desert'), i * 3);
    vegRgb.set(sp ? hexToRgb(speciesColor(sp)) : [200, 200, 200], i * 3);
  }
  const fixed = new Uint8Array(18);
  ['ocean', 'lake', 'mountains', 'hills'].forEach((t, k) => fixed.set(terrainColor(t), k * 3));
  fixed.set([30, 60, 110, 60, 110, 170], 12);
  const terrainRgb = new Uint8Array(n * 3);
  const biomeRgb = new Uint8Array(n * 3);
  for (let p = 0; p < n; p++) {
    const c = cellOf[p];
    let tc: Uint8Array = fixed;
    let to: number;
    let bc: Uint8Array = fixed;
    let bo: number;
    if (!raster.land[p]) {
      to = 0;
      bo = 12;
    } else if (derived.lake[c] === 1) {
      to = 3;
      bo = 15;
    } else {
      if (elev[p] > 2400) to = 6;
      else if (elev[p] > 1100 && derived.slope[c] > 10) to = 9;
      else {
        tc = kindRgb;
        to = c * 3;
      }
      bc = vegRgb;
      bo = c * 3;
    }
    const q = p * 3;
    terrainRgb[q] = tc[to];
    terrainRgb[q + 1] = tc[to + 1];
    terrainRgb[q + 2] = tc[to + 2];
    biomeRgb[q] = bc[bo];
    biomeRgb[q + 1] = bc[bo + 1];
    biomeRgb[q + 2] = bc[bo + 2];
  }
  files['terrain.bmp'] = encodeBmp24(terrainRgb, width, height);
  files['biomes.bmp'] = encodeBmp24(biomeRgb, width, height);
  onProgress?.(0.78);

  // 河流：白色陆地、粉色海洋，河流按流量分级着蓝色（EU4 rivers.bmp 的配色习惯，需转成其索引调色板）
  const riverRgb = new Uint8Array(n * 3);
  const thr = small.planet.riverThreshold;
  for (let p = 0; p < n; p++) {
    riverRgb[p * 3] = 255;
    riverRgb[p * 3 + 1] = raster.land[p] ? 255 : 0;
    riverRgb[p * 3 + 2] = raster.land[p] ? 255 : 128;
  }
  drawRivers(world, riverRgb, raster.land, width, height, thr);
  files['rivers.bmp'] = encodeBmp24(riverRgb, width, height);
  onProgress?.(0.8);

  // 地形类别与资源（第二十一轮）
  Object.assign(files, humanFiles(world, cellOf, raster.land, width, height));
  // 人口与文化（第二十二轮）：只在生成过人文时有
  if (world.small.human && derived.popCulture) Object.assign(files, populationFiles(world, cellOf, raster.land, width, height));
  // 国家（第二十三轮）：只在有国家时有
  const hasCountries = !!(small.countries && causes.country && derived.country);
  if (hasCountries) Object.assign(files, countryFiles(world, cellOf, raster.land, width, height));
  // 城市、道路、地标、自定义点与档案全文（第二十四轮）：只在有它们时有
  const settle = hasSettlements(world);
  if (settle) Object.assign(files, settlementFiles(world, raster.land, width, height));

  files['world.json'] = strToU8(JSON.stringify(doc));
  files['README.txt'] = strToU8(
    [
      '架空世界编辑器导出',
      '',
      `尺寸：${width}×${height}`,
      `heightmap.bmp：8 位灰度，海平面灰度 ${opts.seaLevelGray}，255 ≈ ${opts.maxElevation} m`,
      'heightmap16.png：16 位灰度，16384 为海平面，65535 ≈ 最高海拔',
      `海平面以下（海底、很深的湖底）按深度线性：0 ≈ −${SEA_DEPTH_M} m；湖面的像素是湖底的高度`,
      `provinces.bmp + definition.csv：${ids.length} 个省份，颜色一一对应`,
      'provinces_summary.csv：每个省份的名称、陆海、类型（陆地 / 无人区 / 湖 / 海域）、地形类别、主导类型、格数、平均海拔',
      'features.csv：自动识别的地名（大陆、岛、海、湾、河、山脉……）：类型、名字、面积、中心在图上的像素坐标与经纬度',
      'terrain.bmp：通用地形类别着色（不是游戏的索引调色板，需按游戏的 terrain 定义重新映射）',
      'biomes.bmp：按类型颜色着色的植被图',
      'rivers.bmp：24 位，需转为游戏要求的 8 位索引调色板',
      'terrain_class.bmp + terrain_classes.csv：每格的地形类别（平原、丘陵、山地……），颜色与编号一一对应',
      'resources.bmp + resources.csv：每格的资源，白色是没有资源的陆地',
      ...(world.small.human && derived.popCulture
        ? [
            `population.png：8 位灰度的人口密度，按对数：0 没有人，255 ≈ ${POP_PNG_MAX} 人/km²（灰度 = 255 × log10(1 + 密度) / log10(1 + ${POP_PNG_MAX})）`,
            'cultures.bmp + cultures.csv：每格人口里占多数的文化，颜色与编号一一对应；白色是没有人的陆地',
            'provinces_summary.csv 最后几列：人口、人数最多的文化、文化组与每一维的取值',
          ]
        : []),
      ...(hasCountries
        ? [
            'countries.bmp + countries.csv：每格所属的国家（国家自己的颜色）；白色是无主的陆地，领海是国家的颜色与海的颜色各一半',
            'provinces_summary.csv 的 country 列：省份所属国家的编号（countries.csv 的 id），无主为空',
          ]
        : []),
      ...(settle
        ? [
            'cities.csv：城市（等级、首都、所属国家、人口与占本国的比例、格、经纬度）；roads.csv + roads.geojson：道路（大道、小路，经过的格与经纬度折线）',
            'roads.bmp：道路图，白色陆地、粉色海洋，大道红色、小路橙色',
            'landmarks.csv：地标（自然的、人造的）；points.csv：自定义点',
            'archive.md：档案全文（国家、城市、地标、自定义点）；archive.json：全部人文数据',
          ]
        : []),
      'world.json：完整的世界文件（设置 + 命令记录），可在编辑器中重新打开',
      ...(prov.warnings.length ? ['', '注意：', ...prov.warnings] : []),
    ].join('\n'),
  );
  const zip = zipSync(files, { level: 6 });
  onProgress?.(1);
  return { zip, files: Object.keys(files), warnings: prov.warnings };
}

// 地形类别、资源的图与表（第二十一轮）：逐像素按格；海、湖用 terrain.bmp 的颜色。没有类别的陆地像素
// （画成陆地的碎岛落在海格里）按兜底的那一类；没有资源的陆地是白色
function humanFiles(world: World, cellOf: Int32Array, land: Uint8Array, width: number, height: number): Record<string, Uint8Array> {
  const { mesh, derived: d } = world;
  const classes = worldTerrainClasses(world.small);
  const resources = worldResources(world.small);
  const fallback = classes.findIndex((c) => c.fallback) + 1;
  // 每个编号的颜色：0 号是兜底的那一类 / 没有资源
  const classRgb = new Uint8Array((classes.length + 1) * 3);
  classes.forEach((c, k) => classRgb.set(hexToRgb(c.exportColor ?? c.color), (k + 1) * 3));
  if (fallback) classRgb.copyWithin(0, fallback * 3, fallback * 3 + 3);
  const resRgb = new Uint8Array((resources.length + 1) * 3).fill(255);
  resources.forEach((r, k) => resRgb.set(hexToRgb(r.color), (k + 1) * 3));
  const sea = terrainColor('ocean');
  const lake = terrainColor('lake');
  const n = cellOf.length;
  const tc = new Uint8Array(n * 3);
  const rc = new Uint8Array(n * 3);
  for (let p = 0; p < n; p++) {
    const c = cellOf[p];
    const q = p * 3;
    if (!land[p] || d.lake[c] === 1) {
      const col = land[p] ? lake : sea;
      tc.set(col, q);
      rc.set(col, q);
      continue;
    }
    const a = d.terrainClass[c] * 3;
    tc[q] = classRgb[a];
    tc[q + 1] = classRgb[a + 1];
    tc[q + 2] = classRgb[a + 2];
    const b = d.resource[c] * 3;
    rc[q] = resRgb[b];
    rc[q + 1] = resRgb[b + 1];
    rc[q + 2] = resRgb[b + 2];
  }
  // 表：编号、id、名字、颜色、格数
  const classCells = new Int32Array(classes.length + 1);
  const resCells = new Int32Array(resources.length + 1);
  for (let i = 0; i < mesh.n; i++) {
    classCells[d.terrainClass[i]]++;
    resCells[d.resource[i]]++;
  }
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const classCsv = ['code,id,name,red,green,blue,terrain,cells'];
  classes.forEach((c, k) => {
    const [r, g, b] = hexToRgb(c.exportColor ?? c.color);
    classCsv.push(`${k + 1},${c.id},${esc(c.name)},${r},${g},${b},${c.terrain ?? ''},${classCells[k + 1]}`);
  });
  const resCsv = ['code,id,name,category,red,green,blue,cells'];
  resources.forEach((x, k) => {
    const [r, g, b] = hexToRgb(x.color);
    resCsv.push(`${k + 1},${x.id},${esc(x.name)},${CATEGORY_LABEL[x.category]},${r},${g},${b},${resCells[k + 1]}`);
  });
  return {
    'terrain_class.bmp': encodeBmp24(tc, width, height),
    'resources.bmp': encodeBmp24(rc, width, height),
    'terrain_classes.csv': strToU8(`${classCsv.join('\n')}\n`),
    'resources.csv': strToU8(`${resCsv.join('\n')}\n`),
  };
}

// population.png 的满灰度：人 / km²
export const POP_PNG_MAX = 1000;

// 人口与文化的图与表（第二十二轮）：population.png（人口密度，对数灰度）、cultures.bmp（人口里占多数的文化，海、湖用 terrain.bmp 的颜色，
// 没有人的陆地是白色）、cultures.csv（code, id, name, group, red, green, blue, population, cells）
function populationFiles(world: World, cellOf: Int32Array, land: Uint8Array, width: number, height: number): Record<string, Uint8Array> {
  const { mesh, derived: d, causes } = world;
  const cultures = worldCultures(world.small);
  const groups = worldCultureGroups(world.small);
  const rgb = new Uint8Array((cultures.length + 1) * 3).fill(255);
  cultures.forEach((c, k) => rgb.set(hexToRgb(c.color), (k + 1) * 3));
  const sea = terrainColor('ocean');
  const lake = terrainColor('lake');
  const cul = d.popCulture!;
  const dens = d.popDensity!;
  const scale = 255 / Math.log10(1 + POP_PNG_MAX);
  const cellGray = new Uint8Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) cellGray[i] = dens[i] > 0 ? Math.min(255, Math.max(1, Math.round(Math.log10(1 + dens[i]) * scale))) : 0;
  const n = cellOf.length;
  const gray = new Uint8Array(n);
  const out = new Uint8Array(n * 3);
  for (let p = 0; p < n; p++) {
    const c = cellOf[p];
    const q = p * 3;
    if (!land[p] || d.lake[c] === 1) {
      out.set(land[p] ? lake : sea, q);
      continue;
    }
    gray[p] = cellGray[c];
    const a = cul[c] * 3;
    out[q] = rgb[a];
    out[q + 1] = rgb[a + 1];
    out[q + 2] = rgb[a + 2];
  }
  const pop = new Float64Array(cultures.length + 1);
  const cells = new Int32Array(cultures.length + 1);
  for (let i = 0; i < mesh.n; i++) {
    if (!cul[i]) continue;
    pop[cul[i]] += causes.popTotal![i];
    cells[cul[i]]++;
  }
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = ['code,id,name,group,red,green,blue,population,cells'];
  cultures.forEach((c, k) => {
    const [r, g, b] = hexToRgb(c.color);
    csv.push(`${k + 1},${c.id},${esc(c.name)},${groups.find((x) => x.id === c.group)?.id ?? ''},${r},${g},${b},${Math.round(pop[k + 1])},${cells[k + 1]}`);
  });
  return {
    'population.png': encodePng8Gray(gray, width, height),
    'cultures.bmp': encodeBmp24(out, width, height),
    'cultures.csv': strToU8(`${csv.join('\n')}\n`),
  };
}

// 每个陆地省所属的国家（省份跟着国界，一个省一个国家；取省里第一个陆地格的）
function provinceCountries(world: World): Map<number, number> {
  const out = new Map<number, number>();
  const seen = new Set<number>();
  const { causes, small } = world;
  const c = causes.country!;
  for (let i = 0; i < c.length; i++) {
    const p = causes.province[i];
    if (p < 0 || seen.has(p) || !small.provinces[p]?.land || !causes.land[i]) continue;
    seen.add(p);
    if (c[i] >= 0) out.set(p, c[i]);
  }
  return out;
}

// 国家的图与表（第二十三轮）：countries.bmp（国家自己的颜色；海、湖用 terrain.bmp 的颜色，无主的陆地是白色，领海是国家的颜色与海各一半）、
// countries.csv（id, name, orig, red, green, blue, government, culture, capital, population, area_km2, overlord）
function countryFiles(world: World, cellOf: Int32Array, land: Uint8Array, width: number, height: number): Record<string, Uint8Array> {
  const { mesh, derived: d, causes } = world;
  const list = countryList(world.small);
  const sea = terrainColor('ocean');
  const lake = terrainColor('lake');
  const white: [number, number, number] = [255, 255, 255];
  const codeRgb = list.map((m) => hexToRgb(m.color));
  const code = d.country!;
  const cellRgb = new Uint8Array(mesh.n * 3);
  for (let i = 0; i < mesh.n; i++) {
    const k = code[i];
    let col: readonly number[];
    if (!causes.land[i]) col = k ? codeRgb[k - 1].map((v, q) => Math.round((v + sea[q]) / 2)) : sea;
    else if (d.lake[i] === 1) col = lake;
    else col = k ? codeRgb[k - 1] : white;
    cellRgb.set(col, i * 3);
  }
  const out = new Uint8Array(cellOf.length * 3);
  for (let p = 0; p < cellOf.length; p++) {
    const c = cellOf[p];
    const q = p * 3;
    // 画成陆地的碎岛落在海格里：按无主的陆地；画成水的陆地格按湖、海
    if (land[p] && !causes.land[c]) out.set(white, q);
    else if (!land[p] && causes.land[c]) out.set(d.lake[c] === 1 ? lake : sea, q);
    else {
      out[q] = cellRgb[c * 3];
      out[q + 1] = cellRgb[c * 3 + 1];
      out[q + 2] = cellRgb[c * 3 + 2];
    }
  }
  return {
    'countries.bmp': encodeBmp24(out, width, height),
    'countries.csv': strToU8(countriesCsv(world)),
  };
}

// countries.csv（id, name, orig, red, green, blue, government, culture, capital, population, area_km2, overlord；capital 是格的编号）
export function countriesCsv(world: World): string {
  const stats = allCountryStats(world);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = ['id,name,orig,red,green,blue,government,culture,capital,population,area_km2,overlord'];
  for (const m of countryList(world.small)) {
    const [r, g, b] = hexToRgb(m.color);
    const st = stats.get(m.id);
    csv.push(`${m.id},${esc(m.name)},${esc(m.orig ?? '')},${r},${g},${b},${m.government},${m.primaryCulture},${m.capitalCell ?? ''},${Math.round(st?.population ?? 0)},${Math.round(st?.areaKm2 ?? 0)},${m.overlord ?? ''}`);
  }
  return `${csv.join('\n')}\n`;
}

// 城市、道路、地标、自定义点的表、道路图与档案全文（第二十四轮）
function settlementFiles(world: World, land: Uint8Array, width: number, height: number): Record<string, Uint8Array> {
  return {
    'cities.csv': strToU8(citiesCsv(world)),
    'roads.csv': strToU8(roadsCsv(world)),
    'roads.geojson': strToU8(roadsGeojson(world)),
    'roads.bmp': encodeBmp24(roadsImage(world, land, width, height), width, height),
    'landmarks.csv': strToU8(landmarksCsv(world)),
    'points.csv': strToU8(pointsCsv(world)),
    'archive.md': strToU8(archiveMarkdown(world)),
    'archive.json': strToU8(archiveJson(world)),
  };
}

// 道路图：白色陆地、粉色海洋（同 rivers.bmp），大道红色（宽一些）、小路橙色，按格心连成的折线
export function roadsImage(world: World, land: Uint8Array, width: number, height: number): Uint8Array {
  const { mesh } = world;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    rgb[p * 3] = 255;
    rgb[p * 3 + 1] = land[p] ? 255 : 0;
    rgb[p * 3 + 2] = land[p] ? 255 : 128;
  }
  const sphere = mesh.kind === 'sphere';
  const sx = width / mesh.width;
  const sy = height / mesh.height;
  const scale = Math.max(1, width / 2048);
  const roads = Object.values(world.small.roads ?? {}).sort((a, b) => (a.kind === 'major' ? 1 : 0) - (b.kind === 'major' ? 1 : 0) || a.id - b.id);
  for (const r of roads) {
    const major = r.kind === 'major';
    const col = major ? [200, 30, 30] : [230, 140, 40];
    const rad = (major ? 1.2 : 0.6) * scale;
    const ri = Math.ceil(rad);
    const r2 = rad * rad + 0.25;
    let px0 = mesh.x[r.cells[0]];
    for (let k = 0; k + 1 < r.cells.length; k++) {
      const a = r.cells[k];
      const b = r.cells[k + 1];
      const ax = px0;
      const bx = sphere ? ax + wrapDelta(mesh.x[b] - ax) : mesh.x[b];
      px0 = bx;
      const x0 = ax * sx;
      const y0 = mesh.y[a] * sy;
      const x1 = bx * sx;
      const y1 = mesh.y[b] * sy;
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
      for (let st = 0; st <= steps; st++) {
        const t = st / steps;
        const fx = Math.floor(x0 + (x1 - x0) * t);
        const fy = Math.floor(y0 + (y1 - y0) * t);
        for (let oy = -ri; oy <= ri; oy++) {
          for (let ox = -ri; ox <= ri; ox++) {
            if (ox * ox + oy * oy > r2) continue;
            let x = fx + ox;
            const y = fy + oy;
            if (sphere) x = ((x % width) + width) % width;
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const q = (y * width + x) * 3;
            rgb[q] = col[0];
            rgb[q + 1] = col[1];
            rgb[q + 2] = col[2];
          }
        }
      }
    }
  }
  return rgb;
}

// 分开导出的一项（第二十四轮，界面的“导出 ⋯”用）：表、档案全文按世界现写；图要宽高（按格栅格化，不含格以下的海岸细节）
export const EXPORT_PARTS = [
  { id: 'cities', label: '城市表', files: ['cities.csv'] },
  { id: 'roads', label: '道路', files: ['roads.csv', 'roads.geojson'] },
  { id: 'roads-image', label: '道路图', files: ['roads.bmp'], image: true },
  { id: 'landmarks', label: '地标表', files: ['landmarks.csv'] },
  { id: 'points', label: '自定义点表', files: ['points.csv'] },
  { id: 'countries', label: '国家表', files: ['countries.csv'] },
  { id: 'features', label: '地名表', files: ['features.csv'] },
  { id: 'archive-md', label: '档案全文', files: ['archive.md'] },
  { id: 'archive-json', label: '人文数据', files: ['archive.json'] },
] as const;
export type ExportPartId = (typeof EXPORT_PARTS)[number]['id'];

// 这一项在这个世界里有没有内容
export function exportPartAvailable(world: World, id: ExportPartId): boolean {
  const s = world.small;
  switch (id) {
    case 'cities':
      return !!s.cities && Object.keys(s.cities).length > 0;
    case 'roads':
    case 'roads-image':
      return !!s.roads && Object.keys(s.roads).length > 0;
    case 'landmarks':
      return !!s.landmarks && Object.keys(s.landmarks).length > 0;
    case 'points':
      return !!s.points && Object.keys(s.points).length > 0;
    case 'countries':
      return !!s.countries && Object.keys(s.countries).length > 0;
    case 'features':
      return true;
    case 'archive-md':
    case 'archive-json':
      return !!s.human || hasSettlements(world);
  }
}

export function exportPart(world: World, id: ExportPartId, size: { width: number; height: number } = { width: 4096, height: Math.round((4096 * world.mesh.height) / world.mesh.width) }): Record<string, Uint8Array> {
  switch (id) {
    case 'cities':
      return { 'cities.csv': strToU8(citiesCsv(world)) };
    case 'roads':
      return { 'roads.csv': strToU8(roadsCsv(world)), 'roads.geojson': strToU8(roadsGeojson(world)) };
    case 'roads-image': {
      const cells = rasterizeCells(world, size.width, size.height);
      const land = new Uint8Array(cells.length);
      for (let p = 0; p < cells.length; p++) land[p] = world.causes.land[cells[p]];
      return { 'roads.bmp': encodeBmp24(roadsImage(world, land, size.width, size.height), size.width, size.height) };
    }
    case 'landmarks':
      return { 'landmarks.csv': strToU8(landmarksCsv(world)) };
    case 'points':
      return { 'points.csv': strToU8(pointsCsv(world)) };
    case 'countries':
      return { 'countries.csv': strToU8(countriesCsv(world)) };
    case 'features':
      return { 'features.csv': strToU8(featuresCsv(world, size.width, size.height)) };
    case 'archive-md':
      return { 'archive.md': strToU8(archiveMarkdown(world)) };
    case 'archive-json':
      return { 'archive.json': strToU8(archiveJson(world)) };
  }
}

// 逐像素按格抄颜色：out[p] = cellRgb[cellOf[p]]（各三个字节）
function copyCellRgb(out: Uint8Array, cellRgb: Uint8Array, cellOf: Int32Array) {
  for (let p = 0; p < cellOf.length; p++) {
    const c = cellOf[p] * 3;
    out[p * 3] = cellRgb[c];
    out[p * 3 + 1] = cellRgb[c + 1];
    out[p * 3 + 2] = cellRgb[c + 2];
  }
}

// 地名表：重要的在前；CSV 字段里的逗号与引号按 RFC 4180 转义。
// 有名字带原文（第二十轮，音译式等地名风格）时在 name 后面多一列 orig；都没有时与以前一字不差
export function featuresCsv(world: World, width: number, height: number): string {
  const { mesh } = world;
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const features = world.derived.features.filter((f) => !f.hidden).sort((a, b) => b.importance - a.importance);
  const withOrig = features.some((f) => f.orig);
  const rows = [withOrig ? 'type,type_name,name,orig,custom,area_km2,x_px,y_px,lat,lon,key' : 'type,type_name,name,custom,area_km2,x_px,y_px,lat,lon,key'];
  const lonSpan = (mesh.width * world.kmPerUnit) / 111.2;
  for (const f of features) {
    const lat = worldLatitude(world, f.y);
    // 整个星球：真实的经度；一块地区按赤道尺度把 x 换成相对地图中心的经度
    const lon = world.settings.globe ? longitudeOf(f.x) : (f.x / mesh.width - 0.5) * lonSpan;
    rows.push(
      [
        f.type,
        esc(featureLabel(world, f)),
        esc(f.name),
        ...(withOrig ? [esc(f.orig ?? '')] : []),
        f.custom ? 1 : 0,
        Math.round(f.areaKm2),
        Math.round((f.x / mesh.width) * width),
        Math.round((f.y / mesh.height) * height),
        lat.toFixed(2),
        lon.toFixed(2),
        f.key,
      ].join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

// 河流按平滑后的折线栅格化（与屏幕上的河一致），宽度随流量；画的河再乘它的粗细
function drawRivers(world: World, rgb: Uint8Array, land: Uint8Array, width: number, height: number, thr: number) {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const sx = width / mesh.width;
  const sy = height / mesh.height;
  const scale = width / 1600;
  const colors: [number, number, number][] = [
    [0, 225, 255],
    [0, 200, 255],
    [0, 150, 255],
    [0, 100, 255],
    [0, 50, 200],
  ];
  // 与屏幕上同一条带子（core/rivers.ts 的 riverRibbon：中线带细小的弯曲，宽度平滑、源头收尖、河口张开）
  for (const line of traceRivers(world)) {
    const rb = riverRibbon(line, thr, mesh.spacing);
    for (let k = 0; k + 1 < rb.x.length; k++) {
      const flow = (line.flow[rb.src[k]] + line.flow[Math.min(line.flow.length - 1, rb.src[k] + 1)]) / 2;
      const level = Math.min(colors.length - 1, Math.max(0, Math.floor(Math.log10(flow / thr) * 2)));
      const col = colors[level];
      const r = Math.max(0, ((rb.hw[k] + rb.hw[k + 1]) * scale - 1) / 2);
      const ri = Math.ceil(r);
      const r2 = r * r + 0.25;
      const x0 = rb.x[k] * sx;
      const y0 = rb.y[k] * sy;
      const x1 = rb.x[k + 1] * sx;
      const y1 = rb.y[k + 1] * sy;
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
      for (let st = 0; st <= steps; st++) {
        const t = st / steps;
        const fx = Math.floor(x0 + (x1 - x0) * t);
        const fy = Math.floor(y0 + (y1 - y0) * t);
        for (let oy = -ri; oy <= ri; oy++) {
          for (let ox = -ri; ox <= ri; ox++) {
            if (ox * ox + oy * oy > r2) continue;
            let px = fx + ox;
            const py = fy + oy;
            // 整个星球：河的折线跨过接缝时 x 会超出图宽，绕回另一边
            if (sphere) px = ((px % width) + width) % width;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const p = py * width + px;
            if (!land[p]) continue;
            rgb[p * 3] = col[0];
            rgb[p * 3 + 1] = col[1];
            rgb[p * 3 + 2] = col[2];
          }
        }
      }
    }
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
