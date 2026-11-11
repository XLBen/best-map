import { describe, expect, it } from 'vitest';
import type { Command } from './commands';
import type { Engine } from './engine';
import { builtinPacks } from './packs/builtin-tree';
import { type LossKey, regenLoss, removalCounts } from './regen-loss';
import { continents, generateHuman, snapshot } from './testing/fixtures';

// 第九十八轮：重新生成之前数“会换掉多少手改的东西”。数出来的要和真的重新生成前后比出来的一致：
//   - 刚生成的世界（没有手改）每一种重新生成都数出零——界面不问；改地形时跟着挪的国界不算手改；
//   - 手改一批之后，每一种重新生成：数出来的 = 真的做一遍以后没留住的那些手改；留住的（keepManual、keepLocked、锁定的省、
//     自己放的城市……）不在数里，做完以后也确实还在

const groups = () => ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => ({ id: n.id, weight: n.weight ?? 1 }));

// 2500 格的大陆，带省份、人文、国家、城市、道路、地标
const fresh = () =>
  snapshot('regen-loss', () => {
    const e = continents({ cells: 2500, provinces: true });
    generateHuman(e, 'medieval', groups(), { countries: {}, settlements: {} });
    return e;
  });

const history = (e: Engine) => e.toDoc().commands;
const loss = (e: Engine, cmd: Command): Partial<Record<LossKey, number>> => Object.fromEntries(regenLoss(e.world, cmd, history(e)).map((l) => [l.key, l.count]));

const cellsOfCountry = (e: Engine, id: number) => {
  const out: number[] = [];
  const c = e.world.causes.country!;
  for (let i = 0; i < c.length; i++) if (c[i] === id) out.push(i);
  return out;
};
const cellsOfProvince = (e: Engine, id: number) => {
  const out: number[] = [];
  const p = e.world.causes.province;
  for (let i = 0; i < p.length; i++) if (p[i] === id) out.push(i);
  return out;
};
const allCells = (e: Engine) => Array.from({ length: e.world.mesh.n }, (_, i) => i);

// 界面上有的每一种重新生成（和几条引擎认、界面没有按钮的）
const REGENS = (e: Engine): Record<string, Command> => ({
  人文: { op: 'regenerate_human' },
  '人文和国家': { op: 'regenerate_human', countries: {} },
  '人文、不留手改的格': { op: 'regenerate_human', keepManual: false, countries: {} },
  '人文，整个换掉': { op: 'generate_human', packs: [['medieval']], groups: groups().map((g) => g.id), countries: {}, settlements: {} },
  国家: { op: 'regenerate_countries' },
  '国家，锁定的也换': { op: 'regenerate_countries', keepLocked: false },
  '国家，整个换掉': { op: 'generate_countries' },
  城市与地标: { op: 'regenerate_settlements' },
  '城市与地标，整个换掉': { op: 'generate_settlements' },
  城市: { op: 'regenerate_cities' },
  '城市，锁定的也换': { op: 'regenerate_cities', keepLocked: false },
  '城市，整个换掉': { op: 'generate_cities' },
  '道路，整个换掉': { op: 'generate_roads' },
  道路: { op: 'regenerate_roads' },
  地标: { op: 'generate_landmarks' },
  '地标，整个换掉': { op: 'generate_landmarks', keepManual: false },
  省份: { op: 'generate_provinces', seed: 7 },
  '省份，一片': { op: 'regenerate_provinces', cells: allCells(e) },
  一步做完: { op: 'batch', commands: [{ op: 'generate_provinces', seed: 7 }, { op: 'regenerate_human', countries: {} }] },
});

describe('没有手改：每一种重新生成都数出零', () => {
  it('刚生成的世界', () => {
    const e = fresh();
    for (const [name, cmd] of Object.entries(REGENS(e))) expect(loss(e, cmd), name).toEqual({});
    const g = e.world.small.human!.groups[0];
    expect(loss(e, { op: 'move_hearth', group: g, cell: cellsOfCountry(e, 1)[0] })).toEqual({});
  });

  it('只是锁定、解锁，或者改地形时国界跟着挪：不算手改', () => {
    const e = fresh();
    const ids = Object.keys(e.world.small.countries!).map(Number);
    e.exec({ op: 'set_country', id: ids[0], patch: { locked: true } });
    e.exec({ op: 'set_country', id: ids[0], patch: { locked: false } });
    const p = Object.keys(e.world.small.provinces).map(Number).find((id) => e.world.small.provinces[id].land)!;
    e.exec({ op: 'set_province', id: p, locked: true });
    e.exec({ op: 'set_province', id: p, locked: false });
    // 在一国的海岸外画一圈陆地：新陆地归旁边的国家（repairCountries），和生成时记的不一样了
    const { mesh, causes } = e.world;
    const shore: number[] = [];
    for (let i = 0; i < mesh.n && shore.length < 12; i++) {
      if (causes.land[i]) continue;
      for (let k = mesh.off[i]; k < mesh.off[i + 1]; k++) if (causes.country![mesh.adj[k]] >= 0) {
        shore.push(i);
        break;
      }
    }
    e.exec({ op: 'paint_land', cells: shore, t: shore.map(() => 0), mode: 'land' });
    expect(shore.some((i) => e.world.causes.country![i] >= 0)).toBe(true);
    for (const [name, cmd] of Object.entries(REGENS(e))) expect(loss(e, cmd), name).toEqual({});
  });
});

// 一处手改：动过哪几样（按种类），和“重新生成之后它还在不在”
interface Edit {
  name: string;
  touches: Partial<Record<LossKey, readonly number[]>>;
  survives: (after: Engine) => boolean;
}

function edited() {
  const e = fresh();
  const w = () => e.world;
  const edits: Edit[] = [];
  const countries = Object.keys(w().small.countries!).map(Number).sort((a, b) => a - b);
  // 够大的几国（各拿几格出来）
  const big = countries.filter((id) => cellsOfCountry(e, id).length >= 12);
  const [A, B, C, D, E, F, G] = big;
  expect(G).toBeDefined();

  // ---- 发源地（先做：拖发源地会跟着重算自动的城市） ----
  const group = w().small.human!.groups[0];
  const hearthCell = cellsOfCountry(e, A).find((i) => w().derived.lake[i] !== 1)!;
  e.exec({ op: 'move_hearth', group, cell: hearthCell });
  edits.push({ name: '拖发源地', touches: { hearths: [0] }, survives: (a) => a.world.small.human!.hearths.some((h) => h.locked && h.group === group && !h.culture && h.cell === hearthCell) });

  // ---- 人口 ----
  const popCells = cellsOfCountry(e, C).filter((i) => (w().causes.popTotal?.[i] ?? 0) > 0 && w().derived.lake[i] !== 1).slice(0, 9);
  e.exec({ op: 'paint_pop', cells: popCells, mode: 'count', factor: 3 });
  const manual: number[] = [];
  w().causes.popManual!.forEach((v, i) => v === 1 && manual.push(i));
  expect(manual.length).toBeGreaterThan(0);
  const popWas = manual.map((i) => w().causes.popTotal![i]);
  edits.push({ name: '人口笔刷', touches: { pop: manual }, survives: (a) => manual.every((i, k) => a.world.causes.popManual![i] === 1 && a.world.causes.popTotal![i] === popWas[k]) });

  // ---- 国家 ----
  const moved = cellsOfCountry(e, A).slice(0, 4);
  e.exec({ op: 'paint_country', cells: moved, country: B });
  const nameOfB = w().small.countries![B].name;
  edits.push({ name: '涂领土', touches: { borders: [A, B] }, survives: (a) => moved.every((i) => a.world.small.countries?.[a.world.causes.country![i]]?.name === nameOfB) });
  e.exec({ op: 'set_country', id: C, patch: { name: '测试之国' } });
  edits.push({ name: '改国名', touches: { countries: [C] }, survives: (a) => Object.values(a.world.small.countries ?? {}).some((m) => m.name === '测试之国') });
  e.exec({ op: 'set_country', id: D, patch: { color: '#123456' } });
  e.exec({ op: 'set_country', id: D, patch: { locked: true } });
  edits.push({ name: '换颜色并锁定', touches: { countries: [D] }, survives: (a) => a.world.small.countries?.[D]?.color === '#123456' });
  const cap = cellsOfCountry(e, E).find((i) => i !== w().small.countries![E].capitalCell && w().derived.lake[i] !== 1)!;
  e.exec({ op: 'move_capital', id: E, cell: cap });
  edits.push({ name: '挪首都', touches: { countries: [E] }, survives: (a) => a.world.small.countries?.[E]?.capitalLocked === true && a.world.small.countries[E].capitalCell === cap });
  // 只是锁定：不算手改
  e.exec({ op: 'set_country', id: F, patch: { locked: true } });
  const carved = cellsOfCountry(e, G).slice(0, 3);
  e.exec({ op: 'new_country', cells: carved, name: '新立之国' });
  const N = Math.max(...Object.keys(w().small.countries!).map(Number));
  edits.push({ name: '新建国家', touches: { borders: [N, G] }, survives: (a) => Object.values(a.world.small.countries ?? {}).some((m) => m.name === '新立之国') });

  // ---- 城市 ----
  const auto = () => Object.values(w().small.cities!).filter((c) => c.auto && !c.locked).sort((a, b) => a.id - b.id);
  const [X, Y, Z, V] = auto().map((c) => c.id);
  e.exec({ op: 'set_city', id: X, patch: { description: '甲城的简介' } });
  edits.push({ name: '城市写简介', touches: { cities: [X] }, survives: (a) => Object.values(a.world.small.cities ?? {}).some((c) => c.description === '甲城的简介') });
  e.exec({ op: 'set_city', id: Y, patch: { name: '乙城' } });
  edits.push({ name: '城市改名（不再算自动的）', touches: { cities: [Y] }, survives: (a) => Object.values(a.world.small.cities ?? {}).some((c) => c.name === '乙城') });
  const taken = new Set(Object.values(w().small.cities!).map((c) => c.cell));
  const { mesh, causes, derived } = w();
  const zc = w().small.cities![Z].cell;
  let free = -1;
  for (let k = mesh.off[zc]; k < mesh.off[zc + 1] && free < 0; k++) if (causes.land[mesh.adj[k]] && derived.lake[mesh.adj[k]] !== 1 && !taken.has(mesh.adj[k])) free = mesh.adj[k];
  expect(free).toBeGreaterThanOrEqual(0);
  e.exec({ op: 'move_city', id: Z, cell: free });
  edits.push({ name: '挪城市', touches: { cities: [Z] }, survives: (a) => a.world.small.cities?.[Z]?.cell === free });
  e.exec({ op: 'set_city', id: V, patch: { description: '丁城的简介', locked: true } });
  edits.push({ name: '城市写简介并锁定', touches: { cities: [V] }, survives: (a) => Object.values(a.world.small.cities ?? {}).some((c) => c.description === '丁城的简介') });
  const spot = cellsOfCountry(e, B).find((i) => derived.lake[i] !== 1 && !Object.values(w().small.cities!).some((c) => c.cell === i))!;
  e.exec({ op: 'add_city', cell: spot, name: '戊城' });
  const U = Math.max(...Object.keys(w().small.cities!).map(Number));
  edits.push({ name: '自己放城市', touches: { cities: [U] }, survives: (a) => Object.values(a.world.small.cities ?? {}).some((c) => c.name === '戊城') });

  // ---- 道路：把一条自动的改个名字（改过就不算自动的了） ----
  const road = Object.values(w().small.roads!).sort((a, b) => a.id - b.id)[0];
  e.exec({ op: 'set_road', id: road.id, patch: { name: '官道' } });
  edits.push({ name: '道路改名', touches: { roads: [road.id] }, survives: (a) => Object.values(a.world.small.roads ?? {}).some((r) => r.name === '官道') });

  // ---- 地标 ----
  const marks = Object.values(w().small.landmarks!).filter((l) => l.auto).sort((a, b) => a.id - b.id);
  e.exec({ op: 'set_landmark', id: marks[0].id, patch: { description: '甲地标的简介' } });
  edits.push({ name: '地标写简介', touches: { landmarks: [marks[0].id] }, survives: (a) => Object.values(a.world.small.landmarks ?? {}).some((l) => l.description === '甲地标的简介') });
  e.exec({ op: 'set_landmark', id: marks[1].id, patch: { name: '乙地标' } });
  edits.push({ name: '地标改名（不再算自动的）', touches: { landmarks: [marks[1].id] }, survives: (a) => Object.values(a.world.small.landmarks ?? {}).some((l) => l.name === '乙地标') });

  // ---- 省份 ----
  const landProv = Object.keys(w().small.provinces)
    .map(Number)
    .filter((id) => w().small.provinces[id].land && w().small.provinces[id].kind === 'land' && cellsOfProvince(e, id).length >= 4)
    .sort((a, b) => a - b);
  const [P1, P2, P3, P4, P5] = landProv;
  e.exec({ op: 'set_province', id: P1, name: '甲省' });
  edits.push({ name: '改省名', touches: { provinces: [P1] }, survives: (a) => Object.values(a.world.small.provinces).some((m) => m.name === '甲省') });
  e.exec({ op: 'set_province', id: P2, color: '#654321' });
  edits.push({ name: '省份换颜色', touches: { provinces: [P2] }, survives: (a) => Object.values(a.world.small.provinces).some((m) => m.color === '#654321') });
  e.exec({ op: 'set_province', id: P3, name: '丙省' });
  e.exec({ op: 'set_province', id: P3, locked: true });
  edits.push({ name: '改省名并锁定', touches: { provinces: [P3] }, survives: (a) => a.world.small.provinces[P3]?.name === '丙省' });
  e.exec({ op: 'split_province', id: P4 });
  const Q = Math.max(...Object.keys(w().small.provinces).map(Number));
  const half = cellsOfProvince(e, Q);
  edits.push({
    name: '拆分省份',
    touches: { provinces: [P4, Q] },
    survives: (a) => {
      const p = a.world.causes.province[half[0]];
      return half.every((i) => a.world.causes.province[i] === p) && cellsOfProvince(a, p).length === half.length;
    },
  });
  // 只是锁定：不算手改
  e.exec({ op: 'set_province', id: P5, locked: true });
  return { e, edits, ids: { P1, P4, Q, group } };
}

// 真的做一遍：没留住的那些手改动过的，按种类各有几个
function really(e: Engine, edits: readonly Edit[], cmd: Command): { lost: Partial<Record<LossKey, number>>; kept: string[]; gone: string[] } {
  const after = e.clone();
  after.exec(cmd);
  const sets: Partial<Record<LossKey, Set<number>>> = {};
  const kept: string[] = [];
  const gone: string[] = [];
  for (const x of edits) {
    if (x.survives(after)) {
      kept.push(x.name);
      continue;
    }
    gone.push(x.name);
    for (const [k, ids] of Object.entries(x.touches) as [LossKey, readonly number[]][]) for (const id of ids) (sets[k] ??= new Set()).add(id);
  }
  return { lost: Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s!.size])), kept, gone };
}

describe('手改之后：数出来的和真的重新生成前后比出来的一致', () => {
  const { e, edits, ids } = edited();
  const cases: Record<string, Command> = {
    ...REGENS(e),
    '人文，换掉一个文化组': { op: 'regenerate_human', groups: e.world.small.human!.groups.filter((g) => g !== ids.group) },
    '省份，手改过的那几个': { op: 'regenerate_provinces', cells: [ids.P1, ids.P4, ids.Q].flatMap((p) => cellsOfProvince(e, p)) },
    拖发源地: { op: 'move_hearth', group: e.world.small.human!.groups[1], cell: cellsOfCountry(e, Object.keys(e.world.small.countries!).map(Number)[0])[0] },
  };
  for (const [name, cmd] of Object.entries(cases)) {
    it(name, () => {
      const said = loss(e, cmd);
      const { lost } = really(e, edits, cmd);
      expect(said).toEqual(lost);
    });
  }

  it('每一种的数（钉住：改了规则要看得见）', () => {
    const all = Object.fromEntries(Object.entries(cases).map(([name, cmd]) => [name, loss(e, cmd)]));
    expect(all).toMatchInlineSnapshot(`
      {
        "一步做完": {
          "borders": 4,
          "cities": 2,
          "countries": 2,
          "landmarks": 1,
          "provinces": 4,
        },
        "人文": {
          "cities": 2,
          "landmarks": 1,
        },
        "人文、不留手改的格": {
          "borders": 4,
          "cities": 2,
          "countries": 2,
          "landmarks": 1,
          "pop": 9,
        },
        "人文和国家": {
          "borders": 4,
          "cities": 2,
          "countries": 2,
          "landmarks": 1,
        },
        "人文，换掉一个文化组": {
          "cities": 2,
          "hearths": 1,
          "landmarks": 1,
        },
        "人文，整个换掉": {
          "borders": 4,
          "cities": 5,
          "countries": 3,
          "hearths": 1,
          "landmarks": 2,
          "pop": 9,
          "roads": 1,
        },
        "国家": {
          "borders": 4,
          "cities": 2,
          "countries": 2,
          "landmarks": 1,
        },
        "国家，整个换掉": {
          "borders": 4,
          "cities": 2,
          "countries": 3,
          "landmarks": 1,
        },
        "国家，锁定的也换": {
          "borders": 4,
          "cities": 2,
          "countries": 3,
          "landmarks": 1,
        },
        "地标": {
          "landmarks": 1,
        },
        "地标，整个换掉": {
          "landmarks": 2,
        },
        "城市": {
          "cities": 2,
        },
        "城市与地标": {
          "cities": 2,
          "landmarks": 1,
        },
        "城市与地标，整个换掉": {
          "cities": 5,
          "landmarks": 2,
          "roads": 1,
        },
        "城市，整个换掉": {
          "cities": 5,
        },
        "城市，锁定的也换": {
          "cities": 3,
        },
        "拖发源地": {
          "cities": 2,
          "landmarks": 1,
        },
        "省份": {
          "provinces": 4,
        },
        "省份，一片": {
          "provinces": 4,
        },
        "省份，手改过的那几个": {
          "provinces": 3,
        },
        "道路": {},
        "道路，整个换掉": {
          "roads": 1,
        },
      }
    `);
  });

  it('留着的不算：只重新生成人文时手改的格、国界、国名都还在；锁定的国家、省份、城市一直在', () => {
    const r = really(e, edits, { op: 'regenerate_human' });
    expect(r.kept).toEqual(expect.arrayContaining(['拖发源地', '人口笔刷', '涂领土', '改国名', '换颜色并锁定', '挪首都', '新建国家', '城市改名（不再算自动的）', '城市写简介并锁定', '自己放城市', '道路改名', '地标改名（不再算自动的）', '改省名', '拆分省份']));
    expect(r.gone.sort()).toEqual(['地标写简介', '城市写简介', '挪城市'].sort());
    const c = really(e, edits, { op: 'regenerate_countries' });
    expect(c.kept).toEqual(expect.arrayContaining(['换颜色并锁定', '人口笔刷']));
    expect(c.gone).toEqual(expect.arrayContaining(['涂领土', '改国名', '挪首都', '新建国家']));
    const p = really(e, edits, { op: 'generate_provinces', seed: 7 });
    expect(p.kept).toContain('改省名并锁定');
    expect(p.gone).toEqual(expect.arrayContaining(['改省名', '省份换颜色', '拆分省份']));
  });

  it('第一次“生成”也数：删了人文以后自己改过的地标还在，连城市地标一起生成人文时会被换掉', () => {
    const one = fresh();
    const mark = Object.values(one.world.small.landmarks!).sort((a, b) => a.id - b.id)[0];
    one.exec({ op: 'set_landmark', id: mark.id, patch: { name: '自己起名的地标' } });
    one.exec({ op: 'remove_human' });
    expect(one.world.small.human).toBeUndefined();
    expect(Object.values(one.world.small.landmarks!).some((l) => l.name === '自己起名的地标')).toBe(true);
    const ids = groups().map((g) => g.id);
    const withAll: Command = { op: 'generate_human', packs: [['medieval']], groups: ids, countries: {}, settlements: {} };
    const peopleOnly: Command = { op: 'generate_human', packs: [['medieval']], groups: ids };
    expect(loss(one, withAll)).toEqual({ landmarks: 1 });
    // 只生成人口和文化（不带城市）：地标不动
    expect(loss(one, peopleOnly)).toEqual({});
    const a = one.clone();
    a.exec(withAll);
    expect(Object.values(a.world.small.landmarks ?? {}).some((l) => l.name === '自己起名的地标')).toBe(false);
    const b = one.clone();
    b.exec(peopleOnly);
    expect(Object.values(b.world.small.landmarks ?? {}).some((l) => l.name === '自己起名的地标')).toBe(true);
  });

  it('别的手改哪一种重新生成都不碰：改过的地名、格的名字和备注、画的地形类别', () => {
    const one = fresh();
    const w = one.world;
    const f = w.derived.features.find((x) => /^\w+:\d+$/.test(x.key))!;
    one.exec({ op: 'rename_feature', key: f.key, name: '自己起的地名' });
    const cell = cellsOfCountry(one, 1)[0];
    one.exec({ op: 'set_cell', cell, name: '自己起的格名', note: '备注' });
    const cls = Object.keys(one.world.small.content?.terrainClass ?? {})[0];
    const painted = cellsOfCountry(one, 2).slice(0, 3);
    one.exec({ op: 'set_cell_class', cells: painted, class: cls });
    const code = one.world.causes.terrainClass![painted[0]];
    expect(code).toBeGreaterThan(0);
    for (const [name, cmd] of Object.entries(REGENS(one))) {
      const after = one.clone();
      after.exec(cmd);
      expect(after.world.derived.features.find((x) => x.key === f.key)?.name, name).toBe('自己起的地名');
      expect(after.world.small.cells?.[cell], name).toMatchObject({ name: '自己起的格名', note: '备注' });
      expect(painted.every((i) => after.world.causes.terrainClass![i] === code), name).toBe(true);
    }
  });

  it('没有命令记录时只按世界里的记号数：不比有记录时多出没有的，记号认得出的照样数', () => {
    const cmd: Command = { op: 'regenerate_countries' };
    const bare = Object.fromEntries(regenLoss(e.world, cmd, null).map((l) => [l.key, l.count]));
    // 涂的领土、新建的国家认得出（和生成时不一样的格）、挪过的首都认得出（capitalLocked）；改名、换颜色认不出
    expect(bare.borders).toBe(loss(e, cmd).borders);
    expect(bare.countries).toBe(1);
  });

  it('撤销了手改就不数了', () => {
    const one = fresh();
    const id = Object.keys(one.world.small.countries!).map(Number)[0];
    one.exec({ op: 'set_country', id, patch: { name: '临时' } });
    expect(loss(one, { op: 'regenerate_countries' })).toEqual({ countries: 1 });
    one.undo();
    expect(loss(one, { op: 'regenerate_countries' })).toEqual({});
  });
});

describe('删除之前数一起没了的', () => {
  it('删除人文：国家、城市、道路的个数和真的删掉的一样；地标留着', () => {
    const { e } = edited();
    const s = e.world.small;
    const n = removalCounts(e.world, { op: 'remove_human' });
    expect(n.countries).toBe(Object.keys(s.countries!).length);
    expect(n.cities).toBe(Object.keys(s.cities!).length);
    expect(n.roads).toBe(Object.keys(s.roads!).length);
    expect(n.archive).toBeGreaterThan(0);
    expect(n.pop).toBeGreaterThan(0);
    expect(n.landmarks).toBe(0);
    const marks = Object.keys(s.landmarks!).length;
    e.exec({ op: 'remove_human' });
    expect(e.world.small.countries).toBeUndefined();
    expect(e.world.small.cities).toBeUndefined();
    expect(e.world.small.roads).toBeUndefined();
    expect(e.world.small.archive).toBeUndefined();
    expect(Object.keys(e.world.small.landmarks!).length).toBe(marks);
  });

  it('删除国家：只数国家和档案；删除城市：道路一起', () => {
    const e = fresh();
    const s = e.world.small;
    const c = removalCounts(e.world, { op: 'remove_countries' });
    expect(c).toMatchObject({ countries: Object.keys(s.countries!).length, cities: 0, roads: 0, pop: 0 });
    const t = removalCounts(e.world, { op: 'remove_settlements', cities: true });
    expect(t).toMatchObject({ countries: 0, cities: Object.keys(s.cities!).length, roads: Object.keys(s.roads!).length, landmarks: 0 });
    expect(removalCounts(e.world, { op: 'remove_settlements', landmarks: true })).toMatchObject({ cities: 0, roads: 0, landmarks: Object.keys(s.landmarks!).length });
  });
});

describe('地形的“重画”不换掉手画的', () => {
  it('圈里手画的陆地、堆的山是加在生成的地形上面的：重画之后原样还在', () => {
    const e = continents({ cells: 2500 });
    const { mesh, causes } = e.world;
    const sea: number[] = [];
    for (let i = 0; i < mesh.n && sea.length < 10; i++) if (!causes.land[i]) sea.push(i);
    e.exec({ op: 'paint_land', cells: sea, t: sea.map(() => 0), mode: 'land' });
    const land: number[] = [];
    for (let i = 0; i < mesh.n && land.length < 10; i++) if (e.world.causes.land[i] && !sea.includes(i)) land.push(i);
    e.exec({ op: 'paint_relief', cells: land, t: land.map(() => 0), strength: 1 });
    const before = { land: e.world.causes.landDelta.slice(), up: e.world.causes.upliftDelta.slice() };
    expect(sea.some((i) => before.land[i] !== 0)).toBe(true);
    expect(land.some((i) => before.up[i] !== 0)).toBe(true);
    e.exec({ op: 'reroll_region', x: mesh.x[sea[0]], y: mesh.y[sea[0]], radius: 2000, variant: 1 });
    expect(e.world.causes.landDelta).toEqual(before.land);
    expect(e.world.causes.upliftDelta).toEqual(before.up);
  });
});
