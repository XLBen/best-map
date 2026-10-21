// 快速预览地形（不跑气候与水文）：按 landness 着色输出 PNG，用来看生成器的形状
// npx tsx tools/preview-terrain.ts <输出目录> [cells] [宽度像素] [类型,...] [种子数] [--globe]
//   --globe：整个星球（输出 2:1 的经纬度等距图）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zlibSync } from 'fflate';
import { WORLD_TYPES, type WorldType } from '../core/generate';
import { type Mesh, buildMesh } from '../core/mesh';
import { buildSphereMesh } from '../core/sphere';
import { resolveTerrain } from '../core/terrain';
import { createWorld } from '../core/world';
import { rasterizeCells } from '../core/export';

const out = process.argv[2] ?? 'out/preview';
const cells = Number(process.argv[3] ?? 40000);
const width = Number(process.argv[4] ?? 800);
const types = (process.argv[5]?.split(',') ?? WORLD_TYPES) as WorldType[];
const seeds = Number(process.argv[6] ?? 2);
const globe = process.argv.includes('--globe');
mkdirSync(out, { recursive: true });
const mesh: Mesh = globe ? buildSphereMesh(cells, 1) : buildMesh(cells, 2, 1);
const settings = globe ? { cells, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { cells, seed: 1 };

function png(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (d: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of d) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const o = new Uint8Array(12 + data.length);
    const dv = new DataView(o.buffer);
    dv.setUint32(0, data.length);
    o.set(strToU8(type), 4);
    o.set(data, 8);
    dv.setUint32(8 + data.length, crc(o.subarray(4, 8 + data.length)));
    return o;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())];
  const res = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    res.set(p, o);
    o += p.length;
  }
  return res;
}

for (const type of types) {
  for (let seed = 1; seed <= seeds; seed++) {
    const w = createWorld(settings, mesh);
    w.small.terrain.gen = { seed, type, mountains: 1, rerolls: [] };
    resolveTerrain(w);
    const h = Math.round(width / 2);
    const cellOf = rasterizeCells(w, width, h);
    const rgb = new Uint8Array(width * h * 3);
    for (let p = 0; p < width * h; p++) {
      const c = cellOf[p];
      const L = w.causes.landness[c];
      let col: [number, number, number];
      if (w.causes.land[c]) {
        const u = w.causes.uplift[c];
        const t = Math.min(1, u / 1.2);
        col = [110 + 120 * t, 150 + 40 * t - 60 * t * t, 90 + 60 * t];
      } else {
        const t = Math.min(1, -L / 4500);
        col = L > -250 ? [120, 175, 200] : [40 + 40 * (1 - t), 70 + 60 * (1 - t), 120 + 50 * (1 - t)];
      }
      rgb.set(col.map((v) => Math.max(0, Math.min(255, v))), p * 3);
    }
    writeFileSync(join(out, `${globe ? 'globe-' : ''}${type}-${seed}.png`), png(rgb, width, h));
  }
}
console.log('done');
