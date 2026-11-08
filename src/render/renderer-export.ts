// 渲染器的导出（第八十三轮从 src/render/renderer.ts 原样搬出）：投影的整张、平面的分块
import { effectiveZoom, type Proj, sceneNeed } from './projection';
import { type Camera, type RiverTex, type V4, type ProjScene, type RiverScene, type ProjCompose, planScene } from './renderer-parts';
import { RendererDraw } from './renderer-draw';

export abstract class RendererExport extends RendererDraw {
  // 导出整张地图（投影）：先按整张图要的密度画一块场景（整圈），再一块块合成。cam 是虚拟镜头（CSS 像素），
  // 整张图 W × H 像素、每个 CSS 像素 dpr 个。tile(x, y, T) 返回那一块 T × T 的 RGBA（从上到下）；投影之外透明。
  // river：按场景那一块画河（MapView 给）；用完 releaseExport
  beginProjectedExport(kmPerUnit: number, cam: Camera & { proj: Proj }, W: number, H: number, dpr: number, river: ((s: RiverScene) => RiverTex | null) | null): { scene: ProjScene; tile: (x: number, y: number, T: number) => Uint8Array } {
    const gl = this.gl;
    const mesh = this.mesh;
    if (!mesh || !this.triVao || !this.fanVao) throw new Error('还没有地图');
    const need = sceneNeed(cam, W / dpr, H / dpr, 3 * mesh.spacing);
    if (!need) throw new Error('图上没有地图');
    const limit = Math.min(this.exportLimit(), 16384);
    const sc = planScene({ ...need, zx: need.zx * dpr, zy: need.zy * dpr }, 1, 0, limit, 12e6);
    if (!this.exp) this.exp = { scene: this.makeTarget(), fbo: gl.createFramebuffer()!, tex: this.makeTex(), w: 0, h: 0 };
    const E = this.exp;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    // 导出用的场景目标：键另记（不碰屏幕上的那一份）
    const keys = [this.pIdKey, this.pTerrainKey, this.pTerrainStatic, this.pSeamKey];
    const dirty = this.dirtyCells;
    this.dirtyCells = 'full';
    this.drawProjScene(E.scene, sc, kmPerUnit, hasSeams, true);
    [this.pIdKey, this.pTerrainKey, this.pTerrainStatic, this.pSeamKey] = keys;
    this.dirtyCells = dirty;
    this.pComposeKey = '';
    const rt = river ? this.useRiver(river({ x0: sc.x0, y0: sc.y0, zx: sc.zx, zy: sc.zy, W: sc.W, H: sc.H, dpr, pole: sc.pole, key: `export|${sc.key}` })) : null;
    const relief = this.reliefAt(effectiveZoom(cam));
    const Z = cam.zoom * dpr;
    const pj: ProjCompose = { proj: cam.proj, scene: sc, planePx: Z, outside: [0, 0, 0, 0] };
    const tile = (x: number, y: number, T: number) => {
      if (E.w !== T || E.h !== T) {
        E.w = T;
        E.h = T;
        gl.bindTexture(gl.TEXTURE_2D, E.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, T, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, E.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, E.tex, 0);
      }
      // 平面 → 这一块的裁剪空间：像素 = (平面 − 镜头) · Z + 整张图的中心 − 这一块的左上角
      const sx = (2 * Z) / T;
      const sy = (-2 * Z) / T;
      const view: V4 = [sx, sy, ((-cam.x * Z + W / 2 - x) * 2) / T - 1, 1 - ((-cam.y * Z + H / 2 - y) * 2) / T];
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, T, T);
      this.compose(E.fbo, E.scene, view, [1, 1, 0, 0], [1 / T, 1 / T], 0, 1, 1, relief, hasSeams, rt, pj);
      const px = new Uint8Array(T * T * 4);
      gl.readPixels(0, 0, T, T, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const out = new Uint8Array(px.length);
      const row = T * 4;
      for (let r = 0; r < T; r++) out.set(px.subarray((T - 1 - r) * row, (T - r) * row), r * row);
      return out;
    };
    return { scene: sc, tile };
  }

  // 按停稳的画法（全分辨率，同样的着色器）画一块：tv 见 export-plan.ts 的 tileView；zoom 是虚拟镜头的缩放（CSS 像素 / 地图单位），
  // dpr 是每个 CSS 像素合几个图上的像素。返回 T × T 的 RGBA，从上到下一行行。
  // 画的是渲染器现在的图层（调用方先换成干净的：不带高亮、预览、幽灵海岸）；屏幕上的画布、停稳时的场景不动
  // river：这一块的河（overlay.ts 的 riverLayerTile），null 不画
  renderTile(kmPerUnit: number, tv: { scene: V4; out: V4; xf: V4; cx: number; halfW: number; S: number }, T: number, zoom: number, dpr: number, river: RiverTex | null = null): Uint8Array {
    const gl = this.gl;
    const mesh = this.mesh;
    if (!mesh || !this.triVao || !this.fanVao) throw new Error('还没有地图');
    if (!this.exp) {
      this.exp = { scene: this.makeTarget(), fbo: gl.createFramebuffer()!, tex: this.makeTex(), w: 0, h: 0 };
    }
    const E = this.exp;
    this.sizeTarget(E.scene, tv.S, tv.S);
    if (E.w !== T || E.h !== T) {
      E.w = T;
      E.h = T;
      gl.bindTexture(gl.TEXTURE_2D, E.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, T, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, E.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, E.tex, 0);
    }
    const Z = zoom * dpr;
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const [copy0, copies] = this.copiesFor(tv.cx, tv.halfW);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, tv.S, tv.S);
    this.drawId(E.scene, tv.scene, copy0, copies);
    this.drawTerrain(E.scene, tv.scene, 1 / Z, copy0, copies, coastAmp, kmPerUnit, null);
    if (hasSeams) this.drawSeams(E.scene, tv.scene, tv.cx, tv.halfW);
    gl.viewport(0, 0, T, T);
    this.compose(E.fbo, E.scene, tv.out, tv.xf, [1 / T, 1 / T], mesh.spacing * Z, 1, 1, this.reliefAt(zoom), hasSeams, this.useRiver(river));
    const px = new Uint8Array(T * T * 4);
    gl.readPixels(0, 0, T, T, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL 的第 0 行在下面：倒过来
    const out = new Uint8Array(px.length);
    const row = T * 4;
    for (let r = 0; r < T; r++) out.set(px.subarray((T - 1 - r) * row, (T - r) * row), r * row);
    return out;
  }

  releaseExport() {
    const E = this.exp;
    if (!E) return;
    const gl = this.gl;
    const s = E.scene;
    for (const t of [s.color, s.height, s.id, s.seam, E.tex]) gl.deleteTexture(t);
    for (const f of [s.fbo, s.fboId, s.fboSeam, E.fbo]) gl.deleteFramebuffer(f);
    gl.deleteRenderbuffer(s.depth);
    this.exp = null;
  }
}
