import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { type FieldDesc, allKinds, enableCommand, itemId, kindOf } from '../../../core/content/registry';
import type { Engine } from '../../../core/engine';
import { packItems } from '../../../core/packs';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../../../core/packs/import';
import { worldProvinceRules } from '../../../core/province-rules';
import { NO_CURRENTS, engineFor, setGroupWeights } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { RegenTrack } from '../../regen-track';
import { dividersOf, moveDivider, shareDrag, sharesOf, valuesOf } from '../components/share-bar';
import { logScale, sliderScale, valueText } from './fields';
import { GEN_ERA_KEYS, genCommand, genPage, genSummary } from './gen-settings';
import { worldItemCommand } from './page-actions';
import { HIDDEN, segmentsOf } from './page-segments';
import { oneMark } from './page-marks';
import { HOME, type PageCtx, WORLD_SOURCE } from './pages';
import { startOf } from './panel-store';
import { regenCommand, regenNeed } from './regen';

// 第八十一轮：资源库里改东西好上手——底下一条“改了 N 项 · 重新生成”（省份划分也算、写会重做什么）、打开总是本世界、
// 数都是滑块（大范围按对数）、国家等级的比例是一条色条、生成设置一页、一行最多一个标记、说明不超过 20 个字

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ROOTS = BUILTIN.map((e) => ({ key: e.key, pack: e.pack }));
const ctxOf = (w: PageCtx['world']): PageCtx => ({ world: w && { ...w }, lib: BUILTIN });

let bare: Engine;
beforeAll(() => {
  bare = engineFor({ cells: 3000, seed: 2 }, { bare: true });
  bare.exec(NO_CURRENTS);
  bare.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  bare.exec({ op: 'generate_provinces', seed: 1 });
  library.value = BUILTIN;
});

function worldOf(lib = 'medieval'): Engine {
  const e = bare.clone();
  const root = builtinPacks().find((p) => p.id === lib)!;
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf(lib))) e.exec(c);
  const groups = packItems<{ id: string; weight?: number }>(root, 'cultureGroups')
    .filter((g) => g.weight !== 0)
    .slice(0, 3)
    .map((g) => ({ id: g.id, weight: 1 }));
  for (const c of packImportCommands(ROOTS, { packs: [[lib]], groups: groups.map((g) => g.id) }, e.world)) e.exec(c);
  setGroupWeights(e, groups);
  e.exec({ op: 'generate_human', packs: [[lib]], groups: groups.map((g) => g.id), countries: {}, settlements: {} } as Command);
  e.update();
  return e;
}
const trackOf = (e: Engine) => {
  const t = new RegenTrack();
  t.reset(0, e.world.small.content);
  return t;
};
// 改一项内容，按应用里的样子记一步
function editIn(e: Engine, t: RegenTrack, kind: string, patch: Record<string, unknown>, at: number) {
  const k = kindOf(kind)!;
  const cur = k.inWorld(e.world)[0] as Record<string, unknown>;
  const cmd = enableCommand(k, { ...cur, ...patch }, e.world);
  e.exec(cmd);
  e.update();
  t.pending = cmd;
  t.step(at, e.world.small.content);
}

describe('底下的“改了 N 项 · 重新生成”', () => {
  it('省份划分的大小改了：重新划分省份（按世界的种子）；“湖”改了马上整理，不算', () => {
    const e = worldOf();
    const t = trackOf(e);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    editIn(e, t, 'provinceRules', { lakeMode: 'merge' }, 1);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    editIn(e, t, 'provinceRules', { size: 80 }, 2);
    const need = regenNeed(e.world.small, t.base(), BUILTIN)!;
    expect(need).toMatchObject({ scopes: ['provinces'], count: 1, warn: null });
    expect(need.what).toContain('省份');
    const cmd = regenCommand(need, e.world.small, BUILTIN);
    expect(cmd).toEqual({ op: 'generate_provinces', seed: e.world.small.provinceSeed });
    e.exec(cmd);
    e.update();
    t.pending = cmd;
    t.step(3, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    expect(worldProvinceRules(e.world.small).size).toBe(80);
  });

  it('省份和国家一起改：一步做完（先划分省份），写清楚重做什么；手改过的国家、省份写出来会被换掉', () => {
    const e = worldOf();
    const t = trackOf(e);
    // 手改一下省份、国家（只记命令，内容不变）
    t.pending = { op: 'set_province', id: 0, name: '手起的名' } as Command;
    t.step(1, e.world.small.content);
    t.pending = { op: 'set_country', id: Number(Object.keys(e.world.small.countries!)[0]), patch: { name: '手改' } } as Command;
    t.step(2, e.world.small.content);
    editIn(e, t, 'provinceRules', { size: 90 }, 3);
    const gov = Object.values(e.world.small.countries!)[0].government;
    const k = kindOf('government')!;
    const g = k.inWorld(e.world).find((x) => itemId(k, x) === gov) as Record<string, unknown>;
    e.exec(enableCommand(k, { ...g, name: '改过' }, e.world));
    e.update();
    t.pending = { op: 'set_content', kind: 'government', id: gov, item: null } as Command;
    t.step(4, e.world.small.content);
    const need = regenNeed(e.world.small, t.base(), BUILTIN)!;
    expect(need.scopes).toEqual(['provinces', 'countries']);
    expect(need.count).toBe(2);
    expect(need.what).toBe('会重做省份、国家、人口、城市；锁定的不动');
    expect(need.warn).toBe('手改过的省份、国家会被换掉');
    const cmd = regenCommand(need, e.world.small, BUILTIN) as Extract<Command, { op: 'batch' }>;
    expect(cmd.op).toBe('batch');
    expect(cmd.commands[0]).toEqual({ op: 'generate_provinces', seed: e.world.small.provinceSeed });
    expect(cmd.commands.slice(1).some((c) => c.op === 'regenerate_countries' || (c.op === 'batch' && c.commands.some((x) => x.op === 'regenerate_countries')))).toBe(true);
    e.exec(cmd);
    e.update();
    t.pending = cmd;
    t.step(5, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toBeNull();
    // 重新生成以后不再说手改过
    expect(t.base()!.hand).toBeUndefined();
  });

  it('只改国家：没手改过时不写会被换掉', () => {
    const e = worldOf();
    const t = trackOf(e);
    const gov = Object.values(e.world.small.countries!)[0].government;
    const k = kindOf('government')!;
    const g = k.inWorld(e.world).find((x) => itemId(k, x) === gov) as Record<string, unknown>;
    e.exec(enableCommand(k, { ...g, name: '改过' }, e.world));
    e.update();
    t.step(1, e.world.small.content);
    expect(regenNeed(e.world.small, t.base(), BUILTIN)).toMatchObject({ scopes: ['countries'], warn: null, label: '重新生成国家' });
  });
});

describe('打开资源库', () => {
  it('有世界时总是本世界（上次看的是本世界时回到那一页）；没有世界时回到上次看的', () => {
    const lib = { source: { t: 'lib' as const, key: 'fantasy' }, stack: [HOME, { p: 'list' as const, kind: 'culture' }] };
    expect(startOf(lib, true)).toEqual({ source: WORLD_SOURCE, stack: [HOME] });
    expect(startOf(null, true)).toEqual({ source: WORLD_SOURCE, stack: [HOME] });
    const here = { source: WORLD_SOURCE, stack: [HOME, { p: 'gen' as const }] };
    expect(startOf(here, true)).toEqual(here);
    expect(startOf(lib, false)).toEqual(lib);
    expect(startOf(null, false).source).toEqual({ t: 'lib', key: 'medieval' });
  });
});

describe('数的滑块', () => {
  it('大范围按对数：停得到的数原样回来（值 → 位置 → 值），两位有效数字，两头到得了', () => {
    for (const [lo, hi, step] of [
      [0.001, 10000, 0.1],
      [1000, 1e9, 10000],
      [0, 1000, 0.1],
    ] as const) {
      const s = logScale(lo, hi, step);
      const stops = s.stops!;
      expect(stops[0]).toBe(lo);
      expect(stops[stops.length - 1]).toBe(hi);
      for (let k = 1; k < stops.length; k++) expect(stops[k]).toBeGreaterThan(stops[k - 1]);
      for (const v of stops) expect(s.at(s.pos(v))).toBe(v);
      expect(s.at(0)).toBe(lo);
      expect(s.at(1)).toBe(hi);
      // 中间是按比例的：一半的位置在几何平均附近
      const mid = s.at(0.5);
      const start = lo > 0 ? lo : step;
      expect(mid / Math.sqrt(start * hi)).toBeGreaterThan(0.8);
      expect(mid / Math.sqrt(start * hi)).toBeLessThan(1.25);
    }
    // 内置时代写的数落在格上
    const era = kindOf('era')!;
    const pop = sliderScale(era.fields.find((f) => f.key === 'popDensity')!)!;
    for (const v of [0.5, 2, 4, 12, 30, 80]) expect(pop.at(pop.pos(v))).toBe(v);
  });

  it('滑块右边写单位；比例写成百分之几；很大的数加逗号', () => {
    const era = kindOf('era')!;
    const f = (k: string) => era.fields.find((x) => x.key === k)!;
    expect(valueText(f('urbanization'), 0.1)).toBe('10%');
    expect(valueText(f('popDensity'), 2)).toBe('2 人/km²');
    expect(valueText(f('countryKm2'), 120000)).toBe('120,000 km²');
    expect(valueText(f('seaClaimKm'), 30)).toBe('30 km');
  });

  it('每种内容的数都是滑块（有上下限的）；单位写了的写在字段上', () => {
    const walk = (fs: readonly FieldDesc[], out: FieldDesc[]) => {
      for (const f of fs) {
        if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.step) out.push(f);
        if (f.of) walk(f.of, out);
      }
      return out;
    };
    for (const k of allKinds()) for (const f of walk(k.fields, [])) expect(sliderScale(f), `${k.id}.${f.key}`).not.toBeNull();
    const era = kindOf('era')!;
    for (const key of ['popDensity', 'countryKm2', 'seaClaimKm', 'urbanization']) expect(era.fields.find((f) => f.key === key)!.unit, key).toBeTruthy();
  });

  it('说明一句话，不超过 20 个字（写在字段下面）', () => {
    const walk = (id: string, fs: readonly FieldDesc[] | undefined, at: string) => {
      for (const f of fs ?? []) {
        if (f.hint) expect([...f.hint].length, `${id} ${at}${f.key}：${f.hint}`).toBeLessThanOrEqual(20);
        walk(id, f.of, `${at}${f.key}.`);
        if (f.value) walk(id, [f.value], `${at}${f.key}.`);
        walk(id, f.items, `${at}${f.key}.`);
      }
    };
    for (const k of allKinds()) walk(k.id, k.fields, '');
  });
});

describe('国家等级的比例：一条色条', () => {
  it('拖一个分界只改两边两段，和不变；交出去的是百分之几，和是 100', () => {
    const shares = sharesOf([3, 3, 2, 0.8, 0.2]);
    expect(shares.reduce((a, v) => a + v, 0)).toBeCloseTo(1);
    const d = dividersOf(shares);
    const moved = moveDivider(shares, 1, d[1] + 0.1);
    expect(moved[0]).toBe(shares[0]);
    expect(moved[3]).toBe(shares[3]);
    expect(moved[1] + moved[2]).toBeCloseTo(shares[1] + shares[2]);
    expect(moved.reduce((a, v) => a + v, 0)).toBeCloseTo(1);
    // 不越过旁边的分界
    expect(moveDivider(shares, 1, 0)[1]).toBe(0);
    expect(moveDivider(shares, 1, 0)[0]).toBe(shares[0]);
    for (const v of [valuesOf(moved), valuesOf(sharesOf([1, 1, 1])), valuesOf(sharesOf([1, 2, 3, 4, 5, 6, 7]))]) expect(Number(v.reduce((a, x) => a + x, 0).toFixed(6))).toBe(100);
  });

  it('拖的时候只是草稿，松手交出去一次；没动时不交', () => {
    const values = [10, 30, 60];
    const d = shareDrag(values, 0);
    d.move(0.2);
    d.move(0.3);
    d.move(0.25);
    const out = d.end();
    expect(out).toEqual([25, 15, 60]);
    const still = shareDrag(values, 1);
    still.move(0.4);
    still.move(0.4 + 1e-9);
    expect(still.end()).toBeNull();
  });
});

describe('生成设置', () => {
  it('列本世界的时代和省份划分；改了和那一项自己的页面同一条命令（只是历史里写改的是哪一项）', () => {
    const e = worldOf();
    const ctx = ctxOf(e.world);
    const p = genPage(ctx)!;
    expect(p.era!.id).toBe(e.world.small.human!.era);
    expect(p.era!.fields.map((f) => f.key)).toEqual(GEN_ERA_KEYS);
    expect(p.era!.fields[0]).toBe(kindOf('era')!.fields.find((f) => f.key === 'countryKm2'));
    expect(p.provinces!.fields.map((f) => f.key)).toEqual(['size']);
    expect(p.tiers).toBe(kindOf('era')!.fields.find((f) => f.key === 'tiers'));
    expect(genSummary(p)).toContain('省 40 格');
    const era = p.era!.item as unknown as Record<string, unknown>;
    const next = { ...era, countryKm2: 300000 };
    const cmd = genCommand(p.era!, next, e.world, '国家大小')!;
    const same = worldItemCommand(kindOf('era')!, p.era!.id, next, e.world)!;
    expect(cmd).toEqual({ ...same, label: '改国家大小' });
    e.exec(cmd);
    e.update();
    expect(genPage(ctxOf(e.world))!.era!.item.countryKm2).toBe(300000);
    const rules = p.provinces!.item as unknown as Record<string, unknown>;
    const pc = genCommand(p.provinces!, { ...rules, size: 60 }, e.world, '省份大小')!;
    expect(pc).toEqual({ ...worldItemCommand(kindOf('provinceRules')!, p.provinces!.id, { ...rules, size: 60 }, e.world)!, label: '改省份大小' });
    e.exec(pc);
    e.update();
    expect(worldProvinceRules(e.world.small).size).toBe(60);
  });

  it('没有世界时没有这一页', () => {
    expect(genPage(ctxOf(null))).toBeNull();
  });
});

describe('一行最多一个标记；页面上不列的字段', () => {
  it('默认 / 在用先，其次和库不同，最后本世界改过', () => {
    expect(oneMark({ isDefault: true, changed: true, modified: true })).toEqual({ text: '默认', diff: false });
    expect(oneMark({ isDefault: true, inUse: true })).toEqual({ text: '在用', diff: false });
    expect(oneMark({ changed: true, modified: true })).toEqual({ text: '和库不同', diff: true });
    expect(oneMark({ modified: true })).toEqual({ text: '本世界改过', diff: false });
    expect(oneMark({})).toBeNull();
  });

  it('国家等级的“多少”不列（内置的时代都写了比例）', () => {
    expect(HIDDEN.countryTier).toEqual(['weight']);
    const tiers = segmentsOf(kindOf('countryTier')!).flatMap((s) => s.fields.map((f) => f.key));
    expect(tiers).not.toContain('weight');
    for (const b of builtinPacks()) for (const era of packItems<{ id: string; tiers?: Record<string, number> }>(b, 'eras')) expect(era.tiers, `${b.id}/${era.id}`).toBeDefined();
  });
});
