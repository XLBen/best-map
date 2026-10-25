import { type Culture, type CultureGroup, type Era, type PopValue, cultureGroupSchema, cultureSchema, eraSchema, popValueSchema } from '../../human/era';
import africa from './cultures/africa.json';
import andes from './cultures/andes.json';
import chitin from './cultures/chitin.json';
import dwarves from './cultures/dwarves.json';
import eastern from './cultures/eastern.json';
import elves from './cultures/elves.json';
import emberkin from './cultures/emberkin.json';
import lithic from './cultures/lithic.json';
import mediterranean from './cultures/mediterranean.json';
import mesoamerica from './cultures/mesoamerica.json';
import mideast from './cultures/mideast.json';
import nordic from './cultures/nordic.json';
import oceania from './cultures/oceania.json';
import orcs from './cultures/orcs.json';
import seafolk from './cultures/seafolk.json';
import slavic from './cultures/slavic.json';
import smallfolk from './cultures/smallfolk.json';
import southasia from './cultures/southasia.json';
import southeast from './cultures/southeast.json';
import sporal from './cultures/sporal.json';
import steppe from './cultures/steppe.json';
import tidal from './cultures/tidal.json';
import western from './cultures/western.json';
import antiquity from './antiquity.json';
import fantasy from './fantasy.json';
import industrial from './industrial.json';
import medieval from './medieval.json';
import modern from './modern.json';
import scifi from './scifi.json';
import nation from './values/nation.json';
import religion from './values/religion.json';

// 内置的时代与文化（第二十二轮）：格式见 human/era.ts 与 docs/开发说明.md 的“时代、文化、人口”。
//   一个时代一个文件（这里）：{ era, values? }——时代与只属于它的维度的取值（意识形态、种族……）
//   几个时代共用的一维的取值（values/）：一个数组，每项用 eras 写明在哪几个时代里有（宗教、民族认同）。
//     同一个 id 只算先列的那一个
//   一个文化组一个文件（cultures/）：{ group, tendencies?, cultures }——文化组、组里文化的默认倾向、组里的文化。
//     倾向按维度 id 写，几个时代的取值写在同一张表里（每个时代只认那个时代有的取值）；
//     文化自己写了的那几维换掉组的默认（不是合并），没写的照抄组的。读进来的每个文化都带着完整的倾向
// 加一个：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

const VALUE_FILES: unknown[][] = [religion, nation];
const ERA_FILES: { era: unknown; values?: unknown[] }[] = [antiquity, medieval, industrial, modern, fantasy, scifi];
const CULTURE_FILES: { group: unknown; tendencies?: Record<string, unknown>; cultures: object[] }[] = [
  // 地球上的（历史上的几个时代、奇幻、科幻都能用）
  western,
  eastern,
  steppe,
  nordic,
  slavic,
  mediterranean,
  mideast,
  southasia,
  southeast,
  africa,
  mesoamerica,
  andes,
  oceania,
  // 奇幻
  elves,
  dwarves,
  orcs,
  seafolk,
  smallfolk,
  emberkin,
  // 科幻的异星种族
  tidal,
  lithic,
  sporal,
  chitin,
];

const unique = <T extends { id: string }>(list: T[]): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
};

export const BUILTIN_ERAS: readonly Era[] = ERA_FILES.map((f) => eraSchema.parse(f.era));
export const BUILTIN_POP_VALUES: readonly PopValue[] = unique([...VALUE_FILES.flat(), ...ERA_FILES.flatMap((f) => f.values ?? [])].map((v) => popValueSchema.parse(v)));
export const BUILTIN_CULTURE_GROUPS: readonly CultureGroup[] = CULTURE_FILES.map((f) => cultureGroupSchema.parse(f.group));
export const BUILTIN_CULTURES: readonly Culture[] = unique(
  CULTURE_FILES.flatMap((f) => f.cultures.map((c) => cultureSchema.parse(f.tendencies ? { ...c, tendencies: { ...f.tendencies, ...(c as { tendencies?: object }).tendencies } } : c))),
);
