import algonquianCentral from './algonquian-central.json';
import algonquianEast from './algonquian-east.json';
import algonquianPlains from './algonquian-plains.json';
import apachean from './apachean.json';
import caddoan from './caddoan.json';
import eskaleut from './eskaleut.json';
import iroquoian from './iroquoian.json';
import je from './je.json';
import matacoan from './matacoan.json';
import muskogean from './muskogean.json';
import naDene from './na-dene.json';
import penutian from './penutian.json';
import siouan from './siouan.json';
import sonoran from './sonoran.json';
import tupi from './tupi.json';

// 第四十三轮 C 批：EU4 文化组对应的地名风格（北美、南美的 15 种，都是音译式）
//   北美：因纽特（eskaleut）、纳德内、佩纽蒂、索诺拉、阿帕奇、平原 / 中部 / 东部阿尔冈昆、易洛魁、苏、卡多、马斯科吉
//   南美：马塔科（查科）、热语（巴西高原）、图皮
// 北美的通称多用英语（Lake X、X River，与当地的实际地图一样），能确定的用本族语（Kuuk、Wakpa、Tooh、Dził……）；
// 南美的用西班牙语、葡萄牙语。在 index.ts 的 FILES 里展开 EU4_STYLES_C 就进了内置的风格
export const EU4_STYLES_C: unknown[] = [
  eskaleut,
  naDene,
  penutian,
  sonoran,
  apachean,
  algonquianPlains,
  algonquianCentral,
  algonquianEast,
  iroquoian,
  siouan,
  caddoan,
  muskogean,
  matacoan,
  je,
  tupi,
];
