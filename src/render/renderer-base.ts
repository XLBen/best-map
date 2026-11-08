// 渲染器的底层（第八十三轮从 src/render/renderer.ts 原样搬出）：全部的状态、构造（编译程序、建纹理与目标）、上传纹理的几种办法、场景目标、晕渲的倍数、河的图层
import { FALLBACK_MAP_STYLE, type MapStyle } from '../../core/map-style';
import type { CellFocus } from '../../core/display';
import type { Mesh } from '../../core/mesh';
import type { SeamLayers } from '../../core/seams';
import type { Perf } from './perf';
import { effectiveZoom } from './projection';
import { TEX_W } from './shaders/common';
import { FS_COMPOSE } from './shaders/compose';
import { FS_ID, FS_SEAM, FS_TERRAIN, VS_CELL, VS_ID, VS_SEAM } from './shaders/plane';
import { compileCompose, compile, type Camera, type CellLayers, type RiverTex, type V4, type Rect, type ProjScene, type RiverScene, type PolarGeom, type SceneTarget } from './renderer-parts';

// Renderer 按职责分几层（第八十三轮）：RendererBase（状态与上传）→ RendererLayers（网格与逐格的图层）→ RendererDraw（编号、地形、切线、合成各层与投影、极地）
// → RendererExport（导出的分块）→ Renderer（每一帧：停稳、移动中、投影；屏幕与地图的换算）。方法照原样搬，private 换成 protected
export abstract class RendererBase {
  protected gl: WebGL2RenderingContext;
  protected progId: WebGLProgram;
  protected progTerrain: WebGLProgram;
  protected progCompose: WebGLProgram;
  protected progSeam: WebGLProgram;
  // 整个星球用的三个程序（第一次遇到星球时才编译）
  protected planetProgs: { id: WebGLProgram; terrain: WebGLProgram; compose: WebGLProgram } | null = null;
  protected planet = false;
  // 星球几何在 x 方向上的范围（含接缝外的一点），用来算要画哪几份副本
  protected xRange: [number, number] = [0, 2];
  protected triVao: WebGLVertexArrayObject | null = null;
  protected triCount = 0;
  protected fanVao: WebGLVertexArrayObject | null = null;
  protected fanCount = 0;
  protected tex: Record<'color' | 'other' | 'elev' | 'coast' | 'cellCoast' | 'grad' | 'seaGrad' | 'flat' | 'highlight' | 'group' | 'segData' | 'fx' | 'fxPal' | 'tint' | 'river' | 'lith' | 'landCell' | 'country' | 'fj' | 'near', WebGLTexture>;
  // 河的图层：每帧问一次（参数：这一帧是不是按移动中的样子取；投影时另给场景的那一块），null 不画河。现在上传着的是哪一张、哪个版本
  riverLayer: ((motion: boolean, scene?: RiverScene) => RiverTex | null) | null = null;
  // 等面积、球形投影（第十三轮 G4）：场景目标（用到时才分配）、现在的场景，与各层画的是哪个键（同停稳的那几个）
  protected projT: SceneTarget | null = null;
  protected projScene: ProjScene | null = null;
  protected pIdKey = '';
  protected pTerrainKey = '';
  protected pTerrainStatic = '';
  protected pSeamKey = '';
  protected pComposeKey = '';
  protected progProj: WebGLProgram | null = null;
  // 极地的场景：程序（用到时才编译）与球面上真实的三角形、Voronoi（按网格缓存）
  protected polarProgs: { id: WebGLProgram; terrain: WebGLProgram; seam: WebGLProgram } | null = null;
  protected polarGeom: { mesh: Mesh; north: PolarGeom | null; south: PolarGeom | null } | null = null;
  protected riverShown: { source: unknown; version: number } | null = null;
  // 场景（编号层、地形层、切线层）：停稳时画在与画布一样大的一组目标上；移动中画在低分辨率、带边距的另一组上
  protected rest: SceneTarget;
  protected moving: SceneTarget;
  // 移动中的合成画面（低分辨率），画好后放大拷到画布上
  protected out: { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };
  // 切线：每段一个实例（两端、前后两段的端点、前后有没有段）。setLayers 给的与现在显示的（剪刀拖动时多一条）
  protected seamVao: WebGLVertexArrayObject;
  protected seamBuf: WebGLBuffer;
  protected seamCount = 0;
  protected seamBand = 0;
  protected seamX: [number, number] = [0, 0];
  protected seamsBase: SeamLayers | null = null;
  protected seamsShown: SeamLayers | null = null;
  protected seamVersion = 0;
  protected seamKey = '';
  protected mesh: Mesh | null = null;
  protected hasFlat = false;
  protected hasGroup = false;
  protected hasLandCell = false;
  protected hasCountry = false;
  protected hasHighlight = false;
  protected shade = 1;
  protected rock = 1;
  // 海面也是数据（海水温度底图）：见 CellLayers.seaData
  protected seaData = false;
  protected coastAmp = 180;
  // 画风（第三十八轮）：世界在用的那一种（core/map-style.ts 的 worldMapStyle）
  style: MapStyle = FALLBACK_MAP_STYLE;
  detail = 1;
  // 平涂是省份着色、高亮是省份工具的：切线附近也按换过的格取（否则按像素自己的格）
  flatByGroup = false;
  // 省界的浓淡（0–1，国家、文化等地图模式里淡一些）
  provinceAlpha = 1;
  // 国界的浓淡（第二十五轮：文化等地图模式里细而淡）
  countryAlpha = 1;
  highlightByGroup = false;
  camera: Camera = { x: 1, y: 0.5, zoom: 500 };
  // 晕渲的夸张倍数（全图时）：真实的山坡很缓，不夸张就看不出起伏
  relief = 24;
  // 每个省大约几格宽（√ 省份格数的中位数，MapView 在省份变了时算）：缩小时省界按它淡出
  provinceScale = 1;
  // 场景（编号层、地形层）与合成画面的版本：没变就不重画
  protected layersVersion = 0;
  protected highlightVersion = 0;
  // 描格（第三十七轮，setFocus）：鼠标下的格、钉住的格与它们的键
  protected focus: [CellFocus | null, CellFocus | null] = [null, null];
  protected focusKey = '|';
  protected meshVersion = 0;
  // 停稳的编号层、地形层画的是哪个键：编号层只看网格、画布、镜头；地形层另看图层、细节、海岸幅度
  protected idKey = '';
  protected terrainKey = '';
  protected terrainStatic = '';
  // 地形层自上次画完后哪些格的输入变了（幽灵海岸：只重画这些格所在的那一块）；'full' 整张重画
  protected dirtyCells: 'full' | Set<number> = 'full';
  // 每格的三角形（地形层）在地图上伸到多远（相对格中心：minDx, maxDx, minDy, maxDy），算重画哪一块用
  protected cellBox: Float32Array | null = null;
  protected composeKey = '';
  // 移动中（镜头在 SETTLE_MS 之内动过）：低分辨率画、平移时挪用带边距的场景。lastCam 是上一帧的镜头，movedAt 是它最后一次变的时候
  protected lastCam = '';
  protected movedAt = -Infinity;
  // 移动中的场景是按哪个镜头、哪些输入画的（同样的输入、镜头还在边距之内就不重画）
  protected movingScene: { cam: Camera; key: string } | null = null;
  // 移动中的场景每重画一次加一：叠加层的河、地名在同一帧跟着重画（几样缓存同时重建，卡一下而不是先后卡几下）
  motionEpoch = 0;
  // 这一帧是停下后补画的第一帧（停稳的画法）：叠加层这一帧先照移动中的样子贴，下一帧再按停稳的画（两样重活分在两帧）
  justSettled = false;
  protected wasMoving = false;
  // 分组、平涂：setLayers 给的底子与现在显示的（省份预览覆盖时不同）。换预览时只上传变了的行
  protected groupBase: Float32Array | null = null;
  protected groupShown: Float32Array | null = null;
  protected flatBase: Uint8Array | null = null;
  protected flatShown: Uint8Array | null = null;
  protected groupVersion = 0;
  // 幽灵海岸（colors.ts 的 GhostBuffer）：setLayers 给的底子，现在显示着幽灵的那些行，幽灵的海岸细节幅度
  protected base: CellLayers | null = null;
  protected ghostRows: number[] = [];
  protected ghostCells: number[] = [];
  protected ghostAmp: number | null = null;
  protected ghostGroup: Float32Array | null = null;
  protected ghostFlat: Uint8Array | null = null;
  // 生态的花纹与发光：setLayers 给的，与现在显示的（拖花纹、发光滑块时主线程上换的）
  protected fxBase: { fx: Uint8Array | null; palette: Float32Array | null } = { fx: null, palette: null };
  protected fxShown: { fx: Uint8Array | null; palette: Float32Array | null } = { fx: null, palette: null };
  protected fxVersion = 0;
  // 湖泊类型的颜色（colors.ts 的 lakeTintLayer）：没有时为 null（着色器整段跳过）
  protected tintShown: Uint8Array | null = null;
  protected tintVersion = 0;
  // uniform 的位置按程序记住（第三十九轮：以前每合成一次调约 70 次 getUniformLocation）
  protected locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  // 每张逐格的纹理现在传上去的是哪几个数组（setLayers 按对象是不是同一个来上传，第三十九轮）；
  // 幽灵海岸、省份预览只改了几行的记成 null（下一次 setLayers 整张重传）
  protected shownDeps: Record<string, unknown[] | null> = {};
  // 只有合成读的那几层（平涂、分组、国界、花纹、landCell、离边界远的格、晕渲的强弱）的版本：进合成的键，不重画地形层
  protected modeVersion = 0;
  // 离边界远的格（第三十九轮，near.ts）：传上去的那一份（null 没有），与这张网格的 ρ（空闲时算，没算好时 null）
  protected nearShown: Uint8Array | null = null;
  protected nearRho: Float32Array | null = null;
  protected rhoTimer: ReturnType<typeof setTimeout> | null = null;
  // 按图层对象记住算过的离边界远的格（同一个对象：MapView 按模式缓存着拼好的图层），与还没算的那一次
  protected nearMemo = new WeakMap<CellLayers, Uint8Array>();
  protected nearTimer: ReturnType<typeof setTimeout> | null = null;
  // 描格（第三十七轮）那一遍（第三十九轮）：画布上现在描的是哪一个键、描在哪几块（停稳的与投影的各一份）
  protected focusDrawn = { key: '', rects: [] as Rect[] };
  // 测速（第三十九轮，perf.ts；网址带 ?perf 时 MapView 给）
  perf: Perf | null = null;

  constructor(protected canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('浏览器不支持浮点渲染目标（EXT_color_buffer_float）');
    this.gl = gl;
    this.progId = compile(gl, VS_ID, FS_ID);
    this.progTerrain = compile(gl, VS_CELL, FS_TERRAIN);
    this.progCompose = compileCompose(gl, FS_COMPOSE);
    this.progSeam = compile(gl, VS_SEAM, FS_SEAM);
    const t = () => this.makeTex();
    this.tex = { color: t(), other: t(), elev: t(), coast: t(), cellCoast: t(), grad: t(), seaGrad: t(), flat: t(), highlight: t(), group: t(), segData: t(), fx: t(), fxPal: t(), tint: t(), river: this.makeTex(true), lith: t(), landCell: t(), country: t(), fj: t(), near: t() };
    this.rest = this.makeTarget();
    this.moving = this.makeTarget();
    this.out = { fbo: gl.createFramebuffer()!, tex: this.makeTex(), w: 0, h: 0 };
    // 每段的数据先放一个空纹素：还没有切线时合成程序照样绑着它，不能是没有内容的纹理
    gl.bindTexture(gl.TEXTURE_2D, this.tex.segData);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    // 花纹的两张纹理也先放一个空纹素（没有花纹时合成程序照样绑着它们）
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fxPal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    // 河的图层、离边界远的格也先放一个空纹素
    for (const t of [this.tex.river, this.tex.near]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    // 切线：长方形的四个角（每个顶点一个），与每段的实例数据：10 个数（aSeg 4、aNb 4、aEnds 2）
    this.seamVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.seamVao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2, 3]), gl.STATIC_DRAW);
    const cornerLoc = gl.getAttribLocation(this.progSeam, 'aCorner');
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 1, gl.FLOAT, false, 0, 0);
    this.seamBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seamBuf);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.progSeam, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr('aSeg', 4, 0);
    attr('aNb', 4, 16);
    attr('aEnds', 2, 32);
    gl.bindVertexArray(null);
  }

  protected loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.locs.get(p);
    if (!m) this.locs.set(p, (m = new Map()));
    let l = m.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p, name);
      m.set(name, l);
    }
    return l;
  }

  // 这张纹理传上去的还是不是这几个数组；不是时记下新的，返回 true（调用方去上传）
  protected fresh(slot: string, ...deps: unknown[]): boolean {
    const was = this.shownDeps[slot];
    if (was && was.length === deps.length && was.every((d, k) => d === deps[k])) return false;
    this.shownDeps[slot] = deps;
    return true;
  }

  protected makeTex(linear = false): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  protected makeVao(pos: Float32Array, cell: Float32Array, bary: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attr = (loc: number, data: Float32Array, size: number) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attr(0, pos, 2);
    attr(1, cell, 1);
    attr(2, bary, 3);
    gl.bindVertexArray(null);
    return vao;
  }

  // 峡湾纹理（第三十六轮）：整行的 RGBA32F（core/fjords.ts 的 fjordLayer）；同一份不重新上传，没有时一个 0 的 texel
  protected fjShown: Float32Array | null | undefined = undefined;
  protected uploadFj(data: Float32Array | null) {
    if (data === this.fjShown) return;
    this.fjShown = data;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fj);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const d = data && data.length >= 4 * TEX_W ? data : new Float32Array(4 * TEX_W);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, d.length / (4 * TEX_W), 0, gl.RGBA, gl.FLOAT, d);
  }

  protected upload(tex: WebGLTexture, data: Uint8Array | Float32Array, n: number, channels: 1 | 2 | 4) {
    const gl = this.gl;
    const rows = Math.ceil(n / TEX_W);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (data instanceof Float32Array) {
      const padded = new Float32Array(TEX_W * rows * channels);
      padded.set(data.subarray(0, n * channels));
      if (channels === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, TEX_W, rows, 0, gl.RED, gl.FLOAT, padded);
      else if (channels === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_W, rows, 0, gl.RG, gl.FLOAT, padded);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, padded);
    } else {
      const padded = new Uint8Array(TEX_W * rows * 4);
      padded.set(data.subarray(0, n * 4));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEX_W, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, padded);
    }
  }

  // 高程纹理（两个通道：高程、水面的高程）的打包：setLayers 的一份与幽灵用的一份
  protected elevPack = new Float32Array(0);
  protected elevGhost: Float32Array | null = null;
  // 海岸值纹理（海岸值、破碎度）的打包：同上
  protected coastPack = new Float32Array(0);
  protected coastGhost: Float32Array | null = null;
  // 合成着色器读的海岸值、破碎度（两个通道）：同上
  protected cellCoastPack = new Float32Array(0);
  protected cellCoastGhost: Float32Array | null = null;

  // 只上传这几行（每行 TEX_W 格；连着的几行一次传）
  protected uploadRows(tex: WebGLTexture, data: Uint8Array | Float32Array, rows: number[], channels: 1 | 2 | 4) {
    if (!rows.length) return;
    const gl = this.gl;
    const per = TEX_W * channels;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let k = 0; k < rows.length; ) {
      const r = rows[k];
      let r1 = r + 1;
      while (k + 1 < rows.length && rows[k + 1] === r1) {
        k++;
        r1++;
      }
      k++;
      // 最后一行不满时补齐
      let src: Uint8Array | Float32Array = data.subarray(r * per, Math.min(data.length, r1 * per));
      if (src.length < (r1 - r) * per) {
        const padded = data instanceof Float32Array ? new Float32Array((r1 - r) * per) : new Uint8Array((r1 - r) * per);
        padded.set(src);
        src = padded;
      }
      if (channels === 1) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RED, gl.FLOAT, src);
      else if (channels === 2) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RG, gl.FLOAT, src);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RGBA, data instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE, src);
    }
  }

  // 只上传与现在显示的不同的那些行（每行 TEX_W 格）：涂省、剪刀每动一下只改一小片
  protected uploadChanged(tex: WebGLTexture, before: Float32Array | Uint8Array, after: Float32Array | Uint8Array, channels: 2 | 4) {
    const gl = this.gl;
    const n = this.mesh?.n ?? 0;
    const rows = Math.ceil(n / TEX_W);
    const per = TEX_W * channels;
    const differs = (r: number) => {
      const end = Math.min(n * channels, (r + 1) * per);
      for (let k = r * per; k < end; k++) if (before[k] !== after[k]) return true;
      return false;
    };
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let r = 0; r < rows; ) {
      if (!differs(r)) {
        r++;
        continue;
      }
      let r1 = r + 1;
      while (r1 < rows && differs(r1)) r1++;
      // 最后一行不满时补齐
      let src: Float32Array | Uint8Array = after.subarray(r * per, Math.min(after.length, r1 * per));
      if (src.length < (r1 - r) * per) {
        const padded = after instanceof Float32Array ? new Float32Array((r1 - r) * per) : new Uint8Array((r1 - r) * per);
        padded.set(src);
        src = padded;
      }
      if (channels === 2) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RG, gl.FLOAT, src);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RGBA, gl.UNSIGNED_BYTE, src);
      r = r1;
    }
  }

  // 河的图层：换了画布或版本才上传（上下翻转、预乘 alpha：线性插值时透明处不发黑，合成按预乘混）
  protected useRiver(r: RiverTex | null): RiverTex | null {
    if (!r) return null;
    const s = this.riverShown;
    if (s && s.source === r.source && s.version === r.version) return r;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.river);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, r.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.riverShown = { source: r.source, version: r.version };
    return r;
  }

  // 地图单位 → 裁剪空间（停稳：与画布一样大的目标）
  protected viewUniform(): V4 {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = w / this.canvas.clientWidth || 1;
    const z = this.camera.zoom * dpr;
    const sx = (2 * z) / w;
    const sy = (-2 * z) / h;
    return [sx, sy, -this.camera.x * sx, -this.camera.y * sy];
  }

  protected makeTarget(): SceneTarget {
    const gl = this.gl;
    return {
      w: 0,
      h: 0,
      fbo: gl.createFramebuffer()!,
      fboId: gl.createFramebuffer()!,
      fboSeam: gl.createFramebuffer()!,
      color: this.makeTex(true),
      height: this.makeTex(),
      id: this.makeTex(),
      seam: this.makeTex(),
      depth: gl.createRenderbuffer()!,
    };
  }

  // 一组场景目标按大小分配；大小变了返回 true
  protected sizeTarget(t: SceneTarget, w: number, h: number): boolean {
    const gl = this.gl;
    if (t.w === w && t.h === h) return false;
    t.w = w;
    t.h = h;
    gl.bindTexture(gl.TEXTURE_2D, t.color);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, t.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, t.id);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, t.height, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboId);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.id, 0);
    // 切线层：段号与哪一边（RGBA8），深度 = 到段的距离 / 带宽
    gl.bindTexture(gl.TEXTURE_2D, t.seam);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboSeam);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.seam, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  // 放大后晕渲不必夸张那么多：一格 8 像素以内照旧，越放大越缓（一格 64 像素时约一半）
  protected reliefNow(): number {
    return this.reliefAt(this.planet ? effectiveZoom(this.camera) : this.camera.zoom);
  }
  protected reliefAt(zoom: number): number {
    const cellCss = this.mesh!.spacing * zoom;
    return this.relief / (1 + 0.4 * Math.max(0, Math.log2(cellCss / 8)));
  }

  // 整个星球：屏幕上看得见的那几份副本（x 平移 2 的倍数）。halfW：画面的半宽（地图单位）
  protected copiesFor(camX: number, halfW: number): [number, number] {
    if (!this.planet) return [0, 1];
    const copy0 = Math.ceil((camX - halfW - this.xRange[1]) / 2);
    const copy1 = Math.floor((camX + halfW - this.xRange[0]) / 2);
    return [copy0, Math.max(1, Math.min(7, copy1 - copy0 + 1))];
  }

  // ---------- 导出整张地图（.png）：离屏一块块画，读回像素 ----------

  // 一块场景（T + 2m）最大多少像素：纹理、渲染缓冲、视口的上限里最小的
  exportLimit(): number {
    const gl = this.gl;
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, vp[0], vp[1]);
  }

  // 导出用的一组场景目标与合成画面（画完 releaseExport 放掉）
  protected exp: { scene: SceneTarget; fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;

  protected bindTex(prog: WebGLProgram, name: string, tex: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.loc(prog, name), unit);
  }
}
