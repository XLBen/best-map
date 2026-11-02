// 叠加层与排版的前后对照（第四十轮）的页面那一半：tools/overlay-ab.mjs 把它和两份叠加层（旧的提交的、现在的）、两份国家的档案与列表
// 打包成一个 file:// 页面，在无头 Chrome 里跑。世界：种子 3 的一块地区（4 万格）与类地星球（同 tools/bench-layers.ts，另生成城市、
// 道路、地标），按 MapView 的选项排地貌、国家两种模式，镜头看全图与一格约 8 像素。
//   整张重画：每次挪一点镜头（两边都要重排地名、重画全部）；
//   鼠标移动：选项、图形都没变（旧的照样整张画，新的什么都不画）；
//   画笔移动：只有图形变了（旧的整张画，新的贴两张离屏画布、画图形）；
//   排地名：只排（placeLabels，每次挪一点镜头）；
//   像素：新的直接画与旧的逐字节比；只有图形变了的那一帧（贴缓存）与旧的比，报不同的像素数与最大差；
//   选国家：国家的档案与列表（Preact）里一国接一国地选，量从写信号到画完（下一个宏任务之前）的时间。
// 结果写进 <pre id="o">，最后一行 DONE
import { h, options, render } from 'preact';
import { worldMapStyle } from '../core/map-style';
import { PLANET_SIZES, planetCells } from '../core/presets';
import type { World } from '../core/world';
import { modeDef, modeFeatures } from '../src/ui/map/modes';
import { regionDraws } from '../src/ui/map/political';
import { settleOverlay } from '../src/ui/map/settle';
import { r40Engine } from './r40-world';

type OverlayMod = typeof import('../src/render/overlay');
interface Side {
  O: OverlayMod;
  A: { CountryArchive: () => unknown };
  L: { CountryList: (p: { w: World }) => unknown };
  S: { world: { value: World | null }; selectedCountry: { value: number | null }; sheet: { value: unknown } };
  T: { selectCountry: (id: number | null, open?: boolean) => void };
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

const CW = 1200;
const CH = 800;
function canvas(read = false): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.style.cssText = `position:fixed;left:0;top:0;width:${CW}px;height:${CH}px`;
  document.body.appendChild(c);
  return c.getContext('2d', read ? { willReadFrequently: true } : undefined)!;
}

// 全部同步地跑完（页面的 load 里）：--dump-dom 等 load 跑完再取页面；不用虚拟时间（那时 performance.now 不准）
export function run(oldS: Side, newS: Side, opt: { quick: boolean }) {
  try {
    main(oldS, newS, opt);
    log('DONE');
  } catch (e) {
    log(`ERROR ${(e as Error).stack ?? e}`);
  }
}

function main(oldS: Side, newS: Side, opt: { quick: boolean }) {
  const N = opt.quick ? 7 : 15;
  log(`devicePixelRatio ${devicePixelRatio}，画布 ${CW} × ${CH} CSS 像素，每项 ${N} 次的中位数（毫秒）`);
  const worlds: [string, () => World][] = [['一块地区（4 万格）', () => r40Engine(false, 40000).world]];
  if (!opt.quick) worlds.push(['类地星球', () => r40Engine(true, planetCells(PLANET_SIZES.earth.radiusKm)).world]);
  let differ = 0;
  for (const [wname, make] of worlds) {
    const t0 = performance.now();
    const w = make();
    log(`\n${wname}：${w.mesh.n} 格，${Object.keys(w.small.countries ?? {}).length} 国，${Object.keys(w.small.cities ?? {}).length} 座城市（生成 ${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
    const paths = newS.O.buildPaths(w);
    const style = worldMapStyle(w.small);
    for (const kind of ['geo', 'country'] as const) {
      const md = modeDef(kind);
      const st = {
        rivers: false,
        wind: false,
        markers: false,
        flowSeason: 'annual' as const,
        style,
        shapes: [],
        provinceLabels: [],
        features: modeFeatures(w.derived.features, md.features),
        labelTypes: null,
        nameMode: 'zh' as const,
        peaks: null,
        countries: md.regions ? regionDraws(w, md.regions, 'zh') : null,
        ...settleOverlay(w, { mode: md, editing: false }),
        kmPerUnit: w.kmPerUnit,
        hoverLabel: null,
        scaleBar: true,
        cornerLift: 0,
        latitude: null,
      };
      const sp = w.mesh.spacing;
      const sphere = w.mesh.kind === 'sphere';
      const cams = [
        ['看全图', { x: sphere ? 1 : w.mesh.width / 2, y: sphere ? 0.5 : w.mesh.height / 2, zoom: CW / (sphere ? 2.2 : w.mesh.width * 1.05) }],
        ['一格约 8 像素', { x: sphere ? 0.9 : w.mesh.width * 0.45, y: sphere ? 0.4 : w.mesh.height * 0.5, zoom: 8 / sp }],
      ] as const;
      for (const [cname, cam0] of cams) {
        const label = `${kind === 'geo' ? '地貌' : '国家'} · ${cname}`;
        // 三种情形各量 N 次。soft：画布按软件画（willReadFrequently），每次画完读回一个像素——连光栅化一起量（同第十三轮的 overlayBench）；
        // 否则画布按显卡画、不等光栅化，只量主线程上的
        const measure = (soft: boolean) => {
          // 软件画时离屏画布也按软件画（同 overlayBench；显卡画的离屏画布贴到软件画的画布上要先读回来，量出来的不是真的）
          oldS.O.overlayDebug.softLayers = soft;
          newS.O.overlayDebug.softLayers = soft;
          const co = canvas(soft);
          const cn = canvas(soft);
          const time = (side: Side, ctx: CanvasRenderingContext2D, cam: object, s: object) => {
            const t = performance.now();
            side.O.drawOverlay(ctx, w, paths, cam as never, s as never);
            if (soft) ctx.getImageData(0, 0, 1, 1);
            return performance.now() - t;
          };
          // 整张重画：每次挪一点镜头
          const full = { o: [] as number[], n: [] as number[] };
          for (let i = 0; i < N + 1; i++) {
            const cam = { ...cam0, x: cam0.x + ((i % 3) - 1) * 1e-7 };
            const a = time(oldS, co, cam, st);
            const b = time(newS, cn, cam, st);
            if (i) (full.o.push(a), full.n.push(b));
          }
          // 鼠标移动（什么都没变）与画笔移动（只有图形变了）
          const still = { o: [] as number[], n: [] as number[] };
          const brush = { o: [] as number[], n: [] as number[] };
          time(oldS, co, cam0, st);
          time(newS, cn, cam0, st);
          time(newS, cn, cam0, st);
          for (let i = 0; i < N; i++) {
            still.o.push(time(oldS, co, cam0, st));
            still.n.push(time(newS, cn, cam0, st));
          }
          for (let i = 0; i < N; i++) {
            const shapes = [{ kind: 'circle', x: cam0.x + (i * 0.3 - 2) * sp, y: cam0.y, r: 3 * sp, dashed: true, geodesic: sphere }];
            brush.o.push(time(oldS, co, cam0, { ...st, shapes }));
            brush.n.push(time(newS, cn, cam0, { ...st, shapes }));
          }
          // 只读回一个像素（什么都不画）要多久：软件画时每一项里都有这一份
          const base: number[] = [];
          for (let i = 0; i < N && soft; i++) {
            const t = performance.now();
            cn.getImageData(0, 0, 1, 1);
            base.push(performance.now() - t);
          }
          co.canvas.remove();
          cn.canvas.remove();
          oldS.O.overlayDebug.softLayers = false;
          newS.O.overlayDebug.softLayers = false;
          const m = (x: { o: number[]; n: number[] }) => `${f1(median(x.o))} → ${f1(median(x.n))}`;
          return `整张重画 ${m(full)}；鼠标移动 ${m(still)}；画笔移动 ${m(brush)}${soft ? `（每项里含读回一个像素 ${f1(median(base))}）` : ''}`;
        };
        const main = measure(false);
        const soft = measure(true);
        const co = canvas();
        const cn = canvas();
        // 排地名
        const lay = { o: [] as number[], n: [] as number[] };
        const ks = sphere ? [-1, 0, 1] : [0];
        for (let i = 0; i < N + 1; i++) {
          const cam = { ...cam0, x: cam0.x + ((i % 3) - 1) * 1e-7 + 1e-6 };
          let t = performance.now();
          oldS.O.placeLabels(co, cam as never, st as never, ks, oldS.O.refZoom(w, cam.zoom));
          const a = performance.now() - t;
          t = performance.now();
          newS.O.placeLabels(cn, cam as never, st as never, ks, newS.O.refZoom(w, cam.zoom));
          const b = performance.now() - t;
          if (i) (lay.o.push(a), lay.n.push(b));
        }
        // 像素：直接画；只有图形变了的那一帧
        const px = (ctx: CanvasRenderingContext2D) => ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
        const da = canvas();
        const db = canvas();
        newS.O.overlayDebug.noStatic = true;
        oldS.O.drawOverlay(da, w, paths, cam0 as never, st as never);
        newS.O.drawOverlay(db, w, paths, cam0 as never, st as never);
        newS.O.overlayDebug.noStatic = false;
        const pa = px(da);
        const pb = px(db);
        let same = 0;
        for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) same++;
        differ += same;
        // 一串帧（直接画两帧、只有图形变了的三帧、图形没变的一帧（新的不画）、图形没了的一帧），每帧画完读回整张、与旧的逐字节比。
        // 按显卡画（同屏幕上的叠加层与离屏画布）与按软件画（离屏画布也按软件画）各一遍
        const sh = (x: number, r: number) => [{ kind: 'circle', x: cam0.x + x * sp, y: cam0.y, r: r * sp, dashed: true, geodesic: sphere }, { kind: 'line', points: [[cam0.x, cam0.y], [cam0.x + 6 * sp, cam0.y + 3 * sp]], color: 'rgba(255, 225, 77, 0.95)', width: 2 }];
        const seq = [st, st, { ...st, shapes: sh(1.5, 4) }, { ...st, shapes: sh(2.5, 4) }, { ...st, shapes: sh(2.5, 6) }, { ...st, shapes: sh(2.5, 6) }, st];
        const frameDiff: number[] = [];
        const notes: string[] = [];
        for (const softMode of [false, true]) {
          newS.O.overlayDebug.softLayers = softMode;
          const ea = canvas(softMode);
          const eb = canvas(softMode);
          let bytes = 0;
          const per: number[] = [];
          const hist: [Uint8ClampedArray, Uint8ClampedArray][] = [];
          for (const s of seq) {
            oldS.O.drawOverlay(ea, w, paths, cam0 as never, s as never);
            newS.O.drawOverlay(eb, w, paths, cam0 as never, s as never);
            const qa = px(ea);
            const qb = px(eb);
            hist.push([qa, qb]);
            let k = 0;
            for (let i = 0; i < qa.length; i++) if (qa[i] !== qb[i]) k++;
            per.push(k);
            bytes += k;
          }
          const d = (x: Uint8ClampedArray, y: Uint8ClampedArray) => x.reduce((n, v, i) => n + (v !== y[i] ? 1 : 0), 0);
          // 旧的自己：同样的输入（第二帧与最后一帧）重画一遍，读回来相不相同（按显卡画时 SwiftShader 上不一定相同）
          if (bytes) notes.push(`${softMode ? '软件' : '显卡'}：每帧 ${per.join(' ')}，旧的同样的输入重画一遍自己差 ${d(hist[6][0], hist[1][0])}`);
          frameDiff.push(bytes);
          ea.canvas.remove();
          eb.canvas.remove();
          newS.O.overlayDebug.softLayers = false;
        }
        differ += frameDiff[0] + frameDiff[1];
        for (const c of [co, cn, da, db]) c.canvas.remove();
        log(`${label}\n  主线程：${main}\n  连光栅化（软件画）：${soft}\n  排地名 ${f1(median(lay.o))} → ${f1(median(lay.n))}；直接画与旧的不同 ${same} 字节；一串帧（含只有图形变了、什么都不画的帧）与旧的不同 ${frameDiff[1]} 字节（按软件画）/ ${frameDiff[0]} 字节（按显卡画）${notes.length ? `（${notes.join('；')}）` : ''}`);
      }
    }
    if (Object.keys(w.small.countries ?? {}).length) selectBench(oldS, newS, w, N);
  }
  if (differ) log(`直接画与旧的不同 ${differ} 字节`);
}

// 选国家：档案（Preact）与列表；一国接一国地选。Preact 本来在微任务里重画（几次写信号合成一次）：这里把它要排的那一次接过来、
// 写完信号以后当场跑，量写信号 + 重画 + 排版
function selectBench(oldS: Side, newS: Side, w: World, N: number) {
  const ids = Object.keys(w.small.countries!)
    .map(Number)
    .slice(0, N + 1);
  const res: Record<string, number[]> = {};
  for (const [name, side] of [
    ['旧', oldS],
    ['新', newS],
  ] as const) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:800px;overflow:auto';
    document.body.appendChild(host);
    side.S.world.value = w;
    side.S.selectedCountry.value = ids[0];
    side.S.sheet.value = 'country';
    const queued: (() => void)[] = [];
    const prev = options.debounceRendering;
    options.debounceRendering = (cb) => void queued.push(cb);
    const flush = () => {
      while (queued.length) queued.shift()!();
    };
    render(h('div', null, h(side.A.CountryArchive as never, null), h(side.L.CountryList as never, { w })), host);
    flush();
    const ts: number[] = [];
    for (let k = 1; k < ids.length; k++) {
      const t = performance.now();
      side.T.selectCountry(ids[k]);
      flush();
      void host.offsetHeight;
      ts.push(performance.now() - t);
    }
    options.debounceRendering = prev;
    res[name] = ts;
    render(null, host);
    host.remove();
  }
  log(`选国家（档案 + 列表，一次 Preact 渲染 + 排版）：${f1(median(res['旧']))} → ${f1(median(res['新']))}（最长 ${f1(Math.max(...res['旧']))} → ${f1(Math.max(...res['新']))}）`);
}
