// 计时：鼠标移动（第四十轮，src/ui/map/input.ts）
//   npx vitest run -c tools/bench.vitest.config.ts bench-pointer（vitest 的输出里看 console.log；BENCH_GLOBE=1 时用类地星球）
//     种子 3 的一块地区（4 万格）或类地星球（tools/r40-world.ts：人文、国家、城市），国家模式，指针工具（与选国家工具），
//     镜头一格约 8、24 像素，鼠标沿一条斜线每次挪 1 个 CSS 像素，量 pointermove 处理的主线程时间（找格、画面上的格、悬停的格、
//     工具的 move 与 moveKey），数要重画的次数（第四十轮以前每次移动都重画：叠加层、着色的键、渲染器……整帧）
import { PLANET_SIZES, planetCells } from '../core/presets';
import type { Renderer } from '../src/render/renderer';
import { mode, world } from '../src/state';
import { mapInput } from '../src/ui/map/input';
import { countrySelectTool } from '../src/ui/tools/countries';
import { pointerTool } from '../src/ui/tools/pointer';
import type { ToolHandler } from '../src/ui/tools';
import { it } from 'vitest';
import { r40Engine } from './r40-world';

const globe = !!process.env.BENCH_GLOBE;
(globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };

it('鼠标移动', () => {
const w = r40Engine(globe, globe ? planetCells(PLANET_SIZES.earth.radiusKm) : 40000).world;
world.value = w;
mode.value = 'country';
console.log(`${globe ? '类地星球' : '一块地区'}：${w.mesh.n} 格，${Object.keys(w.small.countries ?? {}).length} 国，${Object.keys(w.small.cities ?? {}).length} 座城市；国家模式`);

for (const px of [8, 24]) {
  const Z = px / w.mesh.spacing;
  const cx = globe ? 0.9 : w.mesh.width * 0.45;
  const cy = globe ? 0.4 : w.mesh.height * 0.5;
  const renderer = { camera: { x: cx, y: cy, zoom: Z }, screenToWorld: (sx: number, sy: number) => [cx + (sx - 600) / Z, cy + (sy - 400) / Z], onProjection: () => true, polarPick: () => false } as unknown as Renderer;
  for (const [name, tool] of [
    ['指针', pointerTool(() => Z)],
    ['选国家', countrySelectTool(() => Z)],
  ] as [string, ToolHandler][]) {
    const on = new Map<string, (e: unknown) => void>();
    const canvas = { clientWidth: 1200, clientHeight: 800, addEventListener: (k: string, f: (e: unknown) => void) => on.set(k, f), getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} };
    let draws = 0;
    mapInput({ pointer: null, lastPointer: null, pressed: false, hoverLabel: null, userMoved: false }, { renderer: () => renderer, glCanvas: canvas as unknown as HTMLCanvasElement, ovCanvas: canvas as unknown as HTMLCanvasElement, active: () => tool, requestDraw: () => draws++, hitLabel: () => null, hintAt: () => {} });
    const move = on.get('pointermove')!;
    const N = 3000;
    // 先热一遍
    for (let i = 0; i < 200; i++) move({ clientX: 100 + i, clientY: 100 + i * 0.6, shiftKey: false, altKey: false });
    draws = 0;
    const ts: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      move({ clientX: 200 + (i % 800), clientY: 150 + (i % 800) * 0.6, shiftKey: false, altKey: false });
      ts.push(performance.now() - t);
    }
    ts.sort((a, b) => a - b);
    const q = (p: number) => ts[Math.min(N - 1, Math.floor(p * N))].toFixed(3);
    console.log(`一格约 ${px} 像素 · ${name}：每次移动 中位数 ${q(0.5)} ms、95 分位 ${q(0.95)} ms、最大 ${q(1 - 1e-9)} ms；${N} 次里要重画 ${draws} 次（第四十轮以前 ${N} 次）`);
  }
}
});
