import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { danglingLinks, linkTable, worldScope } from '../content/links';
import { compactWorldDoc } from '../compact';
import { digest, worldDigest } from '../digest';
import { Engine } from '../engine';
import { builtinPacks, worldPartsOf } from '../packs/builtin-tree';
import { addDimensionCommand, dimensionOptions } from '../packs/add-dimension';
import { ERA_PACKS } from '../packs/eras';
import { type PackRoot, packImportCommands } from '../packs/import';
import { librarySwitchPlan, worldLibrary } from '../packs/switch';
import { NO_CURRENTS, engineFor, humanDigest, snapshot } from '../testing/fixtures';
import type { World } from '../world';
import { countryList } from './countries';
import { allCountryStats } from './country-layers';
import { MAX_DIMENSIONS, composedDims, cultureById, dimensionValues, filledDims, worldCultures, worldDimensions, worldEra } from './era';
import { fillPopulation } from './add-dimension';
import { SLOTS } from './groups';
import { cellPopulation, humanLayers, humanLegend, valueLayer } from './layers';

// 第五十四轮：给已有的世界加一个变量。门槛：只算新变量——文化、国家、城市、地名逐值不变，每格每个文化的占比、总人数逐值相同；
// 撤销、重做、重放一致；之后重新生成国家，政体用得上它。没加变量的世界不走这条路（r29、libraries-digests、golden-full 没有重录）

const LIB = builtinPacks();
const ROOTS: PackRoot[] = LIB.map((p) => ({ key: p.id, pack: p }));
const groupsOf = (id: string) => ERA_PACKS.get(id)!.cultures.map(([g, w]) => ({ id: g, weight: w }));

function build(id: string): Engine {
  const eng = engineFor({ cells: 6000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
  for (const c of packImportCommands(LIB, { packs: worldPartsOf(id), groups: [] }, eng.world)) eng.exec(c);
  eng.exec(NO_CURRENTS);
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
  const groups = groupsOf(id);
  for (const c of packImportCommands(LIB, { packs: [[id]], groups: groups.map((g) => g.id) }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [[id]], groups: groups.map((g) => g.id), countries: {}, settlements: {} });
  return eng;
}
const world = (id: string): Engine => snapshot(`add-dimension:${id}`, () => build(id));

const add = (eng: Engine, dim: string, from?: string): Engine => {
  const cmd = addDimensionCommand(ROOTS, eng.world, dim, from);
  if (!cmd) throw new Error(`没有 ${dim}`);
  eng.exec(cmd);
  return eng;
};

// 不该变的摘要：国家、城市、道路、地标、省份、地名、人口的推导（文化圈、文化组、最近的文化、密度）
function untouched(w: World): Record<string, string> {
  const { pop: _p, popGroups: _g, human: _h, ...rest } = humanDigest(w);
  const { nextGroup: _n, ...human } = w.small.human!;
  const d = w.derived;
  const c = w.causes;
  return { ...rest, human: digest(human), popTotal: digest(c.popTotal!), popManual: digest(c.popManual ?? null), popAutoTotal: digest(c.popAutoTotal ?? null), popCulture: digest(d.popCulture!), popCultureGroup: digest(d.popCultureGroup!), cultureNear: digest(d.cultureNear!), popDensity: digest(d.popDensity!) };
}

// 每格里按 key 合起来的占比（/255），“其他”记在 '' 里
function sumsBy(w: World, key: (t: { culture: string; values: Record<string, string> }) => string, arrays: 'pop' | 'auto' = 'pop'): Map<string, number>[] {
  const c = w.causes;
  const g = arrays === 'pop' ? c.popGroup! : c.popAutoGroup!;
  const s = arrays === 'pop' ? c.popShare! : c.popAutoShare!;
  const out: Map<string, number>[] = [];
  for (let i = 0; i < w.mesh.n; i++) {
    const m = new Map<string, number>();
    let sum = 0;
    for (let k = 0; k < SLOTS; k++) {
      const code = g[i * SLOTS + k];
      if (!code) continue;
      const name = key(w.small.popGroups![code]);
      m.set(name, (m.get(name) ?? 0) + s[i * SLOTS + k]);
      sum += s[i * SLOTS + k];
    }
    if (sum) m.set('', 255 - sum);
    out.push(m);
  }
  return out;
}
const sorted = (l: Map<string, number>[]) => l.map((m) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const byCulture = (t: { culture: string }) => t.culture;

// 旧的群体（文化 + 这几维）
const oldTuple = (dims: readonly string[]) => (t: { culture: string; values: Record<string, string> }) => [t.culture, ...dims.map((d) => t.values[d] ?? '')].join('|');

// 一维的取值在全世界各占多少（按人数，只算有这一维取值的）
function valueShares(w: World, dim: string): Map<string, number> {
  const c = w.causes;
  const out = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < w.mesh.n; i++) {
    for (let k = 0; k < SLOTS; k++) {
      const code = c.popGroup![i * SLOTS + k];
      if (!code) continue;
      const v = w.small.popGroups![code].values[dim];
      if (!v) continue;
      const p = (c.popTotal![i] * c.popShare![i * SLOTS + k]) / 255;
      out.set(v, (out.get(v) ?? 0) + p);
      total += p;
    }
  }
  for (const [k, v] of out) out.set(k, v / total);
  return out;
}

describe('文化、国家、城市都不变', () => {
  const cases: [string, string[]][] = [
    ['fantasy', ['ideology']],
    ['medieval', ['ideology']],
    ['medieval', ['nation', 'ideology', 'race']],
    // 现代已经三维：第 4、第 5 个
    ['modern', ['race', 'species']],
  ];
  for (const [id, dims] of cases) {
    it(`${id} 加 ${dims.join('、')}：摘要逐值不变，每格每个文化、每个旧群体的占比逐值相同，每格总人口逐值相同`, () => {
      const eng = world(id);
      const w0 = eng.world;
      const before = untouched(w0);
      const oldDims = worldDimensions(w0.small).map((d) => d.id);
      const cultures = sorted(sumsBy(w0, byCulture));
      const tuples = sorted(sumsBy(w0, oldTuple(oldDims)));
      const autoCultures = sorted(sumsBy(w0, byCulture, 'auto'));
      const oldLayers = oldDims.map((_, k) => digest(valueLayer(w0, k)!));
      for (const dim of dims) {
        const hit = dimensionOptions(ROOTS, eng.world.small).find((o) => o.id === dim);
        if (!hit) throw new Error(`资源库里没有 ${dim}`);
        add(eng, dim);
      }
      const w = eng.world;
      expect(untouched(w)).toEqual(before);
      expect(sorted(sumsBy(w, byCulture))).toEqual(cultures);
      expect(sorted(sumsBy(w, oldTuple(oldDims)))).toEqual(tuples);
      expect(sorted(sumsBy(w, byCulture, 'auto'))).toEqual(autoCultures);
      // 已有的维度的图层也不变（新维度排在最后，这几段的位置不动）
      oldDims.forEach((_, k) => expect(digest(valueLayer(w, k)!)).toBe(oldLayers[k]));
      expect(worldDimensions(w.small).map((d) => d.id)).toEqual([...oldDims, ...dims]);
      for (const dim of dims) expect(worldDimensions(w.small).find((d) => d.id === dim)).toMatchObject({ required: true, added: true });
    });
  }
});

describe('新变量的份额', () => {
  it('每格的人都有这一维的取值，加起来和原来一样；全世界各取值份额合起来是 1；没写倾向时大致平均', () => {
    const eng = add(world('fantasy'), 'ideology');
    const w = eng.world;
    const c = w.causes;
    for (let i = 0; i < w.mesh.n; i++) {
      for (let k = 0; k < SLOTS; k++) {
        const code = c.popGroup![i * SLOTS + k];
        if (code) expect(w.small.popGroups![code].values.ideology, `${i}`).toBeDefined();
      }
    }
    const shares = valueShares(w, 'ideology');
    let sum = 0;
    for (const v of shares.values()) sum += v;
    expect(sum).toBeCloseTo(1, 9);
    // 15 种取值，都出现；噪声成片，单个不会占太多
    const k = dimensionValues(w.small, 'ideology').length;
    expect(shares.size).toBe(k);
    for (const [id, v] of shares) {
      expect(v, id).toBeGreaterThan(0.25 / k);
      expect(v, id).toBeLessThan(2.5 / k);
    }
  });

  it('文化写了倾向时用倾向：只出现写了的取值，权重大的多', () => {
    const eng = world('medieval');
    const culture = worldCultures(eng.world.small).find((x) => x.id === eng.world.small.popGroups![1].culture)!;
    // 只给这一个文化写
    eng.exec({ op: 'set_content', kind: 'culture', id: culture.id, item: { ...culture, tendencies: { ...(culture.tendencies ?? {}), ideology: [['green', 2], 'monarchist'] } } });
    add(eng, 'ideology');
    const w = eng.world;
    const people = new Map<string, number>();
    for (let i = 0; i < w.mesh.n; i++) {
      for (let k = 0; k < SLOTS; k++) {
        const t = w.small.popGroups![w.causes.popGroup![i * SLOTS + k]];
        if (t?.culture === culture.id) people.set(t.values.ideology, (people.get(t.values.ideology) ?? 0) + (w.causes.popTotal![i] * w.causes.popShare![i * SLOTS + k]) / 255);
      }
    }
    expect([...people.keys()].sort()).toEqual(['green', 'monarchist']);
    expect(people.get('green')!).toBeGreaterThan(people.get('monarchist')! * 2);
    // 别的文化没写：按平均，什么取值都有
    expect(valueShares(w, 'ideology').size).toBeGreaterThan(2);
  });

  it('只有一格一个群体时按份额分开，占比的整数加起来不变', () => {
    const eng = add(world('antiquity'), 'ideology');
    const c = eng.world.causes;
    // 青铜与古典一维：不少格只有一个群体，加上之后要分开
    let split = 0;
    for (let i = 0; i < eng.world.mesh.n; i++) {
      let sum = 0;
      let k = 0;
      for (; k < SLOTS && c.popGroup![i * SLOTS + k]; k++) sum += c.popShare![i * SLOTS + k];
      expect(sum).toBeLessThanOrEqual(255);
      for (let a = 1; a < k; a++) expect(c.popShare![i * SLOTS + a]).toBeLessThanOrEqual(c.popShare![i * SLOTS + a - 1]);
      if (k >= 2) split++;
    }
    expect(split).toBeGreaterThan(1000);
  });
});

describe('撤销、重做、重放', () => {
  for (const [id, dim] of [['fantasy', 'ideology'], ['modern', 'race']] as const) {
    it(`${id} 加 ${dim}：撤销回到原样、重做和重放都和第一次逐值相同`, () => {
      const eng = world(id);
      const before = worldDigest(eng.world);
      add(eng, dim);
      const after = worldDigest(eng.world);
      expect(after).not.toBe(before);
      eng.undo();
      expect(worldDigest(eng.world)).toBe(before);
      eng.redo();
      expect(worldDigest(eng.world)).toBe(after);
      const doc = JSON.parse(JSON.stringify(eng.toDoc()));
      expect(worldDigest(Engine.fromDoc(doc, eng.world.mesh).world)).toBe(after);
      // 压缩世界文件：这一步留着，结果不变
      const r = compactWorldDoc(doc, { mesh: eng.world.mesh });
      expect(r.verified).toBe(true);
      expect(worldDigest(Engine.fromDoc(r.doc, eng.world.mesh).world)).toBe(after);
    });
  }

  it('失败的命令不留痕迹：重复的、没有取值的、超过上限的', () => {
    const eng = world('fantasy');
    const before = worldDigest(eng.world);
    expect(() => eng.exec({ op: 'add_dimension', dimension: { id: 'religion', label: '宗教' } })).toThrow('已经有');
    expect(() => eng.exec({ op: 'add_dimension', dimension: { id: 'nothing', label: '没有' } })).toThrow('取值');
    expect(() => eng.exec({ op: 'add_dimension', dimension: { id: 'x', label: 'x' }, era: 'no-such' })).toThrow('时代');
    expect(worldDigest(eng.world)).toBe(before);
    const era = worldEra(eng.world.small)!;
    const value = dimensionValues(eng.world.small, 'religion')[0];
    for (let k = 0; k < MAX_DIMENSIONS - era.dimensions.length; k++) {
      eng.exec({ op: 'set_content', kind: 'popValue', id: `v${k}`, item: { ...value, id: `v${k}`, dimension: `d${k}` } });
      eng.exec({ op: 'add_dimension', dimension: { id: `d${k}`, label: `d${k}` } });
    }
    expect(worldDimensions(eng.world.small).length).toBe(MAX_DIMENSIONS);
    const full = worldDigest(eng.world);
    eng.exec({ op: 'set_content', kind: 'popValue', id: 'one-more', item: { ...value, id: 'one-more', dimension: 'more' } });
    const before2 = worldDigest(eng.world);
    expect(() => eng.exec({ op: 'add_dimension', dimension: { id: 'more', label: '再多' } })).toThrow('最多');
    expect(worldDigest(eng.world)).toBe(before2);
    expect(full).not.toBe(before2);
  });

  it('笔刷、恢复自动：画一笔再恢复，回到分开之后的样子', () => {
    const eng = add(world('fantasy'), 'ideology');
    const w = eng.world;
    let cell = -1;
    for (let i = 0; i < w.mesh.n && cell < 0; i++) if (w.causes.popTotal![i] > 0) cell = i;
    const pick = () => digest([w.causes.popGroup!.slice(cell * SLOTS, cell * SLOTS + SLOTS), w.causes.popShare!.slice(cell * SLOTS, cell * SLOTS + SLOTS)]);
    const before = pick();
    eng.exec({ op: 'paint_pop', cells: [cell], mode: 'value', dimension: 'ideology', value: 'green', amount: 1 });
    expect(pick()).not.toBe(before);
    eng.exec({ op: 'restore_pop', cells: [cell] });
    const w2 = eng.world;
    expect(digest([w2.causes.popGroup!.slice(cell * SLOTS, cell * SLOTS + SLOTS), w2.causes.popShare!.slice(cell * SLOTS, cell * SLOTS + SLOTS)])).toBe(before);
  });
});

describe('撤销记录共用人口群体', () => {
  it('群体是换掉、不是就地改：冻住跑笔刷、撤销、再加一维，结果和没冻住的逐值相同；撤销记录里没有群体的字', () => {
    const run = (freeze: boolean) => {
      const eng = world('fantasy');
      const guard = () => {
        if (!freeze) return;
        for (const t of Object.values(eng.world.small.popGroups!)) {
          Object.freeze(t.values);
          Object.freeze(t);
        }
        Object.freeze(eng.world.small.popGroups);
      };
      guard();
      const cells: number[] = [];
      for (let i = 0; i < eng.world.mesh.n && cells.length < 40; i++) if (eng.world.causes.popTotal![i] > 0) cells.push(i);
      const out: string[] = [];
      eng.exec({ op: 'paint_pop', cells, mode: 'value', dimension: 'religion', value: dimensionValues(eng.world.small, 'religion')[3].id, amount: 0.5 });
      guard();
      out.push(worldDigest(eng.world));
      eng.undo();
      guard();
      out.push(worldDigest(eng.world));
      add(eng, 'ideology');
      guard();
      out.push(worldDigest(eng.world));
      eng.exec({ op: 'set_cell', cell: cells[0], note: '备注' });
      guard();
      out.push(worldDigest(eng.world));
      eng.undo();
      eng.undo();
      guard();
      out.push(worldDigest(eng.world));
      return out;
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe('群体太多时', () => {
  it('编号到上限：不再给新的，并进这个旧群体已有的分法，文化和旧群体的比例还是不变', () => {
    const eng = world('modern');
    const w = eng.world;
    const dims = worldDimensions(w.small).map((d) => d.id);
    const cultures = sorted(sumsBy(w, byCulture));
    const tuples = sorted(sumsBy(w, oldTuple(dims)));
    const free = fillCopy(eng, 1e9);
    const count = Object.keys(w.small.popGroups!).length;
    const capped = fillCopy(eng, count + 40);
    expect(Object.keys(capped.small.popGroups!).length).toBeLessThan(Object.keys(free.small.popGroups!).length);
    expect(sorted(sumsBy(capped, byCulture))).toEqual(cultures);
    expect(sorted(sumsBy(capped, oldTuple(dims)))).toEqual(tuples);
  });
});

function fillCopy(eng: Engine, maxGroups: number): World {
  const copy = eng.clone();
  const w = copy.world;
  const options = dimensionOptions(ROOTS, w.small).find((o) => o.id === 'race')!;
  const cmd = addDimensionCommand(ROOTS, w, options.id)!;
  const values = (cmd as { commands: Command[] }).commands.filter((c) => c.op !== 'add_dimension');
  for (const c of values) copy.exec(c);
  fillPopulation(copy.world, copy.world.derived, worldEra(copy.world.small)!.id, { id: 'race', label: '种族', required: true }, { maxGroups });
  return copy.world;
}

describe('界面里看得到', () => {
  it('图层、图例、格的人口、国家的人口都有新变量', () => {
    const eng = add(world('fantasy'), 'ideology');
    const w = eng.world;
    expect(humanLayers(w).map((l) => l.id)).toContain('ideology');
    expect(humanLegend(w, 'ideology').length).toBeGreaterThan(3);
    const k = worldDimensions(w.small).findIndex((d) => d.id === 'ideology');
    expect(valueLayer(w, k)!.some((x) => x > 0)).toBe(true);
    let cell = -1;
    for (let i = 0; i < w.mesh.n && cell < 0; i++) if (w.causes.popTotal![i] > 0) cell = i;
    const p = cellPopulation(w, cell)!;
    for (const g of p.groups) expect(g.values.map((v) => v.dimension)).toContain('ideology');
    const stats = allCountryStats(w);
    const first = [...stats.values()][0];
    expect(first.values.find((v) => v.dimension === 'ideology')!.items.length).toBeGreaterThan(0);
  });

  it('资源库能加的：别的库的时代的维度，世界的时代已经有的不列；取值记来源', () => {
    const eng = world('fantasy');
    const options = dimensionOptions(ROOTS, eng.world.small).map((o) => o.id);
    expect(options).toContain('ideology');
    expect(options).toContain('nation');
    expect(options).not.toContain('race');
    expect(options).not.toContain('religion');
    add(eng, 'ideology');
    expect(dimensionOptions(ROOTS, eng.world.small).map((o) => o.id)).not.toContain('ideology');
    const from = eng.world.small.origin?.popValue?.green;
    expect(from?.[0]).toBe(dimensionOptions(ROOTS, world('fantasy').world.small).find((o) => o.id === 'ideology')!.library);
    expect(danglingLinks(linkTable(worldScope(eng.world))).filter((l) => l.link.cls === 'hard')).toEqual([]);
  });

  it('同 id 不同内容的取值：改名加进来，不碰世界里的', () => {
    const eng = world('fantasy');
    const other = dimensionValues(eng.world.small, 'religion')[0];
    eng.exec({ op: 'set_content', kind: 'popValue', id: 'green', item: { ...other, id: 'green', name: '世界自己的绿' } });
    add(eng, 'ideology');
    expect((eng.world.small.content!.popValue as Record<string, { name: string; dimension: string }>).green.name).toBe('世界自己的绿');
    expect(dimensionValues(eng.world.small, 'ideology').some((v) => v.id.startsWith('green-'))).toBe(true);
  });
});

describe('重新生成国家', () => {
  const socialist = () => {
    for (const r of ROOTS) {
      const hit = findItem(r, 'governments', 'socialist-republic');
      if (hit) return hit as Record<string, unknown>;
    }
    throw new Error('没有社会主义共和国');
  };

  it('奇幻世界加意识形态、加社会主义政体：加的时候国家不变，重新生成国家才有这种国家；档案里的派系用得上', () => {
    const eng = world('fantasy');
    add(eng, 'ideology');
    const gov = socialist();
    const factions = ROOTS.flatMap((r) => (gov.factions as string[]).map((id) => findItem(r, 'factions', id))).filter(Boolean) as { id: string }[];
    for (const f of new Map(factions.map((x) => [x.id, x])).values()) eng.exec({ op: 'set_content', kind: 'faction', id: f.id, item: f as unknown as Record<string, unknown> });
    eng.exec({ op: 'set_content', kind: 'government', id: 'socialist-republic', item: gov });
    expect(countryList(eng.world.small).some((m) => m.government === 'socialist-republic')).toBe(false);
    eng.exec({ op: 'regenerate_countries', keepLocked: false });
    const list = countryList(eng.world.small);
    expect(list.some((m) => m.government === 'socialist-republic')).toBe(true);
    // 人还是都有意识形态
    const shares = valueShares(eng.world, 'ideology');
    expect(shares.size).toBeGreaterThan(3);
    const stats = allCountryStats(eng.world);
    const m = list.find((x) => x.government === 'socialist-republic')!;
    expect(stats.get(m.id)!.values.map((v) => v.dimension)).toContain('ideology');
  });

  it('没加新政体时，重新生成的国家、文化和没加变量的世界逐值相同；“其他”也不多', () => {
    const a = world('medieval');
    a.exec({ op: 'regenerate_countries', keepLocked: false });
    const b = add(world('medieval'), 'ideology');
    b.exec({ op: 'regenerate_countries', keepLocked: false });
    const digestOf = (e: Engine) => {
      const { pop: _p, popGroups: _g, human: _h, ...rest } = humanDigest(e.world);
      return { ...rest, popTotal: digest(e.world.causes.popTotal!), popCulture: digest(e.world.derived.popCulture!) };
    };
    expect(digestOf(b)).toEqual(digestOf(a));
    expect(sorted(sumsBy(b.world, byCulture))).toEqual(sorted(sumsBy(a.world, byCulture)));
    expect(sorted(sumsBy(b.world, oldTuple(['religion'])))).toEqual(sorted(sumsBy(a.world, oldTuple(['religion']))));
    expect(valueShares(b.world, 'ideology').size).toBeGreaterThan(3);
    // 撤销、重放
    const after = worldDigest(b.world);
    expect(worldDigest(Engine.fromDoc(b.toDoc(), b.world.mesh).world)).toBe(after);
  });

  it('手改过的格留着：重新生成后编号还对得上，恢复自动回到新的自动值；撤销、重放一样', () => {
    const eng = add(world('medieval'), 'ideology');
    let cell = -1;
    for (let i = 0; i < eng.world.mesh.n && cell < 0; i++) if (eng.world.causes.popTotal![i] > 0) cell = i;
    eng.exec({ op: 'paint_pop', cells: [cell], mode: 'value', dimension: 'ideology', value: 'green', amount: 1 });
    const painted = worldDigest(eng.world);
    eng.exec({ op: 'regenerate_countries', keepLocked: false });
    let w = eng.world;
    expect(w.causes.popManual![cell]).toBe(1);
    // 手改的这格还是全部绿色派（编号重排了，但指的还是它）
    const inCell = (arrG: Uint16Array) => Array.from(arrG.subarray(cell * SLOTS, cell * SLOTS + SLOTS)).filter(Boolean).map((g) => w.small.popGroups![g]);
    for (const t of inCell(w.causes.popGroup!)) expect(t.values.ideology).toBe('green');
    // 自动的快照里这一格的编号也都认得
    for (const t of inCell(w.causes.popAutoGroup!)) expect(t?.culture).toBeDefined();
    const after = worldDigest(w);
    expect(worldDigest(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toBe(after);
    eng.exec({ op: 'restore_pop', cells: [cell] });
    w = eng.world;
    expect(w.causes.popManual![cell]).toBe(0);
    eng.undo();
    eng.undo();
    expect(worldDigest(eng.world)).toBe(painted);
  });

  it('内置的时代都不走原地分开（六个库的默认世界结果不变）', () => {
    for (const r of ROOTS) {
      const era = eraOf(r);
      expect(filledDims(era), r.key).toEqual([]);
      expect(composedDims(era), r.key).toEqual(era.dimensions);
    }
  });
});

describe('换库碰到世界加的变量', () => {
  const switchTo = (eng: Engine, to: string) => {
    const groups = groupsOf(to);
    const plan = librarySwitchPlan(ROOTS, eng.world.small, worldLibrary(eng.world.small), to, groups.map((g) => g.id));
    eng.exec({ op: 'batch', label: '换库', commands: [...plan.imports, { op: 'regenerate_human', packs: [[to]], groups: groups.map((g) => g.id), keepManual: false, countries: {}, switchLibrary: { drop: plan.drop, rehome: plan.rehome } }] });
    return plan;
  };
  const flat = (cmds: readonly Command[]): Command[] => cmds.flatMap((c) => (c.op === 'batch' ? flat(c.commands) : [c]));

  it('新库的时代也有这一维（奇幻加意识形态 → 现代）：用新库的定义，不是后加的；和直接新建比只差多带的取值之外什么都不多', () => {
    const eng = add(world('fantasy'), 'ideology');
    const plan = switchTo(eng, 'modern');
    expect(flat(plan.imports).some((c) => c.op === 'add_dimension')).toBe(false);
    const w = eng.world;
    expect(worldEra(w.small)!.id).toBe('modern');
    const dim = worldDimensions(w.small).find((d) => d.id === 'ideology')!;
    expect(dim.added).toBeUndefined();
    expect(valueShares(w, 'ideology').size).toBeGreaterThan(3);
    expect(danglingLinks(linkTable(worldScope(w))).filter((l) => l.link.cls === 'hard')).toEqual([]);
  });

  it('新库的时代没有这一维（奇幻加意识形态 → 中世纪）：带到新时代，取值留着，人都有这一维；文化圈和没加变量换过去的相同', () => {
    const plain = world('fantasy');
    switchTo(plain, 'medieval');
    const eng = add(world('fantasy'), 'ideology');
    const before = worldDigest(eng.world);
    const plan = switchTo(eng, 'medieval');
    const carried = flat(plan.imports).filter((c) => c.op === 'add_dimension');
    expect(carried).toEqual([{ op: 'add_dimension', dimension: { id: 'ideology', label: '意识形态' }, era: 'medieval' }]);
    expect(plan.drop.some((r) => r.kind === 'popValue' && r.id === 'green')).toBe(false);
    const w = eng.world;
    expect(worldEra(w.small)!.id).toBe('medieval');
    expect(worldDimensions(w.small).find((d) => d.id === 'ideology')).toMatchObject({ added: true });
    expect(humanLayers(w).map((l) => l.id)).toContain('ideology');
    expect(valueShares(w, 'ideology').size).toBeGreaterThan(3);
    expect(digest(w.derived.popCulture!)).toBe(digest(plain.world.derived.popCulture!));
    expect(digest(w.causes.country!)).toBe(digest(plain.world.causes.country!));
    expect(danglingLinks(linkTable(worldScope(w))).filter((l) => l.link.cls === 'hard')).toEqual([]);
    // 撤销回到原样，重放一样
    const after = worldDigest(w);
    expect(worldDigest(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toBe(after);
    eng.undo();
    expect(worldDigest(eng.world)).toBe(before);
    // 再换回奇幻：还在
    eng.redo();
    const again = switchTo(eng, 'fantasy');
    expect(flat(again.imports).filter((c) => c.op === 'add_dimension')).toEqual([{ op: 'add_dimension', dimension: { id: 'ideology', label: '意识形态' }, era: 'fantasy' }]);
    expect(worldEra(eng.world.small)!.id).toBe('fantasy');
    expect(worldDimensions(eng.world.small).map((d) => d.id)).toContain('ideology');
    expect(cultureById(eng.world.small, Object.values(eng.world.small.popGroups!)[0].culture)).toBeDefined();
  });

  it('来源是旧库的取值（我的库里单独放着的）也不移出', () => {
    const eng = add(world('fantasy'), 'ideology');
    // 假装这些取值来自奇幻这个库
    const origin = { ...eng.world.small.origin, popValue: { ...eng.world.small.origin!.popValue } };
    for (const v of dimensionValues(eng.world.small, 'ideology')) origin.popValue[v.id] = ['fantasy'];
    eng.world.small.origin = origin;
    const groups = groupsOf('medieval');
    const plan = librarySwitchPlan(ROOTS, eng.world.small, 'fantasy', 'medieval', groups.map((g) => g.id));
    expect(plan.drop.filter((r) => r.kind === 'popValue' && dimensionValues(eng.world.small, 'ideology').some((v) => v.id === r.id))).toEqual([]);
  });
});

function findItem(r: PackRoot, key: string, id: string): unknown {
  let hit: unknown;
  walk(r.pack, (n) => {
    hit ??= ((n[key] as { id: string }[] | undefined) ?? []).find((x) => x.id === id);
  });
  return hit;
}
function eraOf(r: PackRoot) {
  let hit: { dimensions: { id: string; label: string }[] } | undefined;
  walk(r.pack, (n) => {
    hit ??= (n.eras as { dimensions: { id: string; label: string }[] }[] | undefined)?.[0];
  });
  return hit!;
}
function walk(n: Record<string, unknown>, f: (n: Record<string, unknown>) => void) {
  f(n);
  for (const c of (n.packs as Record<string, unknown>[] | undefined) ?? []) walk(c, f);
}
