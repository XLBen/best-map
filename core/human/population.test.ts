import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../../tools/hash';
import { type Command, CommandError } from '../commands';
import { Engine, passStats } from '../engine';
import { exportPackage } from '../export';
import { styleFor } from '../name-styles';
import { BUILTIN_CULTURES, BUILTIN_ERAS } from '../packs/eras';
import { continents, engineFor, snapshot } from '../testing/fixtures';
import { HUMAN_DERIVED, POP_DERIVED, type World } from '../world';
import {
  SLOTS,
  cellArchive,
  cellPopulation,
  classAt,
  defaultTotalPop,
  dimensionValues,
  humanLayers,
  humanLegend,
  readComp,
  registerHumanStage,
  humanStages,
  unregisterHumanStage,
  worldCultures,
  worldDimensions,
} from './index';
import { majorityCulture } from './culture-style';
import { computePopLayers } from './layers';
import { BIOME_HABITABILITY } from './habitability';

// 第二十二轮：时代、宜居度、文化圈、人口、跟着文化的地名

const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
  { id: 'steppe', weight: 1.5 },
];
const GEN: Command = { op: 'generate_human', era: 'medieval', groups: GROUPS };
// 用到的三个组的内置文化（按组的先后）
const SAMPLE_CULTURES = GROUPS.flatMap((g) => BUILTIN_CULTURES.filter((c) => c.group === g.id).map((c) => c.id));

// 生成过人文的大陆世界（1.2 万格的地区）
const peopled = (): Engine =>
  snapshot('peopled', () => {
    const eng = continents();
    eng.exec(GEN);
    return eng;
  });

// 人口的原因与推导、小数据里的人文
function popDigest(w: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['popTotal', 'popGroup', 'popShare', 'popManual'] as const) if (w.causes[k]) out[k] = digest(w.causes[k]);
  for (const k of POP_DERIVED) if (w.derived[k]) out[k] = digest(w.derived[k]);
  out.habitability = digest(w.derived.habitability);
  out.human = JSON.stringify(w.small.human ?? null);
  out.groups = JSON.stringify(w.small.popGroups ?? null);
  out.names = digest(w.derived.features.map((f) => [f.key, f.name, f.orig ?? '', f.style ?? '']));
  return out;
}

const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
const totalPop = (w: World) => w.causes.popTotal!.reduce((a, b) => a + b, 0);
const peopledCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.popTotal![i] > 0);

// 人文的金标准（第二十二轮记下）：以后提速、重构，生成的人口、群体、发源地必须逐值不变；有意改了生成的规则时重录
const RECORDED = {
  region: { popTotal: '9084d7038178c5a1', popGroup: '0620978a515c5474', popShare: '8fdd90cf255c6d41', human: '994f6c674c7f2025' },
  planet: { popTotal: 'e2884bca35d2ab53', popGroup: '34ccebf74bc8bba1', popShare: 'f4866cd6cfeccbde', human: '5eb96b124561d4e8' },
};
const genDigest = (w: World) => ({ popTotal: digest(w.causes.popTotal!), popGroup: digest(w.causes.popGroup!), popShare: digest(w.causes.popShare!), human: digest(w.small.human) });

describe('宜居度', () => {
  it('水面为 0，陆地在 0–1；冰盖、荒漠很低，河边、海边高；没有人文的世界也有', () => {
    const w = continents().world;
    const h = w.derived.habitability;
    expect(w.small.human).toBeUndefined();
    let river = 0;
    let riverN = 0;
    let inland = 0;
    let inlandN = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!dry(w, i)) {
        expect(h[i]).toBe(0);
        continue;
      }
      expect(h[i]).toBeGreaterThanOrEqual(0);
      expect(h[i]).toBeLessThanOrEqual(1);
      const sp = w.small.species[w.derived.dominant[i]]?.id;
      if (sp === 'ice') expect(h[i]).toBeLessThan(0.05);
      if (sp === 'temperate_forest' && w.derived.elevation[i] < 1000) {
        if (w.derived.discharge[i] >= w.small.planet.riverThreshold) {
          river += h[i];
          riverN++;
        } else {
          inland += h[i];
          inlandN++;
        }
      }
    }
    expect(riverN).toBeGreaterThan(5);
    expect(river / riverN).toBeGreaterThan(inland / inlandN);
    expect(BIOME_HABITABILITY.desert).toBeLessThan(BIOME_HABITABILITY.temperate_forest);
  });

  it('生态写了宜居度就用它，只重算人文的几层；地形类别的倍数也算进去', () => {
    const eng = continents();
    const w = eng.world;
    const elevation = w.derived.elevation;
    const forest = [...Array(w.mesh.n).keys()].filter((i) => dry(w, i) && w.small.species[w.derived.dominant[i]]?.id === 'temperate_forest');
    const before = forest.map((i) => w.derived.habitability[i]);
    expect(eng.exec({ op: 'update_species', id: 'temperate_forest', patch: { habitability: 0.2 } })).toContain('宜居度');
    expect(w.derived.elevation).toBe(elevation);
    forest.forEach((i, k) => expect(w.derived.habitability[i]).toBeLessThan(before[k]));
    const plain = forest.find((i) => w.derived.habitability[i] > 0.05)!;
    const h0 = w.derived.habitability[plain];
    eng.exec({ op: 'set_cell_class', cells: [plain], class: 'peaks' });
    expect(w.derived.habitability[plain]).toBeLessThan(h0 * 0.2);
  });
});

describe('生成人文', () => {
  it('用到的时代、取值、文化组、文化、地名风格复制进世界；总人口按时代的默认密度', () => {
    const w = peopled().world;
    const era = BUILTIN_ERAS.find((e) => e.id === 'medieval')!;
    expect(w.small.content?.era?.medieval).toEqual(era);
    expect(Object.keys(w.small.content?.cultureGroup ?? {})).toEqual(['western', 'eastern', 'steppe']);
    expect(worldCultures(w.small).map((c) => c.id)).toEqual(SAMPLE_CULTURES);
    for (const c of worldCultures(w.small)) if (c.nameStyle !== 'zh-default') expect(w.small.content?.nameStyle?.[c.nameStyle], c.id).toBeDefined();
    expect(dimensionValues(w.small, 'religion').map((v) => v.id)).toEqual(['sun-faith', 'moon-faith', 'ancestor-rites', 'sky-way']);
    expect(w.small.human!.totalPop).toBe(defaultTotalPop(w, w.derived, era));
    expect(Math.abs(totalPop(w) - w.small.human!.totalPop) / w.small.human!.totalPop).toBeLessThan(1e-4);
    expect(humanLayers(w).map((l) => l.id)).toEqual(['culture', 'cultureGroup', 'religion', 'popDensity', 'habitability']);
  });

  it('只有干的陆地有人；每格最多 4 个群体，占比加起来不超过 255；有人的格至少一个群体', () => {
    const w = peopled().world;
    const { popTotal: pop, popGroup: g, popShare: s } = w.causes;
    let people = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      let sum = 0;
      for (let k = 0; k < SLOTS; k++) {
        sum += s![i * SLOTS + k];
        if (!g![i * SLOTS + k]) expect(s![i * SLOTS + k]).toBe(0);
      }
      expect(sum).toBeLessThanOrEqual(255);
      if (pop![i] > 0) {
        people++;
        expect(dry(w, i), `格 ${i}`).toBe(true);
        expect(g![i * SLOTS]).toBeGreaterThan(0);
        expect(sum).toBeGreaterThan(200);
        expect(w.derived.popCulture![i]).toBeGreaterThan(0);
      } else {
        expect(g![i * SLOTS]).toBe(0);
        expect(w.derived.popCulture![i]).toBe(0);
      }
    }
    expect(people).toBeGreaterThan(1000);
    // 每个群体都有文化与宗教（宗教是“每人都有”的维度）
    for (const t of Object.values(w.small.popGroups!)) expect(t.values.religion).toBeDefined();
  });

  it('各文化组的人数按权重；组里的文化按文化的权重', () => {
    const w = peopled().world;
    const total = totalPop(w);
    const byGroup = new Map<string, number>();
    const byCulture = new Map<string, number>();
    const groupOf = new Map(worldCultures(w.small).map((c) => [c.id, c.group]));
    for (const i of peopledCells(w)) {
      for (const x of readComp(w.causes, i)) {
        const t = w.small.popGroups![x.code];
        if (!t) continue;
        const p = w.causes.popTotal![i] * x.s;
        byGroup.set(groupOf.get(t.culture)!, (byGroup.get(groupOf.get(t.culture)!) ?? 0) + p);
        byCulture.set(t.culture, (byCulture.get(t.culture) ?? 0) + p);
      }
    }
    // 文化圈边上掺了邻近的文化，所以只要求大致
    expect(byGroup.get('western')! / total).toBeCloseTo(3 / 7.5, 1);
    expect(byGroup.get('eastern')! / total).toBeCloseTo(3 / 7.5, 1);
    expect(byGroup.get('steppe')! / total).toBeCloseTo(1.5 / 7.5, 1);
    expect(byCulture.get('huaxia')! / byCulture.get('yamato')!).toBeGreaterThan(1.4);
  });

  it('发源地按喜欢的地理挑：草原的在草原、荒漠上，西方的在温带', () => {
    const w = peopled().world;
    const hs = w.small.human!.hearths;
    expect(hs.filter((h) => !h.culture).map((h) => h.group).sort()).toEqual(['eastern', 'steppe', 'western']);
    expect(hs.filter((h) => h.culture).map((h) => h.culture)).toEqual(SAMPLE_CULTURES);
    for (const h of hs) expect(dry(w, h.cell), `${h.group}/${h.culture}`).toBe(true);
    const steppe = hs.find((h) => h.group === 'steppe' && !h.culture)!;
    expect(['steppe', 'grasslands', 'desert']).toContain(classAt(w.small, w.derived.terrainClass[steppe.cell])?.id);
    const west = hs.find((h) => h.group === 'western' && !h.culture)!;
    expect(w.derived.tMean[west.cell]).toBeGreaterThanOrEqual(-2);
    expect(w.derived.tMean[west.cell]).toBeLessThanOrEqual(16);
    const east = hs.find((h) => h.group === 'eastern' && !h.culture)!;
    expect(w.derived.tMean[east.cell]).toBeGreaterThanOrEqual(8);
    // 发源地一带是这个文化的
    for (const h of hs.filter((x) => x.culture)) expect(worldCultures(w.small)[w.derived.popCulture![h.cell] - 1]?.group).toBe(h.group);
  });

  it('宗教成片，不是星星点点：相邻的有人的格大多是同一种', () => {
    const w = peopled().world;
    const k = worldDimensions(w.small).findIndex((x) => x.id === 'religion');
    const v = w.derived.popValue!.subarray(k * w.mesh.n, (k + 1) * w.mesh.n);
    let same = 0;
    let all = 0;
    for (const i of peopledCells(w)) {
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) {
        const j = w.mesh.adj[e];
        if (!(w.causes.popTotal![j] > 0)) continue;
        all++;
        if (v[i] === v[j]) same++;
      }
    }
    expect(same / all).toBeGreaterThan(0.85);
    // 四种宗教都有人信
    expect(humanLegend(w, 'religion').length).toBe(4);
  });

  it('同样的世界、同样的参数逐值相同；重放、检查点一致；金标准', () => {
    const a = peopled();
    const b = continents();
    b.exec(GEN);
    expect(popDigest(b.world)).toEqual(popDigest(a.world));
    const doc = a.toDoc();
    expect(popDigest(Engine.fromDoc(doc, a.world.mesh).world)).toEqual(popDigest(a.world));
    const cp = structuredClone(a.toCheckpoint());
    expect(popDigest(Engine.fromCheckpoint(cp, doc, a.world.mesh)!.world)).toEqual(popDigest(a.world));
    expect(genDigest(a.world)).toEqual(RECORDED.region);
  });

  it('整个星球上也一样', () => {
    const eng = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    eng.exec(GEN);
    const w = eng.world;
    expect(Math.abs(totalPop(w) - w.small.human!.totalPop) / w.small.human!.totalPop).toBeLessThan(1e-4);
    const again = Engine.fromDoc(eng.toDoc(), w.mesh);
    expect(popDigest(again.world)).toEqual(popDigest(w));
    expect(genDigest(w)).toEqual(RECORDED.planet);
  });

  it('换种子换一个样子；总人口可以指定；撤销后与没生成过一样', () => {
    const eng = continents();
    const before = digestWorld(eng.world);
    const human0 = Object.fromEntries(HUMAN_DERIVED.map((k) => [k, digest(eng.world.derived[k])]));
    eng.exec({ ...GEN, seed: 77, totalPop: 1e6 } as Command);
    expect(totalPop(eng.world)).toBeCloseTo(1e6, -1);
    expect(genDigest(eng.world)).not.toEqual(genDigest(peopled().world));
    eng.undo();
    const w = eng.world;
    expect(w.small.human).toBeUndefined();
    expect(w.small.popGroups).toBeUndefined();
    expect(w.small.content).toBeUndefined();
    expect(w.causes.popTotal).toBeUndefined();
    expect(w.derived.popCulture).toBeUndefined();
    expect(digestWorld(w)).toEqual(before);
    expect(Object.fromEntries(HUMAN_DERIVED.map((k) => [k, digest(w.derived[k])]))).toEqual(human0);
  });

  it('不认识的时代、文化组报错；去掉人文', () => {
    const eng = continents();
    expect(() => eng.exec({ ...GEN, era: 'stone' } as Command)).toThrow(CommandError);
    expect(() => eng.exec({ ...GEN, groups: [{ id: 'martian', weight: 1 }] } as Command)).toThrow(CommandError);
    expect(eng.world.small.content).toBeUndefined();
    const p = peopled();
    expect(p.exec({ op: 'remove_human' })).toBe('删除人文');
    expect(p.world.small.human).toBeUndefined();
    expect(p.world.derived.popCulture).toBeUndefined();
    expect(totalPop(p.world)).toBe(0);
  });

  it('生成的步骤可以插一步（第二十三轮的国家）：排在人口之前，能改每格的权重', () => {
    expect(humanStages()).toEqual(['cultures', 'population']);
    let ran = 0;
    registerHumanStage(
      {
        id: 'test-countries',
        run: (ctx) => {
          ran++;
          expect(ctx.cultureOf).toBeDefined();
          ctx.popScale = new Float32Array(ctx.world.mesh.n).fill(1);
        },
      },
      { before: 'population' },
    );
    try {
      expect(humanStages()).toEqual(['cultures', 'test-countries', 'population']);
      const eng = continents();
      eng.exec(GEN);
      expect(ran).toBe(1);
      expect(genDigest(eng.world)).toEqual(genDigest(peopled().world));
    } finally {
      unregisterHumanStage('test-countries');
    }
    expect(humanStages()).toEqual(['cultures', 'population']);
  });
});

describe('发源地', () => {
  it('挪一个发源地：锁定在那里，重新生成；恢复自动', () => {
    const eng = peopled();
    const w = eng.world;
    const west = w.small.human!.hearths.find((h) => h.group === 'western' && !h.culture)!;
    // 东方的发源地附近的一格
    const east = w.small.human!.hearths.find((h) => h.group === 'eastern' && !h.culture)!;
    const target = [...Array(w.mesh.n).keys()].find((i) => dry(w, i) && i !== east.cell && w.derived.popCultureGroup![i] === w.derived.popCultureGroup![east.cell] && Math.abs(w.mesh.x[i] - w.mesh.x[east.cell]) < 0.05)!;
    expect(eng.exec({ op: 'move_hearth', group: 'western', cell: target })).toBe('挪动发源地“西方”');
    const moved = w.small.human!.hearths.find((h) => h.group === 'western' && !h.culture)!;
    expect(moved).toEqual({ group: 'western', cell: target, locked: true });
    expect(worldCultures(w.small)[w.derived.popCulture![target] - 1]?.group).toBe('western');
    // 再重新生成：锁定的还在
    eng.exec({ op: 'regenerate_human', seed: 9 });
    expect(w.small.human!.hearths.find((h) => h.group === 'western' && !h.culture)).toEqual(moved);
    expect(eng.exec({ op: 'move_hearth', group: 'western', cell: null })).toBe('发源地“西方”恢复自动');
    expect(w.small.human!.hearths.find((h) => h.group === 'western' && !h.culture)!.locked).toBeUndefined();
    void west;
    expect(() => eng.exec({ op: 'move_hearth', culture: 'nobody', cell: target })).toThrow(CommandError);
    const sea = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i])!;
    expect(() => eng.exec({ op: 'move_hearth', group: 'western', cell: sea })).toThrow(CommandError);
  });
});

describe('人口笔刷', () => {
  const stroke = (w: World, from = 200, count = 60) => peopledCells(w).slice(from, from + count);

  it('改成分：这个群体的占比升高，人数不变；记成手改的', () => {
    const eng = peopled();
    const w = eng.world;
    const cells = stroke(w);
    const totals = cells.map((i) => w.causes.popTotal![i]);
    const group = { culture: 'arab', values: { religion: 'moon-faith' } };
    expect(eng.exec({ op: 'paint_pop', cells, mode: 'share', group, amount: 0.6 })).toBe(`人口“阿拉伯 · 月轮教” · ${cells.length} 格`);
    const code = Number(Object.entries(w.small.popGroups!).find(([, t]) => t.culture === 'arab' && t.values.religion === 'moon-faith')![0]);
    cells.forEach((i, k) => {
      expect(w.causes.popTotal![i]).toBe(totals[k]);
      const share = readComp(w.causes, i).find((x) => x.code === code)?.s ?? 0;
      expect(share).toBeGreaterThan(0.55);
      expect(w.causes.popManual![i]).toBe(1);
      // 文化圈跟着人口里占多数的文化
      expect(worldCultures(w.small)[w.derived.popCulture![i] - 1].id).toBe('arab');
    });
    eng.undo();
    expect(w.causes.popManual).toBeUndefined();
    expect(popDigest(w)).toEqual(popDigest(peopled().world));
  });

  it('改人数：× factor（反过来是小于 1 的 factor）；画笔权重；没有人的格补上人', () => {
    const eng = peopled();
    const w = eng.world;
    const cells = stroke(w, 300, 10);
    const totals = cells.map((i) => w.causes.popTotal![i]);
    expect(eng.exec({ op: 'paint_pop', cells, t: cells.map((_, k) => (k < 5 ? 1 : 0.5)), mode: 'count', factor: 2 })).toBe(`人数 ×2 · ${cells.length} 格`);
    cells.forEach((i, k) => expect(w.causes.popTotal![i]).toBeCloseTo(totals[k] * (k < 5 ? 2 : Math.SQRT2), -1));
    expect(eng.exec({ op: 'paint_pop', cells, mode: 'count', factor: 0.5 })).toBe(`人数 ×0.50 · ${cells.length} 格`);
    // 没有人的干的陆地
    const empty = [...Array(w.mesh.n).keys()].filter((i) => dry(w, i) && !(w.causes.popTotal![i] > 0)).slice(0, 3);
    expect(empty.length).toBe(3);
    eng.exec({ op: 'paint_pop', cells: empty, mode: 'count', factor: 3 });
    for (const i of empty) {
      expect(w.causes.popTotal![i]).toBeGreaterThan(0);
      expect(w.causes.popGroup![i * SLOTS]).toBeGreaterThan(0);
    }
    // 海上不画
    const sea = [...Array(w.mesh.n).keys()].filter((i) => !w.causes.land[i]).slice(0, 3);
    eng.exec({ op: 'paint_pop', cells: sea, mode: 'count', factor: 3 });
    expect(eng.lastNoop).toBe(true);
  });

  it('只改一个维度（改宗）：别的维度、文化不变', () => {
    const eng = peopled();
    const w = eng.world;
    const cells = stroke(w, 400, 40);
    const culture0 = cells.map((i) => w.derived.popCulture![i]);
    expect(eng.exec({ op: 'paint_pop', cells, mode: 'value', dimension: 'religion', value: 'ancestor-rites', amount: 1 })).toBe(`宗教改为“祖灵信仰” · ${cells.length} 格`);
    cells.forEach((i, k) => {
      expect(w.derived.popCulture![i]).toBe(culture0[k]);
      for (const x of readComp(w.causes, i)) if (x.code) expect(w.small.popGroups![x.code].values.religion).toBe('ancestor-rites');
    });
    expect(() => eng.exec({ op: 'paint_pop', cells, mode: 'value', dimension: 'race', value: 'elf', amount: 1 })).toThrow(CommandError);
    expect(() => eng.exec({ op: 'paint_pop', cells, mode: 'value', dimension: 'religion', value: 'elf', amount: 1 })).toThrow(CommandError);
  });

  it('文化笔刷：换成这个文化（宗教不变）或这个文化最典型的群体', () => {
    const eng = peopled();
    const w = eng.world;
    const cells = stroke(w, 500, 40);
    const religion0 = cells.map((i) => readComp(w.causes, i).map((x) => w.small.popGroups![x.code]?.values.religion));
    expect(eng.exec({ op: 'paint_culture', cells, culture: 'teutonic', amount: 1 })).toMatch(/^文化“条顿” · \d+ 格$/);
    cells.forEach((i, k) => {
      expect(worldCultures(w.small)[w.derived.popCulture![i] - 1].id).toBe('teutonic');
      const rel = readComp(w.causes, i).map((x) => w.small.popGroups![x.code]?.values.religion);
      for (const r of rel) if (r) expect(religion0[k]).toContain(r);
    });
    eng.exec({ op: 'paint_culture', cells, culture: 'yamato', amount: 1, typical: true });
    for (const i of cells) for (const x of readComp(w.causes, i)) if (x.code) expect(w.small.popGroups![x.code]).toEqual({ culture: 'yamato', values: { religion: 'ancestor-rites' } });
    // 地名跟着文化：这一格的风格是大和的
    expect(cellArchive(w, cells[0]).style).toBe('ja-kanji');
  });

  it('只重算人文的几层；撤销、重放、检查点一致；预览就是执行', () => {
    const eng = peopled();
    const w = eng.world;
    const passes = passStats.passes;
    const cells = stroke(w, 100, 50);
    const cmd: Command = { op: 'paint_culture', cells, culture: 'frankish', amount: 0.7 };
    const p = eng.previewWorld(cmd);
    for (const k of Object.keys(p.patch.derived)) expect([...HUMAN_DERIVED, ...POP_DERIVED]).toContain(k);
    eng.exec(cmd);
    expect(passStats.passes).toBe(passes);
    eng.exec({ op: 'paint_pop', cells: cells.slice(0, 10), mode: 'count', factor: 1.5 });
    eng.exec({ op: 'set_cell_pop', cell: cells[20], total: 12345, groups: [{ culture: 'anglic', values: { religion: 'sky-way' }, share: 0.7 }] });
    const after = popDigest(w);
    const doc = eng.toDoc();
    expect(popDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(after);
    const cp = structuredClone(eng.toCheckpoint());
    expect(popDigest(Engine.fromCheckpoint(cp, doc, w.mesh)!.world)).toEqual(after);
    const other = peopled();
    other.exec(cmd);
    expect(digest(other.world.causes.popGroup!)).toBe(digest(Engine.fromDoc({ ...doc, commands: doc.commands.slice(0, -2) }, w.mesh).world.causes.popGroup!));
    eng.undo();
    eng.undo();
    eng.undo();
    expect(popDigest(w)).toEqual(popDigest(peopled().world));
    eng.redo();
    eng.redo();
    eng.redo();
    expect(popDigest(w)).toEqual(after);
    // 只重算变了的格的那几层与整个重算逐值相同
    const fresh = { ...w.derived };
    for (const k of POP_DERIVED) delete fresh[k];
    computePopLayers(w, fresh);
    for (const k of POP_DERIVED) expect(digest(fresh[k]), k).toBe(digest(w.derived[k]));
  });

  it('档案里改一格：总人数、各群体的占比，剩下的是“其他”', () => {
    const eng = peopled();
    const w = eng.world;
    const cell = stroke(w, 50, 1)[0];
    eng.exec({
      op: 'set_cell_pop',
      cell,
      total: 5000,
      groups: [
        { culture: 'huaxia', values: { religion: 'sky-way' }, share: 0.5 },
        { culture: 'turkic', values: { religion: 'moon-faith' }, share: 0.3 },
      ],
    });
    const pop = cellPopulation(w, cell)!;
    expect(pop.total).toBe(5000);
    expect(pop.manual).toBe(true);
    expect(pop.groups.map((g) => [g.label, Math.round(g.share * 100)])).toEqual([
      ['华夏 · 天道', 50],
      ['突厥 · 月轮教', 30],
    ]);
    expect(pop.other).toBeCloseTo(0.2, 1);
    expect(pop.culture?.id).toBe('huaxia');
    const a = cellArchive(w, cell);
    expect(a.population?.groups[0].values).toEqual([{ dimension: 'religion', label: '宗教', id: 'sky-way', name: '天道', color: '#4aa0a0' }]);
    expect(a.habitability).toBeGreaterThan(0);
    expect(() => eng.exec({ op: 'set_cell_pop', cell, groups: [{ culture: 'huaxia', values: { religion: 'nope' }, share: 1 }] })).toThrow(CommandError);
    // 没有人文的世界没有人口这一栏
    expect(cellArchive(continents().world, cell).population).toBeUndefined();
  });

  it('总人口按比例改', () => {
    const eng = peopled();
    const w = eng.world;
    expect(eng.exec({ op: 'set_pop_total', total: 2e8 })).toBe('总人口 · 2.0 亿');
    expect(totalPop(w) / 2e8).toBeCloseTo(1, 4);
    expect(w.small.human!.totalPop).toBe(2e8);
  });
});

describe('地名跟着文化', () => {
  it('地物、省份、格没有自己选的风格时用当地占多数的文化的风格；海、荒地用最近的文化', () => {
    const eng = peopled();
    const w = eng.world;
    const styles = new Set<string>();
    for (const f of w.derived.features) {
      if (f.region || f.guide) continue;
      const code = majorityCulture(w, f.cells);
      const c = worldCultures(w.small)[code - 1];
      expect(c, f.key).toBeDefined();
      const rs = styleFor(w, { feature: f });
      expect(rs.id, f.key).toBe(c.nameStyle);
      // 不是世界默认时地物带着 style
      if (c.nameStyle !== 'zh-default') expect(f.style).toBe(c.nameStyle);
      styles.add(rs.id);
    }
    expect(styles.size).toBeGreaterThan(3);
    // 海也有文化
    const ocean = w.derived.features.find((f) => f.type === 'ocean' || f.type === 'sea')!;
    expect(majorityCulture(w, ocean.cells)).toBeGreaterThan(0);
    // 自己选的风格优先
    eng.exec({ op: 'set_feature_style', key: ocean.key, style: 'zh-default' });
    expect(w.derived.features.find((f) => f.key === ocean.key)!.style).toBeUndefined();
  });

  it('新划的省份按当地的文化起名', () => {
    const eng = peopled();
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    const w = eng.world;
    let orig = 0;
    for (const [id, p] of Object.entries(w.small.provinces)) {
      if (!p.land) continue;
      const cells = [...Array(w.mesh.n).keys()].filter((i) => w.causes.province[i] === Number(id));
      const c = worldCultures(w.small)[majorityCulture(w, cells) - 1];
      if (c && c.nameStyle !== 'zh-default') {
        expect(p.orig, p.name).toBeDefined();
        orig++;
      }
    }
    expect(orig).toBeGreaterThan(10);
  });

  it('没有人文的世界名字不变', () => {
    const a = continents().world.derived.features.map((f) => [f.key, f.name]);
    const b = engineFor({ cells: 12000, seed: 1, latNorth: 72, latSouth: 20 });
    b.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    expect(b.world.derived.features.map((f) => [f.key, f.name])).toEqual(a);
  });
});

describe('改地形以后的修补', () => {
  it('变成海的格没有人了，新的陆地按宜居度补上人、成分照最近的格；记进命令，重放一致；撤销退回', () => {
    const eng = peopled();
    const w = eng.world;
    const before = popDigest(w);
    // 有人的海边一片画成海
    const coastal = peopledCells(w).filter((i) => {
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return true;
      return false;
    });
    const c0 = coastal[Math.floor(coastal.length / 3)];
    const disc = [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c0], w.mesh.y[i] - w.mesh.y[c0]) < w.mesh.spacing * 3);
    const elsewhere = peopledCells(w).filter((i) => !disc.includes(i));
    const keep = elsewhere.slice(0, 200).map((i) => w.causes.popTotal![i]);
    eng.exec({ op: 'paint_land', cells: disc, t: disc.map(() => 0), mode: 'sea' });
    const lost = disc.filter((i) => !w.causes.land[i]);
    expect(lost.length).toBeGreaterThan(3);
    for (const i of lost) {
      expect(w.causes.popTotal![i]).toBe(0);
      expect(w.causes.popGroup![i * SLOTS]).toBe(0);
    }
    // 别处的人数不动
    elsewhere.slice(0, 200).forEach((i, k) => {
      if (dry(w, i)) expect(w.causes.popTotal![i]).toBe(keep[k]);
    });
    // 再画回陆地：新的陆地有人
    eng.exec({ op: 'paint_land', cells: disc, t: disc.map(() => 0), mode: 'land' });
    const regained = lost.filter((i) => dry(w, i) && w.derived.habitability[i] > 0.05);
    expect(regained.length).toBeGreaterThan(2);
    for (const i of regained) {
      expect(w.causes.popTotal![i], `格 ${i}`).toBeGreaterThan(0);
      expect(w.causes.popGroup![i * SLOTS]).toBeGreaterThan(0);
    }
    const doc = eng.toDoc();
    expect(doc.commands.at(-1)!.popFix).toBeDefined();
    expect(doc.commands.at(-2)!.popFix).toBeDefined();
    expect(popDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(popDigest(w));
    eng.undo();
    eng.undo();
    expect(popDigest(w)).toEqual(before);
  });

  it('手改过的格不动；新建世界去掉人文', () => {
    const eng = peopled();
    const w = eng.world;
    const cells = peopledCells(w).slice(10, 20);
    eng.exec({ op: 'paint_pop', cells, mode: 'count', factor: 2 });
    const painted = cells.map((i) => w.causes.popTotal![i]);
    eng.exec({ op: 'regenerate_human', seed: 3 });
    cells.forEach((i, k) => expect(w.causes.popTotal![i]).toBe(painted[k]));
    eng.exec({ op: 'regenerate_human', keepManual: false });
    expect(w.causes.popManual!.every((v) => v === 0)).toBe(true);
    eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents', landFraction: 0.4 }, reset: true });
    expect(w.small.human).toBeUndefined();
    expect(w.derived.popCulture).toBeUndefined();
    expect(totalPop(w)).toBe(0);
  });
});

describe('仓库与导出', () => {
  it('改一个文化的颜色只重算人文的几层；停用了的文化的人照旧在，图层上认不出', () => {
    const eng = peopled();
    const w = eng.world;
    const c = worldCultures(w.small).find((x) => x.id === 'frankish')!;
    const elevation = w.derived.elevation;
    expect(eng.exec({ op: 'set_content', kind: 'culture', id: 'frankish', item: { ...c, color: '#000000' } })).toBe('修改文化“法兰克”');
    expect(w.derived.elevation).toBe(elevation);
    expect(humanLegend(w, 'culture').find((x) => x.id === 'frankish')!.color).toBe('#000000');
    const total = totalPop(w);
    eng.exec({ op: 'set_content', kind: 'culture', id: 'frankish', item: null });
    expect(totalPop(w)).toBe(total);
    expect(humanLegend(w, 'culture').some((x) => x.id === 'frankish')).toBe(false);
  });

  it('导出 population.png、cultures.bmp、cultures.csv，provinces_summary.csv 多几列；没有人文时没有', () => {
    const eng = peopled();
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    const opts = { width: 256, height: 128, seaLevelGray: 95, maxElevation: 6000 };
    const pkg = exportPackage(eng.world, eng.toDoc(), opts);
    expect(pkg.files).toEqual(expect.arrayContaining(['population.png', 'cultures.bmp', 'cultures.csv']));
    const files = unzipSync(pkg.zip);
    const csv = strFromU8(files['cultures.csv']).trim().split('\n');
    expect(csv[0]).toBe('code,id,name,group,red,green,blue,population,cells');
    expect(csv.length).toBe(1 + worldCultures(eng.world.small).length);
    const summary = strFromU8(files['provinces_summary.csv']).split('\n')[0];
    expect(summary).toBe('id,name,land,kind,terrain,species,cells,mean_elevation_m,terrain_class,resource,population,culture,culture_group,religion');
    // PNG：8 位灰度
    expect(files['population.png'][24]).toBe(8);
    expect(files['population.png'][25]).toBe(0);
    const plain = exportPackage(continents().world, continents().toDoc(), opts);
    expect(plain.files).not.toContain('cultures.bmp');
    expect(plain.files).not.toContain('population.png');
  });
});
