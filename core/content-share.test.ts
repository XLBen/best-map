import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { applyCommand, type Command, Dirty } from './commands';
import { allKinds, itemId } from './content/registry';
import { Engine } from './engine';
import { builtinPacks } from './packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from './packs/import';
import { postedPatch, previewPatch, previewWorldOf } from './preview-world';
import { cloneSmall, copySmall, restoreSmall, sameAsCopy } from './small-copy';
import { snapshot } from './testing/fixtures';
import type { SmallState, World } from './world';

// 第四十七轮：small.content 在撤销、比较、克隆、快照里按引用共用。这里查的是：
//   - 带着一整个库的世界上撤销、重做、重放与以前逐字节相同，“没有变化”照旧；
//   - 新的副本、比较与旧的写法（整段 JSON）逐位相同；
//   - 所有改内容的命令都是换掉、不是就地改（把内容冻住跑一遍，就地改会抛错）。

const CELLS = 4000;
const newWorld = (): Engine => {
  const eng = new Engine({ seed: 3, cells: CELLS });
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']] }, eng.world)) eng.exec(c);
  return eng;
};
const library = () => snapshot('r47:library', newWorld);

const text = (e: Engine) => JSON.stringify(e.world.small);
const land = (e: Engine) => {
  const out: number[] = [];
  for (let i = 0; i < e.world.mesh.n; i++) if (e.world.causes.land[i]) out.push(i);
  return out;
};

function deepFreeze(o: unknown) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return;
  Object.freeze(o);
  for (const v of Object.values(o)) deepFreeze(v);
}

// 一组混合的编辑：不重算的、重算的、改内容的、加内容的、删内容的、排先后的
function edits(e: Engine): Command[] {
  const cells = land(e).slice(40, 70);
  const content = e.world.small.content!;
  const point = Object.values(content.pointType!)[0] as { id: string; name: string };
  const style = Object.keys(content.mapStyle!).find((id) => id !== e.world.small.mapStyle)!;
  const ids = Object.keys(content.resource!);
  return [
    { op: 'set_map_style', id: style },
    { op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.5 },
    { op: 'set_content', kind: 'pointType', id: point.id, item: { ...point, name: `${point.name}二` } },
    { op: 'set_content', kind: 'pointType', id: 'r47-new', item: { ...point, id: 'r47-new', name: '新的点' } },
    { op: 'order_content', kind: 'resource', ids: [...ids].reverse() },
    { op: 'paint', field: 'tempOffset', cells, value: -1, mode: 'add' },
    { op: 'set_content', kind: 'pointType', id: 'r47-new', item: null },
    { op: 'generate_provinces', rules: { seed: 2 } },
  ];
}

describe('带库的世界：内容共用之后', () => {
  it('撤销、重做每一步都逐字节回到当时的样子（小数据、原因、推导的摘要）', () => {
    const eng = library().clone();
    const before = [text(eng)];
    const digests = [digestWorld(eng.world)];
    for (const c of edits(eng)) {
      eng.exec(c);
      eng.update();
      before.push(text(eng));
      digests.push(digestWorld(eng.world));
    }
    for (let k = before.length - 2; k >= 0; k--) {
      expect(eng.undo()).toBe(true);
      eng.update();
      expect(text(eng)).toBe(before[k]);
      expect(digestWorld(eng.world)).toEqual(digests[k]);
    }
    for (let k = 1; k < before.length; k++) {
      expect(eng.redo()).toBe(true);
      eng.update();
      expect(text(eng)).toBe(before[k]);
      expect(digestWorld(eng.world)).toEqual(digests[k]);
    }
  });

  it('改内容再撤销：内容逐字节回来，还是原来那个对象；没动到的种类一直共用', () => {
    const eng = library().clone();
    const c0 = eng.world.small.content!;
    const bytes = JSON.stringify(c0);
    const point = Object.values(c0.pointType!)[0] as { id: string; name: string };
    eng.exec({ op: 'set_content', kind: 'pointType', id: point.id, item: { ...point, name: '改了' } });
    const c1 = eng.world.small.content!;
    expect(c1).not.toBe(c0);
    expect(c1.culture).toBe(c0.culture);
    expect(c1.pointType).not.toBe(c0.pointType);
    expect(JSON.stringify(c0)).toBe(bytes);
    eng.undo();
    expect(eng.world.small.content).toBe(c0);
    expect(JSON.stringify(eng.world.small.content)).toBe(bytes);
    eng.redo();
    expect(JSON.stringify(eng.world.small.content)).toBe(JSON.stringify(c1));
  });

  it('从头重放的摘要相同（中间撤销、重做过）', () => {
    const eng = library().clone();
    const list = edits(eng);
    for (const c of list.slice(0, 5)) eng.exec(c);
    eng.undo();
    eng.undo();
    eng.redo();
    for (const c of list.slice(5)) eng.exec(c);
    eng.update();
    const replay = Engine.fromDoc(eng.toDoc());
    replay.update();
    expect(text(replay)).toBe(text(eng));
    expect(digestWorld(replay.world)).toEqual(digestWorld(eng.world));
  });

  it('什么都没改的命令照旧是“没有变化”：不进历史、内容还是那个对象', () => {
    const eng = library().clone();
    const c0 = eng.world.small.content!;
    const point = Object.values(c0.pointType!)[0] as { id: string };
    const steps = eng.toDoc().commands.length;
    eng.exec({ op: 'set_content', kind: 'pointType', id: point.id, item: { ...point } });
    expect(eng.lastNoop).toBe(true);
    eng.exec({ op: 'order_content', kind: 'resource', ids: Object.keys(c0.resource!) });
    expect(eng.lastNoop).toBe(true);
    expect(eng.toDoc().commands.length).toBe(steps);
    expect(eng.world.small.content).toBe(c0);
    // 真改了的不算
    eng.exec({ op: 'set_content', kind: 'pointType', id: point.id, item: { ...point, name: '改了' } });
    expect(eng.lastNoop).toBe(false);
  });

  it('做不了的命令：小数据逐字节回到执行前（内容还是那个对象）', () => {
    const eng = library().clone();
    const c0 = eng.world.small.content!;
    const before = text(eng);
    expect(() => eng.exec({ op: 'batch', commands: [{ op: 'set_content', kind: 'pointType', id: 'r47-x', item: { ...(Object.values(c0.pointType!)[0] as object), id: 'r47-x' } }, { op: 'set_content', kind: 'pointType', id: 'r47-none', item: null }] })).toThrow();
    expect(text(eng)).toBe(before);
    expect(eng.world.small.content).toBe(c0);
  });

  it('每步的撤销记录不带内容（只留引用）：检查点克隆之后还是共用一份', () => {
    const eng = library().clone();
    const size = JSON.stringify(eng.world.small.content).length;
    expect(size).toBeGreaterThan(200_000);
    for (const c of edits(eng).slice(0, 2)) eng.exec(c);
    const cp = eng.toCheckpoint();
    const steps = cp.done.slice(-2);
    for (const h of steps) {
      expect(h.undo.small.length).toBeLessThan(size / 2);
      expect(h.undo.content).toBe(eng.world.small.content);
    }
    const copy = structuredClone(cp);
    for (const h of copy.done.slice(-2)) expect(h.undo.content).toBe(copy.small.content);
    expect(JSON.stringify(copy.small)).toBe(text(eng));
    // 恢复之后撤销：与撤销原来的引擎相同
    const restored = Engine.fromCheckpoint(copy, eng.toDoc(), eng.world.mesh)!;
    restored.undo();
    eng.undo();
    expect(text(restored)).toBe(text(eng));
  });

  it('预览的副本共用内容，世界不变；发给主线程的差别不带内容，补上之后逐字节相同', () => {
    const eng = library().clone();
    const before = text(eng);
    const c0 = eng.world.small.content;
    const copy = eng.clone();
    expect(copy.world.small.content).toBe(c0);
    expect(text(copy)).toBe(before);
    const cells = land(eng).slice(40, 70);
    copy.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.5 });
    copy.update();
    expect(text(eng)).toBe(before);
    expect(eng.world.small.content).toBe(c0);
    const patch = previewPatch(eng.world, copy.world);
    const sent = structuredClone(postedPatch(eng.world, patch));
    expect(sent.sameContent).toBe(true);
    expect(JSON.stringify(sent.small).length).toBeLessThan(JSON.stringify(c0).length / 2);
    expect(JSON.stringify(previewWorldOf(eng.world, sent).small)).toBe(JSON.stringify(previewWorldOf(eng.world, patch).small));
    // 副本改了内容：照旧整份带上
    const edited = eng.clone();
    edited.exec({ op: 'set_content', kind: 'pointType', id: 'r47-new', item: { ...(Object.values(c0!.pointType!)[0] as object), id: 'r47-new' } });
    edited.update();
    const full = postedPatch(eng.world, previewPatch(eng.world, edited.world));
    expect(full.sameContent).toBeUndefined();
    expect(JSON.stringify(previewWorldOf(eng.world, full).small)).toBe(text(edited));
  });
});

// 不要改它：第四十七轮之前 applyCommand、revert 的写法
const old = {
  copy: (small: SmallState) => JSON.stringify(small),
  restore: (s: string) => JSON.parse(s) as SmallState,
  same: (small: SmallState, s: string) => JSON.stringify(small) === s,
  clone: (small: SmallState) => structuredClone(small),
};
// 不要改它：第四十七轮之前的 contentSnapshot、contentDiff（移出、新加的项的 id）
function oldSnapshot(world: World): Map<string, Map<string, unknown>> {
  const out = new Map<string, Map<string, unknown>>();
  for (const k of allKinds()) {
    if (k.id === 'planetForm') continue;
    const list = k.store === 'content' ? Object.values(world.small.content?.[k.id] ?? {}) : k.inWorld(world);
    out.set(k.id, new Map(list.map((x) => [itemId(k, x), x])));
  }
  return out;
}
function oldDiff(world: World, before: Map<string, Map<string, unknown>>) {
  const after = oldSnapshot(world);
  const removed: string[] = [];
  const added: { kind: string; id: string }[] = [];
  for (const [kind, was] of before) {
    const now = after.get(kind)!;
    for (const id of was.keys()) if (!now.has(id)) removed.push(`${kind}/${id}`);
    for (const id of now.keys()) if (!was.has(id)) added.push({ kind, id });
  }
  return { removed, added };
}

describe('新旧逐位相同', () => {
  const small = (extra: Partial<SmallState> = {}) => ({ ...structuredClone(library().world.small), ...extra }) as SmallState;
  // 各种样子的小数据：没有内容、内容在中间（键的先后）、内容在最后、空内容、带 undefined 的
  const shapes = (): SmallState[] => {
    const a = small();
    const { content, ...rest } = a;
    const last = { ...rest, content } as SmallState;
    const { nextId, ...others } = rest;
    const moved = { nextId, content, ...others } as SmallState;
    const none = { ...rest } as SmallState;
    const empty = { ...rest, content: {} } as SmallState;
    const undef = { ...rest, content: undefined } as unknown as SmallState;
    const holes = { ...rest, content: { ...content, junk: undefined } } as unknown as SmallState;
    return [a, last, moved, none, empty, undef, holes];
  };

  it('副本、恢复、克隆：序列化以后一字不差（键的先后也一样）', () => {
    for (const s of shapes()) {
      expect(JSON.stringify(restoreSmall(copySmall(s)))).toBe(JSON.stringify(old.restore(old.copy(s))));
      expect(JSON.stringify(cloneSmall(s))).toBe(JSON.stringify(old.clone(s)));
      expect(Object.keys(restoreSmall(copySmall(s)))).toEqual(Object.keys(old.restore(old.copy(s))));
    }
  });

  it('比较：与比两段完整的 JSON 结果相同', () => {
    const base = small();
    const content = base.content!;
    const kinds = Object.keys(content);
    const [k0, k1] = kinds;
    const items0 = Object.keys(content[k0]!);
    const list: SmallState[] = [
      ...shapes(),
      // 深拷贝（对象都不同，内容相同）
      structuredClone(base),
      // 种类换先后、项换先后
      { ...base, content: { [k1]: content[k1], [k0]: content[k0], ...content } },
      { ...base, content: Object.fromEntries([...kinds].reverse().map((k) => [k, content[k]])) },
      { ...base, content: { ...content, [k0]: Object.fromEntries([...items0].reverse().map((id) => [id, content[k0]![id]])) } },
      // 少一种、少一项、多一项
      { ...base, content: Object.fromEntries(kinds.slice(1).map((k) => [k, content[k]])) },
      { ...base, content: { ...content, [k0]: Object.fromEntries(items0.slice(1).map((id) => [id, content[k0]![id]])) } },
      { ...base, content: { ...content, [k0]: { ...content[k0], extra: { id: 'extra' } } } },
      // 一项里改一个字、键换先后、多一个 undefined
      { ...base, content: { ...content, [k0]: { ...content[k0], [items0[0]]: { ...(content[k0]![items0[0]] as object), name: 'x' } } } },
      { ...base, content: { ...content, [k0]: { ...content[k0], [items0[0]]: Object.fromEntries(Object.entries(content[k0]![items0[0]] as object).reverse()) } } },
      { ...base, content: { ...content, [k0]: { ...content[k0], [items0[0]]: { ...(content[k0]![items0[0]] as object), junk: undefined } } } },
      // 内容以外的
      { ...base, nextId: base.nextId + 1 },
    ] as SmallState[];
    for (const a of list) {
      for (const b of list) expect(sameAsCopy(a, copySmall(b))).toBe(old.same(a, old.copy(b)));
    }
  });

  it('执行同一串命令：changed、移出的、新加的与旧的写法相同', () => {
    const eng = library().clone();
    const point = Object.values(eng.world.small.content!.pointType!)[0] as { id: string };
    const cmds: Command[] = [
      ...edits(eng),
      { op: 'set_content', kind: 'pointType', id: point.id, item: null },
      { op: 'set_content', kind: 'pointType', id: point.id, item: { ...point } },
      { op: 'set_content', kind: 'pointType', id: point.id, item: { ...point } },
      { op: 'remove_river_type', id: 'none' },
    ];
    const w = eng.world;
    for (const c of cmds) {
      const was = old.copy(w.small);
      const before = oldSnapshot(w);
      let r: ReturnType<typeof applyCommand>;
      try {
        r = applyCommand(w, c, { ensureDerived: () => eng.update() });
      } catch {
        expect(text(eng)).toBe(was);
        continue;
      }
      const want = oldDiff(w, before);
      expect(r.removed.map((x) => `${x.kind}/${x.id}`)).toEqual(want.removed);
      expect(r.added).toEqual(want.added);
      const u = r.undo;
      expect(r.changed).toBe(u.arrays.length > 0 || u.fields.length > 0 || !!u.dropHeights || !!u.dropFragment || !!u.dropArrays || !old.same(w.small, was));
      expect(JSON.stringify(restoreSmall(u))).toBe(was);
      // 引擎这一步之后要重算；这里只比小数据与原因，标上从高程重算
      (eng as unknown as { dirty: number }).dirty = Dirty.Elevation;
    }
  });
});

describe('内容是不可变的：所有写内容的地方都是换掉、不是就地改', () => {
  // 每条命令之前把世界里的内容冻住：就地改（模块是严格模式）会抛错，命令就做不了了
  const frozen = (eng: Engine, cmd: Command) => {
    deepFreeze(eng.world.small.content);
    eng.exec(cmd);
    eng.update();
  };

  it('改内容、排先后、生成人文、去掉人文、整理、预览、撤销重做', () => {
    const eng = newWorld();
    for (const c of edits(eng)) frozen(eng, c);
    while (eng.canUndo && eng.toDoc().commands.length > 3) eng.undo();
    for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']], groups: ['germanic', 'chinese'] }, eng.world)) frozen(eng, c);
    frozen(eng, { op: 'generate_human', packs: [['medieval']], groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {}, settlements: {} } as Command);
    expect(eng.world.small.human).toBeTruthy();
    expect(eng.world.small.countries).toBeTruthy();
    frozen(eng, { op: 'regenerate_countries', fragmentation: 0.4 });
    frozen(eng, { op: 'regenerate_settlements' });
    frozen(eng, { op: 'remove_settlements' });
    frozen(eng, { op: 'remove_countries' });
    deepFreeze(eng.world.small.content);
    const plan = eng.planTidy();
    if (plan.command) frozen(eng, plan.command);
    frozen(eng, { op: 'remove_human' });
    deepFreeze(eng.world.small.content);
    eng.undo();
    eng.undo();
    eng.redo();
    eng.update();
    // 副本上的命令与预览也一样
    deepFreeze(eng.world.small.content);
    const cells = land(eng).slice(40, 70);
    eng.preview({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.5 });
    expect(Object.isFrozen(eng.world.small.content)).toBe(true);
  });
});
