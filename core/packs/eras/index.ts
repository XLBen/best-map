import { type Culture, type CultureGroup, type Era, type PopValue, cultureGroupSchema, cultureSchema, eraSchema, popValueSchema } from '../../human/era';
import eastern from './cultures/eastern.json';
import steppe from './cultures/steppe.json';
import western from './cultures/western.json';
import medieval from './medieval.json';

// 内置的时代与文化（第二十二轮）：格式见 human/era.ts 与 docs/开发说明.md 的“时代、文化、人口”。
//   一个时代一个文件（这里）：{ era, values }——时代与它的维度的取值（宗教、种族……）。取值可以几个时代共用：
//     同一个 id 只算先列的那一个，别的文件里可以只写 era
//   一个文化组一个文件（cultures/）：{ group, cultures }——文化组与组里的文化
// 加一个：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

const ERA_FILES: { era: unknown; values?: unknown[] }[] = [medieval];
const CULTURE_FILES: { group: unknown; cultures: unknown[] }[] = [western, eastern, steppe];

const unique = <T extends { id: string }>(list: T[]): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
};

export const BUILTIN_ERAS: readonly Era[] = ERA_FILES.map((f) => eraSchema.parse(f.era));
export const BUILTIN_POP_VALUES: readonly PopValue[] = unique(ERA_FILES.flatMap((f) => (f.values ?? []).map((v) => popValueSchema.parse(v))));
export const BUILTIN_CULTURE_GROUPS: readonly CultureGroup[] = CULTURE_FILES.map((f) => cultureGroupSchema.parse(f.group));
export const BUILTIN_CULTURES: readonly Culture[] = unique(CULTURE_FILES.flatMap((f) => f.cultures.map((c) => cultureSchema.parse(c))));
