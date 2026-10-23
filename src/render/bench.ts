import type { Camera, Renderer } from './renderer';

// 开发用的平移缩放测速（浏览器控制台里 await __map2Bench()）：按几种固定的镜头脚本一帧接一帧同步地画，
// 每帧画完读回一个像素等显卡画完，报每帧耗时（总的，与其中 WebGL 那部分）的平均、中位、p95。
// 不靠 requestAnimationFrame（后台的页面里它不跑），所以浏览器窗口藏着时也能测；只看同一台机器上的前后对照

export interface BenchHooks {
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  // 同步画一帧（MapView 的 draw）
  draw: () => void;
  // 世界的格距（地图单位）与地图宽高（整个星球是 2 × 1）
  spacing: () => number;
}

interface Stats {
  frames: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
  glMean: number;
  glP95: number;
}

function stats(total: number[], gl: number[]): Stats {
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const r = (v: number) => Math.round(v * 10) / 10;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return { frames: total.length, mean: r(mean(total)), p50: r(q(total, 0.5)), p95: r(q(total, 0.95)), max: r(Math.max(...total)), glMean: r(mean(gl)), glP95: r(q(gl, 0.95)) };
}

type Step = (cam: Camera, i: number) => void;

export async function runBench(h: BenchHooks, opts: { frames?: number; only?: string[] } = {}): Promise<Record<string, Stats>> {
  const { renderer } = h;
  const gl = (h.canvas.getContext('webgl2') as WebGL2RenderingContext)!;
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const N = opts.frames ?? 60;
  const saved = { ...renderer.camera };
  // WebGL 那部分：包住 render，画完读回一个像素
  const orig = renderer.render.bind(renderer);
  let glTime = 0;
  renderer.render = (km: number, o?: unknown) => {
    const t = performance.now();
    const out = (orig as (km: number, o?: unknown) => unknown)(km, o);
    sync();
    glTime += performance.now() - t;
    return out as ReturnType<Renderer['render']>;
  };
  const sp = h.spacing();
  const cw = h.canvas.clientWidth;
  // 几种镜头：看全图平移、放大到一格约 8 像素后平移、捏合缩放（来回）、放大到一格约 24 像素后平移
  const scenarios: Record<string, { start: Camera; step: Step }> = {
    'pan-full': { start: { x: 1, y: 0.5, zoom: cw / 2.2 }, step: (c) => (c.x += 6 / c.zoom) },
    'pan-8px': { start: { x: 1, y: 0.5, zoom: 8 / sp }, step: (c) => (c.x += 6 / c.zoom) },
    'pan-24px': { start: { x: 1, y: 0.45, zoom: 24 / sp }, step: (c) => ((c.x += 5 / c.zoom), (c.y += 2 / c.zoom)) },
    zoom: { start: { x: 1, y: 0.5, zoom: 3 / sp }, step: (c, i) => (c.zoom *= i % 40 < 20 ? 1.04 : 1 / 1.04) },
  };
  const out: Record<string, Stats> = {};
  try {
    for (const [name, sc] of Object.entries(scenarios)) {
      if (opts.only && !opts.only.includes(name)) continue;
      renderer.camera = { ...sc.start };
      // 先在起点停稳画一帧（不计）
      h.draw();
      await new Promise((r) => setTimeout(r, 300));
      h.draw();
      const total: number[] = [];
      const glt: number[] = [];
      for (let i = 0; i < N; i++) {
        sc.step(renderer.camera, i);
        glTime = 0;
        const t = performance.now();
        h.draw();
        sync();
        total.push(performance.now() - t);
        glt.push(glTime);
      }
      out[name] = stats(total, glt);
      // 停下以后补的那一帧（全分辨率）
      await new Promise((r) => setTimeout(r, 300));
      glTime = 0;
      const t = performance.now();
      h.draw();
      sync();
      out[`${name}:settle`] = stats([performance.now() - t], [glTime]);
    }
  } finally {
    renderer.render = orig;
    renderer.camera = saved;
    h.draw();
  }
  return out;
}

// ---------- 停稳后的画面对照（开发用）：同一个镜头下截一张干净的图，存进单独的 IndexedDB（map2-bench），
// 改了渲染以后再截一次逐像素比。saveRefs 存、compareRefs 比（报不同的像素数与最大的差）

type ShotHooks = BenchHooks & { snapshot: () => HTMLCanvasElement };

// full：看全图；near：一格约 8 像素；close：一格约 24 像素
const REF_NAMES = ['full', 'near', 'close'] as const;
function refCamera(name: (typeof REF_NAMES)[number], spacing: number, cw: number): Camera {
  if (name === 'near') return { x: 0.83, y: 0.42, zoom: 8 / spacing };
  if (name === 'close') return { x: 1.27, y: 0.38, zoom: 24 / spacing };
  return { x: 1, y: 0.5, zoom: cw / 2.2 };
}

function benchDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('map2-bench', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('refs');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}
async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await benchDb();
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction('refs', mode).objectStore('refs'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function shoot(h: ShotHooks, name: (typeof REF_NAMES)[number]): Promise<ImageData> {
  h.renderer.camera = refCamera(name, h.spacing(), h.canvas.clientWidth);
  h.draw();
  // 停稳（镜头不动 150 毫秒以上）再截
  await new Promise((r) => setTimeout(r, 400));
  const c = h.snapshot();
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
}

export async function saveRefs(h: ShotHooks, tag = ''): Promise<string[]> {
  const saved = { ...h.renderer.camera };
  const out: string[] = [];
  for (const name of REF_NAMES) {
    const img = await shoot(h, name);
    await idb('readwrite', (s) => s.put({ w: img.width, h: img.height, data: img.data }, name + tag));
    out.push(`${name + tag} ${img.width}x${img.height}`);
  }
  h.renderer.camera = saved;
  h.draw();
  return out;
}

export async function compareRefs(h: ShotHooks, tag = ''): Promise<Record<string, { diff: number; max: number; of: number }>> {
  const saved = { ...h.renderer.camera };
  const out: Record<string, { diff: number; max: number; of: number }> = {};
  for (const name of REF_NAMES) {
    const ref = await idb<{ w: number; h: number; data: Uint8ClampedArray } | undefined>('readonly', (s) => s.get(name + tag));
    const img = await shoot(h, name);
    if (!ref || ref.w !== img.width || ref.h !== img.height) {
      out[name] = { diff: -1, max: -1, of: img.width * img.height };
      continue;
    }
    let diff = 0;
    let max = 0;
    for (let p = 0; p < img.data.length; p += 4) {
      const d = Math.max(Math.abs(img.data[p] - ref.data[p]), Math.abs(img.data[p + 1] - ref.data[p + 1]), Math.abs(img.data[p + 2] - ref.data[p + 2]));
      if (d) diff++;
      if (d > max) max = d;
    }
    out[name] = { diff, max, of: img.width * img.height };
  }
  h.renderer.camera = saved;
  h.draw();
  return out;
}
