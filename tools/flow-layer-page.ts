// 风向、洋流两个图层（第四十八轮）的页面那一半：tools/flow-layer.mjs 把它打包成 file:// 页面，在无头 Chrome 里跑。两样：
//   帧时间：种子 3 的一块地区（4 万格）与类地星球，地貌、国家两种模式，关着 / 只开风 / 只开洋流 / 都开；按显卡画、只量主线程（屏幕上的画法），--soft 时软件画、读回一个像素（连光栅化一起量，软件光栅化比显卡慢得多）。
//     整张重画（镜头差一点点）、鼠标移动（什么都没变）、画笔移动（只有图形变了）、平移（移动中，每帧 6 像素）、转球（只有星球，球形投影）。
//   看不看得清：真的渲染器画底图（写实、地图册的地貌，国家、文化、人口、气温、降水、海拔、海水温度），上面按 render/wind.ts 的样式画流线，
//     线上的像素与同一处底图、与紧挨着线的像素比 CIELAB 色差 ΔE。
// 结果写进 <pre id="o">，最后一行 DONE；图片（--png）写进 <pre id="png-名字">
import type { Engine } from '../core/engine';
import { worldMapStyle } from '../core/map-style';
import { PLANET_SIZES, planetCells } from '../core/presets';
import type { World } from '../core/world';
import { cellLayers, provinceScale } from '../src/render/colors';
import { type OverlayState, buildPaths, drawOverlay, overlayDebug } from '../src/render/overlay';
import { setOverlayPerf } from '../src/render/overlay-base';
import { type Camera, Renderer } from '../src/render/renderer';
import { CURRENT_STYLE, type FlowStyle, WIND_STYLE, currentLines, flushWindQueue, strokeFlows, windLines } from '../src/render/wind';
import type { ViewMode } from '../src/state';
import { modeDef, modeFeatures } from '../src/ui/map/modes';
import { regionDraws } from '../src/ui/map/political';
import { settleOverlay } from '../src/ui/map/settle';
import { r40Engine } from './r40-world';

const out: string[] = [];
const log = (s: string) => {
  out.push(s);
  (document.getElementById('o') as HTMLElement).textContent = out.join('\n');
};
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const f1 = (v: number) => v.toFixed(v < 10 ? 2 : 1);
const stat = (a: number[]) => `${f1(q(a, 0.5))} / ${f1(q(a, 0.95))} / ${f1(q(a, 1))}`;

const CW = 1200;
const CH = 800;
function canvas2d(soft: boolean): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = CW * devicePixelRatio;
  c.height = CH * devicePixelRatio;
  c.style.cssText = `position:fixed;left:0;top:0;width:${CW}px;height:${CH}px`;
  document.body.appendChild(c);
  return c.getContext('2d', soft ? { willReadFrequently: true } : undefined)!;
}

const LAYERS: [string, boolean, boolean][] = [
  ['关着', false, false],
  ['只开风', true, false],
  ['只开洋流', false, true],
  ['都开', true, true],
];

function stateFor(w: World, kind: 'geo' | 'country', wind: boolean, currents: boolean): OverlayState {
  const md = modeDef(kind);
  return {
    rivers: false,
    wind,
    currents,
    markers: false,
    flowSeason: 'summer',
    style: worldMapStyle(w.small),
    shapes: [],
    provinceLabels: [],
    features: modeFeatures(w.derived.features, md.features),
    labelTypes: null,
    nameMode: 'zh',
    peaks: null,
    countries: md.regions ? regionDraws(w, md.regions, 'zh') : null,
    ...settleOverlay(w, { mode: md, editing: false }),
    kmPerUnit: w.kmPerUnit,
    hoverLabel: null,
    scaleBar: true,
    cornerLift: 0,
    latitude: null,
    lazy: () => {},
  } as OverlayState;
}

function frameTimes(w: World, label: string, N: number, soft: boolean) {
  const paths = buildPaths(w);
  const sp = w.mesh.spacing;
  const sphere = w.mesh.kind === 'sphere';
  const cam0: Camera = { x: sphere ? 1 : w.mesh.width / 2, y: sphere ? 0.5 : w.mesh.height / 2, zoom: CW / (sphere ? 2.2 : w.mesh.width * 1.05) };
  // 先当场算好看得见的块（第一次算的时间单独写）
  const t0 = performance.now();
  windLines(w, cam0, 'summer', { cw: CW, ch: CH });
  const t1 = performance.now();
  currentLines(w, cam0, { cw: CW, ch: CH });
  const t2 = performance.now();
  log(`${label}（${soft ? '软件画、读回一个像素，连光栅化' : '按显卡画、不等光栅化，主线程上的'}）：看全图时第一次算块（屏幕上分在空闲时做，每段约 6 ms）：风 ${f1(t1 - t0)} ms，洋流 ${f1(t2 - t1)} ms。下面每项是 中位 / p95 / 最大（ms），〔〕里是其中画流线的`);
  overlayDebug.softLayers = soft;
  // 画流线的时间：叠加层记的 flows
  let flows = 0;
  setOverlayPerf({ cpu: (k: string, ms: number) => void (k === 'flows' && (flows += ms)), note: () => {} } as never);
  for (const kind of ['geo', 'country'] as const) {
    if (kind === 'country' && !w.small.countries) continue;
    for (const [name, wind, currents] of LAYERS) {
      const st = stateFor(w, kind, wind, currents);
      const ctx = canvas2d(soft);
      const time = (cam: Camera, s: OverlayState, list?: number[], fl?: number[]) => {
        flows = 0;
        const t = performance.now();
        drawOverlay(ctx, w, paths, cam, s);
        if (soft) ctx.getImageData(0, 0, 1, 1);
        const v = performance.now() - t;
        list?.push(v);
        fl?.push(flows);
      };
      const row = (a: number[], b: number[]) => `${stat(a)}${wind || currents ? `〔${stat(b)}〕` : ''}`;
      time(cam0, st);
      flushWindQueue();
      // 整张重画：镜头差一点点，位图也重画（放大缩小、换了块以后停下来的那一帧）
      const full: number[] = [];
      const fullF: number[] = [];
      for (let i = 0; i < N; i++) time({ ...cam0, x: cam0.x + (((i + 1) % 3) - 1) * 1e-7 + 1e-9 * i }, st, full, fullF);
      time(cam0, st);
      time(cam0, st);
      const still: number[] = [];
      const stillF: number[] = [];
      for (let i = 0; i < N; i++) time(cam0, st, still, stillF);
      const brush: number[] = [];
      const brushF: number[] = [];
      for (let i = 0; i < N; i++) time(cam0, { ...st, shapes: [{ kind: 'circle', x: cam0.x + (i * 0.3 - 2) * sp, y: cam0.y, r: 3 * sp, dashed: true, geodesic: sphere }] }, brush, brushF);
      // 平移：移动中，每帧 6 像素（一路挪过约 0.75 个画面，中间挪出边距要重画位图）
      const pan: number[] = [];
      const panF: number[] = [];
      const moving = { ...st, motion: true, motionEpoch: 1 };
      const panCam = (k: number): Camera => ({ ...cam0, zoom: cam0.zoom * 2, x: cam0.x + (6 * k) / (cam0.zoom * 2) });
      time(panCam(0), moving);
      flushWindQueue();
      for (let k = 1; k <= N * 10; k++) time(panCam(k), moving, pan, panF);
      flushWindQueue();
      const turn: number[] = [];
      const turnF: number[] = [];
      if (sphere) {
        const ball = (k: number): Camera => ({ x: 1, y: 0.5, zoom: 600, proj: { kind: 'globe', lon0: 0.3 + k * 0.01, lat0: 0.2 } });
        time(ball(0), moving);
        flushWindQueue();
        for (let k = 1; k <= N * 4; k++) time(ball(k), moving, turn, turnF);
        flushWindQueue();
      }
      ctx.canvas.remove();
      log(`  ${kind === 'geo' ? '地貌' : '国家'} · ${name}：整张重画 ${row(full, fullF)}；鼠标移动 ${row(still, stillF)}；画笔移动 ${row(brush, brushF)}；平移 ${row(pan, panF)}${turn.length ? `；转球 ${row(turn, turnF)}` : ''}`);
    }
  }
  setOverlayPerf(null);
  overlayDebug.softLayers = false;
}

// ---------- 看不看得清 ----------

function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// 底图：真的渲染器画（一个镜头），读回来是自上而下的 RGBA
function basePixels(r: Renderer, gl: HTMLCanvasElement, w: World, mode: ViewMode): Uint8ClampedArray {
  const human = mode === 'country' || mode === 'culture' || mode === 'popDensity';
  r.style = worldMapStyle(w.small);
  r.setLayers(cellLayers(w, { mode, season: 'annual', focusSpecies: null, borders: human, countryBorders: human && !!w.small.countries }));
  r.flatByGroup = mode === 'country';
  r.highlightByGroup = false;
  r.provinceAlpha = human ? (mode === 'country' ? 0.45 : 0.25) : 1;
  r.countryAlpha = human && mode !== 'country' ? 0.4 : 1;
  r.provinceScale = provinceScale(w.causes.province);
  r.setHighlight(null);
  r.render(w.kmPerUnit, { still: true });
  const c = gl.getContext('webgl2')!;
  c.bindFramebuffer(c.FRAMEBUFFER, null);
  const raw = new Uint8Array(gl.width * gl.height * 4);
  c.readPixels(0, 0, gl.width, gl.height, c.RGBA, c.UNSIGNED_BYTE, raw);
  const px = new Uint8ClampedArray(raw.length);
  for (let y = 0; y < gl.height; y++) px.set(raw.subarray((gl.height - 1 - y) * gl.width * 4, (gl.height - y) * gl.width * 4), y * gl.width * 4);
  return px;
}

interface Flow {
  name: string;
  style: FlowStyle;
  lines: (w: World, cam: Camera) => ReturnType<typeof windLines>;
}

// 线画到透明的画布上：halo 带描边的整幅；不带时是线本身（只用来挑出线上的像素）
function drawLines(flow: Flow, w: World, cam: Camera, W: number, H: number, dev: number, halo: boolean): Uint8ClampedArray {
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  const z = cam.zoom * dev;
  x.setTransform(z, 0, 0, z, (W / 2 / dev - cam.x * cam.zoom) * dev, (H / 2 / dev - cam.y * cam.zoom) * dev);
  strokeFlows(x, flow.lines(w, cam), flow.style, 1 / z, undefined, Infinity, !halo);
  return x.getImageData(0, 0, W, H).data;
}

// 线上的像素（线本身不透明度 ≥ 0.25）：与同一处底图的色差 dE（线盖没盖出颜色来），与紧挨着它的线外的像素（上下左右隔 3 个像素，描边或底图）的色差 local（眼睛看到的线的边）
function measure(base: Uint8ClampedArray, full: Uint8ClampedArray, core: Uint8ClampedArray, W: number) {
  const dE: number[] = [];
  const local: number[] = [];
  const shown = compose(base, full);
  const labAt = (px: Uint8ClampedArray, i: number) => lab(px[i], px[i + 1], px[i + 2]);
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const reach = 3 * 4;
  const rows = reach * W;
  for (let i = 0; i < base.length; i += 4) {
    if (core[i + 3] < 64) continue;
    const L1 = labAt(shown, i);
    dE.push(dist(L1, labAt(base, i)));
    const around = [i - reach, i + reach, i - rows, i + rows].filter((k) => k >= 0 && k < base.length && core[k + 3] < 64);
    if (around.length) local.push(Math.max(...around.map((k) => dist(L1, labAt(shown, k)))));
  }
  return { dE, local };
}

function compose(base: Uint8ClampedArray, full: Uint8ClampedArray): Uint8ClampedArray {
  const o = new Uint8ClampedArray(base.length);
  for (let i = 0; i < base.length; i += 4) {
    const a = full[i + 3] / 255;
    for (let k = 0; k < 3; k++) o[i + k] = full[i + k] * a + base[i + k] * (1 - a);
    o[i + 3] = 255;
  }
  return o;
}

function savePng(name: string, px: Uint8ClampedArray, W: number, H: number) {
  const d = document.createElement('canvas');
  d.width = W;
  d.height = H;
  d.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), W, H), 0, 0);
  const pre = document.createElement('pre');
  pre.id = `png-${name}`;
  pre.textContent = d.toDataURL('image/png');
  document.body.appendChild(pre);
}

const MODES: ViewMode[] = ['terrain', 'country', 'culture', 'popDensity', 'temperature', 'precip', 'elevation', 'seaTemp'];

function readability(eng: Engine, png: boolean, tag = '') {
  const w0 = eng.world;
  const gl = document.createElement('canvas');
  const CWR = 700;
  const CHR = 460;
  gl.style.cssText = `width:${CWR}px;height:${CHR}px;display:block`;
  document.body.appendChild(gl);
  const r = new Renderer(gl);
  r.setMesh(w0.mesh);
  const cam: Camera = { x: w0.mesh.width * 0.5, y: w0.mesh.height * 0.5, zoom: (CWR * 1.15) / w0.mesh.width };
  r.camera = cam;
  const flows: Flow[] = [
    { name: '风', style: WIND_STYLE, lines: (ww, c) => windLines(ww, c, 'annual', { cw: CWR, ch: CHR }) },
    { name: '洋流', style: CURRENT_STYLE, lines: (ww, c) => currentLines(ww, c, { cw: CWR, ch: CHR }) },
  ];
  for (const styleName of ['realistic', 'atlas']) {
    eng.exec({ op: 'set_map_style', id: styleName });
    const w = eng.world;
    for (const mode of MODES) {
      const base = basePixels(r, gl, w, mode);
      const W = gl.width;
      const H = gl.height;
      const dev = W / CWR;
      const parts: string[] = [];
      let shot: Uint8ClampedArray = base;
      for (const fl of flows) {
        const full = drawLines(fl, w, cam, W, H, dev, true);
        const core = drawLines(fl, w, cam, W, H, dev, false);
        const m = measure(base, full, core, W);
        parts.push(`${fl.name} 对底图 ΔE ${f1(q(m.dE, 0.5))}（p10 ${f1(q(m.dE, 0.1))}，<10 占 ${((100 * m.dE.filter((v) => v < 10).length) / m.dE.length).toFixed(0)}%），线的边 ΔE ${f1(q(m.local, 0.5))}（p10 ${f1(q(m.local, 0.1))}）`);
        shot = compose(shot, full);
      }
      log(`${tag}${styleName} ${mode}：${parts.join('；')}`);
      if (png) savePng(`${tag}${styleName}-${mode.replace(':', '_')}`, shot, W, H);
    }
  }
  eng.exec({ op: 'set_map_style', id: 'realistic' });
  gl.remove();
}

export function run(opt: { quick: boolean; png: boolean; only: string; soft: boolean }) {
  try {
    const N = opt.quick ? 7 : 15;
    const t0 = performance.now();
    const region = r40Engine(false, 40000);
    log(`devicePixelRatio ${devicePixelRatio}，画布 ${CW} × ${CH} CSS 像素。一块地区 ${region.world.mesh.n} 格（生成 ${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
    if (opt.only !== 'contrast') frameTimes(region.world, '一块地区', N, opt.soft);
    if (opt.only !== 'frames') readability(region, opt.png);
    if (!opt.quick) {
      const t1 = performance.now();
      const planet = r40Engine(true, planetCells(PLANET_SIZES.earth.radiusKm));
      log(`类地星球 ${planet.world.mesh.n} 格（生成 ${((performance.now() - t1) / 1000).toFixed(1)} 秒）`);
      if (opt.only !== 'contrast') frameTimes(planet.world, '类地星球', N, opt.soft);
      if (opt.only !== 'frames') readability(planet, opt.png, 'planet-');
    }
    log('DONE');
  } catch (e) {
    log(`ERROR ${(e as Error).stack ?? e}`);
  }
}
