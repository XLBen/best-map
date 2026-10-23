// 打印各层数据的哈希，用于核对不同环境下结果是否逐值一致（Node 与浏览器跑同一段代码，比对输出）
import { Engine } from '../core/engine';
import { hashString } from '../core/names';

export function hashArray(a: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < a.length; i++) {
    f[0] = a[i];
    h = Math.imul(h ^ u[0], 0x01000193) >>> 0;
    h = Math.imul(h ^ u[1], 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// 固定的一组操作：生成世界、划分省份、放岛、涂生态、画河。返回各层的哈希
export function referenceHashes(): Record<string, string> {
  const eng = new Engine({ seed: 3, cells: 40000 });
  const w = eng.world;
  const out: Record<string, string> = { meshX: hashArray(w.mesh.x), meshAdj: hashArray(w.mesh.adj) };
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
  eng.exec({ op: 'add_island', island: { x: 1.2, y: 0.45, kind: 'volcanic', size: 440, variant: 0 } });
  const d = w.derived;
  const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && d.lake[i] !== 1);
  eng.exec({ op: 'add_constraint', constraint: { cells: land.slice(2000, 2300), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 600 } });
  const features = d.features.map((f) => `${f.key}=${f.name}`).join('|');
  return {
    ...out,
    landness: hashArray(w.causes.landness),
    land: hashArray(w.causes.land),
    uplift: hashArray(w.causes.uplift),
    elevation: hashArray(d.elevation),
    tS: hashArray(d.tS),
    pS: hashArray(d.pS),
    discharge: hashArray(d.discharge),
    dominant: hashArray(d.dominant),
    corrT: hashArray(d.corrT),
    province: hashArray(w.causes.province),
    features: hashString(features).toString(16),
  };
}

// 更强的哈希：按字节、两条独立的通道（FNV-1a 与乘法混合），64 位十六进制。类型数组按原生字节，
// 其他值先 JSON 序列化（双精度数的 JSON 是精确的往返表示）
export function digest(v: unknown): string {
  let bytes: Uint8Array;
  if (ArrayBuffer.isView(v)) bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  else bytes = new TextEncoder().encode(JSON.stringify(v) ?? 'undefined');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ bytes.length;
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// 一个世界的全部状态：网格、原因、推导的每一个类型数组，地物（名字、位置、标签、面积），省份等小数据
export function digestWorld(w: Engine['world']): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (prefix: string, o: object) => {
    for (const [k, v] of Object.entries(o)) if (ArrayBuffer.isView(v)) out[`${prefix}.${k}`] = digest(v);
  };
  add('mesh', w.mesh);
  add('causes', w.causes);
  for (const [k, v] of Object.entries(w.causes.fields)) out[`causes.fields.${k}`] = digest(v);
  add('derived', w.derived);
  for (const [k, v] of Object.entries(w.derived.corrF)) out[`derived.corrF.${k}`] = digest(v);
  out['derived.features'] = digest(w.derived.features.map((f) => ({ ...f, cells: digest(Int32Array.from(f.cells)) })));
  out['derived.conflicts'] = digest(w.derived.conflicts);
  out.small = digest(w.small);
  return out;
}

// 沿海的海格（挨着陆地）：取第 f 份处的一格，再取它附近 r 格距内的格（按编号），用来画一笔真改海陆的画笔
export function coastalStroke(w: Engine['world'], f: number, r: number): number[] {
  const { mesh, causes } = w;
  const coast: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      if (causes.land[mesh.adj[e]]) {
        coast.push(i);
        break;
      }
    }
  }
  const c = coast[Math.floor(coast.length * f)];
  const cells: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < mesh.spacing * r) cells.push(i);
  return cells;
}

// 更长的一组操作（地区或整个星球）：生成、划省、重画一片、真改海陆、海岸曲折、冷暖、自然融入的生态、
// 陆地多少滑块、撤销与重做、放岛（星球放在接缝上）。返回最后整个世界的哈希
export function extendedHashes(kind: 'region' | 'planet'): Record<string, string> {
  const eng =
    kind === 'planet'
      ? new Engine({ seed: 5, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 })
      : new Engine({ seed: 7, cells: 12000 });
  const w = eng.world;
  eng.exec({ op: 'set_worldgen', params: { seed: 7, type: kind === 'planet' ? 'continents' : 'archipelago' }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 7 } });
  eng.exec({ op: 'reroll_region', x: kind === 'planet' ? 1.99 : 1.0, y: 0.45, radius: 0.08, variant: 1 });
  let cells = coastalStroke(w, 0.37, 6);
  eng.exec({ op: 'paint_land', cells, t: cells.map((_, k) => (k % 7) / 7), mode: 'land' });
  cells = coastalStroke(w, 0.71, 5);
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  eng.exec({ op: 'set_coast_style', roughness: 1.4 });
  const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] !== 1);
  eng.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(100, 400), value: 2, mode: 'add' });
  eng.exec({ op: 'add_constraint', constraint: { cells: land.slice(500, 650), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 600 } });
  eng.exec({ op: 'set_worldgen', params: { ...w.small.terrain.gen!, landFraction: kind === 'planet' ? 0.33 : 0.2 } });
  eng.exec({ op: 'add_island', island: { x: kind === 'planet' ? 1.9995 : 0.6, y: 0.3, kind: 'volcanic', size: 400, variant: 2 } });
  if (kind === 'planet') eng.exec({ op: 'set_planet', patch: { currents: 1.5 } });
  eng.undo();
  eng.undo();
  eng.redo();
  return digestWorld(w);
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('hash.ts')) {
  if (process.argv.includes('--extended')) console.log(JSON.stringify({ region: extendedHashes('region'), planet: extendedHashes('planet') }, null, 1));
  else console.log(JSON.stringify(referenceHashes(), null, 1));
}
