import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import { seededEngine } from '../core/testing/fixtures';
import { UNDO_KEEP_STEPS } from '../core/undo-budget';
import { SnapshotSender } from './worker-snapshot';

// 第九十五轮：撤销记录的内存上限到了主线程这边——快照里带着“最前面几步不能撤销了”（没有时不带），
// 撤到头时 canUndo 是假的、历史还是那么多步

function limited() {
  const eng = seededEngine({ seed: 5, cells: 3000 });
  // 上限小到只留得下最近 8 步
  eng.undoBudget = 1;
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents' }, reset: true });
  for (let k = 0; k < 12; k++) eng.exec({ op: 'set_planet', patch: { humidity: 1 + k * 0.01 } } as Command);
  return eng;
}

describe('快照里的撤销上限', () => {
  it('没有丢过撤销记录：快照里不带这一项', () => {
    const eng = seededEngine({ seed: 5, cells: 3000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents' }, reset: true });
    const { snap } = new SnapshotSender(1).full(eng, true);
    expect(snap.canUndo).toBe(true);
    expect('undoLocked' in snap).toBe(false);
  });

  it('丢过：带着前几步不能撤销；撤到头 canUndo 是假的，历史一步不少；只改名字的轻快照也带', () => {
    const eng = limited();
    const steps = eng.history.length;
    const sender = new SnapshotSender(2);
    const first = sender.full(eng, true).snap;
    expect(first.undoLocked).toBe(steps - UNDO_KEEP_STEPS);
    expect(first.canUndo).toBe(true);
    for (let k = 0; k < UNDO_KEEP_STEPS; k++) expect(eng.undo()).toBe(true);
    const end = sender.full(eng).snap;
    expect(end.canUndo).toBe(false);
    expect(end.canRedo).toBe(true);
    expect(end.undoLocked).toBe(steps - UNDO_KEEP_STEPS);
    expect(end.history.length).toBe(steps);
    expect(end.history.filter((h) => h.done).length).toBe(steps - UNDO_KEEP_STEPS);
    // 再撤：不动
    expect(eng.undo()).toBe(false);
    const light = sender.light(eng).snap;
    expect(light.canUndo).toBe(false);
    expect(light.undoLocked).toBe(steps - UNDO_KEEP_STEPS);
    expect(light.history.length).toBe(steps);
  });
});
