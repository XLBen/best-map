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
// 第三十轮起时代就是资源包（packs/builtin-tree.ts 按这里的数据拼出每个时代的大包），这些数据只在主线程用。
//   一个时代一个文件（这里）：{ era, pack, values? }——时代项（只有规则）、时代包里放什么（pack：政体、派系的 id，
//     默认带的文化组与权重 cultures，基础之外的资源 resources），与只属于它的维度的取值（意识形态、种族……）
//   几个时代共用的一维的取值（values/）：一个数组，每项用 eras 写明放进哪几个时代的包（宗教、民族认同）。
//     eras 只是包的归属，读进来的取值不带它（valueEras 记着）。同一个 id 只算先列的那一个
//   一个文化组一个文件（cultures/）：{ group, tendencies?, cultures }——文化组、组里文化的默认倾向、组里的文化。
//     倾向按维度 id 写，几个时代的取值写在同一张表里（每个时代只认那个时代有的取值）；
//     文化自己写了的那几维换掉组的默认（不是合并），没写的照抄组的。读进来的每个文化都带着完整的倾向
// 加一个：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

// 时代包里放什么（时代文件的 pack）
export interface EraPackDef {
  governments: string[];
  factions: string[];
  // 默认带的文化组与权重（新建向导默认勾这几组）
  cultures: [string, number][];
  // 基础（“通用 ▸ 基础”的通用资源）之外的资源
  resources?: string[];
}

const VALUE_FILES: unknown[][] = [religion, nation];
const ERA_FILES: { era: unknown; pack: EraPackDef; values?: unknown[] }[] = [antiquity, medieval, industrial, modern, fantasy, scifi] as { era: unknown; pack: EraPackDef; values?: unknown[] }[];
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
// 每个时代的包里放什么（按时代的 id）
export const ERA_PACKS: ReadonlyMap<string, EraPackDef> = new Map(ERA_FILES.map((f) => [(f.era as { id: string }).id, f.pack]));
const rawValues = unique([...VALUE_FILES.flat(), ...ERA_FILES.flatMap((f) => f.values ?? [])] as { id: string; eras?: string[] }[]);
export const BUILTIN_POP_VALUES: readonly PopValue[] = rawValues.map((v) => popValueSchema.parse(v));
// 取值放进哪几个时代的包（文件里写的 eras；省略时每个有这一维的时代都放）
export const VALUE_ERAS: ReadonlyMap<string, readonly string[] | undefined> = new Map(rawValues.map((v) => [v.id, v.eras]));
export const BUILTIN_CULTURE_GROUPS: readonly CultureGroup[] = CULTURE_FILES.map((f) => cultureGroupSchema.parse(f.group));
export const BUILTIN_CULTURES: readonly Culture[] = unique(
  CULTURE_FILES.flatMap((f) => f.cultures.map((c) => cultureSchema.parse(f.tendencies ? { ...c, tendencies: { ...f.tendencies, ...(c as { tendencies?: object }).tendencies } } : c))),
);
