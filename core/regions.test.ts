import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { featuresCsv } from './export';
import { guessRegionKind } from './features';
import { findCell } from './mesh';
import { ringCells } from './select';

// 第五轮：用户自己圈的地名区块、放的点状地名

function continents(cells = 12000) {
  const eng = new Engine({ cells, seed: 1, latNorth: 72, latSouth: 20 });
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  return eng;
}

// 以 (cx, cy) 为中心、半轴 rx × ry 的椭圆圈
const ellipse = (cx: number, cy: number, rx: number, ry: number): [number, number][] =>
  Array.from({ length: 48 }, (_, k) => [cx + rx * Math.cos((k / 48) * Math.PI * 2), cy + ry * Math.sin((k / 48) * Math.PI * 2)]);

const regionFeature = (eng: Engine) => eng.world.derived.features.filter((f) => f.region);

describe('圈一块起名', () => {
  it('圈里的格成为一个区块：自动起名、标注在区块里、出现在地名表里；撤销后消失', () => {
    const eng = continents();
    const w = eng.world;
    const before = w.derived.features.map((f) => f.key);
    const cells = ringCells(w, ellipse(0.9, 0.5, 0.12, 0.1));
    expect(cells.length).toBeGreaterThan(50);
    const kind = guessRegionKind(w, w.derived, cells);
    eng.exec({ op: 'add_region', region: { kind, cells } });
    expect(eng.history[eng.history.length - 1].summary).toMatch(/^圈了一块/);
    const [f] = regionFeature(eng);
    expect(f.name.length).toBeGreaterThan(0);
    expect(f.custom).toBe(false);
    // 标注位置在区块里
    expect(cells).toContain(findCell(w.mesh, f.x, f.y));
    // 自动识别的地物不受影响
    expect(w.derived.features.filter((x) => !x.region).map((x) => x.key)).toEqual(before);
    expect(featuresCsv(w, 2000, 1000)).toContain(`,${f.name},`);
    eng.undo();
    expect(regionFeature(eng)).toEqual([]);
    expect(w.small.regions).toEqual([]);
  });

  it('改名、改类型、换一个、恢复自动：每一步都能撤销；结果和存档重放（完整重算）一致', () => {
    const eng = continents();
    const w = eng.world;
    const cells = ringCells(w, ellipse(0.9, 0.5, 0.12, 0.1));
    eng.exec({ op: 'add_region', region: { kind: 'region', cells } });
    const id = w.small.regions[0].id;
    const auto = regionFeature(eng)[0].name;
    eng.exec({ op: 'update_region', id, name: '  北境 ' });
    expect(regionFeature(eng)[0].name).toBe('北境');
    expect(regionFeature(eng)[0].custom).toBe(true);
    eng.exec({ op: 'update_region', id, name: '' });
    expect(regionFeature(eng)[0].name).toBe(auto);
    expect(regionFeature(eng)[0].custom).toBe(false);
    eng.exec({ op: 'update_region', id, kind: 'plain' });
    expect(regionFeature(eng)[0].type).toBe('plain');
    expect(eng.history[eng.history.length - 1].summary).toBe('改成平原');
    const plainName = regionFeature(eng)[0].name;
    eng.exec({ op: 'update_region', id, reroll: true });
    expect(regionFeature(eng)[0].name).not.toBe(plainName);
    // 只改名字走的是快速路径，结果要和从头重放一模一样
    const replay = Engine.fromDoc(eng.toDoc(), w.mesh);
    const sig = (e: Engine) => e.world.derived.features.map((f) => `${f.key}|${f.type}|${f.name}|${f.custom}|${f.x}|${f.y}|${f.angle}`);
    expect(sig(eng)).toEqual(sig(replay));
    eng.undo();
    expect(regionFeature(eng)[0].name).toBe(plainName);
    eng.undo();
    expect(regionFeature(eng)[0].type).toBe('region');
    expect(regionFeature(eng)[0].name).toBe(auto);
  });

  it('删除区块可以撤销；点状地名标在点的位置', () => {
    const eng = continents();
    const w = eng.world;
    const c = findCell(w.mesh, 0.7, 0.4);
    eng.exec({ op: 'add_region', region: { kind: 'spot', cells: [c], at: [0.7, 0.4], name: '白鹭渡' } });
    expect(eng.history[eng.history.length - 1].summary).toBe('放了一个地名“白鹭渡”');
    const spot = regionFeature(eng)[0];
    expect([spot.x, spot.y, spot.type, spot.name]).toEqual([0.7, 0.4, 'spot', '白鹭渡']);
    eng.exec({ op: 'remove_region', id: w.small.regions[0].id });
    expect(regionFeature(eng)).toEqual([]);
    eng.undo();
    expect(regionFeature(eng)[0].name).toBe('白鹭渡');
    expect(() => eng.exec({ op: 'update_region', id: w.small.regions[0].id, kind: 'plain' })).toThrow('点状地名和区块不能互换');
  });

  it('狭长的区块沿主轴写，圆的横着写', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'add_region', region: { kind: 'region', cells: ringCells(w, ellipse(1.0, 0.5, 0.3, 0.04)) } });
    eng.exec({ op: 'add_region', region: { kind: 'region', cells: ringCells(w, ellipse(0.4, 0.5, 0.1, 0.1)) } });
    const [long, round] = regionFeature(eng);
    expect(Math.abs(long.angle)).toBeLessThan(0.2);
    expect(long.span).toBeGreaterThan(0.4);
    expect(round.angle).toBe(0);
    // 斜着的长条：角度跟着主轴
    eng.exec({
      op: 'add_region',
      region: { kind: 'region', cells: ringCells(w, ellipse(1.0, 0.5, 0.3, 0.04).map(([x, y]) => [1.0 + (x - 1.0) * 0.8 - (y - 0.5) * 0.6, 0.5 + (x - 1.0) * 0.6 + (y - 0.5) * 0.8])) },
    });
    expect(regionFeature(eng)[2].angle).toBeCloseTo(Math.atan2(0.6, 0.8), 1);
  });

  it('按地形猜类型：全在海上是海域', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    let sea = -1;
    for (let i = 0; i < w.mesh.n && sea < 0; i++) if (!w.causes.land[i] && d.elevation[i] < -2000) sea = i;
    const cells = ringCells(w, ellipse(w.mesh.x[sea], w.mesh.y[sea], 0.03, 0.03)).filter((c) => !w.causes.land[c]);
    expect(guessRegionKind(w, d, cells)).toBe('sea');
  });
});
