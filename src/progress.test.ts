import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import { DEFAULT_STEP_MS, REF_CELLS } from './progress-defaults';
import { PROGRESS_KEY, type Profile, ProgressBook, ProgressTrack, SHOW_AFTER_MS, defaultMs, defaultProfile, jobKey } from './progress';
import type { Request } from './protocol';
import { PROGRESS_TEXT } from './ui/copy';

// 第九十七轮：进度条画多长（纯规则）。按时间算、按量到的各步耗时加权；不倒退、不自己走到头

const plan: Profile = [
  ['elevation', 300],
  ['climate', 400],
  ['water', 100],
  ['features', 200],
];
const ping = (step: string, k = 1, n = 1, inner = false) => ({ step, k, n, ...(inner ? { inner } : {}) });

describe('进度条画多长', () => {
  it('各步和估的一样快：按时间匀着走，每到一步的边界正是它占的那一份', () => {
    const t = new ProgressTrack(plan, 0);
    expect(t.fraction(0)).toBe(0);
    t.ping(ping('elevation', 1, 4), 0);
    expect(t.fraction(150)).toBeCloseTo(0.15);
    t.ping(ping('climate', 2, 4), 300);
    expect(t.fraction(300)).toBeCloseTo(0.3);
    expect(t.fraction(500)).toBeCloseTo(0.5);
    t.ping(ping('water', 3, 4), 700);
    t.ping(ping('features', 4, 4), 800);
    expect(t.fraction(800)).toBeCloseTo(0.8);
    expect(t.step).toBe('features');
  });

  it('一步比估的久：走到这一步估的九成就停着等，不自己走到头；真的做完时按真实的耗时接着走', () => {
    const t = new ProgressTrack(plan, 0);
    t.ping(ping('elevation'), 0);
    // 估 300，到 270 为止
    expect(t.fraction(270)).toBeCloseTo(0.27);
    expect(t.fraction(2000)).toBeCloseTo(0.27);
    expect(t.fraction(60000)).toBeCloseTo(0.27);
    // 实际用了 3000：已经过去 3000，剩下估 700
    t.ping(ping('climate'), 3000);
    expect(t.fraction(3000)).toBeCloseTo(3000 / 3700);
  });

  it('一步比估的快：边界上往前跳，不倒退', () => {
    const t = new ProgressTrack(plan, 0);
    t.ping(ping('elevation'), 0);
    const a = t.fraction(30);
    t.ping(ping('climate'), 30);
    const b = t.fraction(30);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeCloseTo(30 / 730);
  });

  it('任何情况下都不倒退、做完之前不到头：估错了、多出没料到的步、少了几步', () => {
    const t = new ProgressTrack(plan, 0, () => 500);
    let last = 0;
    let now = 0;
    const check = () => {
      const f = t.fraction(now);
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f).toBeLessThanOrEqual(0.99);
      last = f;
    };
    const script: [string, number][] = [
      ['elevation', 900],
      ['surprise', 50],
      ['climate', 10],
      ['another', 2000],
      ['features', 5000],
      ['features', 100],
      ['tail', 400],
    ];
    for (const [step, ms] of script) {
      t.ping(ping(step), now);
      for (let k = 0; k < 20; k++) {
        now += ms / 20;
        check();
      }
    }
    expect(last).toBeGreaterThan(0.5);
  });

  it('期望里中间没走的几步跳过（只从气候算起的重算）；后面的照样对得上', () => {
    const t = new ProgressTrack(plan, 0);
    t.ping(ping('climate'), 0);
    // 高程那一步不算在剩下的里面：气候 400 + 水 100 + 地物 200
    expect(t.fraction(200)).toBeCloseTo(200 / 700);
  });

  it('数得出来的一步（重放命令）：按数出来的快慢算，不靠估', () => {
    const t = new ProgressTrack(
      [
        ['mesh', 100],
        ['replay', 99999],
        ['show', 100],
      ],
      0,
    );
    t.ping(ping('mesh'), 0);
    t.ping(ping('replay', 0, 200), 100);
    expect(t.count).toBeNull();
    t.ping(ping('replay', 50, 200), 600);
    expect(t.count).toEqual({ k: 50, n: 200 });
    // 500 毫秒做了 50 条：一共要 2000；已经过去 600，后面还有 1500 + 100
    expect(t.fraction(600)).toBeCloseTo(600 / 2200);
    // 重放里面的小步只换名字，不动位置
    t.ping(ping('climate', 2, 5, true), 700);
    expect(t.step).toBe('climate');
    expect(t.count).toEqual({ k: 50, n: 200 });
    t.ping(ping('replay', 200, 200), 2100);
    expect(t.step).toBe('replay');
    expect(t.fraction(2100)).toBeCloseTo(2100 / 2200);
  });

  it('做完了：真实走过的各步（重放只记成一步，里面的小步不记）', () => {
    const t = new ProgressTrack([], 0);
    t.ping(ping('mesh'), 10);
    t.ping(ping('replay', 0, 3), 110);
    t.ping(ping('elevation', 1, 5, true), 120);
    t.ping(ping('replay', 3, 3), 400);
    t.ping(ping('show'), 500);
    expect(t.finish(650)).toEqual([
      ['mesh', 100],
      ['replay', 390],
      ['show', 150],
    ]);
  });

  it('没有期望、也没说过哪一步：一直是 0（不编一个进度）', () => {
    const t = new ProgressTrack([], 0);
    expect(t.fraction(5000)).toBe(0);
    expect(t.step).toBeNull();
  });
});

describe('这是哪一类请求、默认会走哪几步', () => {
  const settings = { cells: 40000 };
  const human: Command = { op: 'generate_human', packs: [['medieval']], groups: ['germanic'], countries: {}, settlements: {} };
  const init: Request = { kind: 'init', settings, commands: [{ op: 'batch', commands: [{ op: 'set_planet', patch: { humidity: 1 } }, { op: 'set_worldgen', params: { seed: 1, type: 'continents' }, reset: true }] }, human, { op: 'generate_provinces', seed: 1 }] };

  it('键：做的是什么（批量按最后一条）、哪种地图、多少格', () => {
    expect(jobKey(init, 40000, false)).toBe('init:batch:set_worldgen+generate_human+generate_provinces|region|40000');
    expect(jobKey({ kind: 'exec', cmd: { op: 'regenerate_countries' } }, 62600, true)).toBe('exec:regenerate_countries|globe|62600');
    expect(jobKey({ kind: 'undo' }, 5000, false)).toBe('undo|region|5000');
    expect(jobKey({ kind: 'load', doc: { format: 'map2-world', version: 22, settings: settings as never, commands: [] } }, 5000, false)).toBe('load|region|5000');
  });

  it('新建：建网格、造陆地、流水线、生成人文的各步、城市、省份、画出来；每一步都有默认的耗时', () => {
    const p = defaultProfile(init, 40000, false);
    expect(p.map((x) => x[0])).toEqual([
      'mesh',
      'terrain',
      'elevation',
      'climate',
      'water',
      'habitat',
      'features',
      'human.cultures',
      'human.population',
      'human.countries',
      'human.claims',
      'human.blocs',
      'human.capitals',
      'human.country-mix',
      'settlements',
      'provinces',
      'show',
    ]);
    for (const [step, ms] of p) expect(ms, step).toBeGreaterThan(0);
  });

  it('别的：重新生成国家是生成人文的几步；平常的一步是流水线；打开是建网格、重放、流水线、画出来', () => {
    expect(defaultProfile({ kind: 'exec', cmd: { op: 'batch', commands: [{ op: 'set_planet', patch: { humidity: 1 } }, { op: 'regenerate_countries' }] } }, 40000, false).map((x) => x[0])).toContain('human.countries');
    expect(defaultProfile({ kind: 'exec', cmd: { op: 'set_planet', patch: { humidity: 1 } } }, 40000, false).map((x) => x[0])).toEqual(['elevation', 'climate', 'water', 'habitat', 'features']);
    expect(defaultProfile({ kind: 'load', doc: { format: 'map2-world', version: 22, settings: settings as never, commands: [] } }, 40000, false).map((x) => x[0])).toEqual(['mesh', 'replay', 'elevation', 'climate', 'water', 'habitat', 'features', 'show']);
  });

  it('默认的耗时按格数折算；地区、星球各一份', () => {
    expect(defaultMs('climate', REF_CELLS.region, false)).toBe(DEFAULT_STEP_MS.climate[0]);
    expect(defaultMs('climate', REF_CELLS.region * 2, false)).toBe(DEFAULT_STEP_MS.climate[0] * 2);
    expect(defaultMs('climate', REF_CELLS.globe, true)).toBe(DEFAULT_STEP_MS.climate[1]);
    expect(defaultMs('没有的步', 40000, false)).toBe(0);
  });

  it('界面上有人话的步都有默认的耗时（除了重放：它按数的）', () => {
    for (const step of Object.keys(PROGRESS_TEXT.steps)) expect(DEFAULT_STEP_MS[step], step).toBeDefined();
    for (const step of Object.keys(DEFAULT_STEP_MS)) if (step !== 'replay' && step !== 'restore') expect(PROGRESS_TEXT.steps[step], step).toBeDefined();
  });

  it('1 秒以后才显示', () => {
    expect(SHOW_AFTER_MS).toBe(1000);
  });
});

describe('记着每一类请求上一次真实的耗时', () => {
  function storage() {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }

  it('记下、读回；存在浏览器里，下次打开页面还在', () => {
    const s = storage();
    const a = new ProgressBook(s);
    expect(a.get('x')).toBeNull();
    a.put('x', plan);
    expect(a.get('x')).toEqual(plan);
    expect(new ProgressBook(s).get('x')).toEqual(plan);
  });

  it('最多记 24 类，最久没用的先丢', () => {
    const s = storage();
    const a = new ProgressBook(s);
    for (let k = 0; k < 30; k++) a.put(`k${k}`, [['a', k]]);
    a.put('k10', [['a', 1]]);
    const b = new ProgressBook(s);
    expect(b.get('k5')).toBeNull();
    expect(b.get('k6')).toEqual([['a', 6]]);
    expect(b.get('k10')).toEqual([['a', 1]]);
    // 再记一类：最久没用的 k6 丢掉，刚用过的 k10 还在
    b.put('新的', [['a', 2]]);
    expect(b.get('k6')).toBeNull();
    expect(b.get('k10')).toEqual([['a', 1]]);
    expect(JSON.parse(s.m.get(PROGRESS_KEY)!).length).toBe(24);
  });

  it('存的不成样子、读不了、写不了：当没有，不出错', () => {
    const s = storage();
    s.m.set(PROGRESS_KEY, '{"不是": "列表"}');
    expect(new ProgressBook(s).get('x')).toBeNull();
    s.m.set(PROGRESS_KEY, JSON.stringify([['x', [['a', '不是数']]], ['y', [['b', 5]]], 7]));
    const b = new ProgressBook(s);
    expect(b.get('x')).toBeNull();
    expect(b.get('y')).toEqual([['b', 5]]);
    const broken = new ProgressBook({
      getItem: () => {
        throw new Error('不让读');
      },
      setItem: () => {
        throw new Error('满了');
      },
    });
    broken.put('x', plan);
    expect(broken.get('x')).toEqual(plan);
    expect(new ProgressBook(null).get('x')).toBeNull();
  });
});
