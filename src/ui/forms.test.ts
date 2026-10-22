import { describe, expect, it } from 'vitest';
import { digestWorld } from '../../tools/hash';
import { Engine } from '../../core/engine';
import { WORLD_TYPES } from '../../core/generate';
import { PACK_FORMAT, PACK_VERSION, type PackItem, type ResourcePack } from '../../core/packs';
import { FANTASY_PACK } from '../../core/packs/fantasy';
import { FANTASY_FORMS, POLAR_CONTINENTS, RING_SEA, TWIN_CONTINENTS } from '../../core/packs/fantasy-forms';
import { type PlanetForm, planetFormSchema } from '../../core/planet-form';
import { planetProfile } from '../../core/planet-gen';
import { engineFor } from '../../core/testing/fixtures';
import type { LibraryEntry } from '../library';
import {
  FORM_KNOBS,
  blankForm,
  currentFormName,
  finalForm,
  formChoices,
  genWithForm,
  newWorldCommands,
  planetTypeName,
  withCrustMode,
  withScript,
  wizardWorldName,
} from './forms';
import { formCommand, landNote } from './panels/FormPicker';

// 星球形态的界面逻辑：向导、调整里列出的形态，向导新建的命令与名字，形态编辑器的滑块、脚本、存之前定 id，
// 调整里换形态的命令（预览说的多出、少掉的陆地就是执行后的，画过的改动照样叠在新地形上）

const pack = (id: string, forms: PlanetForm[]): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name: id, planetForms: forms as unknown as PackItem[] });
const entry = (key: string, p: ResourcePack, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ key, pack: p, builtin: false, mine: false, installedAt: 1, ...extra });
const BUILTIN = entry('fantasy', FANTASY_PACK, { builtin: true, installedAt: 0 });
const mineForm: PlanetForm = { ...blankForm('archipelago'), id: 'my_1', name: '千岛' };
const globe = { cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 };

describe('列出来的形态', () => {
  it('内置的三种在前，之后按资源库的顺序；一模一样的只列一次；键带上是哪个包的', () => {
    const list = formChoices([BUILTIN, entry('我的资源', pack('我的资源', [mineForm, structuredClone(TWIN_CONTINENTS)]), { mine: true }), entry('x', pack('x', [{ ...RING_SEA, name: '另一个环' }]))]);
    expect(list.map((c) => c.key)).toEqual(['fantasy:twin_continents', 'fantasy:ring_sea', 'fantasy:polar_continents', '我的资源:my_1', 'x:ring_sea']);
    expect(list.map((c) => [c.builtin, c.mine])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(list[0].form).toBe(TWIN_CONTINENTS);
    expect(formChoices([BUILTIN]).map((c) => c.form)).toEqual([...FANTASY_FORMS]);
  });

  it('叫法：星球的类型与向导的卡片相同；向导里没有的“内海”用生成器的名字', () => {
    expect(planetTypeName('continents')).toBe('像地球');
    expect(planetTypeName('ocean')).toBe('空白星球');
    expect(planetTypeName('inland_sea')).toBe('内海');
    expect(currentFormName({ seed: 1, type: 'continents', mountains: 1, rerolls: [] })).toBe('不用（像地球）');
    expect(currentFormName({ seed: 1, type: 'continents', mountains: 1, rerolls: [], form: TWIN_CONTINENTS })).toBe('双子大陆');
  });
});

describe('向导新建', () => {
  it('历史里的名字：整个星球用星球的叫法（不是生成器的“几块大陆”），形态用形态的名字，一块地区用世界类型', () => {
    const choices = formChoices([BUILTIN]);
    expect(wizardWorldName('planet', 'continents', choices, 'archipelago')).toBe('像地球');
    expect(wizardWorldName('planet', 'ocean_islands', choices, 'archipelago')).toBe('海洋星球');
    expect(wizardWorldName('planet', 'fantasy:polar_continents', choices, 'archipelago')).toBe('极地大陆');
    expect(wizardWorldName('region', 'fantasy:polar_continents', choices, 'archipelago')).toBe('群岛之海');
  });

  it('用形态新建：一步“新世界：双子大陆”，生成参数带着形态', () => {
    const eng = engineFor(globe);
    for (const cmd of newWorldCommands({ seed: 7, type: 'continents', form: TWIN_CONTINENTS }, '双子大陆', 7)) eng.exec(cmd);
    expect(eng.history.map((h) => h.summary)[0]).toBe('新世界：双子大陆');
    expect(eng.world.small.terrain.gen!.form).toEqual(TWIN_CONTINENTS);
    expect(eng.world.small.planet.terrainWind).toBe(1);
  });
});

describe('形态编辑器', () => {
  it('滑块：没改时读的是那种星球原来的；滑块上的每个值写进去都是合格的形态，读回来还是那个值', () => {
    for (const base of WORLD_TYPES) {
      const f = blankForm(base);
      const prof = planetProfile(base);
      expect(FORM_KNOBS.find((k) => k.id === 'landFraction')!.read(f)).toBe(prof.landFraction);
      expect(FORM_KNOBS.find((k) => k.id === 'blocks')!.read(f)).toBe((prof.blocks[0] + prof.blocks[1]) / 2);
      for (const k of FORM_KNOBS) {
        const [lo, hi] = k.range;
        for (let t = 0; t <= 1; t += 0.125) {
          const v = Math.round((lo + (hi - lo) * t) / k.step) * k.step;
          const g = k.write(f, v);
          expect(planetFormSchema.safeParse(g).success, `${base} ${k.id} ${v}`).toBe(true);
          // 个数取整（一对数的中间可能差半个），大小差不到一个百分点
          expect(Math.abs(k.read(g) - v), `${base} ${k.id} ${v}`).toBeLessThanOrEqual(k.id === 'plates' || k.id === 'blocks' ? 0.5 : 0.011);
          expect(k.format(k.read(g), 6371).length).toBeGreaterThan(0);
        }
      }
    }
    // 一对数按原来的比例整体缩放（6–9 块 → 调到 10：8–12 块）
    expect(FORM_KNOBS.find((k) => k.id === 'blocks')!.write(blankForm('continents'), 10).profile!.blocks).toEqual([8, 12]);
    expect(FORM_KNOBS.find((k) => k.id === 'radius')!.format(0.24, 6371)).toBe('每块约 4,800 公里宽');
  });

  it('脚本：空的去掉，两段都没有时去掉整个 scripts；完全由脚本决定才写 crustMode', () => {
    let f = withScript(blankForm(), 'setup', 'addBlock({ lat: 0, lon: 0, size: 20 });');
    expect(f.scripts).toEqual({ setup: { api: 1, src: 'addBlock({ lat: 0, lon: 0, size: 20 });' } });
    f = withScript(f, 'crust', 'return { height: height + 100 };');
    expect(Object.keys(f.scripts!)).toEqual(['setup', 'crust']);
    f = withScript(withScript(f, 'setup', '  '), 'crust', '');
    expect('scripts' in f).toBe(false);
    expect(withCrustMode(blankForm(), 'replace').crustMode).toBe('replace');
    expect('crustMode' in withCrustMode(withCrustMode(blankForm(), 'replace'), 'modify')).toBe(false);
  });

  it('存之前定 id：没改过用原来的；我的改了 id 不变；内置的改了是副本（新 id、种子沿用、重名加编号）', () => {
    const others = [...FANTASY_FORMS, mineForm];
    expect(finalForm(structuredClone(TWIN_CONTINENTS), TWIN_CONTINENTS, false, others)).toBe(TWIN_CONTINENTS);
    const mineEdited = { ...mineForm, hint: '很多岛' };
    expect(finalForm(mineEdited, mineForm, true, others)).toBe(mineEdited);
    const copy = finalForm({ ...TWIN_CONTINENTS, profile: { ...TWIN_CONTINENTS.profile, landFraction: 0.2 } }, TWIN_CONTINENTS, false, others, 1000);
    expect([copy.id, copy.name, copy.seedKey]).toEqual(['my_rs', '双子大陆 2', 'fantasy/twin_continents']);
    expect(planetFormSchema.safeParse(copy).success).toBe(true);
    // 从头做的：种子用编辑时的 id（存好的与编辑器里的缩略图同一个样子）
    const fresh = finalForm({ ...blankForm(), name: '千岛' }, null, false, others, 1000);
    expect([fresh.id, fresh.name, fresh.seedKey]).toEqual(['my_rs', '千岛 2', 'my_form']);
    // 改了 id、种子沿用：同一个种子新建出来的与编辑时（原来的 id）的样子相同
    const a = engineFor(globe);
    a.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', form: { ...POLAR_CONTINENTS, name: '极地' } }, reset: true });
    const b = engineFor(globe);
    b.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', form: finalForm({ ...POLAR_CONTINENTS, name: '极地' }, POLAR_CONTINENTS, false, others) }, reset: true });
    expect(digestWorld(b.world)['causes.land']).toBe(digestWorld(a.world)['causes.land']);
  });
});

describe('调整里换形态', () => {
  it('预览说的多出、少掉的陆地就是执行后的；画过的改动照样叠在新地形上；一步“换了星球形态”，可以撤销；去掉形态也是一步', () => {
    const eng = engineFor(globe);
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents', landFraction: 0.3 }, reset: true });
    // 画一片陆地（用户的改动）
    const w = eng.world;
    const sea = [...Array(w.mesh.n).keys()].filter((c) => !w.causes.land[c]).slice(0, 40);
    eng.exec({ op: 'paint_land', cells: sea, t: sea.map(() => 0), mode: 'land' });
    const delta = w.causes.landDelta.slice();
    const before = digestWorld(w);
    const land0 = w.causes.land.slice();
    const cmd = formCommand(w.small.terrain.gen!, TWIN_CONTINENTS);
    expect(cmd).toEqual({ op: 'set_worldgen', params: { ...w.small.terrain.gen!, type: 'continents', form: TWIN_CONTINENTS } });
    const p = eng.preview(cmd);
    expect(eng.exec(cmd)).toBe('换了星球形态：双子大陆');
    const gained: number[] = [];
    const lost: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (land0[i] !== w.causes.land[i]) (w.causes.land[i] ? gained : lost).push(i);
    expect(p.landGained).toEqual(gained);
    expect(p.landLost).toEqual(lost);
    expect(gained.length + lost.length).toBeGreaterThan(0);
    // 画过的改动照样叠在新的地形上
    expect(w.causes.landDelta).toEqual(delta);
    // 调过的陆地多少照旧
    expect(w.small.terrain.gen!.landFraction).toBe(0.3);
    // 去掉形态：type 不变
    const back = formCommand(w.small.terrain.gen!, null);
    expect(back.op === 'set_worldgen' && back.params).toEqual({ seed: 4, type: 'continents', landFraction: 0.3, mountains: 1, rerolls: [] });
    expect(eng.exec(back)).toBe('去掉了星球形态「双子大陆」');
    eng.undo();
    eng.undo();
    expect(digestWorld(w)).toEqual(before);
    // 重放与撤销逐值相同
    eng.redo();
    expect(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toEqual(digestWorld(w));
  });

  it('换成另一种星球的形态：type 跟着形态（环形内海是“内海”）；说的话', () => {
    const gen = { seed: 2, type: 'continents' as const, mountains: 1, rerolls: [], islands: 0.7 };
    expect(genWithForm(gen, RING_SEA)).toEqual({ ...gen, type: 'inland_sea', form: RING_SEA });
    expect(genWithForm({ ...gen, type: 'inland_sea', form: RING_SEA }, null)).toEqual({ ...gen, type: 'inland_sea' });
    expect(landNote(0, 0)).toBe('陆地看不出变化');
    expect(landNote(1234, 0)).toBe('会多出 1,234 格陆地（地图上淡黄的是多出的，斜线是会变成海的）');
    expect(landNote(12, 5)).toBe('会多出 12 格陆地、少掉 5 格（地图上淡黄的是多出的，斜线是会变成海的）');
  });
});
