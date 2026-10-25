import { type Faction, type Government, factionSchema, governmentSchema } from '../../human/government';
import medieval from './medieval.json';

// 内置的政体与派系（第二十三轮）：格式见 human/government.ts 与 docs/开发说明.md 的“国家与政体”。
// 一个文件一组：{ governments, factions }（一般一个时代一个文件）。同一个 id 只算先列的文件里的那一个，
// 几个时代共用的政体写一次、eras 里写上几个时代就行。
// 加一个：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

const FILES: { governments?: unknown[]; factions?: unknown[] }[] = [medieval];

const unique = <T extends { id: string }>(list: T[]): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
};

export const BUILTIN_GOVERNMENTS: readonly Government[] = unique(FILES.flatMap((f) => (f.governments ?? []).map((g) => governmentSchema.parse(g))));
export const BUILTIN_FACTIONS: readonly Faction[] = unique(FILES.flatMap((f) => (f.factions ?? []).map((x) => factionSchema.parse(x))));
