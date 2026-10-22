import * as acorn from 'acorn';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { ScriptError, compileScript } from '../../core/script';
import type { Species } from '../../core/species';
import { continents } from '../../core/testing/fixtures';
import type { LightSnapshot, Request, Response } from '../protocol';
import { world, worldState } from '../state';
import { type ApplyMode, type ApplyResult, ScriptEdit, type ScriptEditDeps, type ScriptProblem, problemCell, problemLine } from './script-commit';
import { SCRIPT_EXAMPLES } from './script-examples';
import { bracketProblem, checkNow, syntaxProblem, useAcorn } from './script-syntax';
import { applySpeciesScript, speciesIssue, speciesScriptCommand } from './species-scripts';

// 脚本框：出错的行号与说明（acorn 只解析）、停一下就提交的合并逻辑（第一次 exec，之后 replaceLast，一步撤销）

beforeAll(() => useAcorn(acorn));

const line = (src: string, kind: 'placement' | 'color' = 'placement', fields?: string[]) => {
  const p = checkNow(kind, src, fields);
  return p ? problemLine(p) : null;
};

describe('语法错误的行号（acorn）', () => {
  it('少了右花括号：报那个没配上的 { 所在的行，不是最后一行', () => {
    const src = 'if (海拔 > 100) {\n  return 1;\n\nreturn 0;';
    expect(syntaxProblem(src)).toMatchObject({ line: 1, reason: 'syntax' });
    expect(line(src)).toBe('第 1 行：这个 { 少了配对的 }');
  });

  it('多了一个右括号、配错了括号：各自的行', () => {
    expect(line('const a = 1;\nreturn a;\n}\n')).toBe('第 3 行：多了一个 }');
    // ( 在第 2 行没有配上，到第 3 行的 } 才发现
    expect(line('if (海拔 > 0) {\n  const x = Math.max(1, 2;\n}\nreturn 1;')).toBe('第 2 行：这个 ( 少了配对的 )');
    // 嵌套的 { 都配上了，外面那个没有
    expect(line('if (a) {\n  if (b) {\n    return 1;\n  }\nreturn 0;')).toMatch(/^第 1 行：这个 \{/);
  });

  it('注释、字符串、正则里的括号不算', () => {
    expect(line("// 注意 (\nconst s = '{[';\nconst r = /\\(/;\nreturn s.length > 0 && r.test('(');")).toBeNull();
  });

  it('写错的符号：第几行、换成中文说明', () => {
    expect(line('const a = 1；\nreturn a;')).toBe('第 1 行：用了中文标点「；」，要换成英文的「;」');
    expect(line('const a = 1;\nconst b = 2;\nreturn a b;')).toBe('第 3 行：这里不该出现「b」');
    expect(line('const a = 1;\nreturn a @ 2;')).toBe('第 2 行：不认识的字符「@」');
    expect(line('return 1 +* 2;')).toBe('第 1 行：这里不该出现「*」');
    expect(line('const a = 1;\nreturn a +')).toMatch(/^第 2 行：代码没写完/);
    expect(line('const s = "abc;\nreturn 1;')).toBe('第 1 行：引号没有配对');
    // 引擎按严格模式编译，这里也按严格模式查
    expect(line('const x = 1;\nwith (Math) { return x; }')).toBe('第 2 行：脚本里不能用 with');
    expect(line('let x = 1;\nlet x = 2;\nreturn x;')).toBe('第 2 行：「x」重复声明了');
  });

  it('装上 acorn 后，引擎编译时报的语法错误也带上行号（setSyntaxLocator）', () => {
    let err: unknown;
    try {
      compileScript('placement', 'const a = 1;\nconst b = 2;\nreturn (a + b;', '测试');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).line).toBe(3);
  });

  it('bracketProblem 只看代码本身', () => {
    expect(bracketProblem('return [1, 2, (3)];')).toBeNull();
    expect(bracketProblem('return `${海拔}(`;')).toBeNull();
  });
});

describe('用了没有的变量、不能用的名字', () => {
  it('写错的变量名：第几行，是不是哪个', () => {
    expect(line('return tMeen > 5;')).toBe('第 1 行：没有变量 tMeen（是不是 tMean？）');
    expect(line('const a = 1;\nconst b = 2;\nreturn tMeen + a + b;')).toBe('第 3 行：没有变量 tMeen（是不是 tMean？）');
    expect(line('return 年均温 > 5 && 海拔 < 3000 && fbmAt(2) > 0;')).toBeNull();
  });

  it('只有别的种类的脚本能用的变量', () => {
    expect(line('return share > 0.5;')).toBe('第 1 行：长在哪里脚本里没有变量 share（只有颜色脚本能用）');
    expect(line("return share > 0.5 ? color : '#ffffff';", 'color')).toBeNull();
  });

  it('自己声明的名字、属性名、标签都不算', () => {
    const src = [
      'const { x: q, ...rest } = { x: 1 };',
      'function f(a, [b, c = 2]) { return a + b + c; }',
      'try { q; } catch (e) { e; }',
      'outer: for (const k of [1]) { break outer; }',
      "const o = { foo: 1, [q]: 2 };",
      "return f(q, [1]) > o.foo + o['bar'] ? rest : Math.PI;",
    ].join('\n');
    expect(line(src)).toBeNull();
  });

  it('Math.random、时间：告诉用什么代替', () => {
    expect(line('const a = 1;\nreturn Math.random() < a;')).toBe('第 2 行：用 rand() 代替 Math.random()');
    expect(line('return Date.now() > 0;')).toBe('第 1 行：脚本里不能用时间');
    expect(line('return globalThis.x;')).toBe('第 1 行：脚本里不能用 globalThis');
  });

  it("field('名字')：世界上没有这个自定义场时说出来", () => {
    expect(line("return field('魔力');", 'placement', [])).toBe('第 1 行：没有自定义场「魔力」（先在“调整”里新建）');
    expect(line("return field('魔力');", 'placement', ['魔力'])).toBeNull();
    expect(line("return field('海拔') > 1000;", 'placement', [])).toBeNull();
  });

  it('“变量和例子”里的例子都能通过检查', () => {
    for (const [kind, list] of Object.entries(SCRIPT_EXAMPLES)) {
      for (const ex of list) expect(checkNow(kind as keyof typeof SCRIPT_EXAMPLES, ex.src), `${kind}：${ex.label}`).toBeNull();
    }
  });
});

// 假的定时器、假的世界：记下每次提交是新的一步还是换掉，状态编号随提交增加
function harness(initial = '', opts: { bad?: (src: string) => ScriptProblem | null; check?: (src: string) => ScriptProblem | null; fail?: (src: string) => string | null } = {}) {
  vi.useFakeTimers();
  const calls: [ApplyMode, string][] = [];
  const w = { state: 1, src: initial };
  const deps: ScriptEditDeps = {
    check: async (src) => opts.check?.(src) ?? null,
    apply: async (src, mode): Promise<ApplyResult> => {
      calls.push([mode, src]);
      const err = opts.fail?.(src);
      if (err) return { ok: false, error: err };
      w.state++;
      w.src = src;
      return { ok: true };
    },
    stateId: () => w.state,
    issue: () => opts.bad?.(w.src) ?? null,
  };
  const edit = new ScriptEdit(deps, initial);
  return { edit, calls, w };
}
const pause = () => vi.advanceTimersByTimeAsync(600);

describe('停一下就提交：一次编辑只算一步撤销', () => {
  afterEach(() => vi.useRealTimers());

  it('停 600 毫秒才提交，只提交最后的；第一次是新的一步，之后换掉它', async () => {
    const { edit, calls } = harness('');
    edit.focus();
    edit.input('return 0');
    await vi.advanceTimersByTimeAsync(300);
    edit.input('return 1');
    await vi.advanceTimersByTimeAsync(599);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([['exec', 'return 1']]);
    edit.input('return 0.5');
    await pause();
    edit.input('return 0.25');
    await pause();
    expect(calls).toEqual([
      ['exec', 'return 1'],
      ['replace', 'return 0.5'],
      ['replace', 'return 0.25'],
    ]);
  });

  it('中间有别的改动（最后一步不是这次编辑的了）：新的一步，不换掉别人的', async () => {
    const { edit, calls, w } = harness('');
    edit.focus();
    edit.input('return 1');
    await pause();
    w.state += 5; // 比如涂了一笔
    edit.input('return 0.5');
    await pause();
    edit.input('return 0.25');
    await pause();
    expect(calls.map((c) => c[0])).toEqual(['exec', 'exec', 'replace']);
  });

  it('离开时立即提交；再点进来是新的一步', async () => {
    const { edit, calls } = harness('return 1');
    edit.focus();
    edit.input('return 0.5');
    await edit.blur();
    expect(calls).toEqual([['exec', 'return 0.5']]);
    edit.focus();
    edit.input('return 0.25');
    await pause();
    expect(calls[1]).toEqual(['exec', 'return 0.25']);
  });

  it('改回地图上现在的样子：不提交', async () => {
    const { edit, calls } = harness('return 1');
    edit.focus();
    edit.input('return 2');
    edit.input('return 1');
    await pause();
    expect(calls).toEqual([]);
  });

  it('提交还没回来时又停了一下：回来后接着提交最新的（换掉）', async () => {
    vi.useFakeTimers();
    const calls: [ApplyMode, string][] = [];
    let state = 1;
    let release!: () => void;
    const deps: ScriptEditDeps = {
      check: async () => null,
      apply: (src, mode) => {
        calls.push([mode, src]);
        return new Promise<ApplyResult>((r) => {
          release = () => {
            state++;
            r({ ok: true });
          };
        });
      },
      stateId: () => state,
      issue: () => null,
    };
    const edit = new ScriptEdit(deps, '');
    edit.focus();
    edit.input('return 1');
    await pause();
    edit.input('return 2');
    await pause();
    edit.input('return 3');
    await pause();
    expect(calls).toEqual([['exec', 'return 1']]);
    expect(edit.view().busy).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      ['exec', 'return 1'],
      ['replace', 'return 3'],
    ]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(edit.view().busy).toBe(false);
  });

  it('语法错误：不提交，框下面说第几行，地图保留原来的', async () => {
    const { edit, calls } = harness('return 1', { check: (src) => (src.includes('(') && !src.includes(')') ? { line: 1, text: '这个 ( 少了配对的 )', reason: 'syntax' } : null) });
    edit.focus();
    edit.input('return (1');
    await pause();
    expect(calls).toEqual([]);
    expect(edit.view()).toMatchObject({ problem: { line: 1, reason: 'syntax' }, stale: true });
    edit.input('return (1)');
    await pause();
    expect(calls).toEqual([['exec', 'return (1)']]);
    expect(edit.view()).toMatchObject({ problem: null, stale: false });
  });

  it('在地图上算的时候出错：说明出在哪一格，地图换回上一次没出错的写法（还是同一步）', async () => {
    const bad = (src: string): ScriptProblem | null => (src.includes('tMeen') ? { line: 2, text: '没有变量 tMeen（是不是 tMean？）', cell: 42, reason: 'runtime' } : null);
    const { edit, calls, w } = harness('return 1', { bad });
    edit.focus();
    edit.input('return 0.5');
    await pause();
    edit.input('const a = 1;\nreturn tMeen;');
    await pause();
    expect(calls).toEqual([
      ['exec', 'return 0.5'],
      ['replace', 'const a = 1;\nreturn tMeen;'],
      ['replace', 'return 0.5'],
    ]);
    expect(w.src).toBe('return 0.5');
    const v = edit.view();
    expect(v.stale).toBe(true);
    expect(problemLine(v.problem!)).toBe('第 2 行：没有变量 tMeen（是不是 tMean？）');
    expect(problemCell(v.problem)).toBe(42);
    // 改对了：照样换掉同一步
    edit.input('return tMean > 0;');
    await pause();
    expect(calls[3]).toEqual(['replace', 'return tMean > 0;']);
    expect(edit.view()).toMatchObject({ problem: null, stale: false });
  });

  it('引擎拒绝了这一步：说原因，下一次照样是新的一步', async () => {
    const { edit, calls } = harness('', { fail: (src) => (src.includes('__st') ? '「X」的长在哪里脚本有语法错误：…' : null) });
    edit.focus();
    edit.input('var __st = 1; return 1;');
    await pause();
    expect(edit.view()).toMatchObject({ problem: { reason: 'engine' }, stale: true });
    edit.input('return 1;');
    await pause();
    expect(calls.map((c) => c[0])).toEqual(['exec', 'exec']);
  });

  it('安全模式下脚本不运行：不算错，不换回', async () => {
    const { edit, calls } = harness('', { bad: (src) => (src ? { text: '安全模式下脚本不运行', reason: 'disabled' } : null) });
    edit.focus();
    edit.input('return 1;');
    await pause();
    expect(calls).toEqual([['exec', 'return 1;']]);
    expect(edit.view()).toMatchObject({ problem: { reason: 'disabled' }, stale: false });
  });

  it('撤销、重做之后框里跟着世界变；框里有没用上的改动时留着它', async () => {
    const { edit, calls } = harness('return 1', { check: (src) => (src.endsWith('(') ? { line: 1, text: '代码没写完', reason: 'syntax' } : null) });
    edit.sync('return 2', { line: 1, text: '别的错', reason: 'runtime', cell: 3 });
    expect(edit.view()).toMatchObject({ draft: 'return 2', problem: { text: '别的错' } });
    edit.focus();
    edit.input('return (');
    await pause();
    expect(edit.view()).toMatchObject({ draft: 'return (', stale: true });
    // 期间世界被撤销成了别的样子：框里没用上的改动留着
    edit.sync('return 5', null);
    expect(edit.view().draft).toBe('return (');
    // 改成和世界上一样：不用提交
    edit.input('return 5');
    await pause();
    expect(calls).toEqual([]);
    expect(edit.view()).toMatchObject({ problem: null, stale: false });
  });
});

// 真的走 state.ts 的 exec、replaceLast（Worker 换成假的）：一次编辑里第一次是 exec，之后是 replaceLast
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: { data: Response }) => void) | null = null;
  sent: { id: number; req: Request }[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: { id: number; req: Request }) {
    this.sent.push(m);
  }
}
vi.stubGlobal('Worker', FakeWorker);

describe('生态的脚本框接到真的 exec / replaceLast 上', () => {
  afterEach(() => vi.useRealTimers());

  it('补丁里的 scripts 是整份：另一个框的脚本带上；清空就去掉', () => {
    const sp = { id: 'x', name: 'X', scripts: { color: { api: 1, src: 'return color;' } } } as unknown as Species;
    expect(speciesScriptCommand(sp, 'placement', 'return 1;')).toEqual({
      op: 'update_species',
      id: 'x',
      patch: { scripts: { placement: { api: 1, src: 'return 1;' }, color: { api: 1, src: 'return color;' } } },
    });
    expect(speciesScriptCommand(sp, 'color', '  \n')).toEqual({ op: 'update_species', id: 'x', patch: { scripts: null } });
  });

  it('第一次 exec，之后 replaceLast；出错的说明按生态的 id 找', async () => {
    const eng = continents({ cells: 2000 });
    world.value = eng.world;
    worldState.value = 1;
    const sp = eng.world.small.species[0];
    const edit = new ScriptEdit(
      {
        check: async (src) => checkNow('placement', src),
        apply: (src, mode) => applySpeciesScript(sp.id, 'placement', src, mode),
        stateId: () => worldState.value,
        issue: () => speciesIssue(sp.id, 'placement'),
      },
      '',
    );
    const fw = () => FakeWorker.last!;
    let state = 10;
    // 回一个轻快照（只换小数据与状态编号）
    const answer = (cmd: Command) => {
      const w = world.value!;
      const patch = (cmd as Extract<Command, { op: 'update_species' }>).patch;
      const small = { ...w.small, species: w.small.species.map((s) => (s.id === sp.id ? ({ ...s, ...patch } as Species) : s)) };
      const snap: LightSnapshot = { light: true, small, features: w.derived.features, province: w.causes.province.slice(), history: [], canUndo: true, canRedo: false, timings: { total: 0 }, stateId: ++state };
      const m = fw().sent[fw().sent.length - 1];
      fw().onmessage!({ data: { id: m.id, ok: true, summary: `修改了生态“${sp.name}”的脚本`, snapshot: snap } });
    };
    vi.useFakeTimers();
    edit.focus();
    edit.input('return 海拔 > 500;');
    await pause();
    const first = fw().sent[fw().sent.length - 1];
    expect(first.req.kind).toBe('exec');
    answer((first.req as { cmd: Command }).cmd);
    await vi.advanceTimersByTimeAsync(0);
    edit.input('return 海拔 > 800;');
    await pause();
    const second = fw().sent[fw().sent.length - 1];
    expect(second.req).toEqual({ kind: 'replaceLast', cmd: { op: 'update_species', id: sp.id, patch: { scripts: { placement: { api: 1, src: 'return 海拔 > 800;' } } } } });
    answer((second.req as { cmd: Command }).cmd);
    await vi.advanceTimersByTimeAsync(0);
    expect(world.value!.small.species[0].scripts?.placement?.src).toBe('return 海拔 > 800;');
    // 世界上记着的出错：按 id 找到这一种的
    world.value = {
      ...world.value!,
      derived: { ...world.value!.derived, scriptIssues: [{ owner: '别的', id: 'other', kind: 'placement', reason: 'runtime', text: '别的错', raw: '', message: '' }, { owner: sp.name, id: sp.id, kind: 'placement', reason: 'value', cell: 7, text: '地图上有一处算出了 NaN（不是数字）', raw: '', message: '' }] },
    };
    expect(speciesIssue(sp.id, 'placement')).toMatchObject({ cell: 7, reason: 'value' });
    expect(speciesIssue(sp.id, 'color')).toBeNull();
  });
});
