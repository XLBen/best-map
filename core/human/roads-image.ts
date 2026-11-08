import { wrapDelta } from '../geo';
import type { World } from '../world';

// 道路图（第二十四轮，roads.bmp）：第八十五轮从 export.ts 原样搬来（export.ts 照旧导出）

// 道路图：白色陆地、粉色海洋（同 rivers.bmp），大道红色（宽一些）、小路橙色，按格心连成的折线
export function roadsImage(world: World, land: Uint8Array, width: number, height: number): Uint8Array {
  const { mesh } = world;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    rgb[p * 3] = 255;
    rgb[p * 3 + 1] = land[p] ? 255 : 0;
    rgb[p * 3 + 2] = land[p] ? 255 : 128;
  }
  const sphere = mesh.kind === 'sphere';
  const sx = width / mesh.width;
  const sy = height / mesh.height;
  const scale = Math.max(1, width / 2048);
  // 第八十四轮：海路不画进道路图（游戏里的道路在陆上）
  const roads = Object.values(world.small.roads ?? {})
    .filter((r) => r.kind !== 'sea')
    .sort((a, b) => (a.kind === 'major' ? 1 : 0) - (b.kind === 'major' ? 1 : 0) || a.id - b.id);
  for (const r of roads) {
    const major = r.kind === 'major';
    const col = major ? [200, 30, 30] : [230, 140, 40];
    const rad = (major ? 1.2 : 0.6) * scale;
    const ri = Math.ceil(rad);
    const r2 = rad * rad + 0.25;
    let px0 = mesh.x[r.cells[0]];
    for (let k = 0; k + 1 < r.cells.length; k++) {
      const a = r.cells[k];
      const b = r.cells[k + 1];
      const ax = px0;
      const bx = sphere ? ax + wrapDelta(mesh.x[b] - ax) : mesh.x[b];
      px0 = bx;
      const x0 = ax * sx;
      const y0 = mesh.y[a] * sy;
      const x1 = bx * sx;
      const y1 = mesh.y[b] * sy;
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
      for (let st = 0; st <= steps; st++) {
        const t = st / steps;
        const fx = Math.floor(x0 + (x1 - x0) * t);
        const fy = Math.floor(y0 + (y1 - y0) * t);
        for (let oy = -ri; oy <= ri; oy++) {
          for (let ox = -ri; ox <= ri; ox++) {
            if (ox * ox + oy * oy > r2) continue;
            let x = fx + ox;
            const y = fy + oy;
            if (sphere) x = ((x % width) + width) % width;
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const q = (y * width + x) * 3;
            rgb[q] = col[0];
            rgb[q + 1] = col[1];
            rgb[q + 2] = col[2];
          }
        }
      }
    }
  }
  return rgb;
}
