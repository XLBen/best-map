import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { kindOf } from './content/registry';
import { Engine } from './engine';
import { featuresCsv } from './export';
import type { GeoFeature } from './features';
import { ringDistance } from './mesh';
import { BUILTIN_STYLES } from './packs/names';
import { naturalTarget } from './river-edit';
import { continents } from './testing/fixtures';

// 第二十轮：世界里的地名风格——只用内置中文时名字一个不变；启用、设为默认、单独给地物、省份换风格；
// 原文跟着改名、留着的名字、重放、撤销走；features.csv 只在有原文时多一列

const germanic = BUILTIN_STYLES.find((s) => s.id === 'west-germanic')!;
const japanese = BUILTIN_STYLES.find((s) => s.id === 'ja-kanji')!;
const names = (eng: Engine) => eng.world.derived.features.map((f) => [f.key, f.name, f.orig ?? null, f.style ?? null]);
const provinceNames = (eng: Engine) => Object.entries(eng.world.small.provinces).map(([id, p]) => [id, p.name, p.orig ?? null]);
const enable = (style: typeof germanic) => ({ op: 'set_content' as const, kind: 'nameStyle', id: style.id, item: style as unknown as Record<string, unknown> });

function expectReplay(eng: Engine) {
  const replay = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
  expect(names(replay)).toEqual(names(eng));
  expect(provinceNames(replay)).toEqual(provinceNames(eng));
  expect(digestWorld(replay.world)).toEqual(digestWorld(eng.world));
}

describe('世界里的地名风格', () => {
  it('启用一种风格但不用它：名字一个不变（不重新起名），世界只多了 content；停用后与没启用过一样', () => {
    const eng = continents({ provinces: true });
    const before = names(eng);
    const small = JSON.stringify(eng.world.small);
    eng.exec(enable(germanic));
    expect(eng.history.filter((h) => h.done).at(-1)!.summary).toMatch(/^启用地名风格“西欧·日耳曼”/);
    expect(names(eng)).toEqual(before);
    expect(Object.keys(eng.world.small.content!.nameStyle!)).toEqual(['west-germanic']);
    eng.exec({ op: 'set_content', kind: 'nameStyle', id: 'west-germanic', item: null });
    expect(JSON.stringify(eng.world.small)).toBe(small);
    // 内置中文不能换掉；格式不对、id 对不上的拒绝
    expect(() => eng.exec({ op: 'set_content', kind: 'nameStyle', id: 'zh-default', item: { ...germanic, id: 'zh-default' } })).toThrow(/内置中文不能换掉/);
    expect(() => eng.exec({ op: 'set_content', kind: 'nameStyle', id: 'x', item: { ...germanic } })).toThrow(/id 与命令里的不同/);
    expect(() => eng.exec({ op: 'set_content', kind: 'nameStyle', id: 'x', item: { id: 'x', kind: 'phonetic' } })).toThrow(/地名风格无效/);
    expect(() => eng.exec({ op: 'set_content', kind: 'nope', id: 'x', item: { id: 'x' } })).toThrow(/不认识的内容种类/);
  });

  it('设为世界默认：地名都换成这种风格、带原文；新划的省也是；重放、撤销一样', () => {
    const eng = continents();
    const zh = names(eng);
    eng.exec(enable(germanic));
    eng.exec({ op: 'set_name_style', id: 'west-germanic' });
    const fs = eng.world.derived.features.filter((f) => !f.custom && !f.region);
    expect(fs.length).toBeGreaterThan(10);
    // 生态区、带类型的地物按中文模板起名（没有原文），别的都有原文
    const withOrig = fs.filter((f) => f.orig);
    expect(withOrig.length / fs.length).toBeGreaterThan(0.8);
    for (const f of withOrig) expect(f.name).not.toMatch(/[A-Za-z]/);
    // 世界默认的风格不算“自己选的”
    expect(fs.every((f) => f.style === undefined)).toBe(true);
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    const ps = Object.values(eng.world.small.provinces);
    expect(ps.filter((p) => p.orig).length).toBeGreaterThan(ps.length * 0.8);
    // 新编号的省：省名连同原文记进命令（重放时照用）
    const land = [...Array(eng.world.mesh.n).keys()].filter((c) => eng.world.causes.land[c]).slice(0, 3);
    eng.exec({ op: 'assign_province', cells: land, province: 'new' });
    const cmd = eng.toDoc().commands.at(-1)!;
    const [id] = Object.keys(cmd.provinceNames ?? {});
    expect(cmd.provinceOrig?.[id]).toBe(eng.world.small.provinces[Number(id)].orig);
    expect(cmd.provinceOrig?.[id]).toMatch(/^[A-Z]/);
    expectReplay(eng);
    // 撤销划省、新省：还是这种风格；再撤销“设为默认”：回到中文
    eng.undo();
    eng.undo();
    expect(names(eng)).not.toEqual(zh);
    eng.undo();
    expect(names(eng)).toEqual(zh);
  });

  it('一个地物单独换风格：只有它换名字（种子带上风格 id），别的不变；换回自动后原样', () => {
    const eng = continents();
    eng.exec(enable(japanese));
    const before = names(eng);
    const isle = eng.world.derived.features.find((f) => f.type === 'island' && !f.custom)!;
    eng.exec({ op: 'set_feature_style', key: isle.key, style: 'ja-kanji' });
    const after = eng.world.derived.features.find((f) => f.key === isle.key)!;
    expect(after.style).toBe('ja-kanji');
    expect(after.name).toMatch(/島$/);
    expect(after.orig).toMatch(/shima$/);
    const others = (list: ReturnType<typeof names>) => list.filter(([k]) => k !== isle.key);
    expect(others(names(eng))).toEqual(others(before));
    expectReplay(eng);
    eng.exec({ op: 'set_feature_style', key: isle.key, style: null });
    expect(names(eng)).toEqual(before);
    expect(() => eng.exec({ op: 'set_feature_style', key: isle.key, style: 'nope' })).toThrow(/没有地名风格/);
  });

  it('一个省单独换风格：重新起名、带原文；重放一样；换回自动重新按中文起', () => {
    const eng = continents({ provinces: true });
    eng.exec(enable(germanic));
    const id = Number(Object.entries(eng.world.small.provinces).find(([, p]) => p.kind === 'land')![0]);
    const zhName = eng.world.small.provinces[id].name;
    eng.exec({ op: 'set_province', id, style: 'west-germanic' });
    const p = eng.world.small.provinces[id];
    expect([p.style, !!p.orig, p.name === zhName]).toEqual(['west-germanic', true, false]);
    expect(eng.history.filter((h) => h.done).at(-1)!.summary).toMatch(/地名风格改为“西欧·日耳曼”/);
    expectReplay(eng);
    eng.exec({ op: 'set_province', id, style: null });
    expect([p.style, p.orig]).toEqual([undefined, undefined]);
    expect(eng.world.small.provinces[id].orig).toBeUndefined();
    // 改名：原文跟着名字，没写原文时去掉
    eng.exec({ op: 'set_province', id, name: '卡尔', orig: 'Karl' });
    expect([eng.world.small.provinces[id].name, eng.world.small.provinces[id].orig]).toEqual(['卡尔', 'Karl']);
    eng.exec({ op: 'set_province', id, name: '别的' });
    expect(eng.world.small.provinces[id].orig).toBeUndefined();
  });

  it('改名带原文；只改中文名时原文去掉；换一个时也去掉', () => {
    const eng = continents();
    const isle = eng.world.derived.features.find((f) => f.type === 'island' && !f.custom)!;
    eng.exec({ op: 'rename_feature', key: isle.key, name: '卡尔维尔斯堡岛', orig: 'Karvilsburg' });
    const f = () => eng.world.derived.features.find((x) => x.key === isle.key)!;
    expect([f().name, f().orig, f().custom]).toEqual(['卡尔维尔斯堡岛', 'Karvilsburg', true]);
    eng.exec({ op: 'rename_feature', key: isle.key, orig: 'Karvilsborg' });
    expect(f().orig).toBe('Karvilsborg');
    eng.exec({ op: 'rename_feature', key: isle.key, name: '别的岛' });
    expect([f().name, f().orig]).toEqual(['别的岛', undefined]);
    eng.exec({ op: 'rename_feature', key: isle.key, name: '卡尔岛', orig: 'Karl' });
    eng.exec({ op: 'reroll_feature', key: isle.key });
    expect([f().custom, f().orig]).toEqual([false, undefined]);
    expectReplay(eng);
  });

  it('改地形后名字跟着地方走：自动起的名字连同原文一起留（keptNames）；重放一样', () => {
    const eng = continents();
    eng.exec(enable(germanic));
    eng.exec({ op: 'set_name_style', id: 'west-germanic' });
    const w = eng.world;
    const sea = w.derived.features.filter((f) => f.type === 'ocean' || f.type === 'sea').sort((a, b) => b.cells.length - a.cells.length)[0];
    expect(sea.orig).toBeDefined();
    const d = ringDistance(w.mesh, [sea.anchor], 3);
    const cells = [...Array(w.mesh.n).keys()].filter((c) => d[c] >= 0 && !w.causes.land[c]);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
    const rest = w.derived.features.find((f) => f.name === sea.name)!;
    expect(rest.key).not.toBe(sea.key);
    expect(rest.orig).toBe(sea.orig);
    expect(w.small.keptNames?.[rest.key]).toMatchObject({ name: sea.name, orig: sea.orig });
    expectReplay(eng);
  });

  it('固定一条自然的河：记下的自动名字连同原文（autoOrig），按它叫', () => {
    const eng = continents();
    eng.exec(enable(germanic));
    eng.exec({ op: 'set_name_style', id: 'west-germanic' });
    const w = eng.world;
    const river = w.derived.features.find((f) => f.type === 'river' && f.guide === undefined && f.orig)!;
    const T = naturalTarget(w, w.derived, river.anchor)!;
    expect([T.guide.autoName, T.guide.autoOrig]).toEqual([river.name, river.orig]);
    const { id: _, ...guide } = T.guide;
    eng.exec({ op: 'add_guide', guide });
    const pinned = w.derived.features.find((f) => f.guide !== undefined && f.name === river.name)!;
    expect([pinned.orig, pinned.custom]).toEqual([river.orig, false]);
    // 去掉记下的名字时原文一起去掉
    eng.exec({ op: 'update_guide', id: pinned.guide!, patch: { autoName: null, salt: 1 } });
    expect(w.small.guides.find((g) => g.id === pinned.guide)!.autoOrig).toBeUndefined();
    expectReplay(eng);
  });

  it('features.csv：没有原文时与以前一字不差；有原文时多一列 orig', () => {
    const eng = continents();
    const plain = featuresCsv(eng.world, 400, 200);
    expect(plain.split('\n')[0]).toBe('type,type_name,name,custom,area_km2,x_px,y_px,lat,lon,key');
    eng.exec(enable(germanic));
    // 启用了没用：照旧
    expect(featuresCsv(eng.world, 400, 200)).toBe(plain);
    eng.exec({ op: 'set_name_style', id: 'west-germanic' });
    const rows = featuresCsv(eng.world, 400, 200).trim().split('\n');
    expect(rows[0]).toBe('type,type_name,name,orig,custom,area_km2,x_px,y_px,lat,lon,key');
    const top = [...eng.world.derived.features].filter((f) => !f.hidden).sort((a, b) => b.importance - a.importance)[0] as GeoFeature;
    expect(rows[1].split(',').slice(2, 4)).toEqual([top.name, top.orig ?? '']);
  });

  it('登记表：地名风格放在 small.content，改了在用的才重新起名', () => {
    const kind = kindOf('nameStyle')!;
    expect([kind.store, kind.pack.key, kind.pack.aliases]).toEqual(['content', 'nameStyles', ['textPacks']]);
    const eng = continents();
    eng.exec(enable(germanic));
    expect(kind.inWorld(eng.world).map((s) => (s as { id: string }).id)).toEqual(['zh-default', 'west-germanic']);
    expect(kind.dirty!(germanic, germanic, eng.world)).toBe('none');
    eng.exec({ op: 'set_name_style', id: 'west-germanic' });
    expect(kind.dirty!(germanic, germanic, eng.world)).toBe('names');
  });
});
