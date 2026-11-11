import { mapStyleKey } from '../../core/map-style';
import type { Mesh } from '../../core/mesh';
import { effectiveZoom, planeBounds, sceneNeed, screenToWorld as projScreenToWorld, worldToScreen as projWorldToScreen } from './projection';
import { type Camera, type V4, type ProjScene, type ProjCompose, PROJ_BG, planScene, sceneFits, SETTLE_MS, MOTION_SCALE, MOTION_MARGIN, MOTION_MAX_ZOOM_IN } from './renderer-parts';
import { RendererExport } from './renderer-export';
export { styleUniforms } from './style-uniforms';
export type { StyleUniforms } from './style-uniforms';
export { packElevation, packCoast, packCellCoast, FOCUS_REACH, planScene, sceneFits, SETTLE_MS } from './renderer-parts';
export type { Camera, CellLayers, RiverTex, ProjScene, RiverScene } from './renderer-parts';

// WebGL2 渲染：
//   1. 编号层：Voronoi 多边形写入每个像素属于哪一格
//   2. 地形层：Delaunay 三角形（不共享顶点，带重心坐标）。颜色、高程、海岸值、坡度在三角形内插值；
//      格以下补海岸细节与沿坡向的冲沟纹理（噪声在格中心为 0，陆海与模拟一致）→ 离屏的颜色、高度、坡度。
//      陆地像素只用陆色、水面像素只用水色（每格另带一份“对岸的颜色”），颜色不跨海岸互相渗；
//      晕渲的大尺度坡度用插值后的格坡度，没有三角形折面；海岸线在这里画成抗锯齿的细线
//   3. 切线层：剪刀切省时画的线（core/seams.ts）。每段一个长方形，像素写入离它最近的那一段与在线的哪一边
//      （深度 = 距离 / 带宽，近的胜）
//   4. 合成：晕渲、陡坡露岩、两种风格；按扭曲后的坐标取格，画分类平涂（主导生态、省份）、
//      分组边界（省份）、高亮与轮廓。边界因此是自然的曲线而不是六边形；切线附近按在线的哪一边换格，省界就是画的线
// 1、2 只在镜头、图层、窗口大小变了时重画，3 另外在切线变了时重画；鼠标移动、高亮变化只重画合成层。
// 海岸噪声与 core/subcell.ts 逐位一致，导出的位图与屏幕一致。
// 着色器源码在 shaders/（第四十一轮拆出来）：common 片段、plane 平面的程序、compose 合成、sphere 星球 / 极地 / 投影

export type { MapStyle } from '../../core/map-style';

export class Renderer extends RendererExport {
  // 第九十六轮：WebGL 的上下文丢了又恢复以后（webglcontextrestored）——GPU 上的东西（程序、纹理、缓冲、渲染目标）全没了。
  // 在同一个对象上从头来一遍：新建一个渲染器（同一块画布上拿到的就是恢复了的上下文；构造时把资源都建好），把它的全部状态换进来——
  // “传过没有、画过没有”的记号一个不留，和刚打开页面时一样。外面拿着这个对象的（导出、window.__map2、工具）不用换。
  // 镜头、画风这些设置照旧；网格、图层、高亮、预览由调用方（ui/MapView.tsx）照平常的路重新给一遍。
  // 画法没有动：之后的每一帧走的还是原来的那几个函数，所以和丢之前逐像素相同（冒烟里比）
  revive() {
    if (this.rhoTimer) clearTimeout(this.rhoTimer);
    if (this.nearTimer) clearTimeout(this.nearTimer);
    const keep = {
      camera: this.camera,
      relief: this.relief,
      detail: this.detail,
      provinceScale: this.provinceScale,
      style: this.style,
      riverLayer: this.riverLayer,
      flatByGroup: this.flatByGroup,
      highlightByGroup: this.highlightByGroup,
      provinceAlpha: this.provinceAlpha,
      countryAlpha: this.countryAlpha,
      // 移动中的场景的编号只增不减（叠加层按它认缓存）
      motionEpoch: this.motionEpoch + 1,
      perf: this.perf,
    };
    Object.assign(this, new Renderer(this.canvas), keep);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // 画一帧。镜头在 SETTLE_MS 之内动过时按移动中的画法画（低分辨率，平移时挪用带边距的场景），返回 true：
  // 调用方要在 SETTLE_MS 之后再画一次，那时按停稳的画法补上全分辨率的（与原来逐像素相同）。
  // still：不管镜头动没动都按停稳的画法画（导出图片、截图）
  render(kmPerUnit: number, opts: { still?: boolean } = {}): boolean {
    const mesh = this.mesh;
    if (!mesh || !this.triVao || !this.fanVao) return false;
    this.resize();
    const cam = this.camera;
    const proj = this.planet ? cam.proj : undefined;
    const camKey = `${cam.x}|${cam.y}|${cam.zoom}${proj ? `|${proj.kind}|${proj.lon0}|${proj.lat0}` : ''}`;
    const now = performance.now();
    if (camKey !== this.lastCam) {
      if (this.lastCam) this.movedAt = now;
      this.lastCam = camKey;
    }
    // 等面积、球形投影：另一条路（场景按需要的范围、密度画，合成时反算投影）
    if (proj) {
      const moving = !opts.still && now - this.movedAt < SETTLE_MS;
      this.justSettled = this.wasMoving && !moving && !opts.still;
      if (!opts.still) this.wasMoving = moving;
      this.renderProjected(kmPerUnit, moving);
      return moving;
    }
    if (this.projT) this.leaveProjected();
    if (!opts.still && now - this.movedAt < SETTLE_MS) {
      this.renderMoving(kmPerUnit);
      this.wasMoving = true;
      this.justSettled = false;
      return true;
    }
    // 导出、截图（still）不算停下：真正停下的那一帧照样分两帧补画
    this.justSettled = this.wasMoving && !opts.still;
    if (!opts.still) this.wasMoving = false;
    this.renderStill(kmPerUnit);
    return false;
  }

  // 停稳的画法：画布大小的场景，编号层只在网格、画布、镜头变了时重画，地形层另在图层变了时重画
  // （只有幽灵海岸改了几格时只重画那几格的三角形盖住的一块），切线层在切线变了时重画；合成每次重画
  protected renderStill(kmPerUnit: number) {
    const gl = this.gl;
    const mesh = this.mesh!;
    const t = this.rest;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.sizeTarget(t, w, h);
    const view = this.viewUniform();
    const cam = this.camera;
    const dpr = w / this.canvas.clientWidth || 1;
    const relief = this.reliefNow();
    // 幽灵海岸带着将来的海岸细节幅度（拖海岸曲折时）
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    // 带上 dpr：页面缩放变了而画布像素数没变（CSS 大小跟着反过来变）时也要重画
    const idKey = `${this.meshVersion}|${w}x${h}|${dpr}|${cam.x}|${cam.y}|${cam.zoom}`;
    const terrainStatic = `${idKey}|${this.detail}|${coastAmp}|${kmPerUnit}`;
    const terrainKey = `${terrainStatic}|${this.layersVersion}`;
    const halfW = this.canvas.clientWidth / 2 / cam.zoom;
    const [copy0, copies] = this.copiesFor(cam.x, halfW);
    // 切线层：镜头、窗口、切线变了才重画
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const seamKey = hasSeams ? `${w}x${h}|${dpr}|${cam.x}|${cam.y}|${cam.zoom}|${this.seamVersion}` : '';
    // 河的图层：停稳的那张（刚停下的那一帧就画好：照用移动中的那张的话，下一帧换上停稳的那张时要整张再合成一次，比画河慢得多）
    const river = this.riverLayer?.(false) ?? null;
    const riverKey = river ? `${river.version}|${river.toUv.join(',')}` : '';
    // 描格不在键里（第三十九轮）：鼠标跨格时只重画描格那几块（composeFocus）
    const composeKey = `${terrainKey}|${seamKey}|${this.highlightVersion}|${this.groupVersion}|${this.modeVersion}|${this.fxVersion}|${this.tintVersion}|${mapStyleKey(this.style)}|${relief}|${this.flatByGroup}|${this.highlightByGroup}|${this.provinceScale}|${this.provinceAlpha}|${this.countryAlpha}|${riverKey}`;
    const cellPx = mesh.spacing * cam.zoom * dpr;
    // 画面没有任何变化：画布保留着上一帧（preserveDrawingBuffer），什么都不用画；只有描格变了时只补那几块
    if (composeKey === this.composeKey) {
      if (this.focusKey !== this.focusDrawn.key) {
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, w, h);
        this.composeFocus(this.focusRects(view, w, h, null), (rects) => this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], cellPx, 1, 1, relief, hasSeams, this.useRiver(river), null, rects));
      } else this.perf?.note('compose:none');
      return;
    }
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, w, h);
    if (idKey !== this.idKey) {
      this.idKey = idKey;
      this.drawId(t, view, copy0, copies);
    }
    if (terrainKey !== this.terrainKey) {
      const rects = terrainStatic === this.terrainStatic && this.dirtyCells !== 'full' ? this.dirtyRects(this.dirtyCells, view, w, h) : null;
      this.terrainKey = terrainKey;
      this.terrainStatic = terrainStatic;
      this.dirtyCells = new Set();
      this.perf?.note(rects ? 'terrain:rects' : 'terrain:full');
      this.drawTerrain(t, view, 1 / (cam.zoom * dpr), copy0, copies, coastAmp, kmPerUnit, rects);
    }
    if (hasSeams && seamKey !== this.seamKey) {
      this.seamKey = seamKey;
      this.drawSeams(t, view, cam.x, halfW);
    }
    this.composeKey = composeKey;
    this.perf?.note('compose:full');
    this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], cellPx, 1, 1, relief, hasSeams, this.useRiver(river));
    this.focusDrawn = { key: this.focusKey, rects: this.focusRects(view, w, h, null) };
  }

  // 移动中的画法：场景按 MOTION_SCALE 的分辨率、四周各多画 MOTION_MARGIN 画在另一组目标上；镜头还在边距之内、
  // 放大不到 MOTION_MAX_ZOOM_IN 倍、输入没变时不重画场景，只按新镜头合成（平移、小幅缩放就是挪一挪、缩一缩那张场景）。
  // 合成也按低分辨率画，再放大拷到画布上
  protected renderMoving(kmPerUnit: number) {
    const gl = this.gl;
    const mesh = this.mesh!;
    const cam = this.camera;
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = w / cw || 1;
    // 合成画面与场景的大小（像素），k：一个 CSS 像素合几个这样的像素
    const k = dpr * MOTION_SCALE;
    const ow = Math.max(1, Math.round(cw * k));
    const oh = Math.max(1, Math.round(ch * k));
    const sw = Math.round(ow * (1 + 2 * MOTION_MARGIN));
    const sh = Math.round(oh * (1 + 2 * MOTION_MARGIN));
    if (this.sizeTarget(this.moving, sw, sh)) this.movingScene = null;
    if (this.out.w !== ow || this.out.h !== oh) {
      this.out.w = ow;
      this.out.h = oh;
      gl.bindTexture(gl.TEXTURE_2D, this.out.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out.tex, 0);
    }
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const key = `${this.meshVersion}|${sw}x${sh}|${k}|${this.layersVersion}|${this.detail}|${coastAmp}|${kmPerUnit}|${hasSeams ? this.seamVersion : -1}`;
    gl.disable(gl.BLEND);
    let sc = this.movingScene;
    // 现在的画面（地图单位的半宽、半高）是否还在场景里
    const fits = (c: Camera) => {
      const z = c.zoom * k;
      return cam.zoom / c.zoom <= MOTION_MAX_ZOOM_IN && Math.abs(cam.x - c.x) + cw / 2 / cam.zoom <= sw / 2 / z && Math.abs(cam.y - c.y) + ch / 2 / cam.zoom <= sh / 2 / z;
    };
    if (!sc || sc.key !== key || !fits(sc.cam)) {
      sc = { cam: { ...cam }, key };
      this.movingScene = sc;
      this.motionEpoch++;
      const z = cam.zoom * k;
      const sx = (2 * z) / sw;
      const sy = (-2 * z) / sh;
      const view: V4 = [sx, sy, -cam.x * sx, -cam.y * sy];
      const halfW = sw / 2 / z;
      const [copy0, copies] = this.copiesFor(cam.x, halfW);
      gl.viewport(0, 0, sw, sh);
      this.drawId(this.moving, view, copy0, copies);
      this.drawTerrain(this.moving, view, 1 / z, copy0, copies, coastAmp, kmPerUnit, null);
      if (hasSeams) this.drawSeams(this.moving, view, cam.x, halfW);
    }
    // 合成：画面上的位置（0–1）→ 场景上的位置
    const c0 = sc.cam;
    const z0 = c0.zoom * k;
    const z1 = cam.zoom * k;
    const ax = (ow / z1) * (z0 / sw);
    const ay = (oh / z1) * (z0 / sh);
    const xf: V4 = [ax, ay, ((cam.x - c0.x) * z0) / sw - 0.5 * ax + 0.5, 0.5 - ((cam.y - c0.y) * z0) / sh - 0.5 * ay];
    const sx = (2 * z1) / ow;
    const sy = (-2 * z1) / oh;
    const view: V4 = [sx, sy, -cam.x * sx, -cam.y * sy];
    gl.viewport(0, 0, ow, oh);
    const river = this.useRiver(this.riverLayer?.(true) ?? null);
    this.compose(this.out.fbo, this.moving, view, xf, [1 / ow, 1 / oh], mesh.spacing * z1, w / ow, (z1 / z0) * (w / ow), this.reliefNow(), hasSeams, river);
    // 放大拷到画布上
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.out.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, ow, oh, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 停下来时一定按停稳的画法重画
    this.composeKey = '';
  }

  // 现在的投影场景（开发用的测速、测试看）
  get projectedScene(): ProjScene | null {
    return this.projScene;
  }

  // 回到等距圆柱：放掉投影的场景
  protected leaveProjected() {
    if (this.projT) this.sizeTarget(this.projT, 1, 1);
    this.projScene = null;
    this.pIdKey = this.pTerrainKey = this.pTerrainStatic = this.pSeamKey = this.pComposeKey = '';
  }

  // 投影的画法：要的范围、密度（sceneNeed）→ 现在的场景还能用就只重新合成（转动球、平移时多半如此），
  // 不能用就按要的重画一块（移动中密度打五折、四周多画一圈）。合成按每个像素反算投影；移动中按低分辨率合成再放大
  protected renderProjected(kmPerUnit: number, moving: boolean) {
    const gl = this.gl;
    const mesh = this.mesh!;
    const cam = this.camera;
    const proj = cam.proj!;
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = w / cw || 1;
    // 等距圆柱的两组场景先放掉（占显存）；回到等距圆柱时重新分配、重画
    if (this.rest.w > 1 || this.moving.w > 1) {
      this.sizeTarget(this.rest, 1, 1);
      this.sizeTarget(this.moving, 1, 1);
      this.movingScene = null;
      this.idKey = this.terrainKey = this.terrainStatic = this.seamKey = this.composeKey = '';
    }
    this.projT ??= this.makeTarget();
    const t = this.projT;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const need = sceneNeed({ ...cam, proj }, cw, ch, 3 * mesh.spacing);
    let sc = this.projScene;
    if (need) {
      const dn = { ...need, zx: need.zx * dpr, zy: need.zy * dpr };
      if (!sc || !sceneFits(sc, dn, moving ? 0.45 : 0.9, moving ? Infinity : 2.2)) {
        const limit = Math.min(this.exportLimit(), 8192);
        const budget = Math.min(8e6, Math.max(2.5e6, 1.3 * w * h)) * (moving ? 0.5 : 1);
        sc = planScene(dn, moving ? 0.5 : 1, moving ? MOTION_MARGIN : 0.1, limit, budget);
        this.projScene = sc;
        this.motionEpoch++;
      }
    }
    if (sc) this.drawProjScene(t, sc, kmPerUnit, hasSeams, false);
    // 合成
    const k = moving ? dpr * MOTION_SCALE : dpr;
    const ow = moving ? Math.max(1, Math.round(cw * k)) : w;
    const oh = moving ? Math.max(1, Math.round(ch * k)) : h;
    const z1 = cam.zoom * k;
    const sx = (2 * z1) / ow;
    const sy = (-2 * z1) / oh;
    const view: V4 = [sx, sy, -cam.x * sx, -cam.y * sy];
    const relief = this.reliefAt(effectiveZoom(cam));
    const river = sc ? (this.riverLayer?.(moving, { x0: sc.x0, y0: sc.y0, zx: sc.zx, zy: sc.zy, W: sc.W, H: sc.H, dpr, pole: sc.pole, key: sc.key }) ?? null) : null;
    const riverKey = river ? `${river.version}|${river.toUv.join(',')}` : '';
    const pj: ProjCompose | null = sc ? { proj, scene: sc, planePx: z1, outside: PROJ_BG } : null;
    if (!moving) {
      // 描格不在键里（第三十九轮）：变了时只重画那几块
      const key = `${this.pTerrainKey}|${this.pSeamKey}|${sc?.key}|${w}x${h}|${dpr}|${cam.x}|${cam.y}|${cam.zoom}|${proj.kind}|${proj.lon0}|${proj.lat0}|${this.highlightVersion}|${this.groupVersion}|${this.modeVersion}|${this.fxVersion}|${this.tintVersion}|${mapStyleKey(this.style)}|${relief}|${this.flatByGroup}|${this.highlightByGroup}|${this.provinceScale}|${this.provinceAlpha}|${this.countryAlpha}|${riverKey}`;
      if (key === this.pComposeKey) {
        if (this.focusKey !== this.focusDrawn.key) {
          if (!pj) {
            this.focusDrawn = { key: this.focusKey, rects: [] };
            return;
          }
          gl.disable(gl.BLEND);
          gl.viewport(0, 0, w, h);
          this.composeFocus(this.focusRects(view, w, h, pj), (rects) => this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], 0, 1, 1, relief, hasSeams, this.useRiver(river), pj, rects));
        } else this.perf?.note('compose:none');
        return;
      }
      this.pComposeKey = key;
      this.perf?.note('compose:full');
    } else this.pComposeKey = '';
    if (!sc) {
      // 画面上没有地图（镜头在投影外面）：只有背景
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(PROJ_BG[0], PROJ_BG[1], PROJ_BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.focusDrawn = { key: this.focusKey, rects: [] };
      return;
    }
    if (!pj) return;
    if (moving) {
      if (this.out.w !== ow || this.out.h !== oh) {
        this.out.w = ow;
        this.out.h = oh;
        gl.bindTexture(gl.TEXTURE_2D, this.out.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out.tex, 0);
      }
      gl.viewport(0, 0, ow, oh);
      this.compose(this.out.fbo, t, view, [1, 1, 0, 0], [1 / ow, 1 / oh], 0, w / ow, 1, relief, hasSeams, this.useRiver(river), pj);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.out.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, ow, oh, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.viewport(0, 0, w, h);
    this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], 0, 1, 1, relief, hasSeams, this.useRiver(river), pj);
    this.focusDrawn = { key: this.focusKey, rects: this.focusRects(view, w, h, pj) };
  }

  // 屏幕坐标（CSS 像素，相对画布）→ 地图单位
  // 屏幕坐标（CSS 像素，相对画布）→ 地图单位。投影时在投影之外给最近的边上的一点（是不是在地图上看 pick）
  screenToWorld(px: number, py: number): [number, number] {
    const c = this.camera;
    if (this.planet && c.proj) {
      const p = projScreenToWorld(c, this.canvas.clientWidth, this.canvas.clientHeight, px, py);
      return [p.x, p.y];
    }
    return [c.x + (px - this.canvas.clientWidth / 2) / c.zoom, c.y + (py - this.canvas.clientHeight / 2) / c.zoom];
  }

  // 屏幕上的一点在不在投影之内（等距圆柱时总是 true，南北、东西之内由调用方另看）
  onProjection(px: number, py: number): boolean {
    const c = this.camera;
    return !(this.planet && c.proj) || projScreenToWorld(c, this.canvas.clientWidth, this.canvas.clientHeight, px, py).inside;
  }

  // 地图单位 → 屏幕坐标；投影时球的背面给 NaN
  worldToScreen(x: number, y: number): [number, number] {
    const c = this.camera;
    if (this.planet && c.proj) return projWorldToScreen(c, this.canvas.clientWidth, this.canvas.clientHeight, x, y) ?? [Number.NaN, Number.NaN];
    return [(x - c.x) * c.zoom + this.canvas.clientWidth / 2, (y - c.y) * c.zoom + this.canvas.clientHeight / 2];
  }

  // 整张图放进画布；inset：四周被浮层挡住、要留出来的边（CSS 像素）。投影时放进的是投影的整个形状（朝向不变）
  fit(mesh: Mesh, inset = { top: 0, right: 0, bottom: 0, left: 0 }) {
    const cw = Math.max(100, (this.canvas.clientWidth || 800) - inset.left - inset.right);
    const ch = Math.max(100, (this.canvas.clientHeight || 600) - inset.top - inset.bottom);
    const proj = mesh.kind === 'sphere' ? this.camera.proj : undefined;
    if (proj) {
      const [u0, u1, v0, v1] = planeBounds(proj);
      const zoom = Math.min(cw / (u1 - u0), ch / (v1 - v0)) * 0.98;
      this.camera = { x: (u0 + u1) / 2 - (inset.left - inset.right) / 2 / zoom, y: (v0 + v1) / 2 - (inset.top - inset.bottom) / 2 / zoom, zoom, proj };
      return;
    }
    const zoom = Math.min(cw / mesh.width, ch / mesh.height) * 0.98;
    this.camera = {
      x: mesh.width / 2 - (inset.left - inset.right) / 2 / zoom,
      y: mesh.height / 2 - (inset.top - inset.bottom) / 2 / zoom,
      zoom,
    };
  }
}
