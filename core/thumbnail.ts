import { GLOW_GAIN, blendRgb, cellFx, fxSet, meanTint } from './biome-look';
import { hexToRgb } from './export';
import { rasterizeWorld } from './subcell';
import type { World } from './world';

// 新建向导的缩略图：与屏幕、导出用同一套栅格化（格以下的海岸、地表细节），
// 按格的植被份额着色（有颜色脚本时用它算好的 d.look）、叠晕渲（CPU 栅格化，在 Worker 里跑）。
// 生态的花纹画成拉远时的平均色、发光加在晕渲之后，与屏幕上拉远看时一样（core/biome-look.ts）；没有花纹、发光时整段跳过
export function renderThumbnail(world: World, width: number, height: number): Uint8ClampedArray {
  const { mesh, causes, derived: d, small } = world;
  const r = rasterizeWorld(world, width, height);
  const colors = small.species.map((s) => hexToRgb(s.color));
  const cellColor = new Float32Array(mesh.n * 3);
  const S = small.species.length;
  const look = d.look;
  const fx = fxSet(small.species, mesh.kind === 'sphere');
  // 每格发光加多少（0–255）
  const glow = fx ? new Float32Array(mesh.n * 3) : null;
  const cf = new Float64Array(4);
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) continue;
    let c: [number, number, number];
    if (d.lake[i] === 1) c = [70, 125, 175];
    else {
      c = look && look[i * 4 + 3] ? [look[i * 4], look[i * 4 + 1], look[i * 4 + 2]] : blendRgb(d.share, i, colors);
      let k = 0;
      if (d.tWarm[i] < 0) {
        k = Math.min(1, -d.tWarm[i] / 6);
        c = [c[0] + (245 - c[0]) * k, c[1] + (248 - c[1]) * k, c[2] + (250 - c[2]) * k];
      }
      if (fx && glow) {
        // 与屏幕相同：雪、盐壳盖住的地方不画花纹
        cellFx(fx, d.share, i, S, cf);
        meanTint(fx, cf, d.lake[i] === 2 ? 0 : 1 - k, c);
        if (cf[3] >= 0) {
          const g = fx.looks[cf[3]].glowColor;
          // 屏幕上发光的量是一个字节
          const a = (Math.round(255 * cf[2]) / 255) * GLOW_GAIN;
          glow[3 * i] = g[0] * a;
          glow[3 * i + 1] = g[1] * a;
          glow[3 * i + 2] = g[2] * a;
        }
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
        if (glow) {
          cr += glow[3 * c];
          cg += glow[3 * c + 1];
          cb += glow[3 * c + 2];
        }
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
