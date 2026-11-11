import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from './commands';
import { worldDigest } from './digest';
import { Engine } from './engine';
import { builtinPacks } from './packs/builtin-tree';
import { drain, setStageSink } from './progress';
import { continents, engineFor, generateHuman, snapshot } from './testing/fixtures';

// 第九十七轮：久的步骤回报到哪一步了、分阶段、走到一半不要了。
//   - 接不接回报的钩子，结果逐位相同（只说，不改任何计算）；
//   - 分阶段地走（一步一步 next）与一口气走完逐位相同；
//   - 在任何一个停着的地方往里抛一个错（计算 Worker 的“取消”就是这样做的）：世界、历史、重做记录、状态编号都回到之前，
//     之后照常做同一步，结果与从来没取消过的一样

const groups = () => ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => ({ id: n.id, weight: n.weight ?? 1 }));

// 2500 格的大陆，带省份、人文、国家、城市
const human = () =>
  snapshot('progress-human', () => {
    const e = continents({ cells: 2500, provinces: true });
    generateHuman(e, 'medieval', groups(), { countries: {}, settlements: {} });
    return e;
  });

// 引擎对外看得到的全部状态
const state = (e: Engine) => ({ digest: worldDigest(e.world), history: e.history, canUndo: e.canUndo, canRedo: e.canRedo, ids: e.stepIds(), stateId: e.stateId, doc: JSON.stringify(e.toDoc()) });
// 不看状态编号（两个引擎各数各的）
const shown = (e: Engine) => {
  const { stateId: _, ...rest } = state(e);
  return rest;
};
// 也不看步的编号：取消掉的那一步用过一个编号（和出错的一步一样），之后的一步接着往下编
const result = (e: Engine) => {
  const { ids: _, ...rest } = shown(e);
  return rest;
};

const land = (e: Engine, from: number, k: number) => {
  const out: number[] = [];
  for (let i = from; i < e.world.mesh.n && out.length < k; i++) if (e.world.causes.land[i]) out.push(i);
  return out;
};
const sea = (e: Engine, from: number, k: number) => {
  const out: number[] = [];
  for (let i = from; i < e.world.mesh.n && out.length < k; i++) if (!e.world.causes.land[i]) out.push(i);
  return out;
};

afterEach(() => setStageSink(null));

describe('回报到哪一步了', () => {
  it('接不接钩子，每一步之后的世界、历史、世界文件都逐位相同；说的是每一步的名字和“第几步 / 共几步”', () => {
    const script = (e: Engine): Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [];
      const put = () => out.push(shown(e));
      e.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.45 }, reset: true });
      put();
      generateHuman(e, 'medieval', groups(), { countries: {}, settlements: {} });
      put();
      e.exec({ op: 'generate_provinces', seed: 2 });
      put();
      const stroke = sea(e, 200, 30);
      e.exec({ op: 'paint_land', cells: stroke, t: stroke.map(() => 0), mode: 'land' });
      put();
      e.exec({ op: 'paint', field: 'tempOffset', cells: land(e, 100, 60), value: 3, mode: 'add' });
      put();
      e.exec({ op: 'batch', commands: [{ op: 'set_planet', patch: { humidity: 1.1 } }, { op: 'regenerate_human', keepManual: false, countries: {} }] });
      put();
      e.exec({ op: 'regenerate_countries' });
      put();
      e.undo();
      put();
      e.undo();
      put();
      e.redo();
      put();
      e.replaceLast({ op: 'regenerate_human' });
      put();
      const again = Engine.fromDoc(e.toDoc(), e.world.mesh);
      out.push(shown(again));
      return out;
    };
    const quiet = script(engineFor({ cells: 2500, seed: 4 }));
    const said: [string, number, number][] = [];
    setStageSink((step, k, n) => said.push([step, k, n]));
    const loud = script(engineFor({ cells: 2500, seed: 4 }));
    setStageSink(null);
    expect(loud).toEqual(quiet);
    // 说了：造陆地、流水线的各步、生成人文的各步、建城市、划省份
    const names = new Set(said.map((s) => s[0]));
    for (const step of ['terrain', 'elevation', 'climate', 'water', 'habitat', 'features', 'human.cultures', 'human.population', 'human.countries', 'human.claims', 'human.blocs', 'human.capitals', 'human.country-mix', 'settlements', 'provinces'])
      expect(names.has(step), step).toBe(true);
    // 每一串里：第几步从 1 起一步一步往上，不超过共几步
    for (let i = 0; i < said.length; i++) {
      const [, k, n] = said[i];
      expect(k >= 1 && k <= n, `${said[i]}`).toBe(true);
      if (k > 1) expect(said[i - 1][1], `${said[i - 1]} → ${said[i]}`).toBe(k - 1);
    }
    // 一次从高程起的重算说六步（没有“自然融入”的设定时）；最后一步是认地物
    const first = said.findIndex((s) => s[0] === 'elevation');
    expect(said.slice(first, first + 5)).toEqual([
      ['elevation', 1, 5],
      ['climate', 2, 5],
      ['water', 3, 5],
      ['habitat', 4, 5],
      ['features', 5, 5],
    ]);
  });

  it('只在步的边界上说：一次重算不超过七条，一次生成人文不超过九条（不在循环里说）', () => {
    const e = human();
    const said: string[] = [];
    setStageSink((step) => said.push(step));
    e.exec({ op: 'paint', field: 'tempOffset', cells: land(e, 100, 60), value: 3, mode: 'add' });
    expect(said.length).toBeGreaterThan(0);
    expect(said.length).toBeLessThanOrEqual(7);
    said.length = 0;
    e.exec({ op: 'regenerate_human', countries: {} });
    expect(said.filter((s) => s.startsWith('human.') || s === 'settlements').length).toBeLessThanOrEqual(9);
    // 只重算人文的几层：流水线不说
    expect(said.filter((s) => !s.startsWith('human.') && s !== 'settlements')).toEqual([]);
  });
});

// 这几步都要停得下来：改气候（流水线）、重新造陆地、重新生成人文（单独一条、在批量里）、重新生成国家
const LONG: Record<string, (e: Engine) => Command> = {
  改冷暖: (e) => ({ op: 'paint', field: 'tempOffset', cells: land(e, 100, 60), value: 3, mode: 'add' }),
  重新造陆地: () => ({ op: 'set_worldgen', params: { seed: 9, type: 'continents', landFraction: 0.4 }, reset: true }),
  重新生成人文: () => ({ op: 'regenerate_human', keepManual: false, countries: {} }),
  批量里重新生成人文: () => ({ op: 'batch', label: '重新生成', commands: [{ op: 'set_planet', patch: { humidity: 1.1 } }, { op: 'regenerate_human', keepManual: false, countries: {} }] }),
  重新生成国家: () => ({ op: 'regenerate_countries' }),
};

class Stop extends Error {}

// 走 k 个停的地方再往里抛一个错；没走到第 k 个就做完了时返回 false
function stopAt<R>(steps: Generator<void, R>, k: number): boolean {
  for (let i = 0; i < k; i++) if (steps.next().done) return false;
  const stop = new Stop('不要了');
  let thrown: unknown;
  try {
    const r = steps.throw(stop);
    // 抛进去以后不该接着算
    expect(r.done, '抛了错还在算').toBe(true);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBe(stop);
  return true;
}

// 这一步一共有几个停的地方
function yields<R>(steps: Generator<void, R>): number {
  let n = 0;
  while (!steps.next().done) n++;
  return n;
}

describe('分阶段：停在哪里都能不要', () => {
  for (const [name, make] of Object.entries(LONG)) {
    it(`执行“${name}”：一步一步走与一口气走完逐位相同；每一个停的地方抛错都回到执行前，之后照常`, () => {
      // 撤销过一步：重做记录也要原样回来
      const prepared = () => {
        const e = human();
        e.exec({ op: 'paint', field: 'moistOffset', cells: land(e, 300, 40), value: 0.3, mode: 'add' });
        e.undo();
        return e;
      };
      const whole = prepared();
      whole.exec(make(whole));
      const stepped = prepared();
      const total = yields(stepped.execSteps(make(stepped)));
      expect(total, '这一步中间有停的地方').toBeGreaterThan(0);
      expect(shown(stepped)).toEqual(shown(whole));
      for (let k = 1; k <= total; k++) {
        const e = prepared();
        const before = state(e);
        expect(stopAt(e.execSteps(make(e)), k), `第 ${k} 个停的地方`).toBe(true);
        expect(state(e), `停在第 ${k} 处之后`).toEqual(before);
        // 重做记录还在、能用；再做同一步，与没取消过的一样
        if (k === 1 || k === total) {
          e.exec(make(e));
          expect(result(e), `停在第 ${k} 处之后再做`).toEqual(result(whole));
        }
      }
    });
  }

  for (const cache of [true, false]) {
    const tag = cache ? '存着推导' : '没存推导';
    it(`撤销、重做、换一个（${tag}）：每一个停的地方抛错都回到之前的样子`, () => {
      const prepared = () => {
        const e = human();
        if (!cache) e.undoCache = 0;
        e.exec({ op: 'paint', field: 'tempOffset', cells: land(e, 100, 60), value: 3, mode: 'add' });
        e.exec({ op: 'regenerate_countries' });
        return e;
      };
      const tries: [string, (e: Engine) => void, (e: Engine) => Generator<void, unknown>][] = [
        ['撤销', (e) => void e.undo(), (e) => e.undoSteps()],
        ['撤销两步', (e) => void (e.undo(), e.undo()), (e) => (e.undo(), e.undoSteps())],
        ['重做', (e) => void (e.undo(), e.undo(), e.redo()), (e) => (e.undo(), e.undo(), e.redoSteps())],
        ['换一个', (e) => void e.replaceLast({ op: 'regenerate_human', countries: {} }), (e) => e.replaceLastSteps({ op: 'regenerate_human', countries: {} })],
      ];
      for (const [name, whole, steps] of tries) {
        const done = prepared();
        whole(done);
        const probe = prepared();
        const total = yields(steps(probe));
        expect(shown(probe), name).toEqual(shown(done));
        for (let k = 1; k <= total; k++) {
          const e = prepared();
          const it = steps(e);
          const before = state(e);
          expect(stopAt(it, k), `${name}：第 ${k} 个停的地方`).toBe(true);
          expect(state(e), `${name}：停在第 ${k} 处之后`).toEqual(before);
        }
      }
    });
  }

  it('drain 就是一口气走完', () => {
    const e = human();
    const f = human();
    const cmd: Command = { op: 'regenerate_human', countries: {} };
    expect(drain(e.execSteps(cmd))).toBe(f.exec(cmd));
    expect(shown(e)).toEqual(shown(f));
  });
});
