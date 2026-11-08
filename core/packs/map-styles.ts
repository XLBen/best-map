import { DEFAULT_LOOK, type MapStyle } from '../map-style';

// 每个库的“画风”（第三十八轮）：以前写死在合成着色器、画布里的两种画风（写实、地图册）改成普通的画风，
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

// 手绘（第八十七轮）：老式的手绘奇幻地图——纸的纹理与暗角、淡淡的水彩陆地与浅色的海、墨线的海岸与岸外几道水纹、
// 画成小符号的山、丘陵与森林、楷体的地名，导出时加罗盘、标题、边框、图例。放在每个库单独的小包“手绘画风”里
// （builtin-tree.ts 的 drawn）：新建世界不带它（新世界与以前逐字节相同），在“图层 → 画风”里点“手绘”时从库里加进世界
export const HAND_STYLE_ID = 'hand';
export const HAND_LABEL_FONT = '"LXGW WenKai", "Kaiti SC", "STKaiti", KaiTi, serif';
const HAND: MapStyle = {
  id: HAND_STYLE_ID,
  name: '手绘',
  description: '老式的手绘地图：纸的纹理、水彩的颜色、画成小符号的山与森林、楷体的地名',
  landTint: 'rgb(238, 228, 198)',
  landTintAmount: 0.6,
  landShade: 'tinted',
  shadeDark: 'rgb(196, 180, 156)',
  shadeLight: 'rgb(262, 258, 248)',
  sea: 'tiers',
  seaShade: 0.14,
  tier1: 'rgb(210, 226, 224)',
  tier2: 'rgb(196, 216, 218)',
  tier3: 'rgb(184, 206, 212)',
  tier4: 'rgb(172, 196, 206)',
  depth2: 200,
  depth3: 1000,
  depth4: 3000,
  isobath: 'rgb(120, 146, 152)',
  isobathAmount: 0.12,
  tierShade: 0.03,
  glow: 0.15,
  coastLine: 'rgb(56, 42, 30)',
  coastAmount: 0.9,
  provinceLine: 'rgb(122, 76, 54)',
  countryLine: 'rgb(112, 42, 30)',
  river: 'rgba(64, 98, 130, 0.9)',
  riverBank: 'rgba(48, 58, 70, 0.5)',
  road: 'rgba(118, 44, 28, 0.9)',
  roadMinor: 'rgba(106, 44, 28, 0.78)',
  quietRoad: 'rgba(96, 58, 40, 0.5)',
  quietRoadMinor: 'rgba(96, 58, 40, 0.34)',
  countryLabel: 'rgba(92, 40, 26, 0.85)',
  typeColors: 'atlasColor',
  paper: 1,
  paperColor: 'rgb(238, 226, 196)',
  wash: 0.6,
  ripples: 3,
  rippleColor: 'rgb(72, 96, 108)',
  mountains: true,
  forests: true,
  ink: 'rgb(64, 48, 34)',
  labelFont: HAND_LABEL_FONT,
  exportDecor: true,
};
export const DRAWN_MAP_STYLES: readonly MapStyle[] = [HAND];
