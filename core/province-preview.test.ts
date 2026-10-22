import { describe, expect, it } from 'vitest';
import { groupPreview, provinceFlat, provinceGroups } from '../src/render/colors';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import type { Engine } from './engine';
import { scissors, seamLayers } from './seams';
import { continents } from './testing/fixtures';
import type { World } from './world';

// 第八轮第四批：省份的轻预览（Engine.previewProvinces）。重划、对半分开、合并、剪刀、按新规则重新划分之前，
// 地图上先画出确切的新省界和省名：预览就是执行的结果，活的世界、历史都不变

type Pt = [number, number];

// 每个省的格
function cellsByProvince(w: World): Map<number, number[]> {
  const m = new Map<number, number[]>();
  w.causes.province.forEach((p, i) => {
    if (p < 0) return;
    let l = m.get(p);
    if (!l) m.set(p, (l = []));
    l.push(i);
  });
  return m;
}

// 大一点的陆地省（按格数从大到小）
function bigLand(w: World): number[] {
  return [...cellsByProvince(w)]
    .filter(([p, cells]) => w.small.provinces[p]?.land && !w.small.provinces[p].locked && cells.length >= 30)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([p]) => p);
}

// 两个相邻的陆地省
function neighbours(w: World): [number, number] {
  const { mesh, causes } = w;
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || causes.province[i] < 0) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (causes.land[j] && causes.province[j] >= 0 && causes.province[j] !== causes.province[i]) return [causes.province[i], causes.province[j]];
    }
  }
  throw new Error('没有相邻的省');
}

// 横穿省 p 中间的一刀（剪刀把两端延长到省界）：切得开时返回命令里的线
function cutThrough(w: World, p: number): Pt[] | null {
  const { mesh } = w;
  const cells = cellsByProvince(w).get(p)!;
  let cx = 0;
  let cy = 0;
  for (const c of cells) {
    cx += mesh.x[c];
    cy += mesh.y[c];
  }
  cx /= cells.length;
  cy /= cells.length;
  const s = mesh.spacing;
  const r = scissors(w, [
    [cx - 2 * s, cy + 0.2 * s],
    [cx + 2 * s, cy - 0.1 * s],
  ]);
  return r.cut.plans.length === 1 && r.cut.plans[0].id === p ? r.line : null;
}

// 预览之后执行同一条命令：省份数组、各省（含新起的名字）、切线、历史里的一句话都与预览相同，预览时活的世界不变。
// 交给着色器的省界分组、省份着色（groupPreview 拿整份将来的省份数组）也与执行后的相同
function check(eng: Engine, cmd: Command) {
  const before = digestWorld(eng.world);
  const steps = eng.history.length;
  const p = eng.previewProvinces(cmd);
  const shown = groupPreview(eng.world, { cells: [], ids: [], province: p.province, seamList: p.seams, metas: p.provinces }, 'provinces');
  expect(digestWorld(eng.world)).toEqual(before);
  expect(eng.history.length).toBe(steps);
  expect(p.changed).toBe(true);
  const summary = eng.exec(cmd);
  const w = eng.world;
  expect(Array.from(p.province)).toEqual(Array.from(w.causes.province));
  expect(p.provinces).toEqual(w.small.provinces);
  expect(p.seams).toEqual(w.small.provinceSeams ?? null);
  expect(p.summary).toBe(summary);
  expect(eng.history.length).toBe(steps + 1);
  expect(Array.from(shown.group)).toEqual(Array.from(provinceGroups(w, w.causes.province, seamLayers(w, w.causes.province, w.small.provinceSeams))));
  expect(Array.from(shown.flat!)).toEqual(Array.from(provinceFlat(w, w.causes.province)));
  return p;
}

describe('省份预览 = 执行的结果', () => {
  it('重划：涂满一个省，新的省界与省名都相同', () => {
    const eng = continents({ provinces: true });
    const [p] = bigLand(eng.world);
    const cells = cellsByProvince(eng.world).get(p)!;
    const old = new Set(Object.keys(eng.world.small.provinces));
    const r = check(eng, { op: 'regenerate_provinces', cells });
    // 新省有名字（与执行时起的相同）
    const fresh = Object.keys(r.provinces).filter((id) => !old.has(id));
    expect(fresh.length).toBeGreaterThan(0);
    for (const id of fresh) expect(r.provinces[Number(id)].name).not.toBe('');
  });

  it('对半分开', () => {
    const eng = continents({ provinces: true });
    const [p] = bigLand(eng.world);
    const r = check(eng, { op: 'split_province', id: p });
    expect(r.provinces[eng.world.small.nextProvince - 1].name).not.toBe('');
  });

  it('合并', () => {
    const eng = continents({ provinces: true });
    const [into, from] = neighbours(eng.world);
    check(eng, { op: 'merge_province', from, into });
  });

  it('剪刀：一次切两刀（batch），切线也相同', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const lines: Pt[][] = [];
    for (const p of bigLand(w)) {
      const line = cutThrough(w, p);
      // 两刀离得远一点：第二刀不碰第一刀切的省
      if (line && (!lines.length || Math.hypot(line[0][0] - lines[0][0][0], line[0][1] - lines[0][0][1]) > 12 * w.mesh.spacing)) lines.push(line);
      if (lines.length === 2) break;
    }
    expect(lines).toHaveLength(2);
    const r = check(eng, { op: 'batch', label: '切两刀', commands: lines.map((line) => ({ op: 'cut_province' as const, line })) });
    expect(r.seams?.length).toBe(2);
  });

  it('按新规则重新划分（换一种划分）', () => {
    const eng = continents({ provinces: true });
    check(eng, { op: 'generate_provinces', rules: { size: 'small', varied: false, seed: 11 } });
    check(eng, { op: 'generate_provinces', rules: { seed: 12 } });
  });

  it('改名、锁定也能预览；不是省份的命令、做不成的命令报错，世界不变', () => {
    const eng = continents({ provinces: true });
    const [into, from] = neighbours(eng.world);
    check(eng, { op: 'set_province', id: into, locked: true });
    const before = digestWorld(eng.world);
    expect(() => eng.previewProvinces({ op: 'merge_province', from, into })).toThrow();
    expect(() => eng.previewProvinces({ op: 'paint_land', cells: [0], t: [0], mode: 'land' })).toThrow('不是省份的改动');
    expect(() => eng.previewProvinces({ op: 'batch', commands: [{ op: 'split_province', id: from }, { op: 'set_planet', patch: { solar: 1 } }] })).toThrow('不是省份的改动');
    expect(digestWorld(eng.world)).toEqual(before);
  });
});
