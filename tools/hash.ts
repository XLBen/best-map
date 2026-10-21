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
  eng.exec({ op: 'add_island', island: { x: 1.2, y: 0.45, kind: 'volcanic', size: 'medium', variant: 0 } });
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

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('hash.ts')) {
  console.log(JSON.stringify(referenceHashes(), null, 1));
}
