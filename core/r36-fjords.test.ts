import { describe, expect, it } from 'vitest';
import { FJORD_GLSL, PROJ_SOURCES, STYLE_GLSL, STYLE_N2, STYLE_N3, TERRAIN_SOURCES } from '../src/render/renderer';
import { coastRaster, fjordStats } from '../tools/realism';
import { LOOK, SKERRY_REACH, coastStyle, fjordData, skerryIsle } from './coast-style';
import { FJ, FJ_REACH, fjordField, fjordK, fjordSegField } from './fjords';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { locate } from './subcell';
import { landStroke } from './terrain';
import { brushCells } from './select';
import { meshFor, seededEngine } from './testing/fixtures';
import type { World } from './world';

// 第三十六轮：峡湾（core/fjords.ts）。冰川海岸一带撒点连成谷网（只按生成器），按陆海淹掉连着海的一段，画成一条条带子；
// 海里离岸不远处冒出岛礁。这里查：谷网只按生成器、逐值确定；峡湾长、有支湾、间距不匀；峡湾海岸的盒维数；
// 着色器的算式与 CPU 相同；每个画面三角形取的那张表（最后一个顶点的格）含碰得到它的全部段（GPU、CPU 取的表不同也算出一样的结果）

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

const SMALL = [
  ['一块地区（北纬 40°–78°）', { cells: 6000, seed: 7, latNorth: 78, latSouth: 40 }],
  ['整个星球', { cells: 5000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const;

const build = (settings: Record<string, unknown>, seed: number, mesh?: Mesh) => {
  const e = seededEngine(settings, mesh ?? fresh(meshFor(settings)));
  e.exec({ op: 'set_worldgen', params: { seed, type: 'continents' }, reset: true });
  return e;
};

// 着色器里的算式（STYLE_GLSL 的 fjordSeg、skerryIsle）照字面换成 JS
function transliterate(src: string): Record<string, (...a: number[]) => number> {
  const names = [...src.matchAll(/\bfloat\s+(\w+)\s*\(/g)].map((m) => m[1]);
  const js = src
    .replace(/\bfloat\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (_m, name: string, args: string) => `function ${name}(${args.replace(/\bfloat\s+/g, '')}) {`)
    .replace(/\bfloat\s+/g, 'let ')
    .replace(/\b(min|max|abs|sqrt)\(/g, 'Math.$1(');
  return new Function(`${js}\nreturn { ${names.join(', ')} };`)() as Record<string, (...a: number[]) => number>;
}

// 表里的全部段（去重），按格的表一张张收
function allEntries(tex: Float32Array, nRank: number): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (let rk = 0; rk < nRank; rk++) {
    const off = tex[4 * rk];
    const cnt = tex[4 * rk + 1];
    for (let k = 0; k < cnt; k++) {
      const o = 4 * (off + 3 * k);
      const e = Array.from(tex.subarray(o, o + 8));
      const key = e.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

describe('谷网只按生成器，淹到哪里只按陆海', () => {
  for (const [label, settings] of SMALL) {
    it(`${label}：同样的种子逐值相同；画陆地、改湿度不重建谷网`, () => {
      const a = build(settings, 7);
      const b = build(settings, 7);
      const na = coastStyle(a.world)!.net!;
      const nb = coastStyle(b.world)!.net!;
      expect(na.n).toBeGreaterThan(0);
      expect(Array.from(nb.pos)).toEqual(Array.from(na.pos));
      expect(Array.from(nb.recv)).toEqual(Array.from(na.recv));
      expect(Array.from(fjordData(b.world)!.tex)).toEqual(Array.from(fjordData(a.world)!.tex));
      const w = a.world;
      const { mesh } = w;
      // 有表的格上画一笔海：谷网还是那一份，淹到哪里变了
      let c = -1;
      for (let i = 0; i < mesh.n && c < 0; i++) if (w.causes.land[i] && na.rank[i] >= 0 && fjordData(w)!.tex[4 * na.rank[i] + 1] > 0) c = i;
      expect(c).toBeGreaterThanOrEqual(0);
      const before = fjordData(w)!.tex;
      const br = brushCells(w, mesh.x[c], mesh.y[c], 2 * mesh.spacing * w.kmPerUnit);
      a.exec({ op: 'paint_land', cells: br.cells, t: br.t, mode: 'sea' });
      expect(coastStyle(a.world)!.net).toBe(na);
      expect(Array.from(fjordData(a.world)!.tex)).not.toEqual(Array.from(before));
      a.exec({ op: 'set_planet', patch: { humidity: 1.3 } });
      expect(coastStyle(a.world)!.net).toBe(na);
      // landStroke 只用来确认画笔的格在陆地上（与幽灵海岸同一套）
      expect(landStroke(w, br.cells, br.t, 'sea').cells.length).toBeGreaterThan(0);
    });
  }
});

describe('峡湾长、有支湾、间距不匀（冰川海岸多的区域，4 万格）', () => {
  const e = seededEngine({ seed: 6, cells: 40000 });
  e.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents' }, reset: true });
  const w: World = e.world;
  it('一格以上的峡湾：长度的中位数 ≥ 2.5 格，四分之一以上有支湾，入海口间距的变异系数 ≥ 0.5', () => {
    const f = fjordStats(w, 1);
    expect(f.count).toBeGreaterThanOrEqual(30);
    expect(f.medianLength).toBeGreaterThanOrEqual(2.5);
    expect(f.branchedShare).toBeGreaterThanOrEqual(0.25);
    expect(f.spacingCV).toBeGreaterThanOrEqual(0.5);
    // 最长的不超过入海口的预算上限
    expect(f.lengths[f.lengths.length - 1]).toBeLessThanOrEqual(FJ.LEN_CAP + 1e-6);
  });
  it('峡湾海岸的盒维数 ≥ 1.25', () => {
    const c = coastRaster(w, 2048);
    expect(c.fjordDim).toBeGreaterThanOrEqual(1.25);
  });
});

describe('着色器与 CPU 相同（第三十六轮的峡湾、岛礁）', () => {
  const g = transliterate(STYLE_GLSL);
  it('fjordSeg、skerryIsle：随机几千组输入一致', () => {
    let seed = 13;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let k = 0; k < 4000; k++) {
      const sph = k % 2 === 1;
      const p = [rnd() * 2, rnd(), 0];
      if (sph) {
        const z = rnd() * 2 - 1;
        const a = rnd() * 2 * Math.PI;
        const s = Math.sqrt(1 - z * z);
        p[0] = s * Math.cos(a);
        p[1] = s * Math.sin(a);
        p[2] = z;
      }
      const n = sph ? p : [0, 0, 1];
      const d = () => (rnd() - 0.5) * 0.02;
      const a = [p[0] + d(), p[1] + d(), p[2] + (sph ? d() : 0)];
      const b = [p[0] + d(), p[1] + d(), p[2] + (sph ? d() : 0)];
      const ar = rnd() * 0.002;
      const br = rnd() * 0.002;
      const wst = k % 5 === 0 ? 0 : rnd();
      const nd = (rnd() * 2 - 1) * 0.9;
      const kw = fjordK(0.0077);
      const want = fjordSegField(p[0], p[1], p[2], n[0], n[1], n[2], a[0], a[1], a[2], ar, b[0], b[1], b[2], br, wst, nd, kw);
      expect(g.fjordSeg(p[0], p[1], p[2], n[0], n[1], n[2], a[0], a[1], a[2], ar, b[0], b[1], b[2], br, wst, nd, kw)).toBeCloseTo(want, 3);
      const s = -rnd() * 300;
      const r = rnd() * 260;
      const kk = (k % 7) / 7;
      expect(g.skerryIsle(s, kk, nd, r)).toBeCloseTo(skerryIsle(s, kk, nd, r), 4);
    }
  });

  it('地形着色器（平面、星球、极地）依次冒岛礁、刻峡湾、冒沙坝，峡湾按最后一个顶点的表号逐段取最小', () => {
    const sources = [
      [TERRAIN_SOURCES.plane, STYLE_N2],
      [TERRAIN_SOURCES.planet, STYLE_N3],
      [PROJ_SOURCES.polarTerrainFs, STYLE_N3],
    ] as const;
    for (const [src, n] of sources) {
      const sk = src.indexOf('s = skerryIsle(s, vSkerry * wst, ');
      const fj = src.indexOf(`float fjf = fjordField(${n.fjP}, ${n.fjN}, vFjRank, vCoast > 0.0 ? wst : 1.0, nd, ${n.fjK});`);
      const bar = src.indexOf('s = barrierIsle(s, vBar * wst, ');
      expect(sk).toBeGreaterThan(0);
      expect(fj).toBeGreaterThan(sk);
      expect(bar).toBeGreaterThan(fj);
      expect(src).toContain(`-s < ${SKERRY_REACH} * max(vCoastAbs, ${LOOK.SK_RMIN}.0)`);
      expect(src).toContain('flat in int vFjRank;');
      expect(src).toContain('float nd = ');
    }
    expect(STYLE_N2.fjK).toBe(`${FJ.SMAX / FJ.EDGE}.0 / uSpacing`);
    expect(STYLE_N3.fjK).toBe(`${FJ.SMAX / FJ.EDGE}.0 / (PI * uSpacing)`);
    expect(FJORD_GLSL).toContain(`for (int k = 0; k < ${FJ.MAX_LIST}; k++) {`);
    expect(FJORD_GLSL).toContain('vec4 a = fjTexel(off + 3 * k);');
    expect(FJORD_GLSL).toContain('vec4 b = fjTexel(off + 3 * k + 1);');
    expect(FJORD_GLSL).toContain('if (f < best) { best = f; bi = k; }');
    expect(PROJ_SOURCES.polarCellVs).toContain('flat out int vFjRank;');
  });
});

describe('每个画面三角形取的那张表含碰得到它的全部段', () => {
  for (const [label, settings] of SMALL) {
    it(label, () => {
      const e = build(settings, 7);
      const w = e.world;
      const { mesh } = w;
      const st = coastStyle(w)!;
      const net = st.net!;
      const L = fjordData(w)!;
      const all = allEntries(L.tex, net.nRank);
      expect(all.length).toBeGreaterThan(20);
      // 表不超过着色器的循环上限
      for (let rk = 0; rk < net.nRank; rk++) expect(L.tex[4 * rk + 1]).toBeLessThanOrEqual(FJ.MAX_LIST);
      const sph = mesh.kind === 'sphere';
      const spDist = sph ? Math.PI * mesh.spacing : mesh.spacing;
      const kw = fjordK(spDist);
      let seed = 5;
      const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      let near = 0;
      let checked = 0;
      // 在淹着的段附近撒点（段的半径的几倍以内）
      for (let k = 0; k < 6000; k++) {
        const s = all[Math.floor(rnd() * all.length)];
        const t = rnd();
        let px = s[0] + t * (s[4] - s[0]);
        let py = s[1] + t * (s[5] - s[1]);
        let pz = s[2] + t * (s[6] - s[2]);
        const off = (rnd() * 2 - 1) * Math.max(s[3], s[7]) * FJ_REACH * 1.2;
        let x: number;
        let y: number;
        if (sph) {
          const a = rnd() * 2 * Math.PI;
          px += off * Math.cos(a) * 0.7;
          py += off * Math.sin(a) * 0.7;
          pz += off * 0.3;
          const l = Math.hypot(px, py, pz);
          px /= l;
          py /= l;
          pz /= l;
          x = 1 + Math.atan2(py, px) / Math.PI;
          y = Math.acos(Math.max(-1, Math.min(1, pz))) / Math.PI;
          // 着色器里的点按显示坐标算回来（与 CPU 的 fjordAt 相同）
          const lon = Math.PI * (x - 1);
          const colat = Math.PI * y;
          px = Math.sin(colat) * Math.cos(lon);
          py = Math.sin(colat) * Math.sin(lon);
          pz = Math.cos(colat);
        } else {
          px += off * 0.7;
          py += off * 0.7;
          pz = 0;
          x = px;
          y = py;
        }
        const nd = (rnd() * 2 - 1) * 0.9;
        const n = sph ? [px, py, pz] : [0, 0, 1];
        let brute = Infinity;
        for (const q of all) brute = Math.min(brute, fjordSegField(px, py, pz, n[0], n[1], n[2], q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], 1, nd, kw));
        if (brute >= FJ.SMAX) continue;
        const loc = locate(mesh, x, y, 0);
        // 地图边缘外（找不到三角形，退回最近的格）：画面上不画
        if (loc.i[0] === loc.i[1] && loc.i[1] === loc.i[2]) continue;
        near++;
        const rk = net.rank[loc.prov];
        expect(rk).toBeGreaterThanOrEqual(0);
        expect(fjordField(L.tex, rk, px, py, pz, n[0], n[1], n[2], 1, nd, kw)).toBe(brute);
        checked++;
      }
      expect(near).toBeGreaterThan(500);
      expect(checked).toBe(near);
    });
  }
});
