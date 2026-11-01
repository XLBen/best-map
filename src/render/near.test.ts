import { describe, expect, it } from 'vitest';
import { displayCoast } from '../../core/display';
import type { Engine } from '../../core/engine';
import { blocList } from '../../core/human';
import { landPixelCells } from '../../core/island-types';
import { scissors, seamPick } from '../../core/seams';
import { warpOffset, warpOffset3 } from '../../core/subcell';
import { continents, humanExec, seededEngine, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import type { ViewMode } from '../state';
import { type ColorOptions, FEDERATION_GROUP, cellLayers } from './colors';
import { BUILTIN_ERAS } from '../../core/packs/eras';
import { NEAR_MAX, drawnCellAt, nearFixed, nearGraph, nearLayer, nearRho } from './near';

// 第三十九轮：离边界远的格（near.ts）。合成着色器在“这一格往外 H 步都同值、环上的取样离扭曲后的位置最远 reach < ρ_H”时
// 不取省界、国界、帝国外沿的相邻像素。这里把着色器的那几段（provAt、provCell、seamCell、landCellOf、三个环）照着写成 JS，
// 在真实的世界（一块地区与整个星球，带剪刀切线、领海、帝国）上逐像素地算：凡是会跳过的像素，照算的结果一定画不出线。
// 编号层按画出来的格（near.ts 的 drawnCellAt：多边形，与 GPU 画的同一份），取样位置按场景的纹素取整；
// 像素的陆海故意打乱一些（按位置的哈希把约 12% 的取样翻成另一类，再有 2% 是小湖群）：provCell 往外找格、landCellOf 都走得到

const GROUPS = [
  { id: 'germanic', weight: 3 },
  { id: 'chinese', weight: 3 },
  { id: 'altaic', weight: 1.5 },
];

function cutBig(eng: Engine) {
  const w = eng.world;
  const { mesh } = w;
  const sphere = mesh.kind === 'sphere';
  const sizes = new Map<number, number>();
  w.causes.province.forEach((p) => p >= 0 && sizes.set(p, (sizes.get(p) ?? 0) + 1));
  const bigs = [...sizes].filter(([p]) => w.small.provinces[p]?.land).sort((a, b) => b[1] - a[1]);
  const s = mesh.spacing;
  for (const [big, size] of bigs.slice(0, 5)) {
    let sx = 0;
    let cx = 0;
    let cy = 0;
    w.causes.province.forEach((p, i) => {
      if (p !== big) return;
      sx += sphere ? Math.sin(Math.PI * mesh.x[i]) : mesh.x[i];
      cx += sphere ? Math.cos(Math.PI * mesh.x[i]) : 0;
      cy += mesh.y[i];
    });
    const x = sphere ? Math.atan2(sx, cx) / Math.PI : sx / size;
    const y = cy / size;
    const { line, cut } = scissors(w, [
      [x - 2 * s, y + 0.2 * s],
      [x + 2 * s, y - 0.1 * s],
    ]);
    if (!cut.plans.length) continue;
    eng.exec({ op: 'cut_province', line });
    return;
  }
  throw new Error('没有切得开的省');
}

// 人文、国家（领海：离岸 seaKm 以内的海归国家），再横切一个大省
function peopled(e: Engine, seaKm: number, fragmentation?: number): Engine {
  humanExec(e, { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: { seed: 3 } });
  const era = structuredClone(BUILTIN_ERAS.find((x) => x.id === 'medieval')!);
  e.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: { ...era, seaClaimKm: seaKm } });
  humanExec(e, { op: 'regenerate_countries', ...(fragmentation !== undefined ? { fragmentation } : {}) });
  cutBig(e);
  return e;
}
const seamAt = (w: World): [number, number] => {
  const seam = w.small.provinceSeams![0];
  return seam.line[Math.floor(seam.line.length / 2)];
};

const WORLDS: [string, () => World][] = [
  ['一块地区（人文、国家、帝国、领海、剪刀切线）', () => snapshot('near:region', () => peopled(continents({ provinces: true }), 300)).world],
  [
    '整个星球（人文、国家、领海、剪刀切线，跨经度接缝）',
    () =>
      snapshot('near:planet', () => {
        const e = seededEngine({ cells: 12000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
        e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
        e.exec({ op: 'generate_provinces', rules: { seed: 3 } });
        return peopled(e, 400, 0.2);
      }).world,
  ],
];

// 图层连同离边界远的格（渲染器在空闲时算的那一份）
function layersOf(w: World, o: ColorOptions) {
  const L = cellLayers(w, o);
  return { ...L, near: nearLayer(w.mesh, L.group, L.countryGroup, L.coast, L.landCell) };
}

// 位置的哈希（0–1）
function hash(x: number, y: number): number {
  let h = Math.imul(Math.floor(x * 1e7) | 0, 0x27d4eb2d) ^ Math.imul(Math.floor(y * 1e7) | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// 着色器的边界规则（renderer.ts 的 FS_COMPOSE），一个像素一个像素地算。p：画面一个像素合多少地图单位
function shaderRules(w: World, mode: ViewMode, countryAlpha: number) {
  const { mesh } = w;
  const sphere = mesh.kind === 'sphere';
  const L = layersOf(w, { mode, season: 'annual', focusSpecies: null, borders: true, countryBorders: true });
  const group = L.group!;
  const country = L.countryGroup!;
  const near = L.near!;
  const coast = L.coast;
  const frag = displayCoast(w).frag;
  const lp = landPixelCells(w);
  const seams = L.seams ?? null;
  const rho = Float32Array.from(nearRho(mesh), (v) => (v > 0 ? v * (1 - 1e-4) : v));
  const s = mesh.spacing;
  let hint = 0;
  let p = s / 8;
  const snap = (v: number) => (Math.floor(v / p) + 0.5) * p;
  // 编号层：场景的纹素取整后，按画出来的格
  const idAt = (x: number, y: number) => {
    const c = drawnCellAt(mesh, snap(x), snap(y), hint);
    if (c >= 0) hint = c;
    return c;
  };
  // 像素的陆海：这一点画出来的格的陆海，按位置的哈希翻掉一些；-1 是小湖群
  const landAt = (x: number, y: number): number => {
    const c = idAt(x, y);
    const r = hash(snap(x), snap(y));
    if (r < 0.02) return -1;
    const land = c >= 0 && !(coast[c] < 0);
    return (r < 0.14 ? !land : land) ? 1 : 0;
  };
  const water = (c: number) => coast[c] < 0;
  const isFrag = (c: number) => !!frag && frag[c] > 0;
  const landCellOf = (c: number) => (lp[c] >= 0 ? lp[c] : c);
  const seamCell = (c: number, x: number, y: number) => (c < 0 || !seams ? c : seamPick(seams, w, x, y, c));
  const provCell = (idG: number, x: number, y: number, landPx: boolean): number => {
    if (idG < 0 || water(idG) !== landPx) return idG;
    if (landPx && isFrag(idG)) return idG;
    let c = seamCell(idAt(x, y), x, y);
    if (c >= 0 && water(c) !== landPx) return c;
    for (let ring = 1; ring <= 2; ring++) {
      const r = (landPx ? 0.3 : 0.6) * ring * s;
      for (let k = 0; k < 8; k++) {
        const a = k * 0.7853982;
        const qx = x + Math.cos(a) * r;
        const qy = y + Math.sin(a) * r;
        c = seamCell(idAt(qx, qy), qx, qy);
        if (c >= 0 && water(c) !== landPx) return c;
      }
    }
    return landPx ? landCellOf(idG) : -1;
  };
  const provAt = (x: number, y: number, wx: number, wy: number) => {
    const g = landAt(x, y);
    if (g < 0) return -1;
    return provCell(seamCell(idAt(wx, wy), x, y), x, y, g > 0);
  };
  const groupOf = (c: number) => (c < 0 ? -1e9 : group[2 * c]);
  const cPair = (c: number): [number, number] => (c < 0 ? [-1e9, -1e9] : [country[2 * c], country[2 * c + 1]]);
  const countryEdge = (a: number, b: number) => a >= 0 && b >= 0 && a !== b && a >= 65535.5 === b >= 65535.5;
  const DIRS: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  // 一个像素（没扭曲的位置 x, y）：照算的三样结果、会不会跳过
  const pixel = (x: number, y: number) => {
    const [ox, oy] = sphere ? warpOffset3(x - 2 * Math.floor(x / 2), y, s) : warpOffset(x, y, s);
    const wx = x + ox;
    const wy = sphere ? Math.min(1, Math.max(0, y + oy)) : y + oy;
    const id = idAt(wx, wy);
    const g = landAt(x, y);
    const pc = g < 0 ? -1 : provCell(seamCell(id, x, y), x, y, g > 0);
    if (pc < 0) return null;
    // 跳过的条件（与着色器的 nearSkip 相同）
    const H = pc === id ? [near[4 * id], near[4 * id + 1], near[4 * id + 2]] : [0, 0, 0];
    const rA = Math.hypot(ox, oy) + 0.6 * s + 2 * 0.71 * p;
    const rW = rA + 0.6 * s;
    const skip = (h: number, rPx: number) => (h & 15) > 0 && rA + rPx * p < rho[Math.min(h & 15, NEAR_MAX)] && rW + rPx * p < rho[Math.min(h >> 4, NEAR_MAX)];
    // 省界
    const g0 = groupOf(pc);
    let prov = false;
    for (const [ux, uy] of [
      [1.5, 0],
      [0, 1.5],
    ]) {
      const gx = groupOf(provAt(x + ux * p, y + uy * p, wx + ux * p, wy + uy * p));
      if (gx > -1e8 && gx !== g0 && gx > 0 === g0 > 0) prov = true;
    }
    // 国界（近处一圈与外面一圈，照第三十八轮的写法全取）
    const [c0, b0] = cPair(pc);
    let kIn = 0;
    let kOut = 0;
    if (c0 >= 0) {
      for (let t = 0; t < 8; t++) {
        const r = t < 4 ? 1.5 : 3;
        const [dx, dy] = DIRS[t % 4];
        const pn = cPair(provAt(x + dx * r * p, y + dy * r * p, wx + dx * r * p, wy + dy * r * p));
        if (countryEdge(c0, pn[0])) {
          const fed = b0 >= FEDERATION_GROUP - 0.5 && pn[1] === b0;
          if (t < 4) kIn = Math.max(kIn, fed ? 0.4 : 1);
          else if (!fed) kOut = 1;
        }
      }
    }
    const k = Math.max(kIn * 0.82, kOut * 0.3 * (countryAlpha >= 0.999 ? 1 : 0)) * countryAlpha;
    // 帝国的外沿
    let rim = false;
    const empire = b0 >= 0.5 && b0 < FEDERATION_GROUP - 0.5;
    if (empire) {
      let far = false;
      let nearHit = false;
      for (let t = 0; t < 8; t++) {
        const r = t < 4 ? 3.5 : 5;
        const [dx, dy] = DIRS[t % 4];
        const bn = cPair(provAt(x + dx * r * p, y + dy * r * p, wx + dx * r * p, wy + dy * r * p))[1];
        if (bn >= 0 && bn !== b0) {
          if (t < 4) nearHit = true;
          else far = true;
        }
      }
      rim = far && !nearHit;
    }
    return {
      prov,
      k,
      rim,
      empire,
      claimed: c0 >= 0,
      skipProv: skip(H[0], 1.5),
      skipCountry: c0 >= 0 && skip(H[1], countryAlpha >= 0.999 ? 3 : 1.5),
      skipRim: empire && skip(H[2], 5),
    };
  };
  return {
    setPx(v: number) {
      p = v;
    },
    pixel,
  };
}

describe('第三十九轮：离边界远的格', () => {
  it('ρ 与图：ρ 不减，ρ_0 = −1、ρ_1 = ρ_2 = 0；隔三步以上的格离得开；星球的图含显示用三角网里挨着的格；两极的格总不稳', () => {
    for (const [, build] of WORLDS) {
      const { mesh } = build();
      const rho = nearRho(mesh);
      expect(rho.length).toBe(NEAR_MAX + 1);
      expect(rho[0]).toBe(-1);
      expect(rho[1]).toBe(0);
      for (let h = 2; h <= NEAR_MAX; h++) expect(rho[h]).toBeGreaterThanOrEqual(rho[h - 1]);
      expect(rho[3] / mesh.spacing).toBeGreaterThan(0.2);
      expect(rho[6] / mesh.spacing).toBeGreaterThan(1.5);
      const G = nearGraph(mesh);
      expect(G.adj.length).toBeGreaterThanOrEqual(mesh.adj.length);
      if (mesh.kind === 'sphere') {
        const f = nearFixed(mesh);
        expect(f[mesh.north]).toBe(1);
        expect(f[mesh.south]).toBe(1);
      }
    }
  });

  it('每格的 H：国界两边的格 ≤ 1，同值的邻格至多差 1；海不挡国界的 H；没有分组、国界时那一个通道是 0', () => {
    const w = WORLDS[0][1]();
    const L = layersOf(w, { mode: 'country', season: 'annual', focusSpecies: null, borders: true, countryBorders: true });
    const near = L.near!;
    const cg = L.countryGroup!;
    const { mesh } = w;
    const G = nearGraph(mesh);
    let interior = 0;
    let coastal = 0;
    for (let i = 0; i < mesh.n; i++) {
      for (let e = G.off[i]; e < G.off[i + 1]; e++) {
        const j = G.adj[e];
        if (cg[2 * i] === cg[2 * j]) expect(Math.abs((near[4 * i + 1] & 15) - (near[4 * j + 1] & 15))).toBeLessThanOrEqual(1);
        // 两个国家（同是陆地）挨着：都离危险的格一步以内
        if (cg[2 * i] >= 0 && cg[2 * j] >= 0 && cg[2 * i] !== cg[2 * j] && cg[2 * i] < 65535.5 && cg[2 * j] < 65535.5) expect(near[4 * i + 1] & 15).toBeLessThanOrEqual(1);
        // 国家的海岸（挨着领海、不归谁的海）不算危险
        if (w.causes.land[i] && cg[2 * i] > 0 && (cg[2 * j] < 0 || cg[2 * j] >= 65535.5) && (near[4 * i + 1] & 15) >= 4) coastal++;
      }
      if ((near[4 * i + 1] & 15) >= 6) interior++;
    }
    expect(interior).toBeGreaterThan(mesh.n * 0.1);
    expect(coastal).toBeGreaterThan(0);
    const only = nearLayer(mesh, L.group, null, L.coast, L.landCell);
    for (let i = 0; i < mesh.n; i++) expect(only[4 * i + 1] + only[4 * i + 2]).toBe(0);
  });

  for (const [label, build] of WORLDS) {
    it(`${label}：会跳过的像素照算也画不出省界、国界、帝国的外沿（各种缩放；国界显眼与淡的两种）`, () => {
      const w = build();
      const cut = seamAt(w);
      const { mesh } = w;
      const s = mesh.spacing;
      const empires = blocList(w.small).filter((b) => b.kind === 'empire').length;
      const n = { all: 0, prov: 0, country: 0, rim: 0, skipProv: 0, skipCountry: 0, skipRim: 0, claimed: 0, empire: 0 };
      const bad: string[] = [];
      const maxH = { prov: 0 };
      // 镜头：切线那里、国界上的一格、一个国家里面的一格、领海上
      const c = w.derived.country!;
      const border = [...Array(mesh.n).keys()].find((i) => w.causes.land[i] && c[i] && [...mesh.adj.subarray(mesh.off[i], mesh.off[i + 1])].some((j) => w.causes.land[j] && c[j] && c[j] !== c[i]))!;
      const claim = [...Array(mesh.n).keys()].find((i) => !w.causes.land[i] && c[i] > 0)!;
      for (const [mode, alpha] of [
        ['country', 1],
        ['culture', 0.4],
      ] as [ViewMode, number][]) {
        const rules = shaderRules(w, mode, alpha);
        const L = layersOf(w, { mode, season: 'annual', focusSpecies: null, borders: true, countryBorders: true });
        // 离国界最远的一格
        let deep = 0;
        for (let i = 0; i < mesh.n; i++) if (w.causes.land[i] && c[i] > 0 && (L.near![4 * i + 1] & 15) > (L.near![4 * deep + 1] & 15)) deep = i;
        // 离省界最远的一格（多半在大的海省里）、帝国里离集团的边最远的一格
        let deepP = 0;
        let deepB = -1;
        for (let i = 0; i < mesh.n; i++) {
          if ((L.near![4 * i] & 15) > (L.near![4 * deepP] & 15)) deepP = i;
          const b = L.countryGroup![2 * i + 1];
          if (b >= 0.5 && b < FEDERATION_GROUP - 0.5 && (deepB < 0 || (L.near![4 * i + 2] & 15) > (L.near![4 * deepB + 2] & 15))) deepB = i;
        }
        maxH.prov = Math.max(maxH.prov, L.near![4 * deepP] & 15);
        const at = (i: number): [number, number] => [mesh.x[i], mesh.y[i]];
        const spots: [number, number][] = [cut, at(border), at(deep), at(claim), at(deepP), ...(deepB >= 0 ? [at(deepB)] : [])];
        for (const cellPx of [4, 8, 16, 40]) {
          const p = s / cellPx;
          rules.setPx(p);
          const N = cellPx >= 16 ? 28 : 22;
          for (const [sx, sy] of spots) {
            for (let j = 0; j < N; j++) {
              for (let i = 0; i < N; i++) {
                // 隔几个像素取一个（盖住几格宽的一片），带一点不整的偏移
                const step = Math.max(1, Math.round(cellPx / 6));
                const x = sx + (i - N / 2) * step * p + 0.37 * p;
                const y = sy + (j - N / 2) * step * p + 0.61 * p;
                if (mesh.kind !== 'sphere' && (x < 0 || y < 0 || x > mesh.width || y > mesh.height)) continue;
                if (y < 0 || y > mesh.height) continue;
                const r = rules.pixel(x, y);
                if (!r) continue;
                n.all++;
                if (r.prov) n.prov++;
                if (r.k > 0) n.country++;
                if (r.rim) n.rim++;
                if (r.claimed) n.claimed++;
                if (r.empire) n.empire++;
                if (r.skipProv) {
                  n.skipProv++;
                  if (r.prov) bad.push(`${mode} ${cellPx} (${x.toFixed(4)}, ${y.toFixed(4)}) 跳过了省界`);
                }
                if (r.skipCountry) {
                  n.skipCountry++;
                  if (r.k > 0) bad.push(`${mode} ${cellPx} (${x.toFixed(4)}, ${y.toFixed(4)}) 跳过了国界`);
                }
                if (r.skipRim) {
                  n.skipRim++;
                  if (r.rim) bad.push(`${mode} ${cellPx} (${x.toFixed(4)}, ${y.toFixed(4)}) 跳过了帝国的外沿`);
                }
              }
            }
          }
        }
      }
      if (process.env.NEAR_STATS) console.log(label, JSON.stringify(n), JSON.stringify(maxH));
      expect(bad.slice(0, 5)).toEqual([]);
      // 不是空对照：画得出线的像素、跳过的像素都不少
      expect(n.prov).toBeGreaterThan(20);
      expect(n.country).toBeGreaterThan(20);
      expect(n.skipCountry).toBeGreaterThan(n.claimed * 0.02);
      // 陆上的省小（几十格），省界多半只在大的海省里跳过
      if (maxH.prov >= 6) expect(n.skipProv).toBeGreaterThan(0);
      if (empires) {
        expect(n.empire).toBeGreaterThan(0);
        expect(n.skipRim).toBeGreaterThan(0);
      }
    }, 120_000);
  }
});
