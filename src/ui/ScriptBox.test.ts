import * as acorn from 'acorn';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { ScriptError, compileScript } from '../../core/script';
import type { Species } from '../../core/species';
import { continents } from '../../core/testing/fixtures';
import type { LightSnapshot, Request, Response } from '../protocol';
import { newWorld, world, worldEpoch, worldState } from '../state';
import { inThisWorld } from './ScriptBox';
import { type CommittedScript, registerScriptCommitted } from './editor-hooks';
import { type ApplyMode, type ApplyResult, ScriptEdit, type ScriptEditDeps, type ScriptProblem, problemCell, problemLine } from './script-commit';
import { SCRIPT_EXAMPLES } from './script-examples';
import { LOOP_NOTE, bracketProblem, checkNow, installAcorn, syntaxProblem } from './script-syntax';
import { applySpeciesScript, queueSpeciesEdit, settleSpeciesEdits, speciesEditsSettled, speciesIssue, speciesScriptCommand } from './species-scripts';

// 脚本框：出错的行号与说明（acorn 只解析）、停一下就提交的合并逻辑（第一次 exec，之后 replaceLast，一步撤销）

beforeAll(() => installAcorn(acorn));

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

  it('import()、console、太长的脚本：提交前就说', () => {
    expect(line("const m = 1;\nreturn import('https://example.com/x.js');")).toBe('第 2 行：脚本里不能用 import');
    expect(line('console.log(海拔);\nreturn 1;')).toBe('第 1 行：脚本里不能用 console');
    expect(line(`// ${'很长'.repeat(10001)}\nreturn 1;`)).toBe('脚本太长了（最多 20000 个字符）');
    // 对象的属性叫 import、console 不算
    expect(line('const o = { import: 1, console: 2 };\nreturn o.import + o.console > 0;')).toBeNull();
  });

  it('引擎里有的标准名字不算“没有变量”', () => {
    expect(line("return encodeURI('a').length > 0 && typeof structuredClone === 'function' && new URIError('x') instanceof Error;")).toBeNull();
  });

  it('“变量和例子”里的例子都能通过检查', () => {
    for (const [kind, list] of Object.entries(SCRIPT_EXAMPLES)) {
      for (const ex of list) expect(checkNow(kind as keyof typeof SCRIPT_EXAMPLES, ex.src), `${kind}：${ex.label}`).toBeNull();
    }
  });
});

describe('有循环的脚本：打字停下时先不用，离开框时才用（写到一半的循环会让计算停不下来）', () => {
  it('while、do、for(;;) 停下时是一句说明（不算错）；for…of 不算；离开框时照常检查', () => {
    const pause = { pause: true };
    expect(checkNow('placement', 'let i = 0;\nwhile (i < 3) i++;\nreturn i / 3;', undefined, pause)).toEqual({ text: LOOP_NOTE, reason: 'wait' });
    expect(checkNow('placement', 'let s = 0;\nfor (let i = 0; i < 3; i++) { s += i; }\nreturn s / 3;', undefined, pause)?.reason).toBe('wait');
    expect(checkNow('placement', 'let i = 0;\ndo { i++; } while (i < 3);\nreturn 1;', undefined, pause)?.reason).toBe('wait');
    expect(checkNow('placement', 'let s = 0;\nfor (const x of [1, 2]) s += x;\nreturn s / 3;', undefined, pause)).toBeNull();
    expect(checkNow('placement', 'let i = 0;\nwhile (i < 3) i++;\nreturn i / 3;')).toBeNull();
    // 先说真正的错
    expect(checkNow('placement', 'while (true) {}\nreturn tMeen;', undefined, pause)?.reason).toBe('name');
  });
});

// 假的定时器、假的世界：记下每次提交是新的一步还是换掉，状态编号随提交增加
function harness(
  initial = '',
  opts: {
    bad?: (src: string) => ScriptProblem | null;
    check?: (src: string, final: boolean) => ScriptProblem | null;
    fail?: (src: string) => string | null;
    idle?: () => boolean;
    settle?: () => Promise<void>;
  } = {},
) {
  vi.useFakeTimers();
  const calls: [ApplyMode, string][] = [];
  const reverts: string[] = [];
  const w = { state: 1, src: initial };
  const deps: ScriptEditDeps = {
    check: async (src, final) => opts.check?.(src, final) ?? null,
    idle: opts.idle,
    settle: opts.settle,
    apply: async (src, mode, revert): Promise<ApplyResult> => {
      calls.push([mode, src]);
      if (revert) reverts.push(src);
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
  return { edit, calls, reverts, w };
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

  it('别处的改动还没算完：先等它们算完再提交；最后一步已经不是这次的了，就是新的一步', async () => {
    let busy = false;
    let finish!: () => void;
    const { edit, calls, w } = harness('', {
      idle: () => !busy,
      settle: () => (busy ? new Promise<void>((r) => (finish = r)) : Promise.resolve()),
    });
    edit.focus();
    edit.input('return 1');
    await pause();
    // 涂了一笔，还在算（状态编号要等它算完才变）
    busy = true;
    edit.input('return 0.5');
    await pause();
    expect(calls).toEqual([['exec', 'return 1']]);
    // 那一笔算完了：最后一步是它，这次是新的一步
    busy = false;
    w.state++;
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      ['exec', 'return 1'],
      ['exec', 'return 0.5'],
    ]);
  });

  it('等完了却又有别的改动排上了（不空闲）：不换掉', async () => {
    let busy = false;
    const { edit, calls } = harness('', { idle: () => !busy, settle: async () => undefined });
    edit.focus();
    edit.input('return 1');
    await pause();
    busy = true;
    edit.input('return 0.5');
    await pause();
    expect(calls.map((c) => c[0])).toEqual(['exec', 'exec']);
  });

  it('在地图上出错、已经换回去了：世界没变时离开框不再拿它重算；世界变了再试', async () => {
    const bad = (src: string): ScriptProblem | null => (src.includes('boom') ? { line: 1, text: '读不到「x」：前面的值是 undefined', cell: 9, reason: 'runtime' } : null);
    const { edit, calls, reverts, w } = harness('return 1', { bad });
    edit.focus();
    edit.input('return boom.x;');
    await pause();
    expect(calls).toEqual([
      ['exec', 'return boom.x;'],
      ['replace', 'return 1'],
    ]);
    // 换回去的是旧写法（不报给信任列表）
    expect(reverts).toEqual(['return 1']);
    await edit.blur();
    expect(calls).toHaveLength(2);
    expect(edit.view()).toMatchObject({ problem: { cell: 9 }, stale: true });
    // 别处改了世界（比如地形变了，也许这回不出错了）：离开时再试一次，是新的一步
    w.state += 3;
    edit.focus();
    await edit.blur();
    expect(calls[2]).toEqual(['exec', 'return boom.x;']);
  });

  it('提交途中世界被撤销：提交完再同步一次，框里跟着世界', async () => {
    vi.useFakeTimers();
    let state = 1;
    let release!: () => void;
    const edit = new ScriptEdit(
      {
        check: async () => null,
        apply: () =>
          new Promise<ApplyResult>((r) => {
            release = () => {
              state++;
              r({ ok: true });
            };
          }),
        stateId: () => state,
        issue: () => null,
      },
      'return 1',
    );
    edit.focus();
    edit.input('return 2');
    await pause();
    // 还在算的时候撤销了（世界回到 return 1）：这时不管
    edit.sync('return 1', null);
    expect(edit.view().draft).toBe('return 2');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(edit.view().busy).toBe(false);
    // 提交完（ScriptBox 在 busy 变了时再同步）：框里换成世界上的
    edit.sync('return 1', null);
    expect(edit.view()).toMatchObject({ draft: 'return 1', problem: null, stale: false });
  });

  it('有循环：停下不提交，离开框时才提交', async () => {
    const { edit, calls } = harness('', { check: (src, final) => checkNow('placement', src, undefined, { pause: !final }) });
    edit.focus();
    edit.input('let s = 0;\nfor (let i = 0; i < 4; i++) s += i;\nreturn s / 6;');
    await pause();
    expect(calls).toEqual([]);
    expect(edit.view().problem).toEqual({ text: LOOP_NOTE, reason: 'wait' });
    await edit.blur();
    expect(calls).toEqual([['exec', 'let s = 0;\nfor (let i = 0; i < 4; i++) s += i;\nreturn s / 6;']]);
    expect(edit.view()).toMatchObject({ problem: null, stale: false });
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

// 回一个轻快照：把 update_species 的补丁用到这种生态上，换个状态编号
let nextState = 10;
function answerLast(): Request {
  const fw = FakeWorker.last!;
  const m = fw.sent[fw.sent.length - 1];
  const w = world.value!;
  const cmd = (m.req as { cmd: Extract<Command, { op: 'update_species' }> }).cmd;
  const species = w.small.species.map((s) => {
    if (s.id !== cmd.id) return s;
    const next = { ...s, ...cmd.patch } as Record<string, unknown>;
    for (const [k, v] of Object.entries(cmd.patch)) if (v === null) delete next[k];
    return next as Species;
  });
  const small = { ...w.small, species };
  const snap: LightSnapshot = { light: true, small, features: w.derived.features, province: w.causes.province.slice(), history: [], canUndo: true, canRedo: false, timings: { total: 0 }, stateId: ++nextState };
  fw.onmessage!({ data: { id: m.id, ok: true, summary: '修改了生态', snapshot: snap } });
  return m.req;
}
const sentCount = () => FakeWorker.last?.sent.length ?? 0;

describe('生态的脚本框接到真的 exec / replaceLast 上', () => {
  afterEach(() => {
    vi.useRealTimers();
    registerScriptCommitted(null);
  });

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
        apply: (src, mode, revert) => applySpeciesScript(sp.id, 'placement', src, mode, revert),
        stateId: () => worldState.value,
        issue: () => speciesIssue(sp.id, 'placement'),
        idle: speciesEditsSettled,
        settle: settleSpeciesEdits,
      },
      '',
    );
    vi.useFakeTimers();
    edit.focus();
    edit.input('return 海拔 > 500;');
    await pause();
    expect(answerLast().kind).toBe('exec');
    await vi.advanceTimersByTimeAsync(0);
    edit.input('return 海拔 > 800;');
    await pause();
    expect(answerLast()).toEqual({ kind: 'replaceLast', cmd: { op: 'update_species', id: sp.id, patch: { scripts: { placement: { api: 1, src: 'return 海拔 > 800;' } } } } });
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

  it('另一个框的提交还在算：等它算完再按最新的样子提交，两段都留着', async () => {
    const eng = continents({ cells: 2000 });
    world.value = eng.world;
    const sp = eng.world.small.species[1];
    const box = (kind: 'placement' | 'color') =>
      new ScriptEdit(
        {
          check: async (src) => checkNow(kind, src),
          apply: (src, mode, revert) => applySpeciesScript(sp.id, kind, src, mode, revert),
          stateId: () => worldState.value,
          issue: () => speciesIssue(sp.id, kind),
          idle: speciesEditsSettled,
          settle: settleSpeciesEdits,
        },
        '',
      );
    const a = box('placement');
    const b = box('color');
    vi.useFakeTimers();
    a.focus();
    a.input('return 0.5;');
    const sent = sentCount();
    const left = a.blur();
    await vi.advanceTimersByTimeAsync(0);
    // a 的 exec 发出去了，还没回来；b 停下要提交：先等着（这时 world 里还没有 a 的脚本）
    expect(sentCount()).toBe(sent + 1);
    b.focus();
    b.input('return [10, 20, 30];');
    await pause();
    expect(sentCount()).toBe(sent + 1);
    answerLast();
    await left;
    await vi.advanceTimersByTimeAsync(0);
    expect(sentCount()).toBe(sent + 2);
    const req = answerLast() as { kind: string; cmd: Command };
    expect(req.kind).toBe('exec');
    expect(req.cmd).toEqual({ op: 'update_species', id: sp.id, patch: { scripts: { placement: { api: 1, src: 'return 0.5;' }, color: { api: 1, src: 'return [10, 20, 30];' } } } });
  });

  it('只把这次写的这一段报给信任列表：整份带着的另一段、换回去的旧写法都不报', async () => {
    const eng = continents({ cells: 2000 });
    const w0 = eng.world;
    // 另一段是别人的脚本（比如“不运行脚本打开”的世界）
    w0.small.species[0] = { ...w0.small.species[0], scripts: { color: { api: 1, src: 'return [1, 2, 3];' } } };
    world.value = w0;
    const id = w0.small.species[0].id;
    const seen: CommittedScript[] = [];
    registerScriptCommitted((x) => seen.push(x));
    const p = applySpeciesScript(id, 'placement', 'return 0.25;', 'exec');
    answerLast();
    expect(await p).toEqual({ ok: true });
    const q = applySpeciesScript(id, 'placement', '', 'replace', true);
    answerLast();
    expect(await q).toEqual({ ok: true });
    expect(seen).toEqual([{ species: id, kind: 'placement', src: 'return 0.25;' }]);
  });

  it('换了世界：还没提交的不落到新世界上', async () => {
    const calls: string[] = [];
    const apply = inThisWorld(async (src) => {
      calls.push(src);
      return { ok: true };
    });
    expect(await apply('return 1;', 'exec')).toEqual({ ok: true });
    worldEpoch.value++;
    expect(await apply('return 2;', 'exec')).toMatchObject({ ok: false });
    expect(calls).toEqual(['return 1;']);
  });

  it('生态的改动排队：连着改两处，后一处按前一处算完后的样子做（不把前一处冲掉）', async () => {
    const eng = continents({ cells: 2000 });
    world.value = eng.world;
    const [sp, a, b] = eng.world.small.species;
    const toggle = (t: string) => (cur: Species) => ({ effects: { invade: { targets: [...(cur.effects?.invade?.targets ?? []), t], strength: 2 } } });
    const sent = sentCount();
    const one = queueSpeciesEdit(sp.id, '正在计算生态…', toggle(a.id));
    const two = queueSpeciesEdit(sp.id, '正在计算生态…', toggle(b.id));
    expect(speciesEditsSettled()).toBe(false);
    await vi.waitFor(() => expect(sentCount()).toBe(sent + 1));
    answerLast();
    expect(await one).toBe(true);
    await vi.waitFor(() => expect(sentCount()).toBe(sent + 2));
    const req = answerLast() as { cmd: Extract<Command, { op: 'update_species' }> };
    expect(await two).toBe(true);
    expect(req.cmd.patch).toEqual({ effects: { invade: { targets: [a.id, b.id], strength: 2 } } });
    await settleSpeciesEdits();
    expect(speciesEditsSettled()).toBe(true);
    // 排着的时候换了世界：不做
    const three = queueSpeciesEdit(sp.id, '正在计算生态…', () => ({ competition: 3 }));
    worldEpoch.value++;
    expect(await three).toBe(false);
    expect(sentCount()).toBe(sent + 2);
  });
});

describe('正在打开别的世界', () => {
  it('生态的改动、脚本的提交先等它打开；打开了就不再改（不落到新世界里同名的生态上）', async () => {
    world.value = continents({ cells: 2000 }).world;
    const id = world.value.small.species[0].id;
    // 设置无效：主线程不去预先建网格（Worker 是假的，不管它）
    void newWorld({ cells: 1 }, []);
    const sent = sentCount();
    expect(FakeWorker.last!.sent[sent - 1].req.kind).toBe('init');
    expect(speciesEditsSettled()).toBe(false);
    const job = queueSpeciesEdit(id, '正在计算生态…', () => ({ competition: 2 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentCount()).toBe(sent);
    // 新世界到了（这里只换纪元号，回复按出错处理）
    worldEpoch.value++;
    const m = FakeWorker.last!.sent[sent - 1];
    FakeWorker.last!.onmessage!({ data: { id: m.id, ok: false, error: '测试' } });
    expect(await job).toBe(false);
    expect(sentCount()).toBe(sent);
    expect(speciesEditsSettled()).toBe(true);
  });
});

describe('例子在真的世界上跑得通', () => {
  it('长在哪里、颜色的每个例子：用到一种生态上，没有出错说明', () => {
    for (const kind of ['placement', 'color'] as const) {
      for (const ex of SCRIPT_EXAMPLES[kind]) {
        const eng = continents({ cells: 2000 });
        const sp = eng.world.small.species[0];
        eng.exec({ op: 'update_species', id: sp.id, patch: { scripts: { [kind]: { api: 1, src: ex.src } } } });
        expect(eng.world.derived.scriptIssues, `${kind}：${ex.label}`).toBeUndefined();
        // 真的跑了：长在哪里的系数、颜色脚本的颜色写进了推导数据
        expect(kind === 'placement' ? eng.world.derived.placeF : eng.world.derived.look, `${kind}：${ex.label}`).toBeDefined();
      }
    }
  });
});
