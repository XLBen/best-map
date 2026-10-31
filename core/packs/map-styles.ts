import { DEFAULT_LOOK, type MapStyle } from '../map-style';

// “通用 ▸ 画风”（第三十八轮）：以前写死在合成着色器、画布里的两种画风（写实、地图册）改成普通的画风，
// 和别的内容一样从资源包里选、可以复制了改。数值照第三十七轮的代码原样搬过来（着色器里的 vec3(x, y, z) 写成
// rgb(255x, 255y, 255z)，上传的 float32 与原来的常数逐位相同；画布的 rgba 字符串原样），两种画出来与以前一样（测试逐项对）。
// 只在主线程用

// 写实：默认的画法（map-style.ts 的 DEFAULT_LOOK 就是它）
const REALISTIC: MapStyle = {
  id: 'realistic',
  name: '写实',
  description: '自然的颜色：山的明暗、海底的起伏都画出来',
  ...DEFAULT_LOOK,
};

// 地图册：羊皮纸底色、暖色的山影、按水深分层平涂的海，线条偏红褐，河湖的种类用另一种颜色
const ATLAS: MapStyle = {
  id: 'atlas',
  name: '地图册',
  description: '像纸上印的地图：羊皮纸底色、暖色的山影、按水深分层的海',
  landTint: 'rgb(237.15, 221.85, 183.6)',
  landTintAmount: 0.3,
  landShade: 'tinted',
  shadeDark: 'rgb(158.1, 132.6, 107.1)',
  shadeLight: 'rgb(265.2, 260.1, 249.9)',
  sea: 'tiers',
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
  glow: 0.3,
  coastLine: 'rgb(89.25, 68.85, 51)',
  coastAmount: 0.8,
  provinceLine: 'rgb(114.75, 51, 38.25)',
  countryLine: 'rgb(107.1, 35.7, 25.5)',
  river: 'rgba(70, 110, 150, 0.95)',
  riverBank: 'rgba(48, 70, 92, 0.55)',
  road: 'rgba(120, 36, 24, 0.92)',
  roadMinor: 'rgba(110, 34, 22, 0.8)',
  quietRoad: 'rgba(84, 46, 34, 0.45)',
  quietRoadMinor: 'rgba(84, 46, 34, 0.3)',
  countryLabel: 'rgba(78, 34, 24, 0.82)',
  typeColors: 'atlasColor',
};

export const BUILTIN_MAP_STYLES: readonly MapStyle[] = [REALISTIC, ATLAS];
