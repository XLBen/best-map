import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VNode } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { continents, snapshot, humanExec } from '../../core/testing/fixtures';
import { meshFor, seededEngine } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { cellLayers } from '../render/colors';
import { FIELD_KIND } from '../render/overlay-static';
import { WIND_STYLE, windLines } from '../render/wind';
import { flowSeason, mode, overlays, parseMapKind, parsePrefs, season, world } from '../state';
import { OVERLAYS } from './defs/layers';
import { flowHint, flowLegend } from './domain/legend';
import { cleanOverlay } from './map/export';
import { kindOfView, modeOf } from './map/modes';
import { MapLegend } from './shell/MapLegend';

// 风向、洋流两个图层（第四十八轮）：两个开关互相独立、任何模式上都能叠加；风的季节与地貌的季节分开；图例只在开着时有，
// 底图也有图例时叠着放；导出带上开着的；存着的“风与洋流”模式读回来是地理。
// 画的那一半（关着一块不算、一笔不画）见 render/wind-layer.test.ts

// 组件直接调（同 library-world.test.ts），useState 换成不收起
vi.mock('preact/hooks', async (orig) => ({ ...(await orig<typeof import('preact/hooks')>()), useState: <T,>(v: T) => [v, () => {}] }));

const frame = { cw: 1000, ch: 700, dpr: 1 };
const peoples = () =>
  snapshot('r48:peoples', () => {
    const e = continents();
    humanExec(e, { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {}, settlements: {} });
    return e;
  }).world;

const set = (wind: boolean, currents: boolean) => (overlays.value = { ...overlays.value, wind, currents });

afterEach(() => {
  set(false, false);
  flowSeason.value = 'annual';
  season.value = 'annual';
  mode.value = 'terrain';
  world.value = null;
});

describe('两个开关', () => {
  it('默认都关着，图层面板里各一个，地区、星球上都有', () => {
    expect(overlays.value.wind).toBe(false);
    expect(overlays.value.currents).toBe(false);
    const keys = OVERLAYS.map((o) => o.key);
    expect(keys).toContain('wind');
    expect(keys).toContain('currents');
    for (const k of ['wind', 'currents']) {
      const o = OVERLAYS.find((x) => x.key === k)!;
      expect(o.planetOnly).toBeFalsy();
      expect(o.settle).toBeFalsy();
    }
    expect(OVERLAYS.find((o) => o.key === 'wind')!.label).toBe('风向');
    expect(OVERLAYS.find((o) => o.key === 'currents')!.label).toBe('洋流');
  });

  it('互相独立，也不看地图模式', () => {
    const w = peoples();
    for (const kind of ['terrain', 'culture', 'popDensity'] as const) {
      mode.value = kind;
      for (const [wind, currents] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        set(wind, currents);
        const st = cleanOverlay(w, frame, []);
        expect([st.wind, st.currents]).toEqual([wind, currents]);
      }
    }
  });

  it('新的选项写进了叠加层静态的键（改了要重画）', () => {
    expect(FIELD_KIND.wind).toBe('static');
    expect(FIELD_KIND.currents).toBe('static');
    expect(FIELD_KIND.flowSeason).toBe('static');
  });
});

describe('风的季节与地貌的季节分开', () => {
  const planet = () =>
    snapshot('r48:planet', () => {
      const settings = { seed: 4, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 };
      const e = seededEngine(settings, meshFor(settings));
      e.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
      return e;
    }).world;

  it('换风的季节：地貌的季节不变，雪、着色不变；流线变了', () => {
    const w = planet();
    const shot = (s: typeof season.value) => cellLayers(w, { mode: 'terrain', season: s, focusSpecies: null, borders: false }).smooth;
    const before = shot(season.value);
    // 这张图上冬天的雪确实不一样（比下面的相同才有意义）
    expect(Array.from(shot('winter'))).not.toEqual(Array.from(before));
    flowSeason.value = 'winter';
    expect(season.value).toBe('annual');
    expect(Array.from(shot(season.value))).toEqual(Array.from(before));
    const cam = { x: 1, y: 0.5, zoom: 500 };
    const size = { cw: 1000, ch: 700 };
    expect(windLines(w, cam, flowSeason.value, size)[0].pts).not.toEqual(windLines(w, cam, season.value, size)[0].pts);
  });

  it('换地貌的季节：风的季节不变，导出的流线不变', () => {
    const w = planet();
    flowSeason.value = 'summer';
    season.value = 'winter';
    expect(flowSeason.value).toBe('summer');
    expect(cleanOverlay(w, frame, []).flowSeason).toBe('summer');
  });

  it('地图上：底图的着色只认 season，叠加层的流线只认 flowSeason', () => {
    const src = readFileSync(join(__dirname, 'MapView.tsx'), 'utf8');
    const colors = src.slice(src.indexOf('function applyColors('), src.indexOf('const bk = baseKey(o);'));
    expect(colors).toContain('season: season.value');
    expect(colors).not.toContain('flowSeason');
    expect(src).toContain('flowSeason: flowSeason.value');
    // 叠加层里没有地貌的季节
    expect('season' in FIELD_KIND).toBe(false);
  });
});

describe('图例', () => {
  const legends = () => MapLegend() as VNode<{ class?: string; title?: string; children?: unknown; hint?: string }> | null;
  const stacked = (v: ReturnType<typeof legends>) => (v?.props.children as (VNode<{ title: string; items: { label: string }[]; hint?: string; children: unknown }> | null | false)[]).filter(Boolean) as VNode<{ title: string; items: { label: string }[]; hint?: string; children: unknown }>[];

  it('都关着时没有这一张（没有别的图例时什么都没有）', () => {
    world.value = continents().world;
    // 第七十二轮起地貌也有图例：换一张没有图例的底图
    mode.value = 'elevation';
    expect(flowLegend(false, false)).toBeNull();
    expect(legends()).toBeNull();
  });

  it('开着才有，只列开着的那一层；上面是季节', () => {
    world.value = continents().world;
    mode.value = 'elevation';
    expect(flowLegend(true, false)!.items.map((i) => i.label)).toEqual(['弱风', '中等的风', '强风']);
    expect(flowLegend(false, true)!.items.map((i) => i.label)).toEqual(['暖流', '寒流', '不冷不暖的洋流']);
    expect(flowLegend(true, true)!.items).toHaveLength(6);
    expect(flowLegend(true, false)!.title).toBe('风向');
    expect(flowLegend(false, true)!.title).toBe('洋流');
    set(true, false);
    const [only] = stacked(legends());
    expect(only.props.title).toBe('风向');
    expect((only.props.children as VNode<{ value: string }>).props.value).toBe('annual');
    flowSeason.value = 'winter';
    expect((stacked(legends())[0].props.children as VNode<{ value: string }>).props.value).toBe('winter');
    set(false, false);
    expect(legends()).toBeNull();
  });

  it('底图也有图例时叠着放：风向洋流的在上面；关了回到原来的一张', () => {
    world.value = peoples();
    mode.value = 'culture';
    const plain = legends();
    expect(plain?.props.class).toBeUndefined();
    expect(plain?.props.title).toBeTruthy();
    set(true, true);
    const stack = legends();
    expect(stack?.props.class).toBe('legend-stack');
    const [flow, main] = stacked(stack);
    expect(flow.props.title).toBe('风向与洋流');
    expect(main.props.title).toBe(plain?.props.title);
    set(false, false);
    expect(legends()?.props.class).toBeUndefined();
  });

  it('一句话：季节只管风；洋流强弱是 0 时写明', () => {
    expect(flowHint(true, false, 1)).toContain('不影响地貌的雪');
    expect(flowHint(false, true, 1)).toContain('全年平均');
    expect(flowHint(false, true, 0)).toContain('没有洋流');
    expect(flowHint(true, true, 0)).toContain('没有洋流');
  });

  it('风的三档的颜色就是地图上的', () => {
    expect(flowLegend(true, false)!.items.map((i) => i.color)).toEqual(WIND_STYLE.colors[0]);
  });
});

describe('导出', () => {
  it('带上开着的，按风的季节；关着的不带', () => {
    const w = continents().world;
    let st = cleanOverlay(w, frame, []);
    expect(st.wind).toBe(false);
    expect(st.currents).toBe(false);
    set(true, true);
    flowSeason.value = 'summer';
    st = cleanOverlay(w, frame, []);
    expect(st.wind).toBe(true);
    expect(st.currents).toBe(true);
    expect(st.flowSeason).toBe('summer');
    // 带 frame：导出按当场算、直接画（见 wind-layer.ts 的 drawFlows），没有 lazy
    expect(st.frame).toBe(frame);
    expect(st.lazy).toBeUndefined();
  });
});

describe('去掉了“风与洋流”这个模式', () => {
  it('存着的 wind 读回来是地理', () => {
    expect(parseMapKind('wind')).toBe('geo');
    expect(parsePrefs(JSON.stringify({ map: 'wind' })).map).toBe('geo');
    expect(kindOfView('wind' as never)).toBe('geo');
  });

  it('打开世界时按读回来的偏好：是地理，底图不换', () => {
    const w: World = peoples();
    expect(modeOf(w, parsePrefs(JSON.stringify({ map: 'wind' })).map)).toBe('geo');
  });
});
