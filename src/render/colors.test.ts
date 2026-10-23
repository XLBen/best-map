import { describe, expect, it } from 'vitest';
import { SPARKLE, SPARKLE3, fxPalette, fxSet } from '../../core/biome-look';
import type { Command } from '../../core/commands';
import { type PreviewPatch, previewWorldOf } from '../../core/preview-world';
import { brushCells } from '../../core/select';
import type { Species, Visual } from '../../core/species';
import { islandStamp, landStroke, previewTerrain } from '../../core/terrain';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { type ColorOptions, GhostBuffer, cellLayers, colorSignature, editGhost, fxLayers, ghostLayers, highlightColors, provinceScale, terrainGhost } from './colors';

// 高亮的编码（着色器按 alpha 字节解码）、省界淡出用的省份大小、幽灵海岸的图层、预览世界的着色、
// 生态的颜色脚本（d.look）与花纹、发光（fx）

describe('highlightColors 的 alpha 字节', () => {
  const w = continents().world;

  it('平涂 1–127、只描边 128、斜线 129–255；后面的层盖住前面的层', () => {
    const out = highlightColors(w, [
      { cells: [0, 1, 2], color: [10, 20, 30], alpha: 0.5 },
      { cells: [1], color: [40, 50, 60], pattern: 'outline' },
      { cells: [2], color: [70, 80, 90], alpha: 0.85, pattern: 'hatch' },
      // 只描边不看 alpha、values：淡到 0 也照样描
      { cells: [3], color: [255, 255, 255], alpha: 0, pattern: 'outline' },
    ])!;
    expect(Array.from(out.subarray(0, 4))).toEqual([10, 20, 30, Math.round(127 * 0.5)]);
    expect(Array.from(out.subarray(4, 8))).toEqual([40, 50, 60, 128]);
    expect(Array.from(out.subarray(8, 12))).toEqual([70, 80, 90, 128 + Math.round(127 * 0.85)]);
    expect(out[15]).toBe(128);
    // 没有高亮的格是 0
    expect(out[19]).toBe(0);
  });

  it('淡到一个字节以下的平涂、斜线不写（不会被当成只描边）', () => {
    const out = highlightColors(w, [
      { cells: [0], color: [255, 255, 255], alpha: 0.003 },
      { cells: [1], color: [255, 255, 255], alpha: 0.003, pattern: 'hatch' },
    ])!;
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(0);
  });

  it('闪烁淡出时每一步的不透明度都编成平涂（轮廓跟着它淡）', () => {
    for (let step = 1; step <= 7; step++) {
      const out = highlightColors(w, [{ cells: [5], color: [255, 236, 120], alpha: step / 40 }])!;
      const A = out[5 * 4 + 3];
      expect(A).toBeGreaterThan(0);
      expect(A).toBeLessThan(128);
    }
  });
});

describe('provinceScale', () => {
  it('省份格数中位数的平方根；没划分的格不算', () => {
    const p = Int32Array.from([-1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, -1]);
    // 省 0：4 格，省 1：9 格，省 2：1 格 → 中位数 4
    expect(provinceScale(p)).toBe(2);
  });

  it('没有省份时为 1', () => {
    expect(provinceScale(new Int32Array(10).fill(-1))).toBe(1);
  });

  it('划好省份的世界：每个省大约几格宽', () => {
    const w = continents({ provinces: true }).world;
    const s = provinceScale(w.causes.province);
    expect(s).toBeGreaterThan(2);
    expect(s).toBeLessThan(40);
  });
});

describe('幽灵海岸的图层', () => {
  const opts = (mode: ColorOptions['mode']): ColorOptions => ({ mode, season: 'annual', focusSpecies: null, borders: true });
  const cellKm = (w: World) => w.mesh.spacing * w.kmPerUnit;
  // 一格海，周围 5 格以内都是海
  const seaCell = (w: World) =>
    [...Array(w.mesh.n).keys()].find((i) => i > w.mesh.n * 0.3 && !w.causes.land[i] && brushCells(w, w.mesh.x[i], w.mesh.y[i], cellKm(w) * 5).cells.every((c) => !w.causes.land[c] && !w.mesh.boundary[c]))!;
  const coastCell = (w: World) =>
    [...Array(w.mesh.n).keys()].find((i) => i > w.mesh.n * 0.4 && w.causes.land[i] && !w.derived.lake[i] && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].some((j) => !w.causes.land[j]))!;
  // 与底子不同的格
  const differs = (w: World, base: ReturnType<typeof cellLayers>, g: ReturnType<typeof ghostLayers>) => {
    const out: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) {
      let d = !Object.is(base.coast[i], g.coast[i]) || !Object.is(base.elevation[i], g.elevation[i]);
      for (let c = 0; c < 4; c++) d ||= base.smooth[i * 4 + c] !== g.smooth[i * 4 + c] || base.other[i * 4 + c] !== g.other[i * 4 + c];
      if (base.flat) for (let c = 0; c < 4; c++) d ||= base.flat[i * 4 + c] !== g.flat![i * 4 + c];
      if (base.group) d ||= base.group[2 * i] !== g.group![2 * i] || base.group[2 * i + 1] !== g.group![2 * i + 1];
      if (d) out.push(i);
    }
    return out;
  };

  it('ghostLayers：新陆地用陆色、只改补丁格与邻格', () => {
    const w = continents({ provinces: true }).world;
    const base = cellLayers(w, opts('provinces'));
    const c = seaCell(w);
    const st = islandStamp(w, { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'volcanic', size: 2.5 * cellKm(w), variant: 0 });
    const patch = editGhost(w, base, { cells: st.cells, delta: st.landDelta });
    const g = ghostLayers(w, base, patch, 'provinces');
    const newLand = [...patch.cells].filter((i, k) => patch.land[k] && !w.causes.land[i]);
    expect(newLand.length).toBeGreaterThan(3);
    const allowed = new Set(patch.cells);
    for (const i of newLand) for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) allowed.add(w.mesh.adj[e]);
    const changed = differs(w, base, g);
    expect(changed.every((i) => allowed.has(i))).toBe(true);
    // 报给渲染器的格就是变了的格
    expect(changed.every((i) => g.cells.includes(i))).toBe(true);
    for (const i of newLand) {
      expect(g.coast[i]).toBeGreaterThan(0);
      expect(g.elevation[i]).toBeGreaterThanOrEqual(40);
      // 不再是海的颜色；平涂不画，省界不画在海域省上
      expect(Array.from(g.smooth.subarray(i * 4, i * 4 + 3))).not.toEqual(Array.from(base.smooth.subarray(i * 4, i * 4 + 3)));
      expect(g.flat![i * 4 + 3]).toBe(0);
      expect(g.group![2 * i]).toBeGreaterThanOrEqual(0);
      // 对岸的颜色：相邻水面格的平均
      const wet = [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].filter((j) => g.coast[j] <= 0);
      if (wet.length) expect(g.other[i * 4 + 2]).toBe(Math.round(wet.reduce((a, j) => a + g.smooth[j * 4 + 2], 0) / wet.length));
    }
  });

  it('画海、放湖：新海够深、新湖是水面', () => {
    const w = continents().world;
    const base = cellLayers(w, opts('terrain'));
    const c = coastCell(w);
    const b = brushCells(w, w.mesh.x[c], w.mesh.y[c], 3 * cellKm(w));
    const st = landStroke(w, b.cells, b.t, 'sea');
    const sea = editGhost(w, base, { cells: st.cells, delta: st.delta });
    const g = ghostLayers(w, base, sea, 'terrain');
    const lost = [...sea.cells].filter((i, k) => !sea.land[k] && w.causes.land[i]);
    expect(lost.length).toBeGreaterThan(3);
    for (const i of lost) {
      expect(g.coast[i]).toBeLessThanOrEqual(0);
      expect(g.elevation[i]).toBeLessThanOrEqual(-40);
    }
    // 一个内陆的小湖：湖面的海岸值取负（至少 60 m）、30 m 深
    const inland = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && !w.derived.lake[i] && base.coast[i] > 200)!;
    const lake = [inland, ...w.mesh.adj.subarray(w.mesh.off[inland], w.mesh.off[inland + 1])];
    const lg = ghostLayers(w, base, editGhost(w, base, { cells: [], delta: [], lake }), 'terrain');
    for (const i of lake) {
      expect(lg.coast[i]).toBeLessThanOrEqual(-60);
      expect(lg.elevation[i]).toBe(-30);
    }
  });

  it('持久的缓冲：换补丁时先还原上一次的，回到 null 时与底子逐字节相同', () => {
    const w = continents().world;
    const base = cellLayers(w, opts('terrain'));
    const buf = new GhostBuffer(base, 'terrain');
    const at = (c: number) => {
      const st = islandStamp(w, { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'volcanic', size: 2 * cellKm(w), variant: 0 });
      return editGhost(w, base, { cells: st.cells, delta: st.landDelta });
    };
    const c = seaCell(w);
    const first = buf.apply(w, at(c));
    const firstCells = Array.from(first.cells);
    // 挪开几格再放：上一次的格都还原了，结果与一次性算的相同
    const c2 = w.mesh.adj[w.mesh.off[w.mesh.adj[w.mesh.off[c]]]];
    const second = buf.apply(w, at(c2));
    const fresh = ghostLayers(w, base, at(c2), 'terrain');
    expect(Array.from(second.smooth)).toEqual(Array.from(fresh.smooth));
    expect(Array.from(second.other)).toEqual(Array.from(fresh.other));
    expect(Array.from(second.coast)).toEqual(Array.from(fresh.coast));
    expect(Array.from(second.elevation)).toEqual(Array.from(fresh.elevation));
    expect(firstCells.length).toBeGreaterThan(0);
    const none = buf.apply(w, null);
    expect(none.cells.length).toBe(0);
    expect(Array.from(none.smooth)).toEqual(Array.from(base.smooth));
    expect(Array.from(none.other)).toEqual(Array.from(base.other));
    expect(Array.from(none.coast)).toEqual(Array.from(base.coast));
    expect(Array.from(none.elevation)).toEqual(Array.from(base.elevation));
  });

  it('整份的预览（调整滑块）：只换海岸值变了的格，原来的湖照旧画成湖面', () => {
    const w = continents().world;
    const base = cellLayers(w, opts('terrain'));
    const t = previewTerrain(w, { landFraction: 0.45 });
    const patch = terrainGhost(w, base, t);
    // 什么都不变时补丁是空的
    expect(terrainGhost(w, base, previewTerrain(w, {})).cells.length).toBe(0);
    const g = ghostLayers(w, base, patch, 'terrain');
    expect(t.gained.length).toBeGreaterThan(0);
    for (const i of t.gained) expect(g.coast[i]).toBeGreaterThan(0);
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && w.derived.lake[i] === 1 && !t.lost.includes(i)) expect(g.coast[i]).toBeLessThanOrEqual(-60);
  });
});

describe('预览世界的着色', () => {
  it('高程没变、湖变了（整体干湿）：海岸、水深与执行后一致，不画出旧的湖', () => {
    const o = { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false } as const;
    // 内陆放一个季节性的湖：雨水多了，湖面变大
    const eng = continents({ cells: 5000 });
    const w = eng.world;
    const inland = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.causes.landness[i] >= 300);
    eng.exec({ op: 'add_lake', lake: { cell: inland[Math.floor(inland.length * 0.2)], radius: 1.5 * w.mesh.spacing * w.kmPerUnit, depth: 120, perennial: false } });
    const cmd: Command = { op: 'set_planet', patch: { humidity: 3 } };
    const { patch }: { patch: PreviewPatch } = eng.previewWorld(cmd);
    expect(patch.derived.lake).toBeDefined();
    expect(patch.derived.elevation).toBeUndefined();
    // 当前世界的着色先进了缓存（同一份高程）
    cellLayers(eng.world, o);
    const a = cellLayers(previewWorldOf(eng.world, structuredClone(patch)), o);
    eng.exec(cmd);
    const b = cellLayers(eng.world, o);
    expect(Array.from(a.coast)).toEqual(Array.from(b.coast));
    expect(Array.from(a.elevation)).toEqual(Array.from(b.elevation));
    expect(Array.from(a.smooth)).toEqual(Array.from(b.smooth));
  });
});

describe('生态的颜色脚本、花纹与发光', () => {
  const opts = (mode: ColorOptions['mode'], season: ColorOptions['season'] = 'annual'): ColorOptions => ({ mode, season, focusSpecies: null, borders: false });
  const withSpecies = (w: World, change: (s: Species) => Species): World => ({ ...w, small: { ...w.small, species: w.small.species.map(change) } });
  const veg = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
  const snowAt = (w: World, i: number) => (w.derived.tWarm[i] < 0 ? Math.min(1, -w.derived.tWarm[i] / 6) : 0);

  it('有 d.look 时用它当植被颜色，之后照旧加盐壳、积雪；look 为 0 的格照旧按份额混色', () => {
    const w = continents({ cells: 5000 }).world;
    const look = new Uint8Array(w.mesh.n * 4);
    for (let i = 0; i < w.mesh.n; i++) if (veg(w, i) && i % 3) look.set([10, 200, 30, 255], i * 4);
    const plain = cellLayers(w, opts('terrain'));
    const lw: World = { ...w, derived: { ...w.derived, look } };
    const a = cellLayers(lw, opts('terrain'));
    let used = 0;
    let bad = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const got = Array.from(a.smooth.subarray(i * 4, i * 4 + 4));
      // 海、湖、没有 look 的格：与没有 look 时一样
      let want = Array.from(plain.smooth.subarray(i * 4, i * 4 + 4));
      if (veg(w, i) && i % 3) {
        let c = w.derived.lake[i] === 2 ? [226, 218, 196] : [10, 200, 30];
        const k = snowAt(w, i);
        if (k > 0) c = [c[0] + (245 - c[0]) * k, c[1] + (248 - c[1]) * k, c[2] + (250 - c[2]) * k];
        // alpha（沙质）不变
        want = [...Array.from(new Uint8Array(c)), plain.smooth[i * 4 + 3]];
        used++;
      }
      if (got.some((v, k) => v !== want[k])) bad++;
    }
    expect(bad).toBe(0);
    expect(used).toBeGreaterThan(500);
    // 数据底图（气温）不管植被颜色
    expect(Array.from(cellLayers(lw, opts('temperature')).smooth)).toEqual(Array.from(cellLayers(w, opts('temperature')).smooth));
  });

  it('没有花纹、没有发光：不出 fx，其他图层与以前逐字节相同', () => {
    const w = continents({ cells: 5000 }).world;
    const a = cellLayers(w, opts('terrain'));
    expect(a.fx).toBeNull();
    expect(a.fxPalette).toBeNull();
    expect(fxLayers(w, opts('terrain'))).toBeNull();
    // 外观写了但“没有花纹也不发光”：同样跳过
    const none = withSpecies(w, (s) => ({ ...s, visual: { pattern: 'none', glow: 0 } }));
    expect(cellLayers(none, opts('terrain')).fx).toBeNull();
    // 有花纹时也只多出 fx，其他图层不变
    const pat = withSpecies(w, (s) => ({ ...s, visual: { pattern: 'mottle', glow: 0.3 } }));
    const b = cellLayers(pat, opts('terrain'));
    expect(b.fx).toBeInstanceOf(Uint8Array);
    for (const k of ['smooth', 'other', 'elevation', 'coast', 'grad'] as const) expect(Array.from(b[k]), k).toEqual(Array.from(a[k]));
    // 数据底图不画花纹；主导生态、省份着色照样画
    expect(cellLayers(pat, opts('precip')).fx).toBeNull();
    expect(cellLayers(pat, opts('dominant')).fx).toBeInstanceOf(Uint8Array);
  });

  it('fx 的编码：R 花纹那一行 + 1、G 份额（雪、盐壳盖住的不算）、B 发光、A 发光颜色那一行 + 1；调色板与 core 的一致', () => {
    const w = continents({ cells: 5000 }).world;
    const S = w.small.species.length;
    const pi = w.small.species.findIndex((s) => s.id === 'taiga');
    const gi = w.small.species.findIndex((s) => s.id === 'temperate_forest');
    const vw = withSpecies(w, (s) =>
      s.id === 'taiga' ? { ...s, visual: { pattern: 'cracks', amount: 0.8, size: 1 } } : s.id === 'temperate_forest' ? { ...s, visual: { pattern: 'none', glow: 0.5, glowColor: '#ff0000' } } : s,
    );
    const set = fxSet(vw.small.species, false)!;
    const ps = set.slotOf[pi];
    const gs = set.slotOf[gi];
    // 调色板的行按生态的顺序
    expect([ps, gs]).toEqual([0, 1]);
    for (const season of ['annual', 'winter'] as const) {
      const L = cellLayers(vw, opts('terrain', season));
      const fx = L.fx!;
      expect(Array.from(L.fxPalette!)).toEqual(Array.from(fxPalette(set)));
      let patterned = 0;
      let glowing = 0;
      let bad = 0;
      const d = w.derived;
      for (let i = 0; i < w.mesh.n; i++) {
        const got = Array.from(fx.subarray(i * 4, i * 4 + 4));
        let want = [0, 0, 0, 0];
        if (veg(w, i)) {
          const snowT = season === 'winter' ? Math.min(d.tS[i], d.tW[i]) : d.tWarm[i];
          const cover = d.lake[i] === 2 ? 0 : 1 - (snowT < 0 ? Math.min(1, -snowT / 6) : 0);
          const ws = d.share[i * S + pi];
          const wg = d.share[i * S + gi];
          want = [ws > 0 ? ps + 1 : 0, ws > 0 ? Math.round(255 * ws * cover) : 0, Math.round(255 * Math.min(1, wg * 0.5)), wg > 0 ? gs + 1 : 0];
        }
        if (got.some((v, k) => v !== want[k])) bad++;
        if (got[1] > 20) patterned++;
        if (got[2] > 20) glowing++;
      }
      expect(bad, season).toBe(0);
      expect(patterned, season).toBeGreaterThan(30);
      expect(glowing, season).toBeGreaterThan(30);
    }
  });

  it('着色缓存的键：只改外观（花纹、发光、种子）时变（地图重新着色），只改名字、地名设定时不变', () => {
    const w = continents({ cells: 2000 }).world;
    const sig = (change: (s: Species) => Species) => colorSignature(withSpecies(w, (s) => (s.id === 'steppe' ? change(s) : s)).small);
    const base = colorSignature(w.small);
    expect(sig((s) => s)).toBe(base);
    expect(sig((s) => ({ ...s, name: '大草原', feature: { label: '草原' } }))).toBe(base);
    const spots = sig((s) => ({ ...s, visual: { pattern: 'spots' } }));
    expect(spots).not.toBe(base);
    expect(sig((s) => ({ ...s, visual: { pattern: 'spots', glow: 0.2 } }))).not.toBe(spots);
    expect(sig((s) => ({ ...s, visual: { pattern: 'spots' }, seedKey: 'k' }))).not.toBe(spots);
    expect(sig((s) => ({ ...s, color: '#123456' }))).not.toBe(base);
  });

  it('拖滑块时的外观覆盖：只换花纹，与把外观写进世界后着色的一样', () => {
    const w = continents({ cells: 5000 }).world;
    const v: Visual = { pattern: 'spots', color2: '#203040', amount: 0.7, size: 1.5, glow: 0.2 };
    const ov = fxLayers(w, opts('terrain'), new Map([['steppe', v]]))!;
    const withV = withSpecies(w, (s) => (s.id === 'steppe' ? { ...s, visual: v } : s));
    const real = cellLayers(withV, opts('terrain'));
    expect(Array.from(ov.fx)).toEqual(Array.from(real.fx!));
    expect(Array.from(ov.palette)).toEqual(Array.from(real.fxPalette!));
    // 覆盖成没有花纹：这种生态不画
    expect(fxLayers(withV, opts('terrain'), new Map<string, Visual>([['steppe', { pattern: 'none' }]]))).toBeNull();
  });

  it('预览世界：去掉颜色脚本后的 look 不沿用当前世界的，着色与执行后相同', () => {
    const o = opts('terrain');
    const eng = continents({ cells: 5000 });
    eng.exec({ op: 'update_species', id: 'temperate_forest', patch: { scripts: { color: { api: 1, src: 'return [200, 40, 40];' } } } });
    expect(eng.world.derived.look).toBeInstanceOf(Uint8Array);
    const cmd: Command = { op: 'update_species', id: 'temperate_forest', patch: { scripts: {} } };
    const { patch }: { patch: PreviewPatch } = eng.previewWorld(cmd);
    expect(patch.gone).toContain('look');
    const pw = previewWorldOf(eng.world, structuredClone(patch));
    expect(pw.derived.look).toBeUndefined();
    const a = cellLayers(pw, o);
    eng.exec(cmd);
    expect(eng.world.derived.look).toBeUndefined();
    const b = cellLayers(eng.world, o);
    expect(Array.from(a.smooth)).toEqual(Array.from(b.smooth));
    // 什么都没去掉时不带这一项
    expect(eng.previewWorld({ op: 'set_planet', patch: { humidity: 1.2 } }).patch.gone).toBeUndefined();
  });

  it('合成着色器：平面用二维的花纹、星球换成球面上的三维花纹，括号配得上', async () => {
    // 没有 WebGL：只看拼出来的源码（替换找不到时模块加载就会报错）
    const { COMPOSE_SOURCES } = await import('./renderer');
    const count = (src: string, s: string) => src.split(s).length - 1;
    for (const [name, src] of Object.entries(COMPOSE_SOURCES)) {
      expect(count(src, '{'), name).toBe(count(src, '}'));
      expect(count(src, '('), name).toBe(count(src, ')'));
      expect(count(src, 'float patternAt(int kind'), name).toBe(1);
      for (const u of ['uniform sampler2D uFx;', 'uniform highp sampler2D uFxPal;', 'uniform int uHasFx;']) expect(src, name).toContain(u);
      expect(src).toContain(`const float PAT_DETAIL[7] = float[7](1.0, 0.4, 0.3, 1.0, 0.3, 0.6, 0.7);`);
    }
    expect(COMPOSE_SOURCES.plane).not.toContain('patternValue3');
    expect(COMPOSE_SOURCES.planet).toContain('return patternValue3(kind, sphereOf(world) * (uNoiseK / size)');
    // 闪光的疏密、点的大小用 core 的同一组数（改一边另一边跟着变）；条纹先取小数部分再求正弦
    expect(COMPOSE_SOURCES.plane).toContain(`unitH(h) >= ${SPARKLE.p})`);
    expect(COMPOSE_SOURCES.plane).toContain(`smoothstep(${SPARKLE.r0}, ${SPARKLE.r1}, length(g - ctr))`);
    expect(COMPOSE_SOURCES.planet).toContain(`unitH(h) >= ${SPARKLE3.p})`);
    expect(COMPOSE_SOURCES.planet).toContain(`smoothstep(${SPARKLE3.r0}, ${SPARKLE3.r1}, length(g - ctr))`);
    expect(COMPOSE_SOURCES.plane).toContain('sin(6.28318531 * fract(q.y + ');
    expect(COMPOSE_SOURCES.planet).toContain('sin(6.28318531 * fract(q.z + ');
  });

  it('花纹那几段编译不过时的退路：去掉花纹、发光的几段，剩下的照样是完整的着色器（与没有花纹时一样）', async () => {
    const { COMPOSE_SOURCES, withoutFx } = await import('./renderer');
    const count = (src: string, s: string) => src.split(s).length - 1;
    for (const [name, full] of Object.entries(COMPOSE_SOURCES)) {
      const src = withoutFx(full);
      expect(src.length, name).toBeLessThan(full.length - 2000);
      expect(count(src, '{'), name).toBe(count(src, '}'));
      expect(count(src, '('), name).toBe(count(src, ')'));
      // 花纹、发光的代码一行不剩（只留下用不着的 uniform 声明）
      for (const s of ['patternAt', 'patternValue', 'PAT_DETAIL', 'cellTex(uFx', 'uFxPal,', 'glowSlot', '<fx>', '</fx>']) expect(src, `${name} ${s}`).not.toContain(s);
      // 其余照旧：晕渲、海岸线、高亮、输出
      for (const s of ['void main() {', 'col *= mix(1.0, shade, uShade);', 'if (uHasHighlight == 1 && id >= 0) {', 'oColor = vec4(col, 1.0);']) expect(src, `${name} ${s}`).toContain(s);
    }
    expect(withoutFx(COMPOSE_SOURCES.planet)).toContain('vec3 Pf = sphereOf(world) * uNoiseK * 0.9;');
  });

  it('地图册的海：平涂的海之后再涂一次省份着色（海省选了颜色时与写实风格一样看得到）', async () => {
    const { COMPOSE_SOURCES } = await import('./renderer');
    for (const [name, src] of Object.entries(COMPOSE_SOURCES)) {
      const atlasSea = src.slice(src.indexOf('if (uStyle == 1) {'), src.indexOf('} else if (land) {'));
      expect(atlasSea, name).toContain('col = vec3(0.80, 0.88, 0.89);');
      expect(atlasSea.indexOf('col = mix(col, fc.rgb, fc.a);'), name).toBeGreaterThan(atlasSea.indexOf('col = vec3(0.80, 0.88, 0.89);'));
    }
  });

  it('第十三轮：河只合在画成陆地的像素上，排在平涂、湖面之后，海岸线、省界、高亮之前；省份的平涂、省界、高亮都按 provCell 取格', async () => {
    const { COMPOSE_SOURCES } = await import('./renderer');
    for (const [name, src] of Object.entries(COMPOSE_SOURCES)) {
      const main = src.slice(src.indexOf('void main() {'));
      const river = main.indexOf('if (uHasRiver == 1 && land) {');
      expect(river, name).toBeGreaterThan(0);
      expect(river, name).toBeGreaterThan(main.indexOf('if (uHasTint == 1 && id >= 0) {'));
      expect(river, name).toBeGreaterThan(main.indexOf('col = mix(col, fc.rgb, fc.a);'));
      expect(river, name).toBeLessThan(main.indexOf('// 海岸线：'));
      expect(river, name).toBeLessThan(main.indexOf('if (uHasGroup == 1 && pc >= 0) {'));
      expect(river, name).toBeLessThan(main.indexOf('if (uHasHighlight == 1 && id >= 0) {'));
      // 省份：像素自己的格、省界与轮廓的相邻像素都过 provCell（水面的像素不取陆地格）
      expect(main, name).toContain('int pc = provCell(seamCell(id, vUv), vUv, land);');
      expect(main, name).toContain('float gx = groupOf(provAt(vUv + dx, uvW + dx));');
      expect(main, name).toContain('int idH = byGroup ? pc : id;');
      expect(main, name).toContain('hlByte(byGroup ? provAt(vUv + hx, uvW + hx)');
      // 地图册的海不再另判海省（provCell 已保证水面只取水面格）
      expect(main, name).not.toContain('gS < -0.5');
      // 环上取样的个数、半径与 CPU 的 provinceCell 相同
      expect(src, name).toContain('for (int ring = 1; ring <= 2; ring++) {');
      expect(src, name).toContain('vec2 r = ((landPx ? 0.3 : 0.6) * float(ring) * uCellPx) * uTexel;');
      expect(src, name).toContain('for (int k = 0; k < 8; k++) {');
      // 画成陆地的像素：找不到陆地格时才用那个水面格
      expect(src, name).toContain('return landPx ? idG : -1;');
    }
    const { PROVINCE_LAND_RING, PROVINCE_RING } = await import('../../core/display');
    expect(PROVINCE_RING).toEqual({ n: 8, radii: [0.6, 1.2] });
    expect(PROVINCE_LAND_RING).toEqual({ n: 8, radii: [0.3, 0.6] });
  });
});

