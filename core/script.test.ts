import { describe, expect, it, vi } from 'vitest';

// 数一数 graphDistance 被调用了几次（离海岸、离河只在脚本用到时才算）
const calls = vi.hoisted(() => ({ graphDistance: 0 }));
vi.mock('./mesh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mesh')>();
  return {
    ...actual,
    graphDistance: (...a: Parameters<typeof actual.graphDistance>) => {
      calls.graphDistance++;
      return actual.graphDistance(...a);
    },
  };
});

import { CommandError } from './commands';
import { hashString } from './names';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import {
  type CellResult,
  type ScriptHost,
  ScriptError,
  VARIABLES,
  arrayInputs,
  checkPurity,
  compileScript,
  disallowScripts,
  findScripts,
  runScript,
  runSetup,
  scriptHash,
  scriptStats,
  scriptsSchema,
  setScriptHost,
  setScriptsEnabled,
  setSyntaxLocator,
  worldInputs,
} from './script';
import { continents, engineFor } from './testing/fixtures';

// 一个 6000 格的大陆世界，脚本在它的陆地格上跑
function setup() {
  const eng = continents({ cells: 6000 });
  const w = eng.world;
  const d = w.derived;
  const land: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && d.lake[i] !== 1) land.push(i);
  const cells = Int32Array.from(land);
  const inputs = worldInputs(w);
  const opts = { owner: '水晶丛林', id: 'crystal_jungle', seed: 7, inputs, cells };
  return { eng, w, d, cells, inputs, opts };
}

const placement = (src: string) => ({ kind: 'placement' as const, src });

// 地形脚本的输入：原来的高度、山、丘陵、岩性（调用方必须给全）加上别的
function crustIn(n: number, extra: Record<string, number[]> = {}) {
  const fill = (v: number) => Array.from({ length: n }, () => v);
  return arrayInputs(n, { height: fill(0), mountains: fill(0), hills: fill(0), rock: fill(1), ...extra }, { globe: true });
}

function syntaxError(src: string, owner = '水晶丛林'): ScriptError {
  try {
    compileScript('placement', src, owner);
  } catch (e) {
    return e as ScriptError;
  }
  throw new Error('应该有语法错误');
}

describe('脚本的运行环境', () => {
  it('语法错误给出中文说明', () => {
    const e = syntaxError('const a = elevation * 2;\nreturn a + ;');
    expect(e).toBeInstanceOf(ScriptError);
    expect(e).toBeInstanceOf(CommandError);
    expect(e.owner).toBe('水晶丛林');
    expect(e.kind).toBe('placement');
    expect(e.message).toMatch(/^「水晶丛林」的长在哪里脚本(第 \d+ 行)?有语法错误：这里不该出现「;」/);
    expect(syntaxError('return smoothstep(0, 1, elevation;').message).toContain('少了右括号 )');
    expect(syntaxError('if (elevation > 0) {\n  return 1;').message).toContain('代码没写完（少了右花括号 }）');
    expect(syntaxError('// 注释里的 { 不算\nreturn clamp(elevation));').message).toContain('多了一个 )');
    expect(syntaxError('return [1, 2);').message).toContain('括号没有配对');
    expect(syntaxError('return 海拔 > 100，').message).toContain('中文标点');
    // 注释、字符串里的中文标点、括号不算（真正的错是引号没配对）
    expect(syntaxError('// 注释里有中文标点，还有一个 (\nreturn "abc;').message).toContain('有不认识的字符（是不是引号没有配对？）');
    expect(syntaxError('return ")" + /[(]/.test("x") + ;').message).toMatch(/这里不该出现「;」/);
    // 行号：V8 不给，留给编辑器装的定位器（懒加载的 acorn）
    setSyntaxLocator(() => 2);
    expect(syntaxError('const a = 1;\nreturn (a + ;;').message).toMatch(/第 2 行有语法错误/);
    setSyntaxLocator(null);
    // 不能用多出来的 } 跑出生成代码里的那个块
    expect(syntaxError('return 1; } function evil() { return 2;').issue.reason).toBe('syntax');
    // 运行时遇到语法错误不抛，按没有脚本处理
    const { opts } = setup();
    const res = runScript(placement('return (;'), opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.reason).toBe('syntax');
    expect([...res.output.factor].every((v) => v === 1)).toBe(true);
  });

  it('运行时错误带正确行号（第 3 行）', () => {
    const { opts } = setup();
    const res = runScript(placement('const a = elevation * 2;\nconst b = a + 1;\nreturn b > tMeen;'), opts);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issue.line).toBe(3);
    expect(res.issue.cell).toBe(opts.cells[0]);
    expect(res.issue.message).toBe('「水晶丛林」的长在哪里脚本第 3 行出错：没有变量 tMeen（是不是 tMean？）');
    // 中文名也给提示
    const zh = runScript(placement('// 越暖越多\nreturn smoothstep(0, 20, 年均温度);'), opts);
    expect(zh.ok ? '' : zh.issue.message).toBe('「水晶丛林」的长在哪里脚本第 2 行出错：没有变量 年均温度（是不是 年均温？）');
    // 辅助函数里抛出的错误落在调用它的那一行
    const f = runScript(placement('const a = 1;\nreturn field("没有的场") * a;'), opts);
    expect(f.ok ? '' : f.issue.message).toBe('「水晶丛林」的长在哪里脚本第 2 行出错：没有自定义场「没有的场」');
    // 用户自己写的函数里出错，也是那一行
    const g = runScript(placement('function f(v) {\n  return v.foo.bar;\n}\nreturn f({}) ? 1 : 0;'), opts);
    expect(g.ok ? undefined : g.issue.line).toBe(2);
    // 只有颜色脚本能用的变量
    const s = runScript(placement('\nreturn share;'), opts);
    expect(s.ok ? '' : s.issue.text).toBe('长在哪里脚本里没有变量 share（只有颜色脚本能用）');
    const line = (src: string) => {
      const r = runScript(placement(src), opts);
      return r.ok ? undefined : r.issue.line;
    };
    // Windows 的换行、跨行的模板与注释都不影响行号
    expect(line('const a = 1;\r\nconst b = a;\r\nreturn b.foo.bar;')).toBe(3);
    expect(line('const s = `第一行\n第二行`;\n/* 注释\n还是注释 */\nreturn s.foo.bar;')).toBe(5);
    // 第 1 行就出错，前面的参数再多也一样
    expect(line('return tMean + elevation + 海拔 + moisture + rand() + slope.x.y;')).toBe(1);
    // 布局脚本也有行号
    const setupRes = runSetup({ src: '\n\nreturn blocks.foo.bar;' }, { owner: '双子大陆', seed: 1, values: { blocks: [] } });
    expect(setupRes.ok ? undefined : setupRes.issue.line).toBe(3);
    // 抛出的不是 Error（没有行号），甚至是一碰就出错的值：照样按没有脚本处理，不会变成硬错误
    const five = runScript(placement('throw 5;'), opts);
    expect(five.ok ? '' : five.issue.text).toBe('5');
    const nasty = runScript(placement('throw { toString() { throw new Error("又错了"); } };'), opts);
    expect(nasty.ok).toBe(false);
    expect([...nasty.output.factor].every((v) => v === 1)).toBe(true);
    const sneaky = runScript(placement('const e = new Error("x");\nObject.defineProperty(e, "message", { get() { throw 1; } });\nthrow e;'), opts);
    expect(sneaky.ok).toBe(false);
  });

  it('Math.random、Date、performance 不可用并给出提示', () => {
    const { opts } = setup();
    const text = (src: string) => {
      const r = runScript(placement(src), opts);
      return r.ok ? 'ok' : `${r.issue.line}:${r.issue.text}`;
    };
    expect(text('return Math.random();')).toBe('1:用 rand() 代替 Math.random()');
    expect(text('const t = Date.now();\nreturn t % 2;')).toBe('1:脚本里不能用时间');
    expect(text('\nreturn new Date().getDay() / 7;')).toBe('2:脚本里不能用时间');
    expect(text('return performance.now() > 0;')).toBe('1:脚本里不能用时间');
    expect(text('return fetch("https://example.com");')).toBe('1:脚本里不能用 fetch');
    expect(text('return eval("1");')).toBe('1:脚本里不能用 eval');
    // 全局对象被遮住；Math 是冻结的副本，其余照常
    expect(text("return typeof globalThis === 'undefined' && typeof window === 'undefined' && typeof self === 'undefined' && typeof process === 'undefined';")).toBe('ok');
    expect(text('return Object.isFrozen(Math) && Math.max(0.25, Math.sin(0)) === 0.25;')).toBe('ok');
    expect(text('const r = 1;\nMath.random = () => 0.5;\nreturn r;')).toMatch(/^2:/);
    // 辅助函数也是冻结的，不能在上面记东西
    expect(text('rand.last = cell;\nreturn 1;')).toMatch(/^1:/);
    // 别的会随时间、随电脑变的东西
    expect(text('return crypto.getRandomValues(new Uint8Array(1))[0] / 255;')).toBe('1:用 rand() 代替 crypto 的随机数');
    expect(text('return Temporal.Now.instant().epochMilliseconds % 2;')).toBe('1:脚本里不能用时间');
    expect(text('return new Intl.DateTimeFormat().format().length > 3;')).toBe('1:脚本里不能用 Intl（结果会随电脑的语言和时区变）');
    expect(text('return new Worker("x") ? 1 : 0;')).toBe('1:脚本里不能用 Worker');
    expect(text("return typeof navigator === 'undefined' && typeof WeakRef === 'undefined' && typeof global === 'undefined';")).toBe('ok');
    // 用户自己的报错里出现 Date 这个词，不当成“用了时间”
    expect(text('throw new Error("Date 不对");')).toBe('1:Date 不对');
  });

  it('脚本碰不到运行环境自己的东西，也没有地方记住上一格', () => {
    const { opts, w } = setup();
    const text = (src: string) => {
      const r = runScript(placement(src), opts);
      return r.ok ? 'ok' : `${r.issue.line}:${r.issue.text}`;
    };
    // 生成代码自己的名字（运行状态、循环函数、辅助函数表）在脚本里都是 undefined：
    // 否则 __st.inputs.get('elevation') 能直接改引擎的推导数组，__map2_script.memo 能跨运行记东西
    expect(text("return [__st, __h, __map2_script, __map2_loop].every((v) => typeof v === 'undefined');")).toBe('ok');
    // 用了这些名字的 var 会和生成代码冲突：当场按语法错误拒绝
    expect(() => compileScript('placement', 'var __st = 1;\nreturn 1;')).toThrow(ScriptError);
    // 函数声明带的 prototype 对象也是冻结的
    expect(text('rand.prototype.memo = cell;\nreturn 1;')).toMatch(/^1:/);
    expect(text('field.prototype.memo = cell;\nreturn 1;')).toMatch(/^1:/);
    // Date 等替身的所有操作都拦下（defineProperty 不会落到替身背后的对象上）
    expect(text("Object.defineProperty(Date, 'memo', { value: cell });\nreturn 1;")).toBe('1:脚本里不能用时间');
    expect(text("return Object.getOwnPropertyDescriptor(performance, 'now') ? 1 : 0;")).toBe('1:脚本里不能用时间');
    // 颜色脚本的 color 是冻结的副本，调用方的数组不受影响
    const base = [10, 20, 30];
    const share = new Float32Array(w.mesh.n);
    const r = runScript({ kind: 'color', src: 'color.push(1);\nreturn color;' }, { ...opts, inputs: worldInputs(w, w.derived, { extra: { share, color: base } }) });
    expect(r.ok ? 0 : r.issue.line).toBe(1);
    expect(base).toEqual([10, 20, 30]);
  });

  it('NaN 不抛错而是报告问题并按没有脚本处理', () => {
    const { opts, d, w } = setup();
    const res = runScript(placement('return elevation > 300 ? 0 / 0 : 0.5;'), opts);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issue.reason).toBe('value');
    expect(d.elevation[res.issue.cell!]).toBeGreaterThan(300);
    expect(res.issue.message).toBe('「水晶丛林」的长在哪里脚本出错：地图上有一处算出了 NaN（不是数字）');
    // 当作没有这段脚本：系数 1
    expect(res.output.factor.length).toBe(opts.cells.length);
    expect([...res.output.factor].every((v) => v === 1)).toBe(true);
    // 类型不对、忘了 return 也一样
    const str = runScript(placement('return "很多";'), opts);
    expect(str.ok ? '' : str.issue.text).toBe('应该返回0 到 1 之间的数，或 true / false，地图上有一处返回了文字 "很多"');
    const none = runScript(placement('elevation > 0;'), opts);
    expect(none.ok ? '' : none.issue.text).toContain('忘了写 return');
    // 超出范围的数截到 0–1；true / false 是 1 / 0
    const big = runScript(placement('return elevation / 100 - 3;'), opts);
    expect(big.ok).toBe(true);
    for (let j = 0; j < opts.cells.length; j++) {
      const e = d.elevation[opts.cells[j]] / 100 - 3;
      expect(big.output.factor[j]).toBe(Math.fround(Math.min(1, Math.max(0, e))));
    }
    const bool = runScript(placement('return elevation > 500;'), opts);
    expect([...bool.output.factor].every((v, j) => v === (d.elevation[opts.cells[j]] > 500 ? 1 : 0))).toBe(true);
    // 颜色脚本出错 → 基础颜色；河流匹配出错 → 不匹配；地形脚本出错 → 地形不改
    const color = runScript({ kind: 'color', src: 'return [share * 0 / 0, 0, 0];' }, { ...opts, inputs: worldInputs(w, d, { extra: { share: new Float32Array(w.mesh.n), color: [10, 20, 30] } }) });
    expect(color.ok).toBe(false);
    expect([...color.output.rgb.slice(0, 6)]).toEqual([10, 20, 30, 10, 20, 30]);
    const match = runScript({ kind: 'match', src: 'return discharge.foo.bar;' }, opts);
    expect(match.ok).toBe(false);
    expect([...match.output.match].every((v) => v === 0)).toBe(true);
    // 河流匹配：没有 return 的分支算不匹配（常见写法），NaN 算出错
    const partial = runScript({ kind: 'match', src: 'if (discharge > 10) return true;' }, opts);
    expect(partial.ok).toBe(true);
    const nanMatch = runScript({ kind: 'match', src: 'return discharge * NaN;' }, opts);
    expect(nanMatch.ok ? '' : nanMatch.issue.text).toBe('地图上有一处算出了 NaN（不是数字）');
    const n = 4;
    const crustInputs = arrayInputs(n, { height: [100, 200, 300, 400], mountains: [0, 1, 0, 1], hills: [0, 0, 0, 0], rock: [1, 1, 1, 1] }, { globe: true });
    const crust = runScript({ kind: 'crust', src: 'return height > 250 ? NaN : height;' }, { owner: '极地大陆', seed: 1, inputs: crustInputs, cells: [0, 1, 2, 3] });
    expect(crust.ok).toBe(false);
    expect([...crust.output.height]).toEqual([100, 200, 300, 400]);
    // 地形脚本缺了原来的地形是调用方的错：直接抛错，不会把 0 当成岩性写回去
    const noRock = arrayInputs(1, { height: [1], mountains: [0], hills: [0] }, { globe: true });
    expect(() => runScript({ kind: 'crust', src: 'return height;' }, { owner: '极地大陆', seed: 1, inputs: noRock, cells: [0] })).toThrow(/没有 rock/);
  });

  it('颜色与地形脚本的返回值', () => {
    const { w, opts } = setup();
    const share = new Float32Array(w.mesh.n).fill(0.5);
    const inputs = worldInputs(w, w.derived, { extra: { share, color: [100, 50, 0] } });
    const c = runScript({ kind: 'color', src: "return mixColor(color, '#ffffff', 份额);" }, { ...opts, inputs });
    expect(c.ok).toBe(true);
    expect([...c.output.rgb.slice(0, 3)]).toEqual([178, 153, 128]);
    // color 是只读的
    const frozen = runScript({ kind: 'color', src: 'color[0] = 1;\nreturn color;' }, { ...opts, inputs });
    expect(frozen.ok ? 0 : frozen.issue.line).toBe(1);
    const crustInputs = arrayInputs(2, { height: [100, -3000], mountains: [0.5, 0], hills: [0.1, 0], rock: [1, 1] }, { globe: true });
    const r = runScript({ kind: 'crust', src: 'return { height: height + 50000, rock: 5 };' }, { owner: '极地大陆', seed: 1, inputs: crustInputs, cells: [0, 1] });
    expect(r.ok).toBe(true);
    expect([...r.output.height]).toEqual([9000, 9000]);
    expect([...r.output.rock]).toEqual([1.8, 1.8]);
    expect([...r.output.mountains]).toEqual([0.5, 0]);
    const num = runScript({ kind: 'crust', src: 'return 高度 - 20000;' }, { owner: '极地大陆', seed: 1, inputs: crustInputs, cells: [1] });
    expect([...num.output.height]).toEqual([-11000]);
  });

  it('rand(k) 每格确定、与计算顺序无关', () => {
    const { opts } = setup();
    const src = 'return rand(3);';
    const fwd = runScript(placement(src), opts);
    const rev = runScript(placement(src), { ...opts, cells: opts.cells.slice().reverse() });
    const sub = runScript(placement(src), { ...opts, cells: opts.cells.filter((_, j) => j % 7 === 3) });
    const m = opts.cells.length;
    for (let j = 0; j < m; j++) expect(rev.output.factor[m - 1 - j]).toBe(fwd.output.factor[j]);
    for (let j = 0; j < sub.output.factor.length; j++) expect(sub.output.factor[j]).toBe(fwd.output.factor[7 * j + 3]);
    // 公式：mixSeed(mixSeed(世界种子, hashString(id), k), 格) / 2³²
    const i = opts.cells[5];
    expect(fwd.output.factor[5]).toBe(Math.fround(mixSeed(mixSeed(7, hashString('crystal_jungle'), 3), i) / 4294967296));
    // 换 k、换所属、换世界种子都换一组；seedKey 固定时改 id 不变
    const other = (o: object, s = src) => runScript(placement(s), { ...opts, ...o }).output.factor;
    expect(other({}, 'return rand(4);')).not.toEqual(fwd.output.factor);
    expect(other({ id: 'swarm_zone' })).not.toEqual(fwd.output.factor);
    expect(other({ seed: 8 })).not.toEqual(fwd.output.factor);
    expect(other({ id: 'a', seedKey: 'k' })).toEqual(other({ id: 'b', seedKey: 'k' }));
    // 均匀：平均约 0.5
    const mean = fwd.output.factor.reduce((a, b) => a + b, 0) / m;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.03);
    // 地形脚本按位置：同一位置不论格的编号都得到同一个数
    const px = [0.6, 0, 0.8];
    const py = [0, 0.6, 0];
    const pz = [0.8, 0.8, 0.6];
    const a = runScript({ kind: 'crust', src: 'return rand();' }, { owner: 'f', seed: 1, inputs: crustIn(3, { px, py, pz }), cells: [0, 1, 2] });
    const b = runScript(
      { kind: 'crust', src: 'return rand();' },
      { owner: 'f', seed: 1, inputs: crustIn(3, { px: [px[2], px[0], px[1]], py: [py[2], py[0], py[1]], pz: [pz[2], pz[0], pz[1]] }), cells: [1, 2, 0] },
    );
    expect([...b.output.height]).toEqual([...a.output.height]);
  });

  it('噪声：fbmAt 在地区上是平面噪声，在星球上是三维噪声（没有接缝）', () => {
    const x = [0.1, 0.7];
    const y = [0.3, 0.2];
    const region = runScript({ kind: 'match', src: 'return fbmAt(2, 3, 1) > -2;' }, { owner: 'r', id: 'r', seed: 5, inputs: arrayInputs(2, { x, y }), cells: [0, 1] });
    expect([...region.output.match]).toEqual([1, 1]);
    // 用颜色脚本把噪声值带出来（×100 + 128）
    const probe = (src: string, inputs: ReturnType<typeof arrayInputs>) =>
      runScript({ kind: 'color', src }, { owner: 'r', id: 'r', seed: 5, inputs, cells: [0, 1] }).output.rgb;
    const regionInputs = arrayInputs(2, { x, y, color: [0, 0, 0] });
    const n2 = gradientNoise(mixSeed(5, hashString('r'), 1));
    const got = probe('const v = fbmAt(2, 3, 1) * 100 + 128;\nreturn [v, v, v];', regionInputs);
    for (let j = 0; j < 2; j++) expect(got[3 * j]).toBe(Math.round(fbm(n2, x[j], y[j], 2, 3, 0.5) * 100 + 128));
    const planetInputs = arrayInputs(2, { px: [0.6, 0], py: [0, 0.6], pz: [0.8, 0.8], color: [0, 0, 0] }, { globe: true });
    const n3 = gradientNoise3(mixSeed(5, hashString('r'), 1));
    const got3 = probe('const v = fbmAt(2, 3, 1) * 100 + 128;\nreturn [v, v, v];', planetInputs);
    expect(got3[0]).toBe(Math.round(fbm3(n3, 0.6, 0, 0.8, 2 / Math.PI, 3, 0.5) * 100 + 128));
    expect(got3[3]).toBe(Math.round(fbm3(n3, 0, 0.6, 0.8, 2 / Math.PI, 3, 0.5) * 100 + 128));
  });

  it('整个星球的输入：单位球面上的位置、经纬度', () => {
    const eng = engineFor({ cells: 2000, seed: 2, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    const w = eng.world;
    const inputs = worldInputs(w);
    const cells = Int32Array.from({ length: w.mesh.n }, (_, i) => i);
    const r = runScript(
      { kind: 'match', src: 'const r = Math.hypot(px, py, pz);\nreturn globe && Math.abs(r - 1) < 1e-9 && Math.abs(lon) <= 180 && Math.abs(纬度) <= 90 && fbmAt(3) > -2;' },
      { owner: '星球', seed: 1, inputs, cells },
    );
    expect(r.ok).toBe(true);
    expect([...r.output.match].every((v) => v === 1)).toBe(true);
    // 北极附近的格 pz 接近 1、纬度接近 90
    const north = (w.mesh as { north: number }).north;
    const pz = inputs.get('pz') as Float64Array;
    const lat = inputs.get('lat') as Float64Array;
    expect(pz[north]).toBeGreaterThan(0.99);
    expect(lat[north]).toBeGreaterThan(85);
  });

  it('中文变量名可用（海拔、年均温）', () => {
    const { opts } = setup();
    const zh = runScript(placement('// 越高越少，冷的地方减半\nreturn (1 - smoothstep(0, 2000, 海拔)) * (年均温 > 5 ? 1 : 0.5);'), opts);
    const en = runScript(placement('// 越高越少，冷的地方减半\nreturn (1 - smoothstep(0, 2000, elevation)) * (tMean > 5 ? 1 : 0.5);'), opts);
    expect(zh.ok && en.ok).toBe(true);
    expect([...zh.output.factor]).toEqual([...en.output.factor]);
    expect(compileScript('placement', 'return 海拔 * 年均温 + elevation;').names).toEqual(['年均温', 'elevation', '海拔']);
    // 名字是一个整体：海拔高 不是 海拔；自己声明同名变量也可以
    expect(compileScript('placement', 'const 海拔高 = 3;\nreturn 海拔高 / 4;').names).toEqual([]);
    const own = runScript(placement('const elevation = 0.25;\nreturn elevation;'), opts);
    expect(own.ok && [...own.output.factor].every((v) => v === 0.25)).toBe(true);
    // 每个中文名只属于一个变量
    const zhNames = VARIABLES.flatMap((v) => (v.zh ? [v.zh] : []));
    expect(new Set(zhNames).size).toBe(zhNames.length);
    // 注释、字符串里的名字不算；模板里的 ${…} 是代码，算
    const names = (src: string, kind: 'placement' | 'crust' = 'placement') => compileScript(kind, src).names;
    expect(names('// 离河越近越多，海拔不管\nreturn field("coastDist") * 坡度;')).toEqual(['坡度']);
    expect(names('/* tMean\n   年均温 */ return `${海拔}米`.length > 3;')).toEqual(['海拔']);
    expect(names('return `a${`b${lake}`}c` ? 1 : 0;')).toEqual(['lake']);
    // 正则里的引号不会把后面的代码当成字符串；正则的标志 y 不是变量 y
    expect(names('return /"/.test("a") ? elevation : 0;')).toEqual(['elevation']);
    expect(names("return /x[/]/y.test('x') ? 1 : 0;")).toEqual([]);
    expect(names('const r = slope / 2 / 3;\nreturn r;')).toEqual(['slope']);
    // 名字是一个整体：大陆性 不是 大陆；加大陆块 不是 大陆块
    expect(names('return 大陆性 + 大陆;', 'crust')).toEqual(['大陆']);
    // 只在注释里提到、这次又没有提供的变量，不会让脚本出错
    const partial = arrayInputs(2, { elevation: [100, 900] });
    const r = runScript(placement('// 不看离河（riverDist）\nreturn elevation > 500;'), { owner: '测试', seed: 1, inputs: partial, cells: [0, 1] });
    expect(r.ok && [...r.output.factor]).toEqual([0, 1]);
  });

  it('只计算用到的变量（coastDist 未引用时不调用 graphDistance）', () => {
    const { w, opts } = setup();
    const before = calls.graphDistance;
    runScript(placement('return tMean > 0;'), opts);
    runScript(placement('// coast 只出现在注释的一部分里\nreturn wetness > 10;'), opts);
    runScript(placement('// 离海岸、离河（coastDist、riverDist）都只在注释里\nreturn wetness > "riverDist".length;'), opts);
    expect(calls.graphDistance).toBe(before);
    const near = runScript(placement('return 1 - smoothstep(0, 300, coastDist);'), opts);
    expect(calls.graphDistance).toBe(before + 1);
    // 按内容缓存：同样的陆海不再算；中文名是同一个变量
    const zh = runScript(placement('return 1 - smoothstep(0, 300, 离海岸);'), opts);
    expect(calls.graphDistance).toBe(before + 1);
    expect([...zh.output.factor]).toEqual([...near.output.factor]);
    // 陆海原地改了一格 → 重算；改回来 → 用缓存
    const i = opts.cells[0];
    w.causes.land[i] = 0;
    runScript(placement('return coastDist > 0;'), opts);
    expect(calls.graphDistance).toBe(before + 2);
    w.causes.land[i] = 1;
    runScript(placement('return coastDist > 0;'), opts);
    expect(calls.graphDistance).toBe(before + 2);
    // 离河同理
    runScript(placement('return riverDist < 100;'), opts);
    runScript(placement('return 离河 < 100;'), opts);
    expect(calls.graphDistance).toBe(before + 3);
    // 离河只看哪些格是河：流量变了一点、河没变，不重算
    const thr = w.small.planet.riverThreshold;
    const k = opts.cells.find((c) => w.derived.discharge[c] < thr / 4)!;
    const old = w.derived.discharge[k];
    w.derived.discharge[k] = old * 2;
    runScript(placement('return riverDist < 100;'), opts);
    expect(calls.graphDistance).toBe(before + 3);
    w.derived.discharge[k] = old;
    // 离海岸是 km：挨着海的陆地不到两格宽
    const dist = worldInputs(w).get('coastDist') as Float64Array;
    const cellKm = Math.sqrt(w.mesh.totalArea / w.mesh.n) * w.kmPerUnit;
    for (let j = 0; j < w.mesh.n; j++) if (!w.causes.land[j]) expect(dist[j]).toBe(0);
    const coastal = opts.cells.filter((c) => {
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return true;
      return false;
    });
    expect(coastal.length).toBeGreaterThan(0);
    for (const c of coastal) expect(dist[c]).toBeLessThan(2 * cellKm);
  });

  it('同一源码只编译一次', () => {
    const { opts } = setup();
    const src = 'return clamp(tMean / 30); // 只编译一次';
    const before = scriptStats.compiles;
    compileScript('placement', src);
    compileScript('placement', src, '别的生态');
    runScript(placement(src), opts);
    runScript(placement(src), { ...opts, owner: '死亡森林', id: 'dead_forest' });
    expect(scriptStats.compiles - before).toBe(1);
    // 语法错误也只编译一次，报错里用各自的名字
    const bad = 'return (; // 只编译一次';
    expect(() => compileScript('placement', bad, '甲')).toThrow(/「甲」/);
    expect(() => compileScript('placement', bad, '乙')).toThrow(/「乙」/);
    expect(scriptStats.compiles - before).toBe(2);
    // 最近用过的 128 段：再编译 128 段别的，最早那段被挤出去，要重新编译
    for (let k = 0; k < 128; k++) compileScript('placement', `return ${k} / 1000; // 挤掉`);
    const mid = scriptStats.compiles;
    compileScript('placement', src);
    expect(scriptStats.compiles - mid).toBe(1);
    // 种类不同的同一段源码分开缓存（变量表不同）
    expect(compileScript('crust', 'return rock;').names).toEqual(['rock']);
    expect(compileScript('placement', 'return rock;').names).toEqual(['rock']);
    expect(compileScript('crust', 'return 海拔;').names).toEqual([]);
  });

  it('纯度检查识别“记住上一格”的脚本', () => {
    const { opts } = setup();
    const sample = opts.cells.slice(0, 300);
    const run = (src: string) => (cells: Int32Array): CellResult => runScript(placement(src), { ...opts, cells });
    const sticky = 'const prev = JSON.__prev ?? 0;\nJSON.__prev = elevation;\nreturn prev > 300;';
    const r = checkPurity(run(sticky), sample);
    expect(r.pure).toBe(false);
    expect(r.cell).toBeDefined();
    expect(r.changed).toBe('JSON.__prev');
    // 检查完挂上去的东西被删掉了
    expect((JSON as unknown as Record<string, unknown>).__prev).toBeUndefined();
    expect(checkPurity(run('return smoothstep(0, 20, tMean) * rand(2);'), sample)).toEqual({ pure: true });
    const failed = checkPurity(run('return 完全没有的名字;'), sample);
    expect(failed.pure).toBe(false);
    expect(failed.issue?.text).toBe('没有变量 完全没有的名字');
    // 只在第一格记一次、之后一直用它：正反两遍结果相同，但下一次运行（或重放）会不同——靠比较内置对象查出来
    const once = (where: string) => `${where} ??= elevation;\nreturn ${where} > 300;`;
    const g = globalThis as unknown as Record<string, unknown>;
    for (const [where, name] of [
      ['JSON.memo', 'JSON.memo'],
      ['Math.sin.memo', 'Math.sin.memo'],
      ['[].constructor.prototype.memo', 'Array.prototype.memo'],
      ['(() => {}).constructor("return this")().memo', 'globalThis.memo'],
    ]) {
      const res = checkPurity(run(once(where)), sample);
      expect(res.cell).toBeUndefined();
      expect(res).toMatchObject({ pure: false, changed: name });
      expect(res.text).toContain(name);
    }
    const memoOf = (o: unknown) => (o as Record<string, unknown>).memo;
    expect([memoOf(JSON), memoOf(Math.sin), memoOf([]), g.memo]).toEqual([undefined, undefined, undefined, undefined]);
    // 结果取决于同一批里有哪些格（只重算变了的格时会出错）：隔一格算一遍查出来
    const bySize = (cells: Int32Array): CellResult => ({ ok: true, output: { factor: Float32Array.from(cells, () => cells.length % 7) } });
    expect(checkPurity(bySize, sample)).toMatchObject({ pure: false, cell: sample[1] });
  });

  it('看门狗：每 256 格报一次平安，出错也会退出', () => {
    const { opts } = setup();
    const log: string[] = [];
    const host: ScriptHost = { enter: (l) => log.push(`enter ${l}`), tick: () => log.push('tick'), exit: () => log.push('exit') };
    setScriptHost(host);
    try {
      const cells = opts.cells.slice(0, 1000);
      runScript(placement('return 1;'), { ...opts, cells });
      expect(log).toEqual(['enter 水晶丛林', 'tick', 'tick', 'tick', 'exit']);
      log.length = 0;
      runScript(placement('if (cell === -1) return 1;\nthrow new Error("坏了");'), { ...opts, cells });
      expect(log).toEqual(['enter 水晶丛林', 'exit']);
    } finally {
      setScriptHost(null);
    }
    // 看门狗自己出错是调用方的错，照样抛出；但运行状态复原了，之后的脚本照常运行
    const broken: ScriptHost = {
      enter() {
        throw new Error('看门狗坏了');
      },
      tick() {},
      exit() {},
    };
    setScriptHost(broken);
    try {
      expect(() => runScript(placement('return 1;'), opts)).toThrow('看门狗坏了');
    } finally {
      setScriptHost(null);
    }
    expect(runScript(placement('return 1;'), opts).ok).toBe(true);
    // 脚本里（经由引擎提供的 river 钩子）再运行脚本：外面这段按出错处理，之后照常
    const river = () => {
      runScript(placement('return 1;'), opts);
      return new Float32Array(opts.inputs.n);
    };
    const r = runScript(placement("return river('blood');"), { ...opts, inputs: { ...opts.inputs, river } });
    expect(r.ok ? '' : r.issue.text).toBe('脚本不能嵌套运行');
    expect(runScript(placement('return 1;'), opts).ok).toBe(true);
  });

  it('安全模式：脚本不运行，按没有脚本处理', () => {
    const { opts } = setup();
    setScriptsEnabled(false);
    try {
      const r = runScript(placement('return 0;'), opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issue.reason).toBe('disabled');
      expect([...r.output.factor].every((v) => v === 1)).toBe(true);
    } finally {
      setScriptsEnabled(true);
    }
    expect(runScript(placement('return 0;'), opts).ok).toBe(true);
  });

  it('布局脚本：运行一次，rand() 是第 105 号随机流', () => {
    const blocks: object[] = [];
    const values = { addBlock: (b: object) => blocks.push(b), globe: true, seed: 9 };
    const src = 'const lon = rand() * 360 - 180;\naddBlock({ lat: 10, lon, size: 30 });\n加大陆块({ lat: -10, lon: lon + 180, size: 28 });\nreturn globe;';
    const r = runSetup({ src }, { owner: '双子大陆', id: 'twins', seed: 9, values });
    expect(r).toEqual({ ok: true, value: true });
    expect(blocks.length).toBe(2);
    const again: object[] = [];
    runSetup({ src }, { owner: '双子大陆', id: 'twins', seed: 9, values: { ...values, addBlock: (b: object) => again.push(b) } });
    expect(again).toEqual(blocks);
    const bad = runSetup({ src: '\naddIsland({});' }, { owner: '双子大陆', seed: 9, values });
    expect(bad.ok ? '' : bad.issue.message).toBe('「双子大陆」的布局脚本第 2 行出错：这里没有变量 addIsland');
    // 脚本拿到的是冻结的副本：改不了调用方的列表，也不能在函数上记东西
    const old = [{ lat: 1, lon: 2, size: 3 }];
    const mutate = runSetup({ src: 'blocks[0].lat = 50;\nreturn 1;' }, { owner: '双子大陆', seed: 9, values: { blocks: old } });
    expect(mutate.ok ? 0 : mutate.issue.line).toBe(1);
    expect(old[0].lat).toBe(1);
    const memo = runSetup({ src: '\naddBlock.memo = 1;' }, { owner: '双子大陆', seed: 9, values });
    expect(memo.ok ? 0 : memo.issue.line).toBe(2);
  });

  it('findScripts 找到 batch 里的全部脚本', () => {
    const s = (src: string) => ({ api: 1, src });
    const crystal = { id: 'crystal_jungle', name: '水晶丛林', scripts: { placement: s('return 1;'), color: s('return color;') } };
    const riverType = { op: 'set_river_type', type: { id: 'blood_river', name: '血河', scripts: { match: s('return true;') } } };
    const batch = {
      op: 'batch',
      label: '用了资源包「奇幻」',
      commands: [
        { op: 'update_species', id: 'crystal_jungle', patch: { scripts: { placement: s('return 0.5;') } } },
        riverType,
        {
          op: 'set_worldgen',
          params: { seed: 1, type: 'continents', form: { id: 'twins', name: '双子大陆', scripts: { setup: s('addBlock({});'), crust: s('return 1;') } } },
        },
        { op: 'batch', commands: [{ op: 'add_species', species: { id: 'plain', name: '平原' } }] },
      ],
    };
    const doc = { format: 'map2-world', version: 5, commands: [{ op: 'add_species', species: crystal }, batch] };
    const found = findScripts(doc);
    expect(found.map((f) => `${f.owner}/${f.id}/${f.kind}`)).toEqual([
      '水晶丛林/crystal_jungle/placement',
      '水晶丛林/crystal_jungle/color',
      'crystal_jungle/crystal_jungle/placement',
      '血河/blood_river/match',
      '双子大陆/twins/setup',
      '双子大陆/twins/crust',
    ]);
    expect(found[2].path).toBe('commands[1].commands[0].patch.scripts.placement');
    expect(found[3].src).toBe('return true;');
    expect(found[3].hash).toBe(scriptHash('return true;'));
    expect(found[3].hash).toMatch(/^[0-9a-f]{16}$/);
    expect(found[0].hash).toBe(found[5].hash);
    expect(scriptHash('return 2;')).not.toBe(scriptHash('return 1;'));
    // 资源包、单条命令也一样
    expect(findScripts({ format: 'map2-pack', biomes: [crystal] }).length).toBe(2);
    expect(findScripts(riverType).length).toBe(1);
    expect(findScripts({ op: 'add_species', species: { id: 'x' } })).toEqual([]);
    // 套很多层 batch 也藏不住（信任检查靠它）
    let deep: object = { op: 'add_species', species: { id: 'hidden', name: '藏起来', scripts: { placement: s('return 1;') } } };
    for (let k = 0; k < 5000; k++) deep = { op: 'batch', commands: [deep] };
    const hidden = findScripts(deep);
    expect(hidden.map((f) => `${f.owner}/${f.kind}`)).toEqual(['藏起来/placement']);
  });

  it('容器的格式：全部可选、没有默认值', () => {
    expect(scriptsSchema.parse({})).toEqual({});
    expect(scriptsSchema.parse({ color: { api: 1, src: 'return color;' } })).toEqual({ color: { api: 1, src: 'return color;' } });
    expect(scriptsSchema.safeParse({ placement: { api: 2, src: 'return 1;' } }).success).toBe(false);
    expect(scriptsSchema.safeParse({ placement: { api: 1, src: 'x'.repeat(20001) } }).success).toBe(false);
    // 没有省份变量（改省份不触发重算）
    expect(VARIABLES.some((v) => v.key === 'province')).toBe(false);
  });

  it('速度：引用 3 个变量的脚本跑 10 万格', () => {
    const n = 100000;
    const tMean = new Float32Array(n);
    const elevation = new Float32Array(n);
    const moisture = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      tMean[i] = ((i * 7919) % 6000) / 100 - 20;
      elevation[i] = (i * 104729) % 4000;
      moisture[i] = ((i * 31) % 300) / 100;
    }
    const inputs = arrayInputs(n, { tMean, elevation, moisture, seed: 3 });
    const cells = Int32Array.from({ length: n }, (_, i) => i);
    const src = 'return smoothstep(5, 25, tMean) * (1 - smoothstep(500, 2500, elevation)) * clamp(moisture);';
    const opts = { owner: '速度', inputs, cells };
    for (let k = 0; k < 3; k++) runScript(placement(src), opts);
    let best = Infinity;
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      const r = runScript(placement(src), opts);
      best = Math.min(best, performance.now() - t0);
      expect(r.ok).toBe(true);
    }
    console.log(`10 万格、3 个变量的长在哪里脚本：${best.toFixed(2)} ms`);
    expect(best).toBeLessThan(40);
  });

  it('动态 import() 编译时就拒绝，说出第几行；注释、字符串里的，属性 obj.import、私有方法 #import 不算', () => {
    const e = syntaxError('const a = 1;\nreturn import("https://example.com/x.js");');
    expect(e.issue.reason).toBe('syntax');
    expect(e.line).toBe(2);
    expect(e.message).toBe('「水晶丛林」的长在哪里脚本第 2 行有语法错误：脚本里不能用 import');
    // 换行、注释夹在中间，展开运算符后面，模板里的 ${…}
    expect(syntaxError('return import\n  /* 注释 */ ("x");').line).toBe(1);
    expect(syntaxError('const a = [...import("x")];\nreturn 1;').line).toBe(1);
    expect(syntaxError('const s = `${import("x")}`;\nreturn 1;').line).toBe(1);
    // 不是动态 import
    const ok = (src: string) => expect(() => compileScript('placement', src)).not.toThrow();
    ok('// import("x") 写在注释里\nreturn 1;');
    ok('const s = "import(x)";\nreturn s.length > 0 ? 1 : 0;');
    ok('const o = { import: (x) => x };\nreturn o?.import(1) + o. import(0);');
    ok('const myimport = (x) => x;\nreturn myimport(1);');
    ok('class A { #import(x) { return x; } run() { return this.#import(1); } }\nreturn new A().run();');
  });

  // 放在最后：之后本文件里不能再编译脚本
  it('disallowScripts 后编译抛错', () => {
    disallowScripts();
    expect(() => compileScript('placement', 'return 1;')).toThrow('主线程不运行脚本');
    expect(() => compileScript('placement', 'return clamp(tMean / 30); // 只编译一次')).toThrow('主线程不运行脚本');
    const { opts } = setup();
    expect(() => runScript(placement('return 1;'), opts)).toThrow('主线程不运行脚本');
  });
});
