import { describe, expect, it } from 'vitest';
import { lithLayer } from '../src/render/colors';
import { LAGOON_ERODIBILITY } from './elevation';
import { Engine } from './engine';
import { DEFAULT_SPECIES, OLD_DEFAULT_COLORS, speciesColor } from './species';
import { ISLAND_ERODIBILITY, ISLAND_KINDS, type IslandKind, islandSizeRangeKm, islandStamp } from './terrain';

// 第十三轮：几种岛各有岩性（可蚀性），小到一两格也看得出来；珊瑚岛有真浅的潟湖；新的生态配色

function ocean(): Engine {
  const eng = new Engine({ seed: 4, cells: 12000 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
  return eng;
}

// 在一片海上放一个岛，返回新长出的陆格与改了的海格
function place(kind: IslandKind, cells: number) {
  const eng = ocean();
  const w = eng.world;
  const before = w.causes.land.slice();
  const cellKm = w.mesh.spacing * w.kmPerUnit;
  eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind, size: cellKm * cells, variant: 2 } });
  const fresh: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && !before[i]) fresh.push(i);
  return { eng, w: eng.world, fresh };
}

describe('几种岛的岩性', () => {
  it('新长出的陆地按种类写可蚀性：火山岛硬、低平岛软、珊瑚岛与小礁是珊瑚砂、大陆岛不变', () => {
    for (const kind of ISLAND_KINDS) {
      for (const cells of [0.4, 1, 4]) {
        const { w, fresh } = place(kind, cells);
        expect(fresh.length, `${kind} ${cells}`).toBeGreaterThan(0);
        const want = ISLAND_ERODIBILITY[kind];
        for (const i of fresh) {
          if (want === null) expect(w.causes.erodDelta[i]).toBe(0);
          else expect(w.causes.erod[i], `${kind} ${cells}`).toBeCloseTo(want, 4);
        }
      }
    }
  });

  it('一样大的岛：火山岛最高，大陆岛其次，低平岛低，珊瑚岛几乎贴着海面', () => {
    const top = (kind: IslandKind) => {
      const { w, fresh } = place(kind, 4);
      return Math.max(...fresh.map((i) => w.derived.elevation[i]));
    };
    const [v, c, l, a] = (['volcanic', 'continental', 'low', 'atoll'] as const).map(top);
    expect(v).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(l);
    expect(l).toBeGreaterThan(a);
    expect(v).toBeGreaterThan(1500);
    expect(v).toBeLessThan(6000);
    expect(a).toBeLessThan(40);
  });

  it('撤销放岛时岩性也收回', () => {
    const { eng, w } = place('volcanic', 3);
    eng.undo();
    expect(eng.world.causes.erodDelta.every((v) => v === 0)).toBe(true);
    expect(w).toBeTruthy();
  });

  it('珊瑚岛的潟湖：环里的海格是十几到五十米的浅水', () => {
    for (const cells of [2, 4]) {
      const { w } = place('atoll', cells);
      const lagoon: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) if (!w.causes.land[i] && w.causes.erod[i] >= LAGOON_ERODIBILITY) lagoon.push(i);
      expect(lagoon.length, `${cells}`).toBeGreaterThan(0);
      for (const i of lagoon) {
        expect(w.derived.elevation[i]).toBeLessThanOrEqual(-12);
        expect(w.derived.elevation[i]).toBeGreaterThanOrEqual(-50);
      }
    }
    // 别的岛四周还是深海
    const { w } = place('volcanic', 4);
    for (let i = 0; i < w.mesh.n; i++) if (!w.causes.land[i]) expect(w.causes.erod[i]).toBeLessThan(LAGOON_ERODIBILITY);
  });

  it('开口太大（环不成形）的海格不算潟湖：放岛的结果里没有孤零零的浅水格', () => {
    const w = ocean().world;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    for (let v = 0; v < 20; v++) {
      const st = islandStamp(w, { x: 0.3 + v * 0.07, y: 0.5, kind: 'atoll', size: cellKm * 1, variant: v });
      const fp = new Set(st.footprint);
      st.cells.forEach((i, k) => {
        if (fp.has(i) || st.erodDelta[k] === 0) return;
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

  it('渲染的岩性层：几种岛各占一个通道，一格大的珊瑚岛在格里画潟湖', () => {
    const at = (kind: IslandKind, cells: number) => {
      const { w, fresh } = place(kind, cells);
      const L = lithLayer(w);
      const mean = (ch: number) => fresh.reduce((s, i) => s + L[i * 4 + ch], 0) / fresh.length / 255;
      return [mean(0), mean(1), mean(2), mean(3)];
    };
    const [vh, vs, vc] = at('volcanic', 1);
    expect(vh).toBeGreaterThan(0.9);
    expect(vs + vc).toBe(0);
    const [ch, cs, cc] = at('continental', 1);
    expect(ch + cs + cc).toBeLessThan(0.05);
    const [lh, ls] = at('low', 1);
    expect(lh).toBe(0);
    expect(ls).toBeGreaterThan(0.9);
    const [ah, as, ac, aLagoon] = at('atoll', 0.4);
    expect(ah + as).toBe(0);
    expect(ac).toBeGreaterThan(0.9);
    expect(aLagoon).toBeGreaterThan(0.4);
    // 小礁：珊瑚砂，不画潟湖
    const [, , rc, rLagoon] = at('reef', 1);
    expect(rc).toBeGreaterThan(0.9);
    expect(rLagoon).toBe(0);
  });

  it('最小的岛一格，四种岛一样', () => {
    const w = ocean().world;
    const lo = islandSizeRangeKm(w, 'volcanic')[0];
    for (const kind of ISLAND_KINDS) expect(islandSizeRangeKm(w, kind)[0]).toBe(lo);
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
