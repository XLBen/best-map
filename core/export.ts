import { strToU8, zipSync, zlibSync } from 'fflate';
import type { WorldDoc } from './engine';
import { featureLabel } from './features';
import { summarizeProvinces } from './provinces';
import { riverWidth, traceRivers } from './rivers';
import { findCell } from './mesh';
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
  ihdr[8] = 16;
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
  const csv = ['id,name,land,kind,terrain,species,cells,mean_elevation_m'];
  ids.forEach((pid, k) => {
    const [r, g, b] = provinceColor(pid);
    const s = provinces.get(pid)!;
    const name = (s.name || `p${pid}`).replace(/[;,]/g, ' ');
    def.push(`${k + 1};${r};${g};${b};${name};x`);
    csv.push(`${pid},${name},${s.land ? 1 : 0},${s.kind},${s.terrain},${s.species ?? ''},${s.cells},${s.meanElevation.toFixed(0)}`);
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
    vegRgb.set(sp ? hexToRgb(sp.color) : [200, 200, 200], i * 3);
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
      'world.json：完整的世界文件（设置 + 命令记录），可在编辑器中重新打开',
      ...(prov.warnings.length ? ['', '注意：', ...prov.warnings] : []),
    ].join('\n'),
  );
  const zip = zipSync(files, { level: 6 });
  onProgress?.(1);
  return { zip, files: Object.keys(files), warnings: prov.warnings };
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

// 地名表：重要的在前；CSV 字段里的逗号与引号按 RFC 4180 转义
export function featuresCsv(world: World, width: number, height: number): string {
  const { mesh } = world;
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = ['type,type_name,name,custom,area_km2,x_px,y_px,lat,lon,key'];
  const lonSpan = (mesh.width * world.kmPerUnit) / 111.2;
  const features = [...world.derived.features].sort((a, b) => b.importance - a.importance);
  for (const f of features) {
    const lat = worldLatitude(world, f.y);
    // 整个星球：真实的经度；一块地区按赤道尺度把 x 换成相对地图中心的经度
    const lon = world.settings.globe ? longitudeOf(f.x) : (f.x / mesh.width - 0.5) * lonSpan;
    rows.push(
      [
        f.type,
        featureLabel(world, f),
        esc(f.name),
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
  for (const line of traceRivers(world)) {
    for (let k = 0; k + 1 < line.points.length; k++) {
      const flow = (line.flow[k] + line.flow[k + 1]) / 2;
      const level = Math.min(colors.length - 1, Math.max(0, Math.floor(Math.log10(flow / thr) * 2)));
      const col = colors[level];
      // 没有粗细倍数的（自然的河、没调过粗细的画的河）照原来的算式，逐位不变
      const r = line.mul ? Math.max(0, (riverWidth(flow, thr) * ((line.mul[k] + line.mul[k + 1]) / 2) * scale - 1) / 2) : Math.max(0, (riverWidth(flow, thr) * scale - 1) / 2);
      const ri = Math.ceil(r);
      const r2 = r * r + 0.25;
      const x0 = line.points[k][0] * sx;
      const y0 = line.points[k][1] * sy;
      const x1 = line.points[k + 1][0] * sx;
      const y1 = line.points[k + 1][1] * sy;
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
