import { describe, expect, it, vi } from 'vitest';
import { defaultFeatureLabel, featureLabel } from '../../core/features';
import { continents, engineFor } from '../../core/testing/fixtures';
import type { Conflict, World } from '../../core/world';
import { SEA_TEMP_LAKE, SEA_TEMP_LAND, cellLayers, tempRgb } from '../render/colors';
import { focusSpecies, mode, world } from '../state';
import { focusOn } from './camera';
import { ADJUSTMENTS } from './defs/adjustments';
import { VIEWS, suitabilityFocus } from './defs/layers';
import { riverEnds } from './defs/tools';
import { newWorldCommands } from './forms';
import { showView } from './panels/LayersPanel';
import { labelCommit } from './panels/names';
import { RIVER_END_HINTS } from './riverCourse';
import { locateNextUnmet, locateTitle, unmetLooked, unmetSpots } from './unmetLocate';
import { TERRAIN_SLIDERS, terrainCommands, terrainDefaults, withTerrain } from './wizardTerrain';

// 第十四轮 H1（界面）：地形挪进新建向导、河的终点叫法、类型字可以改、海水温度底图、适宜程度自己选生态、一处一处看没涂成的地方

vi.mock('./camera', () => ({ focusOn: vi.fn() }));

describe('调整整个世界不再调地形', () => {
  it('没有陆地多少、岛多少、山多高、海岸曲折、最高的山，也没有“地形”这一组', () => {
    const ids = ADJUSTMENTS.map((a) => a.id);
    for (const id of ['landFraction', 'islands', 'mountains', 'coast', 'mountainScale']) expect(ids).not.toContain(id);
    expect(ADJUSTMENTS.some((a) => a.group === '地形')).toBe(false);
    expect(ADJUSTMENTS.some((a) => a.command(continents({ cells: 3000 }).world, a.range[0]).op !== 'set_planet')).toBe(false);
  });
});

describe('新建向导的“地形”', () => {
  const region = { cells: 3000, seed: 1 };
  it('五个滑块；不动时的值是这种世界本来的（陆地多少按世界类型）', () => {
    expect(TERRAIN_SLIDERS.map((s) => s.label)).toEqual(['陆地多少', '岛多少', '山多高', '海岸曲折', '最高的山']);
    expect(terrainDefaults({ seed: 3, type: 'archipelago' }, false)).toEqual({ landFraction: 0.13, islands: 0.8, mountains: 1, coast: 1, mountainScale: 6000 });
    expect(terrainDefaults({ seed: 3, type: 'continent' }, false).landFraction).toBe(0.3);
  });

  it('一项都没动：命令与以前逐字相同', () => {
    const gen = { seed: 3, type: 'archipelago' as const };
    expect(newWorldCommands(withTerrain(gen, {}), '群岛之海', 3, terrainCommands({}))).toEqual(newWorldCommands(gen, '群岛之海', 3));
    // 拖动后又拖回默认的海岸曲折、最高的山：不多写命令
    expect(terrainCommands({ coast: 1, mountainScale: 6000 })).toEqual([]);
  });

  it('动过的几项进了建出来的世界，是一步“新世界：X”', () => {
    const t = { landFraction: 0.3, islands: 0.2, mountains: 1.5, coast: 1.6, mountainScale: 9000 };
    const eng = engineFor(region);
    for (const cmd of newWorldCommands(withTerrain({ seed: 3, type: 'archipelago' }, t), '群岛之海', 3, terrainCommands(t))) eng.exec(cmd);
    const w = eng.world;
    expect(eng.history.map((h) => h.summary)).toEqual(['新世界“群岛之海”', expect.any(String)]);
    expect(w.small.terrain.gen).toMatchObject({ landFraction: 0.3, islands: 0.2, mountains: 1.5 });
    expect(w.small.terrain.coastRoughness).toBe(1.6);
    expect(w.small.planet.mountainScale).toBe(9000);
    // 与先建好再一项一项调出来的世界逐格相同
    const ref = engineFor(region);
    ref.exec({ op: 'set_coast_style', roughness: 1.6 });
    ref.exec({ op: 'set_planet', patch: { mountainScale: 9000 } });
    ref.exec({ op: 'set_worldgen', params: { seed: 3, type: 'archipelago', landFraction: 0.3, islands: 0.2, mountains: 1.5 }, reset: true });
    expect(Array.from(w.causes.land)).toEqual(Array.from(ref.world.causes.land));
    expect(Array.from(w.derived.elevation)).toEqual(Array.from(ref.world.derived.elevation));
  });
});

describe('河的终点：短的叫法，细的说法在悬停的提示里', () => {
  it('流下去 / 停在这，各有自己的说明', () => {
    expect(riverEnds.options.map((o) => [o.value, o.label])).toEqual([
      ['flow', '流下去'],
      ['sink', '停在这'],
    ]);
    expect(riverEnds.options[0].hint).toBe('顺地势流到海、湖或别的河');
    expect(riverEnds.options[1].hint).toBe('在线的终点结束');
    expect(RIVER_END_HINTS).toEqual({ flow: riverEnds.options[0].hint, sink: riverEnds.options[1].hint });
  });
});

describe('名字前面的类型字可以改', () => {
  it('自然的地物：写进改过的名字那一条；名字不变；清空换回默认的；撤销还原', () => {
    const eng = continents({ cells: 3000 });
    const w = eng.world;
    const f0 = w.derived.features.find((f) => f.name && !f.guide && !f.region && f.type === 'island')!;
    const name = f0.name;
    const auto = featureLabel(w, f0);
    eng.exec({ op: 'rename_feature', key: f0.key, label: '圣岛' });
    const f1 = w.derived.features.find((f) => f.key === f0.key)!;
    expect(featureLabel(w, f1)).toBe('圣岛');
    expect(defaultFeatureLabel(w, f1)).toBe(auto);
    expect(f1.name).toBe(name);
    expect(f1.custom).toBe(false);
    expect(w.small.featureNames[f0.key]).toEqual({ label: '圣岛' });
    // 再改名字：类型字留着
    eng.exec({ op: 'rename_feature', key: f0.key, name: '长岛' });
    const f2 = w.derived.features.find((f) => f.key === f0.key)!;
    expect([f2.name, featureLabel(w, f2)]).toEqual(['长岛', '圣岛']);
    eng.exec({ op: 'rename_feature', key: f0.key, label: '' });
    const f3 = w.derived.features.find((f) => f.key === f0.key)!;
    expect([f3.name, featureLabel(w, f3), f3.label]).toEqual(['长岛', auto, undefined]);
    eng.undo();
    eng.undo();
    eng.undo();
    const f4 = w.derived.features.find((f) => f.key === f0.key)!;
    expect([f4.name, featureLabel(w, f4)]).toEqual([name, auto]);
    expect(() => eng.exec({ op: 'rename_feature', key: f0.key })).toThrow();
  });

  it('点状地名写在区块上：“地点”换成自己的叫法', () => {
    const eng = continents({ cells: 3000 });
    const w = eng.world;
    const cell = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i])!;
    eng.exec({ op: 'add_region', region: { kind: 'spot', cells: [cell], name: '白塔' } });
    const id = w.small.regions[0].id;
    const spot = () => w.derived.features.find((f) => f.region === id)!;
    expect(featureLabel(w, spot())).toBe('地点');
    expect(eng.exec({ op: 'update_region', id, label: '圣地' })).toBe('类型改叫“圣地”');
    expect([spot().name, featureLabel(w, spot())]).toEqual(['白塔', '圣地']);
    eng.exec({ op: 'update_region', id, label: '' });
    expect(featureLabel(w, spot())).toBe('地点');
  });

  it('框里写的：没变、写回默认的叫法不算一步；清空换回默认的', () => {
    expect(labelCommit('山脉', '山脉', '山脉')).toBeNull();
    expect(labelCommit(' 圣山 ', '山脉', '山脉')).toBe('圣山');
    expect(labelCommit('圣山', '圣山', '山脉')).toBeNull();
    expect(labelCommit('', '圣山', '山脉')).toBe('');
    expect(labelCommit('山脉', '圣山', '山脉')).toBe('');
    expect(labelCommit('', '山脉', '山脉')).toBeNull();
  });
});

describe('海水温度底图', () => {
  const opts = (season: 'annual' | 'summer' | 'winter') => ({ mode: 'seaTemp' as const, season, focusSpecies: null, borders: false });
  it('海面按海水的冷暖（季节跟着换），陆地、湖面是灰的；着色器不给海面加浅水的颜色', () => {
    const w = continents({ cells: 3000 }).world;
    const d = w.derived;
    for (const season of ['annual', 'summer'] as const) {
      const l = cellLayers(w, opts(season));
      expect(l.seaData).toBe(true);
      let sea = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        const rgb = Array.from(l.smooth.slice(i * 4, i * 4 + 3));
        if (!w.causes.land[i]) {
          sea++;
          expect(rgb).toEqual(Array.from(Uint8Array.from(tempRgb(season === 'summer' ? d.tS[i] : d.tMean[i]))));
        } else expect(rgb).toEqual([...(d.lake[i] === 1 ? SEA_TEMP_LAKE : SEA_TEMP_LAND)]);
      }
      expect(sea).toBeGreaterThan(100);
    }
    // 别的数据底图照旧：海面一片暗色，着色器照常加浅水的颜色
    const t = cellLayers(w, { ...opts('annual'), mode: 'temperature' });
    expect(t.seaData).toBe(false);
    const s = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i])!;
    expect(Array.from(t.smooth.slice(s * 4, s * 4 + 3))).toEqual([40, 50, 70]);
  });

  it('和气温、降水一样在常用的底图里', () => {
    const v = VIEWS.find((x) => x.id === 'seaTemp');
    expect(v).toMatchObject({ label: '海水温度' });
    expect(v?.more).toBeFalsy();
  });
});

describe('适宜程度底图自己选生态', () => {
  it('换到这张底图时没选过（或选的那种没了）就是第一种；选过的照旧', () => {
    const w = continents({ cells: 3000 }).world;
    world.value = w;
    const [a, b] = w.small.species;
    focusSpecies.value = null;
    showView('suitability');
    expect([mode.value, focusSpecies.value]).toEqual(['suitability', a.id]);
    focusSpecies.value = b.id;
    showView('suitability');
    expect(focusSpecies.value).toBe(b.id);
    expect(suitabilityFocus(w.small.species, 'gone')).toBe(a.id);
    expect(suitabilityFocus([], 'gone')).toBeNull();
    mode.value = 'terrain';
  });
});

describe('一处一处看没涂成的地方', () => {
  const conflict = (constraintId: string, failing: number[]): Conflict => ({ constraintId, species: 'desert', failing, reasons: [] }) as unknown as Conflict;
  const fake = {
    small: {
      constraints: [
        { id: 'c1', cells: [1, 2], ignored: undefined },
        { id: 'c2', cells: [3, 4] },
        { id: 'c3', cells: [5, 6], ignored: true },
        { id: 'c4', cells: [7], ignored: true },
      ],
    },
    derived: { conflicts: [conflict('c1', [2]), conflict('c2', []), conflict('c3', [6])] },
  } as unknown as World;

  it('先是还要提醒的（涂到水面上的看涂的格），再是说了“就这样”的（已经长出来的看涂的格）', () => {
    expect(unmetSpots(fake)).toEqual([[2], [3, 4], [6], [7]]);
  });

  it('按一下看下一处，看完一圈回到第一处；按钮上写着第几处', () => {
    unmetLooked.value = -1;
    expect(locateTitle(unmetLooked.value, 4)).toBe('定位');
    const seen = [0, 1, 2, 3, 4].map(() => locateNextUnmet(fake));
    expect(seen).toEqual([0, 1, 2, 3, 0]);
    expect(vi.mocked(focusOn).mock.calls.map((c) => Array.from(c[0]))).toEqual([[2], [3, 4], [6], [7], [2]]);
    expect(locateTitle(unmetLooked.value, 4)).toBe('定位 1/4');
    // 没有可看的
    expect(locateNextUnmet({ small: { constraints: [] }, derived: { conflicts: [] } } as unknown as World)).toBe(-1);
    expect(unmetLooked.value).toBe(-1);
  });
});
