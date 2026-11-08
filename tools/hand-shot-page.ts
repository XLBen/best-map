// 手绘画风的截图与叠加层计时（第八十七轮）的页面那一半：tools/hand-shot.mjs 把它和现在的渲染器、叠加层打包成一个 file:// 页面，
// 在无头 Chrome（SwiftShader）里跑。世界：种子 3 的一块地区（4 万格，同 overlay-ab：省份、中世纪的人文与国家、城市、道路、地标）。
//   截图：地貌模式，一格约 8 像素的一处与看全图；底图用渲染器（河由渲染器合成，同 MapView），叠加层画山、森林、地名、城市、道路；
//   另一张是看全图时加上导出的装饰（罗盘、标题、边框、图例）。写进 <pre id="png0">…（data: 地址），hand-shot.mjs 存成文件。
//   计时：叠加层整张重画（每次挪一点镜头）手绘与写实各 N 次的中位数，另记第一次（符号的块还没算）的时间、只画符号的时间；
//   按显卡画（只量主线程）与按软件画（每次读回一个像素，连光栅化一起量）各一遍。
// 页面里的字体：file:// 下不载网页字体，楷体用系统的（Kaiti SC / STKaiti）
import { DRAWN_MAP_STYLES } from '../core/packs/map-styles';
import { FALLBACK_MAP_STYLE, type MapStyle } from '../core/map-style';
import type { World } from '../core/world';
import { cellLayers, provinceScale } from '../src/render/colors';
import { defaultDecor, drawExportDecor } from '../src/render/export-decor';
import { buildPaths, drawOverlay, overlayDebug, riverLayer } from '../src/render/overlay';
import type { OverlayState } from '../src/render/overlay-base';
import { drawSymbols } from '../src/render/overlay-symbols';
import { Renderer } from '../src/render/renderer';
import { decorInfo } from '../src/ui/map/export';
import { modeDef, modeFeatures } from '../src/ui/map/modes';
import { settleOverlay } from '../src/ui/map/settle';
import { r40Engine } from './r40-world';

const CW = 1200;
const CH = 800;
const out: string[] = [];
const log = (s: string) => {
  out.push(s);
  (document.getElementById('o') as HTMLElement).textContent = out.join('\n');
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const f1 = (v: number) => v.toFixed(v < 10 ? 2 : 1);

export function run(opt: { quick: boolean }) {
  try {
    main(opt);
    log('DONE');
  } catch (e) {
    log(`ERROR ${(e as Error).stack ?? e}`);
  }
}

function overlayState(w: World, style: MapStyle): OverlayState {
  const md = modeDef('geo');
  return {
    rivers: false,
    wind: false,
    markers: false,
    flowSeason: 'annual',
    style,
    shapes: [],
    provinceLabels: [],
    features: modeFeatures(w.derived.features, md.features),
    labelTypes: null,
    nameMode: 'zh',
    peaks: null,
    countries: null,
    ...settleOverlay(w, { mode: md, editing: false }),
    kmPerUnit: w.kmPerUnit,
    hoverLabel: null,
    scaleBar: true,
    cornerLift: 0,
    latitude: null,
  };
}

function main(opt: { quick: boolean }) {
  const N = opt.quick ? 5 : 11;
  const t0 = performance.now();
  const w = r40Engine(false, 40000).world;
  const { mesh } = w;
  log(`一块地区：${mesh.n} 格，${Object.keys(w.small.cities ?? {}).length} 座城市（生成 ${((performance.now() - t0) / 1000).toFixed(1)} 秒）；画布 ${CW} × ${CH}`);
  const hand = DRAWN_MAP_STYLES[0];
  const paths = buildPaths(w);
  // 一处多山的陆地：海拔最高的格附近
  let top = 0;
  for (let i = 0; i < mesh.n; i++) if (w.causes.land[i] && w.derived.elevation[i] > w.derived.elevation[top]) top = i;
  const sp = mesh.spacing;
  const cams = [
    ['一格约 8 像素', { x: Math.min(mesh.width - 70 * sp, Math.max(70 * sp, mesh.x[top])), y: Math.min(mesh.height - 50 * sp, Math.max(50 * sp, mesh.y[top])), zoom: 8 / sp }],
    ['看全图', { x: mesh.width / 2, y: mesh.height / 2, zoom: CW / (mesh.width * 1.02) }],
  ] as const;

  // ---------- 截图 ----------
  const gl = document.createElement('canvas');
  gl.style.cssText = `width:${CW}px;height:${CH}px;display:block`;
  document.body.appendChild(gl);
  const r = new Renderer(gl);
  r.setMesh(mesh);
  r.setLayers(cellLayers(w, { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false, countryBorders: false } as never));
  r.provinceScale = provinceScale(w.causes.province);
  (r as unknown as { style: MapStyle }).style = hand;
  r.riverLayer = (motion) => riverLayer(w, paths, r.camera, { style: hand, motion }, gl);
  const ov = document.createElement('canvas');
  ov.style.cssText = `position:fixed;left:0;top:0;width:${CW}px;height:${CH}px`;
  document.body.appendChild(ov);
  const octx = ov.getContext('2d')!;
  const st = overlayState(w, hand);
  cams.forEach(([name, cam], k) => {
    r.camera = { ...cam };
    r.render(w.kmPerUnit, { still: true });
    const shot = document.createElement('canvas');
    shot.width = gl.width;
    shot.height = gl.height;
    const sctx = shot.getContext('2d')!;
    sctx.drawImage(gl, 0, 0);
    drawOverlay(octx, w, paths, cam, st);
    sctx.drawImage(ov, 0, 0);
    if (k === 1) drawExportDecor(sctx, shot.width, shot.height, defaultDecor(hand), decorInfo(w, st, '示例世界'));
    const pre = document.createElement('pre');
    pre.id = `png${k}`;
    pre.textContent = shot.toDataURL('image/png');
    document.body.appendChild(pre);
    log(`截图 ${k}：${name}${k === 1 ? '（加上导出的装饰）' : ''}，${shot.width} × ${shot.height}`);
  });
  gl.remove();
  ov.remove();

  // ---------- 计时 ----------
  const canvas = (soft: boolean) => {
    const c = document.createElement('canvas');
    c.style.cssText = `position:fixed;left:0;top:0;width:${CW}px;height:${CH}px`;
    document.body.appendChild(c);
    return c.getContext('2d', soft ? { willReadFrequently: true } : undefined)!;
  };
  for (const [cname, cam0] of cams) {
    const rows: string[] = [];
    for (const soft of [false, true]) {
      overlayDebug.softLayers = soft;
      const res: Record<string, number[]> = {};
      const variants: [string, MapStyle][] = [
        ['写实', FALLBACK_MAP_STYLE],
        ['手绘', hand],
        ['手绘不要暗角', { ...hand, paper: 0 }],
        ['手绘不换字体', { ...hand, labelFont: undefined }],
        ['手绘不画符号', { ...hand, mountains: false, forests: false }],
      ];
      for (const [sname, style] of variants) {
        const ctx = canvas(soft);
        const s = overlayState(w, style);
        const ts: number[] = [];
        for (let i = 0; i < N + 1; i++) {
          const cam = { ...cam0, x: cam0.x + ((i % 3) - 1) * 1e-7 + (soft ? 3e-7 : 0) };
          const t = performance.now();
          drawOverlay(ctx, w, paths, cam, s);
          if (soft) ctx.getImageData(0, 0, 1, 1);
          if (i) ts.push(performance.now() - t);
        }
        res[sname] = ts;
        ctx.canvas.remove();
      }
      // 只画符号（块已经算好、路径已经建好）
      const sc = canvas(soft);
      sc.canvas.width = CW;
      sc.canvas.height = CH;
      const sym: number[] = [];
      for (let i = 0; i < N; i++) {
        const t = performance.now();
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.clearRect(0, 0, sc.canvas.width, sc.canvas.height);
        drawSymbols(sc, w, cam0, hand, CW, CH, 1);
        if (soft) sc.getImageData(0, 0, 1, 1);
        sym.push(performance.now() - t);
      }
      sc.canvas.remove();
      rows.push(`${soft ? '连光栅化（软件画）' : '主线程（显卡画）'}：整张重画 ${variants.map(([n]) => `${n} ${f1(median(res[n]))}`).join('、')}；只画符号 ${f1(median(sym))}`);
      overlayDebug.softLayers = false;
    }
    log(`${cname}\n  ${rows.join('\n  ')}`);
  }
  // 第一次（块没算过）：换一个种子的同一个世界（缓存按网格与种子）
  const w2 = { ...w, settings: { ...w.settings, seed: w.settings.seed + 1 } };
  const ctx = canvas(false);
  for (const [cname, cam] of cams) {
    const t = performance.now();
    drawSymbols(ctx, w2, cam, hand, CW, CH, 1);
    log(`${cname}：第一次画符号（算看得见的块、建路径）${f1(performance.now() - t)} ms`);
  }
}
