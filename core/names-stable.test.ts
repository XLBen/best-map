import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { Engine } from './engine';
import { type GeoFeature, assignNames } from './features';
import { ringDistance } from './mesh';
import { DEFAULT_PACK, type WordPack } from './names';
import { encodePath } from './rivers';
import { isRiverCell, planCourse, riverStem, stemPath } from './select';
import { fantasyBiomeCommands } from './packs/fantasy-biomes';
import { continents, engineFor, snapshot } from './testing/fixtures';

// 第九轮：名字不乱跳。浏览器里在整个星球 + 奇幻生态上找到的几种情形：
// - 在开阔的海上画一大块陆地：洋的锚点格被涂掉，洋改了名；远处的森林、一条山脉也改了名，新出来的山脉拿走了老山脉的名字；
// - 接着在新陆地上堆山：一条键、锚点都没变的河改了名，那条山脉又换回来；
// - 放一个小礁（多一格陆地）：两片海改了名；
// - 在沙漠中间硬涂一块水晶丛林：没涂的那一大片沙漠、旁边的冰原都改了名。
// 现在每一步编辑之后，配得上的地物（键相同，或同一种里格子大半重叠）照旧叫原来的名字，新出来的另起名字；
// 记进命令，所以从头重放与一步一步编辑一字不差

const kind = (f: GeoFeature) => `${f.type}|${f.species ?? ''}`;

// 编辑前后的地物：名字该留着的却变了的，列出来（空表示都没变）。
// 键相同的同一种地物名字不变；键没了的旧地物与新出来的同一种地物，格子重叠占两者中小的那个一半以上的，
// 按重叠从多到少配成一对（几个岛连成一个时，连成的岛叫重叠最多的那个的名字），配上的叫原来的名字；
// 新出来的地物不能叫还在用的旧名字
function jumps(before: GeoFeature[], after: GeoFeature[]): string[] {
  const out: string[] = [];
  const old = new Map(before.filter((f) => !f.region).map((f) => [f.key, f]));
  const keys = new Set(after.map((f) => f.key));
  const paired = new Set<GeoFeature>();
  for (const f of after) {
    const o = old.get(f.key);
    if (!o || kind(o) !== kind(f)) continue;
    paired.add(f);
    if (o.name !== f.name) out.push(`${f.key}: ${o.name} → ${f.name}`);
  }
  const cand: [number, GeoFeature, GeoFeature][] = [];
  for (const o of before) {
    if (o.region || keys.has(o.key) || o.guide) continue;
    const inside = new Set(o.cells);
    for (const f of after) {
      if (paired.has(f) || old.has(f.key) || kind(f) !== kind(o)) continue;
      let n = 0;
      for (const c of f.cells) if (inside.has(c)) n++;
      if (n && n * 2 >= Math.min(o.cells.length, f.cells.length)) cand.push([n, o, f]);
    }
  }
  const done = new Set<GeoFeature>();
  for (const [, o, f] of cand.sort((a, b) => b[0] - a[0])) {
    if (done.has(o) || paired.has(f)) continue;
    done.add(o);
    paired.add(f);
    if (f.name !== o.name) out.push(`${o.key} → ${f.key}: ${o.name} → ${f.name}`);
  }
  const kept = new Set([...paired].map((f) => f.name));
  for (const f of after) if (!paired.has(f) && !old.has(f.key) && !f.region && kept.has(f.name)) out.push(`新的 ${f.key} 拿走了 ${f.name}`);
  return out;
}

const list = (eng: Engine) => eng.world.derived.features.map((f) => `${f.key}=${f.name}|${f.custom}`);

// 从头重放与一步一步编辑一字不差
function expectReplay(eng: Engine) {
  const replay = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
  expect(list(replay)).toEqual(list(eng));
  expect(digestWorld(replay.world)).toEqual(digestWorld(eng.world));
}

// 离 seed 不超过 r 步、满足 ok 的格
function disc(eng: Engine, seed: number, r: number, ok: (c: number) => boolean): number[] {
  const d = ringDistance(eng.world.mesh, [seed], r);
  return [...Array(eng.world.mesh.n).keys()].filter((c) => d[c] >= 0 && ok(c));
}

const withFantasy = (eng: Engine) => {
  eng.exec(fantasyBiomeCommands({ fields: Object.keys(eng.world.causes.fields), species: eng.world.small.species.map((s) => s.id) }));
  return eng;
};

const worlds = {
  region: () => snapshot('names-stable:region', () => withFantasy(continents())),
  planet: () =>
    snapshot('names-stable:planet', () => {
      const eng = engineFor({ cells: 8000, seed: 5, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 });
      eng.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
      return withFantasy(eng);
    }),
};

describe('名字不乱跳', () => {
  for (const name of ['region', 'planet'] as const) {
    it(`${name}：海上画陆地盖掉洋的锚点、在新陆地上堆山、放小礁、在沙漠中间硬涂别的生态`, () => {
      const eng = worlds[name]();
      const w = eng.world;
      const { mesh } = w;
      const features = () => w.derived.features;

      // 1. 最大的海或洋：在它的锚点周围（只在海上）画一大块陆地，盖掉锚点
      const sea = features()
        .filter((f) => f.type === 'ocean' || f.type === 'sea')
        .sort((a, b) => b.cells.length - a.cells.length)[0];
      const cells = disc(eng, sea.anchor, 3, (c) => !w.causes.land[c]);
      expect(cells).toContain(sea.anchor);
      let before = features();
      eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
      expect(jumps(before, features())).toEqual([]);
      const rest = features().find((f) => f.type === sea.type && f.cells.some((c) => sea.cells.includes(c)) && f.name === sea.name);
      expect(rest, '没被涂掉的那片海还叫原来的名字').toBeDefined();
      expect(rest!.key).not.toBe(sea.key);

      // 2. 在新陆地上堆山
      before = features();
      const land = cells.filter((c) => w.causes.land[c]);
      eng.exec({ op: 'paint_relief', cells: land, t: land.map(() => 0), strength: 2 });
      expect(jumps(before, features())).toEqual([]);

      // 3. 在另一片海里放一个小礁
      const other = features()
        .filter((f) => (f.type === 'ocean' || f.type === 'sea') && f.key !== rest!.key)
        .sort((a, b) => b.cells.length - a.cells.length)[0];
      const at = other.cells[Math.floor(other.cells.length / 2)];
      before = features();
      eng.exec({ op: 'add_island', island: { x: mesh.x[at], y: mesh.y[at], kind: 'reef', size: 20, variant: 1 } });
      expect(jumps(before, features())).toEqual([]);

      // 4. 在最大的一片沙漠（小星球上沙漠太小时用最大的一片森林、冻原）中间（含锚点）硬涂一块水晶丛林：
      // 没涂的那一大片还叫原来的名字，涂的那块另起名字
      const desert = features()
        .filter((f) => ['desert', 'forest', 'tundra'].includes(f.type) && f.species === undefined)
        .sort((a, b) => (b.type === 'desert' && b.cells.length >= 100 ? 1e6 : 0) + b.cells.length - (a.type === 'desert' && a.cells.length >= 100 ? 1e6 : 0) - a.cells.length)[0];
      expect(desert.cells.length).toBeGreaterThan(60);
      const inDesert = new Set(desert.cells);
      const ring = ringDistance(mesh, [desert.anchor], 10);
      const hole = Array.from(desert.cells)
        .filter((c) => ring[c] >= 0)
        .sort((a, b) => ring[a] - ring[b] || a - b)
        .slice(0, 12);
      before = features();
      eng.exec({ op: 'add_constraint', constraint: { cells: hole, species: 'crystal_jungle', mode: 'override', ratio: 1, radius: 300 } });
      expect(jumps(before, features())).toEqual([]);
      const left = features().filter((f) => f.type === desert.type && f.species === undefined && f.cells.some((c) => inDesert.has(c)));
      expect(left.map((f) => f.name)).toContain(desert.name);
      const crystal = features().filter((f) => f.species === 'crystal_jungle' && f.cells.some((c) => hole.includes(c)));
      expect(crystal.length).toBe(1);
      expect(crystal[0].name).not.toBe(desert.name);

      expectReplay(eng);
    });
  }

  it('新出来的地物不抢原有地物的名字（字很少的文字包：常常撞名）', () => {
    // 岛只有 12 个名字可选（别的照内置的包），岛有六到九个：常常撞名。新放的岛与原有的岛连成一个大岛时，
    // 以前大岛先挑走别的岛的名字（“戊岛”），那个岛只好换一个；河的名字也因为撞名、先后变了而跳
    const pack: WordPack = {
      ...DEFAULT_PACK,
      id: 'few',
      name: '少字',
      lists: { ...DEFAULT_PACK.lists, few: [...'甲乙丙丁戊己庚辛壬癸子丑'] },
      types: { ...DEFAULT_PACK.types, island: { patterns: [{ p: '{few}岛' }] } },
    };
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_word_pack', pack });
    const deep = [...Array(w.mesh.n).keys()].filter((c) => w.derived.elevation[c] < -3000);
    let placed = 0;
    for (let k = 0; k < 6; k++) {
      const c = deep[Math.floor((deep.length * (k + 0.5)) / 6)];
      if (w.causes.land[c]) continue;
      const before = w.derived.features;
      eng.exec({ op: 'add_island', island: { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'continental', size: 500, variant: k + 1 } });
      expect(jumps(before, w.derived.features), `第 ${k} 个岛`).toEqual([]);
      placed++;
    }
    expect(placed).toBeGreaterThan(3);
    expectReplay(eng);
  });

  it('改过的名字跟着地方走：锚点被盖掉也不丢；撤销、重做、重放都一样', () => {
    const eng = worlds.region();
    const w = eng.world;
    const sea = w.derived.features.filter((f) => f.type === 'ocean' || f.type === 'sea').sort((a, b) => b.cells.length - a.cells.length)[0];
    eng.exec({ op: 'rename_feature', key: sea.key, name: '我的海' });
    const named = list(eng);
    const cells = disc(eng, sea.anchor, 3, (c) => !w.causes.land[c]);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
    const mine = w.derived.features.filter((f) => f.name === '我的海');
    expect(mine.length).toBe(1);
    expect(mine[0].custom).toBe(true);
    expect(mine[0].key).not.toBe(sea.key);
    const after = list(eng);
    expectReplay(eng);
    eng.undo();
    expect(list(eng)).toEqual(named);
    eng.redo();
    expect(list(eng)).toEqual(after);
    // 恢复自动命名
    eng.exec({ op: 'rename_feature', key: mine[0].key, name: '' });
    const auto = w.derived.features.find((f) => f.key === mine[0].key)!;
    expect([auto.name === '我的海', auto.custom]).toEqual([false, false]);
  });

  it('留着的名字照样能重抽、换文字包：起名的办法变了就不再留', () => {
    const eng = worlds.region();
    const w = eng.world;
    const sea = w.derived.features.filter((f) => f.type === 'ocean' || f.type === 'sea').sort((a, b) => b.cells.length - a.cells.length)[0];
    const cells = disc(eng, sea.anchor, 3, (c) => !w.causes.land[c]);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
    const rest = w.derived.features.find((f) => f.name === sea.name)!;
    expect(rest.key).not.toBe(sea.key);
    expect(w.small.keptNames?.[rest.key]?.name).toBe(sea.name);
    // 重抽：换了名字；再编辑别处也不会换回来
    eng.exec({ op: 'reroll_feature', key: rest.key });
    const rolled = w.derived.features.find((f) => f.key === rest.key)!.name;
    expect(rolled).not.toBe(sea.name);
    const land = [...Array(w.mesh.n).keys()].filter((c) => w.causes.land[c]);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 100), value: 2, mode: 'add' });
    expect(w.derived.features.find((f) => f.key === rest.key)!.name).toBe(rolled);
    eng.undo();
    eng.undo();
    expect(w.derived.features.find((f) => f.key === rest.key)!.name).toBe(sea.name);
    // 换文字包：留着的名字不再用，名字全按新的包
    const pack: WordPack = { id: 'p', name: '包', lists: { a: [...'甲乙丙丁戊己庚辛壬癸'] }, types: { sea: { patterns: [{ p: '{a}{a}海' }] }, ocean: { patterns: [{ p: '{a}{a}洋' }] } } };
    eng.exec({ op: 'set_word_pack', pack });
    expect(w.derived.features.find((f) => f.key === rest.key)!.name).toMatch(/^[甲乙丙丁戊己庚辛壬癸]{2}[海洋]$/);
    expectReplay(eng);
  });

  it('换个形状：岛还叫原来的名字；先预览再执行（采用预览）与直接执行一样', () => {
    const eng = worlds.region();
    const w = eng.world;
    const c = [...Array(w.mesh.n).keys()].find((i) => w.derived.elevation[i] < -3000 && i % 7 === 3)!;
    const island = (variant: number) => ({ op: 'add_island' as const, island: { x: w.mesh.x[c], y: w.mesh.y[c], kind: 'continental' as const, size: 400, variant } });
    eng.exec(island(1));
    const first = w.derived.features.find((f) => f.type === 'island' && f.cells.includes(c))!;
    eng.replaceLast(island(2));
    const second = w.derived.features.find((f) => f.type === 'island' && f.cells.includes(c))!;
    expect(second.name).toBe(first.name);
    expectReplay(eng);
    // 盖掉一片海的锚点：先预览再执行与直接执行的名字、命令都一样
    const sea = w.derived.features.filter((f) => f.type === 'ocean' || f.type === 'sea').sort((a, b) => b.cells.length - a.cells.length)[0];
    const cells = disc(eng, sea.anchor, 3, (i) => !w.causes.land[i]);
    const cmd = { op: 'paint_land' as const, cells, t: cells.map(() => 0), mode: 'land' as const };
    const direct = eng.clone();
    direct.exec(cmd);
    const previewed = eng.clone();
    previewed.preview(cmd);
    previewed.exec(cmd);
    expect(list(previewed)).toEqual(list(direct));
    expect(previewed.toDoc()).toEqual(direct.toDoc());
    expect(direct.toDoc().commands.at(-1)!.nameCarry).toBeDefined();
  });

  it('固定一条留着名字的自然河：名字照旧', () => {
    const base = continents();
    const river = base.world.derived.features.filter((f) => f.type === 'river' && !f.guide).sort((a, b) => b.importance - a.importance)[0];
    // 让这条河留着一个名字（就像它的锚点挪过一次）：存档的命令里记下的照用
    const copies = base.world.derived.features.map((f) => ({ ...f }));
    const ctx = assignNames(base.world, copies).get(copies[base.world.derived.features.indexOf(river)])!.ctx!;
    const doc = base.toDoc();
    doc.commands.push({ op: 'set_word_pack', pack: null, nameCarry: { keep: { [river.key]: { name: '测试河', ctx } } } });
    const eng = Engine.fromDoc(doc, base.world.mesh);
    const w = eng.world;
    expect(w.derived.features.find((f) => f.key === river.key)!.name).toBe('测试河');
    const stem = riverStem(w, w.derived, river.anchor);
    eng.exec({ op: 'add_guide', guide: { id: 'pin', cells: stem.cells, path: stemPath(w, stem.cells), locked: true, spring: false, nameKey: river.key } });
    const pinned = w.derived.features.find((f) => f.key === 'guide:pin')!;
    expect([pinned.name, pinned.custom]).toEqual(['测试河', false]);
    expectReplay(eng);
  });

  // 第十二轮修：放了湖之后出湖的河水少了、不再标，再画一条河流进湖里，出湖的河又标出来，名字却换了
  // （同一个键、起名的办法也一样，只是大小的标签变了，按标签挑的模板就不同）。这一步里没了的自然的河留着名字，
  // 又出来时照旧叫它。这里用河的门槛做出“没了又出来、标签变了”：先调高到它不够标，再调低到它成了大河
  it('自然的河没了又出来（大小的标签变了）：还叫原来的名字；重放一样', () => {
    const eng = continents();
    const w = eng.world;
    const thr = w.small.planet.riverThreshold;
    const q = (f: GeoFeature) => w.derived.discharge[f.anchor!];
    const rivers = w.derived.features.filter((f) => f.type === 'river' && !f.guide && !f.tags.includes('big'));
    expect(rivers.length).toBeGreaterThan(3);
    const before = new Map(rivers.map((f) => [f.key, f.name]));
    // 门槛调高到这几条河都不够标（河口的流量不到门槛的 3 倍）
    const top = Math.max(...rivers.map(q));
    eng.exec({ op: 'set_planet', patch: { riverThreshold: Math.ceil(top / 2) } });
    for (const key of before.keys()) expect(w.derived.features.some((f) => f.key === key)).toBe(false);
    // 门槛调低：都成了大河（标签变了），名字照旧
    eng.exec({ op: 'set_planet', patch: { riverThreshold: Math.max(1, Math.floor(Math.min(...rivers.map(q)) / 41)) } });
    let back = 0;
    for (const [key, name] of before) {
      const f = w.derived.features.find((x) => x.key === key);
      if (!f) continue;
      back++;
      expect(f.tags).toContain('big');
      expect(f.name, key).toBe(name);
    }
    expect(back).toBeGreaterThan(2);
    expect(thr).toBeGreaterThan(1);
    expectReplay(eng);
  });

  it('放湖、出湖的河、画一条河流进湖里：原有的河都不换名字', () => {
    const base = continents();
    const w0 = base.world;
    const { mesh } = w0;
    const river = w0.derived.features.filter((f) => f.type === 'river' && !f.guide).sort((a, b) => b.cells.length - a.cells.length)[0];
    // 在最长的那条河的中上游放湖：出湖的河就是原来那条河的下游
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'add_lake', lake: { cell: river.cells[Math.floor(river.cells.length * 0.6)], radius: 2.5 * mesh.spacing * w.kmPerUnit, depth: 150, perennial: true } });
    const lake = [...Array(mesh.n).keys()].filter((c) => w.derived.lake[c] === 1 && w.causes.land[c]);
    expect(lake.length).toBeGreaterThan(3);
    const outlet = w.derived.features.find((f) => f.key === river.key);
    expect(outlet?.name).toBe(river.name);
    const before = w.derived.features.filter((f) => f.type === 'river').map((f) => ({ ...f }));
    // 从湖外 9 格画一条直着流进湖的河（不穿过别的河）
    const L = lake[Math.floor(lake.length / 2)];
    let drawn = false;
    for (let a = 0; a < 16 && !drawn; a++) {
      const ang = (a / 16) * 2 * Math.PI;
      const from: [number, number] = [mesh.x[L] + 9 * mesh.spacing * Math.cos(ang), mesh.y[L] + 9 * mesh.spacing * Math.sin(ang)];
      const stroke = Array.from({ length: 41 }, (_, k) => [from[0] + ((mesh.x[L] - from[0]) * k) / 40, from[1] + ((mesh.y[L] - from[1]) * k) / 40] as [number, number]);
      const plan = planCourse(w, w.derived, stroke, { endOnLand: 'flow' });
      if (plan.blocked || plan.end !== 'lake' || plan.crossings.length || plan.reroute || isRiverCell(w, w.derived, plan.cells[0])) continue;
      eng.exec({ op: 'add_guide', guide: { cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 30, name: '' } });
      drawn = true;
    }
    expect(drawn).toBe(true);
    expect(jumps(before, w.derived.features.filter((f) => f.type === 'river' && !f.guide))).toEqual([]);
    expect(w.derived.features.find((f) => f.key === river.key)?.name).toBe(river.name);
    expectReplay(eng);
  });
});
