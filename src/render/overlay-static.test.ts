import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import { digest } from '../../core/digest';
import { blocList } from '../../core/human';
import { snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { r40Engine } from '../../tools/r40-world';
import { countriesByName, vassalsOf } from '../ui/domain/countries';
import { type MapKind, modeDef } from '../ui/map/modes';
import { clearRegionGeometry, countryDraws, regionDraws } from '../ui/map/political';
import { countryDrawsRef, regionDrawsRef } from '../testing/frozen/political-r39';
import { settleOverlay } from '../ui/map/settle';
import { modeFeatures } from '../ui/map/modes';
import { COUNTRY_FIT, COUNTRY_FIT_R81, type CountryLabelDraw, type OverlayState, type Shape, buildPaths, drawOverlay, overlayDebug, peakLabels, placeLabels, refZoom, sameShapes } from './overlay';
import { clearLabelLayout } from './overlay-labels';
import { featureLinesOf } from './label-lines';
import type { Camera } from './renderer';
import { BoxIndex } from './settle-draw';
import { TILE_CAP, drawWind, flushWindQueue, windTilesCached } from './wind';

// 第四十轮：叠加层与排版提速——结果与原来逐项相同

// 测试里没有画布：Path2D 只记下画了哪些点
class FakePath {
  ops: unknown[] = [];
  constructor(_d?: unknown) {}
  moveTo(x: number, y: number) {
    this.ops.push(['M', x, y]);
  }
  lineTo(x: number, y: number) {
    this.ops.push(['L', x, y]);
  }
  arc(...a: number[]) {
    this.ops.push(['A', ...a]);
  }
  closePath() {
    this.ops.push(['Z']);
  }
  rect(...a: number[]) {
    this.ops.push(['R', ...a]);
  }
}
(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath;

// 字宽按字体：每个字 = 字号 ×（中文 1，别的 0.55）——没设好字体就量的话量出来不同
const widthOf = (font: string, c: string) => {
  const m = /([\d.]+)px/.exec(font);
  return (m ? Number(m[1]) : 10) * (c.charCodeAt(0) > 255 ? 1 : 0.55);
};

const WORLDS: [string, () => World][] = [
  ['一块地区（种子 3，2 万格）', () => snapshot('r40:region', () => r40Engine(false, 20000)).world],
  ['整个星球（种子 3，1.6 万格）', () => snapshot('r40:planet', () => r40Engine(true, 16000)).world],
];

// 第四十二轮的淡一些、小一些（城市等级的 alpha、iconScale，首都按国家的等级）冻结的第三十九轮参照不认：
// 对照排版的算法时去掉这几项（两边按同样的图标大小排）
const LOOK_KEYS = ['alpha', 'scale', 'labelAlpha', 'country'] as const;
function plainMarks<T extends Pick<OverlayState, 'settlements'>>(o: T): T {
  if (!o.settlements) return o;
  const marks = o.settlements.map((m) => {
    const c = { ...m };
    for (const k of LOOK_KEYS) delete c[k];
    return c;
  });
  return { ...o, settlements: marks };
}

// MapView 的叠加层选项（geo：地貌；country：国家模式）
function stateFor(w: World, kind: MapKind, more: Partial<OverlayState> = {}): OverlayState {
  const md = modeDef(kind);
  return {
    rivers: false,
    wind: false,
    markers: false,
    flowSeason: 'annual',
    style: { countryLabel: '#3a2a1a' } as OverlayState['style'],
    shapes: [],
    provinceLabels: [],
    features: modeFeatures(w.derived.features, md.features),
    labelTypes: null,
    nameMode: 'zh',
    peaks: peakLabels(w),
    countries: md.regions ? regionDraws(w, md.regions, 'zh') : null,
    featureLines: featureLinesOf(w),
    ...plainMarks(settleOverlay(w, { mode: md, editing: false })),
    kmPerUnit: w.kmPerUnit,
    hoverLabel: null,
    scaleBar: true,
    cornerLift: 0,
    latitude: null,
    ...more,
  } as OverlayState;
}

// 几种镜头：看全图、一格约 8、24 像素（星球上另有球形、等面积投影）
function cameras(w: World): Camera[] {
  const sp = w.mesh.spacing;
  if (w.mesh.kind === 'sphere') {
    return [
      { x: 1, y: 0.5, zoom: 1200 / 2.2 },
      { x: 0.7, y: 0.4, zoom: 8 / sp },
      { x: 1.3, y: 0.6, zoom: 24 / sp },
      { x: 1.95, y: 0.45, zoom: 8 / sp },
      { x: 1, y: 0.5, zoom: 600, proj: { kind: 'globe', lon0: 0.4, lat0: 0.3 } },
      { x: 1, y: 0.5, zoom: 3 / sp, proj: { kind: 'globe', lon0: -1, lat0: 0.6 } },
      { x: 1, y: 0.5, zoom: 1200 / 2.3, proj: { kind: 'equalEarth', lon0: 0.5, lat0: 0 } },
    ];
  }
  return [
    { x: w.mesh.width / 2, y: w.mesh.height / 2, zoom: 1200 / w.mesh.width },
    { x: w.mesh.width * 0.4, y: w.mesh.height * 0.45, zoom: 8 / sp },
    { x: w.mesh.width * 0.6, y: w.mesh.height * 0.55, zoom: 24 / sp },
  ];
}

const measuring = (cw = 1200, ch = 800) => {
  const c = { canvas: { clientWidth: cw, clientHeight: ch }, font: '', measureText: (t: string) => ({ width: widthOf(c.font, t) }) };
  return c as unknown as CanvasRenderingContext2D;
};

// 排出来的样子（位置、字、字体、颜色、国名的每个字、图标）
const plain = (r: { placed: { key: string; chars: string[]; widths: number[]; spacing: number; total: number; font: string; color: string; x: number; y: number; angle: number; glyphs?: unknown; halo?: string; haloWidth?: number; mark?: { key: string }; markScale?: number }[]; boxes: unknown[]; marks: unknown[] }) => ({
  placed: r.placed.map((l) => [l.key, l.chars.join(''), l.widths, l.spacing, l.total, l.font, l.color, l.x, l.y, l.angle, l.glyphs ?? null, l.halo ?? null, l.haloWidth ?? null, l.mark?.key ?? null, l.markScale ?? null]),
  boxes: r.boxes,
  marks: r.marks,
});

// 第八十九轮：地名换了新的排版（海名、河名沿着水写，放不下时试几个候选位置，字号分档，城市名随缩放出现），
// 以前对照冻结的第三十九轮参照（src/testing/frozen/place-labels-r39.ts，文件本身没动）的几项退役，改成对照新排版录下的摘要
// （label-digests.json，RECORD_LABELS=1 重录）与“同一世界再排一次逐值相同”
const LABEL_FILE = new URL('./label-digests.json', import.meta.url);
const recorded: Record<string, string> = (() => {
  try {
    return JSON.parse(readFileSync(LABEL_FILE, 'utf8'));
  } catch {
    return {};
  }
})();
const fresh: Record<string, string> = {};
// 一种情形排一次：清掉缓存的版面（不沿用上一次排好的）
function layoutOnce(w: World, cam: Camera, s: OverlayState) {
  clearLabelLayout();
  const sphere = w.mesh.kind === 'sphere' && !cam.proj;
  return placeLabels(measuring(), cam, s, sphere ? [-1, 0, 1] : [0], refZoom(w, cam.zoom));
}
describe('排地名（第八十九轮的新排版）：摘要与录下的相同，再排一次逐值相同', () => {
  for (const [name, make] of WORLDS) {
    it(name, () => {
      const w = make();
      let compared = 0;
      for (const kind of ['geo', 'country'] as MapKind[]) {
        for (const nameMode of ['zh', 'both'] as const) {
          const st = stateFor(w, kind, { nameMode, countries: modeDef(kind).regions ? regionDraws(w, modeDef(kind).regions!, nameMode) : null });
          cameras(w).forEach((cam, ci) => {
            for (const motion of [false, true]) {
              const s = { ...st, motion };
              const a = plain(layoutOnce(w, cam, s));
              const b = plain(layoutOnce(w, cam, s));
              expect(b).toEqual(a);
              compared += a.placed.length;
              fresh[`${w.mesh.kind}|${kind}|${nameMode}|${ci}|${motion ? 'm' : ''}`] = digest(a);
            }
          });
          // 悬停一个地名：它最先放、一定标
          const cam = cameras(w)[1];
          const key = st.features?.[st.features.length - 1]?.key;
          if (key) {
            const r = layoutOnce(w, cam, { ...st, hoverLabel: key });
            fresh[`${w.mesh.kind}|${kind}|${nameMode}|hover`] = digest(plain(r));
          }
        }
      }
      expect(compared).toBeGreaterThan(500);
      const mine = Object.fromEntries(Object.entries(fresh).filter(([k]) => k.startsWith(`${w.mesh.kind}|`)));
      if (process.env.RECORD_LABELS) {
        const all = { ...recorded, ...fresh };
        writeFileSync(LABEL_FILE, `${JSON.stringify(Object.fromEntries(Object.entries(all).sort(([x], [y]) => (x < y ? -1 : 1))), null, 2)}\n`);
      } else expect(mine).toEqual(Object.fromEntries(Object.entries(recorded).filter(([k]) => k.startsWith(`${w.mesh.kind}|`))));
    });
  }

  it('不压别的字；海名、河名沿着水写，字不倒着；城市的名字按等级随缩放出现', () => {
    const w = WORLDS[0][1]();
    const st = stateFor(w, 'country', { features: modeFeatures(w.derived.features, 'all') });
    let curved = 0;
    let rivers = 0;
    for (const cam of cameras(w)) {
      const r = layoutOnce(w, cam, st);
      // 不同地名的框不重叠（同一个地名沿线写的每个字一个框）
      const bs = r.placed.length ? (r as unknown as { boxes: { key: string; x0: number; y0: number; x1: number; y1: number }[] }).boxes : [];
      for (let i = 0; i < bs.length; i++)
        for (let j = i + 1; j < bs.length; j++) {
          const p = bs[i];
          const q = bs[j];
          if (p.key !== q.key) expect(p.x0 < q.x1 && p.x1 > q.x0 && p.y0 < q.y1 && p.y1 > q.y0, `${p.key} / ${q.key}`).toBe(false);
        }
      for (const l of r.placed) {
        if (!l.glyphs || l.key.startsWith('country:') || l.key.startsWith('region:')) continue;
        for (const g of l.glyphs) expect(Math.abs(g.a)).toBeLessThanOrEqual(1.46);
        if (l.key.startsWith('river:')) rivers++;
        else curved++;
      }
    }
    expect(curved).toBeGreaterThan(0);
    expect(rivers).toBeGreaterThan(0);
    // 城市：看全图时只写首都的名字，一格 24 像素时大城市、城市也写
    const towns = (cam: Camera) => {
      const r = layoutOnce(w, cam, st);
      const keys = new Set(r.placed.filter((l) => l.chars.length && l.key.startsWith('settle:city:')).map((l) => l.key));
      return st.settlements!.filter((m) => keys.has(m.key));
    };
    const far = towns(cameras(w)[0]);
    expect(far.length).toBeGreaterThan(0);
    expect(far.every((m) => m.tier === 0)).toBe(true);
    const near = towns(cameras(w)[2]);
    expect(near.some((m) => (m.tier ?? 0) >= 1)).toBe(true);
  });

  it('BoxIndex：随机的框（含很宽的、不是有限数的）与逐个比相同', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 0.5;
    const idx = new BoxIndex();
    const all: { key: string; x0: number; y0: number; x1: number; y1: number }[] = [];
    const box = (k: number) => {
      const x = rnd() * 2000;
      const y = rnd() * 1500;
      const w = k % 37 === 0 ? 1e6 : k % 41 === 0 ? Infinity : Math.abs(rnd()) * 80;
      const h = k % 43 === 0 ? Number.NaN : Math.abs(rnd()) * 30;
      return { key: String(k), x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
    };
    for (let k = 0; k < 3000; k++) {
      const b = box(k);
      const lin = all.some((o) => o.x0 < b.x1 && o.x1 > b.x0 && o.y0 < b.y1 && o.y1 > b.y0);
      expect(idx.hits(b)).toBe(lin);
      if (!lin) {
        idx.add(b);
        all.push(b);
      }
    }
    expect(all.length).toBeGreaterThan(200);
  });
});

describe('国名的大小（第八十二轮）', () => {
  const px = (font: string) => Number(/(\d+)px/.exec(font)![1]);
  const sizes = (w: World, cw: number, ch: number, fit?: typeof COUNTRY_FIT) => {
    const st = stateFor(w, 'country', { countryFit: fit });
    const out: number[] = [];
    for (const cam of cameras(w)) {
      const ks = w.mesh.kind === 'sphere' && !cam.proj ? [-1, 0, 1] : [0];
      const r = placeLabels(measuring(cw, ch), cam, st, ks, refZoom(w, cam.zoom));
      for (const l of r.placed) if (l.key.startsWith('country:') && l.glyphs) out.push(px(l.font));
    }
    return out;
  };
  for (const [name, make] of WORLDS) {
    it(`${name}：不超过 40 px，也不超过画面短边的 5%`, () => {
      const w = make();
      for (const [cw, ch] of [
        [1200, 800],
        [1024, 600],
      ]) {
        const now = sizes(w, cw, ch);
        expect(now.length).toBeGreaterThan(0);
        expect(Math.max(...now)).toBeLessThanOrEqual(Math.min(COUNTRY_FIT.maxPx, COUNTRY_FIT.screen * Math.min(cw, ch)));
        // 不是空对照：以前的大小里有更大的
        expect(Math.max(...sizes(w, cw, ch, COUNTRY_FIT_R81))).toBeGreaterThan(Math.max(...now));
      }
    });
  }
});

// 第八十九轮：国名多了按国家等级的字号倍数（scale），冻结的第三十九轮参照没有：对照时去掉这一项
const noScale = (l: CountryLabelDraw[] | null) => l?.map(({ scale: _s, ...rest }) => rest) ?? null;
describe('片区名：几何与字分开缓存，结果与原来相同', () => {
  for (const [name, make] of WORLDS) {
    it(name, () => {
      const w = make();
      const sources = ['country', 'bloc', 'culture', 'cultureGroup'] as const;
      for (const nm of ['zh', 'orig', 'both'] as const) {
        for (const src of sources) expect(noScale(regionDraws(w, src, nm))).toEqual(regionDrawsRef(w, src, nm));
        expect(noScale(countryDraws(w, nm))).toEqual(countryDrawsRef(w, nm));
      }
      // 改名：字跟着换，几何（中线）是同一个数组（不重算）
      const before = countryDraws(w, 'zh');
      const eng = snapshot(`r40:${w.mesh.kind}`, () => r40Engine(w.mesh.kind === 'sphere', w.mesh.kind === 'sphere' ? 16000 : 20000));
      const id = Number(before[0].key.slice('country:'.length));
      eng.exec({ op: 'set_country', id, patch: { name: '新名字' } } as Command);
      const w2 = eng.world;
      countryDraws(eng.world, 'zh');
      const after = countryDraws(w2, 'zh');
      expect(noScale(after)).toEqual(countryDrawsRef(w2, 'zh'));
      expect(after.find((d) => d.key === `country:${id}`)!.lines[0]).toBe('新名字');
      // 新世界的几何：领土数组没变，与改名前同一份中线
      const prev = countryDraws(w, 'zh');
      expect(after.map((d) => d.path)).toEqual(prev.map((d) => d.path));
    });
  }

  it('屏幕上第一次要某一种片区的几何时空闲时算：这一帧给 null，算好了通知；之后当场给', async () => {
    const w = WORLDS[0][1]();
    clearRegionGeometry();
    let told = 0;
    expect(regionDraws(w, 'culture', 'zh', () => told++)).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(told).toBe(1);
    expect(regionDraws(w, 'culture', 'zh', () => told++)).toEqual(regionDrawsRef(w, 'culture', 'zh'));
  });
});

describe('国家的排序与附庸：与原来相同', () => {
  it('countriesByName 与 localeCompare(…, "zh") 相同；vassalsOf 与逐个筛相同', () => {
    const w = WORLDS[1][1]();
    const metas = { ...w.small.countries! };
    // 再加几个拉丁字母、同名、空名字的
    const base = Object.values(metas)[0];
    const extra = ['Aachen', 'aachen', '', '阿尔', '阿尔', 'Zürich', '北方', '100'];
    extra.forEach((name, k) => (metas[9000 + k] = { ...base, id: 9000 + k, name, overlord: k % 2 ? base.id : undefined }));
    const ww = { small: { ...w.small, countries: metas } } as World;
    expect(countriesByName(ww).map((m) => m.id)).toEqual(
      Object.values(metas)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        .map((m) => m.id),
    );
    for (const m of Object.values(metas)) expect(vassalsOf(ww, m.id)).toEqual(Object.values(metas).filter((x) => x.overlord === m.id));
    expect(blocList(w.small).length).toBeGreaterThanOrEqual(0);
  });
});

// ---------- 静态的那一层：画出来的命令与直接画相同 ----------

// 记下每一笔（方法、参数、那时的状态与变换）的假画布
type Op = unknown[];
// ops：画布上现在的内容（整张清空时清掉）；calls：一共画过几笔
class RecCtx {
  ops: Op[] = [];
  calls = 0;
  canvas: { width: number; height: number; clientWidth: number; clientHeight: number; tag: string };
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  lineJoin = 'miter';
  lineCap = 'butt';
  miterLimit = 10;
  globalAlpha = 1;
  shadowBlur = 0;
  shadowColor = 'rgba(0, 0, 0, 0)';
  private dash: number[] = [];
  private m = [1, 0, 0, 1, 0, 0];
  private stack: { m: number[]; s: Record<string, unknown>; dash: number[] }[] = [];
  constructor(w: number, h: number, tag: string) {
    this.canvas = { width: w, height: h, clientWidth: w, clientHeight: h, tag };
  }
  private snap() {
    return [this.fillStyle, this.strokeStyle, this.lineWidth, this.font, this.textAlign, this.textBaseline, this.lineJoin, this.lineCap, this.globalAlpha, this.shadowBlur, this.dash.join(','), this.m.map((v) => Math.round(v * 1e6) / 1e6).join(',')];
  }
  private rec(name: string, args: unknown[]) {
    this.calls++;
    this.ops.push([name, ...args.map((a) => (a instanceof FakePath ? a.ops : a && typeof a === 'object' && 'tag' in (a as object) ? `canvas:${(a as { tag: string }).tag}` : a)), ...this.snap()]);
  }
  setTransform(a: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b?: number, c?: number, d?: number, e?: number, f?: number) {
    this.m = typeof a === 'object' ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b!, c!, d!, e!, f!];
  }
  getTransform() {
    const [a, b, c, d, e, f] = this.m;
    return { a, b, c, d, e, f } as DOMMatrix;
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    const [A, B, C, D, E, F] = this.m;
    this.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  translate(x: number, y: number) {
    this.transform(1, 0, 0, 1, x, y);
  }
  scale(x: number, y: number) {
    this.transform(x, 0, 0, y, 0, 0);
  }
  rotate(t: number) {
    this.transform(Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0);
  }
  save() {
    this.stack.push({ m: [...this.m], dash: [...this.dash], s: { fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, lineJoin: this.lineJoin, lineCap: this.lineCap, globalAlpha: this.globalAlpha, shadowBlur: this.shadowBlur, shadowColor: this.shadowColor } });
  }
  restore() {
    const t = this.stack.pop();
    if (!t) return;
    this.m = t.m;
    this.dash = t.dash;
    Object.assign(this, t.s);
  }
  setLineDash(d: number[]) {
    this.dash = [...d];
  }
  getLineDash() {
    return [...this.dash];
  }
  measureText(t: string) {
    return { width: widthOf(this.font, t) };
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.calls++;
    if (x <= 0 && y <= 0 && x + w >= this.canvas.width && y + h >= this.canvas.height) this.ops = [];
    else this.ops.push(['clearRect', x, y, w, h]);
  }
  drawImage(img: unknown, ...a: number[]) {
    this.rec('drawImage', [img, ...a]);
  }
}
// 两串命令第一处不同（相同时 null）：报出那一处前后
function firstDiff(a: Op[], b: Op[]): unknown {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return { at: i, of: [a.length, b.length], got: a[i], want: b[i], before: a[i - 1] };
  return null;
}
for (const name of ['fill', 'stroke', 'fillText', 'strokeText', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'arc', 'closePath', 'rect', 'quadraticCurveTo', 'bezierCurveTo', 'ellipse', 'clip']) {
  (RecCtx.prototype as unknown as Record<string, unknown>)[name] = function (this: { rec: (n: string, a: unknown[]) => void }, ...a: unknown[]) {
    this.rec(name, a);
  };
}

describe('叠加层的静态那一层：什么都没变时不画，别的帧与每帧照原样画的命令相同', () => {
  for (const [name, make] of WORLDS) {
    it(name, () => {
      const w = make();
      const paths = buildPaths(w);
      try {
        const sp = w.mesh.spacing;
        const cams: Camera[] = w.mesh.kind === 'sphere' ? [{ x: 1.2, y: 0.4, zoom: 10 / sp }, { x: 1, y: 0.5, zoom: 700, proj: { kind: 'globe', lon0: 0.4, lat0: 0.3 } }] : [{ x: w.mesh.width * 0.5, y: w.mesh.height * 0.5, zoom: 10 / sp }];
        for (const cam of cams) {
          const sh = (x: number, r: number): Shape[] => [
            { kind: 'circle', x: cam.x + x * sp, y: cam.y, r: r * sp, dashed: true, geodesic: w.mesh.kind === 'sphere' },
            { kind: 'line', points: [[cam.x, cam.y], [cam.x + 3 * sp, cam.y + 2 * sp]], color: 'rgba(255, 225, 77, 0.95)' },
          ];
          const st = stateFor(w, 'country', {
            wind: true,
            latitude: w.mesh.kind === 'sphere' ? { north: 90, south: -90 } : { north: 60, south: 20 },
            provinceLabels: [
              { x: cam.x, y: cam.y, text: '某省' },
              { x: cam.x + 2 * sp, y: cam.y + sp, text: '湖省', kind: 'lake' },
            ],
          });
          // A：每帧照原样画；B：屏幕上的画法
          const A = new RecCtx(1000, 700, 'A');
          const B = new RecCtx(1000, 700, 'B');
          // 第一帧之后画布上留下的 textBaseline 变了（新画布是 alphabetic，它在键里）：第二帧照原样画，第三帧起才跳过
          const frames: { shapes: Shape[]; hover?: string }[] = [{ shapes: sh(0, 2) }, { shapes: sh(0, 2) }, { shapes: sh(0, 2) }, { shapes: sh(1, 2) }, { shapes: sh(1, 2) }, { shapes: sh(1, 2), hover: 'country:1' }, { shapes: [] }, { shapes: [] }];
          const skips = [2, 4, 7];
          for (let k = 0; k < frames.length; k++) {
            const s = { ...st, shapes: frames[k].shapes, hoverLabel: frames[k].hover ?? null };
            overlayDebug.noStatic = true;
            const boxesA = drawOverlay(A as unknown as CanvasRenderingContext2D, w, paths, cam, s);
            overlayDebug.noStatic = false;
            const before = B.calls;
            const boxesB = drawOverlay(B as unknown as CanvasRenderingContext2D, w, paths, cam, s);
            expect(boxesB).toEqual(boxesA);
            // 什么都没变：一笔不画（画布上的就是这一帧）；别的帧画了
            if (skips.includes(k)) expect(B.calls).toBe(before);
            else expect(B.calls).toBeGreaterThan(before);
            expect(A.ops.length).toBeGreaterThan(20);
            expect(firstDiff(B.ops, A.ops)).toBeNull();
          }
        }
      } finally {
        overlayDebug.noStatic = false;
      }
    });
  }

  it('sameShapes：每帧新建、内容相同的图形算相同；点、格、颜色变了就不同', () => {
    const a: Shape[] = [{ kind: 'line', points: [[0, 0], [1, 2]], color: 'red' }, { kind: 'cells', cells: [1, 2, 3] }];
    const b: Shape[] = [{ kind: 'line', points: [[0, 0], [1, 2]], color: 'red' }, { kind: 'cells', cells: [1, 2, 3] }];
    expect(sameShapes(a, b)).toBe(true);
    expect(sameShapes(a, [{ ...b[0], color: 'blue' }, b[1]])).toBe(false);
    expect(sameShapes(a, [{ ...b[0], points: [[0, 0], [1, 2.5]] }, b[1]])).toBe(false);
    expect(sameShapes(a, [b[0], { kind: 'cells', cells: [1, 2] }])).toBe(false);
    expect(sameShapes(a, [b[0]])).toBe(false);
    expect(sameShapes([], null)).toBe(false);
  });
});

describe('城市与首都分轻重（第四十二轮）', () => {
  it('淡一些的点按 alpha 画、小一些；settleStrong 里的照 1、照原来大小画（不重排）；没有淡的点时与以前一样', () => {
    const w = WORLDS[0][1]();
    const paths = buildPaths(w);
    const md = modeDef('country');
    const st = { ...stateFor(w, 'country'), ...settleOverlay(w, { mode: md, editing: false }) } as OverlayState;
    const faint = st.settlements!.filter((m) => m.alpha !== undefined);
    expect(faint.length).toBeGreaterThan(10);
    const cam = cameras(w)[2];
    // 每一笔的 globalAlpha（RecCtx 记下的状态里倒数第 4 个）
    const alphas = (ops: Op[]) => new Set(ops.map((o) => o[o.length - 4] as number));
    const draw = (s: OverlayState) => {
      const c = new RecCtx(1000, 700, 'A');
      overlayDebug.noStatic = true;
      const boxes = drawOverlay(c as unknown as CanvasRenderingContext2D, w, paths, cam, s);
      overlayDebug.noStatic = false;
      return { ops: c.ops, boxes };
    };
    const a = draw(st);
    expect([...alphas(a.ops)].some((x) => x < 1)).toBe(true);
    const b = draw({ ...st, settleStrong: st.settlements!.map((m) => m.key) });
    expect([...alphas(b.ops)]).toEqual([1]);
    expect(b.boxes).toEqual(a.boxes);
    // 去掉这几项：一笔也没有淡的
    const c = draw({ ...st, ...plainMarks(st) });
    expect([...alphas(c.ops)]).toEqual([1]);
    // 首都：按国家选中的照 1 画
    const capital = st.settlements!.find((m) => m.country !== undefined);
    if (capital) {
      const d = draw({ ...st, settleStrong: [`country:${capital.country}`] });
      expect(d.ops.length).toBe(a.ops.length);
      expect(d.boxes).toEqual(a.boxes);
    }
  });
});

describe('风的流线：空闲时算与当场算相同；缓存有上限', () => {
  it('一块地区：缺块时先不画（没有上一档），算好了与当场算的逐点相同；缩放来回多次，缓存不超过 TILE_CAP', () => {
    const w = WORLDS[0][1]();
    const draw = (cam: Camera, lazy?: () => void) => {
      const c = new RecCtx(1000, 700, 'W');
      const z = cam.zoom;
      c.setTransform(z, 0, 0, z, 500 - cam.x * z, 350 - cam.y * z);
      drawWind(c as unknown as CanvasRenderingContext2D, w, cam, 'summer', 1 / z, { cw: 1000, ch: 700 }, lazy);
      return c.ops;
    };
    const cam = { x: w.mesh.width * 0.3, y: w.mesh.height * 0.4, zoom: 30 / w.mesh.spacing };
    let told = 0;
    const first = draw(cam, () => told++);
    flushWindQueue();
    expect(told).toBe(1);
    const lazy = draw(cam, () => told++);
    const sync = draw(cam);
    expect(lazy).toEqual(sync);
    expect(sync.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThan(sync.length);
    // 换一档：先画上一档（看得见的块都在缓存里）
    const zoomed = { ...cam, zoom: cam.zoom * 2.2 };
    const meanwhile = draw(zoomed, () => told++);
    expect(meanwhile.length).toBeGreaterThan(0);
    flushWindQueue();
    expect(draw(zoomed, () => {})).toEqual(draw(zoomed));
    for (let k = 0; k < 40; k++) draw({ x: w.mesh.width * ((k * 0.37) % 1), y: w.mesh.height * ((k * 0.61) % 1), zoom: (cam.zoom * 2 ** (k % 7)) / 8 });
    expect(windTilesCached(w.derived.windSX)).toBeLessThanOrEqual(TILE_CAP);
  });
});
