import { describe, expect, it } from 'vitest';
import { Dirty } from '../../core/commands';
import type { Engine } from '../../core/engine';
import { allCountryStats, landmarkList, pointList, stampedPacks, worldEra, eraGovernments, worldGovernments, type Government } from '../../core/human';
import { computeCityTable } from '../../core/human/settlements';
import { continents, fragKm2, humanExec, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { arraysToken } from '../../core/world-token';
import { ContentHolder } from '../content-post';
import { library } from '../library';
import type { LightSnapshot, Snapshot } from '../protocol';
import type { Shape } from '../render/overlay';
import { drawShape, resetPen } from '../render/overlay-shapes';
import { sameShape } from '../render/overlay-static';
import { describeChange } from '../state';
import { lightWorld, mergeSnapshot } from '../state/snapshot-merge';
import { SnapshotSender } from '../worker-snapshot';
import { cellsOf, countryRows, governmentChoices, governmentName, statsOf } from './domain/countries';
import { itemsInPacks, librarySelectable } from './domain/packChoice';
import { legendFor } from './domain/legend';
import { settleLists } from './domain/settlements';
import { capitalShapes, provinceLand } from './tools/countries';

// 第八十轮（国家界面）的提速，新旧逐位相同：
//   快照：没变的原因数组、地物、小数据的段、国家不发，主线程沿用手上的同一个对象——拼出来的世界与完整的快照逐字节相同；
//   国家的统计、列表、城市地标的列表、图例：缓存的结果与不缓存当场算的相同（改名、换颜色、涂陆地、改人口、挪首都、撤销……之后）；
//   首都的星、省份的陆地格、编辑前后的差别、政体的选择、图形的比较、画图形时画笔的状态：与以前的算法相同。
// 下面的 old* 是第七十九轮（1cd3bea）的原样拷贝（只去掉缓存），不要改它

const GROUPS = [
  { id: 'germanic', weight: 3 },
  { id: 'chinese', weight: 3 },
  { id: 'altaic', weight: 1.5 },
];
const nations = (): Engine =>
  snapshot('r80:nations', () => {
    const eng = continents();
    humanExec(eng, { op: 'generate_human', packs: [['medieval']], groups: GROUPS, countries: {} }, { countryKm2: fragKm2('medieval', 1) });
    eng.exec({ op: 'generate_provinces', seed: 5 });
    eng.exec({ op: 'generate_settlements' });
    eng.update();
    return eng;
  });

// ---------- 一个假的主线程：收快照、拼世界（与 worker-host 相同的几步） ----------
function mainThread(eng: Engine) {
  const sender = new SnapshotSender(7);
  const rx = new ContentHolder();
  let world: World | null = null;
  let state = 0;
  const take = (light: boolean): World => {
    const deep = eng.takeRecomputed();
    const out = light && deep <= Dirty.Names && world ? sender.light(eng) : sender.full(eng);
    const s = structuredClone(out.snap, { transfer: out.transfer }) as Snapshot | LightSnapshot;
    expect(rx.unpack(s)).toBe(true);
    if ('light' in s) world = lightWorld(world!, s);
    else {
      const m = mergeSnapshot(world, state, s);
      expect(m).not.toBeNull();
      world = { settings: m!.settings, mesh: eng.world.mesh, kmPerUnit: eng.world.kmPerUnit, causes: m!.causes, small: m!.small, derived: m!.derived };
    }
    state = s.stateId;
    return world;
  };
  return { take, sender };
}

// 同一个状态的完整快照（另一个发送方，什么都带上）
function fullWorld(eng: Engine): World {
  const out = new SnapshotSender(9).full(eng, true);
  const s = structuredClone(out.snap, { transfer: out.transfer });
  expect(new ContentHolder().unpack(s)).toBe(true);
  return { settings: s.settings, mesh: eng.world.mesh, kmPerUnit: eng.world.kmPerUnit, causes: s.causes, small: s.small, derived: s.derived };
}

const bytes = (a: ArrayBufferView) => Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
function expectSameWorld(a: World, b: World) {
  expect(Object.keys(a.causes).sort()).toEqual(Object.keys(b.causes).sort());
  for (const [k, v] of Object.entries(b.causes)) {
    const x = (a.causes as unknown as Record<string, unknown>)[k];
    if (ArrayBuffer.isView(v)) expect(bytes(x as ArrayBufferView), k).toEqual(bytes(v));
  }
  for (const [k, v] of Object.entries(b.causes.fields)) expect(bytes(a.causes.fields[k]), k).toEqual(bytes(v));
  for (const [k, v] of Object.entries(b.derived)) {
    const x = (a.derived as unknown as Record<string, unknown>)[k];
    if (ArrayBuffer.isView(v)) expect(bytes(x as ArrayBufferView), k).toEqual(bytes(v));
  }
  expect(JSON.stringify(a.derived.features)).toBe(JSON.stringify(b.derived.features));
  expect(a.derived.features.map((f) => bytes(f.cells))).toEqual(b.derived.features.map((f) => bytes(f.cells)));
  expect(JSON.stringify(a.small)).toBe(JSON.stringify(b.small));
}

// 统计、城市表不缓存的一份：换一个网格对象（按网格缓存的都当场算）
const fresh = (w: World): World => ({ ...w, mesh: Object.create(w.mesh) as World['mesh'] });

function oldCountryRows(w: World) {
  const stats = allCountryStats(fresh(w));
  const metas = w.small.countries!;
  return Object.values(metas)
    .map((m) => ({ meta: m, stats: stats.get(m.id), government: governmentName(w.small, m.government), ...(m.overlord !== undefined && metas[m.overlord] ? { overlord: metas[m.overlord] } : {}) }))
    .sort((a, b) => (b.stats?.population ?? 0) - (a.stats?.population ?? 0) || (b.stats?.areaKm2 ?? 0) - (a.stats?.areaKm2 ?? 0) || a.meta.id - b.meta.id);
}

function expectCachesFresh(w: World) {
  const f = fresh(w);
  expect(JSON.stringify([...statsOf(w)])).toBe(JSON.stringify([...allCountryStats(f)]));
  expect(JSON.stringify(countryRows(w))).toBe(JSON.stringify(oldCountryRows(w)));
  const lists = settleLists(w);
  expect(JSON.stringify(lists.cities)).toBe(JSON.stringify(computeCityTable(f).list));
  expect(JSON.stringify(lists.landmarks)).toBe(JSON.stringify(landmarkList(f)));
  expect(JSON.stringify(lists.points)).toBe(JSON.stringify(pointList(f)));
  expect(JSON.stringify(legendFor(w, 'country'))).toBe(JSON.stringify(legendFor(f, 'country')));
}

describe('快照只发变了的（原因数组、地物、小数据的段、国家）', () => {
  it('一串编辑：拼出来的世界与完整的快照逐字节相同；没变的沿用同一个对象；国家的统计、列表、城市地标、图例与当场算的相同', () => {
    const eng = nations();
    const host = mainThread(eng);
    let w = host.take(false);
    expectSameWorld(w, fullWorld(eng));
    const ids = Object.keys(w.small.countries!).map(Number);
    const big = countryRows(w)[0].meta.id;
    const land = Array.from({ length: w.mesh.n }, (_, i) => i).filter((i) => w.causes.land[i]);
    const steps: [string, () => void, boolean][] = [
      ['改名', () => eng.exec({ op: 'set_country', id: big, patch: { name: '测试之国' } }), true],
      ['换颜色', () => eng.exec({ op: 'set_country', id: ids[1], patch: { color: '#123456' } }), true],
      ['宗主', () => eng.exec({ op: 'set_country', id: ids[2], patch: { overlord: big } }), true],
      ['主流文化', () => eng.exec({ op: 'set_country', id: big, patch: { primaryCulture: Object.values(w.small.countries!)[3].primaryCulture } }), true],
      ['挪首都', () => eng.exec({ op: 'move_capital', id: big, cell: cellsOf(w, big)[5] }), true],
      ['涂领土', () => eng.exec({ op: 'paint_country', cells: land.slice(0, 40), country: big }), true],
      ['改人口', () => eng.exec({ op: 'paint_pop', cells: land.slice(100, 160), mode: 'count', factor: 2 }), true],
      ['涂成海', () => eng.exec({ op: 'paint_land', cells: land.slice(200, 230), t: land.slice(200, 230).map(() => 1), mode: 'sea' }), true],
      ['河的门槛', () => eng.exec({ op: 'set_planet', patch: { riverThreshold: eng.world.small.planet.riverThreshold * 1.3 } }), true],
      ['省名', () => eng.exec({ op: 'set_province', id: Number(Object.keys(eng.world.small.provinces)[0]), name: '测试省' }), true],
      ['撤销', () => eng.undo(), true],
      ['撤销', () => eng.undo(), true],
      ['重做', () => eng.redo(), true],
    ];
    for (const [what, run, light] of steps) {
      const before = w;
      run();
      w = host.take(light);
      expectSameWorld(w, fullWorld(eng));
      expectCachesFresh(w);
      if (what === '改名' || what === '换颜色' || what === '宗主') {
        // 只改了档案：数组、地物、别的段、别的国家都是原来的对象
        for (const [k, v] of Object.entries(w.causes)) if (ArrayBuffer.isView(v)) expect(v, `${what} ${k}`).toBe((before.causes as unknown as Record<string, unknown>)[k]);
        expect(w.derived.features).toBe(before.derived.features);
        expect(w.small.cities).toBe(before.small.cities);
        expect(w.small.provinces).toBe(before.small.provinces);
        for (const [k, v] of Object.entries(w.derived)) if (ArrayBuffer.isView(v)) expect(v, `${what} ${k}`).toBe((before.derived as unknown as Record<string, unknown>)[k]);
        expect(arraysToken({ ...w })).toBe(arraysToken({ ...before }));
        const same = Object.keys(w.small.countries!).filter((id) => w.small.countries![id] === before.small.countries![id]);
        expect(same.length).toBeGreaterThanOrEqual(ids.length - 2);
      }
    }
  });
});

describe('国家界面的几样小东西与以前的算法相同', () => {
  it('首都的星按国家、缩放、选中缓存：与当场画的相同；换了就重画', () => {
    const w = fullWorld(nations());
    const a = capitalShapes(w, 2000, null);
    expect(capitalShapes(w, 2000, null)).toBe(a);
    const copy = { ...w, small: { ...w.small, countries: { ...w.small.countries } } };
    expect(JSON.stringify(capitalShapes(copy, 2000, null))).toBe(JSON.stringify(a));
    expect(capitalShapes(copy, 2000, 3)).not.toBe(a);
    expect(JSON.stringify(capitalShapes(w, 3000, null))).not.toBe(JSON.stringify(a));
  });

  it('一国的格、一个省的陆地格：陆海变了重数；与逐格扫一遍的相同', () => {
    const w = fullWorld(nations());
    const id = countryRows(w)[0].meta.id;
    const scan = (x: World) => Array.from({ length: x.mesh.n }, (_, i) => i).filter((i) => x.causes.land[i] && x.causes.country![i] === id);
    expect(cellsOf(w, id)).toEqual(scan(w));
    const land = w.causes.land.slice();
    for (const i of scan(w).slice(0, 10)) land[i] = 0;
    const w2 = { ...w, causes: { ...w.causes, land } };
    expect(cellsOf(w2, id)).toEqual(scan(w2));
    for (let c = 0; c < w.mesh.n; c += 97) {
      const p = w.causes.province[c];
      const old = p < 0 || !w.causes.land[c] || !w.small.provinces[p] ? null : { id: p, cells: Array.from({ length: w.mesh.n }, (_, i) => i).filter((i) => w.causes.province[i] === p && w.causes.land[i]) };
      expect(provinceLand(w, c)).toEqual(old);
      expect(provinceLand(w2, c)?.cells ?? null).toEqual(old && w2.causes.land[c] ? Array.from({ length: w.mesh.n }, (_, i) => i).filter((i) => w.causes.province[i] === p && w2.causes.land[i]) : provinceLand(w2, c)?.cells ?? null);
    }
  });

  it('编辑前后的差别：数组都没换时与逐格比的相同（什么都没变）', () => {
    const w = fullWorld(nations());
    const copy = (x: World): World => ({
      ...x,
      causes: { ...x.causes, land: x.causes.land.slice(), province: x.causes.province.slice() },
      derived: { ...x.derived, dominant: x.derived.dominant.slice(), elevation: x.derived.elevation.slice(), tMean: x.derived.tMean.slice(), discharge: x.derived.discharge.slice(), lake: x.derived.lake.slice() },
    });
    const b = { ...w, small: { ...w.small } };
    expect(describeChange(w, b)).toEqual(describeChange(w, copy(b)));
    expect(describeChange(w, b)).toEqual({ cells: [], detail: '' });
  });

  it('档案里能选的政体：资源库的那一份缓存以后与以前每次查的相同', () => {
    const eng = nations();
    const w = fullWorld(eng);
    const lib = library.value;
    for (const m of Object.values(w.small.countries!).slice(0, 5)) {
      const era = worldEra(w.small);
      const list = eraGovernments(w.small, era);
      const rest = worldGovernments(w.small).filter((g) => !list.some((x) => x.id === g.id));
      const all: { gov: Government; path?: string[] }[] = [...list, ...rest].map((gov) => ({ gov }));
      const cur = w.small.content?.government?.[m.government] as Government | undefined;
      if (cur && !all.some((g) => g.gov.id === cur.id)) all.unshift({ gov: cur });
      const selectable = librarySelectable(w.small, lib, 'governments');
      for (const x of itemsInPacks<Government>(w.small.human ? stampedPacks(w.small) : [], lib, 'governments')) {
        if (!all.some((g) => g.gov.id === x.item.id) && selectable(x.item.id, x.path)) all.push({ gov: x.item, path: x.path });
      }
      expect(JSON.stringify(governmentChoices(w, m.government, lib))).toBe(JSON.stringify(all));
    }
  });
});

// ---------- 图形 ----------

function oldSameNums(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function oldSameShape(a: Shape, b: Shape): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Shape)[]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (k === 'points') {
      const p = x as [number, number][] | undefined;
      const q = y as [number, number][] | undefined;
      if (!p || !q || p.length !== q.length) return false;
      for (let i = 0; i < p.length; i++) if (p[i] !== q[i] && (p[i][0] !== q[i][0] || p[i][1] !== q[i][1])) return false;
      continue;
    }
    if (k === 'cells' || k === 'flow' || k === 'mul') {
      if (!oldSameNums(x as number[] | undefined, y as number[] | undefined)) return false;
      continue;
    }
    return false;
  }
  return true;
}

// 第七十九轮的 drawShape（除了河）：每个图形都设颜色、线宽、虚线，画完回到实线
function oldDrawShape(ctx: CanvasRenderingContext2D, sh: Shape, unit: number) {
  const color = sh.color ?? 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = (sh.width ?? 1.5) * unit;
  ctx.setLineDash(sh.dashed ? [6 * unit, 4 * unit] : []);
  if (sh.kind === 'circle' && sh.x !== undefined && sh.y !== undefined && sh.r !== undefined) {
    ctx.beginPath();
    ctx.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2);
    if (sh.fill) ctx.fill();
    ctx.stroke();
  } else if ((sh.kind === 'line' || sh.kind === 'arrow') && sh.points && sh.points.length > 1) {
    ctx.beginPath();
    sh.points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    if (sh.kind === 'arrow') {
      const [x1, y1] = sh.points[sh.points.length - 1];
      const [x0, y0] = sh.points[sh.points.length - 2];
      const a = Math.atan2(y1 - y0, x1 - x0);
      const hs = 12 * unit;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - hs * Math.cos(a - 0.4), y1 - hs * Math.sin(a - 0.4));
      ctx.lineTo(x1 - hs * Math.cos(a + 0.4), y1 - hs * Math.sin(a + 0.4));
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
}

// 只记画出来的：每次 fill、stroke 时的路径与那时画布的状态（颜色、线宽、虚线）
function recorder() {
  const ops: string[] = [];
  let path: string[] = [];
  const st = { strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, dash: [] as number[] };
  const ctx = {
    set strokeStyle(v: string) {
      st.strokeStyle = v;
    },
    set fillStyle(v: string) {
      st.fillStyle = v;
    },
    set lineWidth(v: number) {
      st.lineWidth = v;
    },
    setLineDash: (d: number[]) => (st.dash = [...d]),
    beginPath: () => (path = []),
    moveTo: (x: number, y: number) => path.push(`M${x},${y}`),
    lineTo: (x: number, y: number) => path.push(`L${x},${y}`),
    arc: (...a: number[]) => path.push(`A${a.join(',')}`),
    closePath: () => path.push('Z'),
    fill: () => ops.push(`fill ${path.join(' ')} ${st.fillStyle}`),
    stroke: () => ops.push(`stroke ${path.join(' ')} ${st.strokeStyle} ${st.lineWidth} [${st.dash.join(',')}]`),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, st };
}

describe('图形', () => {
  const w = fullWorld(nations());
  const stars = capitalShapes(w, 1500, Number(Object.keys(w.small.countries!)[2]));
  const ring: Shape = { kind: 'circle', x: 0.3, y: 0.4, r: 0.02, dashed: true };
  const arrow: Shape = { kind: 'arrow', points: [[0.1, 0.1], [0.2, 0.25], [0.3, 0.2]], color: 'rgba(255, 225, 77, 0.95)', width: 2, dashed: true };
  const shapes: Shape[] = [...stars.slice(0, 60), ring, ...stars.slice(60, 90), arrow, { kind: 'line', points: [[0, 0], [1, 1]] }, ...stars.slice(90)];

  it('比较两个图形：与以前把键并成 Set 的相同', () => {
    const variants: Shape[] = [];
    for (const s of shapes.slice(0, 40)) variants.push(s, { ...s }, { ...s, color: 'red' }, { ...s, width: (s.width ?? 1) + 1 }, { ...s, dashed: undefined }, { ...s, fill: true }, { ...s, cells: [1, 2] }, { kind: s.kind } as Shape);
    variants.push({ kind: 'cells', cells: [1, 2, 3] }, { kind: 'cells', cells: [1, 2, 3] }, { kind: 'cells', cells: [1, 2] }, { kind: 'line', points: [[0, 0], [1, 1]], label: undefined } as Shape);
    for (const a of variants) for (const b of variants.slice(0, 120)) expect(sameShape(a, b)).toBe(oldSameShape(a, b));
  });

  it('画几百个首都的星：每次 fill、stroke 时的路径、颜色、线宽、虚线与以前一个个都设的相同', () => {
    const unit = 1 / 1500;
    const a = recorder();
    for (const sh of shapes) oldDrawShape(a.ctx, sh, unit);
    const b = recorder();
    // 一遍开始前画布上是别的状态（上一段画的）：照样从第一个图形起全部设对
    b.st.dash = [3, 3];
    b.st.lineWidth = 9;
    resetPen();
    for (const sh of shapes) drawShape(b.ctx, w, sh, unit, { scale: 1, color: '#000' }, null as never);
    expect(b.ops).toEqual(a.ops);
    expect(b.ops.length).toBeGreaterThan(300);
    // 画完的状态也一样（后面画地名接着用）
    expect(b.st).toEqual(a.st);
  });
});
