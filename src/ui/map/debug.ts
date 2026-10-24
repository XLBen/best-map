import { drawOverlay } from '../../render/overlay';
import type { Renderer } from '../../render/renderer';
import { world } from '../../state';
import { type ExportImageOptions, snapshotCanvas } from './export';

// 挂在 window 上的钩子：给调试、截图、“在地图上看”（camera.ts）与“导出图片”（export.ts）用，开发时另有平移缩放测速

export type OverlayArgs = Parameters<typeof drawOverlay> extends [unknown, ...infer R] ? R : never;

export function installMapHooks(o: {
  renderer: Renderer;
  glCanvas: HTMLCanvasElement;
  ovCanvas: HTMLCanvasElement;
  requestDraw: () => void;
  draw: (clean?: boolean) => void;
  exportImage: (o: ExportImageOptions, progress: (p: number) => void, cancelled: () => boolean) => Promise<HTMLCanvasElement | null>;
  // 上一帧叠加层的参数（开发用的测速重画它）
  lastOverlay: () => OverlayArgs | null;
}) {
  const { renderer, glCanvas, ovCanvas, requestDraw, draw } = o;
  // clean（默认）：只有地图本身，不带高亮、闪烁、工具的图形和预览；调试时 snapshot(false) 截下屏幕上看到的样子（带预览）
  (window as unknown as { __map2?: unknown }).__map2 = {
    renderer,
    requestDraw,
    world: () => world.value,
    snapshot: (clean = true) => {
      draw(clean);
      const out = document.createElement('canvas');
      out.width = glCanvas.width;
      out.height = glCanvas.height;
      const c = out.getContext('2d')!;
      c.drawImage(glCanvas, 0, 0);
      c.drawImage(ovCanvas, 0, 0, out.width, out.height);
      // 截完按原样重画（高亮在下一帧重新上传）
      if (clean) requestDraw();
      return out;
    },
    exportImage: o.exportImage,
  };
  // 开发时的平移缩放测速（src/render/bench.ts）：控制台里 await __map2Bench()
  if (import.meta.env.DEV) {
    const hooks = {
      renderer,
      canvas: glCanvas,
      draw: () => draw(),
      spacing: () => world.value?.mesh.spacing ?? 0.01,
      snapshot: () => snapshotCanvas()!,
      overlay: (c2: CanvasRenderingContext2D) => {
        const last = o.lastOverlay();
        return last ? drawOverlay(c2, ...last) : [];
      },
    };
    Object.assign(window, {
      __map2Bench: (opts?: { frames?: number; only?: string[]; proj?: 'equalEarth' | 'globe' }) => import('../../render/bench').then((b) => b.runBench(hooks, opts)),
      __map2SaveRefs: (tag?: string) => import('../../render/bench').then((b) => b.saveRefs(hooks, tag)),
      __map2CompareRefs: (tag?: string) => import('../../render/bench').then((b) => b.compareRefs(hooks, tag)),
      __map2PassTimes: (moving?: boolean) => import('../../render/bench').then((b) => b.passTimes(hooks, moving)),
      __map2BrushBench: (frames?: number) => import('../../render/bench').then((b) => b.brushBench(hooks, frames)),
      __map2OverlayBench: (opts?: { frames?: number; only?: string[] }) => import('../../render/bench').then((b) => b.overlayBench(hooks, opts)),
      // 地图单位 → 屏幕上的 CSS 像素（开发时在浏览器里按地图上的点拖动、核对用）
      __map2ToScreen: (x: number, y: number) => renderer.worldToScreen(x, y),
    });
  }
}
