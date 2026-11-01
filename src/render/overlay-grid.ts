import type { Camera } from './renderer';
import type { Frame } from './overlay-base';
import type { World } from '../../core/world';

// 经纬网、纬度刻度、比例尺（第四十一轮从 overlay.ts 原样搬来）

// 整个星球的经纬网：经线、纬线的间隔随缩放变（每条线之间至少约 60 像素），回归线、极圈用虚线并写上名字
// exporting：导出整张地图（上面没有顶栏挡着，经度写在图的最上边）
export function drawGraticule(ctx: CanvasRenderingContext2D, cam: Camera, ks: number[], f: Frame, exporting = false) {
  const { cw, ch, dpr } = f;
  const sx = (x: number) => (x - cam.x) * cam.zoom + cw / 2;
  const sy = (y: number) => (y - cam.y) * cam.zoom + ch / 2;
  const yOf = (lat: number) => (90 - lat) / 180;
  const xOf = (lon: number) => 1 + lon / 180;
  // 每度合多少像素（经纬方向相同）
  const pxPerDeg = cam.zoom / 180;
  const step = [1, 2, 5, 10, 15, 30].find((d) => d * pxPerDeg >= 60) ?? 30;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '500 11px system-ui, "PingFang SC", sans-serif';
  ctx.lineJoin = 'round';
  const label = (text: string, x: number, y: number, align: CanvasTextAlign) => {
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15, 20, 28, 0.6)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(text, x, y);
  };
  const top = Math.max(sy(0), 0);
  const bottom = Math.min(sy(1), ch);
  // 纬线
  ctx.lineWidth = 1;
  for (let lat = -90 + step; lat < 90; lat += step) {
    const y = sy(yOf(lat));
    if (y < 0 || y > ch) continue;
    ctx.strokeStyle = lat === 0 ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.22)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    label(lat === 0 ? '0°' : `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}`, 8, y - 7, 'left');
  }
  // 经线（每份副本各画一遍）
  for (const k of ks) {
    for (let lon = -180; lon < 180; lon += step) {
      const x = sx(xOf(lon) + 2 * k);
      if (x < -1 || x > cw + 1) continue;
      ctx.strokeStyle = lon === 0 ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.22)';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      const name = lon === 0 ? '0°' : lon === -180 ? '180°' : `${Math.abs(lon)}°${lon > 0 ? 'E' : 'W'}`;
      label(name, x + 3, Math.max(top, exporting ? 0 : 70) + 8, 'left');
    }
  }
  // 回归线、极圈
  const special: [number, string][] = [
    [66.56, '北极圈'],
    [23.44, '北回归线'],
    [-23.44, '南回归线'],
    [-66.56, '南极圈'],
  ];
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  for (const [lat, name] of special) {
    const y = sy(yOf(lat));
    if (y < 0 || y > ch) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    label(name, 54, y - 8, 'left');
  }
  ctx.setLineDash([]);
}

// 纬度刻度：地图左边每 10° 一格；回归线、极圈画一道淡淡的虚线横穿地图
export function drawLatitude(ctx: CanvasRenderingContext2D, world: World, cam: Camera, lat: { north: number; south: number }, f: Frame) {
  const { cw, ch, dpr } = f;
  const { mesh } = world;
  const yOf = (l: number) => ((lat.north - l) / (lat.north - lat.south)) * mesh.height;
  const sx = (x: number) => (x - cam.x) * cam.zoom + cw / 2;
  const sy = (y: number) => (y - cam.y) * cam.zoom + ch / 2;
  const left = Math.max(8, sx(0));
  const right = Math.min(cw, sx(mesh.width));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '500 11px system-ui, "PingFang SC", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const label = (text: string, x: number, y: number) => {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15, 20, 28, 0.6)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(text, x, y);
  };
  const special: [number, string][] = [
    [66.56, '北极圈'],
    [23.44, '北回归线'],
    [0, '赤道'],
    [-23.44, '南回归线'],
    [-66.56, '南极圈'],
  ];
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  for (const [l, name] of special) {
    if (l > lat.north || l < lat.south) continue;
    const y = sy(yOf(l));
    if (y < 0 || y > ch) continue;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    label(name, left + 46, y - 8);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.5;
  for (let l = Math.ceil(lat.south / 10) * 10; l <= lat.north; l += 10) {
    const y = sy(yOf(l));
    if (y < 0 || y > ch) continue;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + 10, y);
    ctx.stroke();
    label(l === 0 ? '0°' : `${Math.abs(l)}°${l > 0 ? 'N' : 'S'}`, left + 13, y);
  }
}

// 比例尺：左下角（尺子按钮右边），长度取 1、2、5 乘 10 的整数次方公里，屏幕上不超过 140 像素。
// 画在地图画布上，所以导出的图片里也有
export function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera, kmPerUnit: number, lift: number, f: Frame, where?: string) {
  const { ch, dpr } = f;
  const kmPerPx = kmPerUnit / cam.zoom;
  const max = 140 * kmPerPx;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const len = [5, 2, 1].map((m) => m * pow).find((v) => v <= max) ?? pow;
  const px = len / kmPerPx;
  const x0 = 54;
  const y0 = ch - 24 - lift;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(20, 24, 30, 0.85)';
  ctx.fillRect(x0 - 1, y0 - 1, px + 2, 7);
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(x0, y0, px / 2, 5);
  ctx.fillStyle = '#3a414b';
  ctx.fillRect(x0 + px / 2, y0, px / 2, 5);
  ctx.font = '500 11.5px system-ui, "PingFang SC", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const text = where ? `${len.toLocaleString()} km · ${where}` : `${len.toLocaleString()} km`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.strokeText(text, x0 + px + 6, y0 + 2.5);
  ctx.fillStyle = '#1e2226';
  ctx.fillText(text, x0 + px + 6, y0 + 2.5);
}

