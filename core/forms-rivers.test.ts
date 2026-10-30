import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { Engine, passStats } from './engine';
import { applyPackCommands, packFromWorld, readPack } from './packs';

import { TWIN_CONTINENTS } from './packs/fantasy-forms';
import type { PlanetForm } from './planet-form';
import type { RiverType } from './river-types';
import { findScripts } from './script';
import { continents, engineFor, meshFor, snapshot, FANTASY_PACK } from './testing/fixtures';

// 两支合在一起以后：星球形态（布局、地形脚本）与河流类型（match 脚本）、生态和河对周围的影响、
// 自带地名设定的生态自然长成的一片，放在同一个星球上：
// - 两种脚本的问题都记进 d.scriptIssues（星球形态的在前、河流类型的在后），有影响时多算的那一遍里不重复、不丢；
// - 从检查点恢复（地形没有重新组合过）后改河流类型，问题与推导都和从头重放的相同；撤销回到原样；
// - 起名的第二轮里两种新地物都在、不抢第一轮的名字，重放名字相同；
// - 从世界导出时星球形态、河流类型都带上，包里的脚本都列出来（信任检查用）

const settings = { cells: 4000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 };
const src = (s: string) => ({ api: 1 as const, src: s });
// 南边高纬度的格算出 NaN：这些格按没有脚本算，问题记下
const badForm: PlanetForm = { ...TWIN_CONTINENTS, scripts: { ...TWIN_CONTINENTS.scripts, crust: src('return lat < -60 ? NaN : height;') } };
// 每条河都出错的规则（第 2 行）：按不匹配处理，问题记下
const badRiver: RiverType = { id: 'bad_river', name: '坏河', color: '#336699', scripts: { match: src('const o = undefined;\nreturn o.x;') } };
// 排在最后、收下剩下的大河：一定有带类型、按模板起名的河
const longRiver: RiverType = { id: 'long_river', name: '长河', color: '#2255aa', names: [{ p: '{color}长河' }], scripts: { match: src('return discharge >= 2 * riverThreshold;') } };

function planet(): Engine {
  return snapshot('forms-rivers', () => {
    const eng = engineFor(settings);
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', form: badForm }, reset: true });
    eng.exec(applyPackCommands(eng.world, FANTASY_PACK));
    eng.exec({ op: 'set_river_type', type: badRiver });
    eng.exec({ op: 'set_river_type', type: longRiver });
    return eng;
  });
}

const issueKinds = (e: Engine) => e.world.derived.scriptIssues?.map((x) => [x.kind, x.owner]);

describe('星球形态与河流类型、对周围的影响在同一个星球上', () => {
  it('两种脚本的问题都记进 d.scriptIssues：星球形态的在前、河流类型的在后；有影响时多算的一遍里不重复', () => {
    const eng = planet();
    const d = eng.update();
    // 示例生态带着对周围的影响：多算了一遍
    expect(d.effT).toBeInstanceOf(Float32Array);
    expect(d.riverType).toBeInstanceOf(Uint8Array);
    expect(issueKinds(eng)).toEqual([
      ['crust', '双子大陆'],
      ['match', '坏河'],
    ]);
    expect(d.scriptIssues![1]).toMatchObject({ id: 'bad_river', line: 2 });
    // 改一种河两岸的影响：从水文起重算，两遍（第一遍、加了影响的一遍），问题照样只各一条
    const before = passStats.passes;
    eng.exec({ op: 'set_river_type', type: { ...longRiver, bank: { radiusKm: 150, dT: 2, dP: -0.2 } } });
    eng.update();
    expect(passStats.passes - before).toBe(2);
    expect(issueKinds(eng)).toEqual([
      ['crust', '双子大陆'],
      ['match', '坏河'],
    ]);
    // 规则改好：只剩星球形态的
    eng.exec({ op: 'set_river_type', type: { ...badRiver, scripts: { match: src('return false;') } } });
    expect(issueKinds(eng)).toEqual([['crust', '双子大陆']]);
  });

  it('从检查点恢复后改河流类型：问题、推导与从头重放的逐值相同；撤销回到原样', () => {
    const eng = planet();
    const doc = eng.toDoc();
    expect(doc.version).toBe(9);
    const mesh = meshFor(settings);
    const replay = Engine.fromDoc(doc, mesh);
    expect(digestWorld(replay.world)).toEqual(digestWorld(eng.world));
    expect(replay.world.derived.scriptIssues).toEqual(eng.world.derived.scriptIssues);
    // 检查点存进 IndexedDB 时是结构化复制的；恢复后地形没有重新组合过，星球形态的问题照上一次的
    const restored = Engine.fromCheckpoint(structuredClone(eng.toCheckpoint()), doc, mesh)!;
    expect(restored).not.toBeNull();
    const before = digestWorld(eng.world);
    const edit = { op: 'set_river_type' as const, type: { ...longRiver, bank: { radiusKm: 150, dT: 2, dP: -0.2 } } };
    for (const e of [eng, restored, replay]) e.exec(edit);
    expect(digestWorld(restored.world)).toEqual(digestWorld(replay.world));
    expect(digestWorld(eng.world)).toEqual(digestWorld(replay.world));
    expect(restored.world.derived.scriptIssues).toEqual(replay.world.derived.scriptIssues);
    expect(issueKinds(restored)).toEqual([
      ['crust', '双子大陆'],
      ['match', '坏河'],
    ]);
    eng.undo();
    expect(digestWorld(eng.world)).toEqual(before);
  });

  it('起名的第二轮里有自然长成的自带地名的一片、按模板起名的带类型的河；从头重放名字相同', () => {
    // 4 千格的星球上示例生态连不成 8 格以上的一片：用 1.2 万格的大陆
    const eng = continents();
    eng.exec(applyPackCommands(eng.world, FANTASY_PACK));
    eng.exec({ op: 'set_river_type', type: longRiver });
    const fs = eng.world.derived.features;
    // 没涂过生态：带生态的地物都是自然长成的
    const own = fs.filter((f) => f.species !== undefined);
    const typed = fs.filter((f) => f.type === 'river' && f.tags.includes('rtype:long_river'));
    expect(own.length).toBeGreaterThan(0);
    expect(typed.length).toBeGreaterThan(0);
    for (const f of typed) expect(f.name).toMatch(/长河$/);
    // 第二轮的名字不与第一轮的重名（不抢原有地物的名字）
    const first = new Set(fs.filter((f) => f.species === undefined && !f.tags.some((t) => t.startsWith('rtype:'))).map((f) => f.name));
    for (const f of [...own, ...typed]) expect(first.has(f.name), f.name).toBe(false);
    const replay = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(replay.world.derived.features.map((f) => [f.key, f.name])).toEqual(fs.map((f) => [f.key, f.name]));
  });

  it('从世界导出：星球形态、河流类型都带上，读回来一样；包里的脚本（布局、地形、match）都列出来', () => {
    const eng = planet();
    const out = packFromWorld(eng.world, { biomes: [] }, { name: '我的星球' });
    expect(out.planetForms).toEqual([badForm]);
    expect(out.riverTypes?.map((t) => t.id)).toEqual([...FANTASY_PACK.riverTypes!.map((t) => t.id), 'bad_river', 'long_river']);
    const back = readPack(JSON.stringify(out));
    expect(back.ok && back.pack).toEqual(out);
    const kinds = new Set(findScripts(out).map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['crust', 'match', 'setup']);
    // 世界文件里也是（打开别人的世界时问信任）
    const inDoc = new Set(findScripts(eng.toDoc()).map((s) => s.kind));
    for (const k of ['setup', 'crust', 'match', 'placement']) expect(inDoc.has(k as never), k).toBe(true);
  });
});
