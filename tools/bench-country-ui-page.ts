// 国家界面的测速（第八十轮）的页面那一半：tools/bench-country-ui.mjs 把它和两份界面（旧的提交的、现在的）打包成一个 file:// 页面，
// 在无头 Chrome 里跑。两边各挂一份地图（MapView，WebGL 照常画）、底部条、图例、“这里”、右边的抽屉（国家的档案），世界相同。
// 世界：种子 3 的一块地区（4 万格）与类地星球，中世纪的人文，时代的国家大小 ÷ 8（第七十七轮的“很分裂”）：几百个国家，再生成城市。
// 计算 Worker 的那一半在页面里：引擎（现在的 core）执行命令，按 src/worker-snapshot.ts 做快照、结构化克隆（转交数组）后交给
// 那一边的 worker-host 的 handle（与收到 Worker 的回复相同）；第八十轮以前的一边不认得“原因数组没变”，给它的快照里原因数组都是新的副本
// （与那时的 Worker 发的一样）。量的都是主线程上的时间：从写信号（或收到回复）起，Preact 重画、地图画下一帧（requestAnimationFrame
// 接过来当场跑，WebGL 的命令发出去为止，不等显卡），直到没有要画的。
//   改名：档案里改选中的国家的名字（set_country）→ 回复到了、地图与界面画完；
//   领土笔刷移动一下：鼠标在陆地上移动（不按着），笔刷的圈、要涂的格、鼠标旁的话；
//   换档案的页：概览 → 政治 → 人口与城市 → 关系 → 历史 → 概览；
//   选国家：档案开在概览、关系两页时一国接一国地选。
// 结果写进 <pre id="o">，最后一行 DONE
import { options } from 'preact';
import { h, render } from 'preact';
import type { Engine } from '../core/engine';
import { Engine as EngineClass } from '../core/engine';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';
import { PLANET_SIZES, planetCells } from '../core/presets';
import { eraCommand, fragKm2 } from '../core/testing/fixtures';
import type { World } from '../core/world';
import { SnapshotSender } from '../src/worker-snapshot';

type Sig<T> = { value: T };
export interface Side {
  name: string;
  // 认得“原因数组没变”（第八十轮起）
  reuse: boolean;
  S: { world: Sig<World | null>; selectedCountry: Sig<number | null>; sheet: Sig<unknown>; mode: Sig<string>; switchTool: (id: string) => void };
  H: { handle: (r: unknown, fresh?: boolean) => Promise<boolean> };
  N: { noteChange: (head: string, before: World | null) => void };
  M: { MapView: () => unknown };
  A: { CountryArchive: () => unknown };
  CA: { countryTab: Sig<string>; COUNTRY_TABS: [string, string][] };
  T: { selectCountry: (id: number | null, open?: boolean) => void };
  Shell: { ContextBar: () => unknown; MapLegend: () => unknown; HereCard: () => unknown; Sheet: () => unknown };
}

const out: string[] = [];
const log = (s: string) => {
  out.push(s);
  (document.getElementById('o') as HTMLElement).textContent = out.join('\n');
};
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const f1 = (v: number) => v.toFixed(v < 10 ? 2 : 1);

// ---------- 把异步的重画接过来当场跑 ----------
const rafQ: (FrameRequestCallback | null)[] = [];
window.requestAnimationFrame = (cb) => rafQ.push(cb);
window.cancelAnimationFrame = (id) => {
  if (id > 0 && id <= rafQ.length) rafQ[id - 1] = null;
};
let rafBase = 0;
const preactQ: (() => void)[] = [];
options.debounceRendering = (cb) => void preactQ.push(cb);
// hooks 的 useEffect 本来在下一帧之后的 setTimeout 里跑：也接过来
(options as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame = (cb) => void rafQ.push(cb);
// 没有要跑的为止：Preact 的重画、requestAnimationFrame（地图的一帧、hooks 的 effect）
function flush() {
  for (let guard = 0; guard < 50; guard++) {
    let any = false;
    while (preactQ.length) {
      any = true;
      preactQ.shift()!();
    }
    if (rafQ.length > rafBase) {
      any = true;
      const from = rafBase;
      const to = rafQ.length;
      rafBase = to;
      const t = performance.now();
      for (let i = from; i < to; i++) rafQ[i]?.(t);
    }
    if (!any) return;
  }
}

// 全部同步地跑完（页面的 load 里）：--dump-dom 等 load 跑完再取页面
export function run(a: Side, b: Side, opt: { quick: boolean; globe?: boolean }) {
  try {
    main(a, b, opt);
    log('DONE');
  } catch (e) {
    log(`ERROR ${(e as Error).stack ?? e}`);
  }
}

// 中世纪包默认的前三个文化组（同 tools/r40-world.ts）
const medievalGroups = () => ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => n.id);

// 种子 3，中世纪，时代的国家大小 ÷ 8（几百个国家），城市
function makeEngine(globe: boolean, cells: number): Engine {
  const eng = globe
    ? new EngineClass({ seed: 3, cells, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 })
    : new EngineClass({ seed: 3, cells });
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  eng.exec({ op: 'generate_provinces', seed: 3 });
  for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']], groups: medievalGroups() }, eng.world)) eng.exec(c);
  eng.exec(eraCommand(eng.world, { countryKm2: fragKm2('medieval', 1) }, [['medieval']]));
  eng.exec({ op: 'generate_human', packs: [['medieval']], groups: medievalGroups(), countries: { seed: 3 } });
  eng.exec({ op: 'generate_settlements' });
  eng.update();
  return eng;
}

// 一边的“Worker”：快照按 worker-snapshot.ts 做；第八十轮以前的一边原因数组都给新的副本
function makeSender(side: Side) {
  const sender = new SnapshotSender(performance.timeOrigin + side.name.length);
  return (eng: Engine, summary: string, fresh = false) => {
    const { snap, transfer } = sender.full(eng, fresh);
    if (!side.reuse && snap.same) {
      const c = snap.causes as unknown as Record<string, unknown>;
      const cs = eng.world.causes as unknown as Record<string, ArrayBufferView>;
      for (const k of snap.same.causes ?? []) {
        const v = (cs[k] as unknown as { slice: () => ArrayBufferView }).slice();
        c[k] = v;
        transfer.push(v.buffer as ArrayBuffer);
      }
      for (const k of snap.same.fields ?? []) {
        const v = eng.world.causes.fields[k].slice();
        snap.causes.fields[k] = v;
        transfer.push(v.buffer as ArrayBuffer);
      }
      delete snap.same.causes;
      delete snap.same.fields;
      // 地物、小数据的各段、国家：那时都整份发（结构化克隆出新的对象）
      for (const k of snap.same.objects ?? []) (snap.derived as unknown as Record<string, unknown>)[k] = (eng.world.derived as unknown as Record<string, unknown>)[k];
      delete snap.same.objects;
    }
    if (!side.reuse) {
      const small = snap.small as unknown as Record<string, unknown>;
      const live = eng.world.small as unknown as Record<string, unknown>;
      for (const k of snap.sameSmall ?? []) small[k] = live[k];
      if (snap.sameCountries) small.countries = live.countries;
      delete snap.sameSmall;
      delete snap.sameCountries;
      delete snap.secBase;
    }
    // 结构化克隆（与 postMessage 相同：数组转交）：主线程拿到的是新的对象
    return structuredClone({ id: 1, ok: true, summary, snapshot: snap }, { transfer });
  };
}

interface Mounted {
  side: Side;
  host: HTMLElement;
  send: ReturnType<typeof makeSender>;
  map: { renderer: { worldToScreen: (x: number, y: number) => [number, number] } };
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
}

function mount(side: Side, eng: Engine): Mounted {
  const send = makeSender(side);
  void side.H.handle(send(eng, '新世界', true), true);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:1400px;height:900px;overflow:hidden';
  document.body.appendChild(host);
  const { ContextBar, MapLegend, HereCard, Sheet } = side.Shell;
  render(
    h('div', { class: 'app with-sheet' }, h(side.M.MapView as never, null), h(ContextBar as never, null), h(MapLegend as never, null), h(HereCard as never, null), h(Sheet as never, null)),
    host,
  );
  flush();
  const map = (window as unknown as { __map2: Mounted['map'] }).__map2;
  const canvas = host.querySelector('canvas.map-overlay') as HTMLCanvasElement;
  const gl = (host.querySelector('canvas.map-gl') as HTMLCanvasElement).getContext('webgl2')!;
  return { side, host, send, map, gl, canvas };
}

// 等显卡画完（不算进时间）：下一项从空闲的显卡开始
const settle = (m: Mounted) => {
  flush();
  m.gl.finish();
};

// 两边交替、每轮换一边先：fn 返回这一次的毫秒数
function alternate(section: string, ms: Mounted[], n: number, fn: (m: Mounted, i: number) => number): number[][] {
  const res = ms.map(() => [] as number[]);
  for (let i = 0; i < n; i++) {
    const order = i % 2 ? [1, 0] : [0, 1];
    for (const k of order) {
      res[k].push(prof(section, k, () => fn(ms[k], i)));
      settle(ms[k]);
    }
  }
  return res;
}

// 剖析（开发用）：网址带 #rename、#brush、#tab、#pick 时，新的一边的那一项每次包在 console.profile 里（CDP 的 Profiler 收）
const PROF = typeof location !== 'undefined' ? location.hash.slice(1) : '';
let profN = 0;
function prof<T>(section: string, k: number, fn: () => T): T {
  if (PROF !== section || k !== 1) return fn();
  const name = `p${profN++}`;
  console.profile(name);
  try {
    return fn();
  } finally {
    console.profileEnd(name);
  }
}

const row = (label: string, r: number[][]) => `${label}：${f1(median(r[0]))} → ${f1(median(r[1]))}（最长 ${f1(Math.max(...r[0]))} → ${f1(Math.max(...r[1]))}）`;

function main(a: Side, b: Side, opt: { quick: boolean; globe?: boolean }) {
  const N = opt.quick ? 5 : 11;
  log(`${a.name} → ${b.name}，每项 ${N} 次的中位数（毫秒，主线程）`);
  const worlds: [string, boolean, number][] = opt.globe ? [] : [['一块地区（4 万格）', false, 40000]];
  if (!opt.quick || opt.globe) worlds.push(['类地星球', true, planetCells(PLANET_SIZES.earth.radiusKm)]);
  for (const [wname, globe, cells] of worlds) {
    const t0 = performance.now();
    const eng = makeEngine(globe, cells);
    const w0 = eng.world;
    const ids = Object.values(w0.small.countries ?? {})
      .sort((x, y) => x.id - y.id)
      .map((m) => m.id);
    log(`\n${wname}：${w0.mesh.n} 格，${ids.length} 国，${Object.keys(w0.small.cities ?? {}).length} 座城市（生成 ${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
    // 最大的一国（按领土的格数）：选中它，笔刷涂给它
    const count = new Map<number, number>();
    for (let i = 0; i < w0.mesh.n; i++) if (w0.causes.land[i] && w0.causes.country![i] >= 0) count.set(w0.causes.country![i], (count.get(w0.causes.country![i]) ?? 0) + 1);
    const big = [...count].sort((x, y) => y[1] - x[1])[0][0];
    const ms = [a, b].map((s) => mount(s, eng));
    for (const m of ms) {
      m.side.S.mode.value = 'country';
      m.side.S.switchTool('territory');
      m.side.T.selectCountry(big);
      m.side.CA.countryTab.value = 'overview';
      settle(m);
    }

    // 改名（先各改一次不算：第一次画国家模式要编译着色器）
    const rename: number[][] = [[], []];
    for (let i = -1; i < N; i++) {
      eng.exec({ op: 'set_country', id: big, patch: { name: `测速之国${i}` } });
      const order = i % 2 ? [1, 0] : [0, 1];
      const replies = ms.map((m) => m.send(eng, `改名 ${i}`));
      for (const k of order) {
        const m = ms[k];
        const t = performance.now();
        prof(i >= 0 ? 'rename' : '', k, () => {
          const before = m.side.S.world.value;
          void m.side.H.handle(replies[k]);
          m.side.N.noteChange(`改名 ${i}`, before);
          flush();
        });
        if (i >= 0) rename[k].push(performance.now() - t);
        settle(m);
      }
    }
    log(row('改名 → 画完下一帧', rename));

    // 领土笔刷移动：沿着最大一国的陆地格走
    const land: number[] = [];
    for (let i = 0; i < w0.mesh.n && land.length < 4000; i++) if (w0.causes.country![i] === big && w0.causes.land[i]) land.push(i);
    const brush = alternate('brush', ms, N * 2, (m, i) => {
      const w = m.side.S.world.value!;
      const c = land[Math.floor(((i + 1) * land.length) / (N * 2 + 2))];
      const [sx, sy] = m.map.renderer.worldToScreen(w.mesh.x[c], w.mesh.y[c]);
      const r = m.canvas.getBoundingClientRect();
      const t = performance.now();
      m.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, pointerId: 1 }));
      flush();
      return performance.now() - t;
    });
    log(row('领土笔刷移动一下', brush));
    for (const m of ms) {
      const S = m.side.S as unknown as { tool: Sig<string>; cursorHint: Sig<{ text: string } | null> };
      log(`  （${m.side.name}：工具 ${S.tool.value}，鼠标旁 ${S.cursorHint.value?.text ?? '无'}）`);
    }
    log(`  改名每次：${rename.map((r) => r.map(f1).join(' ')).join(' / ')}`);
    for (const m of ms) {
      m.canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerId: 1 }));
      settle(m);
    }

    // 换档案的页
    const tabs = a.CA.COUNTRY_TABS.map(([t]) => t);
    const per = new Map<string, number[][]>(tabs.map((t) => [t, [[], []]]));
    for (let i = 0; i < N; i++) {
      for (const t of [...tabs.slice(1), tabs[0]]) {
        const order = i % 2 ? [1, 0] : [0, 1];
        for (const k of order) {
          const m = ms[k];
          const tt = performance.now();
          prof(`tab-${t}`, k, () => {
            m.side.CA.countryTab.value = t;
            flush();
          });
          per.get(t)![k].push(performance.now() - tt);
          settle(m);
        }
      }
    }
    for (const [t, label] of a.CA.COUNTRY_TABS) log(row(`换到档案的“${label}”`, per.get(t)!));

    // 选国家：档案开在概览、关系两页
    for (const tab of ['overview', 'relations']) {
      for (const m of ms) {
        m.side.CA.countryTab.value = tab;
        settle(m);
      }
      const pick = alternate(`pick-${tab}`, ms, N, (m, i) => {
        const id = ids[(i * 7919 + 13) % ids.length];
        const t = performance.now();
        m.side.T.selectCountry(id === m.side.S.selectedCountry.value ? ids[(i + 1) % ids.length] : id);
        flush();
        return performance.now() - t;
      });
      log(row(`选国家（档案在“${a.CA.COUNTRY_TABS.find(([x]) => x === tab)![1]}”）`, pick));
    }
    for (const m of ms) {
      render(null, m.host);
      m.host.remove();
    }
    flush();
  }
}
