import { type NameStyle, nameStyleSchema } from '../../name-styles';
import arabic from './arabic.json';
import bantuSwahili from './bantu-swahili.json';
import enEnglish from './en-english.json';
import { EU4_STYLES_A } from './eu4-a';
import { EU4_STYLES_B } from './eu4-b';
import { EU4_STYLES_C } from './eu4-c';
import { FICTION_STYLES_A } from './fiction-a';
import { FICTION_STYLES_B } from './fiction-b';
import { FICTION_STYLES_C } from './fiction-c';
import { FICTION_STYLES_D } from './fiction-d';
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
//   zh-default.json    中文·默认（模板式；就是以前的内置文字包。第三十轮起是每个库“地名 ▸ 中文”里的普通内容，新建时默认加进世界）
//   west-germanic.json 西欧·日耳曼（音译式：Karvilsburg → 卡尔维尔斯堡）
//   ja-kanji.json      日本·汉字（模板式 + 读音表：白浜島 → Shirahamashima）
//   ko-hanja.json      朝鲜半岛·韩语（模板式 + 读音表：白川江 → Baekcheongang）
//   其余都是音译式（先拼原文、再按音译表写成中文），按地区排：
//   西欧（英、法、荷）→ 南欧（西、意、拉丁、希腊）→ 北欧、东欧 → 西亚、中亚、南亚 → 东南亚 → 非洲 → 美洲 → 大洋洲 → 幻想
//   第四十三轮的 49 种按 EU4 的文化组分在 eu4-a / b / c.ts 里（一个文化组一种），排在大洋洲之后、幻想之前
//   第四十四轮的 16 种给奇幻的文化组、科幻的物种组（一组一种）分在 fiction-a / b / c / d.ts 里，排在最后（幻想 → 科幻）
// 加一种：放一个 JSON 进来，在下面的表里加一行（资源库里按这个先后列出，地区见 builtin-tree.ts 的 STYLE_REGIONS）

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
  // 第四十三轮：照 EU4 的文化组补的 49 种（eu4-a.ts、eu4-b.ts、eu4-c.ts）
  ...EU4_STYLES_A,
  ...EU4_STYLES_B,
  ...EU4_STYLES_C,
  fantasyElf,
  fantasyDwarf,
  fantasyOrc,
  fantasySeafolk,
  // 第四十四轮：奇幻的文化组、科幻的物种组一组一种（fiction-a / b / c / d.ts）
  ...FICTION_STYLES_A,
  ...FICTION_STYLES_B,
  ...FICTION_STYLES_C,
  ...FICTION_STYLES_D,
];

export const BUILTIN_STYLES: readonly NameStyle[] = FILES.map((f) => nameStyleSchema.parse(f));
