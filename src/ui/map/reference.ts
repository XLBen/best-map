import type { World } from '../../../core/world';
import type { Camera } from '../../render/renderer';
import type { Reference } from '../../state';

// 参考图（第七十轮从 MapView.tsx 分出来）：盖在整张地图的范围上（保持比例时放在中间），跟着镜头走。
// canvas：地图的画布（量它的大小）；load：参考图换了一张时让 <img> 去读它（读好了重画）
export function referenceCss(w: World, img: HTMLImageElement, r: Reference | null, camera: Camera, canvas: HTMLElement, load: (url: string) => void): { img: string; tile: string } {
  const none = 'display:none';
  // 等面积、球形投影时不铺参考图（图层里有说明）
  if (!r || !r.visible || (w.mesh.kind === 'sphere' && camera.proj)) return { img: none, tile: none };
  if (w.mesh.kind === 'sphere') {
    // 整个星球：草图按 2:1 铺满一整圈，左右重复，跟着平铺的副本走
    const cam = camera;
    const W = 2 * cam.zoom;
    const H = cam.zoom;
    const x = (0 - cam.x) * cam.zoom + canvas.clientWidth / 2;
    const y = (0 - cam.y) * cam.zoom + canvas.clientHeight / 2;
    return { img: none, tile: `display:block;left:0;top:${y}px;width:100%;height:${H}px;opacity:${r.opacity};background-image:url("${r.url}");background-size:${W}px ${H}px;background-repeat:repeat-x;background-position:${x}px 0` };
  }
  load(r.url);
  const cam = camera;
  let x = (0 - cam.x) * cam.zoom + canvas.clientWidth / 2;
  let y = (0 - cam.y) * cam.zoom + canvas.clientHeight / 2;
  let W = w.mesh.width * cam.zoom;
  let H = w.mesh.height * cam.zoom;
  if (r.fit === 'contain' && img.naturalWidth && img.naturalHeight) {
    const ar = img.naturalWidth / img.naturalHeight;
    if (ar > W / H) {
      y += (H - W / ar) / 2;
      H = W / ar;
    } else {
      x += (W - H * ar) / 2;
      W = H * ar;
    }
  }
  return { img: `display:block;left:${x}px;top:${y}px;width:${W}px;height:${H}px;opacity:${r.opacity}`, tile: none };
}
