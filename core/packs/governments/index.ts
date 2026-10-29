import { type Faction, type Government, factionSchema, governmentSchema } from '../../human/government';
import antiquity from './antiquity.json';
import fantasy from './fantasy.json';
import industrial from './industrial.json';
import medieval from './medieval.json';
import modern from './modern.json';
import scifi from './scifi.json';

// 内置的政体与派系（第二十三轮）：格式见 human/government.ts 与 docs/开发说明.md 的“国家与政体”。
// 一个文件一组：{ governments, factions }（一般一个时代一个文件）。同一个 id 只算先列的文件里的那一个，
// 几个时代共用的政体写一次（写在最早用到它的时代的文件里）。时代的文件（core/packs/eras/*.json）的 pack 列出它的包里放哪些；
// 政体、派系自己写的 eras 只用来给没被任何时代列出的归包（packs/builtin-tree.ts 的 homeEra），读进来的不带它（GOV_ERAS 记着）
// 加一个：放一个 JSON 进来，在下面的表里加一行（仓库里按这个先后列出）

const FILES: { governments?: unknown[]; factions?: unknown[] }[] = [antiquity, medieval, industrial, modern, fantasy, scifi];

const unique = <T extends { id: string }>(list: T[]): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
};

const rawGovs = unique(FILES.flatMap((f) => (f.governments ?? []) as { id: string; eras?: string[] }[]));
const rawFacs = unique(FILES.flatMap((f) => (f.factions ?? []) as { id: string; eras?: string[] }[]));
export const BUILTIN_GOVERNMENTS: readonly Government[] = rawGovs.map((g) => governmentSchema.parse(g));
export const BUILTIN_FACTIONS: readonly Faction[] = rawFacs.map((x) => factionSchema.parse(x));
// 文件里写的时代（id → eras）
export const GOV_ERAS: ReadonlyMap<string, readonly string[] | undefined> = new Map([...rawGovs, ...rawFacs].map((x) => [x.id, x.eras]));
