// 渲染器画各层（第八十三轮从 src/render/renderer.ts 原样搬出）：编号层、地形层、切线层、合成；极地与投影的程序和场景；描格、要重画的那几块
import { fromUnit } from '../../core/geo';
import { worldToScreen as projWorldToScreen } from './projection';
import { FS_ID, FS_SEAM } from './shaders/plane';
import { FS_COMPOSE_PROJ, FS_TERRAIN_POLAR, VS_CELL_POLAR, VS_ID_POLAR, VS_SEAM_POLAR } from './shaders/sphere';
import { styleUniforms } from './style-uniforms';
import { compileCompose, compile, FOCUS_REACH, type RiverTex, type V4, type Rect, type ProjScene, type ProjCompose, POLAR_REACH, type SceneTarget, pixelRect, mergeRects } from './renderer-parts';
import { RendererLayers } from './renderer-layers';

export abstract class RendererDraw extends RendererLayers {
  // 描格那一遍（第三十九轮）：画布上别处与上一次整张合成的相同，只有新旧描格的几块要重画。在这几块里（scissor）照原样再合成一次：
  // 同一个着色器、同样的输入（描格的 uniform 换成新的），每个像素的结果与整张重画逐字节相同（tools/compose-ab.mjs 在无头 Chrome 里对照）
  protected composeFocus(rects: Rect[], draw: (rects: Rect[]) => void) {
    const all = mergeRects([...this.focusDrawn.rects, ...rects]);
    this.focusDrawn = { key: this.focusKey, rects };
    if (!all.length) return;
    this.perf?.note('compose:focus');
    draw(all);
  }

  // 描格的格（鼠标下的、钉住的）离格心 FOCUS_REACH 格以内的像素（着色器的 nearFocus）在画面上的几块（设备像素，GL 的 y 向上；
  // 四周多留几个像素，边落在偶数上：2×2 一组的像素整组都在里面，fwidth 与整张画时相同）。pj：投影
  protected focusRects(view: V4, w: number, h: number, pj: ProjCompose | null): Rect[] {
    const mesh = this.mesh;
    const out: Rect[] = [];
    if (!mesh) return out;
    const r = FOCUS_REACH * mesh.spacing;
    for (const f of this.focus) {
      if (!f || f.cell >= mesh.n) continue;
      const cx = mesh.x[f.cell];
      const cy = mesh.y[f.cell];
      if (pj) {
        out.push(...this.projFocusRects(cx, cy, r, w, h));
        continue;
      }
      const px = (x: number) => (x * view[0] + view[2] + 1) * 0.5 * w;
      const py = (y: number) => (y * view[1] + view[3] + 1) * 0.5 * h;
      if (!this.planet) {
        out.push(...pixelRect(px(cx - r), px(cx + r), py(cy + r), py(cy - r), w, h));
        continue;
      }
      // 整个星球：按球面上的弦长（着色器的 nearFocus：弦长 < π · r）→ 角半径 θ；包着极点时整行，否则经度最多差 asin(sin θ / sin 余纬)。
      // 南北在地图之外（y < 0、> 1）的像素没有格，不描
      const th = 2 * Math.asin(Math.min(1, (Math.PI * r) / 2));
      const y0 = Math.max(0, cy - th / Math.PI);
      const y1 = Math.min(1, cy + th / Math.PI);
      const s = Math.sin(Math.PI * cy);
      const pole = y0 <= 0 || y1 >= 1 || Math.sin(th) >= s;
      if (pole) {
        out.push(...pixelRect(0, w, py(y1), py(y0), w, h));
        continue;
      }
      const dx = (Math.asin(Math.sin(th) / s) / Math.PI) * 1.01 + 1e-6;
      // 每一份副本（左右相隔 2）
      const left = (-1 - view[2]) / view[0];
      const right = (1 - view[2]) / view[0];
      for (let k = Math.ceil((left - cx - dx) / 2); k <= Math.floor((right - cx + dx) / 2) && out.length < 16; k++) {
        out.push(...pixelRect(px(cx + 2 * k - dx), px(cx + 2 * k + dx), py(y1), py(y0), w, h));
      }
    }
    return out;
  }

  // 投影：沿球面上的那一圈（角半径略大一点）取 64 个点投到画面上，外接矩形再加相邻两点的间距；
  // 有点在球的背面、跨过等面积投影的边（相邻两点在画面上隔得很远）时整张
  protected projFocusRects(cx: number, cy: number, r: number, w: number, h: number): Rect[] {
    const th = 2 * Math.asin(Math.min(1, (Math.PI * r) / 2)) * 1.02;
    const full: Rect[] = [[0, 0, w, h]];
    if (th >= Math.PI / 2) return full;
    const lon = Math.PI * (cx - 1);
    const colat = Math.PI * Math.min(1, Math.max(0, cy));
    const C = [Math.sin(colat) * Math.cos(lon), Math.sin(colat) * Math.sin(lon), Math.cos(colat)];
    // 切平面里的两个方向（极点上随便取一个东）
    const E = Math.sin(colat) > 1e-9 ? [-Math.sin(lon), Math.cos(lon), 0] : [0, 1, 0];
    const N = [C[1] * E[2] - C[2] * E[1], C[2] * E[0] - C[0] * E[2], C[0] * E[1] - C[1] * E[0]];
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const dpr = w / cw;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let gap = 0;
    let prev: [number, number] | null = null;
    const K = 64;
    for (let k = 0; k <= K; k++) {
      const a = (2 * Math.PI * k) / K;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const P = [0, 1, 2].map((i) => Math.cos(th) * C[i] + Math.sin(th) * (ca * E[i] + sa * N[i]));
      const x = 1 + Math.atan2(P[1], P[0]) / Math.PI;
      const y = Math.acos(Math.max(-1, Math.min(1, P[2]))) / Math.PI;
      const sp = projWorldToScreen(this.camera, cw, ch, x, y);
      if (!sp || !Number.isFinite(sp[0]) || !Number.isFinite(sp[1])) return full;
      const q: [number, number] = [sp[0] * dpr, h - sp[1] * dpr];
      if (prev) gap = Math.max(gap, Math.hypot(q[0] - prev[0], q[1] - prev[1]));
      prev = q;
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    if (gap > Math.min(w, h) / 4) return full;
    return pixelRect(x0 - gap, x1 + gap, y0 - gap, y1 + gap, w, h);
  }

  // ---------- 等面积、球形投影（第十三轮 G4） ----------

  // 极地的场景的程序（第一次用到时才编译）
  protected polarPrograms() {
    if (!this.polarProgs) {
      const gl = this.gl;
      const seam = compile(gl, VS_SEAM_POLAR, FS_SEAM);
      this.polarProgs = { id: compile(gl, VS_ID_POLAR, FS_ID), terrain: compile(gl, VS_CELL_POLAR, FS_TERRAIN_POLAR), seam };
      // 切线的实例数据按名字找位置：极地的程序与平面的程序要一致（同一个 VAO）
      for (const name of ['aCorner', 'aSeg', 'aNb', 'aEnds']) {
        if (gl.getAttribLocation(seam, name) !== gl.getAttribLocation(this.progSeam, name)) throw new Error(`切线的属性位置不一致：${name}`);
      }
    }
    return this.polarProgs;
  }

  // 球面上真实的三角形（地形层）与 Voronoi 多边形（编号层，从格中心到相邻两个三角形的外心扇形三角化），顶点是世界坐标。
  // 只要离这一极 POLAR_REACH 以内的（另一极附近在这个平面上是一圈，那里的三角形会横跨整个平面）；按网格、按极缓存
  protected polarGeometry(pole: 1 | -1) {
    const mesh = this.mesh!;
    if (this.polarGeom?.mesh !== mesh) {
      if (this.polarGeom) {
        for (const g of [this.polarGeom.north, this.polarGeom.south]) {
          if (!g) continue;
          this.gl.deleteVertexArray(g.tri);
          this.gl.deleteVertexArray(g.fan);
        }
      }
      this.polarGeom = { mesh, north: null, south: null };
    }
    const cached = pole > 0 ? this.polarGeom.north : this.polarGeom.south;
    if (cached) return cached;
    if (mesh.kind !== 'sphere') throw new Error('只有整个星球有极地的场景');
    const far = (y: number) => (pole > 0 ? y : 1 - y) > POLAR_REACH;
    const tris = mesh.triangles;
    const tp: number[] = [];
    const tc: number[] = [];
    const tb: number[] = [];
    for (let t = 0; t + 2 < tris.length; t += 3) {
      if (far(mesh.y[tris[t]]) || far(mesh.y[tris[t + 1]]) || far(mesh.y[tris[t + 2]])) continue;
      for (let k = 0; k < 3; k++) {
        const c = tris[t + k];
        tp.push(mesh.x[c], mesh.y[c]);
        tc.push(c);
        tb.push(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
      }
    }
    const P = mesh.p;
    const fp: number[] = [];
    const fc: number[] = [];
    const order: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      if (far(mesh.y[i])) continue;
      const a = mesh.off[i];
      const b = mesh.off[i + 1];
      // 邻格按方向（本格切平面里的东、南）排一圈
      order.length = 0;
      for (let k = a; k < b; k++) order.push(k);
      order.sort((u, v) => Math.atan2(mesh.edy[u], mesh.edx[u]) - Math.atan2(mesh.edy[v], mesh.edx[v]));
      const ax = P[3 * i];
      const ay = P[3 * i + 1];
      const az = P[3 * i + 2];
      const ver: [number, number][] = [];
      for (let m = 0; m < order.length; m++) {
        const j = mesh.adj[order[m]];
        const k = mesh.adj[order[(m + 1) % order.length]];
        const ux = P[3 * j] - ax;
        const uy = P[3 * j + 1] - ay;
        const uz = P[3 * j + 2] - az;
        const vx = P[3 * k] - ax;
        const vy = P[3 * k + 1] - ay;
        const vz = P[3 * k + 2] - az;
        let cx = uy * vz - uz * vy;
        let cy = uz * vx - ux * vz;
        let cz = ux * vy - uy * vx;
        const l = Math.hypot(cx, cy, cz) || 1;
        const sg = cx * ax + cy * ay + cz * az < 0 ? -1 / l : 1 / l;
        cx *= sg;
        cy *= sg;
        cz *= sg;
        ver.push(fromUnit([cx, cy, cz]));
      }
      for (let m = 0; m < ver.length; m++) {
        const q = ver[(m + 1) % ver.length];
        fp.push(mesh.x[i], mesh.y[i], ver[m][0], ver[m][1], q[0], q[1]);
        fc.push(i, i, i);
      }
    }
    const g = {
      tri: this.makeVao(new Float32Array(tp), new Float32Array(tc), new Float32Array(tb)),
      triCount: tc.length,
      fan: this.makeVao(new Float32Array(fp), new Float32Array(fc), new Float32Array(fc.length * 3)),
      fanCount: fc.length,
    };
    if (pole > 0) this.polarGeom.north = g;
    else this.polarGeom.south = g;
    return g;
  }

  // 现在画的是极地的场景（球面上的 Voronoi）：鼠标下的格按球面上真正最近的格取（与画出来的一致）
  polarPick(): boolean {
    return !!(this.planet && this.camera.proj && this.projScene?.pole);
  }

  // 投影的合成程序（第一次用到时才编译）
  protected projProgram(): WebGLProgram {
    this.progProj ??= compileCompose(this.gl, FS_COMPOSE_PROJ);
    return this.progProj;
  }

  // 场景按 sc 画（编号层、地形层、切线层；同停稳的画法：哪一层的输入变了才重画那一层，幽灵海岸只重画改了的几格那一块）
  protected drawProjScene(t: SceneTarget, sc: ProjScene, kmPerUnit: number, hasSeams: boolean, force: boolean) {
    const gl = this.gl;
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    if (this.sizeTarget(t, sc.W, sc.H)) force = true;
    const idKey = `${this.meshVersion}|${sc.key}`;
    const terrainStatic = `${idKey}|${this.detail}|${coastAmp}|${kmPerUnit}`;
    const terrainKey = `${terrainStatic}|${this.layersVersion}`;
    const seamKey = hasSeams ? `${sc.key}|${this.seamVersion}` : '';
    const cx = (sc.x0 + sc.x1) / 2;
    const halfW = (sc.x1 - sc.x0) / 2;
    const [copy0, copies] = this.copiesFor(cx, halfW);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, sc.W, sc.H);
    if (force || idKey !== this.pIdKey) {
      this.pIdKey = idKey;
      this.drawId(t, sc.view, copy0, copies, sc.pole);
    }
    if (force || terrainKey !== this.pTerrainKey) {
      // 幽灵海岸只改了几格：只重画那几格的一块（极地的场景整张重画）
      const rects = !force && !sc.pole && terrainStatic === this.pTerrainStatic && this.dirtyCells !== 'full' ? this.dirtyRects(this.dirtyCells, sc.view, sc.W, sc.H) : null;
      this.pTerrainKey = terrainKey;
      this.pTerrainStatic = terrainStatic;
      this.dirtyCells = new Set();
      this.drawTerrain(t, sc.view, 1 / Math.max(sc.zx, sc.zy), copy0, copies, coastAmp, kmPerUnit, rects, sc.pole);
    }
    if (hasSeams && (force || seamKey !== this.pSeamKey)) {
      this.pSeamKey = seamKey;
      this.drawSeams(t, sc.view, cx, halfW, sc.pole);
    }
  }

  // 1. 编号层
  // pole：极地的场景（球面上的 Voronoi，以极点为中心的平面）
  protected drawId(t: SceneTarget, view: V4, copy0: number, copies: number, pole: 0 | 1 | -1 = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboId);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    if (pole) {
      const g = this.polarGeometry(pole);
      const prog = this.polarPrograms().id;
      gl.useProgram(prog);
      gl.uniform4fv(this.loc(prog, 'uView'), view);
      gl.uniform1f(this.loc(prog, 'uPole'), pole);
      gl.bindVertexArray(g.fan);
      gl.drawArrays(gl.TRIANGLES, 0, g.fanCount);
      return;
    }
    const pp = this.planet ? this.planetProgs : null;
    const pid = pp ? pp.id : this.progId;
    gl.useProgram(pid);
    gl.uniform4fv(this.loc(pid, 'uView'), view);
    // 编号层的顶点着色器（VS_ID）不读纹理：不必绑，也不会与写入目标形成反馈环
    gl.bindVertexArray(this.fanVao);
    if (pp) {
      gl.uniform1i(this.loc(pid, 'uCopy0'), copy0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.fanCount, copies);
    } else gl.drawArrays(gl.TRIANGLES, 0, this.fanCount);
  }

  // 2. 地形层。pixel：一个目标像素合多少地图单位。rects：只重画这几块（设备像素，GL 的 y 向上）；null 整张
  protected drawTerrain(t: SceneTarget, view: V4, pixel: number, copy0: number, copies: number, coastAmp: number, kmPerUnit: number, rects: Rect[] | null, pole: 0 | 1 | -1 = 0) {
    const gl = this.gl;
    const mesh = this.mesh!;
    if (rects && !rects.length) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const pp = this.planet ? this.planetProgs : null;
    const pt = pole ? this.polarPrograms().terrain : pp ? pp.terrain : this.progTerrain;
    gl.useProgram(pt);
    gl.uniform4fv(this.loc(pt, 'uView'), view);
    gl.uniform1f(this.loc(pt, 'uSpacing'), mesh.spacing);
    gl.uniform1f(this.loc(pt, 'uCoastAmp'), coastAmp);
    gl.uniform1f(this.loc(pt, 'uDetail'), this.detail);
    gl.uniform1f(this.loc(pt, 'uPixel'), pixel);
    gl.uniform1f(this.loc(pt, 'uMetersPerUnit'), kmPerUnit * 1000);
    this.bindTex(pt, 'uColor', this.tex.color, 0);
    this.bindTex(pt, 'uElev', this.tex.elev, 1);
    this.bindTex(pt, 'uCoast', this.tex.coast, 2);
    this.bindTex(pt, 'uGrad', this.tex.grad, 3);
    this.bindTex(pt, 'uOther', this.tex.other, 4);
    this.bindTex(pt, 'uSeaGrad', this.tex.seaGrad, 5);
    this.bindTex(pt, 'uLith', this.tex.lith, 6);
    this.bindTex(pt, 'uFj', this.tex.fj, 7);
    gl.uniform1f(this.loc(pt, 'uSat'), this.rock ? 1.1 : 1);
    gl.uniform1i(this.loc(pt, 'uSeaData'), this.seaData ? 1 : 0);
    const polar = pole ? this.polarGeometry(pole) : null;
    gl.bindVertexArray(polar ? polar.tri : this.triVao);
    if (pp) {
      gl.uniform1i(this.loc(pt, 'uCopy0'), copy0);
      gl.uniform1f(this.loc(pt, 'uNoiseK'), 1 / (Math.PI * mesh.spacing));
    }
    if (polar) gl.uniform1f(this.loc(pt, 'uPole'), pole);
    this.perf?.gpuBegin('terrain');
    if (rects) gl.enable(gl.SCISSOR_TEST);
    for (const r of rects ?? [null]) {
      if (r) gl.scissor(r[0], r[1], r[2], r[3]);
      gl.clearBufferfv(gl.COLOR, 0, [0.08, 0.1, 0.14, 0]);
      gl.clearBufferfv(gl.COLOR, 1, [-4000, -1, 0, 0]);
      if (polar) gl.drawArrays(gl.TRIANGLES, 0, polar.triCount);
      else if (pp) gl.drawArraysInstanced(gl.TRIANGLES, 0, this.triCount, copies);
      else gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    }
    gl.disable(gl.SCISSOR_TEST);
    this.perf?.gpuEnd('terrain');
  }

  // 3. 切线层：每段画一个长方形，片元算到段的距离与在哪一边，近的胜（深度测试 LESS，同样近时先画的段号小的胜）
  protected drawSeams(t: SceneTarget, view: V4, camX: number, halfW: number, pole: 0 | 1 | -1 = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboSeam);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    const ps = pole ? this.polarPrograms().seam : this.progSeam;
    gl.useProgram(ps);
    gl.uniform4fv(this.loc(ps, 'uView'), view);
    gl.uniform1f(this.loc(ps, 'uBand'), this.seamBand);
    if (pole) gl.uniform1f(this.loc(ps, 'uPole'), pole);
    gl.bindVertexArray(this.seamVao);
    // 整个星球：线（经度展开后可能超出 [0, 2)）在屏幕上看得见的那几份（极地的场景只要一份）
    let k0 = 0;
    let k1 = 0;
    if (this.planet && !pole) {
      k0 = Math.ceil((camX - halfW - this.seamX[1] - this.seamBand) / 2);
      k1 = Math.min(k0 + 6, Math.floor((camX + halfW - this.seamX[0] + this.seamBand) / 2));
    }
    for (let k = k0; k <= k1; k++) {
      gl.uniform1f(this.loc(ps, 'uShift'), 2 * k);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.seamCount);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  // 4. 合成：画进 fb（null 是画布）。xf：画面上的位置 → 场景 t 上的位置；texel：画面一个像素（0–1）；
  // cellPx：一格合画面几个像素；pxScale：画面一个像素合几个屏幕像素；scenePx：场景一个像素合几个屏幕像素
  // river：已上传的河的图层（null 不画）
  // pj：等面积、球形投影（view 是投影平面 → 画面，场景 t 是 pj.scene 那一块等距圆柱）
  // rects：只画这几块（描格那一遍，第三十九轮）；null 整张
  protected compose(fb: WebGLFramebuffer | null, t: SceneTarget, view: V4, xf: V4, texel: [number, number], cellPx: number, pxScale: number, scenePx: number, relief: number, hasSeams: boolean, river: RiverTex | null, pj: ProjCompose | null = null, rects: Rect[] | null = null) {
    const gl = this.gl;
    const mesh = this.mesh!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (fb) gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    const pp = this.planet ? this.planetProgs : null;
    const pc = pj ? this.projProgram() : pp ? pp.compose : this.progCompose;
    gl.useProgram(pc);
    if (pj) {
      const p = pj.proj;
      const S = pj.scene;
      gl.uniform1i(this.loc(pc, 'uProj'), p.kind === 'globe' ? 2 : 1);
      gl.uniform4f(this.loc(pc, 'uProjP'), p.lon0, Math.sin(p.lat0), Math.cos(p.lat0), 0);
      gl.uniform2f(this.loc(pc, 'uPx'), texel[0], texel[1]);
      gl.uniform2f(this.loc(pc, 'uSceneZ'), S.zx, S.zy);
      gl.uniform4fv(this.loc(pc, 'uSceneView'), S.view);
      gl.uniform1f(this.loc(pc, 'uSceneX0'), S.x0);
      gl.uniform1f(this.loc(pc, 'uScenePole'), S.pole);
      gl.uniform4fv(this.loc(pc, 'uOutside'), pj.outside);
      gl.uniform1f(this.loc(pc, 'uPlanePx'), pj.planePx);
    }
    if (pp) gl.uniform1f(this.loc(pc, 'uNoiseK'), 1 / (Math.PI * mesh.spacing));
    this.bindTex(pc, 'uSceneColor', t.color, 0);
    // 手绘（第八十七轮）：场景颜色生成 mipmap（海岸线按它模糊，量离岸多远，见 shaders/hand.ts）；换回别的画风时只放回原来的过滤
    const hand = styleUniforms(this.style).hand === 1;
    if (hand || t.mip) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, hand ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      if (hand) gl.generateMipmap(gl.TEXTURE_2D);
      t.mip = hand;
    }
    this.bindTex(pc, 'uSceneHeight', t.height, 1);
    this.bindTex(pc, 'uIdTex', t.id, 2);
    this.bindTex(pc, 'uFlat', this.tex.flat, 3);
    this.bindTex(pc, 'uHighlight', this.tex.highlight, 4);
    this.bindTex(pc, 'uGroup', this.tex.group, 5);
    this.bindTex(pc, 'uSeam', t.seam, 6);
    this.bindTex(pc, 'uSegData', this.tex.segData, 7);
    gl.uniform1i(this.loc(pc, 'uHasSeams'), hasSeams ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uFlatByGroup'), this.flatByGroup ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHighlightByGroup'), this.highlightByGroup ? 1 : 0);
    gl.uniform2f(this.loc(pc, 'uTexel'), texel[0], texel[1]);
    gl.uniform4fv(this.loc(pc, 'uView'), view);
    gl.uniform4fv(this.loc(pc, 'uSceneXf'), xf);
    gl.uniform1f(this.loc(pc, 'uPxScale'), pxScale);
    gl.uniform1f(this.loc(pc, 'uScenePx'), scenePx);
    gl.uniform1f(this.loc(pc, 'uSpacing'), mesh.spacing);
    gl.uniform1f(this.loc(pc, 'uRelief'), relief);
    gl.uniform1f(this.loc(pc, 'uCellPx'), cellPx);
    gl.uniform1f(this.loc(pc, 'uProvScale'), this.provinceScale);
    gl.uniform1f(this.loc(pc, 'uProvAlpha'), this.provinceAlpha);
    gl.uniform1f(this.loc(pc, 'uCountryAlpha'), this.countryAlpha);
    gl.uniform1f(this.loc(pc, 'uShade'), this.shade);
    gl.uniform1f(this.loc(pc, 'uRock'), this.rock);
    const su = styleUniforms(this.style);
    gl.uniform4fv(this.loc(pc, 'uLandTint'), su.landTint);
    gl.uniform1i(this.loc(pc, 'uShadeTint'), su.shadeTint);
    gl.uniform3fv(this.loc(pc, 'uShadeDark'), su.shadeDark);
    gl.uniform3fv(this.loc(pc, 'uShadeLight'), su.shadeLight);
    gl.uniform1i(this.loc(pc, 'uSeaTiers'), su.seaTiers);
    gl.uniform3fv(this.loc(pc, 'uSeaTier'), su.seaTier);
    gl.uniform3fv(this.loc(pc, 'uSeaDepth'), su.seaDepth);
    gl.uniform4fv(this.loc(pc, 'uIsobath'), su.isobath);
    gl.uniform2fv(this.loc(pc, 'uSeaShade'), su.seaShade);
    gl.uniform2fv(this.loc(pc, 'uTierShade'), su.tierShade);
    gl.uniform1f(this.loc(pc, 'uGlowGain'), su.glowGain);
    gl.uniform4fv(this.loc(pc, 'uCoastLine'), su.coastLine);
    gl.uniform3fv(this.loc(pc, 'uProvLine'), su.provLine);
    gl.uniform3fv(this.loc(pc, 'uCountryLine'), su.countryLine);
    // 手绘（第八十七轮）：写实、地图册只传 0（那一段不走），别的几项照样传
    gl.uniform1i(this.loc(pc, 'uHand'), su.hand);
    gl.uniform4fv(this.loc(pc, 'uPaper'), su.paper);
    gl.uniform1f(this.loc(pc, 'uWash'), su.wash);
    gl.uniform4fv(this.loc(pc, 'uRipple'), su.ripple);
    gl.uniform1i(this.loc(pc, 'uSeaData'), this.seaData ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasFlat'), this.hasFlat ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasGroup'), this.hasGroup ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasHighlight'), this.hasHighlight ? 1 : 0);
    // 描格（第三十七轮）：格号 · 2 + 陆 1 / 水 0；格心与半径（2.5 格以外的像素不算）
    const focus = this.focus.map((f) => (f && f.cell < mesh.n ? f : null));
    const fk = focus.map((f) => (f ? f.cell * 2 + (f.land ? 1 : 0) : -1));
    gl.uniform2i(this.loc(pc, 'uFocus'), fk[0], fk[1]);
    const fc = new Float32Array(6);
    focus.forEach((f, k) => {
      if (!f) return;
      fc[3 * k] = mesh.x[f.cell];
      fc[3 * k + 1] = mesh.y[f.cell];
      fc[3 * k + 2] = FOCUS_REACH * mesh.spacing;
    });
    gl.uniform3fv(this.loc(pc, 'uFocusC'), fc);
    gl.uniform1f(this.loc(pc, 'uFocusSphere'), this.planet ? 1 : 0);
    const hasFx = !!(this.fxShown.fx && this.fxShown.palette);
    this.bindTex(pc, 'uFx', this.tex.fx, 8);
    this.bindTex(pc, 'uFxPal', this.tex.fxPal, 9);
    gl.uniform1i(this.loc(pc, 'uHasFx'), hasFx ? 1 : 0);
    this.bindTex(pc, 'uTint', this.tex.tint, 10);
    this.bindTex(pc, 'uLandCell', this.tex.landCell, 14);
    this.bindTex(pc, 'uCountry', this.tex.country, 13);
    gl.uniform1i(this.loc(pc, 'uHasCountry'), this.hasCountry ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasLandCell'), this.hasLandCell ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasTint'), this.tintShown ? 1 : 0);
    this.bindTex(pc, 'uCellCoast', this.tex.cellCoast, 11);
    this.bindTex(pc, 'uRiver', this.tex.river, 12);
    gl.uniform1i(this.loc(pc, 'uHasRiver'), river ? 1 : 0);
    if (river && pj) {
      // 投影：河的图层画在场景那一块上（同样的范围、大小），按场景上的位置取
      gl.uniform4f(this.loc(pc, 'uRiverXf'), 1, 1, 0, 0);
    } else if (river) {
      // 画面上的位置（0–1）→ 地图单位 → 河的那张图上的位置（双精度在这里算好，着色器里只乘加一次）
      const [a, b, c, d] = river.toUv;
      gl.uniform4f(this.loc(pc, 'uRiverXf'), (2 * a) / view[0], (2 * c) / view[1], ((-1 - view[2]) / view[0]) * a + b, ((-1 - view[3]) / view[1]) * c + d);
    }
    // 离边界远的格（第三十九轮）：图层、ρ 都有，显示的分组就是那一份（没有省份预览、幽灵海岸），投影时只在等距圆柱、整圈的场景里
    const nearOn = !!(this.nearShown && this.nearRho && this.groupShown === this.groupBase && this.seamsShown === this.seamsBase && !this.ghostRows.length && (!pj || (!pj.scene.pole && pj.scene.full)));
    this.bindTex(pc, 'uNear', this.tex.near, 15);
    gl.uniform1i(this.loc(pc, 'uNearOn'), nearOn ? 1 : 0);
    if (nearOn) gl.uniform1fv(this.loc(pc, 'uNearRho'), this.nearRho!);
    gl.bindVertexArray(null);
    const label = rects ? 'focus' : 'compose';
    this.perf?.gpuBegin(label);
    if (rects) {
      gl.enable(gl.SCISSOR_TEST);
      for (const r of rects) {
        gl.scissor(r[0], r[1], r[2], r[3]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    } else gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.perf?.gpuEnd(label);
  }

  // 幽灵海岸改了的这几格：地形层要重画的几块（设备像素，GL 的 y 向上，四周多 2 像素）。
  // 这几格的三角形盖住的范围（cellBox）就是它们会变的全部像素；太多、跨得太宽时返回 null（整张重画）
  protected dirtyRects(cells: Set<number>, view: V4, w: number, h: number): Rect[] | null {
    const mesh = this.mesh!;
    const box = this.cellBox;
    if (!box || cells.size > mesh.n / 8) return null;
    if (!cells.size) return [];
    const sphere = this.planet;
    let ref = Number.NaN;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const c of cells) {
      let x = mesh.x[c];
      // 整个星球：经度在第一格附近展开
      if (sphere) {
        if (Number.isNaN(ref)) ref = x;
        x = ref + (x - ref - 2 * Math.round((x - ref) / 2));
      }
      x0 = Math.min(x0, x + box[4 * c]);
      x1 = Math.max(x1, x + box[4 * c + 1]);
      y0 = Math.min(y0, mesh.y[c] + box[4 * c + 2]);
      y1 = Math.max(y1, mesh.y[c] + box[4 * c + 3]);
    }
    if (sphere && x1 - x0 > 1) return null;
    const px = (x: number) => (x * view[0] + view[2] + 1) * 0.5 * w;
    const py = (y: number) => (y * view[1] + view[3] + 1) * 0.5 * h;
    const bottom = Math.max(0, Math.floor(py(y1)) - 2);
    const top = Math.min(h, Math.ceil(py(y0)) + 2);
    if (top <= bottom) return [];
    // 整个星球：每一份副本（左右相隔 2）上各一块
    let m0 = 0;
    let m1 = 0;
    if (sphere) {
      const period = view[0] * w;
      m0 = Math.ceil((-2 - px(x1)) / period);
      m1 = Math.floor((w + 2 - px(x0)) / period);
    }
    const rects: Rect[] = [];
    for (let m = m0; m <= m1 && rects.length < 8; m++) {
      const left = Math.max(0, Math.floor(px(x0 + 2 * m)) - 2);
      const right = Math.min(w, Math.ceil(px(x1 + 2 * m)) + 2);
      if (right > left) rects.push([left, bottom, right - left, top - bottom]);
    }
    return rects;
  }
}
