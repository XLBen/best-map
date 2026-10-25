import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { exec, options, selectedFeature, selectedLake, selectedProvince, selectedRiver, setOptions, switchTool, tool, world } from '../state';
import { barPreview, clearBarPreview } from './barPreview';
import { CATEGORIES, CATEGORY_DEFS, TOOL_DEFS, type ToolId, category, setTool } from './defs/tools';
import { Settle, slowTail } from './exact';
import { showSplit } from './provincePreview';
import { previewRiverBar } from './riverCourse';
import { type Pointer, climateTool, rangePick } from './tools';

// 第十九轮 A：工具的登记只有一处（工具表），换工具都走 setTool、清掉离开的工具与类别的东西；冷暖、干湿的力度分开；
// 轻预览（Settle）停一下再算、同一个只算一次、旧的不要

vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true) }));

afterEach(() => {
  setTool('land');
  vi.useRealTimers();
});

describe('工具表', () => {
  it('ToolId 就是工具表的键：每个工具的 id 是它的键，每个工具都在它那一类的列表里，各类的列表合起来正好是全部工具', () => {
    const ids = Object.keys(TOOL_DEFS) as ToolId[];
    for (const id of ids) expect(TOOL_DEFS[id].id).toBe(id);
    for (const id of ids) expect(CATEGORY_DEFS[TOOL_DEFS[id].category].tools).toContain(id);
    const listed = CATEGORIES.flatMap((c) => c.tools);
    expect([...listed].sort()).toEqual([...ids].sort());
    expect(new Set(listed).size).toBe(listed.length);
    // 每一类里的先后与第十九轮之前相同（底部工具条上的位置、数字键）；第二十一轮在地形、自然的最后加了地形类别、资源；
    // 第二十二轮加了“文化”一类（文化、人口、发源地）；第二十三轮加了“国家”一类（选国家、领土、新建、合并、首都）
    expect(Object.fromEntries(CATEGORIES.map((c) => [c.id, c.tools]))).toEqual({
      terrain: ['land', 'island', 'chain', 'relief', 'fragment', 'reroll', 'restore', 'terrainClass'],
      climate: ['temp', 'moist', 'unclimate', 'field'],
      nature: ['biome', 'grow', 'erase', 'range', 'resource'],
      water: ['river', 'lake', 'unwater'],
      provinces: ['pselect', 'pbrush', 'pcut', 'pmerge', 'pregen'],
      names: ['rename', 'area', 'spot'],
      culture: ['culture', 'pop', 'hearth'],
      countries: ['cselect', 'territory', 'newCountry', 'cmerge', 'capital'],
    });
  });

  it('光标由工具表声明：点选类的工具是手指，其余是十字（不写）', () => {
    const pointer = (Object.keys(TOOL_DEFS) as ToolId[]).filter((id) => TOOL_DEFS[id].cursor === 'pointer');
    expect(pointer.sort()).toEqual(['capital', 'cmerge', 'cselect', 'pmerge', 'pselect', 'range', 'rename', 'unwater']);
  });
});

describe('换工具', () => {
  it('换到别的类：选中的河、湖、省、地名，选生态的范围，底部条上的预览都清掉；量距离也停了', () => {
    const eng = continents({ provinces: true });
    const w = eng.world;
    world.value = w;
    const id = Number(Object.keys(w.small.provinces)[0]);
    // 省份：选中一个省，鼠标停在“对半分开”上
    setTool('pselect');
    selectedProvince.value = id;
    showSplit(w, id);
    expect(barPreview.value).not.toBeNull();
    setTool('land');
    expect(selectedProvince.value).toBeNull();
    expect(barPreview.value).toBeNull();
    // 地名
    setTool('rename');
    selectedFeature.value = w.derived.features[0].key;
    setTool('pselect');
    expect(selectedFeature.value).toBeNull();
    // 河：选中一条河，底部条上拖着它的大小
    setTool('river');
    selectedRiver.value = { kind: 'natural', cell: 0 };
    const guide = { id: 'g', cells: [0, 1], locked: true, spring: false };
    previewRiverBar({ op: 'remove_guide', id: 'g' } as Command, guide as never, [1, 1], 1e6);
    expect(barPreview.value?.kind).toBe('river');
    setTool('lake');
    expect(selectedRiver.value).toBeNull();
    expect(barPreview.value).toBeNull();
    // 湖
    selectedLake.value = { kind: 'natural', cell: 0 };
    setTool('unwater');
    expect(selectedLake.value).toBeNull();
    // 选生态的范围
    setTool('range');
    rangePick.value = { species: 'desert', kind: 'cells', back: 'biome' };
    setTool('biome');
    expect(rangePick.value).toBeNull();
  });

  it('同一类里换工具：选中的省留着（选了省再涂省、合并）；面板、工具里换工具（switchTool）走同一个 setTool', () => {
    const w = continents({ provinces: true }).world;
    world.value = w;
    setTool('pselect');
    selectedProvince.value = Number(Object.keys(w.small.provinces)[0]);
    setTool('pbrush');
    expect(selectedProvince.value).not.toBeNull();
    switchTool('river');
    expect(tool.value).toBe('river');
    expect(category.value).toBe('water');
    expect(selectedProvince.value).toBeNull();
    clearBarPreview();
  });
});

describe('冷暖、干湿的力度分开', () => {
  const at = (w: World, c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 0, sy: 0, shift: false, alt: false });
  const sent = async (group: 'temp' | 'moist', w: World, c: number) => {
    vi.mocked(exec).mockClear();
    const t = climateTool(group);
    t.move?.(at(w, c), false);
    t.down?.(at(w, c));
    await t.up?.(at(w, c));
    const cmd = vi.mocked(exec).mock.calls[0][0] as Extract<Command, { op: 'paint' }>;
    return { field: cmd.field, peak: Math.max(...(cmd.values ?? []).map(Math.abs)) };
  };

  it('默认都是 1；改冷暖的力度不动干湿的，反过来也一样；底部条上是两个滑块', async () => {
    const w = continents().world;
    world.value = w;
    const c = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && w.derived.elevation[i] > 200)!;
    setOptions({ brushKm: 2 * w.mesh.spacing * w.kmPerUnit, tempMode: 'warm', moistMode: 'wet', tempAmount: 1, moistAmount: 1 });
    const t1 = await sent('temp', w, c);
    const m1 = await sent('moist', w, c);
    expect(t1.field).toBe('tempOffset');
    expect(m1.field).toBe('moistOffset');
    setOptions({ tempAmount: 2 });
    expect(options.value.moistAmount).toBe(1);
    expect((await sent('temp', w, c)).peak).toBeCloseTo(2 * t1.peak);
    expect((await sent('moist', w, c)).peak).toBeCloseTo(m1.peak);
    setOptions({ tempAmount: 1, moistAmount: 0.5 });
    expect((await sent('temp', w, c)).peak).toBeCloseTo(t1.peak);
    expect((await sent('moist', w, c)).peak).toBeCloseTo(0.5 * m1.peak);
    expect(TOOL_DEFS.temp.amount!.key).toBe('tempAmount');
    expect(TOOL_DEFS.moist.amount!.key).toBe('moistAmount');
    setOptions({ moistAmount: 1 });
  });
});

describe('轻预览（Settle）', () => {
  it('停一下再算；同一个世界上同一个 key 只算一次；换了 key，旧的回来了也不要；没算成时 retry 的下次再要会重新算', async () => {
    vi.useFakeTimers();
    world.value = continents({ cells: 5000 }).world;
    const calls: string[] = [];
    let answer: string | null = 'ok';
    const run = (k: string) => async () => (calls.push(k), answer);
    const s = new Settle<string>();
    s.want('a', run('a'), 150);
    s.want('a', run('a'), 150);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toEqual(['a']);
    expect(s.get('a')).toBe('ok');
    s.want('a', run('a'), 150);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual(['a']);
    // 换了 key：旧的（还在路上）回来也不留
    let release: (v: string) => void = () => {};
    s.want('b', () => new Promise<string>((r) => (release = r)), 0);
    s.want('c', run('c'), 0);
    release('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.get('b')).toBeNull();
    expect(s.get('c')).toBe('ok');
    // 没算成：retry 的下次再要会重新算，不 retry 的不再算
    answer = null;
    const r = new Settle<string>(true);
    r.want('x', run('x'), 0);
    await vi.advanceTimersByTimeAsync(0);
    r.want('x', run('x'), 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((k) => k === 'x')).toHaveLength(2);
    const n = new Settle<string>();
    n.want('y', run('y'), 0);
    await vi.advanceTimersByTimeAsync(0);
    n.want('y', run('y'), 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((k) => k === 'y')).toHaveLength(1);
  });

  it('“松手后约 N 秒出结果”只有一种写法', () => {
    expect(slowTail(3)).toBe('，松手后约 3 秒出结果');
    expect(slowTail(null)).toBe('');
    expect(slowTail(null, '…')).toBe('…');
  });
});
