import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import type { Command, UndoRecord } from './commands';
import { Engine } from './engine';
import { seededEngine } from './testing/fixtures';
import { UNDO_KEEP_STEPS, UNDO_RECORD_BYTES, droppedUndo, undoRecordBytes } from './undo-budget';

// 撤销记录的内存上限（第九十五轮）：超过上限时最老的几步丢掉撤销记录，世界不变——
// 有上限与没上限时，撤销到同一步、重做回来逐位相同；命令（世界文件）、历史一条不少；丢掉了的步不能撤

type Step = { id: number; cmd: Command; undo: UndoRecord; bytes?: number };
const inner = (e: Engine) => e as unknown as { done: Step[]; undoFloor: number; undoBytes: number };

const SETTINGS = { seed: 4, cells: 5000 };

// 一串平时的编辑（21 步）
function edits(eng: Engine): Command[] {
  const w = eng.world;
  const land = () => [...Array(w.mesh.n).keys()].filter((i) => eng.world.causes.land[i]);
  const out: Command[] = [];
  const run = (c: Command) => {
    eng.exec(c);
    out.push(c);
  };
  run({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
  run({ op: 'generate_provinces', seed: 4 });
  for (let k = 0; k < 6; k++) {
    const cells = land().slice(100 + k * 90, 160 + k * 90);
    run({ op: 'paint', field: 'tempOffset', cells, value: k % 2 ? 2 : -2, mode: 'add' });
    run({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.4 });
    run({ op: 'set_planet', patch: { humidity: 1 + k * 0.05 } });
  }
  const stroke = coastalStroke(eng.world, 0.4, 4);
  run({ op: 'paint_land', cells: stroke, t: stroke.map(() => 0), mode: 'land' });
  return out;
}

function built(budget: number): { eng: Engine; cmds: Command[] } {
  const eng = seededEngine(SETTINGS);
  eng.undoBudget = budget;
  const cmds = edits(eng);
  return { eng, cmds };
}

describe('撤销记录的内存上限', () => {
  it('一步的记录按数组、场、小数据的字数算', () => {
    const u: UndoRecord = { small: 'abcd', arrays: [{ key: 'landDelta', idx: new Int32Array(3), old: new Float64Array(3) }], fields: [{ name: 'f', old: new Float32Array(5) }, { name: 'g', old: null }] };
    expect(undoRecordBytes(u)).toBe(8 + 12 + 24 + 20);
    const content = {} as NonNullable<UndoRecord['content']>;
    const gone = droppedUndo({ ...u, content });
    expect(gone).toEqual({ small: '', arrays: [], fields: [], content, gone: true });
    expect(gone.content).toBe(content);
    expect(undoRecordBytes(gone)).toBe(0);
  });

  it('默认的上限是 96 MB；最近 8 步总留着', () => {
    expect(UNDO_RECORD_BYTES).toBe(96 * 1024 * 1024);
    expect(UNDO_KEEP_STEPS).toBe(8);
    expect(seededEngine(SETTINGS).undoBudget).toBe(UNDO_RECORD_BYTES);
  });

  it('有上限与没上限：撤销到同一步、重做回来，世界逐位相同；命令、历史一条不少', () => {
    const free = built(Infinity);
    // 上限小到只留得下最近 8 步
    const tight = built(1);
    expect(inner(free.eng).undoFloor).toBe(0);
    const steps = tight.eng.toDoc().commands.length;
    expect(steps).toBeGreaterThanOrEqual(tight.cmds.length);
    expect(inner(tight.eng).undoFloor).toBe(steps - UNDO_KEEP_STEPS);
    const same = () => {
      expect(digestWorld(tight.eng.world)).toEqual(digestWorld(free.eng.world));
      expect(tight.eng.toDoc()).toEqual(free.eng.toDoc());
      expect(tight.eng.history).toEqual(free.eng.history);
      expect(tight.eng.stepIds()).toEqual(free.eng.stepIds());
    };
    same();
    // 一步一步撤到有上限的那边撤不动为止，每一步都相同
    let undone = 0;
    while (tight.eng.canUndo) {
      expect(tight.eng.undo()).toBe(true);
      expect(free.eng.undo()).toBe(true);
      undone++;
      same();
    }
    expect(undone).toBe(UNDO_KEEP_STEPS);
    // 到头了：再撤不动，世界不变；没上限的那边还能撤
    const before = digestWorld(tight.eng.world);
    const state = tight.eng.stateId;
    expect(tight.eng.undo()).toBe(false);
    expect(digestWorld(tight.eng.world)).toEqual(before);
    expect(tight.eng.stateId).toBe(state);
    expect(free.eng.canUndo).toBe(true);
    expect(tight.eng.undoLocked).toBe(steps - UNDO_KEEP_STEPS);
    // 重做回来，每一步都相同
    while (tight.eng.canRedo) {
      tight.eng.redo();
      free.eng.redo();
      same();
    }
    expect(tight.eng.toDoc().commands.length).toBe(steps);
    // 接着编辑、换一个、撤销、重做，照样相同
    for (const e of [tight.eng, free.eng]) {
      e.exec({ op: 'add_island', island: { x: 0.5, y: 0.3, kind: 'continental', size: 300, variant: 1 } });
      e.replaceLast({ op: 'add_island', island: { x: 0.5, y: 0.3, kind: 'continental', size: 300, variant: 2 } });
    }
    same();
    for (const e of [tight.eng, free.eng]) {
      e.undo();
      e.undo();
      e.redo();
    }
    same();
  }, 120_000);

  it('合计的字节数一直对得上；超过上限从最老的丢起，丢掉了的只剩内容的引用', () => {
    const { eng } = built(Infinity);
    const sum = () => inner(eng).done.reduce((n, h) => n + (h.undo.gone ? 0 : undoRecordBytes(h.undo)), 0);
    expect(inner(eng).undoBytes).toBe(sum());
    eng.undo();
    eng.undo();
    expect(inner(eng).undoBytes).toBe(sum());
    eng.redo();
    expect(inner(eng).undoBytes).toBe(sum());
    // 上限定成现在的一半：再做一步，最老的几步丢掉，合计回到上限以内
    const total = sum();
    const sizes = inner(eng).done.map((h) => undoRecordBytes(h.undo));
    eng.undoBudget = total / 2;
    eng.exec({ op: 'set_planet', patch: { humidity: 1.31 } });
    const d = inner(eng).done;
    const floor = inner(eng).undoFloor;
    const lastDropped = sizes[floor - 1];
    expect(floor).toBeGreaterThan(0);
    expect(inner(eng).undoBytes).toBe(sum());
    expect(inner(eng).undoBytes).toBeLessThanOrEqual(total / 2);
    d.forEach((h, k) => {
      expect(!!h.undo.gone).toBe(k < floor);
      if (k < floor) expect(h.undo.small).toBe('');
    });
    // 没有多丢：把刚丢的最后一步算回来就超过上限了
    expect(inner(eng).undoBytes + lastDropped).toBeGreaterThan(total / 2);
  }, 120_000);

  it('“上一次生成时的内容”照样读得出（丢掉的记录留着内容的引用）', () => {
    const free = built(Infinity);
    const tight = built(1);
    expect(tight.eng.regenBase()).toEqual(free.eng.regenBase());
  }, 120_000);

  it('检查点带着丢掉的记录：恢复与重放一致，能撤的步数相同；存档比丢掉的那几步还短时不用检查点', () => {
    const { eng } = built(1);
    const mesh = eng.world.mesh;
    const cp = structuredClone(eng.toCheckpoint());
    const doc = eng.toDoc();
    const floor = eng.undoLocked;
    expect(cp.done.filter((h) => h.undo.gone).length).toBe(floor);
    expect((cp.done[0] as { bytes?: number }).bytes).toBeUndefined();
    const a = Engine.fromCheckpoint(structuredClone(cp), doc, mesh)!;
    const b = Engine.fromDoc(doc, mesh);
    expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    expect(a.undoLocked).toBe(floor);
    let n = 0;
    while (a.canUndo) {
      a.undo();
      b.undo();
      n++;
      expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    }
    expect(n).toBe(UNDO_KEEP_STEPS);
    // 存档只有前 3 步：检查点得撤到丢掉的那几步之前，撤不了——不用它（改用重放）
    expect(floor).toBeGreaterThan(3);
    expect(Engine.fromCheckpoint(structuredClone(cp), { ...doc, commands: doc.commands.slice(0, 3) }, mesh)).toBeNull();
    // 存档正好到丢掉的那几步为止：用得上
    const upTo = { ...doc, commands: doc.commands.slice(0, floor) };
    const c = Engine.fromCheckpoint(structuredClone(cp), upTo, mesh)!;
    expect(digestWorld(c.world)).toEqual(digestWorld(Engine.fromDoc(upTo, mesh).world));
    expect(c.canUndo).toBe(false);
  }, 120_000);

  it('重放很长的世界文件时也不攒着全部的撤销记录；预览不动上限', () => {
    const { eng } = built(Infinity);
    const doc = eng.toDoc();
    const re = Engine.fromDoc(doc, eng.world.mesh, { undoBudget: 1 });
    expect(re.undoLocked).toBe(doc.commands.length - UNDO_KEEP_STEPS);
    expect(digestWorld(re.world)).toEqual(digestWorld(eng.world));
    // 预览在副本上做：活的引擎一步都不丢，采用预览的那一步照常算进合计
    const tight = built(1).eng;
    const floor = tight.undoLocked;
    const cmd: Command = { op: 'set_planet', patch: { humidity: 1.4 } };
    tight.preview(cmd);
    expect(tight.undoLocked).toBe(floor);
    tight.exec(cmd);
    expect(tight.undoLocked).toBe(floor + 1);
    const sum = inner(tight).done.reduce((n, h) => n + (h.undo.gone ? 0 : undoRecordBytes(h.undo)), 0);
    expect(inner(tight).undoBytes).toBe(sum);
  }, 120_000);
});
