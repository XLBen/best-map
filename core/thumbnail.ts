import { hexToRgb } from './export';
import { rasterizeWorld } from './subcell';
import type { World } from './world';

// 新建向导的缩略图：与屏幕、导出用同一套栅格化（格以下的海岸、地表细节），
// 按格的植被份额着色、叠晕渲（CPU 栅格化，在 Worker 里跑）
export function renderThumbnail(world: World, width: number, height: number): Uint8ClampedArray {
  const { mesh, causes, derived: d, small } = world;
  const r = rasterizeWorld(world, width, height);
  const S = small.species.length;
  const colors = small.species.map((s) => hexToRgb(s.color));
  const cellColor = new Float32Array(mesh.n * 3);
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) continue;
    let c: [number, number, number];
    if (d.lake[i] === 1) c = [70, 125, 175];
    else {
      let rr = 0;
      let g = 0;
      let b = 0;
      let t = 0;
      for (let s = 0; s < S; s++) {
        const w = d.share[i * S + s];
        if (w <= 0) continue;
        rr += w * colors[s][0];
        g += w * colors[s][1];
        b += w * colors[s][2];
        t += w;
      }
      c = t > 0 ? [rr / t, g / t, b / t] : [205, 190, 160];
      if (d.tWarm[i] < 0) {
        const k = Math.min(1, -d.tWarm[i] / 6);
        c = [c[0] + (245 - c[0]) * k, c[1] + (248 - c[1]) * k, c[2] + (250 - c[2]) * k];
      }
    }
    cellColor[3 * i] = c[0];
    cellColor[3 * i + 1] = c[1];
    cellColor[3 * i + 2] = c[2];
  }
  const out = new Uint8ClampedArray(width * height * 4);
  // 每像素多少米；晕渲的夸张倍数与屏幕相同
  const mpp = ((mesh.width * world.kmPerUnit) / width) * 1000;
  const relief = 12;
  const L = [-0.6, 0.6, 0.75];
  const ll = Math.hypot(L[0], L[1], L[2]);
  const lx = L[0] / ll;
  const ly = L[1] / ll;
  const lz = L[2] / ll;
  const E = r.elevation;
  // 整个星球：左右两边相接（x 绕回），东西方向每像素的米数随纬度变小
  const sphere = mesh.kind === 'sphere';
  const wrapPx = (x: number) => (sphere ? ((x % width) + width) % width : Math.min(width - 1, Math.max(0, x)));
  const at = (x: number, y: number) => E[Math.min(height - 1, Math.max(0, y)) * width + wrapPx(x)];
  const land = r.land;
  for (let py = 0; py < height; py++) {
    const mppX = sphere ? mpp * Math.max(0.05, Math.sin(((py + 0.5) / height) * Math.PI)) : mpp;
    for (let px = 0; px < width; px++) {
      const p = py * width + px;
      let cr: number;
      let cg: number;
      let cb: number;
      if (!land[p]) {
        const t = Math.min(1, Math.max(0, -E[p] / 4500));
        const shallow = E[p] > -200 ? 1 - Math.max(0, -E[p]) / 200 : 0;
        cr = 62 - 44 * t + 18 * shallow;
        cg = 116 - 80 * t + 22 * shallow;
        cb = 156 - 86 * t + 14 * shallow;
      } else {
        const c = r.cell[p];
        const dx = (Math.max(0, at(px + 1, py)) - Math.max(0, at(px - 1, py))) / (2 * mppX);
        // 图像的 y 向下，与屏幕着色器的方向一致
        const dy = (Math.max(0, at(px, py - 1)) - Math.max(0, at(px, py + 1))) / (2 * mpp);
        const nx = -dx * relief;
        const ny = -dy * relief;
        const nl = Math.hypot(nx, ny, 1);
        const shade = Math.min(1.3, Math.max(0.45, 1 + 0.85 * ((nx * lx + ny * ly + lz) / nl - lz)));
        cr = cellColor[3 * c] * shade;
        cg = cellColor[3 * c + 1] * shade;
        cb = cellColor[3 * c + 2] * shade;
        // 海岸线略深
        const coast = sphere
          ? !land[py * width + wrapPx(px - 1)] || !land[py * width + wrapPx(px + 1)] || (py > 0 && !land[p - width]) || (py < height - 1 && !land[p + width])
          : (px > 0 && !land[p - 1]) || (px < width - 1 && !land[p + 1]) || (py > 0 && !land[p - width]) || (py < height - 1 && !land[p + width]);
        if (coast) {
          cr *= 0.72;
          cg *= 0.72;
          cb *= 0.72;
        }
      }
      out[p * 4] = cr;
      out[p * 4 + 1] = cg;
      out[p * 4 + 2] = cb;
      out[p * 4 + 3] = 255;
    }
  }
  return out;
}
