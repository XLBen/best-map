import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { findCell } from './mesh';
import { DEFAULT_PACK, type WordPack, generateName } from './names';

// 人工构造的地图：一块带半岛和海湾的大陆，东边两个岛之间隔着一道窄海峡
function handmade() {
  const eng = new Engine({ cells: 12000, seed: 2, latNorth: 50, latSouth: 30 });
  const { mesh } = eng.world;
  const inside = (x: number, y: number) => {
    const main = x > 0.3 && x < 1.0 && y > 0.25 && y < 0.75 && !(x > 0.8 && y > 0.42 && y < 0.58);
    const peninsula = x > 0.08 && x <= 0.3 && y > 0.475 && y < 0.525;
    const islandA = x > 1.3 && x < 1.55 && y > 0.3 && y < 0.7;
    const islandB = x > 1.595 && x < 1.85 && y > 0.3 && y < 0.7;
    return main || peninsula || islandA || islandB;
  };
  const cells: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (inside(mesh.x[i], mesh.y[i])) cells.push(i);
  eng.exec({ op: 'set_coast_style', roughness: 0.2 });
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  return eng;
}

const near = (eng: Engine, type: string, x: number, y: number) => {
  const { mesh, derived } = eng.world;
  const c = findCell(mesh, x, y);
  return derived.features.find((f) => f.type === type && f.cells.includes(c));
};

describe('地理要素识别', () => {
  const eng = handmade();

  it('识别出半岛、海湾、海峡、大陆或岛', () => {
    expect(near(eng, 'peninsula', 0.18, 0.5)).toBeDefined();
    expect(near(eng, 'bay', 0.92, 0.5)).toBeDefined();
    expect(near(eng, 'strait', 1.572, 0.5)).toBeDefined();
    expect(near(eng, 'island', 1.42, 0.5)).toBeDefined();
  });

  it('每个要素都有名字，且同一张图重算名字不变', () => {
    const names = eng.world.derived.features.map((f) => `${f.key}=${f.name}`);
    expect(eng.world.derived.features.every((f) => f.name.length > 0)).toBe(true);
    const again = handmade();
    expect(again.world.derived.features.map((f) => `${f.key}=${f.name}`)).toEqual(names);
  });
});

describe('改名与文字包', () => {
  it('改过的名字在之后的地形编辑后保留', () => {
    const eng = handmade();
    const island = near(eng, 'island', 1.42, 0.5)!;
    eng.exec({ op: 'rename_feature', key: island.key, name: '我的岛' });
    expect(near(eng, 'island', 1.42, 0.5)!.name).toBe('我的岛');
    // 在别处放一个岛，地物整体重算
    eng.exec({ op: 'add_island', island: { x: 0.6, y: 0.1, kind: 'volcanic', size: 'small', variant: 0 } });
    expect(near(eng, 'island', 1.42, 0.5)!.name).toBe('我的岛');
    // 恢复自动命名
    eng.exec({ op: 'rename_feature', key: island.key, name: '' });
    expect(near(eng, 'island', 1.42, 0.5)!.name).not.toBe('我的岛');
  });

  it('重抽换一个名字；撤销回到原来的名字', () => {
    const eng = handmade();
    const f = near(eng, 'bay', 0.92, 0.5)!;
    const before = f.name;
    eng.exec({ op: 'reroll_feature', key: f.key });
    const after = near(eng, 'bay', 0.92, 0.5)!.name;
    expect(after).not.toBe(before);
    eng.undo();
    expect(near(eng, 'bay', 0.92, 0.5)!.name).toBe(before);
  });

  it('自定义文字包：名字用包里的词；模板引用不存在的词表时拒绝', () => {
    const eng = handmade();
    const pack: WordPack = {
      id: 'test',
      name: '测试包',
      lists: { a: ['甲'], b: ['乙'] },
      types: Object.fromEntries(Object.keys(DEFAULT_PACK.types).map((t) => [t, { patterns: [{ p: '{a}{b}' }] }])),
    };
    eng.exec({ op: 'set_word_pack', pack });
    expect(eng.world.derived.features.some((f) => f.name.startsWith('甲乙'))).toBe(true);
    const bad = { ...pack, types: { island: { patterns: [{ p: '{没有}岛' }] } } };
    expect(() => eng.exec({ op: 'set_word_pack', pack: bad })).toThrow(/不存在的词表/);
  });

  it('情境标签：寒冷的岛优先用寒冷的字', () => {
    let cold = 0;
    for (let s = 0; s < 60; s++) {
      const name = generateName(DEFAULT_PACK, 'island', ['cold'], s);
      if (DEFAULT_PACK.lists.cold.some((c) => name.includes(c))) cold++;
    }
    expect(cold).toBeGreaterThan(25);
  });
});
