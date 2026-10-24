import { type NameStyle, nameStyleSchema } from '../../name-styles';
import type { ResourcePack } from '../../packs';
import arabic from './arabic.json';
import bantuSwahili from './bantu-swahili.json';
import enEnglish from './en-english.json';
import esSpanish from './es-spanish.json';
import fantasyDwarf from './fantasy-dwarf.json';
import fantasyElf from './fantasy-elf.json';
import fantasyOrc from './fantasy-orc.json';
import fantasySeafolk from './fantasy-seafolk.json';
import frFrench from './fr-french.json';
import greek from './greek.json';
import indic from './indic.json';
import itItalian from './it-italian.json';
import jaKanji from './ja-kanji.json';
import koHanja from './ko-hanja.json';
import latin from './latin.json';
import malay from './malay.json';
import nahuatl from './nahuatl.json';
import nlDutch from './nl-dutch.json';
import nordicNorse from './nordic-norse.json';
import persian from './persian.json';
import polynesian from './polynesian.json';
import quechua from './quechua.json';
import slavicEast from './slavic-east.json';
import thai from './thai.json';
import turkic from './turkic.json';
import westGermanic from './west-germanic.json';
import zhDefault from './zh-default.json';

// 内置的地名风格（第二十轮）：一个文件一种，格式见 name-styles.ts 与 docs/开发说明.md 的“地名风格的写法”。
//   zh-default.json    中文·默认（模板式；就是以前的内置文字包，世界没选别的风格时用它）
//   west-germanic.json 西欧·日耳曼（音译式：Karvilsburg → 卡尔维尔斯堡）
//   ja-kanji.json      日本·汉字（模板式 + 读音表：白浜島 → Shirahamashima）
//   ko-hanja.json      朝鲜半岛·韩语（模板式 + 读音表：白川江 → Baekcheongang）
//   其余都是音译式（先拼原文、再按音译表写成中文），按地区排：
//   西欧（英、法、荷）→ 南欧（西、意、拉丁、希腊）→ 北欧、东欧 → 西亚、中亚、南亚 → 东南亚 → 非洲 → 美洲 → 大洋洲 → 幻想
// 加一种：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

const FILES: unknown[] = [
  { ...zhDefault, kind: 'template' },
  westGermanic,
  jaKanji,
  koHanja,
  enEnglish,
  frFrench,
  nlDutch,
  esSpanish,
  itItalian,
  latin,
  greek,
  nordicNorse,
  slavicEast,
  arabic,
  persian,
  turkic,
  indic,
  malay,
  thai,
  bantuSwahili,
  nahuatl,
  quechua,
  polynesian,
  fantasyElf,
  fantasyDwarf,
  fantasyOrc,
  fantasySeafolk,
];

export const BUILTIN_STYLES: readonly NameStyle[] = FILES.map((f) => nameStyleSchema.parse(f));

export const NAME_STYLES_PACK_ID = 'name-styles';

// 仓库里的“地名风格示例”（除内置中文以外的几种）
export const NAME_STYLES_PACK: ResourcePack = {
  format: 'map2-pack',
  version: 1,
  id: NAME_STYLES_PACK_ID,
  name: '地名风格示例',
  author: 'map_2',
  description: '仿各地语言的地名风格（音译，带原文；日本、朝鲜半岛是汉字带读音），另有精灵、矮人、兽人、海民四种幻想风格。',
  nameStyles: BUILTIN_STYLES.filter((s) => s.id !== 'zh-default'),
};
