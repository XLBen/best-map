import { type NameStyle, nameStyleSchema } from '../../name-styles';
import type { ResourcePack } from '../../packs';
import jaKanji from './ja-kanji.json';
import westGermanic from './west-germanic.json';
import zhDefault from './zh-default.json';

// 内置的地名风格（第二十轮）：一个文件一种，格式见 name-styles.ts 与 docs/开发说明.md 的“地名风格的写法”。
//   zh-default.json    中文·默认（模板式；就是以前的内置文字包，世界没选别的风格时用它）
//   west-germanic.json 西欧·日耳曼（音译式：Karvilsburg → 卡尔维尔斯堡）
//   ja-kanji.json      日本·汉字（模板式 + 读音表：白浜島 → Shirahamashima）
// 加一种：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

const FILES: unknown[] = [{ ...zhDefault, kind: 'template' }, westGermanic, jaKanji];

export const BUILTIN_STYLES: readonly NameStyle[] = FILES.map((f) => nameStyleSchema.parse(f));

export const NAME_STYLES_PACK_ID = 'name-styles';

// 仓库里的“地名风格示例”（除内置中文以外的几种）
export const NAME_STYLES_PACK: ResourcePack = {
  format: 'map2-pack',
  version: 1,
  id: NAME_STYLES_PACK_ID,
  name: '地名风格示例',
  author: 'map_2',
  description: '几种地名风格：西欧·日耳曼（音译）、日本·汉字（带读音）。',
  nameStyles: BUILTIN_STYLES.filter((s) => s.id !== 'zh-default'),
};
