import { describe, expect, it } from 'vitest';
import { colorSignature, provinceFlat } from '../src/render/colors';
import { lakeArea } from './elevation';
import { Engine } from './engine';
import { graphDistance } from './mesh';
import { classOfKind, lakeCells } from './provinces';
import { provinceCells } from './select';
import { continents } from './testing/fixtures';
import { SEA_HUES, type World, seaProvinceDefaultColor } from './world';

// 第十二轮：湖单独成省 / 并进旁边的陆地省；放湖、删湖之后省份跟着整理；海省默认不着色、省份可选颜色

// 内陆、离图边也远的一块低地
function inlandLow(w: World): number {
  const { mesh, causes } = w;
  const all = [...Array(mesh.n).keys()];
  const far = graphDistance(mesh, all.filter((i) => !causes.land[i]), Infinity);
  const edge = graphDistance(mesh, all.filter((i) => mesh.boundary[i]), Infinity);
  let best = -1;
  for (const i of all) {
    if (!causes.land[i] || far[i] < mesh.spacing * 6 || edge[i] < mesh.spacing * 6) continue;
    if (best < 0 || w.derived.elevation[i] < w.derived.elevation[best]) best = i;
  }
  return best;
}

// 省份的三类不混：海省只有海格；湖单独成省时湖面的格都在湖省里，湖省里只有湖面
function checkClasses(w: World, separate: boolean) {
  const { causes, small } = w;
  const lake = lakeCells(w, w.derived);
  for (let i = 0; i < w.mesh.n; i++) {
    const p = causes.province[i];
    expect(p, `格 ${i} 没有省份`).toBeGreaterThanOrEqual(0);
    const meta = small.provinces[p];
    expect(meta.land).toBe(causes.land[i] === 1);
    if (!causes.land[i]) {
      expect(meta.kind).toBe('sea');
      continue;
    }
    if (separate) expect(classOfKind(meta.kind), `格 ${i}`).toBe(lake[i] ? 'lake' : 'land');
    else expect(meta.kind).not.toBe('lake');
  }
}

const provincesOf = (w: World) => JSON.stringify({ p: Array.from(w.causes.province), m: w.small.provinces, next: w.small.nextProvince });

describe('湖与省份', () => {
  it('放湖、删湖之后省份跟着整理；撤销、重做、重放都一样', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    checkClasses(w, true);
    const cell = inlandLow(w);
    const radius = w.mesh.spacing * w.kmPerUnit * 3;
    const before = provincesOf(w);
    eng.exec({ op: 'add_lake', lake: { cell, radius, depth: 200, perennial: true } });
    const area = lakeArea(w, cell, radius);
    expect(area.every((i) => w.derived.lake[i] === 1)).toBe(true);
    // 湖面成了湖省，湖省里只有湖面，陆地省里没有湖面
    checkClasses(w, true);
    const lakeProv = w.causes.province[cell];
    expect(w.small.provinces[lakeProv].kind).toBe('lake');
    expect(w.small.provinces[lakeProv].name).not.toBe('');
    // 记进了命令：重放与现在逐格相同
    const doc = eng.toDoc();
    expect(doc.commands[doc.commands.length - 1].provinceFix).toBeTruthy();
    const after = provincesOf(w);
    const replay = Engine.fromDoc(doc, w.mesh);
    expect(provincesOf(replay.world)).toBe(after);
    // 撤销回到放湖之前；重做回到之后
    eng.undo();
    expect(provincesOf(w)).toBe(before);
    eng.redo();
    expect(provincesOf(w)).toBe(after);

    // 删湖：湖省没了，那些格并进旁边的陆地省
    const id = w.small.lakes[0].id;
    eng.exec({ op: 'remove_lake', id });
    expect(w.small.provinces[lakeProv]).toBeUndefined();
    checkClasses(w, true);
    expect(provincesOf(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toBe(provincesOf(w));
  });

  it('湖：并进旁边的陆地省 / 单独成省（只整理湖，别的省份不动）；海永远单独', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const cell = inlandLow(w);
    eng.exec({ op: 'add_lake', lake: { cell, radius: w.mesh.spacing * w.kmPerUnit * 3, depth: 200, perennial: true } });
    const lakeProvs = () => Object.values(w.small.provinces).filter((m) => m.kind === 'lake').length;
    expect(lakeProvs()).toBeGreaterThan(0);
    // 别的省：不碰湖的陆地省、海省
    const lake = lakeCells(w, w.derived);
    const untouched = new Map<number, string>();
    for (const [k, m] of Object.entries(w.small.provinces)) {
      const id = Number(k);
      if (m.kind === 'lake') continue;
      const cells = provinceCells(w, id);
      if (cells.some((c) => lake[c])) continue;
      let nearLake = false;
      for (const c of cells) for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (lake[w.mesh.adj[e]]) nearLake = true;
      if (!nearLake) untouched.set(id, cells.join(','));
    }
    eng.exec({ op: 'set_lake_mode', mode: 'merge' });
    expect(w.small.provinceRules.lakeMode).toBe('merge');
    expect(lakeProvs()).toBe(0);
    checkClasses(w, false);
    for (const [id, cells] of untouched) expect(provinceCells(w, id).join(','), `省 ${id}`).toBe(cells);
    // 并进陆地省之后再放湖、改地形：湖照样在陆地省里
    eng.exec({ op: 'set_lake_mode', mode: 'separate' });
    expect(lakeProvs()).toBeGreaterThan(0);
    checkClasses(w, true);
    for (const [id, cells] of untouched) expect(provinceCells(w, id).join(','), `省 ${id}`).toBe(cells);
    // 按规则重新划分：并进陆地省时没有湖省
    eng.exec({ op: 'generate_provinces', rules: { lakeMode: 'merge' } });
    expect(lakeProvs()).toBe(0);
    checkClasses(w, false);
    // 整张图重放：与现在相同
    expect(provincesOf(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toBe(provincesOf(w));
  });

  it('湖省与陆地省不能合并、不能互相划格；海与陆地也不行', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const cell = inlandLow(w);
    eng.exec({ op: 'add_lake', lake: { cell, radius: w.mesh.spacing * w.kmPerUnit * 3, depth: 200, perennial: true } });
    const lakeProv = w.causes.province[cell];
    expect(w.small.provinces[lakeProv].kind).toBe('lake');
    // 挨着湖的陆地省
    let landProv = -1;
    let landCell = -1;
    for (const c of provinceCells(w, lakeProv)) {
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
        const j = w.mesh.adj[e];
        const p = w.causes.province[j];
        if (p !== lakeProv && w.small.provinces[p]?.kind === 'land') {
          landProv = p;
          landCell = j;
        }
      }
    }
    expect(landProv).toBeGreaterThanOrEqual(0);
    expect(() => eng.exec({ op: 'merge_province', from: lakeProv, into: landProv })).toThrow(/湖省与陆地省份不能合并/);
    expect(() => eng.exec({ op: 'assign_province', cells: [cell], province: landProv })).toThrow(/湖面/);
    expect(() => eng.exec({ op: 'assign_province', cells: [landCell], province: lakeProv })).toThrow(/不是湖面/);
    const sea = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i])!;
    expect(() => eng.exec({ op: 'merge_province', from: w.causes.province[sea], into: landProv })).toThrow(/陆地省份与海域省份不能合并/);
  });
});

describe('省份的颜色', () => {
  it('海上的省份默认不着色；自己选了颜色才涂，恢复自动又不着色', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    const sea = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i])!;
    const land = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && w.derived.lake[i] !== 1)!;
    const seaProv = w.causes.province[sea];
    const landProv = w.causes.province[land];
    let flat = provinceFlat(w, w.causes.province);
    expect(flat[sea * 4 + 3]).toBe(0);
    expect(flat[land * 4 + 3]).toBeGreaterThan(0);
    const sig0 = colorSignature(w.small);
    eng.exec({ op: 'set_province', id: seaProv, color: '#3366CC' });
    expect(w.small.provinces[seaProv].color).toBe('#3366cc');
    expect(colorSignature(w.small)).not.toBe(sig0);
    flat = provinceFlat(w, w.causes.province);
    expect(Array.from(flat.subarray(sea * 4, sea * 4 + 4))).toEqual([0x33, 0x66, 0xcc, 120]);
    // 陆地省选颜色
    eng.exec({ op: 'set_province', id: landProv, color: '#ff0000' });
    flat = provinceFlat(w, w.causes.province);
    expect(Array.from(flat.subarray(land * 4, land * 4 + 3))).toEqual([255, 0, 0]);
    // 恢复自动
    eng.exec({ op: 'set_province', id: seaProv, color: null });
    expect(w.small.provinces[seaProv].color).toBeUndefined();
    expect(provinceFlat(w, w.causes.province)[sea * 4 + 3]).toBe(0);
    expect(() => eng.exec({ op: 'set_province', id: seaProv, color: 'red' })).toThrow();
  });

  it('海省“自己选”先给的颜色：跳过海的蓝色一段、与海色差得远，同一编号总是同一个颜色', () => {
    const hueOf = ([r, g, b]: number[]) => {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const d = mx - mn;
      if (d === 0) return 0;
      const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    // 写实（深蓝）与地图册（浅蓝灰的几层）的海色、原来给的 #4a7fb5
    const seas = [
      [0x4a, 0x7f, 0xb5],
      [204, 224, 227],
      [150, 181, 199],
      [40, 70, 120],
      [25, 50, 90],
    ];
    const seen = new Set<string>();
    for (let id = 0; id < 2000; id++) {
      const hex = seaProvinceDefaultColor(id);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(seaProvinceDefaultColor(id)).toBe(hex);
      seen.add(hex);
      const v = parseInt(hex.slice(1), 16);
      const c = [v >> 16, (v >> 8) & 255, v & 255];
      const h = hueOf(c);
      expect(h < SEA_HUES[0] - 1 || h > SEA_HUES[1] + 1, `${id} ${hex} ${h}`).toBe(true);
      // 有颜色（不灰）
      expect(Math.max(...c) - Math.min(...c)).toBeGreaterThan(80);
      for (const s of seas) expect(Math.hypot(c[0] - s[0], c[1] - s[1], c[2] - s[2]), `${id} ${hex}`).toBeGreaterThan(90);
    }
    expect(seen.size).toBeGreaterThan(200);
  });
});
