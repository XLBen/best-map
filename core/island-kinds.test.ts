import { describe, expect, it } from 'vitest';
import { lithLayer } from '../src/render/colors';
import * as elevation from './elevation';
import { Engine } from './engine';
import { BUILTIN_ISLAND_TYPES, LAGOON_BIT } from './island-types';
import { DEFAULT_SPECIES, OLD_DEFAULT_COLORS, speciesColor } from './species';
import { islandSizeRangeKm, islandStamp } from './terrain';

// 第十三轮：几种岛各有岩性（可蚀性），小到一两格也看得出来；珊瑚岛有真浅的潟湖；新的生态配色。
// 第十四轮：去掉了火山岛；岛的样子、潟湖按每格记下的岛的种类（causes.islandType），不再按可蚀性认

function ocean(): Engine {
  const eng = new Engine({ seed: 4, cells: 12000 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
  return eng;
}

// 在一片海上放一个岛，返回新长出的陆格与改了的海格
function place(kind: string, cells: number, eng = ocean()) {
  const w = eng.world;
  const before = w.causes.land.slice();
  const cellKm = w.mesh.spacing * w.kmPerUnit;
  eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind, size: cellKm * cells, variant: 2 } });
  const fresh: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && !before[i]) fresh.push(i);
  return { eng, w: eng.world, fresh };
}

const isLagoon = (w: Engine['world'], i: number) => !w.causes.land[i] && (w.causes.islandType[i] & LAGOON_BIT) !== 0;

describe('几种岛的岩性', () => {
  it('新长出的陆地按种类写可蚀性（低平岛软、珊瑚岛与小礁是珊瑚砂、大陆岛不变），并记下种类', () => {
    BUILTIN_ISLAND_TYPES.forEach((t, k) => {
      // 碎岛（第十八轮）不长出陆地（见 shards.test.ts）
      if (t.shape === 'frag') return;
      for (const cells of [0.4, 1, 4]) {
        const { w, fresh } = place(t.id, cells);
        expect(fresh.length, `${t.id} ${cells}`).toBeGreaterThan(0);
        for (const i of fresh) {
          if (t.rock === undefined) expect(w.causes.erodDelta[i]).toBe(0);
          else expect(w.causes.erod[i], `${t.id} ${cells}`).toBeCloseTo(t.rock, 4);
          expect(w.causes.islandType[i], `${t.id} ${cells}`).toBe(k + 1);
        }
      }
    });
  });

  it('一样大的岛：大陆岛比低平岛高，低平岛比珊瑚岛高，珊瑚岛几乎贴着海面；自己的“高”的岛最高', () => {
    const top = (kind: string, eng?: Engine) => {
      const { w, fresh } = place(kind, 4, eng);
      return Math.max(...fresh.map((i) => w.derived.elevation[i]));
    };
    const [c, l, a] = (['continental', 'low', 'atoll'] as const).map((k) => top(k));
    expect(c).toBeGreaterThan(l);
    expect(l).toBeGreaterThan(a);
    expect(a).toBeLessThan(40);
    const eng = ocean();
    eng.exec({ op: 'set_island_type', type: { id: 'peak', name: '高岛', shape: 'round', height: 'high' } });
    expect(top('peak', eng)).toBeGreaterThan(c);
  });

  it('撤销放岛时岩性、种类也收回', () => {
    const { eng } = place('low', 3);
    eng.undo();
    expect(eng.world.causes.erodDelta.every((v) => v === 0)).toBe(true);
    expect(eng.world.causes.islandType.every((v) => v === 0)).toBe(true);
  });

  it('珊瑚岛的潟湖：环里的海格记着潟湖，是十几到五十米的浅水', () => {
    for (const cells of [2, 4]) {
      const { w } = place('atoll', cells);
      const lagoon: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) if (isLagoon(w, i)) lagoon.push(i);
      expect(lagoon.length, `${cells}`).toBeGreaterThan(0);
      for (const i of lagoon) {
        expect(w.derived.elevation[i]).toBeLessThanOrEqual(-12);
        expect(w.derived.elevation[i]).toBeGreaterThanOrEqual(-50);
      }
    }
    // 别的岛四周还是深海
    const { w } = place('continental', 4);
    for (let i = 0; i < w.mesh.n; i++) expect(isLagoon(w, i)).toBe(false);
  });

  it('涂了很软的岩石的海不会当成潟湖（第十四轮：以前按可蚀性 ≥ 4.6 认）', () => {
    const eng = ocean();
    const w = eng.world;
    const sea: number[] = [];
    for (let i = 0; i < w.mesh.n && sea.length < 40; i++) if (!w.causes.land[i] && Math.abs(w.mesh.x[i] - 1) < 0.1 && Math.abs(w.mesh.y[i] - 0.5) < 0.1) sea.push(i);
    const before = sea.map((i) => w.derived.elevation[i]);
    eng.exec({ op: 'paint', field: 'erodDelta', cells: sea, value: 4, mode: 'set' });
    expect(sea.map((i) => eng.world.derived.elevation[i])).toEqual(before);
  });

  it('开口太大（环不成形）的海格不算潟湖：放岛的结果里没有孤零零的浅水格', () => {
    const w = ocean().world;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    for (let v = 0; v < 20; v++) {
      const st = islandStamp(w, { x: 0.3 + v * 0.07, y: 0.5, kind: 'atoll', size: cellKm * 1, variant: v });
      const fp = new Set(st.footprint);
      st.cells.forEach((i, k) => {
        if (fp.has(i) || !(st.types[k] & LAGOON_BIT)) return;
        let near = 0;
        let all = 0;
        for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) {
          all++;
          const j = w.mesh.adj[e];
          if (fp.has(j) || st.cells.includes(j)) near++;
        }
        expect(near / all).toBeGreaterThanOrEqual(0.6);
      });
    }
  });

  it('渲染的岛的样子：沙洲、白沙各占一个通道，一格大的珊瑚岛在格里画潟湖；没有玄武岩', () => {
    const at = (kind: string, cells: number) => {
      const { w, fresh } = place(kind, cells);
      const L = lithLayer(w);
      const mean = (ch: number) => fresh.reduce((s, i) => s + L[i * 4 + ch], 0) / fresh.length / 255;
      return [mean(0), mean(1), mean(2), mean(3)];
    };
    const [ch, cs, cc] = at('continental', 1);
    expect(ch + cs + cc).toBe(0);
    const [lh, ls] = at('low', 1);
    expect(lh).toBe(0);
    expect(ls).toBeGreaterThan(0.9);
    const [ah, as, ac, aLagoon] = at('atoll', 0.4);
    expect(ah + as).toBe(0);
    expect(ac).toBeGreaterThan(0.9);
    expect(aLagoon).toBeGreaterThan(0.4);
    // 小礁：白沙，不画潟湖
    const [rh, , rc, rLagoon] = at('reef', 1);
    expect(rh).toBe(0);
    expect(rc).toBeGreaterThan(0.9);
    expect(rLagoon).toBe(0);
  });

  it('涂了很硬、很软的岩石的陆地画面不变（岛的样子只按种类）', () => {
    const eng = new Engine({ seed: 4, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const w = eng.world;
    const land: number[] = [];
    for (let i = 0; i < w.mesh.n && land.length < 300; i++) if (w.causes.land[i]) land.push(i);
    eng.exec({ op: 'paint', field: 'erodDelta', cells: land.slice(0, 150), value: -0.6, mode: 'set' });
    eng.exec({ op: 'paint', field: 'erodDelta', cells: land.slice(150), value: 3.5, mode: 'set' });
    expect(lithLayer(eng.world).every((v) => v === 0)).toBe(true);
  });

  it('最小的岛一格，各种岛一样（碎岛更小：0.15 格）', () => {
    const w = ocean().world;
    const lo = islandSizeRangeKm(w, 'continental')[0];
    for (const t of BUILTIN_ISLAND_TYPES) {
      if (t.shape === 'frag') expect(islandSizeRangeKm(w, t.id)[0]).toBeCloseTo((lo * 0.15) / 0.4, 9);
      else expect(islandSizeRangeKm(w, t.id)[0]).toBe(lo);
    }
  });
});

describe('去掉了火山岛（第十四轮）', () => {
  it('没有火山岛这一种，放火山岛的命令报错；高程里不再有 volcanoes', () => {
    // 第十八轮在最后加了碎岛
    expect(BUILTIN_ISLAND_TYPES.map((t) => t.id)).toEqual(['continental', 'low', 'atoll', 'reef', 'shards']);
    expect('volcanoes' in elevation).toBe(false);
    const eng = ocean();
    expect(() => eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'volcanic', size: 100, variant: 0 } })).toThrow(/没有火山岛了/);
    expect(() => eng.exec({ op: 'add_island_chain', chain: { points: [[0.5, 0.5], [1.2, 0.5]], kind: 'volcanic', size: 60 } })).toThrow(/没有火山岛了/);
  });

  it('不写种类时是大陆岛', () => {
    const eng = ocean();
    expect(eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, size: 100 } })).toContain('大陆岛');
  });
});

describe('生态的新配色', () => {
  it('旧的默认颜色画的时候换成新的；用户改过的颜色不动', () => {
    for (const sp of DEFAULT_SPECIES) {
      const old = OLD_DEFAULT_COLORS[sp.id];
      if (old === undefined) continue;
      expect(old).not.toBe(sp.color);
      expect(speciesColor({ id: sp.id, color: old })).toBe(sp.color);
      expect(speciesColor({ id: sp.id, color: old.toUpperCase() })).toBe(sp.color);
      expect(speciesColor(sp)).toBe(sp.color);
      expect(speciesColor({ id: sp.id, color: '#123456' })).toBe('#123456');
    }
    // 别的生态（自定义的）用了某个旧的默认颜色也不换
    expect(speciesColor({ id: 'my_forest', color: OLD_DEFAULT_COLORS.taiga })).toBe(OLD_DEFAULT_COLORS.taiga);
  });

  it('相邻的默认生态颜色差得更开（CIEDE76 最近的一对比旧配色大）', () => {
    const lab = (hex: string) => {
      const v = parseInt(hex.slice(1), 16);
      const lin = (c: number) => {
        const x = c / 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      const [r, g, b] = [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255)];
      const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
      return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
    };
    const minPair = (colors: string[]) => {
      let best = Infinity;
      for (let a = 0; a < colors.length; a++)
        for (let b = a + 1; b < colors.length; b++) {
          const [p, q] = [lab(colors[a]), lab(colors[b])];
          best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        }
      return best;
    };
    const ids = Object.keys(OLD_DEFAULT_COLORS);
    const now = ids.map((id) => DEFAULT_SPECIES.find((s) => s.id === id)!.color);
    const old = ids.map((id) => OLD_DEFAULT_COLORS[id]);
    expect(minPair(now)).toBeGreaterThan(minPair(old) * 1.5);
  });
});

// 第十三轮修：放岛只添陆地
describe('放岛只添陆地', () => {
  it('珊瑚岛贴着别的岛放：原来的陆地一格不少（潟湖只压原来是海的格）', () => {
    for (const kind of ['low', 'continental'] as const) {
      const eng = new Engine({ seed: 4, cells: 12000, latNorth: 18, latSouth: 8 });
      eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
      eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind, size: 60, variant: 1 } });
      const before = eng.world.causes.land.slice();
      eng.exec({ op: 'add_island', island: { x: 0.92, y: 0.5, kind: 'atoll', size: 70, variant: 2 } });
      const w = eng.world;
      for (let i = 0; i < w.mesh.n; i++) if (before[i]) expect(w.causes.land[i], `${kind} #${i}`).toBe(1);
      // 还是有潟湖
      let lagoon = 0;
      for (let i = 0; i < w.mesh.n; i++) if (isLagoon(w, i)) lagoon++;
      expect(lagoon, kind).toBeGreaterThan(3);
    }
  });
});
