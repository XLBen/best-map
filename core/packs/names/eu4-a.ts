import baltic from './baltic.json';
import carpathian from './carpathian.json';
import caucasian from './caucasian.json';
import celtic from './celtic.json';
import cushitic from './cushitic.json';
import greatLakes from './great-lakes.json';
import kongo from './kongo.json';
import maghrebi from './maghrebi.json';
import mande from './mande.json';
import sahelian from './sahelian.json';
import slavicSouth from './slavic-south.json';
import slavicWest from './slavic-west.json';
import southernAfrican from './southern-african.json';
import sudanese from './sudanese.json';
import tatar from './tatar.json';
import ugric from './ugric.json';
import westAfrican from './west-african.json';

// 第四十三轮：仿 EU4 文化组的地名风格，A 批 17 种（都是音译式，格式同 index.ts 里的那些）。
// 按地区排：欧洲（波罗的、喀尔巴阡、凯尔特、南斯拉夫、西斯拉夫）→ 乌拉尔、伏尔加、高加索 → 北非、东北非 → 西非 → 中非、东非、南非
export const EU4_STYLES_A: unknown[] = [
  baltic,
  carpathian,
  celtic,
  slavicSouth,
  slavicWest,
  ugric,
  tatar,
  caucasian,
  maghrebi,
  cushitic,
  sudanese,
  sahelian,
  mande,
  westAfrican,
  kongo,
  greatLakes,
  southernAfrican,
];
