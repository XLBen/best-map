import { z } from 'zod';
import { typeIdSchema } from './type-id';
import type { SmallState } from './world';

// 画风（第三十八轮）：地图的画法里两种画风（写实、地图册）不一样的那几处，做成资源包里的一种内容（种类 mapStyle，包里的段 mapStyles）。
// 世界里启用的画风放在 small.content.mapStyle，选的那一种记在 small.mapStyle（set_map_style，可以撤销、跟着世界存盘）。
// 只是画法：不重算、不进计算 Worker 的内置数据（内置的写实、地图册在 packs/map-styles.ts，只在主线程）。
//
// 颜色的写法（styleRgba 读）：#rrggbb、#rrggbbaa，或 rgb(r, g, b)、rgba(r, g, b, a)（r、g、b 是 0–255，可以带小数；a 是 0–1）。
// 合成着色器里的颜色按 r / 255 上传成 float32：以前写在着色器里的 vec3(0.93, 0.87, 0.72) 在这里写成 rgb(237.15, 221.85, 183.6)，
// 上传的值与原来的常数逐位相同（map-style.test.ts 查）。山影的亮色是乘在颜色上的系数，可以超过 255（最多 510，即 2 倍）。
// 画布上画的颜色（河、河岸、道路、国名）原样交给画布（rgba 带不透明度）；着色器里的颜色不看不透明度，浓淡另有一项

const NUM = String.raw`\s*(\d+(?:\.\d+)?)\s*`;
const RGB_RE = new RegExp(`^rgb\\(${NUM},${NUM},${NUM}\\)$`);
const RGBA_RE = new RegExp(`^rgba\\(${NUM},${NUM},${NUM},${NUM}\\)$`);
const HEX_RE = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;

// 一个颜色 → [r, g, b, a]（r、g、b 0–255，a 0–1）；写错了是 null
export function styleRgba(s: string): [number, number, number, number] | null {
  const h = HEX_RE.exec(s);
  if (h) {
    const v = parseInt(h[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, h[2] ? parseInt(h[2], 16) / 255 : 1];
  }
  const m = RGB_RE.exec(s) ?? RGBA_RE.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

// 颜色的格式：max 是 r、g、b 最大多少（山影的亮色可以到 510）
const color = (max = 255) =>
  z.string().refine((s) => {
    const c = styleRgba(s);
    return !!c && c[0] <= max && c[1] <= max && c[2] <= max && c[3] <= 1;
  }, `颜色需为 #rrggbb 或 rgb(r, g, b)、rgba(r, g, b, a)（r、g、b 为 0–${max}，a 为 0–1）`);
const amount = z.number().min(0).max(1);

// 默认的画法（就是写实，与第三十七轮之前写在着色器、画布里的常数相同）。没写的项按它补上
export const DEFAULT_LOOK = {
  // 陆地：底色混进多少（0 不混）；山影平常（按“晕渲”的强弱明暗）还是着色（暗处、亮处各一种颜色，不看“晕渲”）
  landTint: 'rgb(237.15, 221.85, 183.6)',
  landTintAmount: 0,
  landShade: 'plain' as 'plain' | 'tinted',
  shadeDark: 'rgb(158.1, 132.6, 107.1)',
  shadeLight: 'rgb(265.2, 260.1, 249.9)',
  // 海：按海底的坡明暗（shade），或按水深分四层平涂（tiers：0 m 起、depth2、depth3、depth4 起各一层，层与层之间一道等深线）。
  // 海面是数据（海水温度底图）时都按明暗画
  sea: 'shade' as 'shade' | 'tiers',
  seaShade: 0.14,
  tier1: 'rgb(204, 224.4, 226.95)',
  tier2: 'rgb(186.15, 211.65, 219.3)',
  tier3: 'rgb(168.3, 196.35, 209.1)',
  tier4: 'rgb(150.45, 181.05, 198.9)',
  depth2: 200,
  depth3: 1000,
  depth4: 3000,
  isobath: 'rgb(114.75, 147.9, 168.3)',
  isobathAmount: 0.35,
  tierShade: 0.06,
  // 生态发光的强弱
  glow: 0.6,
  // 线条：海岸线的颜色与浓淡，省界、国界的颜色
  coastLine: 'rgb(45.9, 56.1, 61.2)',
  coastAmount: 0.4,
  provinceLine: 'rgb(30.6, 25.5, 20.4)',
  countryLine: 'rgb(40.8, 28.05, 25.5)',
  // 河、两岸的细线
  river: 'rgba(52, 104, 168, 0.92)',
  riverBank: 'rgba(24, 52, 88, 0.55)',
  // 道路：“道路”工具开着时的大道、小路，平时的大道、小路
  road: 'rgba(84, 38, 22, 0.92)',
  roadMinor: 'rgba(70, 36, 22, 0.8)',
  quietRoad: 'rgba(52, 44, 38, 0.45)',
  quietRoadMinor: 'rgba(52, 44, 38, 0.3)',
  // 国名
  countryLabel: 'rgba(36, 28, 24, 0.8)',
  // 河、湖的种类用哪一种颜色：颜色（color）或另一种颜色（atlasColor，没写时用颜色）
  typeColors: 'color' as 'color' | 'atlasColor',
};

const D = DEFAULT_LOOK;
export const mapStyleSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(24),
  description: z.string().max(200).optional(),
  landTint: color().default(D.landTint),
  landTintAmount: amount.default(D.landTintAmount),
  landShade: z.enum(['plain', 'tinted']).default(D.landShade),
  shadeDark: color().default(D.shadeDark),
  shadeLight: color(510).default(D.shadeLight),
  sea: z.enum(['shade', 'tiers']).default(D.sea),
  seaShade: amount.default(D.seaShade),
  tier1: color().default(D.tier1),
  tier2: color().default(D.tier2),
  tier3: color().default(D.tier3),
  tier4: color().default(D.tier4),
  depth2: z.number().min(1).max(20000).default(D.depth2),
  depth3: z.number().min(1).max(20000).default(D.depth3),
  depth4: z.number().min(1).max(20000).default(D.depth4),
  isobath: color().default(D.isobath),
  isobathAmount: amount.default(D.isobathAmount),
  tierShade: amount.default(D.tierShade),
  glow: z.number().min(0).max(2).default(D.glow),
  coastLine: color().default(D.coastLine),
  coastAmount: amount.default(D.coastAmount),
  provinceLine: color().default(D.provinceLine),
  countryLine: color().default(D.countryLine),
  river: color().default(D.river),
  riverBank: color().default(D.riverBank),
  road: color().default(D.road),
  roadMinor: color().default(D.roadMinor),
  quietRoad: color().default(D.quietRoad),
  quietRoadMinor: color().default(D.quietRoadMinor),
  countryLabel: color().default(D.countryLabel),
  typeColors: z.enum(['color', 'atlasColor']).default(D.typeColors),
  // ---------- 手绘（第八十七轮）：都可以不写、没有默认值 ----------
  // 写实、地图册不写这几项：库里、世界里的这两种与以前逐字节相同（内容的摘要不变），读的时候按 HAND_OFF 补上（handLook）
  // 纸：纹理与四周暗角的浓淡（0 不画）、纸的颜色；陆地上水彩的晕染
  paper: amount.optional(),
  paperColor: color().optional(),
  wash: amount.optional(),
  // 岸外几道细的水纹（0 不画）与颜色
  ripples: z.number().int().min(0).max(4).optional(),
  rippleColor: color().optional(),
  // 山、丘陵、森林画成小符号（叠加层，src/render/overlay-symbols.ts）；符号的墨色
  mountains: z.boolean().optional(),
  forests: z.boolean().optional(),
  ink: color().optional(),
  // 地名、城市名、国名的字体（CSS 的 font-family）；不写时照旧
  labelFont: z.string().min(1).max(160).optional(),
  // 导出整张地图时默认加上罗盘、标题、边框、图例
  exportDecor: z.boolean().optional(),
});

export type MapStyle = z.infer<typeof mapStyleSchema>;

// 一个世界都没有画风时用的（id 为 ''）：默认的画法，与内置的写实画出来一样
export const FALLBACK_MAP_STYLE: MapStyle = Object.freeze({ id: '', name: '写实', ...DEFAULT_LOOK }) as MapStyle;

type StyleSmall = Pick<Partial<SmallState>, 'content' | 'mapStyle'>;

// 世界里启用的画风（按启用的先后）
export function worldMapStyles(small: Pick<Partial<SmallState>, 'content'>): Record<string, MapStyle> {
  return (small.content?.mapStyle ?? {}) as Record<string, MapStyle>;
}

// 世界在用的画风 id：选了的（还在世界里时）；没选、选的不在了时是世界里第一种；一种都没有时为 ''
export function worldMapStyleId(small: StyleSmall): string {
  const styles = worldMapStyles(small);
  const id = small.mapStyle;
  if (id && styles[id]) return id;
  for (const k in styles) return k;
  return '';
}

// 世界在用的画风（照 worldMapStyleId；一种都没有时是默认的画法：没有画风的旧世界照旧按写实画）
export function worldMapStyle(small: StyleSmall): MapStyle {
  const id = worldMapStyleId(small);
  return id ? worldMapStyles(small)[id] : FALLBACK_MAP_STYLE;
}

// 一种河、湖的种类画出来的颜色（画风选了另一种颜色时用 atlasColor，没写时用颜色）
export function typeColor(t: { color: string; atlasColor?: string }, style: Pick<MapStyle, 'typeColors'>): string {
  return style.typeColors === 'atlasColor' ? (t.atlasColor ?? t.color) : t.color;
}

// 手绘的几项不写时的值（第八十七轮）：都关着，画出来与没有这几项时逐像素相同
export const HAND_OFF = {
  paper: 0,
  paperColor: 'rgb(238, 226, 196)',
  wash: 0,
  ripples: 0,
  rippleColor: 'rgb(70, 92, 104)',
  mountains: false,
  forests: false,
  ink: 'rgb(62, 48, 36)',
  exportDecor: false,
};
export type HandLook = typeof HAND_OFF & { labelFont: string | null };
const handLooks = new WeakMap<object, HandLook>();
// 画风里手绘的几项（没写的按 HAND_OFF）；按画风对象记住
export function handLook(style: MapStyle): HandLook {
  let h = handLooks.get(style);
  if (!h) {
    h = { labelFont: style.labelFont ?? null } as HandLook;
    for (const k of Object.keys(HAND_OFF) as (keyof typeof HAND_OFF)[]) (h as Record<string, unknown>)[k] = style[k] ?? HAND_OFF[k];
    handLooks.set(style, h);
  }
  return h;
}
// 画风有没有画符号（山、森林）
export const hasSymbols = (style: MapStyle) => !!(style.mountains || style.forests);

// 画风的签名（缓存的键）：画出来有关的各项。按对象记住，每帧不重算
const sigs = new WeakMap<object, string>();
export function mapStyleKey(style: MapStyle): string {
  let s = sigs.get(style);
  if (s === undefined) {
    const { id: _id, name: _name, description: _d, ...look } = style;
    // 第八十七轮：手绘的几项（没写的是 null）跟在后面
    s = JSON.stringify([...Object.keys(DEFAULT_LOOK), ...Object.keys(HAND_OFF), 'labelFont'].map((k) => look[k as keyof typeof look] ?? null));
    sigs.set(style, s);
  }
  return s;
}
