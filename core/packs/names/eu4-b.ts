import aboriginal from './aboriginal.json';
import araucanian from './araucanian.json';
import aridoamerican from './aridoamerican.json';
import aryanEast from './aryan-east.json';
import aryanWest from './aryan-west.json';
import burman from './burman.json';
import caribbean from './caribbean.json';
import centralIndian from './central-indian.json';
import chibchan from './chibchan.json';
import dravidian from './dravidian.json';
import evenki from './evenki.json';
import kamchatkan from './kamchatkan.json';
import maranon from './maranon.json';
import mayan from './mayan.json';
import monKhmer from './mon-khmer.json';
import otomanguean from './otomanguean.json';
import tibetan from './tibetan.json';

// 第四十三轮：照 EU4 的文化组补的地名风格，B 批 17 种（都是音译式）。在 index.ts 的 FILES 里展开就进了 BUILTIN_STYLES。
//   西伯利亚、堪察加（照俄文转写）→ 西藏、缅甸、柬埔寨 → 印度西部、东部、中部、南印度 → 美洲（玛雅、瓦哈卡、墨西哥北部、加勒比、哥伦比亚、马拉尼翁、智利）→ 澳大利亚
export const EU4_STYLES_B: unknown[] = [
  evenki,
  kamchatkan,
  tibetan,
  burman,
  monKhmer,
  aryanWest,
  aryanEast,
  centralIndian,
  dravidian,
  mayan,
  otomanguean,
  aridoamerican,
  caribbean,
  chibchan,
  maranon,
  araucanian,
  aboriginal,
];
