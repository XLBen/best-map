import { describe, expect, it } from 'vitest';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { HALO, MAX_LEVEL, Sym, type SymbolTile, symbolLevel, symbolSet, tileSize, tilesIn } from './symbol-place';

// 第八十七轮：手绘画风的符号放在哪里——确定（同一个世界两次、换一个网格对象都一样）、互不重叠（足迹的圆不相交）、
// 改了高程只有那一片的块重算（别的块是同一个对象）

const all = (w: World, level: number) => tilesIn(symbolSet(w), level, 0, 0, w.mesh.width, w.mesh.height);
const flat = (tiles: SymbolTile[]) => tiles.flatMap((t) => Array.from({ length: t.count }, (_, q) => Array.from(t.syms.subarray(q * 5, q * 5 + 5))));

// 足迹相交的两对（按格子查）
function overlaps(syms: number[][]): number {
  const cell = Math.max(...syms.map((s) => s[2])) * 2;
  const grid = new Map<string, number[]>();
  syms.forEach((s, k) => {
    const key = `${Math.floor(s[0] / cell)},${Math.floor(s[1] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(k);
  });
  let bad = 0;
  syms.forEach((s, k) => {
    const gx = Math.floor(s[0] / cell);
    const gy = Math.floor(s[1] / cell);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j <= k) continue;
          const t = syms[j];
          if (Math.hypot(t[0] - s[0], t[1] - s[1]) < s[2] + t[2] - 1e-12) bad++;
        }
  });
  return bad;
}

// 摘要：每个符号的位置、半径、种类、大小按 1e-9 取整后的 FNV
function digestOf(syms: number[][]): string {
  let h = 2166136261;
  for (const s of syms) for (const v of s) h = Math.imul(h ^ Math.round(v * 1e9), 16777619) >>> 0;
  return h.toString(16);
}

describe('手绘画风的符号', () => {
  const eng = continents();
  const w = eng.world;

  it('有山、丘陵、森林；互不重叠（每一档）', () => {
    for (let level = 0; level <= MAX_LEVEL; level++) {
      // 第 1、2 档只看中间的一片（整张图的块太多）
      const s = symbolSet(w);
      const W = w.mesh.width;
      const H = w.mesh.height;
      const k = level ? 0.18 / level : 1;
      const tiles = tilesIn(s, level, W * (0.5 - k / 2), H * (0.5 - k / 2), W * (0.5 + k / 2), H * (0.5 + k / 2));
      const syms = flat(tiles);
      const kinds = new Set(syms.map((x) => x[3]));
      if (level === 0) {
        expect(kinds.has(Sym.Mountain)).toBe(true);
        expect(kinds.has(Sym.Hill)).toBe(true);
        expect(kinds.has(Sym.Broadleaf) || kinds.has(Sym.Conifer)).toBe(true);
        expect(syms.length).toBeGreaterThan(500);
      }
      expect(overlaps(syms), `第 ${level} 档`).toBe(0);
      // 放大后更密
      if (level) expect(syms.length).toBeGreaterThan(0);
    }
  });

  it('确定：同一个世界再建一份（另一个网格对象、空的缓存）放出来逐值相同；摘要不变', () => {
    const a = flat(all(w, 0));
    const b = flat(all(continents().world, 0));
    expect(b).toEqual(a);
    const byKind = [0, 0, 0, 0, 0];
    for (const s of a) byKind[s[3]]++;
    expect({ n: a.length, byKind, digest: digestOf(a) }).toMatchInlineSnapshot(`
      {
        "byKind": [
          97,
          347,
          45,
          100,
          0,
        ],
        "digest": "d60145a3",
        "n": 589,
      }
    `);
  });

  // 一片格（半径 R、中心 c）抬高 2500 m 的世界（只换高程这一个数组：别的推导不变，看得出只有那一片重算）
  const raised = (base: World, c: number, R: number): World => {
    const { mesh } = base;
    const elevation = base.derived.elevation.slice();
    for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < R) elevation[i] += 2500;
    return { ...base, derived: { ...base.derived, elevation } };
  };
  const ts = tileSize(w.mesh.spacing, 0);
  const centre = (t: SymbolTile, x: number, y: number) => Math.hypot((t.tx + 0.5) * ts - x, (t.ty + 0.5) * ts - y);

  it('改了高程：那一片长出山的符号，只有那一片的块重算，别的块是同一个对象', () => {
    const { mesh } = w;
    const land = [...Array(mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.elevation[i] < 400);
    const c = land[Math.floor(land.length * 0.4)];
    const R = 4 * mesh.spacing;
    const before = all(w, 0);
    const w2 = raised(w, c, R);
    const after = all(w2, 0);
    expect(after.length).toBe(before.length);
    const changed = after.filter((t, k) => t !== before[k]);
    expect(changed.length).toBeGreaterThan(0);
    // 新的山上有山的符号
    const near = flat(changed).filter((s) => Math.hypot(s[0] - mesh.x[c], s[1] - mesh.y[c]) < R);
    expect(near.some((s) => s[3] === Sym.Mountain)).toBe(true);
    // 重算的块都在改的那一片附近：块心离山不超过 改的半径 + 一格（起伏看邻格）+ 四周的范围 + 半块的对角线
    // （四周的范围按第 0 档的块取整：再多一块）
    const reach = R + mesh.spacing + (HALO * mesh.spacing + ts * 1.5) * Math.SQRT2;
    for (const t of changed) expect(centre(t, mesh.x[c], mesh.y[c]), `块 ${t.tx},${t.ty}`).toBeLessThan(reach);
    expect(changed.length).toBeLessThan(after.length / 2);
    // 再按原来的高程画：又是原来的那些对象（缓存里没被挤掉的块按键认回来）……至少位置逐值相同
    expect(flat(all(w, 0))).toEqual(flat(before));
  });

  it('引擎里画一座山（气候、生态也跟着变）：编码没变的那一片的块原样留着', () => {
    const e = continents();
    const { mesh } = e.world;
    const before = all(e.world, 0);
    const codes0 = symbolSet(e.world).codes.slice();
    const land = [...Array(mesh.n).keys()].filter((i) => e.world.causes.land[i] && e.world.derived.elevation[i] < 400);
    const c = land[Math.floor(land.length * 0.4)];
    const cells = [...Array(mesh.n).keys()].filter((i) => Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < 4 * mesh.spacing);
    e.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 2 });
    const codes1 = symbolSet(e.world).codes;
    const after = all(e.world, 0);
    const moved = [...Array(mesh.n).keys()].filter((i) => codes0[i] !== codes1[i]);
    expect(moved.length).toBeGreaterThan(0);
    const reach = (HALO * mesh.spacing + ts * 1.5) * Math.SQRT2;
    let kept = 0;
    after.forEach((t, k) => {
      const touched = moved.some((i) => centre(t, mesh.x[i], mesh.y[i]) < reach);
      if (!touched) {
        expect(t, `块 ${t.tx},${t.ty}`).toBe(before[k]);
        kept++;
      }
    });
    expect(kept).toBeGreaterThan(0);
  });

  it('一格多大用第几档', () => {
    expect(symbolLevel(1)).toBe(-1);
    expect(symbolLevel(5)).toBe(0);
    expect(symbolLevel(20)).toBe(1);
    expect(symbolLevel(48)).toBe(2);
  });
});
