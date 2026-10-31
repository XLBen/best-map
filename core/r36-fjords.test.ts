import { describe, expect, it } from 'vitest';
import { FJORD_GLSL, PROJ_SOURCES, STYLE_GLSL, STYLE_N2, STYLE_N3, TERRAIN_SOURCES } from '../src/render/renderer';
import { coastRaster, fjordStats } from '../tools/realism';
import { GhostBuffer, cellLayers, editGhost } from '../src/render/colors';
import { LOOK, SKERRY_REACH, coastStyle, fjordData, skerryIsle } from './coast-style';
import { clearCoastMemo, memoStats, setCoastMemo } from './coast-memo';
import { type RiverLine, traceRivers } from './rivers';
import { FJ, FJ_REACH, buildFjordNet, fjordField, fjordK, fjordLayer, fjordSegField } from './fjords';
import { planetSettings } from './presets';
import { baseComponentsOf } from './terrain';
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
  // 峡湾按 km（最长 350 km）：5000 格的星球一格三百多 km，峡湾不到一格，这里用 2 万格（一格约 160 km）
  ['整个星球（2 万格）', { cells: 20000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
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
    });
  }
});

// 长度、宽度按 km：区域（一格约 69 km）与星球（一格约 100 km）一样长、一样宽
const WORLDS = [
  ['冰川海岸多的区域（4 万格，6 号种子）', { seed: 6, cells: 40000 }, 6],
  ['类地星球（3 号种子）', { ...planetSettings('earth'), seed: 3 }, 3],
] as const;
for (const [label, settings, seed] of WORLDS) {
  describe(`峡湾的长度、宽度、支湾、间距：${label}`, () => {
    const e = seededEngine(settings);
    e.exec({ op: 'set_worldgen', params: { seed, type: 'continents' }, reset: true });
    const w: World = e.world;
    it('20 km 以上的峡湾：长度的中位数 60–200 km、最长不过 350 km；一个峡湾最多三条支湾；入海口间距的变异系数 ≥ 0.5', () => {
      const f = fjordStats(w, 20);
      expect(f.count).toBeGreaterThanOrEqual(20);
      expect(f.medianKm).toBeGreaterThanOrEqual(60);
      expect(f.medianKm).toBeLessThanOrEqual(200);
      expect(f.maxKm).toBeLessThanOrEqual(FJ.LEN_CAP_KM + 1e-3);
      expect(f.armsMax).toBeLessThanOrEqual(FJ.MAX_ARMS);
      expect(f.branchedShare).toBeGreaterThan(0.05);
      expect(f.spacingCV).toBeGreaterThanOrEqual(0.5);
    });
    it('宽度按 km：淹着的段的半径不过 HW_KM × 1.4 × 1.35', () => {
      const net = coastStyle(w)!.net!;
      const L = fjordData(w)!;
      const kmPerDist = net.kmCell / net.spDist;
      let max = 0;
      for (const q of allEntries(L.tex, net.nRank)) max = Math.max(max, q[3], q[7]);
      expect(max * kmPerDist).toBeLessThanOrEqual(FJ.HW_KM * FJ.SEA_W * (FJ.WIDEN0 + FJ.WIDEN1) + 1e-3);
      expect(max * kmPerDist).toBeGreaterThan(FJ.HW_KM * 0.5);
    });
    if (seed === 6) {
      it('峡湾海岸的盒维数 ≥ 1.25', () => {
        const c = coastRaster(w, 2048);
        expect(c.fjordDim).toBeGreaterThanOrEqual(1.25);
      });
    }
  });
}

describe('幽灵海岸：画海、画陆地时峡湾纹理与执行后的逐值相同', () => {
  for (const [label, settings] of SMALL) {
    for (const mode of ['sea', 'land'] as const) {
      it(`${label}：${mode === 'sea' ? '画海' : '画陆地'}`, () => {
        const e = build(settings, 7);
        const w = e.world;
        const { mesh } = w;
        const net = coastStyle(w)!.net!;
        const L = fjordData(w)!;
        // 淹着的峡湾经过的陆格（画海：往里淹；画陆地：把它附近堵上）
        let c = -1;
        for (let i = 0; i < mesh.n && c < 0; i++) if (w.causes.land[i] && net.rank[i] >= 0 && L.tex[4 * net.rank[i] + 1] > 0 && L.sig[i] > 0) c = i;
        expect(c).toBeGreaterThanOrEqual(0);
        const b = brushCells(w, mesh.x[c], mesh.y[c], 1.5 * mesh.spacing * w.kmPerUnit);
        const stroke = landStroke(w, b.cells, b.t, mode);
        const opts = { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false } as const;
        const base = cellLayers(w, opts);
        const ghost = new GhostBuffer(base, 'terrain').apply(w, editGhost(w, base, { cells: stroke.cells, delta: stroke.delta }));
        const after = e.clone();
        after.exec({ op: 'paint_land', cells: b.cells, t: b.t, mode });
        const want = fjordData(after.world)!.tex;
        if (mode === 'sea') expect(Array.from(want)).not.toEqual(Array.from(base.fjord!));
        expect(Array.from(ghost.fjord!)).toEqual(Array.from(want));
      });
    }
  }
});

// 描河记下的查询（core/coast-memo.ts）不看峡湾的表号（重新生成一片时一带多了、少了几格，后面的格的表号都挪一位），只看表的摘要：
// 在冰川海岸上重新生成几片、画一笔海，每一步之后开着与关着描出来的河逐值相同，开着时真的用上了记下的
const ser = (lines: RiverLine[]) => JSON.stringify(lines, (_, v) => (typeof v === 'number' && (Object.is(v, -0) || Number.isNaN(v)) ? String(v) : v));
describe('描河记下的查询：冰川海岸上重新生成一片后与不记逐值相同', () => {
  for (const [label, settings] of SMALL) {
    it(label, () => {
      clearCoastMemo();
      const e = build(settings, 7);
      const copy = (w: World): World => ({ ...w, derived: { ...w.derived, elevation: w.derived.elevation.slice() } });
      const plain = (w: World) => {
        setCoastMemo(false);
        try {
          return ser(traceRivers(copy(w)));
        } finally {
          setCoastMemo(true);
        }
      };
      traceRivers(copy(e.world));
      const { mesh } = e.world;
      const st0 = coastStyle(e.world)!;
      let c = -1;
      for (let i = 0; i < mesh.n; i++) {
        if (!e.world.causes.land[i] || st0.fjord[i] < 0.5) continue;
        let coast = false;
        for (let k = mesh.off[i]; k < mesh.off[i + 1]; k++) if (!e.world.causes.land[mesh.adj[k]]) coast = true;
        if (coast && (c < 0 || st0.fjord[i] > st0.fjord[c])) c = i;
      }
      expect(c).toBeGreaterThanOrEqual(0);
      const h0 = memoStats().hits;
      let shifted = false;
      for (const variant of [2, 3, 4]) {
        const before = coastStyle(e.world)!.net!;
        e.exec({ op: 'reroll_region', x: mesh.x[c], y: mesh.y[c], radius: 0.1, variant });
        const after = coastStyle(e.world)!.net!;
        if (after.rank.some((r, i) => r !== before.rank[i])) shifted = true;
        expect(ser(traceRivers(copy(e.world)))).toBe(plain(e.world));
      }
      const b = brushCells(e.world, mesh.x[c], mesh.y[c], 1.5 * mesh.spacing * e.world.kmPerUnit);
      e.exec({ op: 'paint_land', cells: b.cells, t: b.t, mode: 'sea' });
      expect(ser(traceRivers(copy(e.world)))).toBe(plain(e.world));
      expect(shifted).toBe(true);
      expect(memoStats().hits - h0).toBeGreaterThan(100);
    });
  }
});

describe('重新生成一片只重建碰到的块，结果与整个重建逐值相同', () => {
  for (const [label, settings] of SMALL) {
    it(label, () => {
      const e = build(settings, 7);
      const w0 = e.world;
      const st0 = coastStyle(w0)!;
      const { mesh } = w0;
      // 峡湾权重最大的海岸陆格上重画一片
      let c = -1;
      for (let i = 0; i < mesh.n; i++) {
        if (!w0.causes.land[i] || st0.fjord[i] < 0.5) continue;
        let coast = false;
        for (let k = mesh.off[i]; k < mesh.off[i + 1]; k++) if (!w0.causes.land[mesh.adj[k]]) coast = true;
        if (coast && (c < 0 || st0.fjord[i] > st0.fjord[c])) c = i;
      }
      expect(c).toBeGreaterThanOrEqual(0);
      e.exec({ op: 'reroll_region', x: mesh.x[c], y: mesh.y[c], radius: 0.04, variant: 3 });
      const w = e.world;
      const st = coastStyle(w)!;
      const inc = st.net!;
      const full = buildFjordNet(mesh, w.settings.seed, w.kmPerUnit, st.fjord, baseComponentsOf(w)!.b0)!;
      for (const k of ['pos', 'mid', 'owner', 'recv', 'order', 'len', 'lc', 'lsea', 'lcs', 'hw', 'isMain', 'dirOk', 'rank', 'ring', 'watch', 'wz'] as const) expect(Array.from(inc[k] as ArrayLike<number>), k).toEqual(Array.from(full[k] as ArrayLike<number>));
      // 真的有块照用了上一份，也真的重建了几块
      const old = new Set(st0.net!.tiles);
      const kept = inc.tiles.filter((t) => old.has(t)).length;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(inc.tiles.length);
      expect(Array.from(fjordData(w)!.tex)).toEqual(Array.from(fjordLayer(full, w.causes.land, mesh.n).tex));
      // 离谷网一带很远的地方重画一片：一块都不重建，峡湾纹理还是同一份
      const L = fjordData(w)!;
      let far = -1;
      for (let i = 0; i < mesh.n && far < 0; i++) {
        if (!w.causes.land[i] || inc.wz[i] > 0) continue;
        let ok = true;
        const r2 = (0.06 + 6 * mesh.spacing) ** 2;
        for (let j = 0; j < mesh.n && ok; j++) if (inc.wz[j] > 0 && (mesh.x[j] - mesh.x[i]) ** 2 + (mesh.y[j] - mesh.y[i]) ** 2 < r2) ok = false;
        if (ok) far = i;
      }
      if (mesh.kind === 'plane') {
        expect(far).toBeGreaterThanOrEqual(0);
        e.exec({ op: 'reroll_region', x: mesh.x[far], y: mesh.y[far], radius: 0.04, variant: 2 });
        expect(coastStyle(e.world)!.net!.tiles).toBe(inc.tiles);
        expect(fjordData(e.world)).toBe(L);
      }
    });
  }
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
      expect(all.length).toBeGreaterThan(10);
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
      expect(near).toBeGreaterThan(200);
      expect(checked).toBe(near);
    });
  }
});
