import { describe, expect, it } from 'vitest';
import type { Command } from './commands';
import { Engine } from './engine';
import { endemicSpecies } from './endemic';
import { encodePath } from './rivers';
import { planCourse, riverStem } from './select';

// 撤销只从被撤掉的那一步影响到的那一层重算（改名不重算高程、气候）：
// 每撤一步，推导都要与把剩下的命令从头重放、完整重算的结果逐值一致

function fingerprint(e: Engine): string {
  const d = e.world.derived;
  let h = 0x811c9dc5;
  const mix = (a: ArrayLike<number>) => {
    for (let i = 0; i < a.length; i++) h = Math.imul(h ^ Math.round(a[i] * 1000), 0x01000193);
  };
  for (const a of [d.elevation, d.tMean, d.precip, d.moisture, d.discharge, d.lake, d.dominant, d.share, d.corrT, e.world.causes.province]) mix(a);
  const names = d.features.map((f) => `${f.key}=${f.name}${f.custom ? '*' : ''}@${f.x.toFixed(6)},${f.y.toFixed(6)}`).join('|');
  return `${(h >>> 0).toString(16)}|${d.conflicts.length}|${names}`;
}

describe('撤销从受影响的那一层重算', () => {
  it('各种命令逐个撤销：每一步都与从头重放的结果一致', () => {
    const eng = new Engine({ cells: 8000, seed: 3, latNorth: 70, latSouth: 10 });
    eng.exec({ op: 'set_worldgen', params: { seed: 9, type: 'continents', landFraction: 0.4 }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 2 } });
    const w = eng.world;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]);
    const patch = land.filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[land[400]], w.mesh.y[i] - w.mesh.y[land[400]]) < 0.08);
    const island = w.derived.features.find((f) => f.type === 'island' && f.cells.length > 20) ?? w.derived.features.find((f) => f.type === 'continent')!;
    const endemic = endemicSpecies(w, Array.from(island.cells), 'endemic-1', island.name)!;
    const steps = [
      // 气候（Climate）
      { op: 'paint', field: 'tempOffset', cells: patch, value: -3, mode: 'add' },
      // 求解（Solve）：新生态、涂一片生态
      { op: 'add_species', species: endemic },
      { op: 'add_constraint', constraint: { cells: patch, species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 500 } },
      // 植被（Vegetation）
      { op: 'set_planet', patch: { riverThreshold: 120 } },
      // 只改名字（Names）
      { op: 'rename_feature', key: island.key, name: '试验岛' },
      { op: 'add_region', region: { kind: 'region', cells: patch } },
      // 不影响推导（None）
      { op: 'assign_province', cells: patch.slice(0, 5), province: 'new' },
      // 地形（Elevation）
      { op: 'paint_land', cells: patch, t: patch.map(() => 0.9), mode: 'sea' },
    ] as const;
    for (const s of steps) eng.exec(s as never);
    for (let k = steps.length; k > 0; k--) {
      eng.undo();
      const replay = Engine.fromDoc(eng.toDoc(), w.mesh);
      expect(fingerprint(eng), `撤销第 ${k} 步（${steps[k - 1].op}）后`).toBe(fingerprint(replay));
    }
    // 重做也一样
    eng.redo();
    eng.redo();
    expect(fingerprint(eng)).toBe(fingerprint(Engine.fromDoc(eng.toDoc(), w.mesh)));
  });

  it('画的河（第八轮）：只挖河床、改大小、在终点消失、重画、旧式河道、删掉，逐个撤销都与从头重放一致', () => {
    const eng = new Engine({ cells: 8000, seed: 3, latNorth: 70, latSouth: 10 });
    eng.exec({ op: 'set_worldgen', params: { seed: 9, type: 'continents', landFraction: 0.4 }, reset: true });
    const w = eng.world;
    const { mesh } = w;
    // 从最高处往最近的海画，两头各多画一点
    let peak = -1;
    for (let i = 0; i < mesh.n; i++) if (w.causes.land[i] && (peak < 0 || w.derived.elevation[i] > w.derived.elevation[peak])) peak = i;
    let sea = -1;
    for (let i = 0; i < mesh.n; i++) {
      if (w.causes.land[i]) continue;
      if (sea < 0 || Math.hypot(mesh.x[i] - mesh.x[peak], mesh.y[i] - mesh.y[peak]) < Math.hypot(mesh.x[sea] - mesh.x[peak], mesh.y[sea] - mesh.y[peak])) sea = i;
    }
    const ux = mesh.x[sea] - mesh.x[peak];
    const uy = mesh.y[sea] - mesh.y[peak];
    const l = Math.hypot(ux, uy);
    const s = (t: number): [number, number] => [mesh.x[peak] + (ux / l) * t * mesh.spacing, mesh.y[peak] + (uy / l) * t * mesh.spacing];
    const plan = planCourse(w, w.derived, [s(-3), s(0), s(l / mesh.spacing + 1)], { endOnLand: 'flow' });
    expect(plan.blocked).toBeNull();
    const cells = plan.cells;
    const path = encodePath(plan.path);
    const stem = riverStem(w, w.derived, w.derived.features.find((f) => f.type === 'river' && !cells.some((c) => f.cells.includes(c)))!.anchor).cells;
    const steps: Command[] = [
      { op: 'add_guide', guide: { id: 'river-u', cells, path, locked: true, spring: true, flow: 3, carve: 'bed', name: '' } },
      { op: 'update_guide', id: 'river-u', patch: { flow: 6, width: 2 } },
      { op: 'update_guide', id: 'river-u', patch: { cells: cells.slice(0, -2), end: 'sink' } },
      { op: 'update_guide', id: 'river-u', patch: { name: '试验河', salt: 1 } },
      { op: 'update_guide', id: 'river-u', patch: { cells, end: null } },
      // 旧式的河道（下切山谷）与只挖河床的混在一起
      { op: 'add_guide', guide: { cells: stem, locked: true, spring: false } },
      { op: 'remove_guide', id: 'river-u' },
    ];
    for (const c of steps) eng.exec(c);
    for (let k = steps.length; k > 0; k--) {
      eng.undo();
      const replay = Engine.fromDoc(eng.toDoc(), w.mesh);
      expect(fingerprint(eng), `撤销第 ${k} 步（${steps[k - 1].op}）后`).toBe(fingerprint(replay));
    }
    for (let k = 0; k < 4; k++) eng.redo();
    expect(fingerprint(eng)).toBe(fingerprint(Engine.fromDoc(eng.toDoc(), w.mesh)));
  });

  it('只改名字的撤销不重算地形与气候', () => {
    const eng = new Engine({ cells: 8000, seed: 3, latNorth: 70, latSouth: 10 });
    eng.exec({ op: 'set_worldgen', params: { seed: 9, type: 'continents', landFraction: 0.4 }, reset: true });
    const f = eng.world.derived.features.find((x) => x.type === 'continent')!;
    eng.exec({ op: 'rename_feature', key: f.key, name: '试验洲' });
    eng.takeRecomputed();
    eng.undo();
    expect(eng.takeRecomputed()).toBe(1);
    expect(eng.world.derived.features.find((x) => x.key === f.key)!.name).not.toBe('试验洲');
  });
});
