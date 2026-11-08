// 渲染器的网格与逐格的图层（第八十三轮从 src/render/renderer.ts 原样搬出）：网格、离边界远的格、图层、花纹、湖色、幽灵海岸、省份预览、切线、高亮、描格
import type { CellFocus } from '../../core/display';
import type { Mesh } from '../../core/mesh';
import type { SeamLayers } from '../../core/seams';
import { viewOf } from '../../core/sphere';
import type { GhostLayers } from './colors';
import { nearLayerSteps, nearRhoStep } from './near';
import { TEX_W } from './shaders/common';
import { FS_ID } from './shaders/plane';
import { FS_COMPOSE_PLANET, FS_TERRAIN_PLANET, VS_CELL_PLANET, VS_ID_PLANET } from './shaders/sphere';
import { compileCompose, compile, packElevation, packCoast, packCellCoast, type CellLayers, cellBoxes } from './renderer-parts';
import { RendererBase } from './renderer-base';

export abstract class RendererLayers extends RendererBase {
  setMesh(mesh: Mesh) {
    if (this.mesh === mesh) return;
    this.mesh = mesh;
    this.layersVersion++;
    this.meshVersion++;
    this.dirtyCells = 'full';
    // 换了网格：逐格的纹理都要重传（格数变了），离边界远的格按新网格的 ρ（空闲时算）
    this.shownDeps = {};
    this.fjShown = undefined;
    this.nearRho = null;
    this.scheduleRho(mesh);
    this.planet = mesh.kind === 'sphere';
    if (mesh.kind === 'sphere') {
      this.setSphereMesh(mesh);
      return;
    }
    // Delaunay 三角形，不共享顶点，每个顶点带重心坐标的一个分量
    const tris = mesh.triangles;
    const tp = new Float32Array(tris.length * 2);
    const tc = new Float32Array(tris.length);
    const tb = new Float32Array(tris.length * 3);
    for (let k = 0; k < tris.length; k++) {
      const c = tris[k];
      tp[2 * k] = mesh.x[c];
      tp[2 * k + 1] = mesh.y[c];
      tc[k] = c;
      tb[3 * k + (k % 3)] = 1;
    }
    this.triVao = this.makeVao(tp, tc, tb);
    this.triCount = tris.length;
    this.cellBox = cellBoxes(mesh, tp, tc, false);
    // Voronoi：每个多边形以格中心做扇形三角化（编号层）
    const vp: number[] = [];
    const vc: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      const a = mesh.polyOff[i];
      const b = mesh.polyOff[i + 1];
      const m = b - a;
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        vp.push(mesh.x[i], mesh.y[i], mesh.poly[2 * (a + k)], mesh.poly[2 * (a + k) + 1], mesh.poly[2 * (a + k2)], mesh.poly[2 * (a + k2) + 1]);
        vc.push(i, i, i);
      }
    }
    this.fanVao = this.makeVao(new Float32Array(vp), new Float32Array(vc), new Float32Array(vc.length * 3));
    this.fanCount = vc.length;
  }

  // 整个星球：显示用的三角网（含接缝两侧、两极的影子点，对应回真实的格）。
  // 同一个三角形里对应同一格的角共用一个重心坐标分量，与导出（subcell.ts）的权重合并一致
  protected setSphereMesh(mesh: Extract<Mesh, { kind: 'sphere' }>) {
    const gl = this.gl;
    if (!this.planetProgs) {
      this.planetProgs = {
        id: compile(gl, VS_ID_PLANET, FS_ID),
        terrain: compile(gl, VS_CELL_PLANET, FS_TERRAIN_PLANET),
        compose: compileCompose(gl, FS_COMPOSE_PLANET),
      };
    }
    const view = viewOf(mesh);
    const tris = view.triangles;
    const tp = new Float32Array(tris.length * 2);
    const tc = new Float32Array(tris.length);
    const tb = new Float32Array(tris.length * 3);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let t = 0; t < tris.length; t += 3) {
      const c0 = view.cellOf[tris[t]];
      const c1 = view.cellOf[tris[t + 1]];
      for (let k = 0; k < 3; k++) {
        const v = tris[t + k];
        const c = view.cellOf[v];
        tp[2 * (t + k)] = view.x[v];
        tp[2 * (t + k) + 1] = view.y[v];
        tc[t + k] = c;
        const slot = c === c0 ? 0 : c === c1 ? 1 : k;
        tb[3 * (t + k) + slot] = 1;
        x0 = Math.min(x0, view.x[v]);
        x1 = Math.max(x1, view.x[v]);
      }
    }
    this.triVao = this.makeVao(tp, tc, tb);
    this.triCount = tris.length;
    this.cellBox = cellBoxes(mesh, tp, tc, true);
    // 编号层：Voronoi 多边形（凸），从第一个顶点扇形三角化
    const polys = view.polygons();
    let count = 0;
    for (let q = 0; q + 1 < polys.off.length; q++) count += Math.max(0, polys.off[q + 1] - polys.off[q] - 2) * 3;
    const vp = new Float32Array(count * 2);
    const vc = new Float32Array(count);
    let o = 0;
    for (let q = 0; q + 1 < polys.off.length; q++) {
      const a = polys.off[q];
      const b = polys.off[q + 1];
      for (let k = a + 1; k + 1 < b; k++) {
        for (const v of [a, k, k + 1]) {
          vp[2 * o] = polys.xy[2 * v];
          vp[2 * o + 1] = polys.xy[2 * v + 1];
          vc[o] = polys.cell[q];
          o++;
        }
      }
    }
    this.fanVao = this.makeVao(vp, vc, new Float32Array(count * 3));
    this.fanCount = count;
    this.xRange = [Math.min(x0, 0), Math.max(x1, 2)];
  }

  // ρ（near.ts 的 nearRho）在空闲时一小段一小段地算（类地星球约 0.6 秒）；算好之前合成照算环上的点（结果一样，只是慢）
  protected scheduleRho(mesh: Mesh) {
    if (this.rhoTimer) clearTimeout(this.rhoTimer);
    const step = () => {
      this.rhoTimer = null;
      if (this.mesh !== mesh) return;
      const r = nearRhoStep(mesh, 6);
      if (!r) {
        this.rhoTimer = setTimeout(step, 16);
        return;
      }
      // 着色器里按 float32 比：往小里收一点，取整、舍入不会让保证的距离变远
      this.nearRho = Float32Array.from(r, (v) => (v > 0 ? v * (1 - 1e-4) : v));
    };
    this.rhoTimer = setTimeout(step, 50);
  }

  // 离边界远的格（near.ts 的 nearLayer：地区约 15–25 毫秒、星球约 30–55 毫秒）不在换图层的那一帧里算：图层停下 40 毫秒后在空闲时
  // 分几步算（每步几毫秒，步与步之间让出线程），算好时图层还是那一份才用上（之前照取环上的点，画出来一样）。编辑时图层每一笔都换，算不上也不耽误
  protected scheduleNear(l: CellLayers) {
    if (this.nearTimer) clearTimeout(this.nearTimer);
    const mesh = this.mesh;
    let job: ReturnType<typeof nearLayerSteps> | null = null;
    let k = 0;
    const step = () => {
      this.nearTimer = null;
      if (this.base !== l || this.mesh !== mesh || !mesh) return;
      const t = performance.now();
      job ??= nearLayerSteps(mesh, l.group, l.countryGroup, l.coast, l.landCell);
      if (k < job.steps.length) job.steps[k++]();
      this.perf?.cpu('near', performance.now() - t);
      if (k < job.steps.length) {
        this.nearTimer = setTimeout(step, 0);
        return;
      }
      this.nearMemo.set(l, job.out);
      this.useNear(l);
    };
    this.nearTimer = setTimeout(step, 40);
  }
  protected useNear(l: CellLayers) {
    const mesh = this.mesh;
    if (!mesh || (!l.group && !l.countryGroup)) return;
    let near = this.nearMemo.get(l);
    if (!near) {
      const job = nearLayerSteps(mesh, l.group, l.countryGroup, l.coast, l.landCell);
      for (const st of job.steps) st();
      near = job.out;
      this.nearMemo.set(l, near);
    }
    if (this.fresh('near', near)) this.upload(this.tex.near, near, mesh.n, 4);
    this.nearShown = near;
  }

  // 测试、导出：现在就把 ρ 与这一份图层的离边界远的格算完
  prepareNear() {
    if (this.mesh && !this.nearRho) {
      if (this.rhoTimer) clearTimeout(this.rhoTimer);
      this.rhoTimer = null;
      const r = nearRhoStep(this.mesh, Infinity)!;
      this.nearRho = Float32Array.from(r, (v) => (v > 0 ? v * (1 - 1e-4) : v));
    }
    if (this.base && !this.nearShown) {
      if (this.nearTimer) clearTimeout(this.nearTimer);
      this.nearTimer = null;
      this.useNear(this.base);
    }
  }

  // 换图层（第三十九轮）：按对象是不是同一个来上传（换模式时底子多半没变）；地形层读的变了才加 layersVersion（重画地形层），
  // 只有合成读的变了只加 modeVersion（只重新合成）。幽灵海岸、省份预览在这之后都没了，调用方要重新给
  setLayers(l: CellLayers) {
    const n = this.mesh?.n ?? 0;
    let terrain = false;
    let mode = false;
    if (this.fresh('color', l.smooth)) {
      this.upload(this.tex.color, l.smooth, n, 4);
      terrain = true;
    }
    if (this.fresh('other', l.other)) {
      this.upload(this.tex.other, l.other, n, 4);
      terrain = true;
    }
    if (this.fresh('elev', l.elevation, l.coast, l.shore)) {
      this.elevPack = new Float32Array(n * 2);
      packElevation(this.elevPack, l.elevation, l.coast, l.shore ?? null, 0, n);
      this.upload(this.tex.elev, this.elevPack, n, 2);
      terrain = true;
    }
    this.elevGhost = null;
    if (this.fresh('coast', l.coast, l.frag, l.style)) {
      this.coastPack = new Float32Array(n * 4);
      packCoast(this.coastPack, l.coast, l.frag, l.style, 0, n);
      this.upload(this.tex.coast, this.coastPack, n, 4);
      terrain = true;
    }
    this.coastGhost = null;
    // 合成着色器只读海岸值、破碎度（provCell 一个像素要查十几次）：另一张两个通道的（RGBA32F 的那张读起来多一倍的带宽，合成慢约三成）
    if (this.fresh('cellCoast', l.coast, l.frag)) {
      this.cellCoastPack = new Float32Array(n * 2);
      packCellCoast(this.cellCoastPack, l.coast, l.frag, 0, n);
      this.upload(this.tex.cellCoast, this.cellCoastPack, n, 2);
      mode = true;
    }
    this.cellCoastGhost = null;
    // 峡湾的纹理自己记着传上去的是哪一份（幽灵海岸也换它）
    const fj = this.fjShown;
    this.uploadFj(l.fjord ?? null);
    if (this.fjShown !== fj) terrain = true;
    if (this.fresh('grad', l.grad)) {
      this.upload(this.tex.grad, l.grad, n, 2);
      terrain = true;
    }
    if (this.fresh('seaGrad', l.seaGrad ?? null)) {
      this.upload(this.tex.seaGrad, l.seaGrad ?? new Float32Array(n * 2), n, 2);
      terrain = true;
    }
    if (this.fresh('lith', l.lith ?? null)) {
      this.upload(this.tex.lith, l.lith ?? new Uint8Array(n * 4), n, 4);
      terrain = true;
    }
    if (this.fresh('landCell', l.landCell ?? null)) {
      if (l.landCell) this.upload(this.tex.landCell, l.landCell, n, 4);
      mode = true;
    }
    if (this.fresh('flat', l.flat)) {
      if (l.flat) this.upload(this.tex.flat, l.flat, n, 4);
      mode = true;
    }
    if (this.fresh('group', l.group)) {
      if (l.group) this.upload(this.tex.group, l.group, n, 2);
      mode = true;
    }
    if (this.fresh('country', l.countryGroup ?? null)) {
      if (l.countryGroup) this.upload(this.tex.country, l.countryGroup, n, 2);
      mode = true;
    }
    // 离边界远的格：算过的照用，没算过的空闲时算（只决定跳不跳过，画出来一样：不进合成的键）
    const near = l.near ?? this.nearMemo.get(l) ?? null;
    if (near && this.fresh('near', near)) this.upload(this.tex.near, near, n, 4);
    this.nearShown = near;
    if (!near && (l.group || l.countryGroup)) this.scheduleNear(l);
    this.hasLandCell = !!l.landCell;
    this.hasFlat = !!l.flat;
    this.hasGroup = !!l.group;
    this.hasCountry = !!l.countryGroup;
    this.groupBase = this.groupShown = l.group;
    this.flatBase = this.flatShown = l.flat;
    this.seamsBase = l.group ? (l.seams ?? null) : null;
    this.showSeams(this.seamsBase);
    // 露岩（地形层的饱和度也看它）、海面是数据（地形层也看它）变了要重画地形层；晕渲的强弱只在合成里
    if (l.rock !== this.rock || !!l.seaData !== this.seaData) terrain = true;
    if (l.shade !== this.shade) mode = true;
    this.shade = l.shade;
    this.rock = l.rock;
    this.seaData = !!l.seaData;
    this.coastAmp = l.coastAmp;
    this.base = l;
    if (terrain) {
      this.layersVersion++;
      this.dirtyCells = 'full';
    }
    if (mode) this.modeVersion++;
    this.ghostCells = [];
    this.ghostRows = [];
    this.ghostAmp = null;
    this.ghostGroup = null;
    this.ghostFlat = null;
    // 花纹与发光：与现在显示的是同一份时不重传（调用方的外观覆盖随后照样给）
    this.fxBase = { fx: l.fx ?? null, palette: l.fxPalette ?? null };
    this.setFx(this.fxBase.fx, this.fxBase.palette);
  }

  // 生态的花纹与发光：拖花纹、发光滑块时主线程上换一份（colors.ts 的 fxLayers 带上覆盖的外观），null 回到 setLayers 给的。
  // 同一份不重新上传；setLayers 之后回到它给的，调用方要重新给
  setFx(fx: Uint8Array | null, palette: Float32Array | null) {
    if (fx === this.fxShown.fx && palette === this.fxShown.palette) return;
    this.fxShown = { fx, palette };
    this.fxVersion++;
    if (!fx || !palette) return;
    const gl = this.gl;
    this.upload(this.tex.fx, fx, this.mesh?.n ?? 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fxPal);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 3, palette.length / 12, 0, gl.RGBA, gl.FLOAT, palette);
  }

  // 湖泊类型的颜色与画法（每格 RGBA 字节，见 colors.ts 的 lakeTintLayer）；null 不画。同一份不重新上传
  setTint(tint: Uint8Array | null) {
    if (tint === this.tintShown) return;
    this.tintShown = tint;
    this.tintVersion++;
    if (tint) this.upload(this.tex.tint, tint, this.mesh?.n ?? 0, 4);
  }

  // 幽灵海岸：几格的地形输入（颜色、对岸的颜色、高程、海岸值，与平涂、分组）换成将来的样子，着色器照此画出将来真实的海岸线；
  // null 回到 setLayers 给的。g 的数组是持久的缓冲，g.cells 是现在与底子不同的格：只上传这些格与上一次不同的格所在的行。
  // 省份预览（setGroupPreview）显示着的时候平涂、分组听省份预览的。setLayers 之后幽灵就没了，调用方要重新给
  setGhost(g: GhostLayers | null) {
    const base = this.base;
    if (!base) return;
    const now = new Set<number>();
    if (g) for (const i of g.cells) now.add(Math.floor(i / TEX_W));
    const rows = [...new Set([...this.ghostRows, ...now])].sort((a, b) => a - b);
    const amp = g?.coastAmp ?? null;
    if (!rows.length && amp === this.ghostAmp) return;
    // 峡湾（第三十六轮）：幽灵里按将来的陆海重算过（colors.ts 的 GhostBuffer），与上一次的不同才上传
    this.uploadFj(g?.fjord !== undefined ? g.fjord : (base.fjord ?? null));
    const src = g ?? { smooth: base.smooth, other: base.other, elevation: base.elevation, coast: base.coast, frag: base.frag ?? null, flat: base.flat, group: base.group, style: base.style ?? null };
    // 这几张只改了几行：与哪个数组都对不上了（下一次 setLayers 整张重传）
    for (const k of ['color', 'other', 'elev', 'coast', 'cellCoast']) this.shownDeps[k] = null;
    this.uploadRows(this.tex.color, src.smooth, rows, 4);
    this.uploadRows(this.tex.other, src.other, rows, 4);
    // 高程与水面的高程按行打包（陆海按这一份的海岸值分）
    if (!this.elevGhost) this.elevGhost = this.elevPack.slice();
    for (const r of rows) packElevation(this.elevGhost, src.elevation, src.coast, base.shore ?? null, r * TEX_W, Math.min(src.coast.length, (r + 1) * TEX_W));
    this.uploadRows(this.tex.elev, this.elevGhost, rows, 2);
    if (!this.coastGhost) this.coastGhost = this.coastPack.slice();
    // 海岸类型（第三十四轮）：幽灵里峡湾按将来的陆海重算过（colors.ts 的 GhostBuffer）
    for (const r of rows) packCoast(this.coastGhost, src.coast, src.frag, src.style, r * TEX_W, Math.min(src.coast.length, (r + 1) * TEX_W));
    this.uploadRows(this.tex.coast, this.coastGhost, rows, 4);
    if (!this.cellCoastGhost) this.cellCoastGhost = this.cellCoastPack.slice();
    for (const r of rows) packCellCoast(this.cellCoastGhost, src.coast, src.frag, r * TEX_W, Math.min(src.coast.length, (r + 1) * TEX_W));
    this.uploadRows(this.tex.cellCoast, this.cellCoastGhost, rows, 2);
    // 平涂、分组：显示着的是底子或上一次的幽灵时才换
    if (this.groupBase && src.group && (this.groupShown === this.groupBase || this.groupShown === this.ghostGroup)) {
      this.uploadRows(this.tex.group, src.group, rows, 2);
      this.groupShown = g ? src.group : this.groupBase;
      this.shownDeps.group = null;
      this.groupVersion++;
    }
    if (this.flatBase && src.flat && (this.flatShown === this.flatBase || this.flatShown === this.ghostFlat)) {
      this.uploadRows(this.tex.flat, src.flat, rows, 4);
      this.flatShown = g ? src.flat : this.flatBase;
      this.shownDeps.flat = null;
      this.groupVersion++;
    }
    this.ghostGroup = g?.group ?? null;
    this.ghostFlat = g?.flat ?? null;
    // 地形层只重画输入变了的格（上一次的幽灵与这一次的）；海岸细节幅度变了整张重画
    const cells = g ? g.cells : [];
    if (amp !== this.ghostAmp) this.dirtyCells = 'full';
    else if (this.dirtyCells !== 'full') {
      for (const c of this.ghostCells) this.dirtyCells.add(c);
      for (const c of cells) this.dirtyCells.add(c);
    }
    this.ghostCells = Array.from(cells);
    this.ghostRows = [...now];
    this.ghostAmp = amp;
    this.layersVersion++;
  }

  // 省份预览：整份分组（与平涂、切线）换成将来的样子，着色器照此画出真实的新省界；null 回到 setLayers 给的。
  // 没有画分组边界时不管。setLayers 之后预览就没了，调用方要重新给
  setGroupPreview(p: { group: Float32Array; flat: Uint8Array | null; seams?: SeamLayers | null } | null) {
    if (!this.groupBase || !this.groupShown) return;
    const group = p ? p.group : this.groupBase;
    const flat = p && p.flat && this.flatBase ? p.flat : this.flatBase;
    const seams = p ? (p.seams ?? null) : this.seamsBase;
    if (group === this.groupShown && flat === this.flatShown && seams === this.seamsShown) return;
    this.uploadChanged(this.tex.group, this.groupShown, group, 2);
    this.groupShown = group;
    this.shownDeps.group = null;
    if (flat && this.flatShown && flat !== this.flatShown) {
      this.uploadChanged(this.tex.flat, this.flatShown, flat, 4);
      this.flatShown = flat;
      this.shownDeps.flat = null;
    }
    this.showSeams(seams);
    this.groupVersion++;
  }

  // 切线：每段的几何（实例数据）与两边的省（gL, gR, repL, repR 一段一个纹素）
  protected showSeams(L: SeamLayers | null) {
    if (L === this.seamsShown) return;
    this.seamsShown = L;
    this.seamVersion++;
    const m = L ? L.segs.count : 0;
    this.seamCount = m;
    if (!L || !m) return;
    const gl = this.gl;
    const S = L.segs;
    const inst = new Float32Array(m * 10);
    const data = new Float32Array(m * 4);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let s = 0; s < m; s++) {
      inst.set([S.ax[s], S.ay[s], S.bx[s], S.by[s], S.px[s], S.py[s], S.nx[s], S.ny[s], S.hasPrev[s], S.hasNext[s]], s * 10);
      data.set([L.gL[s], L.gR[s], L.repL[s], L.repR[s]], s * 4);
      x0 = Math.min(x0, S.ax[s], S.bx[s]);
      x1 = Math.max(x1, S.ax[s], S.bx[s]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seamBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
    const rows = Math.ceil(m / TEX_W);
    const padded = new Float32Array(TEX_W * rows * 4);
    padded.set(data);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.segData);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, padded);
    this.seamBand = L.band;
    this.seamX = [x0, x1];
  }

  setHighlight(h: Uint8Array | null) {
    this.highlightVersion++;
    this.hasHighlight = !!h;
    if (h) this.upload(this.tex.highlight, h, this.mesh?.n ?? 0, 4);
  }

  // 描格（第三十七轮）：鼠标下的格与钉住的格，各描出画成陆地（land）或水面的那一部分（合成着色器的 focusAt）。
  // null 不描。第三十九轮：focusKey 不在合成的键里，变了时只在新旧两处的那几块里重新合成（见 composeFocus）
  setFocus(hover: CellFocus | null, pinned: CellFocus | null) {
    const n = this.mesh?.n ?? 0;
    const ok = (f: CellFocus | null) => (f && f.cell >= 0 && f.cell < n ? f : null);
    const h = ok(hover);
    const p = ok(pinned);
    this.focus = [h, p];
    this.focusKey = `${h ? `${h.cell}${h.land ? 'L' : 'W'}` : ''}|${p ? `${p.cell}${p.land ? 'L' : 'W'}` : ''}`;
  }
}
