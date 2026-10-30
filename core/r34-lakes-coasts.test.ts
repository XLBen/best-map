import { describe, expect, it } from 'vitest';
import { STYLE_GLSL, STYLE_N2, STYLE_N3, TERRAIN_SOURCES, PROJ_SOURCES } from '../src/render/renderer';
import { GhostBuffer, cellLayers, editGhost } from '../src/render/colors';
import { digestWorld } from '../tools/hash';
import { glacialLakes } from '../tools/realism';
import { LOOK, barrierBump, barrierDetail, barrierIsle, coastStyle, decodeStyleB, displayStyle, fjordCut, speckApply, speckK, speckW, styleWeight } from './coast-style';
import type { Command } from './commands';
import { displayCellAt } from './display';
import { computeElevation, elevationMemo } from './elevation';
import type { Engine } from './engine';
import { GLACIAL, glacialField, glacialOn, glacialStats } from './glacial';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { riverRibbon, traceRivers } from './rivers';
import { settingsFor } from './presets';
import { landStroke } from './terrain';
import { brushCells } from './select';
import { pointIsLand, rasterizeWorld, shownCoastValues } from './subcell';
import { meshFor, seededEngine } from './testing/fixtures';
import type { World } from './world';

// 第三十四轮：湖与海岸。冰川刻蚀（core/glacial.ts，高程求解里挖小洼，水文蓄成湖群）、海岸类型（core/coast-style.ts：峡湾、沙坝、溺谷，
// 格子层级、只按生成器与新建时的纬度定）、小湖群（画法：陆地像素里噪声的峰画成水面，格还是陆地）。这里查：
// 记忆开着与关着逐值相同、改一块陆地别的陆地不变、改气候不改高程；冰川低地上有湖群；海岸类型不随陆海、气候变，
// 幽灵海岸按将来的陆海重算峡湾；着色器的算式与 CPU 相同；导出、悬停、点的陆海判定一致；溺谷的河口更宽

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

function withMemo<T>(on: boolean, f: () => T): T {
  const saved = elevationMemo.on;
  elevationMemo.on = on;
  try {
    return f();
  } finally {
    elevationMemo.on = saved;
  }
}

// 高纬的一块地区与整个星球（冰盖到过的地方多）
const SETTINGS = [
  ['一块地区（北纬 40°–78°）', { cells: 6000, seed: 7, latNorth: 78, latSouth: 40 }],
  ['整个星球', { cells: 5000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const;

const build = (settings: (typeof SETTINGS)[number][1]) => {
  const e = seededEngine(settings, fresh(meshFor(settings)));
  e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
  return e;
};

// 冰盖强度最大、有小洼的陆格
function glacialCell(w: World): number {
  const f = glacialField(w);
  let best = -1;
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && f.mask[i] && (best < 0 || f.g[i] > f.g[best])) best = i;
  return best;
}

for (const [label, settings] of SETTINGS) {
  describe(`冰川刻蚀：${label}`, () => {
    it('真的挖了，且只在冰盖到过的地方', () => {
      const c0 = glacialStats.carved;
      const e = build(settings);
      expect(glacialStats.carved).toBeGreaterThan(c0);
      // 关掉冰川刻蚀：冰盖没到过的陆块逐值相同
      const w = e.world;
      const off = (() => {
        const saved = glacialOn.on;
        glacialOn.on = false;
        try {
          return withMemo(false, () => computeElevation(w).elevation);
        } finally {
          glacialOn.on = saved;
        }
      })();
      const on = withMemo(false, () => computeElevation(w).elevation);
      const f = glacialField(w);
      let diff = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        if (!w.causes.land[i] || on[i] === off[i]) continue;
        diff++;
        expect(f.depth[i]).toBeGreaterThan(0);
      }
      expect(diff).toBeGreaterThan(0);
    });

    it('高程记忆开着与关着逐值相同（冰川区里抬山、改岩性、画陆地、撤销重做）', () => {
      const mesh = meshFor(settings);
      const a = seededEngine(settings, fresh(mesh));
      const b = seededEngine(settings, fresh(mesh));
      a.undoCache = 0;
      b.undoCache = 0;
      const both = (step: (e: Engine) => void) => {
        withMemo(true, () => step(a));
        withMemo(false, () => step(b));
        expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
      };
      const run = (cmd: Command) => both((e) => e.exec(cmd));
      run({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
      const w = a.world;
      const m = glacialCell(w);
      expect(m).toBeGreaterThanOrEqual(0);
      const near = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && Math.hypot(w.mesh.x[i] - w.mesh.x[m], w.mesh.y[i] - w.mesh.y[m]) < w.mesh.spacing * 3);
      run({ op: 'paint_relief', cells: near, t: near.map(() => 0), strength: 0.3 });
      run({ op: 'paint', field: 'erodDelta', cells: near, value: 0.5, mode: 'add' });
      both((e) => e.undo());
      both((e) => e.redo());
      const sea = [...Array(w.mesh.n).keys()].filter((i) => !w.causes.land[i]).slice(0, 12);
      run({ op: 'paint_land', cells: sea, t: sea.map(() => 0), mode: 'land' });
      both((e) => e.undo());
    });

    it('改一块陆地，别的陆地的高程一格不变', () => {
      const e = build(settings);
      const w = e.world;
      const before = withMemo(false, () => computeElevation(w).elevation);
      const comp = new Int32Array(w.mesh.n).fill(-1);
      const sizes: number[] = [];
      for (let s = 0; s < w.mesh.n; s++) {
        if (!w.causes.land[s] || comp[s] >= 0) continue;
        const q = [s];
        comp[s] = sizes.length;
        for (let h = 0; h < q.length; h++)
          for (let k = w.mesh.off[q[h]]; k < w.mesh.off[q[h] + 1]; k++) {
            const j = w.mesh.adj[k];
            if (w.causes.land[j] && comp[j] < 0) {
              comp[j] = sizes.length;
              q.push(j);
            }
          }
        sizes.push(q.length);
      }
      // 冰川区里的那块陆地
      const g = glacialCell(w);
      const big = comp[g];
      const cells = [...Array(w.mesh.n).keys()].filter((i) => comp[i] === big).slice(0, 150);
      e.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.6 });
      const after = withMemo(false, () => computeElevation(e.world).elevation);
      let other = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        if (!w.causes.land[i] || comp[i] === big) continue;
        other++;
        expect(after[i]).toBe(before[i]);
      }
      expect(other).toBeGreaterThan(0);
    });

    it('改气候不改高程（湿度、冷暖笔、挪纬度或轴倾角）', () => {
      const e = build(settings);
      const terrain = digestWorld(e.world)['derived.elevation'];
      const c0 = elevationMemo.computed;
      const land = [...Array(e.world.mesh.n).keys()].filter((i) => e.world.causes.land[i]).slice(0, 400);
      for (const cmd of [
        { op: 'set_planet', patch: { humidity: 0.5 } },
        { op: 'paint', field: 'tempOffset', cells: land, value: -8, mode: 'add' },
        { op: 'set_planet', patch: 'globe' in settings ? { tilt: 35 } : { latShift: -12 } },
      ] as Command[]) {
        e.exec(cmd);
        expect(digestWorld(e.world)['derived.elevation']).toBe(terrain);
      }
      expect(elevationMemo.computed).toBe(c0);
    });

    it('海岸类型只按生成器与新建时的纬度：画陆地、改气候都不变', () => {
      const e = build(settings);
      const st = coastStyle(e.world)!;
      expect(st).not.toBeNull();
      const packed = st.packed.slice();
      const sea = [...Array(e.world.mesh.n).keys()].filter((i) => !e.world.causes.land[i]).slice(0, 30);
      e.exec({ op: 'paint_land', cells: sea, t: sea.map(() => 0), mode: 'land' });
      e.exec({ op: 'set_planet', patch: { humidity: 1.4 } });
      expect(coastStyle(e.world)!.packed).toEqual(packed);
    });
  });
}

describe('冰川低地上的湖群', () => {
  const w = withMemo(false, () => {
    const e = seededEngine({ ...settingsFor('hemisphere', 'temperate', 20000), seed: 5 });
    e.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents' }, reset: true });
    return e.world;
  });
  it('冰川低地里湖面 3–12%，别处 < 2%；挖的都是三格以上的一片', () => {
    const gl = glacialLakes(w);
    expect(gl.share).toBeGreaterThan(0.03);
    expect(gl.share).toBeLessThan(0.12);
    expect(gl.other).toBeLessThan(0.02);
    expect(gl.count).toBeGreaterThanOrEqual(5);
    expect(GLACIAL.MIN_CELLS).toBe(3);
  });
});

// 着色器里的算式（STYLE_GLSL）照字面换成 JS（函数声明、float → let、min/max/abs），与 CPU 的逐个比（着色器是单精度）
function transliterate(src: string): Record<string, (...a: number[]) => number> {
  const names = [...src.matchAll(/\bfloat\s+(\w+)\s*\(/g)].map((m) => m[1]);
  const js = src
    .replace(/\bfloat\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (_m, name: string, args: string) => `function ${name}(${args.replace(/\bfloat\s+/g, '')}) {`)
    .replace(/\bfloat\s+/g, 'let ')
    .replace(/\b(min|max|abs)\(/g, 'Math.$1(');
  return new Function(`${js}\nreturn { ${names.join(', ')} };`)() as Record<string, (...a: number[]) => number>;
}

describe('着色器与 CPU 相同（第三十四轮的海岸类型、小湖群）', () => {
  const g = transliterate(STYLE_GLSL);
  it('barrierDetail、fjordCut、barrierIsle、speckK、speckApply：随机几千组输入一致', () => {
    let seed = 11;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let k = 0; k < 5000; k++) {
      const s = (rnd() * 2 - 1) * 260;
      const sv = (rnd() * 2 - 1) * 250;
      const w = k % 7 === 0 ? 0 : rnd();
      const n = (rnd() * 2 - 1) * 0.8;
      const r = rnd() * 260;
      const h = rnd() * 900 - 100;
      expect(g.barrierDetail(w)).toBeCloseTo(barrierDetail(w), 6);
      expect(g.styleWeight(w)).toBeCloseTo(styleWeight(w), 6);
      expect(g.fjordCut(s, sv, w, n)).toBeCloseTo(fjordCut(s, sv, w, n), 3);
      const bump = barrierBump(s, r);
      expect(g.barrierBump(s, r)).toBeCloseTo(bump, 5);
      expect(g.barrierIsle(s, w, n, bump, r)).toBeCloseTo(barrierIsle(s, w, n, bump, r), 3);
      expect(g.speckW(s, w, h)).toBeCloseTo(speckW(s, w, h), 6);
      expect(g.speckK(w, n)).toBeCloseTo(speckK(w, n), 5);
      const kk = speckK(w, n);
      expect(g.speckApply(s, kk)).toBeCloseTo(speckApply(s, kk), 4);
      // 权重为 0 时什么都不改（与第三十三轮的画法相同）
      expect(fjordCut(s, sv, 0, n)).toBe(s);
      expect(barrierIsle(s, 0, n, bump, r)).toBe(s);
      expect(speckW(s, 0, h)).toBe(0);
    }
  });

  it('地形着色器（平面、星球、极地）在海岸场算完之后依次刻峡湾、冒沙坝、画小湖群，噪声的频率、偏移与 CPU 相同', () => {
    const sources = [
      [TERRAIN_SOURCES.plane, STYLE_N2],
      [TERRAIN_SOURCES.planet, STYLE_N3],
      [PROJ_SOURCES.polarTerrainFs, STYLE_N3],
    ] as const;
    for (const [src, n] of sources) {
      expect(src).toContain('float wst = styleWeight(wmax);');
      expect(src).toContain(`if (vFjord > 0.0 && s > 0.0) s = fjordCut(s, vCoast, vFjord * wst, ${n.fjord});`);
      expect(src).toContain(`if (bump > 0.0) s = barrierIsle(s, vBar * wst, ${n.bar}, bump, vCoastAbs);`);
      expect(src).toContain('float spw = speckW(s, vSpeck * wst, h);');
      expect(src).toContain(`lakeDot = speckK(spw, ${n.speck});`);
      expect(src).toContain('barrierDetail(vBar)');
    }
    expect(STYLE_N2.fjord).toContain(`/ ${LOOK.FJ_K}.0)) / uSpacing * ${LOOK.FJ_FREQ} + vec2(${LOOK.FJ_OFF[0]}, ${LOOK.FJ_OFF[1]})`);
    expect(STYLE_N3.speck).toContain(`(uNoiseK * ${LOOK.SPK_FREQ}.0) + vec3(${LOOK.SPK_OFF.join(', ')})`);
    // 顶点着色器把海岸值纹理的 b、a 拆开（core/coast-style.ts 的 decodeStyleB），极地的场景另把峡湾的方向换到极地平面上
    for (const vs of [PROJ_SOURCES.polarCellVs]) {
      expect(vs).toContain('vec4 cf = texelFetch(uCoast, t, 0);');
      expect(vs).toContain('vFjord = (rest - 256.0 * cq) / 255.0;');
      expect(vs).toContain('vFjDir = vec2(cq, sq) / 127.5 - 1.0;');
      expect(vs).toContain('vSpeck = -cf.b / 255.0;');
      expect(vs).toContain('vBar = cf.a;');
      expect(vs).toContain('vStyle.yz = fjDirW.x * pE + fjDirW.y * pS;');
    }
    expect(PROJ_SOURCES.polarTerrainFs).toContain('vFjDir = vec2(dot(vStyle.yz, pE), dot(vStyle.yz, pS));');
    const out = new Float64Array(4);
    decodeStyleB(200 + 256 * 128 + 65536 * 255, out, 0);
    expect(out[0]).toBeCloseTo(200 / 255, 9);
    expect(out[1]).toBeCloseTo(128 / 127.5 - 1, 9);
    expect(out[2]).toBeCloseTo(1, 9);
    decodeStyleB(-128, out, 0);
    expect([out[0], out[3]]).toEqual([0, 128 / 255]);
  });
});

describe('导出、悬停、点的陆海判定一致（有峡湾、沙坝、小湖群的世界）', () => {
  for (const [label, settings] of SETTINGS) {
    it(label, () => {
      const e = build(settings);
      const w = e.world;
      const { mesh } = w;
      const W = 480;
      const H = 240;
      const r = rasterizeWorld(w, W, H);
      const s = shownCoastValues(w);
      const st = coastStyle(w)!;
      let agree = 0;
      let total = 0;
      let fj = 0;
      let bar = 0;
      let dots = 0;
      let dotWater = 0;
      let hint = 0;
      for (let py = 0; py < H; py += 2) {
        for (let px = 0; px < W; px += 2) {
          const x = ((px + 0.5) / W) * mesh.width;
          const y = ((py + 0.5) / H) * mesh.height;
          const p = py * W + px;
          const d = displayCellAt(w, x, y, hint);
          hint = d.cell;
          total++;
          if (d.land === (r.land[p] === 1)) agree++;
          if (mesh.kind !== 'sphere') expect(pointIsLand(w, s, w.derived.elevation, x, y, hint).land).toBe(r.land[p] === 1);
          if (r.land[p] && st.fjord[r.cell[p]] >= 0.5) fj++;
          if (r.land[p] && !w.causes.land[d.cell] && st.barrier[d.cell] >= 0.5) bar++;
          if (r.lakeDot[p]) {
            dots++;
            // 小湖群：格还是陆地，画面上是水（导出按陆海判的那一套算：湖面格算陆地，湖岸附近与画面差一点）
            expect(r.land[p]).toBe(1);
            expect(w.causes.land[r.cell[p]]).toBe(1);
            if (d.water) dotWater++;
          }
        }
      }
      expect(agree / total).toBeGreaterThan(0.999);
      expect(fj + bar).toBeGreaterThan(0);
      expect(dots).toBeGreaterThan(0);
      expect(dotWater / dots).toBeGreaterThan(0.95);
    });
  }
});

describe('峡湾按将来的陆海：幽灵海岸画陆地、画海时与执行后画的一样', () => {
  for (const [label, settings] of SETTINGS) {
    for (const mode of ['land', 'sea'] as const) {
      it(`${label}：${mode === 'land' ? '画陆地' : '画海'}`, () => {
        const e = build(settings);
        const w = e.world;
        const { mesh } = w;
        const st = coastStyle(w)!;
        // 峡湾权重最高的海岸格上画一笔
        let c = -1;
        for (let i = 0; i < mesh.n; i++) {
          if (!w.causes.land[i] || st.fjord[i] < 0.5) continue;
          let coast = false;
          for (let k = mesh.off[i]; k < mesh.off[i + 1]; k++) if (!w.causes.land[mesh.adj[k]]) coast = true;
          if (coast && (c < 0 || st.fjord[i] > st.fjord[c])) c = i;
        }
        expect(c).toBeGreaterThanOrEqual(0);
        const b = brushCells(w, mesh.x[c], mesh.y[c], 2.5 * mesh.spacing * w.kmPerUnit);
        const stroke = landStroke(w, b.cells, b.t, mode);
        const opts = { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false } as const;
        const base = cellLayers(w, opts);
        const ghost = new GhostBuffer(base, 'terrain').apply(w, editGhost(w, base, { cells: stroke.cells, delta: stroke.delta }));
        const after = e.clone();
        after.exec({ op: 'paint_land', cells: b.cells, t: b.t, mode });
        const want = displayStyle(after.world)!;
        let changed = 0;
        let bad = 0;
        for (let i = 0; i < mesh.n; i++) {
          if (want[2 * i] !== base.style![2 * i]) changed++;
          // 湖随结果变（幽灵里湖照旧）：湖格的沙坝不比
          if (ghost.style![2 * i] !== want[2 * i]) bad++;
        }
        expect(changed).toBeGreaterThan(0);
        expect(bad).toBe(0);
      });
    }
  }
});

describe('溺谷的河口', () => {
  it('有溺谷的河口，喇叭口比不标溺谷时宽', () => {
    const e = build(SETTINGS[1][1]);
    const w = e.world;
    const lines = traceRivers(w);
    const rias = lines.filter((l) => l.ria);
    expect(rias.length).toBeGreaterThan(0);
    const thr = w.small.planet.riverThreshold;
    for (const l of rias.slice(0, 5)) {
      const a = riverRibbon(l, thr, w.mesh.spacing);
      const b = riverRibbon({ ...l, ria: undefined }, thr, w.mesh.spacing);
      expect(a.hw[a.hw.length - 1]).toBeGreaterThan(1.5 * b.hw[b.hw.length - 1]);
      // 离河口两格以外一样宽
      expect(a.hw[0]).toBe(b.hw[0]);
    }
  });
});
