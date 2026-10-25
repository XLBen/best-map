import { z } from 'zod';
import { mulberry32 } from '../rng';
import { HEX } from './terrain-class';

// 旗帜（第二十三轮）：不存图，存一份“规则”——样式（条纹、十字、角旗……）、几种颜色、一个纹章。生成时按种子与文化的颜色挑，
// 档案里可以改（set_country 的 flag）。flagSvg 把它画成 SVG（界面、导出共用）

export const FLAG_LAYOUTS = ['plain', 'bicolor-h', 'bicolor-v', 'tricolor-h', 'tricolor-v', 'cross', 'nordic', 'saltire', 'canton', 'chevron', 'quartered', 'border', 'diagonal', 'stripes'] as const;
export type FlagLayout = (typeof FLAG_LAYOUTS)[number];
export const FLAG_EMBLEMS = ['star', 'sun', 'moon', 'crown', 'cross', 'circle', 'tower', 'tree', 'sword', 'eagle', 'lion', 'wheel', 'mountain', 'wave'] as const;
export type FlagEmblem = (typeof FLAG_EMBLEMS)[number];

// 样式要几种颜色
export const LAYOUT_COLORS: Record<FlagLayout, number> = {
  plain: 1,
  'bicolor-h': 2,
  'bicolor-v': 2,
  'tricolor-h': 3,
  'tricolor-v': 3,
  cross: 2,
  nordic: 2,
  saltire: 2,
  canton: 2,
  chevron: 2,
  quartered: 2,
  border: 2,
  diagonal: 2,
  stripes: 2,
};

export const flagSchema = z.object({
  layout: z.enum(FLAG_LAYOUTS),
  // 按样式的先后：底色、第二种、第三种（多出来的不用，少了的用底色）
  colors: z.array(HEX).min(1).max(4),
  emblem: z.enum(FLAG_EMBLEMS).optional(),
  emblemColor: HEX.optional(),
});
export type FlagSpec = z.output<typeof flagSchema>;

// 纹章里常用的几种颜色：白、金、黑、红、蓝、绿、紫
const TINCTURES = ['#f4f1e8', '#e8b923', '#1d1d1f', '#b8202a', '#1f4f9a', '#2b7a3d', '#5e2c84'];

const hexRgb = (h: string): [number, number, number] => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
// 相对亮度（0–1）
const luma = (h: string) => {
  const [r, g, b] = hexRgb(h);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};
const far = (a: string, b: string) => {
  const x = hexRgb(a);
  const y = hexRgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) > 110 || Math.abs(luma(a) - luma(b)) > 0.35;
};

// 按类别默认的纹章
const CATEGORY_EMBLEMS: Record<string, FlagEmblem[]> = {
  monarchy: ['crown', 'lion', 'eagle', 'tower'],
  empire: ['eagle', 'crown', 'sun'],
  republic: ['star', 'tower', 'wheel'],
  oligarchy: ['tower', 'wheel'],
  theocracy: ['sun', 'moon', 'cross'],
  tribal: ['sun', 'mountain', 'tree', 'wave'],
  nomadic: ['sun', 'moon', 'mountain'],
};

// 生成一面旗：seed 定样式与颜色；main 是国家的颜色（做底色或第二色）；layouts / emblems 是政体偏好的（省略时按类别）
export function makeFlag(seed: number, main: string, opts: { categories?: readonly string[]; layouts?: readonly string[]; emblems?: readonly string[] } = {}): FlagSpec {
  const rand = mulberry32(seed >>> 0);
  const pickOf = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length) % list.length];
  const okLayouts = (opts.layouts ?? []).filter((l): l is FlagLayout => (FLAG_LAYOUTS as readonly string[]).includes(l));
  const layout = okLayouts.length && rand() < 0.7 ? pickOf(okLayouts) : pickOf(FLAG_LAYOUTS.filter((l) => l !== 'plain' || rand() < 0.3));
  const k = LAYOUT_COLORS[layout];
  const colors: string[] = [main.toLowerCase()];
  for (let t = 0; colors.length < k && t < 40; t++) {
    const c = pickOf(TINCTURES);
    if (colors.every((x) => far(x, c))) colors.push(c);
  }
  while (colors.length < k) colors.push(luma(colors[colors.length - 1]) > 0.5 ? '#1d1d1f' : '#f4f1e8');
  // 国家的颜色有时做第二色
  if (k >= 2 && rand() < 0.35) [colors[0], colors[1]] = [colors[1], colors[0]];
  const flag: FlagSpec = { layout, colors };
  const wanted = (opts.emblems ?? []).filter((e): e is FlagEmblem => (FLAG_EMBLEMS as readonly string[]).includes(e));
  const byCat = (opts.categories ?? []).flatMap((c) => CATEGORY_EMBLEMS[c] ?? []);
  if (rand() < 0.75) {
    const pool = wanted.length ? wanted : byCat.length ? byCat : (['star', 'circle', 'sun'] as FlagEmblem[]);
    flag.emblem = pickOf(pool);
    // 纹章的颜色：与底色分得开的一种
    const bg = colors[0];
    const cands = [...TINCTURES.slice(0, 3), ...colors.slice(1)].filter((c) => far(c, bg));
    flag.emblemColor = cands.length ? pickOf(cands) : luma(bg) > 0.5 ? '#1d1d1f' : '#f4f1e8';
  }
  return flag;
}

// ---------- 画成 SVG ----------

// 纹章的图形（画在 100 × 100 的方框里，中心 50, 50）
const EMBLEM_PATHS: Record<FlagEmblem, string> = {
  star: 'M50 12 L59.4 38.2 L87.2 38.2 L64.9 54.8 L73.5 81 L50 65 L26.5 81 L35.1 54.8 L12.8 38.2 L40.6 38.2 Z',
  sun: 'M50 28 A22 22 0 1 1 49.9 28 Z M50 6 L54 20 L46 20 Z M50 94 L46 80 L54 80 Z M6 50 L20 46 L20 54 Z M94 50 L80 54 L80 46 Z M19 19 L31 26 L26 31 Z M81 81 L69 74 L74 69 Z M81 19 L74 31 L69 26 Z M19 81 L26 69 L31 74 Z',
  moon: 'M62 14 A38 38 0 1 0 62 86 A30 30 0 1 1 62 14 Z',
  crown: 'M16 74 L16 34 L33 52 L50 24 L67 52 L84 34 L84 74 Z M16 80 L84 80 L84 88 L16 88 Z',
  cross: 'M42 12 L58 12 L58 42 L88 42 L88 58 L58 58 L58 88 L42 88 L42 58 L12 58 L12 42 L42 42 Z',
  circle: 'M50 16 A34 34 0 1 1 49.9 16 Z',
  tower: 'M28 88 L28 30 L22 30 L22 14 L34 14 L34 22 L44 22 L44 14 L56 14 L56 22 L66 22 L66 14 L78 14 L78 30 L72 30 L72 88 Z',
  tree: 'M50 8 L80 54 L62 54 L84 80 L56 80 L56 92 L44 92 L44 80 L16 80 L38 54 L20 54 Z',
  sword: 'M47 8 L53 8 L55 62 L70 62 L70 68 L55 68 L55 80 L58 92 L42 92 L45 80 L45 68 L30 68 L30 62 L45 62 Z',
  eagle: 'M50 22 L58 32 L90 22 L72 46 L84 48 L60 60 L58 84 L50 76 L42 84 L40 60 L16 48 L28 46 L10 22 L42 32 Z',
  lion: 'M30 84 L34 58 L22 46 L30 30 L46 22 L60 28 L66 40 L80 44 L74 54 L64 56 L70 84 L58 84 L54 66 L44 66 L42 84 Z',
  wheel: 'M50 14 A36 36 0 1 1 49.9 14 Z M50 26 A24 24 0 1 0 50.1 26 Z M47 14 L53 14 L53 86 L47 86 Z M14 47 L86 47 L86 53 L14 53 Z',
  mountain: 'M6 84 L36 30 L50 52 L64 34 L94 84 Z',
  wave: 'M8 44 Q22 30 36 44 T64 44 T92 44 L92 56 Q78 42 64 56 T36 56 T8 56 Z M8 66 Q22 52 36 66 T64 66 T92 66 L92 78 Q78 64 64 78 T36 78 T8 78 Z',
};

// 一面旗的 SVG（宽 w、高 h；省略为 3:2 的 60 × 40）
export function flagSvg(flag: FlagSpec, w = 60, h = 40): string {
  const c = (k: number) => flag.colors[k] ?? flag.colors[0];
  const r = (x: number, y: number, ww: number, hh: number, fill: string) => `<rect x="${x}" y="${y}" width="${ww}" height="${hh}" fill="${fill}"/>`;
  const p = (d: string, fill: string) => `<path d="${d}" fill="${fill}"/>`;
  const parts: string[] = [r(0, 0, w, h, c(0))];
  const t = Math.round(Math.min(w, h) / 6);
  switch (flag.layout) {
    case 'bicolor-h':
      parts.push(r(0, h / 2, w, h / 2, c(1)));
      break;
    case 'bicolor-v':
      parts.push(r(w / 2, 0, w / 2, h, c(1)));
      break;
    case 'tricolor-h':
      parts.push(r(0, h / 3, w, h / 3, c(1)), r(0, (2 * h) / 3, w, h / 3, c(2)));
      break;
    case 'tricolor-v':
      parts.push(r(w / 3, 0, w / 3, h, c(1)), r((2 * w) / 3, 0, w / 3, h, c(2)));
      break;
    case 'cross':
      parts.push(r((w - t) / 2, 0, t, h, c(1)), r(0, (h - t) / 2, w, t, c(1)));
      break;
    case 'nordic':
      parts.push(r(w * 0.3, 0, t, h, c(1)), r(0, (h - t) / 2, w, t, c(1)));
      break;
    case 'saltire':
      parts.push(`<path d="M0 0 L${w} ${h} M${w} 0 L0 ${h}" stroke="${c(1)}" stroke-width="${t}"/>`);
      break;
    case 'canton':
      parts.push(r(0, 0, w * 0.45, h * 0.5, c(1)));
      break;
    case 'chevron':
      parts.push(p(`M0 0 L${w * 0.45} ${h / 2} L0 ${h} Z`, c(1)));
      break;
    case 'quartered':
      parts.push(r(w / 2, 0, w / 2, h / 2, c(1)), r(0, h / 2, w / 2, h / 2, c(1)));
      break;
    case 'border':
      parts.push(`<rect x="${t / 2}" y="${t / 2}" width="${w - t}" height="${h - t}" fill="none" stroke="${c(1)}" stroke-width="${t}"/>`);
      break;
    case 'diagonal':
      parts.push(p(`M${w} 0 L${w} ${h} L0 ${h} Z`, c(1)));
      break;
    case 'stripes':
      for (let k = 1; k < 7; k += 2) parts.push(r(0, (k * h) / 7, w, h / 7, c(1)));
      break;
    default:
      break;
  }
  if (flag.emblem) {
    const s = Math.min(w, h) * 0.55;
    const x = flag.layout === 'canton' ? w * 0.225 - (s * 0.7) / 2 : flag.layout === 'nordic' || flag.layout === 'chevron' ? w * 0.18 - s / 2 + (flag.layout === 'chevron' ? 0 : -s * 0.05) : (w - s) / 2;
    const scale = flag.layout === 'canton' ? (s * 0.7) / 100 : s / 100;
    const y = flag.layout === 'canton' ? h * 0.25 - (s * 0.7) / 2 : (h - s) / 2;
    parts.push(`<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})">${p(EMBLEM_PATHS[flag.emblem], flag.emblemColor ?? '#f4f1e8')}</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`;
}
